//! The wallet's account path: the wallet authorizing, as a custom account, a plain asset transfer.
//! Authorization is enforced throughout. A payment is made the way a service or relayer that knows
//! nothing of this wallet makes it: `asset.transfer(wallet, payee, amount)` carrying one entry
//! signed by the agent's key.

extern crate std;

use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    auth::{Context, ContractContext, ContractExecutable, CreateContractHostFnContext},
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{self, Limits, WriteXdr},
    Address, Bytes, BytesN, Env, Event, IntoVal, InvokeError, String, Symbol, TryFromVal, Val, Vec,
};
use stellar_agent_auth_agent_registry::{AgentRegistry, AgentRegistryClient};
use stellar_agent_auth_shared_types::{
    action::{AccountSignature, Action, ActionKind, ActionRequest, Transfer},
    attestation::{
        risk_score, AssessmentMode, CheckKind, CheckOutcome, CheckResult, VerificationResult,
    },
    audit::{AccountPayment, AuditEntry, AuditHead, AuditOutcome},
    encoding::audit_hash,
    errors::Error,
    events::WalletAudit,
    identity::AgentIdentity,
    policy::{AssetLimit, AssetSpend, Policy, PolicyState, ServicePermission, SECONDS_PER_DAY},
};
use stellar_agent_auth_verification_registry::{VerificationRegistry, VerificationRegistryClient};

use crate::{SmartWallet, SmartWalletClient};

/// 2027-01-15T08:00:00Z; the next UTC midnight is 57,600 seconds later.
const NOW: u64 = 1_800_000_000;
const UNTIL_MIDNIGHT: u64 = 57_600;
const DAY: u64 = SECONDS_PER_DAY;
const PAYLOAD: [u8; 32] = [3; 32];

type Denied = Result<Error, InvokeError>;

struct Test {
    env: Env,
    key: SigningKey,
    signer: Address,
    owner: Address,
    provider: Address,
    agents: Address,
    verifier: Address,
    asset: Address,
    other_asset: Address,
    wallet: Address,
    recipient: Address,
    stranger: Address,
    agent: AgentIdentity,
    /// The 5-per-payment, 20-per-day policy approved in `setup`.
    policy: BytesN<32>,
}

/// The account address of an ed25519 key, which is how the registry stores an agent signer.
fn account(env: &Env, key: &SigningKey) -> Address {
    let address = xdr::ScAddress::Account(xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(
        xdr::Uint256(key.verifying_key().to_bytes()),
    )));
    Address::try_from_val(env, &xdr::ScVal::Address(address)).unwrap()
}

fn scval(env: &Env, value: impl IntoVal<Env, Val>) -> xdr::ScVal {
    xdr::ScVal::try_from_val(env, &value.into_val(env)).unwrap()
}

fn sc_address(env: &Env, address: &Address) -> xdr::ScAddress {
    match scval(env, address.clone()) {
        xdr::ScVal::Address(address) => address,
        _ => unreachable!(),
    }
}

