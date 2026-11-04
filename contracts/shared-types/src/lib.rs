#![no_std]

//! Versioned contract ABI shared by registries, wallets, and SDK clients.

pub mod action;
pub mod attestation;
pub mod audit;
pub mod encoding;
pub mod errors;
pub mod events;
pub mod identity;
pub mod policy;

pub const SCHEMA_VERSION: u32 = 1;
