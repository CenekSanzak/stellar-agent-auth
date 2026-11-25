# Contracts

P0 configures four Soroban WASM crates plus the shared-types Rust library. `npm run build:contracts` uses the pinned Stellar CLI and locked dependencies. Rust host tests run with `npm run test:rust`.

P1 defines the [v1 contract ABI and event layouts](../docs/decisions/0002-v1-abi-and-authorization.md) in the shared library. The separate `tests/contracts/auth-probe` fixture exercises owner authorization and a signed transfer on local Stellar. P2 implements the agent registry; see [its decision record](../docs/decisions/0003-agent-registry.md). P3 implements the verification registry, which binds provider results to live agent revisions; see [ADR 0004](../docs/decisions/0004-verification-registry.md). P4 implements the smart wallet: owner custody, policy approval, revocation and replacement, pause, agent execution checked against live identity and verification, per-asset UTC budgets and an on-chain audit head; see [ADR 0005](../docs/decisions/0005-smart-wallet.md).

The policy module stays inside smart-wallet. Shared types remain a normal library and do not produce an independently deployed contract.

`tests/contracts/account-probe` is a spike fixture, not a product contract: a custom account that enforces a cut-down policy in `__check_auth`, used to show that the wallet can pay a plain asset transfer. Its findings and the decision to add that path to the smart wallet are in [ADR 0006](../docs/decisions/0006-custom-account-spike.md).

P9 adds the smart wallet's account payment path: as a custom account it authorizes one plain transfer of a policy asset under a policy, on the same budget as `execute`, and `check_payment` explains a refusal in advance; see [ADR 0007](../docs/decisions/0007-account-payment-path.md).
