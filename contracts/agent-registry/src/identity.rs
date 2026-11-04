use soroban_sdk::{xdr::ToXdr, Address, Bytes, BytesN, Env, String};
use stellar_agent_auth_shared_types::{
    errors::Error,
    identity::{validate_metadata, AgentIdentity},
};

/// XDR prefix of `ScVal::Address(ScAddress::Account(..))`.
const ACCOUNT_ADDRESS_XDR: [u8; 8] = [0, 0, 0, 18, 0, 0, 0, 0];

/// v1 signers are standard Stellar accounts; contract addresses are rejected.
pub fn require_account(env: &Env, address: &Address) -> Result<(), Error> {
    let xdr = address.clone().to_xdr(env);
    if xdr.len() < 8 || xdr.slice(0..8) != Bytes::from_array(env, &ACCOUNT_ADDRESS_XDR) {
        return Err(Error::InvalidInput);
    }
    Ok(())
}

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