/// Both registries, a registered agent whose signer has a real key, a passing result, two assets,
/// and a wallet holding `funded` of the first asset with one approved policy. Setup is authorized
/// by mocks; from its return on, nothing is.
fn setup(funded: i128) -> Test {
    let env = Env::default();
    env.ledger().set_timestamp(NOW);
    env.mock_all_auths();

    let key = SigningKey::from_bytes(&[7; 32]);
    let signer = account(&env, &key);
    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let controller = Address::generate(&env);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let stranger = Address::generate(&env);

    let agents = env.register(AgentRegistry, ());
    let verifier = env.register(VerificationRegistry, (admin.clone(), agents.clone()));
    VerificationRegistryClient::new(&env, &verifier)
        .approve_provider(&provider, &AssessmentMode::Fixture);
    let agent = AgentRegistryClient::new(&env, &agents).register(
        &controller,
        &signer,
        &String::from_str(&env, "https://agent.example.test/account-path.json"),
        &BytesN::from_array(&env, &[4; 32]),
    );
    let checks = vec![
        &env,
        CheckResult {
            kind: CheckKind::Metadata,
            outcome: CheckOutcome::Passed,
            score: Some(0),
        },
        CheckResult {
            kind: CheckKind::SignerAccount,
            outcome: CheckOutcome::Passed,
            score: Some(0),
        },
    ];
    VerificationRegistryClient::new(&env, &verifier).publish(&VerificationResult {
        schema_version: 1,
        agent_id: agent.agent_id,
        revision: agent.revision,
        provider: provider.clone(),
        sequence: 1,
        mode: AssessmentMode::Fixture,
        risk_score: risk_score(&checks),
        checks,
        serious_wallet_risks: 0,
        evidence_hash: BytesN::from_array(&env, &[9; 32]),
        issued_at: NOW,
        expires_at: NOW + 30 * DAY,
        revoked: false,
    });

    let asset = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let other_asset = env.register_stellar_asset_contract_v2(admin).address();
    let wallet = env.register(
        SmartWallet,
        (owner.clone(), agents.clone(), verifier.clone()),
    );
    StellarAssetClient::new(&env, &asset).mint(&wallet, &funded);
    StellarAssetClient::new(&env, &other_asset).mint(&wallet, &funded);

    let mut t = Test {
        env,
        key,
        signer,
        owner,
        provider,
        agents,
        verifier,
        asset,
        other_asset,
        wallet,
        recipient,
        stranger,
        agent,
        policy: BytesN::from_array(&Env::default(), &[0; 32]),
    };
    t.policy = t.client().approve_policy(&t.terms(1, 5, 20));
    t.env.set_auths(&[]);
    t
}

