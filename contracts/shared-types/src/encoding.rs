use soroban_sdk::{xdr::ToXdr, Address, BytesN, Env, IntoVal, Symbol, Val, Vec};

use crate::{
    action::ActionRequest,
    audit::{AuditEntry, AuditOutcome},
    errors::Error,
    policy::Policy,
    SCHEMA_VERSION,
};

fn digest(env: &Env, purpose: &str, wallet: &Address, value: impl IntoVal<Env, Val>) -> BytesN<32> {
    let preimage = Vec::<Val>::from_array(
        env,
        [
            Symbol::new(env, "stellar_agent_auth").into_val(env),
            SCHEMA_VERSION.into_val(env),
            Symbol::new(env, purpose).into_val(env),
            env.ledger().network_id().into_val(env),
            wallet.into_val(env),
            value.into_val(env),
        ],
    );
    env.crypto().sha256(&preimage.to_xdr(env)).into()
}

pub fn policy_hash(env: &Env, wallet: &Address, policy: &Policy) -> Result<BytesN<32>, Error> {
    let canonical = policy.clone().canonicalize(env)?;
    Ok(digest(env, "policy", wallet, canonical))
}

pub fn action_hash(env: &Env, request: &ActionRequest) -> Result<BytesN<32>, Error> {
    if request.schema_version != SCHEMA_VERSION {
        return Err(Error::UnsupportedVersion);
    }
    request.action.validate_amount()?;
    Ok(digest(env, "action", &request.wallet, request))
}

pub fn audit_hash(env: &Env, entry: &AuditEntry) -> Result<BytesN<32>, Error> {
    if entry.schema_version != SCHEMA_VERSION {
        return Err(Error::UnsupportedVersion);
    }
    match &entry.outcome {
        AuditOutcome::Executed(execution) => execution.action.validate_amount()?,
        AuditOutcome::OwnerWithdrawal(transfer) => transfer.validate_amount()?,
        _ => {}
    }
    Ok(digest(env, "audit", &entry.wallet, entry))
}
