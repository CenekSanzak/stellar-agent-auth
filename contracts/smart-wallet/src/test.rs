extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{AccountId, ContractId, Hash, PublicKey, ScAddress, Uint256},
    Address, BytesN, Env, Event, IntoVal, InvokeError, String, Symbol, TryFromVal, Val, Vec,
};
use stellar_agent_auth_agent_registry::{AgentRegistry, AgentRegistryClient};
use stellar_agent_auth_shared_types::{
    action::{Action, ActionKind, ActionRequest, ServicePayment, ServiceRule, Transfer},
    attestation::{
        risk_score, AssessmentMode, CheckKind, CheckOutcome, CheckResult, VerificationResult,
        KNOWN_COMPROMISE,
    },
    audit::{AuditEntry, AuditHead, AuditOutcome, ExecutedAction},
    encoding::{action_hash, audit_hash, policy_hash},
    errors::Error,
    events::WalletAudit,
    identity::AgentIdentity,
    policy::{
        AssetLimit, AssetSpend, Policy, PolicyState, ServicePermission, MAX_ACTIVE_POLICIES,
        SECONDS_PER_DAY,
    },
};
use stellar_agent_auth_verification_registry::{VerificationRegistry, VerificationRegistryClient};

use crate::{
    storage::{DataKey, TTL_EXTEND_TO},
    SmartWallet, SmartWalletClient,
};

/// A `try_` client result; the inner conversion error type depends on the return type.
type Outcome<T, C = soroban_sdk::ConversionError> =
    Result<Result<T, C>, Result<Error, InvokeError>>;

/// 2027-01-15T08:00:00Z; the next UTC midnight is 57,600 seconds later.
const NOW: u64 = 1_800_000_000;
const UNTIL_MIDNIGHT: u64 = 57_600;
const HOUR: u64 = 3_600;
const DAY: u64 = SECONDS_PER_DAY;
const FUNDED: i128 = 100;

/// Random standard account address; agent signers must be accounts.
fn account(env: &Env) -> Address {
    let ScAddress::Contract(ContractId(Hash(key))) = ScAddress::from(&Address::generate(env))
    else {
        unreachable!()
    };
    Address::try_from_val(
        env,
        &ScAddress::Account(AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(key)))),
    )
    .unwrap()
}

#[track_caller]
fn denied<T: core::fmt::Debug + PartialEq, C: core::fmt::Debug + PartialEq>(
    outcome: Outcome<T, C>,
) {
    assert_eq!(outcome, Err(Err(InvokeError::Abort)));
}

#[track_caller]
fn failed<T: core::fmt::Debug + PartialEq, C: core::fmt::Debug + PartialEq>(
    outcome: Outcome<T, C>,
    error: Error,
) {
    assert_eq!(outcome, Err(Ok(error)));
}

/// An asset whose transfers always fail, to prove rollback after the wallet's own state changes.
#[contract]
pub struct FailingToken;

#[contractimpl]
impl FailingToken {
    pub fn balance(_env: Env, _id: Address) -> i128 {
        i128::MAX
    }

    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {
        panic!("token transfer failed");
    }
}

/// An asset that accepts any transfer, to reach arithmetic limits no real balance could fund.
#[contract]
pub struct PermissiveToken;

#[contractimpl]
impl PermissiveToken {
    pub fn balance(_env: Env, _id: Address) -> i128 {
        0
    }

    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
}

/// A snapshot of everything a failed execution must leave untouched.
#[derive(Debug, PartialEq)]
struct Snapshot {
    state: PolicyState,
    head: AuditHead,
    wallet: i128,
    recipient: i128,
}

struct Test {
    env: Env,
    wallet: Address,
    agents: Address,
    verifier: Address,
    owner: Address,
    controller: Address,
    provider: Address,
    funder: Address,
    recipient: Address,
    stranger: Address,
    attacker: Address,
    asset: Address,
    other_asset: Address,
    agent: AgentIdentity,
}

impl Test {
    /// Registries with a registered agent and a passing live result, two funded assets and a wallet,
    /// at ledger time `NOW`. Authorization is mocked for setup only.
    fn new() -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(NOW);
        env.mock_all_auths();
        let agents = env.register(AgentRegistry, ());
        let admin = Address::generate(&env);
        let verifier = env.register(VerificationRegistry, (admin, agents.clone()));
        let controller = Address::generate(&env);
        let agent = AgentRegistryClient::new(&env, &agents).register(
            &controller,
            &account(&env),
            &String::from_str(&env, "https://agent.example/v1.json"),
            &BytesN::from_array(&env, &[1; 32]),
        );
        let provider = Address::generate(&env);
        VerificationRegistryClient::new(&env, &verifier)
            .approve_provider(&provider, &AssessmentMode::Live);