impl Test {
    fn client(&self) -> SmartWalletClient<'_> {
        SmartWalletClient::new(&self.env, &self.wallet)
    }

    /// A transfer-only policy for the agent on the first asset, valid from now for seven days.
    fn terms(&self, id: u8, per_transaction: i128, per_day: i128) -> Policy {
        let env = &self.env;
        Policy {
            schema_version: 1,
            policy_id: BytesN::from_array(env, &[id; 32]),
            agent_id: self.agent.agent_id,
            revision: self.agent.revision,
            signer: self.signer.clone(),
            provider: self.provider.clone(),
            required_checks: vec![env, CheckKind::Metadata, CheckKind::SignerAccount],
            max_assessment_age: 30 * DAY,
            max_risk_score: 10,
            assets: vec![
                env,
                AssetLimit {
                    asset: self.asset.clone(),
                    per_transaction,
                    per_day,
                },
            ],
            allowed_recipients: vec![env, self.recipient.clone()],
            blocked_recipients: Vec::new(env),
            valid_after: NOW,
            valid_until: NOW + 7 * DAY,
            action_kinds: vec![env, ActionKind::Transfer],
            service: ServicePermission::Disabled,
        }
    }

    /// An owner or setup step, authorized by mocks, after which authorization is enforced again.
    fn as_owner<T>(&self, step: impl FnOnce() -> T) -> T {
        self.env.mock_all_auths();
        let value = step();
        self.env.set_auths(&[]);
        value
    }

    fn state(&self) -> PolicyState {
        self.client().policy_state(&self.policy)
    }

    fn spent(&self) -> i128 {
        self.state()
            .daily_spend
            .iter()
            .map(|spend| spend.amount)
            .sum()
    }

    fn balance(&self, holder: &Address) -> i128 {
        TokenClient::new(&self.env, &self.asset).balance(holder)
    }

    /// The agent's signature over `payload || policy`, as `key`.
    fn sign(&self, key: &SigningKey, payload: &[u8; 32], policy: &BytesN<32>) -> AccountSignature {
        let mut message = [0u8; 64];
        message[..32].copy_from_slice(payload);
        message[32..].copy_from_slice(&policy.to_array());
        AccountSignature {
            policy_hash: policy.clone(),
            signature: BytesN::from_array(&self.env, &key.sign(&message).to_bytes()),
        }
    }

    fn call(
        &self,
        contract: &Address,
        name: &str,
        from: &Address,
        to: &Address,
        amount: i128,
    ) -> Context {
        Context::Contract(ContractContext {
            contract: contract.clone(),
            fn_name: Symbol::new(&self.env, name),
            args: vec![
                &self.env,
                from.into_val(&self.env),
                to.into_val(&self.env),
                amount.into_val(&self.env),
            ],
        })
    }

    fn transfer(&self, to: &Address, amount: i128) -> Context {
        self.call(&self.asset, "transfer", &self.wallet, to, amount)
    }

    /// `__check_auth` on its own, as the host would call it for `contexts`.
    fn check(&self, signature: &AccountSignature, contexts: Vec<Context>) -> Result<(), Denied> {
        self.env.try_invoke_contract_check_auth::<Error>(
            &self.wallet,
            &BytesN::from_array(&self.env, &PAYLOAD),
            signature.clone().into_val(&self.env),
            &contexts,
        )
    }

    /// `__check_auth` for one transfer under the default policy, signed by the agent.
    fn check_transfer(&self, to: &Address, amount: i128) -> Result<(), Denied> {
        self.check(
            &self.sign(&self.key, &PAYLOAD, &self.policy),
            vec![&self.env, self.transfer(to, amount)],
        )
    }

    /// A complete entry for `asset.transfer(wallet, to, amount)` under `policy`, signed by `key`
    /// over the real payload hash, and that hash.
    fn entry(
        &self,
        key: &SigningKey,
        policy: &BytesN<32>,
        to: &Address,
        amount: i128,
        nonce: i64,
    ) -> (xdr::SorobanAuthorizationEntry, [u8; 32]) {
        let env = &self.env;
        let args = std::vec![
            scval(env, self.wallet.clone()),
            scval(env, to.clone()),
            scval(env, amount),
        ];
        let invocation = xdr::SorobanAuthorizedInvocation {
            function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
                contract_address: sc_address(env, &self.asset),
                function_name: "transfer".try_into().unwrap(),
                args: args.try_into().unwrap(),
            }),
            sub_invocations: xdr::VecM::default(),
        };
        let expiration = env.ledger().sequence() + 10;
        let preimage =
            xdr::HashIdPreimage::SorobanAuthorization(xdr::HashIdPreimageSorobanAuthorization {
                network_id: xdr::Hash(env.ledger().network_id().to_array()),
                nonce,
                signature_expiration_ledger: expiration,
                invocation: invocation.clone(),
            });
        let bytes = preimage.to_xdr(Limits::none()).unwrap();
        let payload = env
            .crypto()
            .sha256(&Bytes::from_slice(env, &bytes))
            .to_array();
        let entry = xdr::SorobanAuthorizationEntry {
            credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
                address: sc_address(env, &self.wallet),
                nonce,
                signature_expiration_ledger: expiration,
                signature: scval(env, self.sign(key, &payload, policy)),
            }),
            root_invocation: invocation,
        };
        (entry, payload)
    }

    /// A plain `asset.transfer(wallet, to, amount)` carrying `entry` and nothing else.
    fn pay(&self, entry: xdr::SorobanAuthorizationEntry, to: &Address, amount: i128) -> bool {
        self.env.set_auths(&[entry]);
        let paid = TokenClient::new(&self.env, &self.asset)
            .try_transfer(&self.wallet, to, &amount)
            .is_ok();
        paid
    }

    /// An agent payment through `execute` at the policy's next sequence. `execute` requires the
    /// signer's Stellar account, which the test host cannot authenticate for one account alone, so
    /// this call is mocked; the wallet's own `execute` tests cover its authorization.
    fn execute(&self, amount: i128) -> Result<(), Error> {
        let request = ActionRequest {
            schema_version: 1,
            wallet: self.wallet.clone(),
            policy_hash: self.policy.clone(),
            sequence: self.state().next_sequence,
            deadline: self.env.ledger().timestamp() + 300,
            action: Action::Transfer(Transfer {
                asset: self.asset.clone(),
                recipient: self.recipient.clone(),
                amount,
            }),
        };
        self.as_owner(|| match self.client().try_execute(&request) {
            Ok(_) => Ok(()),
            Err(Ok(error)) => Err(error),
            Err(Err(error)) => panic!("execute aborted: {error:?}"),
        })
    }
}

