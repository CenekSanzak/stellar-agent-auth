# Development

P0 supplies the build and test environment. P1 adds the v1 contract ABI, hash vectors and a local fixture that verifies native authorization and a sponsor-paid transfer. P2 adds the agent registry, its SDK helpers and a signed local registry flow. P3 adds the verification registry, the limited verifier CLI (`services/verifier`), the SDK verification client and a signed local verification flow. P4 adds the smart wallet, the SDK wallet and policy clients, and signed local wallet and adversarial suites; see [ADR 0005](decisions/0005-smart-wallet.md) for its storage maintenance notes. P5 adds the SDK transaction pipeline, the fee sponsor (`services/submitter`), the CLI (`packages/cli`) and `examples/payment-flow.ts`; see [P5 validation](P5_VALIDATION.md). P9 adds the wallet's account payment path, service payments, one error code per cause and a total cap; see [P9 validation](P9_VALIDATION.md). P6 adds the indexer (`services/indexer`), which keeps event history in SQLite and verifies audit chains, and `history --indexer` in the CLI; see [ADR 0009](decisions/0009-durable-history.md) and [P6 validation](P6_VALIDATION.md). P7 adds the owner demo (`apps/demo`): `npm run demo:setup` and `npm run demo` after `npm run dev`, and `npm run test:browser` for its browser test, which needs an installed Chrome; see the [demo README](../apps/demo/README.md), [ADR 0010](decisions/0010-owner-demo.md) and [P7 validation](P7_VALIDATION.md). The final Testnet deployment (P8) is not made yet.

## Pinned environment

