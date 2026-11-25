use soroban_sdk::contracterror;

/// The v1 errors of every contract in this project. Each code names one cause, so that a client
/// can say which rule refused a call. Codes 1 to 14 keep their numbers; 15 onwards split causes
/// that used to share `Revoked`, `Expired`, `VerificationDenied`, `PolicyDenied` and
/// `LimitExceeded`.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    UnsupportedVersion = 1,
    InvalidInput = 2,
    /// A structural limit: too many assets, recipients, checks or active policies, or a value too
    /// long. Spending caps are `PaymentLimitExceeded` and `DailyLimitExceeded`.
    LimitExceeded = 3,
    Duplicate = 4,
    NotFound = 5,
    InvalidSequence = 6,
    /// The policy's validity window has ended.
    Expired = 7,
    /// The policy is revoked.
    Revoked = 8,
    IdentityChanged = 9,
    /// A registry answered in a way the caller did not expect. Specific verification refusals
    /// have their own codes below.
    VerificationDenied = 10,
    /// The policy does not permit this kind of action, this shape of authorization, or this
    /// wallet. Assets, recipients and the start of the window have their own codes below.
    PolicyDenied = 11,
    Paused = 12,
    ArithmeticOverflow = 13,
    /// An asset contract refused a transfer the wallet requested, such as for an insufficient
    /// balance or a missing trustline. Asset contracts number their own errors, so the wallet
    /// reports this instead of letting an asset error code pass for one of its own.
    TransferFailed = 14,
    /// The agent identity is disabled in the agent registry.
    AgentDisabled = 15,
    /// The provider was never approved in the verification registry.
    ProviderNotApproved = 16,
    /// The provider was approved and has since been disabled.
    ProviderDisabled = 17,
    /// The provider revoked its latest result for this agent revision.
    ResultRevoked = 18,
    /// The provider's result has passed its expiry, or is older than the consumer allows.
    ResultExpired = 19,
    /// The result carries a serious wallet-risk flag.
    RiskFlagged = 20,
    /// A check the consumer requires is not `Passed` in the result.
    CheckNotPassed = 21,
    /// The result's aggregate risk is absent or above the consumer's threshold.
    RiskTooHigh = 22,
    /// The request's own deadline has passed.
    RequestExpired = 23,
    /// The policy's validity window has not started.
    NotYetValid = 24,
    /// The policy does not list this asset.
    AssetNotAllowed = 25,
    /// The recipient is not on the policy's allowlist, or is on its blocklist.
    RecipientNotAllowed = 26,
    /// The amount is above the policy's cap for one payment of this asset.
    PaymentLimitExceeded = 27,
    /// The amount would take today's spend of this asset above the policy's daily cap.
    DailyLimitExceeded = 28,
    /// The amount would take everything spent of this asset under the policy above its total cap.
    TotalLimitExceeded = 29,
}
