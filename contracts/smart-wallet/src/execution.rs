use soroban_sdk::{token::TokenClient, Address, BytesN, Env};
use stellar_agent_auth_shared_types::{
    action::{Action, ActionRequest, Transfer},
    audit::{AuditOutcome, ExecutedAction},
    encoding::action_hash,
    errors::Error,
    policy::Policy,
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
/// The sequence, spend and audit head are then committed before the token call. A refused token
/// call fails with `TransferFailed`, which rolls all of them back.
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
    if storage::paused(env) {
        return Err(Error::Paused);
    }
    let now = env.ledger().timestamp();
    let mut state = rules::as_of(env, storage::policy_state(env, hash)?, now);
    if state.revoked {
        return Err(Error::Revoked);
    }
    if request.sequence != state.next_sequence {
        return Err(Error::InvalidSequence);
    }
    if now >= request.deadline || now >= policy.valid_until {
        return Err(Error::Expired);
    }
    if now < policy.valid_after {
        return Err(Error::PolicyDenied);
    }

    if !policy.action_kinds.contains(request.action.kind()) {
        return Err(Error::PolicyDenied);
    }
    let Action::Transfer(ref transfer) = request.action else {
        // Approval admits transfer-only policies, so this is unreachable in v1; deny regardless.
        return Err(Error::PolicyDenied);
    };
    let limit = rules::asset_limit(&policy, &transfer.asset)?;
    if policy.blocked_recipients.contains(&transfer.recipient)
        || !policy.allowed_recipients.contains(&transfer.recipient)
    {
        return Err(Error::PolicyDenied);
    }
    if transfer.amount > limit.per_transaction {
        return Err(Error::LimitExceeded);
    }
    rules::add_spend(&mut state, &limit, transfer.amount)?;

    authorization::require_live_signer(env, &policy)?;
    authorization::require_verification(env, &policy)?;

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
