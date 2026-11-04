# Development

P0 supplies the build and test environment. P1 adds the v1 contract ABI, hash vectors and a local fixture that verifies native authorization and a sponsor-paid transfer. P2 adds the agent registry, its SDK helpers and a signed local registry flow. P3 adds the verification registry, the limited verifier CLI (`services/verifier`), the SDK verification client and a signed local verification flow. The wallet arrives in P4.

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

Alternatively install the matching Stellar CLI release binary for your OS/architecture. `npm run build:contracts` rejects a different CLI version. Contract compilation uses `stellar contract build`, which applies the SDK's required WASM processing. The build creates the four application WASM files plus the local-only auth probe under `target/wasm32v1-none/release`. The shared types remain a library.

`npm run check` typechecks source, deployments and tests; builds all TS workspaces; runs fast TS tests; runs Rust check, format, clippy and non-empty tests; and builds WASM. Fast checks need no network credentials. Rust and Node dependencies must be downloaded once.

## Local network

```sh
npm run build:contracts
npm run dev
npm run test:integration
npm run local:down
```

`dev` starts an isolated protocol-29 Quickstart and waits for matching RPC metadata and a serving Friendbot, which starts several seconds after RPC. It does not start the future application. Port 8000 binds only to loopback. The network is ephemeral: `local:down` removes its state. Do not use it to retain deployment evidence.

Docker must be running. If startup fails, use `docker compose ps` and `docker compose logs`. The local suite checks RPC health and protocol, deploys the Phase 1 fixture with ephemeral accounts, exercises real agent and sponsor signatures and checks a native token transfer and audit event. It also deploys the agent registry and runs its lifecycle with real controller, signer, new-signer and sponsor signatures. The verification suite deploys both registries, approves live and fixture providers, runs the verifier with an in-process metadata transport and exercises publication, sequencing, revocation, expiry and identity changes with real signatures. Existing planned scenarios use `.planned.ts` until executable tests replace them; Vitest searches the integration/adversarial directories for `.test.ts` files and fails on empty suites.

## Configuration

`.env.example` lists non-secret values. `loadConfig` in the SDK takes an explicit environment object; it does not load `.env` implicitly. Copy the example to `.env` and use Node's `--env-file=.env` when launching future application entry points, or supply environment variables through the process manager. Do not shell-source the example: the Stellar passphrase contains spaces and punctuation.

Local mode defaults to loopback RPC and the standalone passphrase. Testnet mode defaults to the public Testnet RPC and its passphrase. A supplied passphrase/network hash must match the selected network. HTTP is permitted only for local loopback. Optional deployment addresses are validated, never invented. Public provider address, asset contract, database path and deployment epoch are separate fields. Store private keys in future signer adapters, not in this configuration.

## Explicit public-network check

```sh
RUN_TESTNET_TESTS=1 npm run test:testnet
```

This is a read-only network compatibility preflight. It is excluded from required CI and makes no transactions. P0 has no deployment command. Public network outages cannot invalidate fast/local acceptance.

## Test layout

- `tests/unit`: deterministic configuration and ABI tests; SDK/service colocated tests also belong to the unit project.
- `tests/local`, `tests/integration`, `tests/adversarial`: local-network suites, with explicit execution.
- `tests/testnet`: opt-in public Testnet preflight.
- Rust contract tests: native Soroban host dispatch; the wrapper rejects zero discovered tests.
- `tests/fixtures`: public fixtures only; generate private test keys at runtime.

CI builds WASM in the foundation job. The Docker local-network job downloads the contract WASM and auth probe artifacts for integration tests.
