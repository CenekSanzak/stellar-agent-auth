use soroban_sdk::{contracttype, Address, BytesN, String};

pub const MAX_METADATA_URI_BYTES: u32 = 2_048;

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
