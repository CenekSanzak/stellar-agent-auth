#![no_std]

//! Agent identity, signing address, and metadata records.
//! Placeholder only; no contract entry points are implemented.

// Link the Soroban runtime while business entry points remain unimplemented.
use soroban_sdk as _;

pub mod identity;

pub mod storage;

pub mod events;
