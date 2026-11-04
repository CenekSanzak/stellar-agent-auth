extern crate std;

use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    xdr::{AccountId, ContractId, Hash, PublicKey, ScAddress, Uint256},
    Address, BytesN, Env, Event, IntoVal, InvokeError, String, Symbol, TryFromVal, Val, Vec,
};
use stellar_agent_auth_shared_types::{
    errors::Error,
    events::IdentityChanged,
    identity::{AgentIdentity, MAX_METADATA_URI_BYTES},
};

use crate::{
    storage::{self, DataKey, DAY_IN_LEDGERS, TTL_EXTEND_TO},
    AgentRegistry, AgentRegistryClient,
};

type Outcome =
    Result<Result<AgentIdentity, soroban_sdk::ConversionError>, Result<Error, InvokeError>>;

/// Random standard account address. `mock_auths` cannot impersonate accounts, so
/// account-signer authorization is asserted through `env.auths()` instead.
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

fn link(env: &Env, bytes: &[u8]) -> String {
    String::from_bytes(env, bytes)
}

fn uri_of_len(env: &Env, len: u32) -> String {
    let mut bytes = b"https://".to_vec();
    bytes.resize(len as usize, b'a');
    link(env, &bytes)
}

fn digest(env: &Env, value: u8) -> BytesN<32> {
    BytesN::from_array(env, &[value; 32])
}

fn denied(outcome: Outcome) {
    assert_eq!(outcome, Err(Err(InvokeError::Abort)));
}

fn failed(outcome: Outcome, error: Error) {
    assert_eq!(outcome, Err(Ok(error)));
}

struct Test {
    env: Env,
    id: Address,
    /// A contract address so enforcing `mock_auths` can supply or withhold its auth.
    controller: Address,
    signer: Address,
    attacker: Address,
}

impl Test {
    fn new() -> Self {
        let env = Env::default();
        let id = env.register(AgentRegistry, ());
        Test {
            controller: Address::generate(&env),
            signer: account(&env),
            attacker: Address::generate(&env),
            id,
            env,
        }
    }

    fn client(&self) -> AgentRegistryClient<'_> {
        AgentRegistryClient::new(&self.env, &self.id)
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

    /// Enforcing mode with exactly these addresses authorizing `fn_name(args)`.
    fn allow(&self, addresses: &[&Address], fn_name: &str, args: Vec<Val>) {
        let invoke = MockAuthInvoke {
            contract: &self.id,
            fn_name,
            args,
            sub_invokes: &[],
        };
        let auths: std::vec::Vec<_> = addresses
            .iter()
            .map(|address| MockAuth {
                address,
                invoke: &invoke,
            })
            .collect();
        self.env.mock_auths(&auths);
    }

    fn register_args(&self, uri: &String, hash: &BytesN<32>) -> Vec<Val> {
        (
            self.controller.clone(),
            self.signer.clone(),
            uri.clone(),
            hash.clone(),
        )
            .into_val(&self.env)
    }

    fn try_register_with(&self, uri: &String, hash: &BytesN<32>) -> Outcome {
        self.env.mock_all_auths();
        self.client()
            .try_register(&self.controller, &self.signer, uri, hash)
    }

    /// Registers with both role auths and asserts exactly those auths were required.
    fn register(&self) -> AgentIdentity {
        let (uri, hash) = (
            link(&self.env, b"https://agent.example/v1.json"),
            digest(&self.env, 1),
        );
        let identity = self.try_register_with(&uri, &hash).unwrap().unwrap();
        let invocation = self.invocation("register", self.register_args(&uri, &hash));
        assert_eq!(
            self.env.auths(),
            std::vec![
                (self.controller.clone(), invocation.clone()),
                (self.signer.clone(), invocation)
            ]
        );
        identity
    }

    fn update(&self, agent_id: u64, revision: u64, uri: &String, hash: &BytesN<32>) -> Outcome {
        let args = (agent_id, revision, uri.clone(), hash.clone()).into_val(&self.env);
        self.allow(&[&self.controller], "update_metadata", args);
        self.client()
            .try_update_metadata(&agent_id, &revision, uri, hash)
    }

    fn rotate(&self, agent_id: u64, revision: u64, new_signer: &Address) -> Outcome {
        self.env.mock_all_auths();
        self.client()
            .try_rotate_signer(&agent_id, &revision, new_signer)
    }

