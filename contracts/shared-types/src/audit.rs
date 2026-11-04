use soroban_sdk::{contracttype, Address, BytesN};

use crate::action::Action;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutedAction {
    pub policy_hash: BytesN<32>,
    pub action_hash: BytesN<32>,
    pub action: Action,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(
    clippy::large_enum_variant,
    reason = "Keep typed inline Soroban ABI payloads in no_std WASM"
)]
pub enum AuditOutcome {
    PolicyCreated(BytesN<32>),
    PolicyRevoked(BytesN<32>),
    PauseChanged(bool),
    OwnerWithdrawal(crate::action::Transfer),
    Executed(ExecutedAction),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditEntry {
    pub schema_version: u32,
    pub wallet: Address,
    pub sequence: u64,
    pub previous_hash: BytesN<32>,
    pub ledger: u32,
    pub timestamp: u64,
    pub actor: Address,
    pub outcome: AuditOutcome,
}

/// The wallet's audit chain position: the sequence and hash of the latest entry. At genesis the
/// sequence is 0 and the hash is 32 zero bytes; the first entry has sequence 1.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditHead {
    pub sequence: u64,
    pub hash: BytesN<32>,
}
