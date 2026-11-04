#![no_std]

//! Agent identity, signing address, and metadata records.
//!
//! Every successful mutation increments the identity revision so that verification
//! results and wallet policies bound to an earlier revision stop applying.

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, String};
use stellar_agent_auth_shared_types::{
    errors::Error,
    identity::{validate_metadata, AgentIdentity},
};

pub mod events;
pub mod identity;
pub mod storage;

#[cfg(test)]
mod test;

#[contract]
pub struct AgentRegistry;

#[contractimpl]
impl AgentRegistry {
    /// Allocates the next ID. Both the controller and the signer must authorize. The signer is
    /// checked before its proof is requested, so a contract signer's `__check_auth` never runs.
    pub fn register(
        env: Env,
        controller: Address,
        signer: Address,
        metadata_uri: String,
        metadata_hash: BytesN<32>,
    ) -> Result<AgentIdentity, Error> {
        storage::extend_instance(&env);
        controller.require_auth();
        if signer == controller {
            return Err(Error::InvalidInput);
        }
        identity::require_account(&env, &signer)?;
        signer.require_auth();
        validate_metadata(&metadata_uri, &metadata_hash)?;
        let agent_id = storage::agent_count(&env)
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?;
        storage::set_agent_count(&env, agent_id);
        commit(
            &env,
            AgentIdentity {
                agent_id,
                controller,
                signer,
                metadata_uri,
                metadata_hash,
                revision: 1,
                disabled: false,
            },
        )
    }

    pub fn update_metadata(
        env: Env,
        agent_id: u64,
        expected_revision: u64,
        metadata_uri: String,
        metadata_hash: BytesN<32>,
    ) -> Result<AgentIdentity, Error> {
        let mut identity = controlled(&env, agent_id)?;
        identity::check_revision(&identity, expected_revision)?;
        identity::set_metadata(&mut identity, metadata_uri, metadata_hash)?;
        commit(&env, identity)
    }

    /// The new signer must authorize. Allowed while disabled for compromise recovery.
    pub fn rotate_signer(
        env: Env,
        agent_id: u64,
        expected_revision: u64,
        new_signer: Address,
    ) -> Result<AgentIdentity, Error> {
        let mut identity = controlled(&env, agent_id)?;
        // A controller named as signer has just authorized; requiring it again would need a
        // second entry. `set_signer` rejects it after the revision check.
        if new_signer != identity.controller {
            new_signer.require_auth();
        }
        identity::check_revision(&identity, expected_revision)?;
        identity::set_signer(&env, &mut identity, new_signer)?;
        commit(&env, identity)
    }

    pub fn disable(
        env: Env,
        agent_id: u64,
        expected_revision: u64,
    ) -> Result<AgentIdentity, Error> {
        let mut identity = controlled(&env, agent_id)?;
        identity::check_revision(&identity, expected_revision)?;
        identity::set_disabled(&mut identity, true)?;
        commit(&env, identity)
    }

    pub fn reactivate(
        env: Env,
        agent_id: u64,
        expected_revision: u64,
    ) -> Result<AgentIdentity, Error> {
        let mut identity = controlled(&env, agent_id)?;
        identity::check_revision(&identity, expected_revision)?;
        identity::set_disabled(&mut identity, false)?;
        commit(&env, identity)
    }

    pub fn get(env: Env, agent_id: u64) -> Result<AgentIdentity, Error> {
        storage::extend_instance(&env);
        storage::load(&env, agent_id)
    }

    /// Returns the identity only while it is active at exactly `revision`.
    pub fn current(env: Env, agent_id: u64, revision: u64) -> Result<AgentIdentity, Error> {
        storage::extend_instance(&env);
        let identity = storage::load(&env, agent_id)?;
        identity::check_current(&identity, revision)?;
        Ok(identity)
    }

    pub fn agent_count(env: Env) -> u64 {
        storage::extend_instance(&env);
        storage::agent_count(&env)
    }
}

fn controlled(env: &Env, agent_id: u64) -> Result<AgentIdentity, Error> {
    storage::extend_instance(env);
    let identity = storage::load(env, agent_id)?;
    identity.controller.require_auth();
    Ok(identity)
}

fn commit(env: &Env, identity: AgentIdentity) -> Result<AgentIdentity, Error> {
    storage::store(env, &identity);
    events::identity_changed(env, &identity);
    Ok(identity)
}
