extern crate std;

use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    auth::{Context, ContractContext, ContractExecutable, CreateContractHostFnContext},
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{self, Limits, WriteXdr},
    Address, Bytes, BytesN, Env, IntoVal, InvokeError, String, Symbol, TryFromVal, Val, Vec,
};
use stellar_agent_auth_agent_registry::{AgentRegistry, AgentRegistryClient as Registry};
use stellar_agent_auth_shared_types::{
    attestation::{
        risk_score, AssessmentMode, CheckKind, CheckOutcome, CheckResult, VerificationResult,
    },
    errors::Error,
    SCHEMA_VERSION,
};
use stellar_agent_auth_verification_registry::{
    VerificationRegistry, VerificationRegistryClient as Verification,
};

use crate::{AccountProbe, AccountProbeClient, AgentSignature, Config, Spend};

const UNIT: i128 = 10_000_000;
const DAY: u64 = 86_400;
const PAYLOAD: [u8; 32] = [3; 32];

type Denied = Result<Error, InvokeError>;

struct Test {
    env: Env,
    key: SigningKey,
    controller: Address,
    provider: Address,
    registry: Address,
    verification: Address,
    token: Address,
    probe: Address,
    recipient: Address,
    stranger: Address,
    config: Config,
}

/// The account address of an ed25519 key, as the agent registry stores an agent signer.
fn account(env: &Env, key: &[u8; 32]) -> Address {
    let address = xdr::ScAddress::Account(xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(
        xdr::Uint256(*key),
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

/// Both registries, a registered agent with a passing fixture result, an asset, and the account
/// holding `funded` units under a 5-per-payment, 20-per-day policy for one recipient. Authorization
/// is enforced from here on: nothing below is mocked.
fn setup(funded: i128) -> Test {
    let env = Env::default();
    env.ledger().set_timestamp(100 * DAY + 3_600);
    env.mock_all_auths();

    let key = SigningKey::from_bytes(&[7; 32]);
    let signer = account(&env, &key.verifying_key().to_bytes());
    let admin = Address::generate(&env);
    let controller = Address::generate(&env);
    let provider = Address::generate(&env);
    let recipient = Address::generate(&env);
    let stranger = Address::generate(&env);

    let registry = env.register(AgentRegistry, ());
    let verification = env.register(VerificationRegistry, (admin.clone(), registry.clone()));
    Verification::new(&env, &verification).approve_provider(&provider, &AssessmentMode::Fixture);
    let identity = Registry::new(&env, &registry).register(
        &controller,
        &signer,
        &String::from_str(&env, "https://agent.example.test/account-probe.json"),
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
    Verification::new(&env, &verification).publish(&VerificationResult {
        schema_version: SCHEMA_VERSION,
        agent_id: identity.agent_id,
        revision: identity.revision,
        provider: provider.clone(),
        sequence: 1,
        mode: AssessmentMode::Fixture,
        risk_score: risk_score(&checks),
        checks,
        serious_wallet_risks: 0,
        evidence_hash: BytesN::from_array(&env, &[9; 32]),
        issued_at: env.ledger().timestamp(),
        expires_at: env.ledger().timestamp() + 30 * DAY,
        revoked: false,
    });

    let token = env.register_stellar_asset_contract_v2(admin).address();
    let config = Config {
        policy_id: BytesN::from_array(&env, &[1; 32]),
        signer_key: BytesN::from_array(&env, &key.verifying_key().to_bytes()),
        agent_id: identity.agent_id,
        revision: identity.revision,
        agent_registry: registry.clone(),
        verification_registry: verification.clone(),
        provider: provider.clone(),
        required_checks: vec![&env, CheckKind::Metadata, CheckKind::SignerAccount],
        max_assessment_age: DAY,
        max_risk_score: 0,
        asset: token.clone(),
        per_transaction: 5 * UNIT,
        per_day: 20 * UNIT,
        recipients: vec![&env, recipient.clone()],
    };
    let probe = env.register(AccountProbe, (config.clone(),));
    StellarAssetClient::new(&env, &token).mint(&probe, &funded);

    env.set_auths(&[]);
    Test {
        env,
        key,
        controller,
        provider,
        registry,
        verification,
        token,
        probe,
        recipient,
        stranger,
        config,
    }
}

impl Test {
    fn spend(&self) -> Spend {
        AccountProbeClient::new(&self.env, &self.probe).spend()
    }

    fn balance(&self, holder: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(holder)
    }

    /// The agent's signature over `payload || policy_id`, as `key`.
    fn sign(&self, key: &SigningKey, payload: &[u8; 32], policy_id: &BytesN<32>) -> AgentSignature {
        let mut message = [0u8; 64];
        message[..32].copy_from_slice(payload);
        message[32..].copy_from_slice(&policy_id.to_array());
        AgentSignature {
            policy_id: policy_id.clone(),
            signature: BytesN::from_array(&self.env, &key.sign(&message).to_bytes()),
        }
    }

    fn agent_signature(&self) -> AgentSignature {
        self.sign(&self.key, &PAYLOAD, &self.config.policy_id)
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
        self.call(&self.token, "transfer", &self.probe, to, amount)
    }

    /// `__check_auth` on its own, as the host would call it for `contexts`.
    fn check(&self, signature: &AgentSignature, contexts: Vec<Context>) -> Result<(), Denied> {
        self.env.try_invoke_contract_check_auth::<Error>(
            &self.probe,
            &BytesN::from_array(&self.env, &PAYLOAD),
            signature.clone().into_val(&self.env),
            &contexts,
        )
    }

    fn check_transfer(&self, to: &Address, amount: i128) -> Result<(), Denied> {
        self.check(
            &self.agent_signature(),
            vec![&self.env, self.transfer(to, amount)],
        )
    }

    /// A complete authorization entry for `asset.transfer(account, to, signed_amount)`, signed by
    /// `key` over the real payload hash. This is what a client would hand to a relayer.
    fn entry(
        &self,
        key: &SigningKey,
        to: &Address,
        signed_amount: i128,
        nonce: i64,
    ) -> xdr::SorobanAuthorizationEntry {
        let env = &self.env;
        let args = std::vec![
            scval(env, self.probe.clone()),
            scval(env, to.clone()),
            scval(env, signed_amount),
        ];
        let invocation = xdr::SorobanAuthorizedInvocation {
            function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
                contract_address: sc_address(env, &self.token),
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
        let signature = self.sign(key, &payload, &self.config.policy_id);
        xdr::SorobanAuthorizationEntry {
            credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
                address: sc_address(env, &self.probe),
                nonce,
                signature_expiration_ledger: expiration,
                signature: scval(env, signature),
            }),
            root_invocation: invocation,
        }
    }

    /// A plain `asset.transfer(account, to, amount)` carrying `entry` and nothing else, the way
    /// any contract or relayer that knows nothing of this account would make it.
    fn pay(&self, entry: xdr::SorobanAuthorizationEntry, to: &Address, amount: i128) -> bool {
        self.env.set_auths(&[entry]);
        let paid = TokenClient::new(&self.env, &self.token)
            .try_transfer(&self.probe, to, &amount)
            .is_ok();
        self.env.set_auths(&[]);
        paid
    }
}

#[test]
fn pays_through_a_plain_token_transfer() {
    let t = setup(50 * UNIT);
    let entry = t.entry(&t.key, &t.recipient, 3 * UNIT, 1);
    assert!(t.pay(entry, &t.recipient, 3 * UNIT));
    // Read before any other call: the test host keeps the events of the latest invocation only.
    let published = t.env.events().all().filter_by_contract(&t.probe);
    assert_eq!(published.events().len(), 1);

    assert_eq!(t.balance(&t.recipient), 3 * UNIT);
    assert_eq!(t.balance(&t.probe), 47 * UNIT);
    // The policy ran inside `__check_auth`, once: it consulted both registries, wrote the spend and
    // published its event, all in the token's own invocation.
    assert_eq!(
        t.spend(),
        Spend {
            utc_day: 100,
            amount: 3 * UNIT,
            count: 1
        }
    );
}

#[test]
fn refuses_a_replayed_or_altered_transfer() {
    let t = setup(50 * UNIT);
    let entry = t.entry(&t.key, &t.recipient, 3 * UNIT, 1);
    assert!(t.pay(entry.clone(), &t.recipient, 3 * UNIT));
    // The host consumes the entry's nonce, so the same signed entry never authorizes twice.
    assert!(!t.pay(entry, &t.recipient, 3 * UNIT));

    // The signature covers the exact invocation: another amount or recipient is another payload.
    assert!(!t.pay(
        t.entry(&t.key, &t.recipient, 3 * UNIT, 2),
        &t.recipient,
        4 * UNIT
    ));
    assert!(!t.pay(
        t.entry(&t.key, &t.recipient, 3 * UNIT, 3),
        &t.stranger,
        3 * UNIT
    ));
    // Another key, even over the right payload.
    let attacker = SigningKey::from_bytes(&[8; 32]);
    assert!(!t.pay(
        t.entry(&attacker, &t.recipient, 3 * UNIT, 4),
        &t.recipient,
        3 * UNIT
    ));
    // No entry at all.
    t.env.set_auths(&[]);
    assert!(TokenClient::new(&t.env, &t.token)
        .try_transfer(&t.probe, &t.recipient, &UNIT)
        .is_err());

    assert_eq!(t.balance(&t.recipient), 3 * UNIT);
    assert_eq!(t.spend().count, 1);
}

#[test]
fn rolls_back_the_spend_when_the_transfer_fails() {
    // Within every cap, but the account holds less than the payment.
    let t = setup(2 * UNIT);
    let before = t.spend();
    assert!(!t.pay(
        t.entry(&t.key, &t.recipient, 3 * UNIT, 1),
        &t.recipient,
        3 * UNIT
    ));
    assert_eq!(t.spend(), before);
    assert_eq!(t.balance(&t.probe), 2 * UNIT);
    assert_eq!(t.balance(&t.recipient), 0);
}

#[test]
fn authorizes_only_a_transfer_the_policy_allows() {
    let t = setup(50 * UNIT);
    let before = t.spend();
    let signature = t.agent_signature();
    let one = |context: Context| vec![&t.env, context];
    let other_asset = Address::generate(&t.env);

    // The per-payment cap, to the unit.
    assert_eq!(
        t.check_transfer(&t.recipient, 5 * UNIT + 1),
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
    // A recipient the policy does not list.
    assert_eq!(
        t.check_transfer(&t.stranger, UNIT),
        Err(Ok(Error::PolicyDenied))
    );

    let denied = [
        // Another asset contract, even with the same call.
        one(t.call(&other_asset, "transfer", &t.probe, &t.recipient, UNIT)),
        // The policy's asset, but not a transfer: an allowance would let the spender drain it later.
        one(t.call(&t.token, "approve", &t.probe, &t.recipient, UNIT)),
        one(t.call(&t.token, "burn", &t.probe, &t.recipient, UNIT)),
        // Someone else's funds.
        one(t.call(&t.token, "transfer", &t.stranger, &t.recipient, UNIT)),
        // Two calls under one signature, each allowed on its own.
        vec![
            &t.env,
            t.transfer(&t.recipient, UNIT),
            t.transfer(&t.recipient, UNIT),
        ],
        // Nothing to authorize.
        Vec::new(&t.env),
        // A deployment on the account's behalf.
        one(Context::CreateContractHostFn(CreateContractHostFnContext {
            executable: ContractExecutable::Wasm(BytesN::from_array(&t.env, &[5; 32])),
            salt: BytesN::from_array(&t.env, &[6; 32]),
        })),
    ];
    for contexts in denied {
        assert_eq!(t.check(&signature, contexts), Err(Ok(Error::PolicyDenied)));
    }
    assert_eq!(t.spend(), before);

    assert_eq!(t.check_transfer(&t.recipient, 5 * UNIT), Ok(()));
    assert_eq!(t.spend().amount, 5 * UNIT);
}

#[test]
fn requires_the_agent_key_over_the_payload_and_the_policy() {
    let t = setup(50 * UNIT);
    let contexts = || vec![&t.env, t.transfer(&t.recipient, UNIT)];

    // Another key.
    let attacker = SigningKey::from_bytes(&[8; 32]);
    let forged = t.sign(&attacker, &PAYLOAD, &t.config.policy_id);
    assert!(matches!(t.check(&forged, contexts()), Err(Err(_))));
    // The right key over another payload.
    let stale = t.sign(&t.key, &[4; 32], &t.config.policy_id);
    assert!(matches!(t.check(&stale, contexts()), Err(Err(_))));
    // The right key over the payload alone: the policy ID is part of what must be signed.
    let unbound = AgentSignature {
        policy_id: t.config.policy_id.clone(),
        signature: BytesN::from_array(&t.env, &t.key.sign(&PAYLOAD).to_bytes()),
    };
    assert!(matches!(t.check(&unbound, contexts()), Err(Err(_))));
    // A valid signature for another policy ID, and one relabelled to this policy.
    let other_policy = BytesN::from_array(&t.env, &[2; 32]);
    let other = t.sign(&t.key, &PAYLOAD, &other_policy);
    assert_eq!(t.check(&other, contexts()), Err(Ok(Error::PolicyDenied)));
    let relabelled = AgentSignature {
        policy_id: t.config.policy_id.clone(),
        ..other
    };
    assert!(matches!(t.check(&relabelled, contexts()), Err(Err(_))));

    assert_eq!(t.spend().count, 0);
    assert_eq!(t.check(&t.agent_signature(), contexts()), Ok(()));
}

#[test]
fn enforces_the_daily_cap_and_resets_at_utc_midnight() {
    let t = setup(50 * UNIT);
    for _ in 0..4 {
        assert_eq!(t.check_transfer(&t.recipient, 5 * UNIT), Ok(()));
    }
    assert_eq!(t.spend().amount, 20 * UNIT);
    assert_eq!(
        t.check_transfer(&t.recipient, 1),
        Err(Ok(Error::LimitExceeded))
    );

    // One second before midnight still counts against today.
    t.env.ledger().set_timestamp(101 * DAY - 1);
    assert_eq!(
        t.check_transfer(&t.recipient, 1),
        Err(Ok(Error::LimitExceeded))
    );
    t.env.ledger().set_timestamp(101 * DAY);
    assert_eq!(t.check_transfer(&t.recipient, 5 * UNIT), Ok(()));
    assert_eq!(
        t.spend(),
        Spend {
            utc_day: 101,
            amount: 5 * UNIT,
            count: 5
        }
    );
}

#[test]
fn consults_the_live_verification_result() {
    let t = setup(50 * UNIT);
    assert_eq!(t.check_transfer(&t.recipient, UNIT), Ok(()));

    t.env.mock_all_auths();
    Verification::new(&t.env, &t.verification).revoke(
        &t.config.agent_id,
        &t.config.revision,
        &t.provider,
        &1,
    );
    t.env.set_auths(&[]);
    assert_eq!(
        t.check_transfer(&t.recipient, UNIT),
        Err(Ok(Error::ResultRevoked))
    );
    // The same through a real transfer: the registry's refusal fails the token call.
    assert!(!t.pay(t.entry(&t.key, &t.recipient, UNIT, 1), &t.recipient, UNIT));
    assert_eq!(t.spend().count, 1);
}

#[test]
fn consults_the_live_identity() {
    let t = setup(50 * UNIT);
    t.env.mock_all_auths();
    Registry::new(&t.env, &t.registry).update_metadata(
        &t.config.agent_id,
        &t.config.revision,
        &String::from_str(&t.env, "https://agent.example.test/changed.json"),
        &BytesN::from_array(&t.env, &[5; 32]),
    );
    t.env.set_auths(&[]);
    let _ = &t.controller;
    assert_eq!(
        t.check_transfer(&t.recipient, UNIT),
        Err(Ok(Error::IdentityChanged))
    );
    assert_eq!(t.spend().count, 0);
}
