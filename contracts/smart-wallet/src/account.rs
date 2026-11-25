use soroban_sdk::{
    auth::Context, crypto::Hash, Address, Bytes, BytesN, Env, Symbol, TryFromVal, Vec,
};
use stellar_agent_auth_shared_types::{
    action::{
        AccountSignature, Action, ServicePayment, ServiceRule, Transfer, SERVICE_PAYMENT_METHOD,
    },
    audit::{AccountPayment, AuditOutcome},
    errors::Error,
    identity::account_key,
    policy::{Policy, PolicyState, ServicePermission},
};

use crate::{audit, execution, storage};

/// The account path: the wallet authorizing, as a custom account, a payment that another contract
/// asked it to authorize. `execute` covers payments the agent pushes; this covers payments that
/// are pulled, where the payer itself must authorize the transfer out of its balance.
///
/// It authorizes two shapes and nothing else:
///
/// - a **plain transfer**: one context, `asset.transfer(wallet, recipient, amount)`. Anyone holding
///   the signed entry can make exactly that transfer, which is what an x402 `exact` payment needs.
/// - a **service payment**: two contexts, the call
///   `service.pay_for_service(wallet, asset, recipient, amount, service_id)` on the one service the
///   policy permits, and inside it the transfer of exactly that amount of that asset to that
///   recipient. The entry is rooted at the service call, so the transfer cannot be made without it.
///
/// The host calls this from the wallet's `__check_auth`. Checks, in order:
///
/// 1. the policy named in the signature exists (`NotFound`);
/// 2. the policy signer's ed25519 key signed the payload followed by the policy hash. A wrong
///    signature fails the authorization with a host crypto error, not a contract error;
/// 3. the contexts are one of the two shapes, moving this wallet's own funds, with a positive
///    amount (`PolicyDenied`, or `InvalidInput` for the amount). Every other call, any deployment,
///    and any other combination of calls under one signature are refused, so the wallet is never a
///    general signer;
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

    let action = requested(env, &policy, &contexts)?;
    let now = env.ledger().timestamp();
    let mut state = execution::gate(env, &hash, now)?;
    execution::permit(
        env,
        &policy,
        &mut state,
        action.kind(),
        action.transfer(),
        now,
    )?;

    storage::set_policy_state(env, &state);
    audit::record(
        env,
        policy.signer,
        AuditOutcome::AccountPayment(AccountPayment {
            policy_hash: hash,
            authorization: BytesN::from_array(env, &payload),
            action,
        }),
    )?;
    Ok(())
}

/// What `action` under the policy would do to its state on the account path, or the error that
/// would refuse it. Authenticates nobody and stores nothing.
pub fn preview(env: &Env, hash: &BytesN<32>, action: &Action) -> Result<PolicyState, Error> {
    let policy = storage::policy(env, hash)?;
    let transfer = action.transfer();
    if transfer.amount <= 0 || transfer.recipient == env.current_contract_address() {
        return Err(Error::InvalidInput);
    }
    if let Action::ServicePayment(payment) = action {
        if policy.service != ServicePermission::Restricted(payment.service.clone()) {
            return Err(Error::PolicyDenied);
        }
    }
    let now = env.ledger().timestamp();
    let mut state = execution::gate(env, hash, now)?;
    execution::permit(env, &policy, &mut state, action.kind(), transfer, now)?;
    Ok(state)
}

/// The action the contexts ask this account to authorize: a single transfer of its own funds, or
/// the policy's permitted service call followed by the transfer that call makes. Whether the
/// policy lists the asset and recipient is `permit`'s decision.
fn requested(env: &Env, policy: &Policy, contexts: &Vec<Context>) -> Result<Action, Error> {
    match contexts.len() {
        1 => Ok(Action::Transfer(own_transfer(
            env,
            &contexts.get_unchecked(0),
        )?)),
        2 => {
            let ServicePermission::Restricted(rule) = &policy.service else {
                return Err(Error::PolicyDenied);
            };
            let payment = own_transfer(env, &contexts.get_unchecked(1))?;
            service_call(env, rule, &contexts.get_unchecked(0), &payment)?;
            Ok(Action::ServicePayment(ServicePayment {
                service: rule.clone(),
                payment,
            }))
        }
        _ => Err(Error::PolicyDenied),
    }
}

/// A `transfer(wallet, recipient, amount)` call on some contract, which becomes the transfer's
/// asset.
fn own_transfer(env: &Env, context: &Context) -> Result<Transfer, Error> {
    let Context::Contract(call) = context else {
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
        asset: call.contract.clone(),
        recipient,
        amount,
    })
}

/// The policy's service, called as `pay_for_service(wallet, asset, recipient, amount, service_id)`
/// with exactly the terms of `payment` and the policy's service ID. Any other contract, method,
/// argument count or argument is refused.
fn service_call(
    env: &Env,
    rule: &ServiceRule,
    context: &Context,
    payment: &Transfer,
) -> Result<(), Error> {
    let Context::Contract(call) = context else {
        return Err(Error::PolicyDenied);
    };
    if call.contract != rule.contract
        || call.fn_name != Symbol::new(env, SERVICE_PAYMENT_METHOD)
        || call.args.len() != 5
    {
        return Err(Error::PolicyDenied);
    }
    let wallet = Address::try_from_val(env, &call.args.get_unchecked(0));
    let asset = Address::try_from_val(env, &call.args.get_unchecked(1));
    let recipient = Address::try_from_val(env, &call.args.get_unchecked(2));
    let amount = i128::try_from_val(env, &call.args.get_unchecked(3));
    let service_id = BytesN::<32>::try_from_val(env, &call.args.get_unchecked(4));
    let (Ok(wallet), Ok(asset), Ok(recipient), Ok(amount), Ok(service_id)) =
        (wallet, asset, recipient, amount, service_id)
    else {
        return Err(Error::PolicyDenied);
    };
    if wallet != env.current_contract_address()
        || asset != payment.asset
        || recipient != payment.recipient
        || amount != payment.amount
        || service_id != rule.service_id
    {
        return Err(Error::PolicyDenied);
    }
    Ok(())
}
