# Contracts

P0 configures four Soroban WASM crates plus the shared-types Rust library. `npm run build:contracts` uses the pinned Stellar CLI and locked dependencies. Rust host tests run with `npm run test:rust`.

Only demo-service exposes a non-economic `probe(BytesN<32>)` entry point to exercise build, ABI and host dispatch. Registries and wallet link the runtime but have no business entry points. Nothing is deployed. Future identity, verification, wallet and service behavior remains defined by the implementation plan.

The policy module stays inside smart-wallet. Shared types remain a normal library and do not produce an independently deployed contract.