#[test]
fn pays_a_plain_transfer_and_records_it() {
    let t = setup(100);
    let head: AuditHead = t.client().audit_head();
    let (entry, payload) = t.entry(&t.key, &t.policy, &t.recipient, 3, 1);
    assert!(t.pay(entry, &t.recipient, 3));

    // Read before any other call: the test host keeps the events of the latest invocation only.
    let expected = AuditEntry {
        schema_version: 1,
        wallet: t.wallet.clone(),
        sequence: head.sequence + 1,
        previous_hash: head.hash.clone(),
        ledger: t.env.ledger().sequence(),
        timestamp: NOW,
        actor: t.signer.clone(),
        outcome: AuditOutcome::AccountPayment(AccountPayment {
            policy_hash: t.policy.clone(),
            authorization: BytesN::from_array(&t.env, &payload),
            transfer: Transfer {
                asset: t.asset.clone(),
                recipient: t.recipient.clone(),
                amount: 3,
            },
        }),
    };
    let hash = audit_hash(&t.env, &expected).unwrap();
    let event = WalletAudit {
        sequence: expected.sequence,
        entry: expected,
        hash: hash.clone(),
    };
    assert_eq!(
        t.env.events().all().filter_by_contract(&t.wallet),
        std::vec![event.to_xdr(&t.env, &t.wallet)]
    );
    t.env.set_auths(&[]);

    assert_eq!(t.balance(&t.recipient), 3);
    assert_eq!(t.balance(&t.wallet), 97);
    assert_eq!(
        t.client().audit_head(),
        AuditHead {
            sequence: head.sequence + 1,
            hash
        }
    );
    // The spend is charged; the policy sequence, which orders `execute` requests, is not used.
    assert_eq!(
        t.state(),
        PolicyState {
            policy_hash: t.policy.clone(),
            revoked: false,
            next_sequence: 1,
            utc_day: NOW / DAY,
            daily_spend: vec![
                &t.env,
                AssetSpend {
                    asset: t.asset.clone(),
                    amount: 3
                }
            ],
        }
    );
}

#[test]
fn shares_one_budget_with_execute() {
    let t = setup(100);
    // 20 a day, 5 a payment: two payments on each path use the whole day between them.
    assert_eq!(t.execute(5), Ok(()));
    assert_eq!(t.check_transfer(&t.recipient, 5), Ok(()));
    assert_eq!(t.execute(5), Ok(()));
    assert_eq!(t.check_transfer(&t.recipient, 4), Ok(()));
    assert_eq!(t.spent(), 19);

    // One unit is left, whichever path asks for it.
    assert_eq!(
        t.check_transfer(&t.recipient, 2),
        Err(Ok(Error::LimitExceeded))
    );
    assert_eq!(t.execute(2), Err(Error::LimitExceeded));
    assert_eq!(t.check_transfer(&t.recipient, 1), Ok(()));
    assert_eq!(t.execute(1), Err(Error::LimitExceeded));
    assert_eq!(t.spent(), 20);

    // Still spent one second before UTC midnight, on both paths, and free again at midnight.
    t.env.ledger().set_timestamp(NOW + UNTIL_MIDNIGHT - 1);
    assert_eq!(
        t.check_transfer(&t.recipient, 1),
        Err(Ok(Error::LimitExceeded))
    );
    t.env.ledger().set_timestamp(NOW + UNTIL_MIDNIGHT);
    assert_eq!(t.check_transfer(&t.recipient, 5), Ok(()));
    assert_eq!(t.execute(5), Ok(()));
    assert_eq!(t.spent(), 10);
    // `execute` advanced its sequence three times; the account path never touched it.
    assert_eq!(t.state().next_sequence, 4);
}

