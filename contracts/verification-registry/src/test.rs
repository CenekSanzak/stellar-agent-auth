extern crate std;

use soroban_sdk::{
    contract, contractimpl,
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    vec,
    xdr::{AccountId, ContractId, Hash, PublicKey, ScAddress, Uint256},
    Address, BytesN, Env, Event, IntoVal, InvokeError, String, Symbol, TryFromVal, Val, Vec,
};
use stellar_agent_auth_agent_registry::{AgentRegistry, AgentRegistryClient};
use stellar_agent_auth_shared_types::{
    attestation::{
        risk_score, AssessmentMode, CheckKind, CheckOutcome, CheckResult, ProviderRecord,
        VerificationResult, KNOWN_COMPROMISE, MAX_CHECKS, THREAT_FEED_MATCH,
    },
    errors::Error,
    events::{AssessmentChanged, ProviderChanged},
    identity::AgentIdentity,
};

use crate::{
    storage::{self, DataKey, ResultKey, DAY_IN_LEDGERS, TTL_EXTEND_TO},
    VerificationRegistry, VerificationRegistryClient,
};

type Outcome<T> = Result<Result<T, soroban_sdk::ConversionError>, Result<Error, InvokeError>>;

const NOW: u64 = 1_800_000_000;
const HOUR: u64 = 3_600;

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

fn denied<T: core::fmt::Debug + PartialEq>(outcome: Outcome<T>) {
    assert_eq!(outcome, Err(Err(InvokeError::Abort)));
}

#[track_caller]
fn failed<T: core::fmt::Debug + PartialEq>(outcome: Outcome<T>, error: Error) {
    assert_eq!(outcome, Err(Ok(error)));
}

fn check(kind: CheckKind, outcome: CheckOutcome, score: Option<u32>) -> CheckResult {
    CheckResult {
        kind,
        outcome,
        score,
    }
}

/// The limited live verifier's coverage: three scored passes, unscored history, the rest unsupported.
fn limited_checks(env: &Env) -> Vec<CheckResult> {
    use CheckKind::*;
    use CheckOutcome::*;
    vec![
        env,
        check(Code, Unsupported, None),
        check(Endpoint, Passed, Some(0)),
        check(Media, Unsupported, None),
        check(Metadata, Passed, Some(0)),
        check(SignerAccount, Passed, Some(0)),
        check(SignerHistory, Inconclusive, None),
        check(ThreatFeed, Unsupported, None),
        check(Token, Unsupported, None),
    ]
}

struct Test {
    env: Env,
    id: Address,
    registry: Address,
    admin: Address,
    controller: Address,
    provider: Address,
    fixture_provider: Address,
    attacker: Address,
    agent: AgentIdentity,
}

