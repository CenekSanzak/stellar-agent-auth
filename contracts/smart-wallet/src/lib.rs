#![no_std]

//! Custody wallet that lets a verified agent make bounded transfers under owner-approved policies.
//!
//! The constructor binds an owner and the agent and verification registries. The owner funds,
//! withdraws, pauses and approves, replaces or revokes policies. A policy names one agent identity
//! revision, its signer, a verification requirement, per-asset caps, recipients and a validity
//! window. `execute` runs one request signed by that signer only while every condition holds
//! against live state. Every successful owner action and execution extends a hash-linked audit
//! chain whose head is stored on-chain.
//!
//! The wallet is also a custom account with one narrow power: under the same policies and the same
//! budgets it authorizes a payment that another contract asks it to authorize. That is a plain
//! transfer of a policy asset, or a call to the one service a policy permits together with the
//! transfer that call makes. See `account`.

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    panic_with_error,
    token::TokenClient,
    Address, BytesN, Env, Vec,
};
use stellar_agent_auth_shared_types::{
    action::{AccountSignature, Action, ActionRequest, Transfer},
    audit::{AuditHead, AuditOutcome},
    errors::Error,
    identity::require_contract,
    policy::{Policy, PolicyState},
};

pub mod account;
pub mod audit;
pub mod authorization;
pub mod execution;
pub mod policy;
pub mod storage;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_account;

#[contract]
pub struct SmartWallet;

#[contractimpl]
impl SmartWallet {
    /// Binds the owner, who must authorize, and the registries every policy decision consults.
    /// The verification registry must itself be bound to `agent_registry`. None of the three can
    /// change after deployment.
    pub fn __constructor(
        env: Env,
        owner: Address,
        agent_registry: Address,
        verification_registry: Address,
    ) {
        owner.require_auth();
        let consistent = require_contract(&env, &agent_registry).is_ok()
            && require_contract(&env, &verification_registry).is_ok()
            && authorization::bound_agent_registry(&env, &verification_registry)
                .is_some_and(|bound| bound == agent_registry);
        if !consistent {
            panic_with_error!(&env, Error::InvalidInput);
        }
        storage::init(&env, &owner, &agent_registry, &verification_registry);
        storage::extend_instance(&env);
    }

    /// `from` must authorize, which covers exactly this transfer of `amount` of `asset` into the
    /// wallet. Anyone may fund, at any time, including while paused; funding grants no authority.
    /// Returns the wallet's balance afterwards.
    pub fn fund(env: Env, from: Address, asset: Address, amount: i128) -> Result<i128, Error> {
        storage::extend_instance(&env);
        from.require_auth();
        let wallet = env.current_contract_address();
        validate_transfer(&env, &wallet, &asset, &from, amount)?;
        execution::move_asset(&env, &asset, &from, &wallet, amount)?;
        Ok(TokenClient::new(&env, &asset).balance(&wallet))
    }