#[test]
fn authorizes_only_one_transfer_of_its_own_funds_within_the_policy() {
    let t = setup(100);
    let before = (t.state(), t.client().audit_head());
    let signature = t.sign(&t.key, &PAYLOAD, &t.policy);
    let one = |context: Context| vec![&t.env, context];

    // The policy's own limits, as on `execute`.
    assert_eq!(
        t.check_transfer(&t.recipient, 6),
        Err(Ok(Error::LimitExceeded))
    );
    assert_eq!(
        t.check_transfer(&t.recipient, 0),
        Err(Ok(Error::InvalidInput))
    );
    assert_eq!(
        t.check_transfer(&t.recipient, -1),
        Err(Ok(Error::InvalidInput))
    );
    assert_eq!(
        t.check_transfer(&t.stranger, 1),
        Err(Ok(Error::PolicyDenied))
    );

    let denied = [
        // An asset the wallet holds but the policy does not list.
        one(t.call(&t.other_asset, "transfer", &t.wallet, &t.recipient, 1)),
        // The policy's asset, but not a transfer. An allowance would let the spender take funds
        // later, outside every cap.
        one(t.call(&t.asset, "approve", &t.wallet, &t.recipient, 1)),
        one(t.call(&t.asset, "burn", &t.wallet, &t.recipient, 1)),
        one(t.call(&t.asset, "transfer_from", &t.wallet, &t.recipient, 1)),
        // Someone else's funds.
        one(t.call(&t.asset, "transfer", &t.stranger, &t.recipient, 1)),
        // The wallet's own entry points are not something it authorizes as an account.
        one(t.call(&t.wallet, "withdraw", &t.wallet, &t.recipient, 1)),
        // Two calls under one signature, each allowed on its own.
        vec![
            &t.env,
            t.transfer(&t.recipient, 1),
            t.transfer(&t.recipient, 1),
        ],
        // Nothing to authorize.
        Vec::new(&t.env),
        // A deployment on the wallet's behalf.
        one(Context::CreateContractHostFn(CreateContractHostFnContext {
            executable: ContractExecutable::Wasm(BytesN::from_array(&t.env, &[5; 32])),
            salt: BytesN::from_array(&t.env, &[6; 32]),
        })),
    ];
    for contexts in denied {
        assert_eq!(t.check(&signature, contexts), Err(Ok(Error::PolicyDenied)));
    }
    assert_eq!((t.state(), t.client().audit_head()), before);

    assert_eq!(t.check_transfer(&t.recipient, 5), Ok(()));
}

#[test]
fn requires_the_policy_signer_over_the_payload_and_the_policy() {
    let t = setup(100);
    let contexts = |amount| vec![&t.env, t.transfer(&t.recipient, amount)];

    // Another key.
    let attacker = SigningKey::from_bytes(&[8; 32]);
    let forged = t.sign(&attacker, &PAYLOAD, &t.policy);
    assert!(matches!(t.check(&forged, contexts(1)), Err(Err(_))));
    // The right key over another payload.
    let stale = t.sign(&t.key, &[4; 32], &t.policy);
    assert!(matches!(t.check(&stale, contexts(1)), Err(Err(_))));
    // The right key over the payload alone: the policy hash is part of what must be signed.
    let unbound = AccountSignature {
        policy_hash: t.policy.clone(),
        signature: BytesN::from_array(&t.env, &t.key.sign(&PAYLOAD).to_bytes()),
    };
    assert!(matches!(t.check(&unbound, contexts(1)), Err(Err(_))));
    // A policy this wallet does not hold.
    let unknown = BytesN::from_array(&t.env, &[2; 32]);
    assert_eq!(
        t.check(&t.sign(&t.key, &PAYLOAD, &unknown), contexts(1)),
        Err(Ok(Error::NotFound))
    );

    // The same agent under a second, larger policy. A signature names the policy it was made for:
    // one made for the small policy cannot be moved to the large one by whoever relays it.
    let large = t.as_owner(|| t.client().approve_policy(&t.terms(2, 50, 50)));
    let small = t.sign(&t.key, &PAYLOAD, &t.policy);
    let moved = AccountSignature {
        policy_hash: large.clone(),
        ..small.clone()
    };
    assert_eq!(t.check(&small, contexts(40)), Err(Ok(Error::LimitExceeded)));
    assert!(matches!(t.check(&moved, contexts(40)), Err(Err(_))));
    assert_eq!(t.spent(), 0);
    // The agent itself may choose the large policy, and only that policy's budget is charged.
    assert_eq!(
        t.check(&t.sign(&t.key, &PAYLOAD, &large), contexts(40)),
        Ok(())
    );
    assert_eq!(t.spent(), 0);
    assert_eq!(
        t.client()
            .policy_state(&large)
            .daily_spend
            .get_unchecked(0)
            .amount,
        40
    );
}

