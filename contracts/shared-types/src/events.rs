use soroban_sdk::{contractevent, Address, BytesN};

use crate::attestation::VerificationResult;
use crate::audit::AuditEntry;
use crate::identity::AgentIdentity;

#[contractevent(topics = ["identity_v1"], data_format = "single-value")]
pub struct IdentityChanged {
    #[topic]
    pub agent_id: u64,
    pub identity: AgentIdentity,
}

#[contractevent(topics = ["provider_v1"], data_format = "single-value")]
pub struct ProviderChanged {
    #[topic]
    pub provider: Address,
    pub approved: bool,
}

#[contractevent(topics = ["assessment_v1"], data_format = "single-value")]
pub struct AssessmentChanged {
    #[topic]
    pub agent_id: u64,
    #[topic]
    pub provider: Address,
    pub result: VerificationResult,
}

#[contractevent(topics = ["audit_v1"])]
pub struct WalletAudit {
    #[topic]
    pub sequence: u64,
    pub entry: AuditEntry,
    pub hash: BytesN<32>,
}