    /// Owner only, also while paused. Sends `amount` of `asset` to `recipient` and returns the
    /// wallet's balance afterwards.
    pub fn withdraw(
        env: Env,
        asset: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<i128, Error> {
        storage::extend_instance(&env);
        let owner = storage::owner(&env);
        owner.require_auth();
        let wallet = env.current_contract_address();
        validate_transfer(&env, &wallet, &asset, &recipient, amount)?;
        let transfer = Transfer {
            asset,
            recipient,
            amount,
        };
        audit::record(&env, owner, AuditOutcome::OwnerWithdrawal(transfer.clone()))?;
        execution::pay(&env, &wallet, &transfer)?;
        Ok(TokenClient::new(&env, &transfer.asset).balance(&wallet))
    }

    /// The wallet's balance of `asset`, read from the asset contract.
    pub fn balance(env: Env, asset: Address) -> Result<i128, Error> {
        storage::extend_instance(&env);
        require_contract(&env, &asset)?;
        Ok(TokenClient::new(&env, &asset).balance(&env.current_contract_address()))
    }

    /// Owner only. Approves `policy` and returns its hash, which agent requests must name.
    pub fn approve_policy(env: Env, policy: Policy) -> Result<BytesN<32>, Error> {
        storage::extend_instance(&env);
        let owner = storage::owner(&env);
        owner.require_auth();
        policy::approve(&env, &owner, policy)
    }

    /// Owner only. Terminally revokes the policy; requests under it fail from this ledger on.
    pub fn revoke_policy(env: Env, policy_hash: BytesN<32>) -> Result<PolicyState, Error> {
        storage::extend_instance(&env);
        let owner = storage::owner(&env);
        owner.require_auth();
        policy::revoke(&env, &owner, &policy_hash)
    }

    /// Owner only. Revokes `old_policy_hash` and approves `policy` atomically: both happen or
    /// neither does. The new policy starts with a fresh sequence and a fresh daily budget.
    pub fn replace_policy(
        env: Env,
        old_policy_hash: BytesN<32>,
        policy: Policy,
    ) -> Result<BytesN<32>, Error> {
        storage::extend_instance(&env);
        let owner = storage::owner(&env);
        owner.require_auth();
        policy::revoke(&env, &owner, &old_policy_hash)?;
        policy::approve(&env, &owner, policy)
    }

    /// Owner only. Blocks every agent execution until `resume`; owner actions and funding remain
    /// available. `Duplicate` when already paused.
    pub fn pause(env: Env) -> Result<(), Error> {
        storage::extend_instance(&env);
        set_paused(&env, true)
    }

    /// Owner only. Lifts the pause. Revoked and expired policies stay unusable. `Duplicate` when
    /// not paused.
    pub fn resume(env: Env) -> Result<(), Error> {
        storage::extend_instance(&env);
        set_paused(&env, false)
    }

    /// The policy's signer must authorize this exact request. See `execution::execute` for the
    /// checks. Returns the action hash recorded in the audit entry.
    pub fn execute(env: Env, request: ActionRequest) -> Result<BytesN<32>, Error> {
        storage::extend_instance(&env);
        let policy = storage::policy(&env, &request.policy_hash)?;
        policy.signer.require_auth();
        let hash = request.policy_hash.clone();
        execution::execute(&env, &hash, policy, request)
    }

    /// What `action` under the policy would leave as the policy's state on the account path, or
    /// the error that would refuse it now. It applies every rule both payment paths share and
    /// authenticates nobody, so it says why a payment would be refused before anything is signed.
    /// A refusal on the account path otherwise reaches the caller only as a host authorization
    /// failure.
    pub fn check_payment(
        env: Env,
        policy_hash: BytesN<32>,
        action: Action,
    ) -> Result<PolicyState, Error> {
        storage::extend_instance(&env);
        account::preview(&env, &policy_hash, &action)
    }

    pub fn owner(env: Env) -> Address {
        storage::extend_instance(&env);
        storage::owner(&env)
    }

    pub fn agent_registry(env: Env) -> Address {
        storage::extend_instance(&env);
        storage::agent_registry(&env)
    }

    pub fn verification_registry(env: Env) -> Address {
        storage::extend_instance(&env);
        storage::verification_registry(&env)
    }

    pub fn paused(env: Env) -> bool {
        storage::extend_instance(&env);
        storage::paused(&env)
    }

    /// Hashes of the active policies, oldest first; at most `MAX_ACTIVE_POLICIES`.
    pub fn policies(env: Env) -> Vec<BytesN<32>> {
        storage::extend_instance(&env);
        storage::active_policies(&env)
    }

    /// The canonical policy, active or revoked.
    pub fn policy(env: Env, policy_hash: BytesN<32>) -> Result<Policy, Error> {
        storage::extend_instance(&env);
        storage::policy(&env, &policy_hash)
    }

    /// The policy's state as of the current ledger time: after a UTC day change, today's spend is
    /// empty even before the next execution writes it.
    pub fn policy_state(env: Env, policy_hash: BytesN<32>) -> Result<PolicyState, Error> {
        storage::extend_instance(&env);
        let state = storage::policy_state(&env, &policy_hash)?;
        Ok(policy::as_of(&env, state, env.ledger().timestamp()))
    }

    pub fn audit_head(env: Env) -> AuditHead {
        storage::extend_instance(&env);
        storage::audit_head(&env)
    }
}

#[contractimpl]
impl CustomAccountInterface for SmartWallet {
    type Signature = AccountSignature;
    type Error = Error;

    /// Called by the host when a contract requires this wallet's authorization. Authorizes one
    /// thing: a transfer of a policy asset out of the wallet, signed by that policy's agent key,
    /// within the policy. See `account::authorize`.
    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: AccountSignature,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Error> {
        storage::extend_instance(&env);
        account::authorize(&env, signature_payload, signature, auth_contexts)
    }
}

/// A positive amount of a contract asset moving between the wallet and another address.
fn validate_transfer(
    env: &Env,
    wallet: &Address,
    asset: &Address,
    counterparty: &Address,
    amount: i128,
) -> Result<(), Error> {
    require_contract(env, asset)?;
    if amount <= 0 || counterparty == wallet {
        return Err(Error::InvalidInput);
    }
    Ok(())
}

fn set_paused(env: &Env, paused: bool) -> Result<(), Error> {
    let owner = storage::owner(env);
    owner.require_auth();
    if storage::paused(env) == paused {
        return Err(Error::Duplicate);
    }
    storage::set_paused(env, paused);
    audit::record(env, owner, AuditOutcome::PauseChanged(paused))?;
    Ok(())
}