#[test]
fn refuses_a_replayed_or_altered_transfer() {
    let t = setup(100);
    let (entry, _) = t.entry(&t.key, &t.policy, &t.recipient, 3, 1);
    assert!(t.pay(entry.clone(), &t.recipient, 3));
    // The host consumes the entry's nonce, so the same signed entry never authorizes twice.
    assert!(!t.pay(entry, &t.recipient, 3));
    // The signature covers the exact invocation: another amount or recipient is another payload.
    assert!(!t.pay(
        t.entry(&t.key, &t.policy, &t.recipient, 3, 2).0,
        &t.recipient,
        4
    ));
    assert!(!t.pay(
        t.entry(&t.key, &t.policy, &t.recipient, 3, 3).0,
        &t.stranger,
        3
    ));
    // Another key over the right payload.
    let attacker = SigningKey::from_bytes(&[8; 32]);
    assert!(!t.pay(
        t.entry(&attacker, &t.policy, &t.recipient, 3, 4).0,
        &t.recipient,
        3
    ));
    // No entry: nobody can move the wallet's funds by calling the asset directly.
    t.env.set_auths(&[]);
    assert!(TokenClient::new(&t.env, &t.asset)
        .try_transfer(&t.wallet, &t.recipient, &1)
        .is_err());

    assert_eq!(t.balance(&t.recipient), 3);
    assert_eq!(t.spent(), 3);
}

#[test]
fn rolls_back_when_the_transfer_fails() {
    // Within every cap, but the wallet holds less than the payment.
    let t = setup(2);
    let before = (t.state(), t.client().audit_head());
    assert!(!t.pay(
        t.entry(&t.key, &t.policy, &t.recipient, 3, 1).0,
        &t.recipient,
        3
    ));
    t.env.set_auths(&[]);
    assert_eq!((t.state(), t.client().audit_head()), before);
    assert_eq!(t.balance(&t.wallet), 2);
    assert_eq!(t.balance(&t.recipient), 0);
}

#[test]
fn obeys_pause_revocation_and_the_validity_window() {
    let t = setup(100);
    assert_eq!(t.check_transfer(&t.recipient, 1), Ok(()));

    t.as_owner(|| t.client().pause());
    assert_eq!(t.check_transfer(&t.recipient, 1), Err(Ok(Error::Paused)));
    assert!(!t.pay(
        t.entry(&t.key, &t.policy, &t.recipient, 1, 1).0,
        &t.recipient,
        1
    ));
    t.as_owner(|| t.client().resume());
    assert_eq!(t.check_transfer(&t.recipient, 1), Ok(()));

    // The last second of the window passes; `valid_until` itself does not.
    t.env.ledger().set_timestamp(NOW + 7 * DAY - 1);
    assert_eq!(t.check_transfer(&t.recipient, 1), Ok(()));
    t.env.ledger().set_timestamp(NOW + 7 * DAY);
    assert_eq!(t.check_transfer(&t.recipient, 1), Err(Ok(Error::Expired)));

    t.env.ledger().set_timestamp(NOW);
    t.as_owner(|| t.client().revoke_policy(&t.policy));
    assert_eq!(t.check_transfer(&t.recipient, 1), Err(Ok(Error::Revoked)));
    assert!(!t.pay(
        t.entry(&t.key, &t.policy, &t.recipient, 1, 2).0,
        &t.recipient,
        1
    ));
    t.env.set_auths(&[]);
    assert_eq!(t.balance(&t.recipient), 0);
}

