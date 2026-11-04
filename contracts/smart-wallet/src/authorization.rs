use soroban_sdk::{contractclient, Address, Env, Vec};
use stellar_agent_auth_shared_types::{
    attestation::{CheckKind, VerificationResult},
    errors::Error,
    identity::AgentIdentity,
    policy::Policy,
};

use crate::storage;

/// The one agent registry entry point this wallet calls.
#[contractclient(name = "AgentRegistryClient")]
pub trait AgentRegistryInterface {
    fn current(env: Env, agent_id: u64, revision: u64) -> Result<AgentIdentity, Error>;
}

/// The verification registry entry points this wallet calls.
#[contractclient(name = "VerificationRegistryClient")]
pub trait VerificationRegistryInterface {
    fn agent_registry(env: Env) -> Address;
    #[allow(clippy::too_many_arguments)]
    fn check(
        env: Env,
        agent_id: u64,
        revision: u64,
        provider: Address,
        required_checks: Vec<CheckKind>,
        max_age: u64,
        max_risk_score: u32,
    ) -> Result<VerificationResult, Error>;
}

/// The agent registry the verification registry consults, for the constructor's consistency check.
pub fn bound_agent_registry(env: &Env, verification_registry: &Address) -> Option<Address> {
    match VerificationRegistryClient::new(env, verification_registry).try_agent_registry() {
        Ok(Ok(registry)) => Some(registry),
        _ => None,
    }
}

/// Requires the policy's `(agent_id, revision)` to be the live, enabled identity in the bound agent
/// registry, with the policy's signer as its signer. Registry errors (`NotFound`,
/// `IdentityChanged`, `Revoked`) pass through, a different signer is `IdentityChanged`, and any
/// other failure denies.
pub fn require_live_signer(env: &Env, policy: &Policy) -> Result<(), Error> {
    let registry = AgentRegistryClient::new(env, &storage::agent_registry(env));
    match registry.try_current(&policy.agent_id, &policy.revision) {
        Ok(Ok(identity))
            if identity.agent_id == policy.agent_id
                && identity.revision == policy.revision
                && !identity.disabled =>
        {
            if identity.signer == policy.signer {
                Ok(())
            } else {
                Err(Error::IdentityChanged)
            }
        }
        Err(Ok(error)) => Err(error),
        _ => Err(Error::VerificationDenied),
    }
}

/// Applies the policy's verification requirement to the provider's current result through the
/// bound verification registry. Registry errors pass through; any other failure denies.
pub fn require_verification(env: &Env, policy: &Policy) -> Result<(), Error> {
    let registry = VerificationRegistryClient::new(env, &storage::verification_registry(env));
    match registry.try_check(
        &policy.agent_id,
        &policy.revision,
        &policy.provider,
        &policy.required_checks,
        &policy.max_assessment_age,
        &policy.max_risk_score,
    ) {
        Ok(Ok(result))
            if result.agent_id == policy.agent_id
                && result.revision == policy.revision
                && result.provider == policy.provider =>
        {
            Ok(())
        }
        Err(Ok(error)) => Err(error),
        _ => Err(Error::VerificationDenied),
    }
}
