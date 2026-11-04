#![no_std]

//! Local test fixture for the v1 authorization and resource gate.

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env};
use stellar_agent_auth_shared_types::{
    action::{Action, ActionRequest},
    attestation::VerificationResult,
    audit::{AuditEntry, AuditOutcome, ExecutedAction},
    encoding::{action_hash, audit_hash, policy_hash},
    errors::Error,
    events::{AssessmentChanged, IdentityChanged, WalletAudit},
    identity::AgentIdentity,
    policy::Policy,
    SCHEMA_VERSION,
};

#[contracttype]
enum Key {
    Owner,
    Agent,
    Asset,
    Policy,
    PolicyHash,
    Identity,
    Assessment,
    AuditHead,
    AuditSequence,
    NextSequence,
}

#[contract]
pub struct AuthProbe;

#[contractimpl]
impl AuthProbe {
    pub fn __constructor(env: Env, owner: Address, agent: Address, asset: Address) {
        owner.require_auth();
        let storage = env.storage().instance();
        storage.set(&Key::Owner, &owner);
        storage.set(&Key::Agent, &agent);
        storage.set(&Key::Asset, &asset);
        storage.set(&Key::AuditHead, &BytesN::from_array(&env, &[0; 32]));
        storage.set(&Key::AuditSequence, &0u64);
        storage.set(&Key::NextSequence, &0u64);
    }

    pub fn measure(
        env: Env,
        policy: Policy,
        identity: AgentIdentity,
        assessment: VerificationResult,
    ) -> Result<BytesN<32>, Error> {
        let owner: Address = env.storage().instance().get(&Key::Owner).unwrap();
        owner.require_auth();

        identity.validate_shape()?;
        assessment.validate_shape()?;
        let wallet = env.current_contract_address();
        let hash = policy_hash(&env, &wallet, &policy)?;
        let storage = env.storage().persistent();
        storage.set(&Key::Policy, &policy);
        storage.set(&Key::PolicyHash, &hash);
        storage.set(&Key::Identity, &identity);
        storage.set(&Key::Assessment, &assessment);
        IdentityChanged {
            agent_id: identity.agent_id,
            identity,
        }
        .publish(&env);
        AssessmentChanged {
            agent_id: assessment.agent_id,
            provider: assessment.provider.clone(),
            result: assessment,
        }
        .publish(&env);
        record(&env, owner, AuditOutcome::PolicyCreated(hash.clone()))?;
        Ok(hash)
    }

    pub fn execute(env: Env, request: ActionRequest) -> Result<BytesN<32>, Error> {
        let storage = env.storage().instance();
        let agent: Address = storage.get(&Key::Agent).unwrap();
        agent.require_auth();
        let wallet = env.current_contract_address();
        let hash = action_hash(&env, &request)?;
        let policy: BytesN<32> = env
            .storage()
            .persistent()
            .get(&Key::PolicyHash)
            .ok_or(Error::NotFound)?;
        if request.wallet != wallet || request.policy_hash != policy {
            return Err(Error::PolicyDenied);
        }
        let next: u64 = storage.get(&Key::NextSequence).unwrap();
        if request.sequence != next {
            return Err(Error::InvalidSequence);
        }
        if env.ledger().timestamp() >= request.deadline {
            return Err(Error::Expired);
        }
        let Action::Transfer(ref transfer) = request.action else {
            return Err(Error::InvalidInput);
        };
        let asset: Address = storage.get(&Key::Asset).unwrap();
        if transfer.asset != asset {
            return Err(Error::InvalidInput);
        }

        storage.set(
            &Key::NextSequence,
            &next.checked_add(1).ok_or(Error::ArithmeticOverflow)?,
        );
        // The token contract sees this wallet as its direct invoker.
        token::TokenClient::new(&env, &asset).transfer(
            &wallet,
            &transfer.recipient,
            &transfer.amount,
        );
        record(
            &env,
            agent,
            AuditOutcome::Executed(ExecutedAction {
                policy_hash: policy,
                action_hash: hash.clone(),
                action: request.action,
            }),
        )?;
        Ok(hash)
    }
}

fn record(env: &Env, actor: Address, outcome: AuditOutcome) -> Result<(), Error> {
    let storage = env.storage().instance();
    let sequence: u64 = storage.get(&Key::AuditSequence).unwrap();
    let entry = AuditEntry {
        schema_version: SCHEMA_VERSION,
        wallet: env.current_contract_address(),
        sequence,
        previous_hash: storage.get(&Key::AuditHead).unwrap(),
        ledger: env.ledger().sequence(),
        timestamp: env.ledger().timestamp(),
        actor,
        outcome,
    };
    let hash = audit_hash(env, &entry)?;
    storage.set(
        &Key::AuditSequence,
        &sequence.checked_add(1).ok_or(Error::ArithmeticOverflow)?,
    );
    storage.set(&Key::AuditHead, &hash);
    WalletAudit {
        sequence,
        entry,
        hash,
    }
    .publish(env);
    Ok(())
}
