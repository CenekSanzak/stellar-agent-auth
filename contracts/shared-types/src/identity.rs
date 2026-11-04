use soroban_sdk::{contracttype, xdr::ToXdr, Address, Bytes, BytesN, Env, String};

use crate::errors::Error;

pub const MAX_METADATA_URI_BYTES: u32 = 2_048;

const METADATA_URI_SCHEME: &[u8] = b"https://";

/// XDR prefixes of `ScVal::Address(ScAddress::Account(..))` and `ScVal::Address(ScAddress::Contract(..))`.
/// `Address::to_payload` would need soroban-sdk's `hazmat-address` feature.
const ACCOUNT_ADDRESS_XDR: [u8; 8] = [0, 0, 0, 18, 0, 0, 0, 0];
const CONTRACT_ADDRESS_XDR: [u8; 8] = [0, 0, 0, 18, 0, 0, 0, 1];

fn has_prefix(env: &Env, address: &Address, prefix: &[u8; 8]) -> Result<(), Error> {
    let xdr = address.clone().to_xdr(env);
    if xdr.len() < 8 || xdr.slice(0..8) != Bytes::from_array(env, prefix) {
        return Err(Error::InvalidInput);
    }
    Ok(())
}

/// A standard ed25519 account; contract and muxed addresses fail with `InvalidInput`.
pub fn require_account(env: &Env, address: &Address) -> Result<(), Error> {
    has_prefix(env, address, &ACCOUNT_ADDRESS_XDR)
}

/// A contract address; anything else fails with `InvalidInput`.
pub fn require_contract(env: &Env, address: &Address) -> Result<(), Error> {
    has_prefix(env, address, &CONTRACT_ADDRESS_XDR)
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentIdentity {
    pub agent_id: u64,
    pub controller: Address,
    pub signer: Address,
    pub metadata_uri: String,
    pub metadata_hash: BytesN<32>,
    pub revision: u64,
    pub disabled: bool,
}

impl AgentIdentity {
    pub fn validate_shape(&self) -> Result<(), crate::errors::Error> {
        if self.metadata_uri.len() > MAX_METADATA_URI_BYTES {
            return Err(crate::errors::Error::LimitExceeded);
        }
        Ok(())
    }
}

/// Accepts a non-empty `https://` URI of visible ASCII bytes within the v1 cap and a non-zero hash.
pub fn validate_metadata(uri: &String, hash: &BytesN<32>) -> Result<(), Error> {
    let len = uri.len();
    if len == 0 {
        return Err(Error::InvalidInput);
    }
    if len > MAX_METADATA_URI_BYTES {
        return Err(Error::LimitExceeded);
    }
    let mut buffer = [0u8; MAX_METADATA_URI_BYTES as usize];
    let bytes = &mut buffer[..len as usize];
    uri.copy_into_slice(bytes);
    if bytes.len() <= METADATA_URI_SCHEME.len() || !bytes.starts_with(METADATA_URI_SCHEME) {
        return Err(Error::InvalidInput);
    }
    if bytes.iter().any(|byte| !(0x21..=0x7e).contains(byte)) {
        return Err(Error::InvalidInput);
    }
    if hash.to_array() == [0; 32] {
        return Err(Error::InvalidInput);
    }
    Ok(())
}
