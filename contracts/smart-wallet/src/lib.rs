#![no_std]

//! Wallet custody, permissions, and restricted execution.
//! Placeholder only; no contract entry points are implemented.

// Link the Soroban runtime while business entry points remain unimplemented.
use soroban_sdk as _;

pub mod policy;

pub mod execution;

pub mod audit;

pub mod authorization;

pub mod storage;
