use soroban_sdk::{Address, BytesN, Env, Vec};
use stellar_agent_auth_shared_types::{
    action::ActionKind,
    audit::AuditOutcome,
    encoding::policy_hash,
    errors::Error,
    identity::{require_account, require_contract},
    policy::{
        utc_day, AssetLimit, AssetSpend, Policy, PolicyState, ServicePermission,
        MAX_ACTIVE_POLICIES,
    },
};

use crate::{audit, authorization, storage};

/// Validates, stores and activates a policy for the owner. Checks, in order: the canonical v1 shape
/// (`canonicalize`); the wallet's own rules (`InvalidInput`); an unexpired validity window
/// (`Expired`); an unused policy ID (`Duplicate` while active, `Revoked` once revoked); a free
/// active slot (`LimitExceeded`); and the live identity with the policy's signer.
pub fn approve(env: &Env, owner: &Address, policy: Policy) -> Result<BytesN<32>, Error> {
    let wallet = env.current_contract_address();
    let policy = policy.canonicalize(env)?;
    validate_for_wallet(env, &wallet, owner, &policy)?;
    let now = env.ledger().timestamp();
    if now >= policy.valid_until {
        return Err(Error::Expired);
    }
    if let Some(previous) = storage::policy_id_owner(env, &policy.policy_id) {
        let state = storage::policy_state(env, &previous)?;
        return Err(if state.revoked {
            Error::Revoked
        } else {
            Error::Duplicate
        });
    }
    let mut active = storage::active_policies(env);
    if active.len() >= MAX_ACTIVE_POLICIES {
        return Err(Error::LimitExceeded);
    }
    authorization::require_live_signer(env, &policy)?;

    let hash = policy_hash(env, &wallet, &policy)?;
    let state = PolicyState {
        policy_hash: hash.clone(),
        revoked: false,
        next_sequence: 1,
        utc_day: utc_day(now),
        daily_spend: Vec::new(env),
    };
    storage::add_policy(env, &hash, &policy, &state);
    active.push_back(hash.clone());
    storage::set_active_policies(env, &active);
    audit::record(
        env,
        owner.clone(),
        AuditOutcome::PolicyCreated(hash.clone()),
    )?;
    Ok(hash)
}

/// Terminally revokes an active policy: `NotFound` if unknown, `Duplicate` if already revoked.
pub fn revoke(env: &Env, owner: &Address, hash: &BytesN<32>) -> Result<PolicyState, Error> {
    let policy = storage::policy(env, hash)?;
    let mut state = storage::policy_state(env, hash)?;
    if state.revoked {
        return Err(Error::Duplicate);
    }
    state.revoked = true;
    storage::set_policy_state(env, &state);
    storage::touch_policy_id(env, &policy.policy_id);
    let mut active = storage::active_policies(env);
    if let Some(index) = active.first_index_of(hash) {
        active.remove(index);
    }
    storage::set_active_policies(env, &active);
    audit::record(
        env,
        owner.clone(),
        AuditOutcome::PolicyRevoked(hash.clone()),
    )?;
    Ok(state)
}

/// Rules beyond the shared canonical shape. In v1 the wallet executes plain transfers only, so a
/// policy naming service payments is refused until the restricted service path exists. The signer
/// must be a standard account other than the owner, every asset a contract, and no recipient the
/// wallet itself.
fn validate_for_wallet(
    env: &Env,
    wallet: &Address,
    owner: &Address,
    policy: &Policy,
) -> Result<(), Error> {
    if policy.action_kinds.len() != 1
        || policy.action_kinds.get_unchecked(0) != ActionKind::Transfer
        || policy.service != ServicePermission::Disabled
    {
        return Err(Error::InvalidInput);
    }
    require_account(env, &policy.signer)?;
    if policy.signer == *owner {
        return Err(Error::InvalidInput);
    }
    for limit in policy.assets.iter() {
        require_contract(env, &limit.asset)?;
    }
    if policy.allowed_recipients.contains(wallet) || policy.blocked_recipients.contains(wallet) {
        return Err(Error::InvalidInput);
    }
    Ok(())
}

/// The policy's limit for `asset`, or `PolicyDenied` for an asset the policy does not name.
pub fn asset_limit(policy: &Policy, asset: &Address) -> Result<AssetLimit, Error> {
    policy
        .assets
        .iter()
        .find(|limit| limit.asset == *asset)
        .ok_or(Error::PolicyDenied)
}

/// The state as of ledger time `now`: a stored day before today has spent nothing today. Used for
/// reads and before accounting, so a day change never needs a separate write.
pub fn as_of(env: &Env, mut state: PolicyState, now: u64) -> PolicyState {
    let today = utc_day(now);
    if state.utc_day != today {
        state.utc_day = today;
        state.daily_spend = Vec::new(env);
    }
    state
}

/// Adds `amount` of `asset` to today's spend, failing with `LimitExceeded` above `per_day` and
/// `ArithmeticOverflow` on overflow. Spend is per asset and never combined across assets.
pub fn add_spend(state: &mut PolicyState, limit: &AssetLimit, amount: i128) -> Result<(), Error> {
    let index = state
        .daily_spend
        .iter()
        .position(|spend| spend.asset == limit.asset);
    let spent = index.map_or(0, |i| state.daily_spend.get_unchecked(i as u32).amount);
    let total = spent.checked_add(amount).ok_or(Error::ArithmeticOverflow)?;
    if total > limit.per_day {
        return Err(Error::LimitExceeded);
    }
    let spend = AssetSpend {
        asset: limit.asset.clone(),
        amount: total,
    };
    match index {
        Some(i) => state.daily_spend.set(i as u32, spend),
        None => state.daily_spend.push_back(spend),
    }
    Ok(())
}
