use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    UnsupportedVersion = 1,
    InvalidInput = 2,
    LimitExceeded = 3,
    Duplicate = 4,
    NotFound = 5,
    InvalidSequence = 6,
    Expired = 7,
    Revoked = 8,
    IdentityChanged = 9,
    VerificationDenied = 10,
    PolicyDenied = 11,
    Paused = 12,
    ArithmeticOverflow = 13,
    /// An asset contract refused a transfer the wallet requested, such as for an insufficient
    /// balance or a missing trustline. Asset contracts number their own errors, so the wallet
    /// reports this instead of letting an asset error code pass for one of its own.
    TransferFailed = 14,
}
