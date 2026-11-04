use soroban_sdk::{Address, Env};
use stellar_agent_auth_shared_types::{
    audit::{AuditEntry, AuditHead, AuditOutcome},
    encoding::audit_hash,
    errors::Error,
    events::WalletAudit,
    SCHEMA_VERSION,
};

use crate::storage;

/// Appends one entry to the hash chain and publishes it as `audit_v1`. Only the head is stored;
/// the entry itself lives in the event, and the indexer attaches the transaction hash, which is
/// not available as an execution input. Called only for state changes that are about to commit,
/// so a later failure in the same invocation rolls the head back with everything else.
pub fn record(env: &Env, actor: Address, outcome: AuditOutcome) -> Result<AuditHead, Error> {
    let head = storage::audit_head(env);
    let sequence = head
        .sequence
        .checked_add(1)
        .ok_or(Error::ArithmeticOverflow)?;
    let entry = AuditEntry {
        schema_version: SCHEMA_VERSION,
        wallet: env.current_contract_address(),
        sequence,
        previous_hash: head.hash,
        ledger: env.ledger().sequence(),
        timestamp: env.ledger().timestamp(),
        actor,
        outcome,
    };
    let hash = audit_hash(env, &entry)?;
    let head = AuditHead {
        sequence,
        hash: hash.clone(),
    };
    storage::set_audit_head(env, &head);
    WalletAudit {
        sequence,
        entry,
        hash,
    }
    .publish(env);
    Ok(head)
}
