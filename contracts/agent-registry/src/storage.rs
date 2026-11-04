use soroban_sdk::{contracttype, Env};
use stellar_agent_auth_shared_types::{errors::Error, identity::AgentIdentity};

pub const DAY_IN_LEDGERS: u32 = 17_280;
pub const TTL_THRESHOLD: u32 = 29 * DAY_IN_LEDGERS;
pub const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    AgentCount,
    Identity(u64),
}

pub fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Highest allocated agent ID; zero before the first registration.
pub fn agent_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::AgentCount)
        .unwrap_or(0)
}

pub fn set_agent_count(env: &Env, count: u64) {
    env.storage().instance().set(&DataKey::AgentCount, &count);
}

pub fn load(env: &Env, agent_id: u64) -> Result<AgentIdentity, Error> {
    let key = DataKey::Identity(agent_id);
    let storage = env.storage().persistent();
    let identity = storage.get(&key).ok_or(Error::NotFound)?;
    storage.extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    Ok(identity)
}

pub fn store(env: &Env, identity: &AgentIdentity) {
    let key = DataKey::Identity(identity.agent_id);
    let storage = env.storage().persistent();
    storage.set(&key, identity);
    storage.extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}
