use soroban_sdk::{
    testutils::Address as _,
    vec,
    xdr::{AccountId, PublicKey, ScAddress, Uint256},
    Address, Env, TryFromVal, Vec,
};
use stellar_agent_auth_shared_types::{
    attestation::{risk_score, validate_requirement, CheckKind, CheckOutcome, CheckResult},
    errors::Error,
    identity::{require_account, require_contract},
};

fn scored(env: &Env, scores: &[Option<u32>]) -> Vec<CheckResult> {
    let kinds = [
        CheckKind::Code,
        CheckKind::Endpoint,
        CheckKind::Media,
        CheckKind::Metadata,
    ];
    let mut checks = Vec::new(env);
    for (kind, score) in kinds.iter().zip(scores) {
        checks.push_back(CheckResult {
            kind: *kind,
            outcome: CheckOutcome::Passed,
            score: *score,
        });
    }
    checks
}

#[test]
fn risk_score_is_the_ceiling_of_the_mean_of_scored_checks() {
    let env = Env::default();
    assert_eq!(risk_score(&scored(&env, &[])), None);
    assert_eq!(risk_score(&scored(&env, &[None, None])), None);
    assert_eq!(risk_score(&scored(&env, &[Some(0), Some(0)])), Some(0));
    assert_eq!(
        risk_score(&scored(&env, &[Some(100), Some(0), Some(0)])),
        Some(34)
    );
    assert_eq!(
        risk_score(&scored(&env, &[Some(1), Some(0), Some(0)])),
        Some(1)
    );
    assert_eq!(
        risk_score(&scored(&env, &[Some(100), None, Some(0)])),
        Some(50)
    );
    assert_eq!(
        risk_score(&scored(&env, &[Some(100), Some(100), Some(100), Some(100)])),
        Some(100)
    );
}

#[test]
fn requirements_are_bounded_and_distinct() {
    let env = Env::default();
    use CheckKind::*;
    assert_eq!(validate_requirement(&vec![&env, Metadata], 1, 100), Ok(()));
    assert_eq!(
        validate_requirement(&Vec::new(&env), 1, 0),
        Err(Error::InvalidInput)
    );
    assert_eq!(
        validate_requirement(&vec![&env, Metadata, Metadata], 1, 0),
        Err(Error::Duplicate)
    );
    let nine = vec![
        &env,
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
    assert_eq!(validate_requirement(&nine, 1, 0), Err(Error::LimitExceeded));
    assert_eq!(
        validate_requirement(&vec![&env, Metadata], 0, 0),
        Err(Error::InvalidInput)
    );
    assert_eq!(
        validate_requirement(&vec![&env, Metadata], 1, 101),
        Err(Error::InvalidInput)
    );
}

#[test]
fn address_kinds_are_distinguished() {
    let env = Env::default();
    let contract = Address::generate(&env);
    let account = Address::try_from_val(
        &env,
        &ScAddress::Account(AccountId(PublicKey::PublicKeyTypeEd25519(Uint256([7; 32])))),
    )
    .unwrap();
    assert_eq!(require_account(&env, &account), Ok(()));
    assert_eq!(require_account(&env, &contract), Err(Error::InvalidInput));
    assert_eq!(require_contract(&env, &contract), Ok(()));
    assert_eq!(require_contract(&env, &account), Err(Error::InvalidInput));
}