#[test]
fn is_not_valid_before_the_policy_starts() {
    let t = setup(100);
    let mut later = t.terms(3, 5, 20);
    later.valid_after = NOW + DAY;
    let policy = t.as_owner(|| t.client().approve_policy(&later));
    let signature = t.sign(&t.key, &PAYLOAD, &policy);
    let contexts = || vec![&t.env, t.transfer(&t.recipient, 1)];
    assert_eq!(
        t.check(&signature, contexts()),
        Err(Ok(Error::PolicyDenied))
    );
    t.env.ledger().set_timestamp(NOW + DAY);
    assert_eq!(t.check(&signature, contexts()), Ok(()));
}

#[test]
fn consults_the_live_identity_and_verification() {
    let t = setup(100);
    assert_eq!(t.check_transfer(&t.recipient, 1), Ok(()));

    // A result revoked after a payment was signed.
    let (signed_before, _) = t.entry(&t.key, &t.policy, &t.recipient, 1, 1);
    t.as_owner(|| {
        VerificationRegistryClient::new(&t.env, &t.verifier).revoke(
            &t.agent.agent_id,
            &t.agent.revision,
            &t.provider,
            &1,
        )
    });
    assert_eq!(t.check_transfer(&t.recipient, 1), Err(Ok(Error::Revoked)));
    assert!(!t.pay(signed_before, &t.recipient, 1));
    t.env.set_auths(&[]);

    // An identity that changed: the policy names an earlier revision.
    t.as_owner(|| {
        AgentRegistryClient::new(&t.env, &t.agents).update_metadata(
            &t.agent.agent_id,
            &t.agent.revision,
            &String::from_str(&t.env, "https://agent.example.test/changed.json"),
            &BytesN::from_array(&t.env, &[5; 32]),
        )
    });
    assert_eq!(
        t.check_transfer(&t.recipient, 1),
        Err(Ok(Error::IdentityChanged))
    );
    assert_eq!(t.spent(), 1);
    let _ = &t.owner;
}

#[test]
fn check_payment_explains_a_refusal_without_authorization() {
    let t = setup(100);
    let check = |asset: &Address, to: &Address, amount: i128| {
        t.client()
            .try_check_payment(&t.policy, asset, to, &amount)
            .map(|state| state.unwrap())
            .map_err(|error| error.unwrap())
    };
    let before = (t.state(), t.client().audit_head());

    // What the payment would leave, with nothing stored and nobody authenticated.
    let after = check(&t.asset, &t.recipient, 5).unwrap();
    assert_eq!(after.daily_spend.get_unchecked(0).amount, 5);
    assert_eq!(after.next_sequence, 1);
    assert_eq!((t.state(), t.client().audit_head()), before);

    assert_eq!(check(&t.asset, &t.recipient, 6), Err(Error::LimitExceeded));
    assert_eq!(check(&t.asset, &t.stranger, 1), Err(Error::PolicyDenied));
    assert_eq!(
        check(&t.other_asset, &t.recipient, 1),
        Err(Error::PolicyDenied)
    );
    assert_eq!(check(&t.asset, &t.recipient, 0), Err(Error::InvalidInput));
    assert_eq!(check(&t.asset, &t.wallet, 1), Err(Error::InvalidInput));
    let unknown = BytesN::from_array(&t.env, &[2; 32]);
    assert_eq!(
        t.client()
            .try_check_payment(&unknown, &t.asset, &t.recipient, &1)
            .map_err(|error| error.unwrap()),
        Err(Error::NotFound)
    );

    // It tracks the budget both paths have used.
    assert_eq!(t.execute(5), Ok(()));
    assert_eq!(t.check_transfer(&t.recipient, 5), Ok(()));
    assert_eq!(t.check_transfer(&t.recipient, 5), Ok(()));
    assert_eq!(
        check(&t.asset, &t.recipient, 5)
            .unwrap()
            .daily_spend
            .get_unchecked(0)
            .amount,
        20
    );
    assert_eq!(t.check_transfer(&t.recipient, 5), Ok(()));
    assert_eq!(check(&t.asset, &t.recipient, 1), Err(Error::LimitExceeded));

    t.as_owner(|| t.client().pause());
    assert_eq!(check(&t.asset, &t.recipient, 1), Err(Error::Paused));
}
