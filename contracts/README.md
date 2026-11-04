# Contracts

P0 configures four Soroban WASM crates plus the shared-types Rust library. `npm run build:contracts` uses the pinned Stellar CLI and locked dependencies. Rust host tests run with `npm run test:rust`.

P1 defines the [v1 contract ABI and event layouts](../docs/decisions/0002-v1-abi-and-authorization.md) in the shared library. The separate `tests/contracts/auth-probe` fixture exercises owner authorization and a signed transfer on local Stellar. Application entry points for the registries and wallet follow in P2–P4.

The policy module stays inside smart-wallet. Shared types remain a normal library and do not produce an independently deployed contract.