    fn disable(&self, agent_id: u64, revision: u64) -> Outcome {
        self.allow(
            &[&self.controller],
            "disable",
            (agent_id, revision).into_val(&self.env),
        );
        self.client().try_disable(&agent_id, &revision)
    }

    fn reactivate(&self, agent_id: u64, revision: u64) -> Outcome {
        let args = (agent_id, revision).into_val(&self.env);
        self.allow(&[&self.controller], "reactivate", args);
        self.client().try_reactivate(&agent_id, &revision)
    }

    fn seed(&self, identity: &AgentIdentity) {
        self.env
            .as_contract(&self.id, || storage::store(&self.env, identity));
    }

    fn assert_event(&self, identity: &AgentIdentity) {
        let event = IdentityChanged {
            agent_id: identity.agent_id,
            identity: identity.clone(),
        };
        assert_eq!(self.env.events().all(), [event.to_xdr(&self.env, &self.id)]);
    }
}

#[test]
fn register_requires_controller_and_signer() {
    let t = Test::new();
    let client = t.client();
    let (uri, hash) = (
        link(&t.env, b"https://agent.example/v1.json"),
        digest(&t.env, 1),
    );
    let args = t.register_args(&uri, &hash);

    t.env.set_auths(&[]);
    denied(client.try_register(&t.controller, &t.signer, &uri, &hash));
    t.allow(&[&t.controller], "register", args.clone());
    denied(client.try_register(&t.controller, &t.signer, &uri, &hash));
    t.allow(&[&t.attacker], "register", args);
    denied(client.try_register(&t.controller, &t.signer, &uri, &hash));
    // Controller auth is bound to the exact arguments.
    let other = t.register_args(&uri, &digest(&t.env, 2));
    t.allow(&[&t.controller], "register", other);
    denied(client.try_register(&t.controller, &t.signer, &uri, &hash));
    assert_eq!(client.agent_count(), 0);

    let identity = t.register();
    assert_eq!(
        identity,
        AgentIdentity {
            agent_id: 1,
            controller: t.controller.clone(),
            signer: t.signer.clone(),
            metadata_uri: uri,
            metadata_hash: hash,
            revision: 1,
            disabled: false,
        }
    );
    t.assert_event(&identity);
    assert_eq!(client.get(&1), identity);
    assert_eq!(client.current(&1, &1), identity);
    assert_eq!(client.agent_count(), 1);
}

#[test]
fn register_allocates_sequential_ids() {
    let t = Test::new();
    let client = t.client();
    failed(client.try_get(&1), Error::NotFound);
    failed(client.try_current(&1, &1), Error::NotFound);
    assert_eq!(t.register().agent_id, 1);
    assert_eq!(t.register().agent_id, 2);
    assert_eq!(client.agent_count(), 2);
    assert_eq!(client.get(&2).agent_id, 2);
    failed(client.try_get(&0), Error::NotFound);
    failed(client.try_get(&3), Error::NotFound);
}

#[test]
fn register_rejects_invalid_roles() {
    let t = Test::new();
    let client = t.client();
    let (uri, hash) = (link(&t.env, b"https://a"), digest(&t.env, 1));
    t.env.mock_all_auths();
    failed(
        client.try_register(&t.controller, &t.controller, &uri, &hash),
        Error::InvalidInput,
    );
    let contract_signer = Address::generate(&t.env);
    failed(
        client.try_register(&t.controller, &contract_signer, &uri, &hash),
        Error::InvalidInput,
    );
    // An account controller is allowed; only the signer must be an account.
    let account_controller = account(&t.env);
    assert_eq!(
        client
            .register(&account_controller, &t.signer, &uri, &hash)
            .controller,
        account_controller
    );
}

#[test]
fn register_validates_metadata() {
    let t = Test::new();
    let env = &t.env;
    let good = digest(env, 9);
    assert!(t
        .try_register_with(&uri_of_len(env, MAX_METADATA_URI_BYTES), &good)
        .is_ok());
    failed(
        t.try_register_with(&uri_of_len(env, MAX_METADATA_URI_BYTES + 1), &good),
        Error::LimitExceeded,
    );
    for bad in [
        &b""[..],
        b"https://",
        b"http://agent.example",
        b"HTTPS://agent.example",
        b"https://agent example",
        b"https://agent.example\t",
        b"https://agent.example\x7f",
        "https://agént.example".as_bytes(),
    ] {
        failed(
            t.try_register_with(&link(env, bad), &good),
            Error::InvalidInput,
        );
    }
    failed(
        t.try_register_with(&link(env, b"https://a"), &digest(env, 0)),
        Error::InvalidInput,
    );
    assert_eq!(t.client().agent_count(), 1);
}