        let owner = Address::generate(&env);
        let wallet = env.register(
            SmartWallet,
            (owner.clone(), agents.clone(), verifier.clone()),
        );
        let issuer = Address::generate(&env);
        let asset = env
            .register_stellar_asset_contract_v2(issuer.clone())
            .address();
        let other_asset = env.register_stellar_asset_contract_v2(issuer).address();
        let funder = Address::generate(&env);
        for token in [&asset, &other_asset] {
            StellarAssetClient::new(&env, token).mint(&funder, &1_000_000);
        }
        let t = Test {
            recipient: Address::generate(&env),
            stranger: Address::generate(&env),
            attacker: Address::generate(&env),
            env,
            wallet,
            agents,
            verifier,
            owner,
            controller,
            provider,
            funder,
            asset,
            other_asset,
            agent,
        };
        t.publish(t.result(1));
        t.client().fund(&t.funder, &t.asset, &FUNDED);
        t.client().fund(&t.funder, &t.other_asset, &FUNDED);
        t
    }

    fn client(&self) -> SmartWalletClient<'_> {
        SmartWalletClient::new(&self.env, &self.wallet)
    }

    fn signer(&self) -> Address {
        self.agent.signer.clone()
    }

    fn verification(&self) -> VerificationRegistryClient<'_> {
        VerificationRegistryClient::new(&self.env, &self.verifier)
    }

    fn registry(&self) -> AgentRegistryClient<'_> {
        AgentRegistryClient::new(&self.env, &self.agents)
    }

    fn token(&self, asset: &Address) -> TokenClient<'_> {
        TokenClient::new(&self.env, asset)
    }

    /// The SOW policy: 5 per payment and 20 per UTC day of `asset` to `recipient`, for seven days.
    fn policy(&self, id: u8) -> Policy {
        let env = &self.env;
        Policy {
            schema_version: 1,
            policy_id: BytesN::from_array(env, &[id; 32]),
            agent_id: self.agent.agent_id,
            revision: self.agent.revision,
            signer: self.signer(),
            provider: self.provider.clone(),
            required_checks: vec![
                env,
                CheckKind::Endpoint,
                CheckKind::Metadata,
                CheckKind::SignerAccount,
            ],
            max_assessment_age: 30 * DAY,
            max_risk_score: 10,
            assets: vec![
                env,
                AssetLimit {
                    asset: self.asset.clone(),
                    per_transaction: 5,
                    per_day: 20,
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

    /// The limited verifier's passing checks for the agent's current revision, valid for 30 days.
    fn result(&self, sequence: u64) -> VerificationResult {
        let env = &self.env;
        let check = |kind, outcome, score| CheckResult {
            kind,
            outcome,
            score,
        };
        let checks = vec![
            env,
            check(CheckKind::Code, CheckOutcome::Unsupported, None),
            check(CheckKind::Endpoint, CheckOutcome::Passed, Some(0)),
            check(CheckKind::Metadata, CheckOutcome::Passed, Some(0)),
            check(CheckKind::SignerAccount, CheckOutcome::Passed, Some(0)),
            check(CheckKind::SignerHistory, CheckOutcome::Inconclusive, None),
        ];
        VerificationResult {
            schema_version: 1,
            agent_id: self.agent.agent_id,
            revision: self.agent.revision,
            provider: self.provider.clone(),
            sequence,
            mode: AssessmentMode::Live,
            risk_score: risk_score(&checks),
            checks,
            serious_wallet_risks: 0,
            evidence_hash: BytesN::from_array(env, &[9; 32]),
            issued_at: env.ledger().timestamp(),
            expires_at: env.ledger().timestamp() + 30 * DAY,
            revoked: false,
        }
    }

    fn publish(&self, result: VerificationResult) {
        self.env.mock_all_auths();
        self.verification().publish(&result);
    }

    fn approve(&self, policy: &Policy) -> BytesN<32> {
        self.env.mock_all_auths();
        self.client().approve_policy(policy)
    }

    fn try_approve(&self, policy: &Policy) -> Outcome<BytesN<32>> {
        self.env.mock_all_auths();
        self.client().try_approve_policy(policy)
    }

    fn revoke(&self, hash: &BytesN<32>) -> Outcome<PolicyState> {
        self.env.mock_all_auths();
        self.client().try_revoke_policy(hash)
    }

    fn transfer_to(&self, recipient: &Address, asset: &Address, amount: i128) -> Action {
        Action::Transfer(Transfer {
            asset: asset.clone(),
            recipient: recipient.clone(),
            amount,
        })
    }

    fn request(&self, hash: &BytesN<32>, sequence: u64, action: Action) -> ActionRequest {
        ActionRequest {
            schema_version: 1,
            wallet: self.wallet.clone(),
            policy_hash: hash.clone(),
            sequence,
            deadline: self.env.ledger().timestamp() + 300,
            action,
        }
    }

    /// `amount` of the policy asset to the approved recipient.
    fn payment(&self, hash: &BytesN<32>, sequence: u64, amount: i128) -> ActionRequest {
        let action = self.transfer_to(&self.recipient, &self.asset, amount);
        self.request(hash, sequence, action)
    }

    /// Executes in recording mode and, on success, asserts that the agent signer's authorization of
    /// exactly `execute(request)` was the only one required. The test host cannot mock a specific
    /// account's authorization, so impostors use `execute_as`; real signed entries and their
    /// tampering are covered by the local-network suite.
    fn execute(&self, request: &ActionRequest) -> Outcome<BytesN<32>> {
        self.env.mock_all_auths();
        let outcome = self.client().try_execute(request);
        if outcome.is_ok() {
            assert_eq!(
                self.env.auths(),
                std::vec![(
                    self.signer(),
                    AuthorizedInvocation {
                        function: AuthorizedFunction::Contract((
                            self.wallet.clone(),
                            Symbol::new(&self.env, "execute"),
                            (request.clone(),).into_val(&self.env),
                        )),
                        sub_invocations: std::vec![],
                    }
                )]
            );
        }
        outcome
    }

    /// Enforcing mode with only the (contract) `address` authorizing `execute(request)`.
    fn execute_as(&self, signer: &Address, request: &ActionRequest) -> Outcome<BytesN<32>> {
        self.allow(signer, "execute", (request.clone(),).into_val(&self.env));
        self.client().try_execute(request)
    }

    /// Enforcing mode with only `address` authorizing `wallet.fn_name(args)`.
    fn allow(&self, address: &Address, fn_name: &str, args: Vec<Val>) {
        let invoke = MockAuthInvoke {
            contract: &self.wallet,
            fn_name,
            args,
            sub_invokes: &[],
        };
        self.env.mock_auths(&[MockAuth {
            address,
            invoke: &invoke,
        }]);
    }

    fn state(&self, hash: &BytesN<32>) -> PolicyState {
        self.client().policy_state(hash)
    }

    fn snapshot(&self, hash: &BytesN<32>) -> Snapshot {
        Snapshot {
            state: self.state(hash),
            head: self.client().audit_head(),
            wallet: self.token(&self.asset).balance(&self.wallet),
            recipient: self.token(&self.asset).balance(&self.recipient),
        }
    }

    fn spend(&self, amount: i128) -> Vec<AssetSpend> {
        vec![
            &self.env,
            AssetSpend {
                asset: self.asset.clone(),
                amount,
            },
        ]
    }

    fn advance(&self, seconds: u64) {
        let now = self.env.ledger().timestamp();
        self.env.ledger().set_timestamp(now + seconds);
    }

    /// Asserts that the last invocation appended exactly one audit entry after `before` and
    /// published it; reads the head only after inspecting the invocation's events.
    #[track_caller]
    fn assert_audit(&self, before: &AuditHead, actor: &Address, outcome: AuditOutcome) {
        let entry = AuditEntry {
            schema_version: 1,
            wallet: self.wallet.clone(),
            sequence: before.sequence + 1,
            previous_hash: before.hash.clone(),
            ledger: self.env.ledger().sequence(),
            timestamp: self.env.ledger().timestamp(),
            actor: actor.clone(),
            outcome,
        };
        let hash = audit_hash(&self.env, &entry).unwrap();
        let event = WalletAudit {
            sequence: entry.sequence,
            entry,
            hash: hash.clone(),
        };
        assert_eq!(
            self.env.events().all().filter_by_contract(&self.wallet),
            std::vec![event.to_xdr(&self.env, &self.wallet)]
        );
        assert_eq!(
            self.client().audit_head(),
            AuditHead {
                sequence: before.sequence + 1,
                hash
            }
        );
    }
}

// --- Construction ------------------------------------------------------------------------------

#[test]
fn constructor_binds_roles_and_starts_an_empty_audit_chain() {
    let t = Test::new();
    let client = t.client();
    assert_eq!(client.owner(), t.owner);
    assert_eq!(client.agent_registry(), t.agents);
    assert_eq!(client.verification_registry(), t.verifier);
    assert!(!client.paused());
    assert_eq!(client.policies(), Vec::new(&t.env));
    assert_eq!(
        client.audit_head(),
        AuditHead {
            sequence: 0,
            hash: BytesN::from_array(&t.env, &[0; 32])
        }
    );
    let ttl = t
        .env
        .as_contract(&t.wallet, || t.env.storage().instance().get_ttl());
    assert_eq!(ttl, TTL_EXTEND_TO);
}

/// `env.register` does not enforce constructor authorization, so this asserts the exact recorded
/// requirement; the local-network suite shows a deployment without the owner's signature fails.
#[test]
fn constructor_records_the_owner_authorization() {
    let t = Test::new();
    let owner = Address::generate(&t.env);
    t.env.mock_all_auths();
    let id = t.env.register(
        SmartWallet,
        (owner.clone(), t.agents.clone(), t.verifier.clone()),
    );
    let [(address, invocation)] = t.env.auths().try_into().unwrap();
    assert_eq!(address, owner);
    let AuthorizedFunction::Contract((contract, name, args)) = invocation.function else {
        panic!("expected a contract invocation")
    };
    assert_eq!(
        (contract, name, args),
        (
            id,
            Symbol::new(&t.env, "__constructor"),
            (owner, t.agents.clone(), t.verifier.clone()).into_val(&t.env)
        )
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn constructor_rejects_an_account_registry() {
    let t = Test::new();
    t.env.register(
        SmartWallet,
        (t.owner.clone(), account(&t.env), t.verifier.clone()),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn constructor_rejects_a_verification_registry_bound_elsewhere() {
    let t = Test::new();
    let other_agents = t.env.register(AgentRegistry, ());
    let other_verifier = t.env.register(
        VerificationRegistry,
        (Address::generate(&t.env), other_agents),
    );
    t.env.register(
        SmartWallet,
        (t.owner.clone(), t.agents.clone(), other_verifier),
    );
}

// --- Funding and owner actions (A08, A09) ---------------------------------------------------------

#[test]
fn funding_needs_only_the_funder_and_grants_no_authority() {
    let t = Test::new();
    let client = t.client();
    let args: Vec<Val> = (t.funder.clone(), t.asset.clone(), 7i128).into_val(&t.env);
    let invoke = MockAuthInvoke {
        contract: &t.wallet,
        fn_name: "fund",
        args: args.clone(),
        sub_invokes: &[MockAuthInvoke {
            contract: &t.asset,
            fn_name: "transfer",
            args: (t.funder.clone(), t.wallet.clone(), 7i128).into_val(&t.env),
            sub_invokes: &[],
        }],
    };
    t.env.mock_auths(&[MockAuth {
        address: &t.funder,
        invoke: &invoke,
    }]);
    assert_eq!(client.fund(&t.funder, &t.asset, &7), FUNDED + 7);
    assert_eq!(t.token(&t.asset).balance(&t.wallet), FUNDED + 7);
    // Funding is not an owner action: no audit entry, no policy, no role.
    assert_eq!(client.audit_head().sequence, 0);
    assert_eq!(client.policies(), Vec::new(&t.env));

    // A funder cannot fund from someone else's balance or act as the owner.
    t.allow(&t.attacker, "fund", args);
    denied(client.try_fund(&t.funder, &t.asset, &7));
    t.allow(&t.funder, "pause", ().into_val(&t.env));
    denied(client.try_pause());

    t.env.mock_all_auths();
    failed(
        client.try_fund(&t.funder, &t.asset, &0),
        Error::InvalidInput,
    );
    failed(
        client.try_fund(&t.funder, &t.asset, &-1),
        Error::InvalidInput,
    );
    failed(
        client.try_fund(&t.wallet, &t.asset, &1),
        Error::InvalidInput,
    );
    failed(
        client.try_fund(&t.funder, &account(&t.env), &1),
        Error::InvalidInput,
    );
    failed(
        client.try_fund(&t.stranger, &t.asset, &1),
        Error::TransferFailed,
    );
}

#[test]
fn owner_actions_reject_every_other_role() {
    let t = Test::new();
    let client = t.client();
    let policy = t.policy(1);
    let hash = t.approve(&policy);
    let replacement = t.policy(2);
    let env = &t.env;
    let cases: [(&str, Vec<Val>); 6] = [
        ("approve_policy", (replacement.clone(),).into_val(env)),
        ("revoke_policy", (hash.clone(),).into_val(env)),
        (
            "replace_policy",
            (hash.clone(), replacement.clone()).into_val(env),
        ),
        ("pause", ().into_val(env)),
        ("resume", ().into_val(env)),
        (
            "withdraw",
            (t.asset.clone(), t.attacker.clone(), 1i128).into_val(env),
        ),
    ];
    // The agent signer is an account, which the host test cannot mock; the local-network suite
    // shows a real agent signature cannot act as the owner.
    for impostor in [&t.funder, &t.controller, &t.provider, &t.attacker] {
        for (name, args) in cases.iter() {
            t.allow(impostor, name, args.clone());
            let rejected = match *name {
                "approve_policy" => {
                    client.try_approve_policy(&replacement) == Err(Err(InvokeError::Abort))
                }
                "revoke_policy" => client.try_revoke_policy(&hash) == Err(Err(InvokeError::Abort)),
                "replace_policy" => {
                    client.try_replace_policy(&hash, &replacement) == Err(Err(InvokeError::Abort))
                }
                "pause" => client.try_pause() == Err(Err(InvokeError::Abort)),
                "resume" => client.try_resume() == Err(Err(InvokeError::Abort)),
                _ => client.try_withdraw(&t.asset, &t.attacker, &1) == Err(Err(InvokeError::Abort)),
            };
            assert!(rejected, "{name} by an impostor");
        }
    }
    assert_eq!(client.policies(), vec![env, hash.clone()]);
    assert!(!client.paused());
    assert_eq!(t.token(&t.asset).balance(&t.wallet), FUNDED);
    assert_eq!(client.audit_head().sequence, 1);
}

#[test]
fn owner_withdraws_and_pauses_with_audit_entries() {
    let t = Test::new();
    let client = t.client();
    let args: Vec<Val> = (t.asset.clone(), t.stranger.clone(), 30i128).into_val(&t.env);
    let before = client.audit_head();
    t.allow(&t.owner, "withdraw", args);
    assert_eq!(client.withdraw(&t.asset, &t.stranger, &30), FUNDED - 30);
    let withdrawal = Transfer {
        asset: t.asset.clone(),
        recipient: t.stranger.clone(),
        amount: 30,
    };
    t.assert_audit(&before, &t.owner, AuditOutcome::OwnerWithdrawal(withdrawal));
    assert_eq!(t.token(&t.asset).balance(&t.stranger), 30);

    let before = client.audit_head();
    t.allow(&t.owner, "pause", ().into_val(&t.env));
    client.pause();
    t.assert_audit(&before, &t.owner, AuditOutcome::PauseChanged(true));
    assert!(client.paused());
    t.env.mock_all_auths();
    failed(client.try_pause(), Error::Duplicate);

    // Funding and withdrawal stay available while agents are paused.
    assert_eq!(client.fund(&t.funder, &t.asset, &10), FUNDED - 20);
    assert_eq!(client.withdraw(&t.asset, &t.stranger, &5), FUNDED - 25);
    assert_eq!(client.balance(&t.asset), FUNDED - 25);

    let before = client.audit_head();
    client.resume();
    t.assert_audit(&before, &t.owner, AuditOutcome::PauseChanged(false));
    failed(client.try_resume(), Error::Duplicate);

    failed(
        client.try_withdraw(&t.asset, &t.stranger, &0),
        Error::InvalidInput,
    );
    failed(
        client.try_withdraw(&t.asset, &t.wallet, &1),
        Error::InvalidInput,
    );
    // More than the balance: the asset contract refuses and nothing is recorded.
    let head = client.audit_head();
    failed(
        client.try_withdraw(&t.asset, &t.stranger, &1_000),
        Error::TransferFailed,
    );
    assert_eq!(client.audit_head(), head);
}

// --- Policy approval -------------------------------------------------------------------------------

#[test]
fn approval_stores_a_canonical_policy_and_fresh_state() {
    let t = Test::new();
    let client = t.client();
    let mut policy = t.policy(1);
    policy.required_checks = vec![
        &t.env,
        CheckKind::SignerAccount,
        CheckKind::Metadata,
        CheckKind::Endpoint,
    ];
    let before = client.audit_head();
    t.allow(
        &t.owner,
        "approve_policy",
        (policy.clone(),).into_val(&t.env),
    );
    let hash = client.approve_policy(&policy);
    t.assert_audit(&before, &t.owner, AuditOutcome::PolicyCreated(hash.clone()));

    let canonical = policy.clone().canonicalize(&t.env).unwrap();
    assert_eq!(hash, policy_hash(&t.env, &t.wallet, &canonical).unwrap());
    assert_eq!(client.policy(&hash), canonical);
    assert_eq!(client.policies(), vec![&t.env, hash.clone()]);
    assert_eq!(
        t.state(&hash),
        PolicyState {
            policy_hash: hash.clone(),
            revoked: false,
            next_sequence: 1,
            utc_day: NOW / DAY,
            daily_spend: Vec::new(&t.env),
        }
    );
    for key in [
        DataKey::Policy(hash.clone()),
        DataKey::PolicyState(hash.clone()),
        DataKey::PolicyId(policy.policy_id.clone()),
    ] {
        let ttl = t
            .env
            .as_contract(&t.wallet, || t.env.storage().persistent().get_ttl(&key));
        assert_eq!(ttl, TTL_EXTEND_TO);
    }
    failed(
        client.try_policy(&BytesN::from_array(&t.env, &[7; 32])),
        Error::NotFound,
    );
    failed(
        client.try_policy_state(&BytesN::from_array(&t.env, &[7; 32])),
        Error::NotFound,
    );
}

#[test]
fn approval_rejects_policies_the_wallet_cannot_enforce() {
    let t = Test::new();
    let env = &t.env;
    let base = t.policy(1);
    let with = |change: &dyn Fn(&mut Policy)| {
        let mut policy = base.clone();
        change(&mut policy);
        policy
    };
    let service = ServiceRule {
        contract: Address::generate(env),
        service_id: BytesN::from_array(env, &[3; 32]),
    };
    let cases = [
        // Service payments are outside the v1 wallet.
        with(&|p| {
            p.action_kinds = vec![env, ActionKind::ServicePayment, ActionKind::Transfer];
            p.service = ServicePermission::Restricted(service.clone());
        }),
        with(&|p| {
            p.action_kinds = vec![env, ActionKind::ServicePayment];
            p.service = ServicePermission::Restricted(service.clone());
        }),
        // The signer must be a standard account other than the owner.
        with(&|p| p.signer = Address::generate(env)),
        with(&|p| p.signer = t.owner.clone()),
        // Assets must be contracts, and the wallet cannot pay itself.
        with(&|p| {
            p.assets = vec![
                env,
                AssetLimit {
                    asset: account(env),
                    per_transaction: 1,
                    per_day: 1,
                },
            ]
        }),
        with(&|p| p.allowed_recipients.push_back(t.wallet.clone())),
        with(&|p| p.blocked_recipients.push_back(t.wallet.clone())),
        // Shared canonical rules.
        with(&|p| p.valid_after = p.valid_until),
        with(&|p| {
            p.assets.set(
                0,
                AssetLimit {
                    asset: t.asset.clone(),
                    per_transaction: 0,
                    per_day: 1,
                },
            )
        }),
        with(&|p| {
            p.assets.set(
                0,
                AssetLimit {
                    asset: t.asset.clone(),
                    per_transaction: 6,
                    per_day: 5,
                },
            )
        }),
        with(&|p| p.max_assessment_age = 0),
        with(&|p| p.required_checks = Vec::new(env)),
    ];
    for (i, policy) in cases.iter().enumerate() {
        assert_eq!(
            t.try_approve(policy),
            Err(Ok(Error::InvalidInput)),
            "case {i}"
        );
    }
    failed(
        t.try_approve(&with(&|p| p.schema_version = 2)),
        Error::UnsupportedVersion,
    );
    failed(
        t.try_approve(&with(&|p| {
            p.allowed_recipients = vec![env, t.recipient.clone(), t.recipient.clone()]
        })),
        Error::Duplicate,
    );
    // Already over: approving it could never authorize anything.
    t.advance(7 * DAY);
    failed(t.try_approve(&base), Error::Expired);
    assert_eq!(t.client().policies(), Vec::new(env));
    assert_eq!(t.client().audit_head().sequence, 0);
}

#[test]
fn approval_requires_the_live_identity_and_its_signer() {
    let t = Test::new();
    let mut policy = t.policy(1);
    policy.signer = account(&t.env);
    failed(t.try_approve(&policy), Error::IdentityChanged);
    let mut policy = t.policy(2);
    policy.revision += 1;
    failed(t.try_approve(&policy), Error::IdentityChanged);
    let mut policy = t.policy(3);
    policy.agent_id = 99;
    failed(t.try_approve(&policy), Error::NotFound);
}

#[test]
fn policy_ids_are_never_reused_and_active_policies_are_bounded() {
    let t = Test::new();
    let client = t.client();
    let hash = t.approve(&t.policy(1));
    // The same ID with different terms is still the same ID.
    let mut same_id = t.policy(1);
    same_id.assets.set(
        0,
        AssetLimit {
            asset: t.asset.clone(),
            per_transaction: 1,
            per_day: 1,
        },
    );
    failed(t.try_approve(&same_id), Error::Duplicate);
    failed(t.try_approve(&t.policy(1)), Error::Duplicate);
    t.revoke(&hash).unwrap().unwrap();
    failed(t.try_approve(&t.policy(1)), Error::Revoked);
    failed(t.try_approve(&same_id), Error::Revoked);

    let mut hashes = Vec::new(&t.env);
    for id in 2..(2 + MAX_ACTIVE_POLICIES as u8) {
        hashes.push_back(t.approve(&t.policy(id)));
    }
    assert_eq!(client.policies(), hashes);
    failed(t.try_approve(&t.policy(100)), Error::LimitExceeded);
    t.revoke(&hashes.get_unchecked(3)).unwrap().unwrap();
    hashes.remove(3);
    hashes.push_back(t.approve(&t.policy(100)));
    assert_eq!(client.policies(), hashes);
}

// --- The SOW gate (A10) ----------------------------------------------------------------------------

#[test]
fn signed_three_unit_payment_succeeds_once() {
    let t = Test::new();
    let client = t.client();
    let hash = t.approve(&t.policy(1));
    let request = t.payment(&hash, 1, 3);
    let before = client.audit_head();

    let action = t.execute(&request).unwrap().unwrap();
    assert_eq!(action, action_hash(&t.env, &request).unwrap());
    let executed = ExecutedAction {
        policy_hash: hash.clone(),
        action_hash: action.clone(),
        action: request.action.clone(),
    };
    // The audit event is the wallet's only event; the asset contract publishes its own transfer.
    t.assert_audit(&before, &t.signer(), AuditOutcome::Executed(executed));

    assert_eq!(t.token(&t.asset).balance(&t.wallet), FUNDED - 3);
    assert_eq!(t.token(&t.asset).balance(&t.recipient), 3);
    assert_eq!(
        t.state(&hash),
        PolicyState {
            policy_hash: hash.clone(),
            revoked: false,
            next_sequence: 2,
            utc_day: NOW / DAY,
            daily_spend: t.spend(3),
        }
    );
    // Replaying the confirmed request fails on the wallet sequence, whatever authorization is
    // supplied; the host nonce separately rejects a replayed signature on the network.
    let snapshot = t.snapshot(&hash);
    failed(t.execute(&request), Error::InvalidSequence);
    assert_eq!(t.snapshot(&hash), snapshot);
}

#[test]
fn execution_requires_exactly_the_policy_signer() {
    let t = Test::new();
    let hash = t.approve(&t.policy(1));
    let request = t.payment(&hash, 1, 3);
    let snapshot = t.snapshot(&hash);
    for impostor in [&t.owner, &t.controller, &t.provider, &t.funder, &t.attacker] {
        denied(t.execute_as(impostor, &request));
    }
    assert_eq!(t.snapshot(&hash), snapshot);
    // `execute` asserts the exact recorded requirement: the signer, this request, no sub-calls.
    t.execute(&request).unwrap().unwrap();
}

// --- Request binding (A11, A12) ----------------------------------------------------------------

#[test]
fn requests_are_bound_to_wallet_policy_and_sequence() {
    let t = Test::new();
    let hash = t.approve(&t.policy(1));
    let snapshot = t.snapshot(&hash);

    let mut request = t.payment(&hash, 1, 3);
    request.wallet = Address::generate(&t.env);
    failed(t.execute(&request), Error::PolicyDenied);
    let mut request = t.payment(&hash, 1, 3);
    request.schema_version = 2;
    failed(t.execute(&request), Error::UnsupportedVersion);
    let request = t.payment(&BytesN::from_array(&t.env, &[7; 32]), 1, 3);
    failed(t.execute(&request), Error::NotFound);
    for sequence in [0, 2, u64::MAX] {
        failed(
            t.execute(&t.payment(&hash, sequence, 3)),
            Error::InvalidSequence,
        );
    }
    assert_eq!(t.snapshot(&hash), snapshot);

    // Two requests signed for one sequence: exactly one commits.
    t.execute(&t.payment(&hash, 1, 3)).unwrap().unwrap();
    failed(t.execute(&t.payment(&hash, 1, 4)), Error::InvalidSequence);
    t.execute(&t.payment(&hash, 2, 4)).unwrap().unwrap();
    assert_eq!(t.state(&hash).daily_spend, t.spend(7));
    assert_eq!(t.state(&hash).next_sequence, 3);
}

// --- Time windows (A13) ------------------------------------------------------------------------

#[test]
fn deadline_and_policy_window_boundaries_are_exact() {
    let t = Test::new();
    let mut policy = t.policy(1);
    policy.valid_after = NOW + HOUR;
    policy.valid_until = NOW + 2 * HOUR;
    let hash = t.approve(&policy);

    // One second before the window opens, then at the exact start.
    t.env.ledger().set_timestamp(NOW + HOUR - 1);
    failed(t.execute(&t.payment(&hash, 1, 1)), Error::PolicyDenied);
    t.env.ledger().set_timestamp(NOW + HOUR);
    t.execute(&t.payment(&hash, 1, 1)).unwrap().unwrap();

    // The deadline is exclusive.
    let mut request = t.payment(&hash, 2, 1);
    request.deadline = NOW + HOUR + 10;
    t.env.ledger().set_timestamp(NOW + HOUR + 10);
    failed(t.execute(&request), Error::Expired);
    t.env.ledger().set_timestamp(NOW + HOUR + 9);
    t.execute(&request).unwrap().unwrap();

    // `valid_until` is exclusive too.
    let mut request = t.payment(&hash, 3, 1);
    request.deadline = NOW + 3 * HOUR;
    t.env.ledger().set_timestamp(NOW + 2 * HOUR - 1);
    let snapshot = t.snapshot(&hash);
    t.env.ledger().set_timestamp(NOW + 2 * HOUR);
    failed(t.execute(&request), Error::Expired);
    t.env.ledger().set_timestamp(NOW + 2 * HOUR - 1);
    assert_eq!(t.snapshot(&hash), snapshot);
    t.execute(&request).unwrap().unwrap();
}

// --- Assets, recipients and amounts (A14, A15) -------------------------------------------------

#[test]
fn unapproved_assets_and_recipients_fail_closed() {
    let t = Test::new();
    let mut policy = t.policy(1);
    policy.allowed_recipients.push_back(t.stranger.clone());
    policy.blocked_recipients.push_back(t.stranger.clone());
    let hash = t.approve(&policy);
    let snapshot = t.snapshot(&hash);
    let cases = [
        // Not on the allowlist.
        t.transfer_to(&t.attacker, &t.asset, 1),
        // Allowed and blocked: the blocklist wins.
        t.transfer_to(&t.stranger, &t.asset, 1),
        // An asset the policy does not name, even one the wallet holds.
        t.transfer_to(&t.recipient, &t.other_asset, 1),
        t.transfer_to(&t.recipient, &Address::generate(&t.env), 1),
    ];
    for action in cases {
        failed(t.execute(&t.request(&hash, 1, action)), Error::PolicyDenied);
    }
    let service = Action::ServicePayment(ServicePayment {
        service: ServiceRule {
            contract: Address::generate(&t.env),
            service_id: BytesN::from_array(&t.env, &[3; 32]),
        },
        payment: Transfer {
            asset: t.asset.clone(),
            recipient: t.recipient.clone(),
            amount: 1,
        },
    });
    failed(
        t.execute(&t.request(&hash, 1, service)),
        Error::PolicyDenied,
    );
    assert_eq!(t.snapshot(&hash), snapshot);

    // An empty allowlist pays no one.
    let mut empty = t.policy(2);
    empty.allowed_recipients = Vec::new(&t.env);
    let empty = t.approve(&empty);
    failed(t.execute(&t.payment(&empty, 1, 1)), Error::PolicyDenied);
}

#[test]
fn per_transfer_cap_is_inclusive_and_amounts_must_be_positive() {
    let t = Test::new();
    let hash = t.approve(&t.policy(1));
    failed(t.execute(&t.payment(&hash, 1, 6)), Error::LimitExceeded);
    failed(
        t.execute(&t.payment(&hash, 1, i128::MAX)),
        Error::LimitExceeded,
    );
    failed(t.execute(&t.payment(&hash, 1, 0)), Error::InvalidInput);
    failed(t.execute(&t.payment(&hash, 1, -3)), Error::InvalidInput);
    failed(
        t.execute(&t.payment(&hash, 1, i128::MIN)),
        Error::InvalidInput,
    );
    t.execute(&t.payment(&hash, 1, 5)).unwrap().unwrap();
    assert_eq!(t.token(&t.asset).balance(&t.recipient), 5);
}

#[test]
fn spend_arithmetic_is_checked() {
    let t = Test::new();
    let token = t.env.register(PermissiveToken, ());
    let mut policy = t.policy(1);
    policy.assets = vec![
        &t.env,
        AssetLimit {
            asset: token.clone(),
            per_transaction: i128::MAX,
            per_day: i128::MAX,
        },
    ];
    let hash = t.approve(&policy);
    let pay = |sequence, amount| {
        let action = t.transfer_to(&t.recipient, &token, amount);
        t.execute(&t.request(&hash, sequence, action))
    };
    pay(1, i128::MAX).unwrap().unwrap();
    failed(pay(2, 1), Error::ArithmeticOverflow);
    assert_eq!(t.state(&hash).next_sequence, 2);
}

// --- Daily budgets (A16, A17) ------------------------------------------------------------------

#[test]
fn daily_budget_is_exact_and_resets_at_utc_midnight() {
    let t = Test::new();
    let hash = t.approve(&t.policy(1));
    for sequence in 1..=4 {
        t.execute(&t.payment(&hash, sequence, 5)).unwrap().unwrap();
    }
    assert_eq!(t.state(&hash).daily_spend, t.spend(20));
    let snapshot = t.snapshot(&hash);
    failed(t.execute(&t.payment(&hash, 5, 1)), Error::LimitExceeded);
    assert_eq!(t.snapshot(&hash), snapshot);

    // One second before midnight is still the same day.
    t.advance(UNTIL_MIDNIGHT - 1);
    failed(t.execute(&t.payment(&hash, 5, 1)), Error::LimitExceeded);
    t.advance(1);
    // The read shows the new day before any execution writes it.
    let state = t.state(&hash);
    assert_eq!((state.utc_day, state.daily_spend.len()), (NOW / DAY + 1, 0));
    t.execute(&t.payment(&hash, 5, 5)).unwrap().unwrap();
    assert_eq!(t.state(&hash).daily_spend, t.spend(5));
    assert_eq!(t.token(&t.asset).balance(&t.recipient), 25);
}

#[test]
fn budgets_are_independent_per_asset_and_policy() {
    let t = Test::new();
    let mut policy = t.policy(1);
    policy.assets.push_back(AssetLimit {
        asset: t.other_asset.clone(),
        per_transaction: 5,
        per_day: 10,
    });
    let first = t.approve(&policy);
    let second = t.approve(&t.policy(2));
    for sequence in 1..=4 {
        t.execute(&t.payment(&first, sequence, 5)).unwrap().unwrap();
    }
    // The other asset has its own budget, never combined with the first.
    let other = |sequence, amount| {
        let action = t.transfer_to(&t.recipient, &t.other_asset, amount);
        t.request(&first, sequence, action)
    };
    t.execute(&other(5, 5)).unwrap().unwrap();
    t.execute(&other(6, 5)).unwrap().unwrap();
    failed(t.execute(&other(7, 1)), Error::LimitExceeded);
    // A second policy has its own budget and sequence: exposure is additive.
    for sequence in 1..=4 {
        t.execute(&t.payment(&second, sequence, 5))
            .unwrap()
            .unwrap();
    }
    assert_eq!(t.token(&t.asset).balance(&t.recipient), 40);
    assert_eq!(t.token(&t.other_asset).balance(&t.recipient), 10);
}

/// Seeded property test: random amounts and times never exceed either cap, every committed
/// payment moves exactly its amount, and failures change nothing.
#[test]
fn budget_accounting_matches_a_model() {
    let t = Test::new();
    t.client().fund(&t.funder, &t.asset, &10_000);
    let mut policy = t.policy(1);
    policy.valid_until = NOW + 30 * DAY;
    let hash = t.approve(&policy);
    let mut seed: u64 = 0x5eed_2026_1104;
    let mut next = |bound: u64| {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (seed >> 33) % bound
    };
    let (mut sequence, mut day, mut spent, mut paid) = (1u64, NOW / DAY, 0i128, 0i128);
    for _ in 0..300 {
        t.advance(next(4 * HOUR));
        let today = t.env.ledger().timestamp() / DAY;
        if today != day {
            (day, spent) = (today, 0);
        }
        let amount = next(8) as i128;
        let outcome = t.execute(&t.payment(&hash, sequence, amount));
        let expected = if amount == 0 {
            Err(Ok(Error::InvalidInput))
        } else if amount > 5 || spent + amount > 20 {
            Err(Ok(Error::LimitExceeded))
        } else {
            (sequence, spent, paid) = (sequence + 1, spent + amount, paid + amount);
            Ok(Ok(()))
        };
        assert_eq!(outcome.map(|r| r.map(|_| ())), expected);
        let state = t.state(&hash);
        assert_eq!(state.next_sequence, sequence);
        let recorded = state.daily_spend.iter().map(|s| s.amount).sum::<i128>();
        assert_eq!(recorded, spent);
        assert!(recorded <= 20);
        assert_eq!(t.token(&t.asset).balance(&t.recipient), paid);
    }
    assert_eq!(t.client().audit_head().sequence, 1 + sequence - 1);
}

// --- Pause and revocation (A18, A19, A22) --------------------------------------------------------

#[test]
fn pause_blocks_execution_and_resume_restores_only_eligible_policies() {
    let t = Test::new();
    let client = t.client();
    let live = t.approve(&t.policy(1));
    let revoked = t.approve(&t.policy(2));
    let mut short = t.policy(3);
    short.valid_until = NOW + HOUR;
    let short = t.approve(&short);
    t.revoke(&revoked).unwrap().unwrap();

    t.env.mock_all_auths();
    client.pause();
    let snapshot = t.snapshot(&live);
    failed(t.execute(&t.payment(&live, 1, 3)), Error::Paused);
    assert_eq!(t.snapshot(&live), snapshot);

    t.advance(HOUR);
    t.env.mock_all_auths();
    client.resume();
    t.execute(&t.payment(&live, 1, 3)).unwrap().unwrap();
    failed(t.execute(&t.payment(&revoked, 1, 3)), Error::Revoked);
    failed(t.execute(&t.payment(&short, 1, 3)), Error::Expired);
}

#[test]
fn revocation_is_terminal_and_blocks_already_signed_requests() {
    let t = Test::new();
    let client = t.client();
    let hash = t.approve(&t.policy(1));
    t.execute(&t.payment(&hash, 1, 3)).unwrap().unwrap();
    // Signed before the revocation, executed after it.
    let signed = t.payment(&hash, 2, 3);

    let before = client.audit_head();
    t.allow(&t.owner, "revoke_policy", (hash.clone(),).into_val(&t.env));
    let state = client.revoke_policy(&hash);
    t.assert_audit(&before, &t.owner, AuditOutcome::PolicyRevoked(hash.clone()));
    assert!(state.revoked);
    assert_eq!(state.next_sequence, 2);
    assert_eq!(client.policies(), Vec::new(&t.env));
    // The revoked policy stays readable.
    assert_eq!(
        client.policy(&hash),
        t.policy(1).canonicalize(&t.env).unwrap()
    );

    let snapshot = t.snapshot(&hash);
    failed(t.execute(&signed), Error::Revoked);
    failed(t.revoke(&hash), Error::Duplicate);
    failed(
        t.revoke(&BytesN::from_array(&t.env, &[7; 32])),
        Error::NotFound,
    );
    t.env.mock_all_auths();
    client.pause();
    client.resume();
    failed(t.execute(&signed), Error::Revoked);
    assert_eq!(t.snapshot(&hash).state, snapshot.state);
}

#[test]
fn replacement_is_atomic_with_an_explicit_fresh_budget() {
    let t = Test::new();
    let client = t.client();
    let old = t.approve(&t.policy(1));
    for sequence in 1..=4 {
        t.execute(&t.payment(&old, sequence, 5)).unwrap().unwrap();
    }

    // An invalid replacement leaves the old policy active.
    let mut invalid = t.policy(2);
    invalid.signer = t.owner.clone();
    t.env.mock_all_auths();
    failed(
        client.try_replace_policy(&old, &invalid),
        Error::InvalidInput,
    );
    assert_eq!(client.policies(), vec![&t.env, old.clone()]);
    assert!(!t.state(&old).revoked);
    // Replacing a policy with its own ID is a reuse.
    failed(
        client.try_replace_policy(&old, &t.policy(1)),
        Error::Revoked,
    );
    assert!(!t.state(&old).revoked);

    let replacement = t.policy(2);
    let before = client.audit_head();
    let args = (old.clone(), replacement.clone()).into_val(&t.env);
    t.allow(&t.owner, "replace_policy", args);
    let new = client.replace_policy(&old, &replacement);
    // Two chained entries: the revocation, then the approval.
    let events = t.env.events().all().filter_by_contract(&t.wallet);
    assert_eq!(events.events().len(), 2);
    let head = client.audit_head();
    assert_eq!(head.sequence, before.sequence + 2);
    assert_eq!(client.policies(), vec![&t.env, new.clone()]);
    assert!(t.state(&old).revoked);
    failed(t.execute(&t.payment(&old, 5, 1)), Error::Revoked);

    // The new policy's budget starts at zero on the same day: total daily exposure is the sum.
    let state = t.state(&new);
    assert_eq!((state.next_sequence, state.daily_spend.len()), (1, 0));
    t.execute(&t.payment(&new, 1, 5)).unwrap().unwrap();
    assert_eq!(t.token(&t.asset).balance(&t.recipient), 25);
}

// --- Live identity and verification (A02, A19) -------------------------------------------------

#[test]
fn identity_changes_invalidate_policies_and_signed_requests() {
    let t = Test::new();
    let hash = t.approve(&t.policy(1));
    let signed = t.payment(&hash, 1, 3);
    let snapshot = t.snapshot(&hash);
    t.env.mock_all_auths();
    t.registry().update_metadata(
        &t.agent.agent_id,
        &t.agent.revision,
        &String::from_str(&t.env, "https://agent.example/v2.json"),
        &BytesN::from_array(&t.env, &[2; 32]),
    );
    failed(t.execute(&signed), Error::IdentityChanged);
    assert_eq!(t.snapshot(&hash), snapshot);
}

#[test]
fn disabled_identity_and_rotated_signer_fail() {
    let t = Test::new();
    let hash = t.approve(&t.policy(1));
    t.env.mock_all_auths();
    let rotated =
        t.registry()
            .rotate_signer(&t.agent.agent_id, &t.agent.revision, &account(&t.env));
    // The old signer's policy names an old revision.
    failed(t.execute(&t.payment(&hash, 1, 3)), Error::IdentityChanged);
    t.env.mock_all_auths();
    t.registry().disable(&t.agent.agent_id, &rotated.revision);
    failed(t.execute(&t.payment(&hash, 1, 3)), Error::IdentityChanged);
}

#[test]
fn verification_failures_block_execution() {
    // A newer failing result, or a flagged one, replaces the pass.
    let replaced: [fn(&mut VerificationResult); 2] = [
        |result| {
            result.checks.set(
                2,
                CheckResult {
                    kind: CheckKind::Metadata,
                    outcome: CheckOutcome::Failed,
                    score: Some(100),
                },
            );
            result.risk_score = risk_score(&result.checks);
        },
        |result| result.serious_wallet_risks = KNOWN_COMPROMISE,
    ];
    for change in replaced {
        let t = Test::new();
        let hash = t.approve(&t.policy(1));
        let mut result = t.result(2);
        change(&mut result);
        t.publish(result);
        failed(
            t.execute(&t.payment(&hash, 1, 3)),
            Error::VerificationDenied,
        );
    }

    // Revoked result, disabled provider, expiry, stale age, and an unsupported required check.
    let t = Test::new();
    let hash = t.approve(&t.policy(1));
    t.env.mock_all_auths();
    t.verification()
        .revoke(&t.agent.agent_id, &t.agent.revision, &t.provider, &1);
    failed(t.execute(&t.payment(&hash, 1, 3)), Error::Revoked);

    let t = Test::new();
    let hash = t.approve(&t.policy(1));
    t.env.mock_all_auths();
    t.verification().disable_provider(&t.provider);
    failed(t.execute(&t.payment(&hash, 1, 3)), Error::Revoked);

    let t = Test::new();
    let mut policy = t.policy(1);
    policy.valid_until = NOW + 60 * DAY;
    policy.max_assessment_age = 60 * DAY;
    let hash = t.approve(&policy);
    t.advance(30 * DAY);
    failed(t.execute(&t.payment(&hash, 1, 3)), Error::Expired);

    let t = Test::new();
    let mut policy = t.policy(1);
    policy.max_assessment_age = HOUR;
    let hash = t.approve(&policy);
    t.advance(HOUR);
    t.execute(&t.payment(&hash, 1, 3)).unwrap().unwrap();
    t.advance(1);
    failed(t.execute(&t.payment(&hash, 2, 3)), Error::Expired);

    let t = Test::new();
    let mut policy = t.policy(1);
    policy.required_checks.push_back(CheckKind::ThreatFeed);
    let hash = t.approve(&policy);
    failed(
        t.execute(&t.payment(&hash, 1, 3)),
        Error::VerificationDenied,
    );

    // A different provider's result does not count.
    let t = Test::new();
    let mut policy = t.policy(1);
    policy.provider = Address::generate(&t.env);
    let hash = t.approve(&policy);
    failed(
        t.execute(&t.payment(&hash, 1, 3)),
        Error::VerificationDenied,
    );

    // Risk above the policy's threshold.
    let t = Test::new();
    let mut risky = t.result(2);
    risky.checks.set(
        1,
        CheckResult {
            kind: CheckKind::Endpoint,
            outcome: CheckOutcome::Passed,
            score: Some(40),
        },
    );
    risky.risk_score = risk_score(&risky.checks);
    t.publish(risky);
    let hash = t.approve(&t.policy(1));
    failed(
        t.execute(&t.payment(&hash, 1, 3)),
        Error::VerificationDenied,
    );
}

// --- Rollback (A20) --------------------------------------------------------------------------------

#[test]
fn failed_token_call_rolls_back_sequence_budget_and_audit() {
    let t = Test::new();
    let token = t.env.register(FailingToken, ());
    let mut policy = t.policy(1);
    policy.assets.push_back(AssetLimit {
        asset: token.clone(),
        per_transaction: 5,
        per_day: 20,
    });
    let hash = t.approve(&policy);
    t.execute(&t.payment(&hash, 1, 2)).unwrap().unwrap();
    let snapshot = t.snapshot(&hash);
    let action = t.transfer_to(&t.recipient, &token, 3);
    // Every wallet check passes and state is advanced before the asset call fails.
    failed(
        t.execute(&t.request(&hash, 2, action)),
        Error::TransferFailed,
    );
    assert_eq!(t.snapshot(&hash), snapshot);

    // An insufficient balance in a real asset contract rolls back the same way.
    t.env.mock_all_auths();
    t.client()
        .withdraw(&t.asset, &t.stranger, &(FUNDED - 2 - 1));
    let snapshot = t.snapshot(&hash);
    // The asset's own error #10 must not pass for the wallet's `VerificationDenied`.
    failed(t.execute(&t.payment(&hash, 2, 3)), Error::TransferFailed);
    assert_eq!(t.snapshot(&hash), snapshot);
    t.execute(&t.payment(&hash, 2, 1)).unwrap().unwrap();
}

// --- Storage maintenance (A21) -----------------------------------------------------------------

#[test]
fn archived_state_restores_without_reset_or_resurrection() {
    let t = Test::new();
    let client = t.client();
    let hash = t.approve(&t.policy(1));
    let revoked = t.approve(&t.policy(2));
    t.revoke(&revoked).unwrap().unwrap();
    t.execute(&t.payment(&hash, 1, 3)).unwrap().unwrap();
    for key in [
        DataKey::Policy(hash.clone()),
        DataKey::PolicyState(hash.clone()),
        DataKey::PolicyState(revoked.clone()),
        DataKey::PolicyId(t.policy(2).policy_id),
    ] {
        let ttl = t
            .env
            .as_contract(&t.wallet, || t.env.storage().persistent().get_ttl(&key));
        assert_eq!(ttl, TTL_EXTEND_TO);
    }
    let before = (t.state(&hash), t.state(&revoked), client.audit_head());

    // Past every TTL in the same UTC day. The test host restores archived entries automatically, as
    // a transaction with a restore footprint does; restoration brings back exactly the stored values.
    let ledger = t.env.ledger().sequence();
    t.env
        .ledger()
        .set_sequence_number(ledger + TTL_EXTEND_TO + 1);
    assert_eq!(
        (t.state(&hash), t.state(&revoked), client.audit_head()),
        before
    );
    failed(t.execute(&t.payment(&hash, 1, 3)), Error::InvalidSequence);
    failed(t.execute(&t.payment(&revoked, 1, 3)), Error::Revoked);
    failed(t.try_approve(&t.policy(2)), Error::Revoked);
    t.execute(&t.payment(&hash, 2, 5)).unwrap().unwrap();
    assert_eq!(t.state(&hash).daily_spend, t.spend(8));

    // Expired permissions stay expired after restoration.
    t.env
        .ledger()
        .set_sequence_number(t.env.ledger().sequence() + TTL_EXTEND_TO + 1);
    t.advance(7 * DAY);
    failed(t.execute(&t.payment(&hash, 3, 1)), Error::Expired);
}

#[test]
fn execution_extends_every_entry_it_touches() {
    let t = Test::new();
    let hash = t.approve(&t.policy(1));
    let ledger = t.env.ledger().sequence();
    t.env.ledger().set_sequence_number(ledger + 2 * 17_280);
    t.execute(&t.payment(&hash, 1, 3)).unwrap().unwrap();
    t.env.as_contract(&t.wallet, || {
        let storage = t.env.storage();
        assert_eq!(storage.instance().get_ttl(), TTL_EXTEND_TO);
        for key in [
            DataKey::Policy(hash.clone()),
            DataKey::PolicyState(hash.clone()),
        ] {
            assert_eq!(storage.persistent().get_ttl(&key), TTL_EXTEND_TO);
        }
    });
}