| Component | Pin |
| --- | --- |
| Node / npm | 24.22.2 / 11.19.1 (Node's bundled npm) |
| Rust | 1.98.0 with rustfmt, clippy, wasm32v1-none |
| Soroban SDK | 29.0.1 (protocol 29) |
| Stellar CLI | 30.0.1 (build tool; SDK major must not exceed CLI major) |
| Stellar JS SDK | 17.4.0 |
| TypeScript / Vitest | 5.9.3 / 5.1.0 |
| Quickstart | Immutable digest in compose.yaml; local protocol explicitly set to 29 |

Testnet reported protocol 29 during P0 version selection and protocol 30 at the P3 checkpoint. The contracts built on soroban-sdk 29 deploy and run on it. Its RPC records CAP-71 `AddressV2` credentials, which the SDK signs; the local baseline stays at 29 until a deliberate upgrade. The Rust SDK's published minimum Rust version is 1.91; the pinned compiler exceeds it. Dependencies are locked in Cargo.lock and package-lock.json. Revalidate network compatibility before deployment; a future Testnet upgrade does not automatically change the local baseline.

Sources: [Soroban build requirements](https://github.com/stellar/rs-soroban-sdk), [CLI releases](https://github.com/stellar/stellar-cli/releases), [Quickstart options](https://github.com/stellar/quickstart). P0 installs no private signing keys and deploys nothing.

## Clean checkout

Install nvm (or the exact Node version), rustup and Docker with Compose v2, then:

```sh
nvm install
nvm use
npm ci --ignore-scripts
rustup show
cargo install stellar-cli --version 30.0.1 --locked
npm run check
```

Alternatively install the matching Stellar CLI release binary for your OS/architecture. `npm run build:contracts` rejects a different CLI version. Contract compilation uses `stellar contract build`, which applies the SDK's required WASM processing. The build creates the four application WASM files plus two local-only test contracts, the auth probe and the custom account spike ([ADR 0006](decisions/0006-custom-account-spike.md)), under `target/wasm32v1-none/release`. The shared types remain a library.

`npm run check` typechecks source, deployments and tests; builds all TS workspaces; packs the SDK, CLI and services and runs them outside the workspace; runs fast TS tests; runs Rust check, format, clippy and non-empty tests; and builds WASM. Fast checks need no network credentials. Rust and Node dependencies must be downloaded once.

## Local network

```sh
npm run build:contracts
npm run dev
npm run test:integration
npm run local:down
```

`dev` starts an isolated protocol-29 Quickstart and waits for matching RPC metadata and a serving Friendbot, which starts several seconds after RPC. It does not start the submitter; the payment flow test starts its own. Port 8000 binds only to loopback. The network is ephemeral: `local:down` removes its state. Do not use it to retain deployment evidence.

Docker must be running. If startup fails, use `docker compose ps` and `docker compose logs`. The local suite checks RPC health and protocol, deploys the Phase 1 fixture with ephemeral accounts, exercises real agent and sponsor signatures and checks a native token transfer and audit event. It also deploys the agent registry and runs its lifecycle with real controller, signer, new-signer and sponsor signatures. The verification suite deploys both registries, approves live and fixture providers, runs the verifier with an in-process metadata transport and exercises publication, sequencing, revocation, expiry and identity changes with real signatures. The sponsor suite attacks the fee sponsor with real signatures, and the payment flow test runs the built CLI and submitter as separate processes, so run `npm run build` first; it also fetches the example agent's metadata from GitHub, so it needs internet access. Vitest searches the integration/adversarial directories for `.test.ts` files and fails on empty suites.

## Configuration

`.env.example` lists non-secret values. `loadConfig` in the SDK takes an explicit environment object; it does not load `.env` implicitly. Copy the example to `.env` and use Node's `--env-file=.env` when launching future application entry points, or supply environment variables through the process manager. Do not shell-source the example: the Stellar passphrase contains spaces and punctuation.

Local mode defaults to loopback RPC and the standalone passphrase. Testnet mode defaults to the public Testnet RPC and its passphrase. A supplied passphrase/network hash must match the selected network. HTTP is permitted only for local loopback. Optional deployment addresses are validated, never invented. Public provider address, asset contract, database path and deployment epoch are separate fields. Store private keys in future signer adapters, not in this configuration.

## Explicit public-network check

```sh
RUN_TESTNET_TESTS=1 npm run test:testnet
```

This is a read-only network compatibility preflight. It is excluded from required CI and makes no transactions. Public network outages cannot invalidate fast/local acceptance.

Two suites in the same project do submit transactions. Each is skipped unless its own flag is set as well:

```sh
RUN_TESTNET_TESTS=1 RUN_TESTNET_WALLET=1 npx vitest run --project testnet tests/testnet/account-path.test.ts
RUN_TESTNET_TESTS=1 RUN_TESTNET_SPIKE=1 npx vitest run --project testnet tests/testnet/account-probe.test.ts
RUN_TESTNET_TESTS=1 RUN_TESTNET_X402=1 npx vitest run --project testnet tests/testnet/x402.test.ts
```

The first runs the smart wallet's account path ([ADR 0007](decisions/0007-account-payment-path.md)): both registries, an asset, the wallet and the demo service, then payments on both paths. The second runs the spike that preceded it ([ADR 0006](decisions/0006-custom-account-spike.md)). The third pays an x402-protected service from the wallet through the published x402 facilitator and through this project's own ([ADR 0012](decisions/0012-x402-and-payee-gate.md)). All three deploy from keys generated at runtime and funded by Friendbot, and keep none of them. They need `npm run build:contracts` first.

## Test layout

- `tests/unit`: deterministic configuration and ABI tests; SDK/service colocated tests also belong to the unit project.
- `tests/local`, `tests/integration`, `tests/adversarial`: local-network suites, with explicit execution.
- `tests/integration/payment-flow.test.ts` contacts no public host. Its variant that lets the verifier fetch the public metadata URL runs only with `RUN_ONLINE_TESTS=1`.
- `tests/browser`: the owner demo in an installed Chrome against the local network; run with `npm run test:browser` after `npm run build`.
- `tests/testnet`: opt-in public Testnet preflight.
- Rust contract tests: native Soroban host dispatch; the wrapper rejects zero discovered tests.
- `tests/fixtures`: public fixtures only; generate private test keys at runtime.

CI builds WASM in the foundation job. The Docker local-network job downloads the contract WASM and auth probe artifacts for integration tests.
