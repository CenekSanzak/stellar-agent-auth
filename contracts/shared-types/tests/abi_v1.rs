use soroban_sdk::{
    testutils::Ledger,
    vec,
    xdr::{AccountId, ContractId, Hash, PublicKey, ScAddress, Uint256},
    Address, Bytes, BytesN, Env, TryFromVal,
};
use stellar_agent_auth_shared_types::{
    action::{Action, ActionKind, ActionRequest, ServiceRule, Transfer},
    attestation::CheckKind,
    audit::{AuditEntry, AuditOutcome, ExecutedAction},
    encoding::{action_hash, audit_hash, policy_hash},
    policy::{AssetLimit, Policy, ServicePermission},
};

const GOLDEN: &str = include_str!("../../../tests/fixtures/abi-v1.sha256");

#[test]
fn v1_hashes_match_the_typescript_vectors() {
    let env = Env::default();
    let network_id = env.crypto().sha256(&Bytes::from_slice(
        &env,
        b"Standalone Network ; February 2017",
    ));
    env.ledger().set_network_id(network_id.to_array());
    let bytes = |value| BytesN::from_array(&env, &[value; 32]);
    let account = |value| {
        Address::try_from_val(
            &env,
            &ScAddress::Account(AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(
                [value; 32],
            )))),
        )
        .unwrap()
    };
    let contract = |value| {
        Address::try_from_val(&env, &ScAddress::Contract(ContractId(Hash([value; 32])))).unwrap()
    };
    let wallet = contract(11);
    let policy = Policy {
        schema_version: 1,
        policy_id: bytes(12),
        agent_id: 5,
        revision: 2,
        signer: account(13),
        provider: account(14),
        required_checks: vec![
            &env,
            CheckKind::SignerHistory,
            CheckKind::Metadata,
            CheckKind::Endpoint,
        ],
        max_assessment_age: 120,
        max_risk_score: 25,
        assets: vec![
            &env,
            AssetLimit {
                asset: contract(16),
                per_transaction: 70,
                per_day: 100,
            },
            AssetLimit {
                asset: contract(15),
                per_transaction: 9_007_199_254_740_993,
                per_day: i128::MAX,
            },
        ],
        allowed_recipients: vec![&env, contract(19), account(18), account(17)],
        blocked_recipients: vec![&env, contract(21), account(20)],
        valid_after: 1_700_000_000,
        valid_until: 1_700_000_600,
        action_kinds: vec![&env, ActionKind::Transfer, ActionKind::ServicePayment],
        service: ServicePermission::Restricted(ServiceRule {
            contract: contract(22),
            service_id: bytes(23),
        }),
    };
    let request = ActionRequest {
        schema_version: 1,
        wallet: wallet.clone(),
        policy_hash: bytes(24),
        sequence: u64::MAX,
        deadline: 1_700_000_100,
        action: Action::Transfer(Transfer {
            asset: contract(15),
            recipient: account(17),
            amount: 9_007_199_254_740_993,
        }),
    };
    let entry = AuditEntry {
        schema_version: 1,
        wallet: wallet.clone(),
        sequence: 3,
        previous_hash: bytes(25),
        ledger: 42,
        timestamp: 1_700_000_011,
        actor: policy.signer.clone(),
        outcome: AuditOutcome::Executed(ExecutedAction {
            policy_hash: request.policy_hash.clone(),
            action_hash: bytes(26),
            action: request.action.clone(),
        }),
    };

    let hashes = [
        policy_hash(&env, &wallet, &policy).unwrap(),
        action_hash(&env, &request).unwrap(),
        audit_hash(&env, &entry).unwrap(),
    ];
    let actual = hashes.map(|hash| {
        hash.to_array()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    });
    assert_eq!(GOLDEN.lines().collect::<Vec<_>>(), actual);
}
