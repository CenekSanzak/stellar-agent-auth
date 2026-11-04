use soroban_sdk::{contracttype, Address, BytesN, Vec};

use crate::errors::Error;

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
    pub fn validate_shape(&self) -> Result<(), Error> {
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

/// An approved verification provider. Each provider address is bound to one assessment mode for its
/// lifetime, so fixture data can never be published under a live provider identity or the reverse.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderRecord {
    pub mode: AssessmentMode,
    pub approved: bool,
}

/// Aggregate risk: the integer ceiling of the mean of the scored checks, or `None` when no check is
/// scored. Unscored checks never count as zero risk.
pub fn risk_score(checks: &Vec<CheckResult>) -> Option<u32> {
    let (mut sum, mut count) = (0u32, 0u32);
    for check in checks.iter() {
        if let Some(score) = check.score {
            // At most `MAX_CHECKS` scores of at most `MAX_RISK_SCORE`, so the sum cannot overflow.
            sum += score.min(MAX_RISK_SCORE);
            count += 1;
        }
    }
    (count > 0).then(|| sum.div_ceil(count))
}

impl VerificationResult {
    /// Stateless rules for a new publication at ledger time `now`, in this order: the v1 shape;
    /// at least one check, in strictly ascending kind order; scores only on `Passed` or `Failed`
    /// checks; an aggregate equal to [`risk_score`]; not revoked; `issued_at <= now`;
    /// `issued_at < expires_at`; and `now < expires_at`.
    pub fn validate_publication(&self, now: u64) -> Result<(), Error> {
        self.validate_shape()?;
        if self.checks.is_empty() {
            return Err(Error::InvalidInput);
        }
        let mut previous: Option<CheckKind> = None;
        for check in self.checks.iter() {
            if previous.is_some_and(|kind| kind >= check.kind) {
                return Err(Error::InvalidInput);
            }
            previous = Some(check.kind);
            let assessed = matches!(check.outcome, CheckOutcome::Passed | CheckOutcome::Failed);
            if check.score.is_some() && !assessed {
                return Err(Error::InvalidInput);
            }
        }
        if self.risk_score != risk_score(&self.checks) || self.revoked {
            return Err(Error::InvalidInput);
        }
        if self.issued_at > now || self.expires_at <= self.issued_at {
            return Err(Error::InvalidInput);
        }
        if self.expires_at <= now {
            return Err(Error::Expired);
        }
        Ok(())
    }

    /// Applies a consumer's requirement to a result already returned as current, at ledger time
    /// `now`. Checks, in order: revocation (`Revoked`); expiry, valid while `now < expires_at`
    /// (`Expired`); an issue time not after `now` (`InvalidInput`); an age of at most `max_age`
    /// seconds (`Expired`); no serious wallet-risk flag; every required check `Passed`; and an
    /// aggregate risk present and at most `max_risk_score` (each `VerificationDenied`).
    pub fn evaluate(
        &self,
        now: u64,
        required_checks: &Vec<CheckKind>,
        max_age: u64,
        max_risk_score: u32,
    ) -> Result<(), Error> {
        validate_requirement(required_checks, max_age, max_risk_score)?;
        if self.revoked {
            return Err(Error::Revoked);
        }
        if now >= self.expires_at {
            return Err(Error::Expired);
        }
        let age = now.checked_sub(self.issued_at).ok_or(Error::InvalidInput)?;
        if age > max_age {
            return Err(Error::Expired);
        }
        if self.serious_wallet_risks != 0 {
            return Err(Error::VerificationDenied);
        }
        for required in required_checks.iter() {
            let passed = self
                .checks
                .iter()
                .any(|check| check.kind == required && check.outcome == CheckOutcome::Passed);
            if !passed {
                return Err(Error::VerificationDenied);
            }
        }
        match self.risk_score {
            Some(score) if score <= max_risk_score => Ok(()),
            _ => Err(Error::VerificationDenied),
        }
    }
}

/// A consumer requirement: one to `MAX_CHECKS` distinct required checks, a positive maximum age
/// and a risk threshold of at most `MAX_RISK_SCORE`.
pub fn validate_requirement(
    required_checks: &Vec<CheckKind>,
    max_age: u64,
    max_risk_score: u32,
) -> Result<(), Error> {
    if required_checks.len() > MAX_CHECKS {
        return Err(Error::LimitExceeded);
    }
    let mut seen = 0u32;
    for kind in required_checks.iter() {
        let bit = 1 << (kind as u32);
        if seen & bit != 0 {
            return Err(Error::Duplicate);
        }
        seen |= bit;
    }
    if required_checks.is_empty() || max_age == 0 || max_risk_score > MAX_RISK_SCORE {
        return Err(Error::InvalidInput);
    }
    Ok(())
}
