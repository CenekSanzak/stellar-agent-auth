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

impl Transfer {
    pub(crate) fn validate_amount(&self) -> Result<(), Error> {
        if self.amount <= 0 {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }
}

impl Action {
    pub(crate) fn validate_amount(&self) -> Result<(), Error> {
        match self {
            Self::Transfer(transfer) => transfer.validate_amount(),
            Self::ServicePayment(payment) => payment.payment.validate_amount(),
        }
    }
}
