use soroban_sdk::{Address, Env};
use stellar_agent_auth_shared_types::{
    attestation::{AssessmentMode, ProviderRecord},
    errors::Error,
    events::ProviderChanged,
};

use crate::storage;

/// Approves a provider address that has never been approved. Disabling is terminal: a disabled
/// address returns `Revoked` and a replacement provider needs a new address.
pub fn approve(
    env: &Env,
    provider: Address,
    mode: AssessmentMode,
) -> Result<ProviderRecord, Error> {
    match storage::provider(env, &provider) {
        Some(record) if record.approved => Err(Error::Duplicate),
        Some(_) => Err(Error::Revoked),
        None => commit(
            env,
            provider,
            ProviderRecord {
                mode,
                approved: true,
            },
        ),
    }
}

pub fn disable(env: &Env, provider: Address) -> Result<ProviderRecord, Error> {
    let mut record = storage::provider(env, &provider).ok_or(Error::NotFound)?;
    if !record.approved {
        return Err(Error::Duplicate);
    }
    record.approved = false;
    commit(env, provider, record)
}

/// The record of a provider whose results may be published or used: `VerificationDenied` if it
/// was never approved, `Revoked` once disabled.
pub fn require_approved(env: &Env, provider: &Address) -> Result<ProviderRecord, Error> {
    match storage::provider(env, provider) {
        Some(record) if record.approved => Ok(record),
        Some(_) => Err(Error::Revoked),
        None => Err(Error::VerificationDenied),
    }
}

/// Stores the record and publishes `provider_v1` with the record after the change.
fn commit(env: &Env, provider: Address, record: ProviderRecord) -> Result<ProviderRecord, Error> {
    storage::set_provider(env, &provider, &record);
    ProviderChanged { provider, record }.publish(env);
    Ok(record)
}