#[test]
fn register_rejects_counter_overflow() {
    let t = Test::new();
    t.env.as_contract(&t.id, || {
        storage::set_agent_count(&t.env, u64::MAX);
    });
    failed(
        t.try_register_with(&link(&t.env, b"https://a"), &digest(&t.env, 1)),
        Error::ArithmeticOverflow,
    );
    assert_eq!(t.client().agent_count(), u64::MAX);
}

#[test]
fn update_metadata_requires_controller_and_bumps_revision() {
    let t = Test::new();
    let client = t.client();
    let registered = t.register();
    let (new_uri, new_hash) = (
        link(&t.env, b"https://agent.example/v2.json"),
        digest(&t.env, 2),
    );
    let args: Vec<Val> = (1u64, 1u64, new_uri.clone(), new_hash.clone()).into_val(&t.env);

    t.env.set_auths(&[]);
    denied(client.try_update_metadata(&1, &1, &new_uri, &new_hash));
    t.allow(&[&t.attacker], "update_metadata", args.clone());
    denied(client.try_update_metadata(&1, &1, &new_uri, &new_hash));
    assert_eq!(client.get(&1), registered);

    t.env.mock_all_auths();
    let updated = client.update_metadata(&1, &1, &new_uri, &new_hash);
    assert_eq!(
        t.env.auths(),
        std::vec![(t.controller.clone(), t.invocation("update_metadata", args))]
    );
    t.assert_event(&updated);
    assert_eq!(
        updated,
        AgentIdentity {
            metadata_uri: new_uri.clone(),
            metadata_hash: new_hash.clone(),
            revision: 2,
            ..registered
        }
    );
    assert_eq!(client.get(&1), updated);
    failed(client.try_current(&1, &1), Error::IdentityChanged);
    assert_eq!(client.current(&1, &2), updated);

    // Changing only one of uri/hash is a real change.
    let changed = t
        .update(1, 2, &new_uri, &digest(&t.env, 3))
        .unwrap()
        .unwrap();
    assert_eq!(changed.revision, 3);
    let changed = t.update(1, 3, &link(&t.env, b"https://b"), &digest(&t.env, 3));
    assert_eq!(changed.unwrap().unwrap().revision, 4);
}

#[test]
fn update_metadata_rejects_invalid_transitions() {
    let t = Test::new();
    let current = t.register();
    let (same_uri, same_hash) = (current.metadata_uri.clone(), current.metadata_hash.clone());
    let good = digest(&t.env, 5);
    failed(t.update(2, 1, &same_uri, &good), Error::NotFound);
    failed(t.update(1, 0, &same_uri, &good), Error::IdentityChanged);
    failed(t.update(1, 2, &same_uri, &good), Error::IdentityChanged);
    failed(t.update(1, 1, &same_uri, &same_hash), Error::Duplicate);
    failed(
        t.update(1, 1, &uri_of_len(&t.env, MAX_METADATA_URI_BYTES + 1), &good),
        Error::LimitExceeded,
    );
    failed(
        t.update(1, 1, &link(&t.env, b"http://a"), &good),
        Error::InvalidInput,
    );
    failed(
        t.update(1, 1, &link(&t.env, b"https://"), &good),
        Error::InvalidInput,
    );
    failed(
        t.update(1, 1, &same_uri, &digest(&t.env, 0)),
        Error::InvalidInput,
    );
    assert_eq!(t.client().get(&1), current);
    assert!(t
        .update(1, 1, &uri_of_len(&t.env, MAX_METADATA_URI_BYTES), &good)
        .is_ok());
}

