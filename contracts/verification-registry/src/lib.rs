#![no_std]

//! Provider results, risk scores, expiry, and revocation.
//! Placeholder only; no contract entry points are implemented.

// Link the Soroban runtime while business entry points remain unimplemented.
use soroban_sdk as _;

pub mod attestation;

pub mod provider;

pub mod storage;
