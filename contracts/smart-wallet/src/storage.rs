use soroban_sdk::{contracttype, Address, BytesN, Env, IntoVal, TryFromVal, Val, Vec};
use stellar_agent_auth_shared_types::{
    audit::AuditHead,
    errors::Error,
    policy::{Policy, PolicyState},
};

pub const DAY_IN_LEDGERS: u32 = 17_280;
pub const TTL_THRESHOLD: u32 = 29 * DAY_IN_LEDGERS;
pub const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

/// Instance storage holds the bound roles, the pause flag, the bounded active-policy list and the
/// audit head. Each policy, its mutable state and its ID reservation are separate persistent
/// entries, so archival can only ever make them unavailable, never absent.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Owner,
    AgentRegistry,
    VerificationRegistry,
    Paused,
    ActivePolicies,
    AuditHead,
    /// The immutable canonical policy, by policy hash.
    Policy(BytesN<32>),
    /// The policy's revocation flag, next sequence and daily spend, by policy hash.
    PolicyState(BytesN<32>),
    /// The policy hash that first used a policy ID; never removed, so an ID is never reused.
    PolicyId(BytesN<32>),
}

pub fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn init(env: &Env, owner: &Address, agent_registry: &Address, verification_registry: &Address) {
    let instance = env.storage().instance();
    instance.set(&DataKey::Owner, owner);
    instance.set(&DataKey::AgentRegistry, agent_registry);
    instance.set(&DataKey::VerificationRegistry, verification_registry);
    instance.set(&DataKey::Paused, &false);
    instance.set(&DataKey::ActivePolicies, &Vec::<BytesN<32>>::new(env));
    instance.set(
        &DataKey::AuditHead,
        &AuditHead {
            sequence: 0,
            hash: BytesN::from_array(env, &[0; 32]),
        },
    );
}

fn instance<V: TryFromVal<Env, Val>>(env: &Env, key: &DataKey) -> V {
    // Every instance key is set by the constructor and never removed.
    env.storage().instance().get(key).unwrap()
}

pub fn owner(env: &Env) -> Address {
    instance(env, &DataKey::Owner)
}

pub fn agent_registry(env: &Env) -> Address {
    instance(env, &DataKey::AgentRegistry)
}

pub fn verification_registry(env: &Env) -> Address {
    instance(env, &DataKey::VerificationRegistry)
}

pub fn paused(env: &Env) -> bool {
    instance(env, &DataKey::Paused)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

pub fn active_policies(env: &Env) -> Vec<BytesN<32>> {
    instance(env, &DataKey::ActivePolicies)
}

pub fn set_active_policies(env: &Env, policies: &Vec<BytesN<32>>) {
    env.storage()
        .instance()
        .set(&DataKey::ActivePolicies, policies);
}

pub fn audit_head(env: &Env) -> AuditHead {
    instance(env, &DataKey::AuditHead)
}

pub fn set_audit_head(env: &Env, head: &AuditHead) {
    env.storage().instance().set(&DataKey::AuditHead, head);
}

fn load<V: TryFromVal<Env, Val>>(env: &Env, key: &DataKey) -> Option<V> {
    let storage = env.storage().persistent();
    let value = storage.get(key)?;
    storage.extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    Some(value)
}

fn store<V: IntoVal<Env, Val>>(env: &Env, key: &DataKey, value: &V) {
    let storage = env.storage().persistent();
    storage.set(key, value);
    storage.extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn policy(env: &Env, hash: &BytesN<32>) -> Result<Policy, Error> {
    load(env, &DataKey::Policy(hash.clone())).ok_or(Error::NotFound)
}

/// Stored with every policy, so a policy without state is never observed.
pub fn policy_state(env: &Env, hash: &BytesN<32>) -> Result<PolicyState, Error> {
    load(env, &DataKey::PolicyState(hash.clone())).ok_or(Error::NotFound)
}

pub fn set_policy_state(env: &Env, state: &PolicyState) {
    store(env, &DataKey::PolicyState(state.policy_hash.clone()), state);
}

pub fn policy_id_owner(env: &Env, policy_id: &BytesN<32>) -> Option<BytesN<32>> {
    load(env, &DataKey::PolicyId(policy_id.clone()))
}

/// Stores a newly approved policy, its initial state and its ID reservation together.
pub fn add_policy(env: &Env, hash: &BytesN<32>, policy: &Policy, state: &PolicyState) {
    store(env, &DataKey::Policy(hash.clone()), policy);
    store(env, &DataKey::PolicyId(policy.policy_id.clone()), hash);
    set_policy_state(env, state);
}

/// Extends the reservation alongside a revocation, which is when reuse would matter most.
pub fn touch_policy_id(env: &Env, policy_id: &BytesN<32>) {
    let key = DataKey::PolicyId(policy_id.clone());
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}