#[test]
fn rotate_signer_requires_controller_and_new_signer() {
    let t = Test::new();
    let client = t.client();
    let registered = t.register();
    let new_signer = account(&t.env);
    let args: Vec<Val> = (1u64, 1u64, new_signer.clone()).into_val(&t.env);

    t.env.set_auths(&[]);
    denied(client.try_rotate_signer(&1, &1, &new_signer));
    t.allow(&[&t.controller], "rotate_signer", args.clone());
    denied(client.try_rotate_signer(&1, &1, &new_signer));
    t.allow(&[&t.attacker], "rotate_signer", args.clone());
    denied(client.try_rotate_signer(&1, &1, &new_signer));
    assert_eq!(client.get(&1), registered);

    let rotated = t.rotate(1, 1, &new_signer).unwrap().unwrap();
    let invocation = t.invocation("rotate_signer", args);
    assert_eq!(
        t.env.auths(),
        std::vec![
            (t.controller.clone(), invocation.clone()),
            (new_signer.clone(), invocation)
        ]
    );
    t.assert_event(&rotated);
    assert_eq!(
        rotated,
        AgentIdentity {
            signer: new_signer,
            revision: 2,
            ..registered
        }
    );
    assert_eq!(client.get(&1), rotated);
    failed(client.try_current(&1, &1), Error::IdentityChanged);
}

#[test]
fn rotate_signer_rejects_invalid_transitions() {
    let t = Test::new();
    let current = t.register();
    let new_signer = account(&t.env);
    failed(t.rotate(2, 1, &new_signer), Error::NotFound);
    failed(t.rotate(1, 0, &new_signer), Error::IdentityChanged);
    failed(t.rotate(1, 2, &new_signer), Error::IdentityChanged);
    failed(t.rotate(1, 1, &t.controller), Error::InvalidInput);
    failed(t.rotate(1, 1, &t.signer), Error::Duplicate);
    failed(
        t.rotate(1, 1, &Address::generate(&t.env)),
        Error::InvalidInput,
    );
    assert_eq!(t.client().get(&1), current);
}

#[test]
fn disable_and_reactivate_require_controller_and_bump_revision() {
    let t = Test::new();
    let client = t.client();
    let registered = t.register();

    t.env.set_auths(&[]);
    denied(client.try_disable(&1, &1));
    t.allow(&[&t.attacker], "disable", (1u64, 1u64).into_val(&t.env));
    denied(client.try_disable(&1, &1));

    let disabled = t.disable(1, 1).unwrap().unwrap();
    t.assert_event(&disabled);
    assert_eq!(
        disabled,
        AgentIdentity {
            revision: 2,
            disabled: true,
            ..registered.clone()
        }
    );
    failed(client.try_current(&1, &2), Error::Revoked);
    failed(client.try_current(&1, &1), Error::IdentityChanged);
    failed(t.disable(1, 2), Error::Duplicate);
    failed(t.disable(1, 1), Error::IdentityChanged);

    t.env.set_auths(&[]);
    denied(client.try_reactivate(&1, &2));
    t.allow(&[&t.attacker], "reactivate", (1u64, 2u64).into_val(&t.env));
    denied(client.try_reactivate(&1, &2));

    let reactivated = t.reactivate(1, 2).unwrap().unwrap();
    t.assert_event(&reactivated);
    assert_eq!(
        reactivated,
        AgentIdentity {
            revision: 3,
            ..registered
        }
    );
    // The pre-disable revision does not revive.
    failed(client.try_current(&1, &1), Error::IdentityChanged);
    assert_eq!(client.current(&1, &3), reactivated);
    failed(t.reactivate(1, 3), Error::Duplicate);
    failed(t.reactivate(1, 2), Error::IdentityChanged);
    failed(t.reactivate(2, 3), Error::NotFound);
    failed(t.disable(2, 3), Error::NotFound);
}

#[test]
fn disabled_identity_supports_recovery() {
    let t = Test::new();
    let client = t.client();
    t.register();
    t.disable(1, 1).unwrap().unwrap();
    let new_signer = account(&t.env);
    let rotated = t.rotate(1, 2, &new_signer).unwrap().unwrap();
    assert_eq!((rotated.revision, rotated.disabled), (3, true));
    let updated = t
        .update(
            1,
            3,
            &link(&t.env, b"https://agent.example/v2"),
            &digest(&t.env, 2),
        )
        .unwrap()
        .unwrap();
    assert_eq!((updated.revision, updated.disabled), (4, true));
    failed(client.try_current(&1, &4), Error::Revoked);
    let reactivated = t.reactivate(1, 4).unwrap().unwrap();
    assert_eq!(reactivated.signer, new_signer);
    assert_eq!(client.current(&1, &5), reactivated);
}

