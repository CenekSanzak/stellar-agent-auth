use soroban_sdk::{
    auth::Context, crypto::Hash, Address, Bytes, BytesN, Env, Symbol, TryFromVal, Vec,
};
use stellar_agent_auth_shared_types::{
    action::{AccountSignature, Transfer},
    audit::{AccountPayment, AuditOutcome},
    errors::Error,
    identity::account_key,
    policy::PolicyState,
};

use crate::{audit, execution, storage};

/// The account path: the wallet authorizing, as a custom account, a transfer that an asset contract
/// asked it to authorize. `execute` covers payments the agent pushes; this covers payments a
/// service pulls, where the payer must authorize `asset.transfer(wallet, payee, amount)` itself.
///
/// The host calls this from the wallet's `__check_auth`. Checks, in order:
///
/// 1. the policy named in the signature exists (`NotFound`);
/// 2. the policy signer's ed25519 key signed the payload followed by the policy hash. A wrong
///    signature fails the authorization with a host crypto error, not a contract error;
/// 3. exactly one context, a `transfer` of this wallet's own funds with a positive amount
///    (`PolicyDenied`, or `InvalidInput` for the amount). Every other call, any deployment, and
///    several calls under one signature are refused, so the wallet is never a general signer;
/// 4. everything `execute` checks about the wallet, the policy and the transfer, on the same
///    budget (`execution::gate` and `execution::permit`).
///
/// The spend and an audit entry are then stored. The asset contract moves the funds only after
/// this returns; if that fails, the invocation fails and both are rolled back.
///
/// Two things differ from `execute` by nature. The agent signs here as a key: the signer account's
/// own signers and thresholds are not consulted, only its key. And there is no policy sequence or
/// request deadline: the host's nonce prevents replay, and the entry's expiry ledger, chosen by
/// the signer, bounds its life.
pub fn authorize(
    env: &Env,
    signature_payload: Hash<32>,
    signature: AccountSignature,
    contexts: Vec<Context>,
) -> Result<(), Error> {
    let hash = signature.policy_hash;
    let policy = storage::policy(env, &hash)?;

    let payload = signature_payload.to_array();
    let mut message = Bytes::from_array(env, &payload);
    message.append(&Bytes::from_array(env, &hash.to_array()));
    env.crypto().ed25519_verify(
        &account_key(env, &policy.signer)?,
        &message,
        &signature.signature,
    );

    let transfer = own_transfer(env, &contexts)?;
    let now = env.ledger().timestamp();
    let mut state = execution::gate(env, &hash, now)?;
    execution::permit(env, &policy, &mut state, &transfer, now)?;

    storage::set_policy_state(env, &state);
    audit::record(
        env,
        policy.signer,
        AuditOutcome::AccountPayment(AccountPayment {
            policy_hash: hash,
            authorization: BytesN::from_array(env, &payload),
            transfer,
        }),
    )?;
    Ok(())
}

/// What a payment of `amount` of `asset` to `recipient` under the policy would do to its state,
/// or the error that would refuse it. Authenticates nobody and stores nothing.
pub fn preview(env: &Env, hash: &BytesN<32>, transfer: &Transfer) -> Result<PolicyState, Error> {
    let policy = storage::policy(env, hash)?;
    if transfer.amount <= 0 || transfer.recipient == env.current_contract_address() {
        return Err(Error::InvalidInput);
    }
    let now = env.ledger().timestamp();
    let mut state = execution::gate(env, hash, now)?;
    execution::permit(env, &policy, &mut state, transfer, now)?;
    Ok(state)
}

/// The one thing this account authorizes: a single `transfer(wallet, recipient, amount)` call on
/// some contract, which becomes the transfer's asset. Whether the policy lists that asset and
/// recipient is `permit`'s decision.
fn own_transfer(env: &Env, contexts: &Vec<Context>) -> Result<Transfer, Error> {
    if contexts.len() != 1 {
        return Err(Error::PolicyDenied);
    }
    let Context::Contract(call) = contexts.get_unchecked(0) else {
        return Err(Error::PolicyDenied);
    };
    if call.fn_name != Symbol::new(env, "transfer") || call.args.len() != 3 {
        return Err(Error::PolicyDenied);
    }
    let from = Address::try_from_val(env, &call.args.get_unchecked(0));
    let recipient = Address::try_from_val(env, &call.args.get_unchecked(1));
    let amount = i128::try_from_val(env, &call.args.get_unchecked(2));
    let (Ok(from), Ok(recipient), Ok(amount)) = (from, recipient, amount) else {
        return Err(Error::PolicyDenied);
    };
    if from != env.current_contract_address() {
        return Err(Error::PolicyDenied);
    }
    if amount <= 0 {
        return Err(Error::InvalidInput);
    }
    Ok(Transfer {
        asset: call.contract,
        recipient,
        amount,
    })
}
