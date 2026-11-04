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
}