#[test]
fn signer_alone_cannot_mutate() {
    let t = Test::new();
    let registered = t.register();
    // Seed a contract-address signer so enforcing mocks can offer its authorization.
    let signer = Address::generate(&t.env);
    t.seed(&AgentIdentity {
        signer: signer.clone(),
        ..registered.clone()
    });
    let client = t.client();
    let (new_uri, new_hash) = (link(&t.env, b"https://b"), digest(&t.env, 2));
    let new_signer = account(&t.env);

    t.allow(
        &[&signer],
        "update_metadata",
        (1u64, 1u64, new_uri.clone(), new_hash.clone()).into_val(&t.env),
    );
    denied(client.try_update_metadata(&1, &1, &new_uri, &new_hash));
    t.allow(
        &[&signer],
        "rotate_signer",
        (1u64, 1u64, new_signer.clone()).into_val(&t.env),
    );
    denied(client.try_rotate_signer(&1, &1, &new_signer));
    t.allow(&[&signer], "disable", (1u64, 1u64).into_val(&t.env));
    denied(client.try_disable(&1, &1));
    t.allow(&[&signer], "reactivate", (1u64, 1u64).into_val(&t.env));
    denied(client.try_reactivate(&1, &1));
    assert_eq!(client.get(&1).signer, signer);
}

#[test]
fn revision_overflow_is_rejected() {
    let t = Test::new();
    let registered = t.register();
    let max = AgentIdentity {
        revision: u64::MAX,
        ..registered
    };
    t.seed(&max);
    let max_revision = u64::MAX;
    failed(
        t.update(
            1,
            max_revision,
            &link(&t.env, b"https://b"),
            &digest(&t.env, 2),
        ),
        Error::ArithmeticOverflow,
    );
    failed(
        t.rotate(1, max_revision, &account(&t.env)),
        Error::ArithmeticOverflow,
    );
    failed(t.disable(1, max_revision), Error::ArithmeticOverflow);
    t.seed(&AgentIdentity {
        disabled: true,
        ..max.clone()
    });
    failed(t.reactivate(1, max_revision), Error::ArithmeticOverflow);
    assert_eq!(t.client().get(&1).revision, u64::MAX);
}

#[test]
fn reads_and_writes_extend_ttl() {
    let t = Test::new();
    let client = t.client();
    t.register();
    let ttls = || {
        t.env.as_contract(&t.id, || {
            (
                t.env.storage().instance().get_ttl(),
                t.env.storage().persistent().get_ttl(&DataKey::Identity(1)),
            )
        })
    };
    assert_eq!(ttls(), (TTL_EXTEND_TO, TTL_EXTEND_TO));

    // Above the 29-day threshold nothing is extended.
    t.env
        .ledger()
        .with_mut(|ledger| ledger.sequence_number += DAY_IN_LEDGERS / 2);
    client.get(&1);
    assert_eq!(
        ttls(),
        (
            TTL_EXTEND_TO - DAY_IN_LEDGERS / 2,
            TTL_EXTEND_TO - DAY_IN_LEDGERS / 2
        )
    );

    for step in 0..6 {
        t.env
            .ledger()
            .with_mut(|ledger| ledger.sequence_number += 2 * DAY_IN_LEDGERS);
        let _ = match step {
            0 => client.get(&1),
            1 => client.current(&1, &1),
            2 => t.disable(1, 1).unwrap().unwrap(),
            3 => t.reactivate(1, 2).unwrap().unwrap(),
            4 => t
                .update(1, 3, &link(&t.env, b"https://b"), &digest(&t.env, 2))
                .unwrap()
                .unwrap(),
            _ => t.rotate(1, 4, &account(&t.env)).unwrap().unwrap(),
        };
        assert_eq!(ttls(), (TTL_EXTEND_TO, TTL_EXTEND_TO), "step {step}");
    }

    t.env
        .ledger()
        .with_mut(|ledger| ledger.sequence_number += 2 * DAY_IN_LEDGERS);
    client.agent_count();
    assert_eq!(
        t.env
            .as_contract(&t.id, || t.env.storage().instance().get_ttl()),
        TTL_EXTEND_TO
    );
}
