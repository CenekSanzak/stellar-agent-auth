use soroban_sdk::{contracttype, Address, BytesN, String};

use crate::errors::Error;

pub const MAX_METADATA_URI_BYTES: u32 = 2_048;

const METADATA_URI_SCHEME: &[u8] = b"https://";

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