impl Test {
    /// A registered agent, a live provider and a fixture provider, at ledger time `NOW`.
    fn new() -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(NOW);
        let registry = env.register(AgentRegistry, ());
        let admin = Address::generate(&env);
        env.mock_all_auths();
        let id = env.register(VerificationRegistry, (admin.clone(), registry.clone()));
        let controller = Address::generate(&env);
        let agent = AgentRegistryClient::new(&env, &registry).register(
            &controller,
            &account(&env),
            &String::from_str(&env, "https://agent.example/v1.json"),
            &BytesN::from_array(&env, &[1; 32]),
        );
        let t = Test {
            provider: Address::generate(&env),
            fixture_provider: Address::generate(&env),
            attacker: Address::generate(&env),
            id,
            registry,
            admin,
            controller,
            agent,
            env,
        };
        let client = t.client();
        client.approve_provider(&t.provider, &AssessmentMode::Live);
        client.approve_provider(&t.fixture_provider, &AssessmentMode::Fixture);
        t
    }

    fn client(&self) -> VerificationRegistryClient<'_> {
        VerificationRegistryClient::new(&self.env, &self.id)
    }

    fn agents(&self) -> AgentRegistryClient<'_> {
        AgentRegistryClient::new(&self.env, &self.registry)
    }

    fn invocation(&self, fn_name: &str, args: Vec<Val>) -> AuthorizedInvocation {
        AuthorizedInvocation {
            function: AuthorizedFunction::Contract((
                self.id.clone(),
                Symbol::new(&self.env, fn_name),
                args,
            )),
            sub_invocations: std::vec![],
        }
    }

    /// Enforcing mode with only `address` authorizing `fn_name(args)`.
    fn allow(&self, address: &Address, fn_name: &str, args: Vec<Val>) {
        let invoke = MockAuthInvoke {
            contract: &self.id,
            fn_name,
            args,
            sub_invokes: &[],
        };
        self.env.mock_auths(&[MockAuth {
            address,
            invoke: &invoke,
        }]);
    }

    /// A passing live result for the current agent revision.
    fn result(&self, sequence: u64) -> VerificationResult {
        let checks = limited_checks(&self.env);
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
            evidence_hash: BytesN::from_array(&self.env, &[9; 32]),
            issued_at: self.env.ledger().timestamp(),
            expires_at: self.env.ledger().timestamp() + HOUR,
            revoked: false,
        }
    }

    /// Publishes with exactly the provider's authorization of `publish(result)`.
    fn publish_as(
        &self,
        signer: &Address,
        result: &VerificationResult,
    ) -> Outcome<VerificationResult> {
        self.allow(signer, "publish", (result.clone(),).into_val(&self.env));
        self.client().try_publish(result)
    }

    fn publish(&self, result: &VerificationResult) -> Outcome<VerificationResult> {
        self.publish_as(&result.provider, result)
    }

    fn revoke_as(
        &self,
        signer: &Address,
        provider: &Address,
        sequence: u64,
    ) -> Outcome<VerificationResult> {
        let (agent_id, revision) = (self.agent.agent_id, self.agent.revision);
        let args = (agent_id, revision, provider.clone(), sequence).into_val(&self.env);
        self.allow(signer, "revoke", args);
        self.client()
            .try_revoke(&agent_id, &revision, provider, &sequence)
    }

    fn current(&self) -> Outcome<VerificationResult> {
        self.client()
            .try_current(&self.agent.agent_id, &self.agent.revision, &self.provider)
    }

    fn latest(&self) -> Outcome<VerificationResult> {
        self.client()
            .try_latest(&self.agent.agent_id, &self.agent.revision, &self.provider)
    }

    fn check(
        &self,
        required: &[CheckKind],
        max_age: u64,
        max_risk: u32,
    ) -> Outcome<VerificationResult> {
        let required = Vec::from_slice(&self.env, required);
        self.client().try_check(
            &self.agent.agent_id,
            &self.agent.revision,
            &self.provider,
            &required,
            &max_age,
            &max_risk,
        )
    }

    /// Updates the agent's metadata through its controller, moving it to the next revision.
    fn update_agent(&self) -> AgentIdentity {
        self.env.mock_all_auths();
        self.agents().update_metadata(
            &self.agent.agent_id,
            &self.agent.revision,
            &String::from_str(&self.env, "https://agent.example/v2.json"),
            &BytesN::from_array(&self.env, &[2; 32]),
        )
    }

    fn advance(&self, seconds: u64) {
        let now = self.env.ledger().timestamp();
        self.env.ledger().set_timestamp(now + seconds);
    }

    fn assert_assessment_event(&self, result: &VerificationResult) {
        let event = AssessmentChanged {
            agent_id: result.agent_id,
            provider: result.provider.clone(),
            result: result.clone(),
        };
        assert_eq!(self.env.events().all(), [event.to_xdr(&self.env, &self.id)]);
    }
}

#[test]
fn constructor_binds_admin_and_agent_registry() {
    let t = Test::new();
    assert_eq!(t.client().admin(), t.admin);
    assert_eq!(t.client().agent_registry(), t.registry);
    let ttl = t
        .env
        .as_contract(&t.id, || t.env.storage().instance().get_ttl());
    assert_eq!(ttl, TTL_EXTEND_TO);
}

