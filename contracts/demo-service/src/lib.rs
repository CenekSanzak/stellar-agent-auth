#![no_std]

//! A small paid service, for demonstrating a payment that the service pulls from a wallet.
//!
//! It sells one thing at a fixed price in one asset. A purchase is one call,
//! `pay_for_service(wallet, asset, recipient, amount, service_id)`: the service requires the
//! wallet's authorization for that call, takes the price by transferring from the wallet inside
//! it, and records a receipt. Payment and receipt are atomic. If the wallet refuses the
//! authorization or the transfer fails, nothing is recorded.
//!
//! The arguments repeat the service's own terms so that the payer authorizes them explicitly. The
//! service refuses anything other than its configured asset, payee, price and service ID.

use soroban_sdk::{
    contract, contractevent, contractimpl, token::TokenClient, Address, BytesN, Env,
};
use stellar_agent_auth_shared_types::errors::Error;

pub mod service;

pub use service::{Receipt, Terms};

#[contractevent(topics = ["service_paid_v1"])]
pub struct ServicePaid {
    #[topic]
    pub wallet: Address,
    pub receipt: Receipt,
}

#[contract]
pub struct DemoService;

#[contractimpl]
impl DemoService {
    /// Fixes what this service sells and to whom the price is paid. Nothing can change afterwards.
    pub fn __constructor(env: Env, terms: Terms) {
        if terms.price <= 0 {
            soroban_sdk::panic_with_error!(&env, Error::InvalidInput);
        }
        service::init(&env, &terms);
    }

    /// Sells the service to `wallet` for the configured price. `wallet` must authorize this exact
    /// call, and the transfer of `amount` of `asset` from `wallet` to `recipient` inside it.
    /// Returns the receipt, numbered from 1. `InvalidInput` unless the four terms are exactly the
    /// service's own.
    pub fn pay_for_service(
        env: Env,
        wallet: Address,
        asset: Address,
        recipient: Address,
        amount: i128,
        service_id: BytesN<32>,
    ) -> Result<Receipt, Error> {
        service::extend(&env);
        let terms = service::terms(&env);
        if asset != terms.asset
            || recipient != terms.payee
            || amount != terms.price
            || service_id != terms.service_id
        {
            return Err(Error::InvalidInput);
        }
        wallet.require_auth();
        TokenClient::new(&env, &asset).transfer(&wallet, &recipient, &amount);

        let receipt = service::record(&env, &wallet, amount)?;
        ServicePaid {
            wallet,
            receipt: receipt.clone(),
        }
        .publish(&env);
        Ok(receipt)
    }

    /// Asks `wallet` to let this service spend from it later. A wallet that pays only what it was
    /// asked to pay must refuse this; it exists to show that it does.
    pub fn open_allowance(env: Env, wallet: Address, amount: i128, live_until_ledger: u32) {
        service::extend(&env);
        let terms = service::terms(&env);
        wallet.require_auth();
        TokenClient::new(&env, &terms.asset).approve(
            &wallet,
            &env.current_contract_address(),
            &amount,
            &live_until_ledger,
        );
    }

    pub fn terms(env: Env) -> Terms {
        service::extend(&env);
        service::terms(&env)
    }

    /// Receipts issued so far.
    pub fn receipts(env: Env) -> u64 {
        service::extend(&env);
        service::receipts(&env)
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::Address as _,
        token::{StellarAssetClient, TokenClient},
    };

    struct Test {
        env: Env,
        service: Address,
        asset: Address,
        payee: Address,
        payer: Address,
        terms: Terms,
    }

    fn setup() -> Test {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let asset = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let payee = Address::generate(&env);
        let payer = Address::generate(&env);
        let terms = Terms {
            asset: asset.clone(),
            payee: payee.clone(),
            price: 3,
            service_id: BytesN::from_array(&env, &[7; 32]),
        };
        let service = env.register(DemoService, (terms.clone(),));
        StellarAssetClient::new(&env, &asset).mint(&payer, &10);
        Test {
            env,
            service,
            asset,
            payee,
            payer,
            terms,
        }
    }

    #[test]
    fn sells_at_its_own_terms_and_numbers_receipts() {
        let t = setup();
        let client = DemoServiceClient::new(&t.env, &t.service);
        let token = TokenClient::new(&t.env, &t.asset);
        assert_eq!(client.terms(), t.terms);

        let buy = || client.pay_for_service(&t.payer, &t.asset, &t.payee, &3, &t.terms.service_id);
        let first = buy();
        assert_eq!(
            (first.number, first.wallet.clone(), first.amount),
            (1, t.payer.clone(), 3)
        );
        assert_eq!(buy().number, 2);
        assert_eq!(client.receipts(), 2);
        assert_eq!(token.balance(&t.payee), 6);
        assert_eq!(token.balance(&t.payer), 4);
    }

    #[test]
    fn refuses_any_other_terms_and_records_nothing() {
        let t = setup();
        let client = DemoServiceClient::new(&t.env, &t.service);
        let other = Address::generate(&t.env);
        let other_id = BytesN::from_array(&t.env, &[8; 32]);
        let id = &t.terms.service_id;
        for (asset, payee, amount, service_id) in [
            (&other, &t.payee, 3, id),
            (&t.asset, &other, 3, id),
            (&t.asset, &t.payee, 2, id),
            (&t.asset, &t.payee, 4, id),
            (&t.asset, &t.payee, 3, &other_id),
        ] {
            assert_eq!(
                client.try_pay_for_service(&t.payer, asset, payee, &amount, service_id),
                Err(Ok(Error::InvalidInput))
            );
        }
        // A payer who cannot pay: the transfer fails and no receipt is issued.
        assert!(client
            .try_pay_for_service(&other, &t.asset, &t.payee, &3, id)
            .is_err());
        assert_eq!(client.receipts(), 0);
        assert_eq!(TokenClient::new(&t.env, &t.asset).balance(&t.payee), 0);
    }
}
