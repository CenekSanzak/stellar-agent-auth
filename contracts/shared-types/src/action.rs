use soroban_sdk::{contracttype, Address, BytesN};

use crate::errors::Error;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Transfer {
    pub asset: Address,
    pub recipient: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceRule {
    pub contract: Address,
    pub service_id: BytesN<32>,
}

/// The one entry point a service must offer to be paid through a wallet's service permission:
/// `pay_for_service(wallet, asset, recipient, amount, service_id)`. The service requires the
/// wallet's authorization for that call and, inside it, transfers exactly `amount` of `asset` from
/// the wallet to `recipient`.
pub const SERVICE_PAYMENT_METHOD: &str = "pay_for_service";

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServicePayment {
    pub service: ServiceRule,
    pub payment: Transfer,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum ActionKind {
    ServicePayment,
    Transfer,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Action {
    ServicePayment(ServicePayment),
    Transfer(Transfer),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionRequest {
    pub schema_version: u32,
    pub wallet: Address,
    pub policy_hash: BytesN<32>,
    pub sequence: u64,
    pub deadline: u64,
    pub action: Action,
}

/// The signature value of the wallet's own credential on its account path, where the wallet
/// authorizes a plain asset transfer as a custom account. It names the policy the agent acts under
/// and carries the policy signer's ed25519 signature over the host's signature payload followed by
/// that policy hash. The payload alone does not say which policy applies.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountSignature {
    pub policy_hash: BytesN<32>,
    pub signature: BytesN<64>,
}

impl Transfer {
    pub(crate) fn validate_amount(&self) -> Result<(), Error> {
        if self.amount <= 0 {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }
}

impl Action {
    /// The transfer of funds this action makes, whichever kind it is.
    pub fn transfer(&self) -> &Transfer {
        match self {
            Self::Transfer(transfer) => transfer,
            Self::ServicePayment(payment) => &payment.payment,
        }
    }

    pub fn kind(&self) -> ActionKind {
        match self {
            Self::Transfer(_) => ActionKind::Transfer,
            Self::ServicePayment(_) => ActionKind::ServicePayment,
        }
    }

    pub(crate) fn validate_amount(&self) -> Result<(), Error> {
        match self {
            Self::Transfer(transfer) => transfer.validate_amount(),
            Self::ServicePayment(payment) => payment.payment.validate_amount(),
        }
    }
}
