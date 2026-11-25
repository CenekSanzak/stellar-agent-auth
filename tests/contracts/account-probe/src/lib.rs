#![no_std]

//! Spike, not a product contract: can a contract enforce an owner's policy as the *payer* of a plain
//! token transfer?
//!
//! The smart wallet pays only through its own `execute` entry point. A service that expects the
//! payer to authorize `asset.transfer(payer, payee, amount)` directly, as x402's `exact` scheme on
//! Stellar does, cannot be paid that way. This contract is a custom account instead: the host calls
//! `__check_auth` when the asset requires this contract's authorization, and the policy runs there.
//!
//! It holds one cut-down policy with no owner and no way to change it. It exists to answer whether
//! `__check_auth` can do what `execute` does: verify the agent's signature, restrict what is being
//! authorized, consult both registries, update the daily spend and publish an event.

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractclient, contractevent, contractimpl, contracttype,
    crypto::Hash,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Symbol, TryFromVal, Vec,
};
use stellar_agent_auth_shared_types::{
    attestation::{CheckKind, VerificationResult},
    errors::Error,
    identity::AgentIdentity,
    policy::utc_day,
};

#[cfg(test)]
mod test;

/// The one policy this account enforces, fixed at construction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// Named in every signature, so a signature cannot be moved to another policy of the same key.
    pub policy_id: BytesN<32>,
    /// The agent's ed25519 key. The registered agent signer must be the account with this key.
    pub signer_key: BytesN<32>,
    pub agent_id: u64,
    pub revision: u64,
    pub agent_registry: Address,
    pub verification_registry: Address,
    pub provider: Address,
    pub required_checks: Vec<CheckKind>,
    pub max_assessment_age: u64,
    pub max_risk_score: u32,
    pub asset: Address,
    pub per_transaction: i128,
    pub per_day: i128,
    pub recipients: Vec<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Spend {
    pub utc_day: u64,
    pub amount: i128,
    /// Payments authorized, ever. Shows that `__check_auth` ran exactly once per payment.
    pub count: u32,
}

/// What the agent supplies as the credential's signature: the policy it acts under and an ed25519
/// signature over `signature_payload || policy_id`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSignature {
    pub policy_id: BytesN<32>,
    pub signature: BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Config,
    Spend,
}

#[contractevent(topics = ["account_pay_v1"])]
pub struct AccountPayment {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
    pub spent_today: i128,
}

#[contractclient(name = "AgentRegistryClient")]
pub trait AgentRegistryInterface {
    fn current(env: Env, agent_id: u64, revision: u64) -> Result<AgentIdentity, Error>;
}

#[contractclient(name = "VerificationRegistryClient")]
pub trait VerificationRegistryInterface {
    #[allow(clippy::too_many_arguments)]
    fn check(
        env: Env,
        agent_id: u64,
        revision: u64,
        provider: Address,
        required_checks: Vec<CheckKind>,
        max_age: u64,
        max_risk_score: u32,
    ) -> Result<VerificationResult, Error>;
}

#[contract]
pub struct AccountProbe;

#[contractimpl]
impl AccountProbe {
    pub fn __constructor(env: Env, config: Config) {
        let storage = env.storage().instance();
        storage.set(&DataKey::Config, &config);
        storage.set(
            &DataKey::Spend,
            &Spend {
                utc_day: utc_day(env.ledger().timestamp()),
                amount: 0,
                count: 0,
            },
        );
    }

    pub fn config(env: Env) -> Config {
        env.storage().instance().get(&DataKey::Config).unwrap()
    }

    /// The spend as stored; a day change shows only after the next payment.
    pub fn spend(env: Env) -> Spend {
        env.storage().instance().get(&DataKey::Spend).unwrap()
    }
}

#[contractimpl]
impl CustomAccountInterface for AccountProbe {
    type Signature = AgentSignature;
    type Error = Error;

