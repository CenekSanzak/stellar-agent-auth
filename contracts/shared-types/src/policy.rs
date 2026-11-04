use soroban_sdk::{contracttype, Address, BytesN, Env, IntoVal, Vec};

use crate::action::{ActionKind, ServiceRule};
use crate::attestation::{CheckKind, MAX_CHECKS, MAX_RISK_SCORE};
use crate::{errors::Error, SCHEMA_VERSION};

pub const MAX_ASSETS: u32 = 4;
pub const MAX_RECIPIENTS: u32 = 32;
/// Active (approved and not revoked) policies one wallet may hold at once.
pub const MAX_ACTIVE_POLICIES: u32 = 8;
pub const SECONDS_PER_DAY: u64 = 86_400;

/// The UTC day number of a Unix timestamp; daily budgets reset when it changes.
pub const fn utc_day(timestamp: u64) -> u64 {
    timestamp / SECONDS_PER_DAY
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetLimit {
    pub asset: Address,
    pub per_transaction: i128,
    pub per_day: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServicePermission {
    Disabled,
    Restricted(ServiceRule),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Policy {
    pub schema_version: u32,
    pub policy_id: BytesN<32>,
    pub agent_id: u64,
    pub revision: u64,
    pub signer: Address,
    pub provider: Address,
    pub required_checks: Vec<CheckKind>,
    pub max_assessment_age: u64,
    pub max_risk_score: u32,
    pub assets: Vec<AssetLimit>,
    pub allowed_recipients: Vec<Address>,
    pub blocked_recipients: Vec<Address>,
    pub valid_after: u64,
    pub valid_until: u64,
    pub action_kinds: Vec<ActionKind>,
    pub service: ServicePermission,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetSpend {
    pub asset: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyState {
    pub policy_hash: BytesN<32>,
    pub revoked: bool,
    pub next_sequence: u64,
    pub utc_day: u64,
    pub daily_spend: Vec<AssetSpend>,
}

impl Policy {
    /// Normalize bounded sets before hashing or storing the policy.
    pub fn canonicalize(mut self, env: &Env) -> Result<Self, Error> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(Error::UnsupportedVersion);
        }
        if self.assets.len() > MAX_ASSETS
            || self.allowed_recipients.len() > MAX_RECIPIENTS
            || self.blocked_recipients.len() > MAX_RECIPIENTS
            || self.required_checks.len() > MAX_CHECKS
            || self.action_kinds.len() > 2
        {
            return Err(Error::LimitExceeded);
        }
        if self.valid_after >= self.valid_until
            || self.max_assessment_age == 0
            || self.max_risk_score > MAX_RISK_SCORE
            || self.required_checks.is_empty()
            || self.assets.is_empty()
            || self.action_kinds.is_empty()
            || self.action_kinds.contains(ActionKind::ServicePayment)
                != matches!(self.service, ServicePermission::Restricted(_))
        {
            return Err(Error::InvalidInput);
        }
        for asset in self.assets.iter() {
            if asset.per_transaction <= 0 || asset.per_transaction > asset.per_day {
                return Err(Error::InvalidInput);
            }
        }

        self.assets = sorted_unique(env, self.assets, |limit| limit.asset.clone())?;
        self.allowed_recipients = sorted_unique(env, self.allowed_recipients, Address::clone)?;
        self.blocked_recipients = sorted_unique(env, self.blocked_recipients, Address::clone)?;
        self.required_checks = sorted_unique(env, self.required_checks, |kind| *kind)?;
        self.action_kinds = sorted_unique(env, self.action_kinds, |kind| *kind)?;
        Ok(self)
    }
}

fn sorted_unique<T, K>(env: &Env, values: Vec<T>, key: impl Fn(&T) -> K) -> Result<Vec<T>, Error>
where
    T: Clone + IntoVal<Env, soroban_sdk::Val> + soroban_sdk::TryFromVal<Env, soroban_sdk::Val>,
    K: Ord,
{
    let mut sorted: Vec<T> = Vec::new(env);
    for value in values.iter() {
        let value_key = key(&value);
        let mut lo = 0;
        let mut hi = sorted.len();
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            match key(&sorted.get_unchecked(mid)).cmp(&value_key) {
                core::cmp::Ordering::Less => lo = mid + 1,
                core::cmp::Ordering::Greater => hi = mid,
                core::cmp::Ordering::Equal => return Err(Error::Duplicate),
            }
        }
        sorted.insert(lo, value);
    }
    Ok(sorted)
}
