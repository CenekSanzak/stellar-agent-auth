#![no_std]

//! Provider-authenticated verification results bound to live agent identity revisions.
//!
//! A constructor-appointed admin approves providers. Each approved provider publishes results for
//! `(agent_id, revision)` in strict sequence; only the latest result per agent revision and
//! provider is stored, so a newer failure or revocation can never fall back to an older pass.

use soroban_sdk::{contract, contractimpl, panic_with_error, Address, Env, Vec};
use stellar_agent_auth_shared_types::{
    attestation::{
        validate_requirement, AssessmentMode, CheckKind, ProviderRecord, VerificationResult,
    },
    errors::Error,
    identity::require_contract,
};

pub mod attestation;
pub mod provider;
pub mod storage;

#[cfg(test)]
mod test;

#[contract]
pub struct VerificationRegistry;

#[contractimpl]
impl VerificationRegistry {
    /// Binds the admin, who must authorize, and the agent registry every publication and lookup
    /// consults. Neither can change after deployment.
    pub fn __constructor(env: Env, admin: Address, agent_registry: Address) {
        admin.require_auth();
        if require_contract(&env, &agent_registry).is_err() {
            panic_with_error!(&env, Error::InvalidInput);
        }
        storage::init(&env, &admin, &agent_registry);
        storage::extend_instance(&env);
    }

    /// Admin only. Binds a never-approved provider address to `mode` for its lifetime.
    pub fn approve_provider(
        env: Env,
        provider: Address,
        mode: AssessmentMode,
    ) -> Result<ProviderRecord, Error> {
        storage::extend_instance(&env);
        storage::admin(&env).require_auth();
        provider::approve(&env, provider, mode)
    }

    /// Admin only. Immediately blocks every result from `provider`; terminal.
    pub fn disable_provider(env: Env, provider: Address) -> Result<ProviderRecord, Error> {
        storage::extend_instance(&env);
        storage::admin(&env).require_auth();
        provider::disable(&env, provider)
    }

    /// The provider named in `result` must authorize. Publishes the next sequence for the agent
    /// revision and provider; see `attestation::publish` for the rules.
    pub fn publish(env: Env, result: VerificationResult) -> Result<VerificationResult, Error> {
        storage::extend_instance(&env);
        result.provider.require_auth();
        attestation::publish(&env, result)
    }

    /// The provider must authorize. Terminal for the result at `sequence`, which must be the latest.
    pub fn revoke(
        env: Env,
        agent_id: u64,
        revision: u64,
        provider: Address,
        sequence: u64,
    ) -> Result<VerificationResult, Error> {
        storage::extend_instance(&env);
        provider.require_auth();
        attestation::revoke(
            &env,
            &attestation::key(agent_id, revision, provider),
            sequence,
        )
    }

    pub fn provider(env: Env, provider: Address) -> Result<ProviderRecord, Error> {
        storage::extend_instance(&env);
        storage::provider(&env, &provider).ok_or(Error::NotFound)
    }

    /// The latest result in any state, for display. Never use it to authorize anything.
    pub fn latest(
        env: Env,
        agent_id: u64,
        revision: u64,
        provider: Address,
    ) -> Result<VerificationResult, Error> {
        storage::extend_instance(&env);
        storage::result(&env, &attestation::key(agent_id, revision, provider))
            .ok_or(Error::NotFound)
    }

    /// The latest result only while it is usable: approved provider, live identity revision, not
    /// revoked and not expired.
    pub fn current(
        env: Env,
        agent_id: u64,
        revision: u64,
        provider: Address,
    ) -> Result<VerificationResult, Error> {
        storage::extend_instance(&env);
        attestation::current(&env, &attestation::key(agent_id, revision, provider))
    }

    /// `current`, then the consumer's requirement: every required check `Passed`, an age of at
    /// most `max_age` seconds, no serious wallet-risk flag and a present aggregate risk of at most
    /// `max_risk_score`.
    pub fn check(
        env: Env,
        agent_id: u64,
        revision: u64,
        provider: Address,
        required_checks: Vec<CheckKind>,
        max_age: u64,
        max_risk_score: u32,
    ) -> Result<VerificationResult, Error> {
        storage::extend_instance(&env);
        validate_requirement(&required_checks, max_age, max_risk_score)?;
        let result = attestation::current(&env, &attestation::key(agent_id, revision, provider))?;
        result.evaluate(
            env.ledger().timestamp(),
            &required_checks,
            max_age,
            max_risk_score,
        )?;
        Ok(result)
    }

    pub fn admin(env: Env) -> Address {
        storage::extend_instance(&env);
        storage::admin(&env)
    }

    pub fn agent_registry(env: Env) -> Address {
        storage::extend_instance(&env);
        storage::agent_registry(&env)
    }
}
