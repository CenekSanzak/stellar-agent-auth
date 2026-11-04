use soroban_sdk::{contracttype, Address, Env};
use stellar_agent_auth_shared_types::attestation::{ProviderRecord, VerificationResult};

pub const DAY_IN_LEDGERS: u32 = 17_280;
pub const TTL_THRESHOLD: u32 = 29 * DAY_IN_LEDGERS;
pub const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

/// The one latest-result slot for an agent revision and provider.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResultKey {
    pub agent_id: u64,
    pub revision: u64,
    pub provider: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    AgentRegistry,
    Provider(Address),
    Result(ResultKey),
}

pub fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn init(env: &Env, admin: &Address, agent_registry: &Address) {
    let instance = env.storage().instance();
    instance.set(&DataKey::Admin, admin);
    instance.set(&DataKey::AgentRegistry, agent_registry);
}

/// Set once by the constructor.
pub fn admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

/// Set once by the constructor.
pub fn agent_registry(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::AgentRegistry)
        .unwrap()
}

fn load<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey) -> Option<V> {
    let storage = env.storage().persistent();
    let value = storage.get(key)?;
    storage.extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    Some(value)
}

fn store<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, value: &V) {
    let storage = env.storage().persistent();
    storage.set(key, value);
    storage.extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn provider(env: &Env, provider: &Address) -> Option<ProviderRecord> {
    load(env, &DataKey::Provider(provider.clone()))
}

pub fn set_provider(env: &Env, provider: &Address, record: &ProviderRecord) {
    store(env, &DataKey::Provider(provider.clone()), record);
}

pub fn result(env: &Env, key: &ResultKey) -> Option<VerificationResult> {
    load(env, &DataKey::Result(key.clone()))
}

pub fn set_result(env: &Env, result: &VerificationResult) {
    store(env, &DataKey::Result(result_key(result)), result);
}

pub fn result_key(result: &VerificationResult) -> ResultKey {
    ResultKey {
        agent_id: result.agent_id,
        revision: result.revision,
        provider: result.provider.clone(),
    }
}