    /// Authorizes exactly one thing: `asset.transfer(this, recipient, amount)` within the policy,
    /// signed by the agent key, while the agent's identity and verification are current.
    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: AgentSignature,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Error> {
        let config: Config = env.storage().instance().get(&DataKey::Config).unwrap();

        // The payload covers the network, the nonce, the expiry and the whole invocation, but not
        // which policy applies. Binding the policy ID here stops a relayer from choosing one.
        if signature.policy_id != config.policy_id {
            return Err(Error::PolicyDenied);
        }
        let mut message = Bytes::from_array(&env, &signature_payload.to_array());
        message.append(&Bytes::from_array(&env, &signature.policy_id.to_array()));
        // Panics, failing the authorization, unless the agent key signed this message.
        env.crypto()
            .ed25519_verify(&config.signer_key, &message, &signature.signature);

        // Deny by default: one contract call, to the policy's asset, named `transfer`, moving this
        // account's own funds. Deployments and every other call this address might be asked to
        // authorize are refused.
        if auth_contexts.len() != 1 {
            return Err(Error::PolicyDenied);
        }
        let Context::Contract(call) = auth_contexts.get_unchecked(0) else {
            return Err(Error::PolicyDenied);
        };
        if call.contract != config.asset
            || call.fn_name != Symbol::new(&env, "transfer")
            || call.args.len() != 3
        {
            return Err(Error::PolicyDenied);
        }
        let from = Address::try_from_val(&env, &call.args.get_unchecked(0));
        let recipient = Address::try_from_val(&env, &call.args.get_unchecked(1));
        let amount = i128::try_from_val(&env, &call.args.get_unchecked(2));
        let (Ok(from), Ok(recipient), Ok(amount)) = (from, recipient, amount) else {
            return Err(Error::PolicyDenied);
        };
        if from != env.current_contract_address() || !config.recipients.contains(&recipient) {
            return Err(Error::PolicyDenied);
        }
        if amount <= 0 {
            return Err(Error::InvalidInput);
        }
        if amount > config.per_transaction {
            return Err(Error::LimitExceeded);
        }

        let mut spend: Spend = env.storage().instance().get(&DataKey::Spend).unwrap();
        let today = utc_day(env.ledger().timestamp());
        if spend.utc_day != today {
            spend.utc_day = today;
            spend.amount = 0;
        }
        spend.amount = spend
            .amount
            .checked_add(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        if spend.amount > config.per_day {
            return Err(Error::LimitExceeded);
        }
        spend.count = spend
            .count
            .checked_add(1)
            .ok_or(Error::ArithmeticOverflow)?;

        require_live_signer(&env, &config)?;
        require_verification(&env, &config)?;

        env.storage().instance().set(&DataKey::Spend, &spend);
        AccountPayment {
            recipient,
            amount,
            spent_today: spend.amount,
        }
        .publish(&env);
        Ok(())
    }
}

/// `ScVal::Address(ScAddress::Account(PublicKey::Ed25519(..)))` as XDR: three four-byte
/// discriminants, then the 32-byte key.
const ACCOUNT_ADDRESS_XDR_PREFIX: [u8; 12] = [0, 0, 0, 18, 0, 0, 0, 0, 0, 0, 0, 0];

/// The live identity must name, as its signer, the account whose key signs for this policy.
fn require_live_signer(env: &Env, config: &Config) -> Result<(), Error> {
    let registry = AgentRegistryClient::new(env, &config.agent_registry);
    match registry.try_current(&config.agent_id, &config.revision) {
        Ok(Ok(identity))
            if identity.agent_id == config.agent_id
                && identity.revision == config.revision
                && !identity.disabled =>
        {
            let mut expected = Bytes::from_array(env, &ACCOUNT_ADDRESS_XDR_PREFIX);
            expected.append(&Bytes::from_array(env, &config.signer_key.to_array()));
            if identity.signer.to_xdr(env) == expected {
                Ok(())
            } else {
                Err(Error::IdentityChanged)
            }
        }
        Err(Ok(error)) => Err(error),
        _ => Err(Error::VerificationDenied),
    }
}

fn require_verification(env: &Env, config: &Config) -> Result<(), Error> {
    let registry = VerificationRegistryClient::new(env, &config.verification_registry);
    match registry.try_check(
        &config.agent_id,
        &config.revision,
        &config.provider,
        &config.required_checks,
        &config.max_assessment_age,
        &config.max_risk_score,
    ) {
        Ok(Ok(result))
            if result.agent_id == config.agent_id
                && result.revision == config.revision
                && result.provider == config.provider =>
        {
            Ok(())
        }
        Err(Ok(error)) => Err(error),
        _ => Err(Error::VerificationDenied),
    }
}
