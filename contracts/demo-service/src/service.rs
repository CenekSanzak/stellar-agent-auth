//! The service's fixed terms and its receipt counter.

use soroban_sdk::{contracttype, Address, BytesN, Env};
use stellar_agent_auth_shared_types::errors::Error;

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 29 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

/// What the service sells: `service_id` for `price` of `asset`, paid to `payee`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Terms {
    pub asset: Address,
    pub payee: Address,
    pub price: i128,
    pub service_id: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Receipt {
    pub number: u64,
    pub wallet: Address,
    pub amount: i128,
    pub ledger: u32,
}

#[contracttype]
enum DataKey {
    Terms,
    Receipts,
}

pub fn init(env: &Env, terms: &Terms) {
    let storage = env.storage().instance();
    storage.set(&DataKey::Terms, terms);
    storage.set(&DataKey::Receipts, &0u64);
    extend(env);
}

pub fn extend(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn terms(env: &Env) -> Terms {
    env.storage().instance().get(&DataKey::Terms).unwrap()
}

pub fn receipts(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey::Receipts).unwrap()
}

/// Counts and returns the next receipt for a payment that has already been taken.
pub fn record(env: &Env, wallet: &Address, amount: i128) -> Result<Receipt, Error> {
    let number = receipts(env)
        .checked_add(1)
        .ok_or(Error::ArithmeticOverflow)?;
    env.storage().instance().set(&DataKey::Receipts, &number);
    Ok(Receipt {
        number,
        wallet: wallet.clone(),
        amount,
        ledger: env.ledger().sequence(),
    })
}
