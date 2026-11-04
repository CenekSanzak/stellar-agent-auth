use soroban_sdk::{contracttype, Address, BytesN, Vec};

pub const MAX_CHECKS: u32 = 8;
pub const MAX_RISK_SCORE: u32 = 100;
pub const KNOWN_COMPROMISE: u32 = 1 << 0;
pub const CONFIRMED_MALICIOUS_ACTIVITY: u32 = 1 << 1;
pub const THREAT_FEED_MATCH: u32 = 1 << 2;
pub const SERIOUS_WALLET_RISK_MASK: u32 =
    KNOWN_COMPROMISE | CONFIRMED_MALICIOUS_ACTIVITY | THREAT_FEED_MATCH;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum CheckKind {
    Code,
    Endpoint,
    Media,
    Metadata,
    SignerAccount,
    SignerHistory,
    ThreatFeed,
    Token,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CheckOutcome {
    Passed,
    Failed,
    Inconclusive,
    NotApplicable,
    Unsupported,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckResult {
    pub kind: CheckKind,
    pub outcome: CheckOutcome,
    pub score: Option<u32>,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssessmentMode {
    Live,
    Fixture,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerificationResult {
    pub schema_version: u32,
    pub agent_id: u64,
    pub revision: u64,
    pub provider: Address,
    pub sequence: u64,
    pub mode: AssessmentMode,
    pub checks: Vec<CheckResult>,
    pub risk_score: Option<u32>,
    pub serious_wallet_risks: u32,
    pub evidence_hash: BytesN<32>,
    pub issued_at: u64,
    pub expires_at: u64,
    pub revoked: bool,
}

impl VerificationResult {
    pub fn validate_shape(&self) -> Result<(), crate::errors::Error> {
        use crate::errors::Error;

        if self.schema_version != crate::SCHEMA_VERSION {
            return Err(Error::UnsupportedVersion);
        }
        if self.checks.len() > MAX_CHECKS {
            return Err(Error::LimitExceeded);
        }
        if self.serious_wallet_risks & !SERIOUS_WALLET_RISK_MASK != 0
            || self.risk_score.is_some_and(|score| score > MAX_RISK_SCORE)
        {
            return Err(Error::InvalidInput);
        }

        let mut seen = 0u32;
        for check in self.checks.iter() {
            let bit = 1 << (check.kind as u32);
            if seen & bit != 0 {
                return Err(Error::Duplicate);
            }
            seen |= bit;
            if check.score.is_some_and(|score| score > MAX_RISK_SCORE) {
                return Err(Error::InvalidInput);
            }
        }
        Ok(())
    }
}