/// `env.register` does not enforce constructor authorization, so this asserts the exact recorded requirement;
/// the local-network suite shows that a deployment without the admin's signature fails.
#[test]
fn constructor_records_the_admin_authorization() {
    let env = Env::default();
    let registry = env.register(AgentRegistry, ());
    let admin = Address::generate(&env);
    env.mock_all_auths();
    let id = env.register(VerificationRegistry, (admin.clone(), registry.clone()));
    let [(address, invocation)] = env.auths().try_into().unwrap();
    assert_eq!(address, admin);
    let AuthorizedFunction::Contract((contract, name, args)) = invocation.function else {
        panic!("expected a contract invocation")
    };
    assert_eq!(
        (contract, name, args),
        (
            id,
            Symbol::new(&env, "__constructor"),
            (admin, registry).into_val(&env)
        )
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn constructor_rejects_an_account_as_agent_registry() {
    let env = Env::default();
    env.mock_all_auths();
    env.register(
        VerificationRegistry,
        (Address::generate(&env), account(&env)),
    );
}

#[test]
fn provider_approval_is_admin_only_and_mode_bound() {
    let t = Test::new();
    let client = t.client();
    let candidate = Address::generate(&t.env);
    let args: Vec<Val> = (candidate.clone(), AssessmentMode::Live).into_val(&t.env);
    for signer in [&t.attacker, &candidate, &t.provider] {
        t.allow(signer, "approve_provider", args.clone());
        denied(client.try_approve_provider(&candidate, &AssessmentMode::Live));
    }
    failed(client.try_provider(&candidate), Error::NotFound);

    t.allow(&t.admin, "approve_provider", args.clone());
    let record = client.approve_provider(&candidate, &AssessmentMode::Live);
    assert_eq!(
        record,
        ProviderRecord {
            mode: AssessmentMode::Live,
            approved: true
        }
    );
    assert_eq!(
        t.env.auths(),
        std::vec![(t.admin.clone(), t.invocation("approve_provider", args))]
    );
    let event = ProviderChanged {
        provider: candidate.clone(),
        record,
    };
    assert_eq!(t.env.events().all(), [event.to_xdr(&t.env, &t.id)]);
    assert_eq!(client.provider(&candidate), record);

    t.env.mock_all_auths();
    // Neither a repeated approval nor a mode change is possible for an approved address.
    for mode in [AssessmentMode::Live, AssessmentMode::Fixture] {
        failed(
            client.try_approve_provider(&candidate, &mode),
            Error::Duplicate,
        );
    }
}

#[test]
fn provider_disabling_is_admin_only_and_terminal() {
    let t = Test::new();
    let client = t.client();
    let args: Vec<Val> = (t.provider.clone(),).into_val(&t.env);
    for signer in [&t.attacker, &t.provider] {
        t.allow(signer, "disable_provider", args.clone());
        denied(client.try_disable_provider(&t.provider));
    }
    t.allow(&t.admin, "disable_provider", args);
    let record = client.disable_provider(&t.provider);
    assert_eq!(
        record,
        ProviderRecord {
            mode: AssessmentMode::Live,
            approved: false
        }
    );
    let event = ProviderChanged {
        provider: t.provider.clone(),
        record,
    };
    assert_eq!(t.env.events().all(), [event.to_xdr(&t.env, &t.id)]);

    t.env.mock_all_auths();
    failed(client.try_disable_provider(&t.provider), Error::Duplicate);
    failed(
        client.try_approve_provider(&t.provider, &AssessmentMode::Live),
        Error::Revoked,
    );
    failed(
        client.try_disable_provider(&Address::generate(&t.env)),
        Error::NotFound,
    );
}

#[test]
fn publish_requires_the_named_provider() {
    let t = Test::new();
    let result = t.result(1);
    for signer in [&t.attacker, &t.admin, &t.controller, &t.fixture_provider] {
        denied(t.publish_as(signer, &result));
    }
    failed(t.latest(), Error::NotFound);

    t.env.mock_all_auths();
    let published = t.client().publish(&result);
    assert_eq!(published, result);
    assert_eq!(
        t.env.auths(),
        std::vec![(
            t.provider.clone(),
            t.invocation("publish", (result.clone(),).into_val(&t.env))
        )]
    );
    t.assert_assessment_event(&result);
    assert_eq!(t.latest(), Ok(Ok(result.clone())));
    assert_eq!(t.current(), Ok(Ok(result)));
}

#[test]
fn publish_requires_an_approved_provider_of_the_same_mode() {
    let t = Test::new();
    let stranger = Address::generate(&t.env);
    failed(
        t.publish(&VerificationResult {
            provider: stranger,
            ..t.result(1)
        }),
        Error::VerificationDenied,
    );
    // A live provider cannot publish fixture data, and a fixture provider cannot publish live data.
    failed(
        t.publish(&VerificationResult {
            mode: AssessmentMode::Fixture,
            ..t.result(1)
        }),
        Error::InvalidInput,
    );
    failed(
        t.publish(&VerificationResult {
            provider: t.fixture_provider.clone(),
            ..t.result(1)
        }),
        Error::InvalidInput,
    );
    let fixture = VerificationResult {
        provider: t.fixture_provider.clone(),
        mode: AssessmentMode::Fixture,
        ..t.result(1)
    };
    assert_eq!(t.publish(&fixture), Ok(Ok(fixture)));

    t.env.mock_all_auths();
    t.client().disable_provider(&t.provider);
    failed(t.publish(&t.result(1)), Error::Revoked);
}

#[test]
fn publish_validates_the_result() {
    use CheckKind::*;
    use CheckOutcome::*;
    let t = Test::new();
    let env = &t.env;
    let base = t.result(1);
    let with_checks = |checks: Vec<CheckResult>| VerificationResult {
        risk_score: risk_score(&checks),
        checks,
        ..base.clone()
    };
    let mut nine = limited_checks(env);
    nine.push_back(check(Code, Unsupported, None));
    let cases: std::vec::Vec<(&str, VerificationResult, Error)> = std::vec![
        (
            "schema version 2",
            VerificationResult {
                schema_version: 2,
                ..base.clone()
            },
            Error::UnsupportedVersion
        ),
        ("nine checks", with_checks(nine), Error::LimitExceeded),
        (
            "duplicate kind",
            with_checks(vec![
                env,
                check(Metadata, Passed, Some(0)),
                check(Metadata, Passed, Some(0))
            ]),
            Error::Duplicate,
        ),
        (
            "check score 101",
            with_checks(vec![env, check(Metadata, Failed, Some(101))]),
            Error::InvalidInput
        ),
        (
            "risk score 101",
            VerificationResult {
                risk_score: Some(101),
                ..base.clone()
            },
            Error::InvalidInput
        ),
        (
            "unknown risk flag",
            VerificationResult {
                serious_wallet_risks: 1 << 3,
                ..base.clone()
            },
            Error::InvalidInput
        ),
        ("no checks", with_checks(Vec::new(env)), Error::InvalidInput),
        (
            "descending kinds",
            with_checks(vec![
                env,
                check(Metadata, Passed, Some(0)),
                check(Endpoint, Passed, Some(0))
            ]),
            Error::InvalidInput,
        ),
        (
            "scored unsupported",
            with_checks(vec![env, check(Token, Unsupported, Some(0))]),
            Error::InvalidInput
        ),
        (
            "scored inconclusive",
            with_checks(vec![env, check(Token, Inconclusive, Some(50))]),
            Error::InvalidInput
        ),
        (
            "scored not applicable",
            with_checks(vec![env, check(Token, NotApplicable, Some(0))]),
            Error::InvalidInput
        ),
        (
            "aggregate too low",
            VerificationResult {
                risk_score: Some(0),
                ..with_checks(vec![env, check(Metadata, Failed, Some(1))])
            },
            Error::InvalidInput
        ),
        (
            "aggregate missing",
            VerificationResult {
                risk_score: None,
                ..base.clone()
            },
            Error::InvalidInput
        ),
        (
            "aggregate without scores",
            VerificationResult {
                risk_score: Some(0),
                ..with_checks(vec![env, check(Token, Unsupported, None)])
            },
            Error::InvalidInput,
        ),
        (
            "published revoked",
            VerificationResult {
                revoked: true,
                ..base.clone()
            },
            Error::InvalidInput
        ),
        (
            "issued in the future",
            VerificationResult {
                issued_at: NOW + 1,
                ..base.clone()
            },
            Error::InvalidInput
        ),
        (
            "expires at issue",
            VerificationResult {
                issued_at: NOW - 10,
                expires_at: NOW - 10,
                ..base.clone()
            },
            Error::InvalidInput
        ),
        (
            "expires before issue",
            VerificationResult {
                expires_at: NOW - 1,
                ..base.clone()
            },
            Error::InvalidInput
        ),
        (
            "expires now",
            VerificationResult {
                issued_at: NOW - 10,
                expires_at: NOW,
                ..base.clone()
            },
            Error::Expired
        ),
    ];
    for (label, result, error) in cases {
        assert_eq!(t.publish(&result), Err(Ok(error)), "{label}");
    }
    failed(t.latest(), Error::NotFound);

    // Boundaries that pass: one second of validity and a mixed aggregate rounded up.
    let edge = VerificationResult {
        expires_at: NOW + 1,
        ..with_checks(vec![
            env,
            check(Endpoint, Failed, Some(100)),
            check(Metadata, Passed, Some(0)),
            check(SignerAccount, Passed, Some(0)),
        ])
    };
    assert_eq!(edge.risk_score, Some(34));
    assert_eq!(t.publish(&edge), Ok(Ok(edge)));
}

#[test]
fn publish_requires_the_live_identity_revision() {
    let t = Test::new();
    failed(
        t.publish(&VerificationResult {
            agent_id: 99,
            ..t.result(1)
        }),
        Error::NotFound,
    );
    for revision in [0, 2] {
        failed(
            t.publish(&VerificationResult {
                revision,
                ..t.result(1)
            }),
            Error::IdentityChanged,
        );
    }
    t.env.mock_all_auths();
    let disabled = t.agents().disable(&t.agent.agent_id, &t.agent.revision);
    failed(t.publish(&t.result(1)), Error::IdentityChanged);
    failed(
        t.publish(&VerificationResult {
            revision: disabled.revision,
            ..t.result(1)
        }),
        Error::Revoked,
    );
}

#[test]
fn identity_change_retires_results_for_the_old_revision() {
    let t = Test::new();
    let old = t.result(1);
    t.publish(&old).unwrap().unwrap();
    assert_eq!(
        t.check(&[CheckKind::Metadata], HOUR, 0),
        Ok(Ok(old.clone()))
    );

    let updated = t.update_agent();
    failed(t.current(), Error::IdentityChanged);
    failed(
        t.check(&[CheckKind::Metadata], HOUR, 0),
        Error::IdentityChanged,
    );
    // The old result stays readable for history but cannot be extended.
    assert_eq!(t.latest(), Ok(Ok(old.clone())));
    failed(t.publish(&t.result(2)), Error::IdentityChanged);

    // The new revision starts its own sequence and needs a fresh assessment.
    let client = t.client();
    failed(
        client.try_current(&t.agent.agent_id, &updated.revision, &t.provider),
        Error::NotFound,
    );
    let fresh = VerificationResult {
        revision: updated.revision,
        ..t.result(1)
    };
    assert_eq!(t.publish(&fresh), Ok(Ok(fresh.clone())));
    assert_eq!(
        client.try_current(&t.agent.agent_id, &updated.revision, &t.provider),
        Ok(Ok(fresh))
    );

    // Disabling and reactivating also moves past every earlier revision.
    t.env.mock_all_auths();
    let disabled = t.agents().disable(&t.agent.agent_id, &updated.revision);
    failed(
        client.try_current(&t.agent.agent_id, &updated.revision, &t.provider),
        Error::IdentityChanged,
    );
    failed(
        client.try_current(&t.agent.agent_id, &disabled.revision, &t.provider),
        Error::Revoked,
    );
    let active = t.agents().reactivate(&t.agent.agent_id, &disabled.revision);
    failed(
        client.try_current(&t.agent.agent_id, &active.revision, &t.provider),
        Error::NotFound,
    );
}

#[test]
fn publish_requires_the_next_sequence_and_ordered_issue_times() {
    let t = Test::new();
    for sequence in [0, 2] {
        failed(t.publish(&t.result(sequence)), Error::InvalidSequence);
    }
    let first = t.result(1);
    t.publish(&first).unwrap().unwrap();
    failed(t.publish(&first), Error::InvalidSequence);
    failed(t.publish(&t.result(1)), Error::InvalidSequence);
    failed(t.publish(&t.result(3)), Error::InvalidSequence);

    t.advance(60);
    let backwards = VerificationResult {
        issued_at: NOW - 1,
        ..t.result(2)
    };
    failed(t.publish(&backwards), Error::InvalidSequence);
    // An equal issue time is not a reordering.
    let same_second = VerificationResult {
        issued_at: NOW,
        ..t.result(2)
    };
    assert_eq!(t.publish(&same_second), Ok(Ok(same_second)));

    // Sequences are independent per provider.
    let fixture = VerificationResult {
        provider: t.fixture_provider.clone(),
        mode: AssessmentMode::Fixture,
        ..t.result(1)
    };
    assert_eq!(t.publish(&fixture), Ok(Ok(fixture)));
}

#[test]
fn sequence_overflow_is_rejected() {
    let t = Test::new();
    let last = t.result(u64::MAX);
    t.env
        .as_contract(&t.id, || storage::set_result(&t.env, &last));
    failed(t.publish(&t.result(0)), Error::ArithmeticOverflow);
}

#[test]
fn newer_failure_replaces_an_older_pass() {
    use CheckKind::*;
    let t = Test::new();
    t.publish(&t.result(1)).unwrap().unwrap();
    assert!(t.check(&[Metadata], HOUR, 0).is_ok());

    t.advance(1);
    let mut checks = limited_checks(&t.env);
    checks.set(3, check(Metadata, CheckOutcome::Failed, Some(100)));
    let failure = VerificationResult {
        risk_score: risk_score(&checks),
        checks,
        ..t.result(2)
    };
    t.publish(&failure).unwrap().unwrap();
    assert_eq!(t.current(), Ok(Ok(failure.clone())));
    failed(t.check(&[Metadata], HOUR, 100), Error::VerificationDenied);
    // The earlier pass is gone: no read returns it and it cannot be republished.
    assert_eq!(t.latest(), Ok(Ok(failure)));
    failed(t.publish(&t.result(1)), Error::InvalidSequence);
}

#[test]
fn revocation_is_provider_only_terminal_and_latest_only() {
    let t = Test::new();
    failed(t.revoke_as(&t.provider, &t.provider, 1), Error::NotFound);
    let first = t.result(1);
    t.publish(&first).unwrap().unwrap();
    t.advance(1);
    let second = t.result(2);
    t.publish(&second).unwrap().unwrap();

    for signer in [&t.attacker, &t.admin, &t.controller, &t.fixture_provider] {
        denied(t.revoke_as(signer, &t.provider, 2));
    }
    failed(
        t.revoke_as(&t.provider, &t.provider, 1),
        Error::InvalidSequence,
    );
    failed(
        t.revoke_as(&t.provider, &t.provider, 3),
        Error::InvalidSequence,
    );

    let revoked = t.revoke_as(&t.provider, &t.provider, 2).unwrap().unwrap();
    assert_eq!(
        revoked,
        VerificationResult {
            revoked: true,
            ..second
        }
    );
    t.assert_assessment_event(&revoked);
    assert_eq!(t.latest(), Ok(Ok(revoked)));
    failed(t.current(), Error::Revoked);
    failed(t.check(&[CheckKind::Metadata], HOUR, 100), Error::Revoked);
    failed(t.revoke_as(&t.provider, &t.provider, 2), Error::Duplicate);

    // Only a fresh, higher-sequence assessment supersedes a revocation.
    failed(t.publish(&first), Error::InvalidSequence);
    t.advance(1);
    let third = t.result(3);
    assert_eq!(t.publish(&third), Ok(Ok(third.clone())));
    assert_eq!(t.current(), Ok(Ok(third)));
}

#[test]
fn revocation_works_after_provider_or_identity_changes() {
    let t = Test::new();
    t.publish(&t.result(1)).unwrap().unwrap();
    t.env.mock_all_auths();
    t.client().disable_provider(&t.provider);
    failed(t.current(), Error::Revoked);
    assert!(t.revoke_as(&t.provider, &t.provider, 1).is_ok());

    t.env.mock_all_auths();
    let fixture = VerificationResult {
        provider: t.fixture_provider.clone(),
        mode: AssessmentMode::Fixture,
        ..t.result(1)
    };
    t.publish(&fixture).unwrap().unwrap();
    t.update_agent();
    assert!(t
        .revoke_as(&t.fixture_provider, &t.fixture_provider, 1)
        .is_ok());
}

#[test]
fn disabling_a_provider_blocks_its_unexpired_results() {
    let t = Test::new();
    t.publish(&t.result(1)).unwrap().unwrap();
    assert!(t.current().is_ok());
    t.env.mock_all_auths();
    t.client().disable_provider(&t.provider);
    failed(t.current(), Error::Revoked);
    failed(t.check(&[CheckKind::Metadata], HOUR, 100), Error::Revoked);
    // Still readable for history.
    assert!(t.latest().is_ok());
    let stranger = Address::generate(&t.env);
    failed(
        t.client()
            .try_current(&t.agent.agent_id, &t.agent.revision, &stranger),
        Error::VerificationDenied,
    );
}

#[test]
fn results_expire_at_expires_at() {
    let t = Test::new();
    let result = t.result(1);
    t.publish(&result).unwrap().unwrap();
    t.env.ledger().set_timestamp(result.expires_at - 1);
    assert!(t.current().is_ok());
    assert!(t.check(&[CheckKind::Metadata], HOUR, 0).is_ok());
    t.env.ledger().set_timestamp(result.expires_at);
    failed(t.current(), Error::Expired);
    failed(
        t.check(&[CheckKind::Metadata], 2 * HOUR, 100),
        Error::Expired,
    );
}

#[test]
fn check_enforces_maximum_age() {
    let t = Test::new();
    t.publish(&t.result(1)).unwrap().unwrap();
    t.advance(600);
    assert!(t.check(&[CheckKind::Metadata], 600, 0).is_ok());
    failed(t.check(&[CheckKind::Metadata], 599, 0), Error::Expired);
}

#[test]
fn check_requires_every_required_check_to_pass() {
    use CheckKind::*;
    let t = Test::new();
    let mut checks = limited_checks(&t.env);
    checks.set(1, check(Endpoint, CheckOutcome::Failed, Some(100)));
    checks.set(2, check(Media, CheckOutcome::NotApplicable, None));
    let result = VerificationResult {
        risk_score: risk_score(&checks),
        checks,
        ..t.result(1)
    };
    t.publish(&result).unwrap().unwrap();
    assert!(t.check(&[Metadata, SignerAccount], HOUR, 100).is_ok());
    for (label, kind) in [
        ("failed", Endpoint),
        ("not applicable", Media),
        ("inconclusive", SignerHistory),
        ("unsupported", ThreatFeed),
    ] {
        assert_eq!(
            t.check(&[Metadata, kind], HOUR, 100),
            Err(Ok(Error::VerificationDenied)),
            "{label}"
        );
    }

    let partial = VerificationResult {
        checks: vec![&t.env, check(Metadata, CheckOutcome::Passed, Some(0))],
        risk_score: Some(0),
        ..t.result(2)
    };
    t.publish(&partial).unwrap().unwrap();
    assert!(t.check(&[Metadata], HOUR, 0).is_ok());
    failed(t.check(&[Endpoint], HOUR, 100), Error::VerificationDenied);
}

#[test]
fn check_applies_the_risk_threshold_and_serious_flags() {
    use CheckKind::*;
    use CheckOutcome::*;
    let t = Test::new();
    let checks = vec![
        &t.env,
        check(Endpoint, Failed, Some(100)),
        check(Metadata, Passed, Some(0)),
        check(SignerAccount, Passed, Some(0)),
    ];
    let scored = VerificationResult {
        risk_score: risk_score(&checks),
        checks,
        ..t.result(1)
    };
    t.publish(&scored).unwrap().unwrap();
    assert!(t.check(&[Metadata], HOUR, 34).is_ok());
    failed(t.check(&[Metadata], HOUR, 33), Error::VerificationDenied);

    t.advance(1);
    let flagged = VerificationResult {
        serious_wallet_risks: KNOWN_COMPROMISE | THREAT_FEED_MATCH,
        ..t.result(2)
    };
    t.publish(&flagged).unwrap().unwrap();
    assert_eq!(flagged.risk_score, Some(0));
    failed(t.check(&[Metadata], HOUR, 100), Error::VerificationDenied);

    // Without any scored check there is no usable aggregate.
    t.advance(1);
    let unscored = VerificationResult {
        checks: vec![&t.env, check(Metadata, Passed, None)],
        risk_score: None,
        ..t.result(3)
    };
    t.publish(&unscored).unwrap().unwrap();
    failed(t.check(&[Metadata], HOUR, 100), Error::VerificationDenied);
}

#[test]
fn check_validates_the_requirement_first() {
    use CheckKind::*;
    let t = Test::new();
    let all = [
        Code,
        Endpoint,
        Media,
        Metadata,
        SignerAccount,
        SignerHistory,
        ThreatFeed,
        Token,
        Code,
    ];
    assert_eq!(all.len() as u32, MAX_CHECKS + 1);
    // No result exists, so each of these fails on the requirement alone.
    failed(t.check(&[], HOUR, 0), Error::InvalidInput);
    failed(t.check(&[Metadata, Metadata], HOUR, 0), Error::Duplicate);
    failed(t.check(&all, HOUR, 0), Error::LimitExceeded);
    failed(t.check(&[Metadata], 0, 0), Error::InvalidInput);
    failed(t.check(&[Metadata], HOUR, 101), Error::InvalidInput);
    failed(t.check(&[Metadata], HOUR, 100), Error::NotFound);
}

/// Answers `current` with an identity for a different revision.
#[contract]
struct WrongRegistry;

#[contractimpl]
impl WrongRegistry {
    pub fn current(env: Env, agent_id: u64, revision: u64) -> AgentIdentity {
        AgentIdentity {
            agent_id,
            controller: Address::generate(&env),
            signer: Address::generate(&env),
            metadata_uri: String::from_str(&env, "https://agent.example"),
            metadata_hash: BytesN::from_array(&env, &[1; 32]),
            revision: revision + 1,
            disabled: false,
        }
    }
}

#[test]
fn unexpected_agent_registry_answers_deny() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);
    let admin = Address::generate(&env);
    let provider = Address::generate(&env);
    for registry in [
        env.register(WrongRegistry, ()),
        // A contract without `current` at all.
        env.register(
            VerificationRegistry,
            (admin.clone(), env.register(AgentRegistry, ())),
        ),
    ] {
        let id = env.register(VerificationRegistry, (admin.clone(), registry));
        let client = VerificationRegistryClient::new(&env, &id);
        client.approve_provider(&provider, &AssessmentMode::Live);
        let checks = limited_checks(&env);
        let result = VerificationResult {
            schema_version: 1,
            agent_id: 1,
            revision: 1,
            provider: provider.clone(),
            sequence: 1,
            mode: AssessmentMode::Live,
            risk_score: risk_score(&checks),
            checks,
            serious_wallet_risks: 0,
            evidence_hash: BytesN::from_array(&env, &[9; 32]),
            issued_at: NOW,
            expires_at: NOW + HOUR,
            revoked: false,
        };
        failed(client.try_publish(&result), Error::VerificationDenied);
    }
}

#[test]
fn reads_and_writes_extend_ttl() {
    let t = Test::new();
    let result = t.result(1);
    t.publish(&result).unwrap().unwrap();
    let ttl = |key: &DataKey| {
        t.env
            .as_contract(&t.id, || t.env.storage().persistent().get_ttl(key))
    };
    let result_key = DataKey::Result(ResultKey {
        agent_id: result.agent_id,
        revision: result.revision,
        provider: t.provider.clone(),
    });
    let provider_key = DataKey::Provider(t.provider.clone());
    assert_eq!(ttl(&result_key), TTL_EXTEND_TO);
    assert_eq!(ttl(&provider_key), TTL_EXTEND_TO);

    // After two days every entry is below the threshold; each read extends what it touches.
    let ledger = t.env.ledger().sequence();
    t.env
        .ledger()
        .set_sequence_number(ledger + 2 * DAY_IN_LEDGERS);
    assert!(t.current().is_ok());
    assert_eq!(ttl(&result_key), TTL_EXTEND_TO);
    assert_eq!(ttl(&provider_key), TTL_EXTEND_TO);
    let instance = t
        .env
        .as_contract(&t.id, || t.env.storage().instance().get_ttl());
    assert_eq!(instance, TTL_EXTEND_TO);
}
