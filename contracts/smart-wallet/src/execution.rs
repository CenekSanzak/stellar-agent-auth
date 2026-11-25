use soroban_sdk::{token::TokenClient, Address, BytesN, Env};
use stellar_agent_auth_shared_types::{
    action::{Action, ActionKind, ActionRequest, Transfer},
    audit::{AuditOutcome, ExecutedAction},
    encoding::action_hash,
    errors::Error,
    policy::{Policy, PolicyState},
};

use crate::{audit, authorization, policy as rules, storage};

/// Executes one agent-signed request under its policy. The caller has already required the
/// policy's signer, which it loaded as `policy`. Checks, in order:
///
/// 1. the request shape and a positive amount (`action_hash`), and this wallet (`PolicyDenied`);
/// 2. the wallet is not paused (`Paused`) and the policy not revoked (`Revoked`);
/// 3. exactly the policy's next sequence (`InvalidSequence`);
/// 4. ledger time before the request deadline and within the policy's validity window
///    (`Expired`, or `PolicyDenied` before `valid_after`);
/// 5. a permitted action kind, an approved asset, a recipient on the allowlist and not on the
///    blocklist (`PolicyDenied`);
/// 6. the per-transfer cap and today's per-asset budget (`LimitExceeded`);
/// 7. the live identity and signer, then the provider's current verification result.
///
/// Steps 2 and 4 to 7 are shared with the account path (`gate` and `permit`). The sequence, spend
/// and audit head are then committed before the token call. A refused token call fails with
/// `TransferFailed`, which rolls all of them back.
pub fn execute(
    env: &Env,
    hash: &BytesN<32>,
    policy: Policy,
    request: ActionRequest,
) -> Result<BytesN<32>, Error> {
    let wallet = env.current_contract_address();
    let action_hash = action_hash(env, &request)?;
    if request.wallet != wallet {
        return Err(Error::PolicyDenied);
    }
    let now = env.ledger().timestamp();
    let mut state = gate(env, hash, now)?;
    if request.sequence != state.next_sequence {
        return Err(Error::InvalidSequence);
    }
    if now >= request.deadline {
        return Err(Error::Expired);
    }
    let Action::Transfer(ref transfer) = request.action else {
        // `execute` pushes plain transfers. A service payment has to be authorized together with
        // the service's own call, which only the account path can do.
        return Err(Error::PolicyDenied);
    };
    permit(
        env,
        &policy,
        &mut state,
        ActionKind::Transfer,
        transfer,
        now,
    )?;

    state.next_sequence = state
        .next_sequence
        .checked_add(1)
        .ok_or(Error::ArithmeticOverflow)?;
    storage::set_policy_state(env, &state);
    audit::record(
        env,
        policy.signer.clone(),
        AuditOutcome::Executed(ExecutedAction {
            policy_hash: hash.clone(),
            action_hash: action_hash.clone(),
            action: request.action.clone(),
        }),
    )?;
    pay(env, &wallet, transfer)?;
    Ok(action_hash)
}

/// The policy's state as of `now`, unless the wallet is paused (`Paused`) or the policy is revoked
/// (`Revoked`). Both payment paths start here.
pub fn gate(env: &Env, hash: &BytesN<32>, now: u64) -> Result<PolicyState, Error> {
    if storage::paused(env) {
        return Err(Error::Paused);
    }
    let state = rules::as_of(env, storage::policy_state(env, hash)?, now);
    if state.revoked {
        return Err(Error::Revoked);
    }
    Ok(state)
}

/// Whether `policy` permits `transfer` at `now`, adding it to `state`'s spend. Both payment paths
/// apply exactly these rules to one budget, so neither can spend what the other has spent. Checks,
/// in order: the validity window (`Expired` at or after `valid_until`, `PolicyDenied` before
/// `valid_after`); `kind` as a permitted action kind, an approved asset, and a recipient on the
/// allowlist and not on the blocklist (`PolicyDenied`); the per-transfer cap and today's per-asset
/// budget (`LimitExceeded`); then the live identity and signer, and the provider's current
/// verification result. A service payment's transfer is held to the same asset, recipient and
/// budget rules as a plain one. Nothing is stored.
pub fn permit(
    env: &Env,
    policy: &Policy,
    state: &mut PolicyState,
    kind: ActionKind,
    transfer: &Transfer,
    now: u64,
) -> Result<(), Error> {
    if now >= policy.valid_until {
        return Err(Error::Expired);
    }
    if now < policy.valid_after {
        return Err(Error::PolicyDenied);
    }
    if !policy.action_kinds.contains(kind) {
        return Err(Error::PolicyDenied);
    }
    let limit = rules::asset_limit(policy, &transfer.asset)?;
    if policy.blocked_recipients.contains(&transfer.recipient)
        || !policy.allowed_recipients.contains(&transfer.recipient)
    {
        return Err(Error::PolicyDenied);
    }
    if transfer.amount > limit.per_transaction {
        return Err(Error::LimitExceeded);
    }
    rules::add_spend(state, &limit, transfer.amount)?;

    authorization::require_live_signer(env, policy)?;
    authorization::require_verification(env, policy)
}

/// Moves `transfer.amount` from the wallet. The asset sees the wallet as its direct invoker, which
/// authorizes the debit.
pub fn pay(env: &Env, wallet: &Address, transfer: &Transfer) -> Result<(), Error> {
    move_asset(
        env,
        &transfer.asset,
        wallet,
        &transfer.recipient,
        transfer.amount,
    )
}

/// Any refusal by the asset contract, such as an insufficient balance or a missing trustline,
/// becomes `TransferFailed`. Returning an error fails the invocation, which rolls back every write
/// it made, including the sequence, spend and audit head committed before this call.
pub fn move_asset(
    env: &Env,
    asset: &Address,
    from: &Address,
    to: &Address,
    amount: i128,
) -> Result<(), Error> {
    match TokenClient::new(env, asset).try_transfer(from, to, &amount) {
        Ok(Ok(())) => Ok(()),
        _ => Err(Error::TransferFailed),
    }
}
