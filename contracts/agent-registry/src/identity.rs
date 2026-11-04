use soroban_sdk::{Address, BytesN, Env, String};
/// v1 signers are standard Stellar accounts; contract addresses are rejected.
pub use stellar_agent_auth_shared_types::identity::require_account;
use stellar_agent_auth_shared_types::{
    errors::Error,
    identity::{validate_metadata, AgentIdentity},
};

pub fn check_revision(identity: &AgentIdentity, expected_revision: u64) -> Result<(), Error> {
    if identity.revision != expected_revision {
        return Err(Error::IdentityChanged);
    }
    Ok(())
}

/// Live identity at exactly `revision`; disabled identities carry no authority.
pub fn check_current(identity: &AgentIdentity, revision: u64) -> Result<(), Error> {
    check_revision(identity, revision)?;
    if identity.disabled {
        return Err(Error::Revoked);
    }
    Ok(())
}

pub fn set_metadata(
    identity: &mut AgentIdentity,
    metadata_uri: String,
    metadata_hash: BytesN<32>,
) -> Result<(), Error> {
    validate_metadata(&metadata_uri, &metadata_hash)?;
    if identity.metadata_uri == metadata_uri && identity.metadata_hash == metadata_hash {
        return Err(Error::Duplicate);
    }
    identity.metadata_uri = metadata_uri;
    identity.metadata_hash = metadata_hash;
    bump(identity)
}

pub fn set_signer(env: &Env, identity: &mut AgentIdentity, signer: Address) -> Result<(), Error> {
    if signer == identity.controller {
        return Err(Error::InvalidInput);
    }
    require_account(env, &signer)?;
    if identity.signer == signer {
        return Err(Error::Duplicate);
    }
    identity.signer = signer;
    bump(identity)
}

pub fn set_disabled(identity: &mut AgentIdentity, disabled: bool) -> Result<(), Error> {
    if identity.disabled == disabled {
        return Err(Error::Duplicate);
    }
    identity.disabled = disabled;
    bump(identity)
}

fn bump(identity: &mut AgentIdentity) -> Result<(), Error> {
    identity.revision = identity
        .revision
        .checked_add(1)
        .ok_or(Error::ArithmeticOverflow)?;
    Ok(())
}
