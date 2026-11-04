use soroban_sdk::{contractclient, Address, Env};
use stellar_agent_auth_shared_types::{
    attestation::VerificationResult, errors::Error, events::AssessmentChanged,
    identity::AgentIdentity,
};

use crate::{
    provider,
    storage::{self, ResultKey},
};

/// The one agent registry entry point this contract calls.
#[contractclient(name = "AgentRegistryClient")]
pub trait AgentRegistryInterface {
    fn current(env: Env, agent_id: u64, revision: u64) -> Result<AgentIdentity, Error>;
}

/// Requires `(agent_id, revision)` to be the live, enabled identity in the bound agent registry.
/// Registry errors (`NotFound`, `IdentityChanged`, `Revoked`) pass through; any other failure or
/// an unexpected identity denies.
pub fn require_live_identity(env: &Env, agent_id: u64, revision: u64) -> Result<(), Error> {
    let registry = AgentRegistryClient::new(env, &storage::agent_registry(env));
    match registry.try_current(&agent_id, &revision) {
        Ok(Ok(identity))
            if identity.agent_id == agent_id
                && identity.revision == revision
                && !identity.disabled =>
        {
            Ok(())
        }
        Err(Ok(error)) => Err(error),
        _ => Err(Error::VerificationDenied),
    }
}

/// Validates and stores a provider-authorized result as the latest for its agent revision.
pub fn publish(env: &Env, result: VerificationResult) -> Result<VerificationResult, Error> {
    let record = provider::require_approved(env, &result.provider)?;
    if record.mode != result.mode {
        return Err(Error::InvalidInput);
    }
    result.validate_publication(env.ledger().timestamp())?;
    require_live_identity(env, result.agent_id, result.revision)?;

    let expected = match storage::result(env, &storage::result_key(&result)) {
        None => 1,
        Some(previous) => {
            if result.issued_at < previous.issued_at {
                return Err(Error::InvalidSequence);
            }
            previous
                .sequence
                .checked_add(1)
                .ok_or(Error::ArithmeticOverflow)?
        }
    };
    if result.sequence != expected {
        return Err(Error::InvalidSequence);
    }
    commit(env, result)
}

/// Marks the latest result revoked. Only the latest sequence can be revoked; earlier ones are
/// already superseded. Allowed whatever the identity or provider state.
pub fn revoke(env: &Env, key: &ResultKey, sequence: u64) -> Result<VerificationResult, Error> {
    let mut result = storage::result(env, key).ok_or(Error::NotFound)?;
    if result.sequence != sequence {
        return Err(Error::InvalidSequence);
    }
    if result.revoked {
        return Err(Error::Duplicate);
    }
    result.revoked = true;
    commit(env, result)
}

/// The latest result only while its provider is approved, its identity revision is live, and it
/// is neither revoked nor expired.
pub fn current(env: &Env, key: &ResultKey) -> Result<VerificationResult, Error> {
    provider::require_approved(env, &key.provider)?;
    require_live_identity(env, key.agent_id, key.revision)?;
    let result = storage::result(env, key).ok_or(Error::NotFound)?;
    if result.revoked {
        return Err(Error::Revoked);
    }
    if env.ledger().timestamp() >= result.expires_at {
        return Err(Error::Expired);
    }
    Ok(result)
}

pub fn key(agent_id: u64, revision: u64, provider: Address) -> ResultKey {
    ResultKey {
        agent_id,
        revision,
        provider,
    }
}

/// Stores the result and publishes `assessment_v1` with the result after the change.
fn commit(env: &Env, result: VerificationResult) -> Result<VerificationResult, Error> {
    storage::set_result(env, &result);
    AssessmentChanged {
        agent_id: result.agent_id,
        provider: result.provider.clone(),
        result: result.clone(),
    }
    .publish(env);
    Ok(result)
}
