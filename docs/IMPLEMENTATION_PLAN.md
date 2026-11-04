# Repository review and implementation plan

Reviewed: 3 November 2026. Baseline: `c12bd39`.

This is a proposed implementation plan, not an implementation or deployment report. The review changed no application code, made no commits, and performed no deployment. The existing untracked statement-of-work PDF was read without modification.

## 1. Outcome and scope

Deliver a reproducible Stellar Testnet flow in which an owner funds a contract wallet, registers an agent policy, and lets the agent make a signed payment only while its identity, verification, and permissions are current. Demonstrate a permitted payment, rejected payments, pause, and confirmed revocation.

The repository is a coherent scaffold with a useful architectural specification. It does not yet contain application behavior to extend. Implementation starts with toolchains, contract interfaces, and a real signed transaction path.

### Source of requirements

- `readme.md`: proposed four grant milestones and the 5-per-payment / 20-per-day example.
- `ARCHITECTURE.md`: identity revisions, current provider results, policy enforcement, restricted execution, persistent security state, and chained audit history.
- The local four-page Instawards SOW dated 30 September 2026: three deliverables within 30 calendar days, with a working checked-agent payment, rejection examples, revocation, developer kit, demo, tests, deployment, and guide. The sprint start date is blank, so this plan uses relative days.
- `docs/DEVELOPMENT.md` and component READMEs: explicit acknowledgement that current files are placeholders.

The SOW excludes a security audit, full ERC implementations, a general consumer wallet, and unrestricted contract execution. Its requested budget is not a technical completion guarantee.

### Delivery boundaries

| Scope | Planned result | Completion claim |
| --- | --- | --- |
| 30-day SOW baseline | Two registries, limited verifier, transfer-only wallet, SDK, focused CLI, simple demo, signed tests, deployment records, basic durable history and guide | SOW deliverables 1-3, subject to passing their gates |
| Additional repository milestone work | One restricted service-contract adapter and its argument/auth tests; complete the corresponding SDK/CLI/demo flow | Required before claiming README milestone 3 in full |
| Full architecture acceptance | All listed acceptance tests, service-call integration, audit reconstruction, CI, deployment and demo evidence | Required before claiming all four README milestones complete |
| Deferred by existing architecture | Privacy proofs, entropy commit-reveal, TLS credential delegation, external identity registries, arbitrary execution | Separate designs and delivery work |

The service-contract adapter is planned below, not silently removed. If it does not fit the sprint, report that README milestone 3 and any dependent milestone 4 criteria remain incomplete. Do not relabel a transfer as a service-contract integration. Do not weaken authorization, verification, or rollback checks to meet a date.

## 2. Review findings

These are implementation gaps and design risks. There is too little executable behavior to make a meaningful runtime security assessment.

| ID | Priority | Evidence | Impact and planned response |
| --- | --- | --- | --- |
| R1 | Critical implementation gap | Every `contracts/*/src/lib.rs` is an empty library; contract manifests have no dependencies or deployable contract configuration | No callable registry or wallet exists. Add Soroban types, entry points, storage, authorization and WASM builds in P0-P4. |
| R2 | High | `packages/sdk/src/index.ts`, CLI, service and demo entry points only export empty modules | No user flow exists. Build one complete SDK-driven path before broadening interfaces in P5-P7. |
| R3 | High | `tests/integration/*.test.ts` and `tests/adversarial/*.test.ts` are placeholders; root scripts have no test command; all workspace TS configs include only `src/**/*.ts` | A green build provides no authorization evidence. Add real Rust tests, an explicit root TS test project and signed local-network integration tests. |
| R4 | High design risk | `ARCHITECTURE.md`, action execution section; `contracts/smart-wallet/src/authorization.rs` and `packages/sdk/src/actions.ts` are empty | Exact signing scope, sponsor separation, invocation trees and retry semantics are undecided. Prove native Soroban authorization in P1 before developing the wallet. |
| R5 | High design risk | Verification design names latest results and identity revisions, but all registry modules are empty | Publication ordering, provider approval, disabling, stale revisions, and revocation could otherwise permit stale authority. Define their state machines in P2-P3. |
| R6 | High delivery risk | The SOW is 30 days; README/architecture also expect a restricted contract integration and verifiable history | Track SOW completion and full repository milestones separately. Use the scope table and release gates below. |
| R7 | Medium | No Node/toolchain pin, npm lockfile, CI workflow, Stellar SDK, Soroban SDK, browser bundler, or service startup commands | Builds are not yet reproducible from a clean checkout. Establish these in P0; do not interpret global tools as installed project dependencies. |
| R8 | Medium design risk | Wallet storage, audit modules, indexer storage and deployment records are placeholders | TTL/restoration, event retention, canonical hashes and reset recovery need explicit implementation. Address in P1, P4, P6 and P8. |
| R9 | Local credential hygiene | Local Git remote configuration embeds an authentication token; this is outside tracked source | Rotate the token and replace URL-based credentials with a credential manager. Do not copy the URL into docs, logs or deployment records. No remote configuration was changed by this review. |

### Baseline validation

| Command | Observed result | What it establishes |
| --- | --- | --- |
| `npm run typecheck` | Passed across all six TS workspaces | Placeholder source typechecks |
| `npm run build` | Passed across all six TS workspaces | Empty modules emit successfully |
| `cargo check --workspace --locked --offline` | Passed | Five empty Rust libraries compile |
| `cargo fmt --all -- --check` | Passed | Existing Rust formatting is valid |
| `cargo test --workspace --locked --offline` | Passed; zero unit tests and zero doc tests | No behavioral coverage exists |
| `git diff --check` | Passed before plan authoring | No existing tracked whitespace errors |

The installed global TypeScript compiler is 5.4.4, matching the manifest, but `npm install`/`npm ci` was not performed. Node is 25.2.1 and Rust is 1.98.0 in this environment; neither is pinned by the repository. The Stellar CLI is absent from PATH. Native Rust tests emitted macOS SDK/cache warnings, but completed successfully. No WASM, local-network, browser, or Testnet workflow could be validated from this scaffold.

## 3. Proposed implementation decisions

Record these as short architecture decision records in P0-P1. They are proposed defaults rather than existing functionality.

### Contract and account model

- Keep `agent-registry` and `verification-registry` separate as the repository intends. A wallet is one dedicated contract instance per owner, referencing fixed registry addresses supplied at construction.
- Initialize ownership and registry references atomically through `__constructor`; do not expose a public initialization race. Require the owner's authorization for creation with those arguments and test deployment/auth behavior on the selected SDK.
- Use immutable contract code for this Testnet release: no upgrade entry point or authority that can bypass policies. Changes produce a new deployment manifest and require explicit owner action to fund/use the new wallet.
- Start with standard Stellar account signers and native `Address::require_auth()` on complete entry-point arguments. Do not add custom message signatures or a wallet `__check_auth` interface for the first release. The wallet is accessed through explicit execution methods, not as an unrestricted signer for other contracts.
- Keep the owner, agent controller, agent signer, verifier publisher and fee sponsor as separate roles, including in tests. A sponsor has no policy, verification, withdrawal or agent-signing authority.

Native Soroban authorization binds an invocation and its arguments. The SDK also signs network-specific authorization entries with bounded ledger validity; the wallet's policy sequence and deadline enforce application ordering and freshness. See [Stellar auth documentation](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/auth) and the official [authorization-entry implementation](https://stellar.github.io/js-stellar-base/auth.js.html).

### Versioned data and canonical encoding

Add shared action and audit modules alongside the existing shared types. Use `#[contracttype]` and stable `#[contracterror]` values. Proposed v1 records:

| Record | Required fields and rules |
| --- | --- |
| `AgentIdentity` | Registry-assigned ID, controller address, signer address, metadata URI, SHA-256 hash of exact metadata bytes, monotonically increasing revision, disabled status |
| `VerificationResult` | Agent ID/revision, provider address, provider-scoped publication sequence, schema version, check outcomes and optional per-check scores, overall risk score, serious-wallet-risk flags, evidence hash, issued/expiry timestamps, revoked flag |
| `Policy` | Schema version, owner-chosen unique policy ID, agent ID/revision/signer, trusted provider, required checks, maximum age/risk, per-asset limits, recipient allow/block lists, activation/expiry, permitted action kinds and restricted adapter rules |
| `PolicyState` | Policy hash, irrevocable revoked status, next application sequence, current UTC day and per-asset daily spending |
| `ActionRequest` | Schema version, wallet address, policy hash, next policy sequence, deadline, typed action: `Transfer { asset, recipient, amount }` or the later restricted `ServicePayment` |
| `AuditEntry` | Schema version, wallet, audit sequence, previous hash, ledger/time, event kind, actor, policy/action hashes and outcome-specific payload |

- Amounts use positive checked `i128` contract units and TypeScript `bigint`. JSON interfaces use decimal strings, never floating-point numbers for amounts. Reject zero, negative, overflow and excessive fractional precision.
- Hash canonical XDR-encoded contract values with SHA-256 and an explicit version/purpose domain. Include network ID and wallet address in policy/action domains. Do not hash JSON serialization or display strings. Add identical Rust/TS golden vectors before funds move.
- Define exclusive ends: `valid_after <= ledger_time < valid_until`; action validity is `ledger_time < deadline`. Enforce provider expiry and maximum age independently. Document ledger-number authorization expiry separately from timestamp deadlines.
- Bound all collections, metadata URI sizes, evidence payloads and event fields. Initial proposed caps: four assets, 32 allowed recipients, 32 blocked recipients, eight check kinds and a 2 KiB metadata URI; measure worst-case cost in P1 and adjust before freezing v1.
- Normalize set-like policy fields to a deterministic sorted order and reject duplicates. Keep mutable counters/revocation outside the immutable policy hash. Reject reuse of an existing policy ID, including a revoked one.

### Identity and verification semantics

- Registration requires controller authorization and signer proof of control. Updates require controller authorization; signer replacement also requires the new signer's authorization. Signer or metadata changes increment the identity revision and require fresh verification and a new owner-approved policy. Disable/reactivate transitions also invalidate prior authority; no silent revival of an old policy.
- A constructor-appointed registry admin approves/disables providers. Publication requires the provider address's native authorization. Owners still select their trusted approved provider in each policy. Disabling a provider immediately blocks its results, even if their timestamps remain valid.
- Store the latest result pointer per `(agent_id, revision, provider)` and reject unexpected publication sequences. A provider-authenticated newer failure becomes authoritative immediately. Read APIs may expose past results, but execution must never accept a caller-selected historical pass.
- Revocation is terminal for an individual result. Only a fresh, higher-sequence assessment may supersede it. Reject old revisions, future issue times, invalid score ranges, duplicate check kinds, expiry at/before issue time, and issue times moving backwards.
- Use explicit outcomes `Passed`, `Failed`, `Inconclusive`, `NotApplicable`, and `Unsupported`. A policy-required check must be `Passed`; unsupported, absent, inconclusive and not-applicable required checks deny execution. Serious wallet-risk flags deny execution independently of the aggregate score.
- Define and test scoring once: the integer ceiling of the mean of scored, applicable checks. Keep unscored checks visibly unscored; deny if a policy has no usable required assessment. Validate the aggregate against supplied scored outcomes in the registry. Never turn missing coverage into zero-risk passes.
- First provider integration is the project's own approved verifier, running real metadata-hash, endpoint HTTPS/TLS/availability, and Stellar signer-account/history checks. These are limited checks, not complete web vulnerability or wallet threat assessments. Threat-feed, token, media and code analysis remain explicitly unsupported unless a real adapter is implemented.
- Metadata integrity and an existing wallet do not establish safe agent behavior. Separate real limited assessments from simulated risk fixtures in schemas, reports and UI; use separate configured provider identities for fixtures. The production demo policy must not treat a fixture-only provider as an independent assessment.

Publish an ERC-to-Stellar coverage matrix. This release adapts identity resolution, provider results, current verification, risk thresholds, limited execution and hash-linked events. It does not claim full [ERC-8126](https://eips.ethereum.org/EIPS/eip-8126) or [ERC-8196](https://eips.ethereum.org/EIPS/eip-8196) compliance; privacy proofs and other omitted requirements remain visible.

### Wallet invariants

1. Only the owner creates/replaces/revokes policies, pauses/resumes agent execution and withdraws assets. Owner withdrawal remains available while agent execution is paused or verification is unavailable.
2. Execution authenticates the registered policy signer for the entire exact request, then compares the live identity and current provider result with the stored policy. Never rely on SDK prechecks for enforcement.
3. Empty allowlists allow nothing. Explicit blocks override allows. Enforce asset, recipient, action kind, adapter target and method/argument restrictions independently.
4. Per-transaction and daily caps are per asset and policy. UTC day is `ledger_timestamp / 86400`. Budgets do not combine different assets or use exchange rates. Multiple policies add exposure; replacing a policy grants a fresh budget and the owner interface must show that consequence.
5. Execution requires the exact next policy sequence. A successful action increments it once. Requests signed before revocation, identity change or a newer failing assessment fail against live state.
6. Update sequence and budget state before the downstream call, but let a downstream failure abort the entire invocation. Do not catch a failed call and return success or a committed error value after partial mutation. Assert token balances, counters, sequences and audit head all roll back together.
7. Use a fixed supported asset contract with known behavior for the demo. Do not assume that any contract claiming a token ABI has trustworthy accounting or immutable behavior.
8. Policy revocation, sequences, budgets and audit heads must survive archival/restoration. A missing security record is an error, not a reason to reconstruct an active default. Never delete revocation tombstones to reclaim storage.

Use instance storage for bounded wallet configuration and persistent entries for identities, results, individual policies and policy state. Avoid unbounded global vectors. Extend touched data/code lifetimes and support simulation-populated restoration. Protocol 23+ restoration still requires the transaction to include the necessary archived entries; see [Stellar state archival](https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival).

## 4. Implementation work packages

Dependencies: `P0 -> P1 -> P2/P3 -> P4 -> P5 -> P6/P7 -> P8`. P3 depends on P2's identity ABI. Minimal SDK helpers and tests should be added as each contract lands. P9 follows the proven transfer path; full milestone completion depends on it.

### P0. Reproducible foundation and requirements (days 1-2)

**Files:** root manifests/configuration; all workspace manifests; `docs/DEVELOPMENT.md`; new `.github/workflows/ci.yml`, root test configuration, `.env.example`, toolchain pins and `docs/decisions/`.

- Select and pin mutually compatible Soroban SDK, Stellar JS SDK, Stellar CLI, Rust and supported Node LTS versions against the target Testnet protocol. Check actual release compatibility; do not pick unrelated latest versions. Generate an npm lockfile and update `Cargo.lock` during implementation.
- Configure deployable contracts as WASM contract crates and keep shared types a normal Rust library. Add workspace dependencies and appropriate test features; configure release overflow checks and the SDK-recommended WASM profile/target.
- Add a root TS test project covering `tests/**`, service/SDK tests and fixtures. Use a pinned test runner, preferably Vitest, with separate fast, local-network and explicitly invoked Testnet suites.
- Add scripts for typecheck, TS build, Rust check/test/format/clippy, contract WASM build, local-network setup, integration tests and developer startup. CI must fail when expected test suites discover zero cases.
- Select a pinned local Stellar Quickstart environment for real signing tests. Define non-secret configuration for network passphrase/ID, RPC URL, registry/wallet IDs, provider public address, test asset, database path and deployment epoch.
- Create `docs/REQUIREMENTS.md` mapping each SOW/README/architecture acceptance statement to test IDs and evidence. Record the decisions from section 3. Track R9 separately without recording the credential value.

**Gate:** a clean checkout can install locked dependencies, run non-empty tests and build a minimal deployable contract in CI. No deployment secrets are required for fast CI.

### P1. ABI, hashes, authorization and resource spike (days 2-3)

**Files:** `contracts/shared-types/src/{identity,attestation,policy,errors}.rs`; new `action.rs`, `audit.rs`; `packages/sdk/src/types.ts`, `actions.ts`; new test-vector fixtures and a tiny auth test contract/harness.

- Implement v1 records, error codes, domain separation and Rust/TS serialization vectors. Define event schemas before indexer work.
- Demonstrate owner, agent and fee sponsor as distinct accounts on the local network. Sign a simulated authorization entry for the exact wallet invocation, attach it to a sponsor-signed transaction, submit and confirm success.
- Prove mutation of amount, recipient, policy hash, sequence, deadline, wallet or network fails. Prove a sponsor alone cannot authorize an action. Exercise auth-entry expiry and network mismatch using real signatures.
- Prove direct wallet-to-token transfer authorization. Separately document the deeper invocation authorization needed for the future service adapter. Native invoker auth and explicit deeper-call authorization have different scopes; see [Stellar's composable auth model](https://stellar.org/blog/foundation-news/stellars-composable-auth-model).
- Measure representative and maximum proposed policy/check payload sizes, event sizes, resource fees and execution cost against target-network limits. Fix collection caps before freezing the interface.

**Gate:** a real separately sponsored signed call works; the mutation matrix fails as expected; both languages produce identical policy/action/audit hashes. If this gate fails, resolve the signing model before adding more wallet features.

### P2. Agent registry (days 3-5)

**Files:** `contracts/agent-registry/src/{lib,identity,storage,events}.rs`; Rust tests; `packages/sdk/src/agents.ts`; `tests/integration/agent-flow.test.ts`.

- Add registration, lookup, metadata update, signer rotation and disable/reactivate entry points. Allocate IDs with a bounded checked counter; store each identity independently.
- Enforce role authorization and signer proof, validate bounded URI/hash input, and implement revision transitions. Controller transfer is deferred; do not expose an incomplete transfer function.
- Emit versioned lifecycle events and extend touched state TTL. Include replay/revision behavior in read responses.
- Add fixtures that generate private keys only at test runtime. Public example metadata contains no secrets and states its test purpose.

**Gate:** real signed registration/readback works. Unauthorized updates and malformed metadata fail. A metadata/signing change increments the revision and makes old verification/policies unusable in later integration tests.

### P3. Verification registry and limited verifier (days 5-7)

**Files:** `contracts/verification-registry/src/{lib,provider,attestation,storage}.rs`; `services/verifier/src/{index,metadata,checks,attestations}.ts`; `packages/sdk/src/verification.ts`; coverage/scoring docs and tests.

- Implement provider approval/disable, authenticated publication, current-result lookup and result revocation with the sequencing rules above. The registry validates the live agent revision.
- Implement metadata retrieval against registered URI/hash only. Hash original bytes before parsing, validate a versioned JSON schema, enforce body/time limits, and protect every request/redirect against private/link-local addresses and DNS rebinding. Keep TLS verification enabled. Verification must not execute fetched code or conduct intrusive scans.
- Implement explicit partial-coverage check adapters. Persist a content-addressed detailed report before publishing its evidence hash; expose a report reference to the developer. Handle publication failure without losing the report or duplicating result sequences.
- Make verifier execution an explicit CLI/process job initially. Keep the publisher key outside browser code and public configuration. Retry publication only after checking whether the previous transaction committed.
- Add deterministic failing/stale/revoked/high-risk fixtures under a clearly marked test provider, not as fabricated real risk findings.

**Gate / SOW deliverable 1:** after passing local signed tests, perform an initial Testnet registration and real limited assessment/readback, recording IDs and transaction links. Reject unauthorized publication, provider disabling, wrong revisions, out-of-order results, malformed scores, expiry and revocation. This is a development checkpoint, not the final deployment.

### P4. Custody wallet and policy-controlled transfers (days 8-14)

**Files:** `contracts/smart-wallet/src/{lib,storage,authorization,policy,execution,audit}.rs`; shared types; SDK policy/action helpers; Rust tests and `tests/adversarial/{authorization,limits}.test.ts`.

- Add owner-authorized construction, balance lookup, funding convenience method, withdrawal, policy approval/replacement/revocation, pause/resume, policy state lookup and `execute(ActionRequest)`. Direct token funding remains possible; balance is read from the asset contract.
- `fund` authenticates the funder for the exact transfer into the wallet. It creates no spending permission. Configure test issuer/trustlines and Stellar Asset Contract behavior in the harness.
- Implement structural policy validation and atomic replacement: revoke the old policy and approve a new unique one in one transaction. Show fresh budget and aggregate policy exposure to the owner.
- Implement exact signer authorization, live identity/provider checks, all transfer restrictions, UTC budgets, sequence/deadline checks, checked arithmetic and terminal revocation.
- Implement successful owner/action audit entries. Canonically hash entries without transaction hash, which is not available as an execution input; the indexer attaches transaction metadata separately. Store only the audit head/sequence on-chain, with a defined genesis hash.
- Advance security state before the token call and propagate any downstream failure. Add a failing asset/test contract so rollback is tested after state mutation would have occurred.
- Implement TTL extension on touched instance/code/persistent data. Add restoration tests on the selected local-network version and maintenance instructions; ensure restored revocation and same-day spending remain effective.

**Gate / SOW deliverable 2:** a signed 3-unit payment under a 5-per-payment, 20-per-UTC-day, seven-day policy succeeds. Over-limit, unapproved-recipient and post-revocation payments fail. All wallet security cases in section 5 pass, including rollback of balances, counters, sequence and audit head. No UI is needed to establish this gate.

### P5. SDK, transaction pipeline and focused CLI (days 15-18)

**Files:** all `packages/sdk/src/*`; all `packages/cli/src/*`; `services/submitter/src/{index,simulation,submission}.ts`; package exports/bin metadata; examples and integration tests.

- Generate contract bindings from pinned WASM specs where supported, then provide stable domain wrappers. Export the public SDK API; declare actual workspace dependencies, build order and package entry points. Test importing the built SDK from an external sample.
- Define signer interfaces for owner transactions, agent authorization entries, provider publication and fee sponsorship. Support browser owner wallets through an adapter; keep headless agent/provider keys outside the browser and SDK library defaults.
- Implement read, build, simulate, inspect authorization, sign, assemble, submit and poll stages. The signer must validate the expected invocation tree and every economic field before signing simulated entries.
- Keep the reusable transaction pipeline in the SDK; `submitter` is a thin process adapter. Start with a configured private/demo sponsor, not an open public fee relay. Enforce configured networks/contracts, fee ceilings, timeouts and sponsor request limits.
- Serialize or reserve sponsor source-account sequence use. Persist submitted transaction hashes, signed XDR and request status without private keys. On timeout, query the known hash before rebuilding; after definitive expiry/rejection, refresh policy state, resimulate and obtain fresh authorization. Never blindly retry an action with a new sequence.
- Decode contract errors into stable actionable messages. Distinguish simulation rejection, submitted/pending, confirmed success, confirmed failure and unknown status. Keep timestamp and ledger-expiry validation separate.
- Add CLI commands for `agent register/show/update/rotate`, `verify run/show/revoke`, `wallet create/fund/balance/withdraw/pause/resume`, `policy approve/show/revoke/replace`, `execute transfer`, and `history`. Support machine-readable JSON, dry-run/simulation, nonzero failure codes and key references rather than secret command-line arguments.
- Add `examples/payment-flow.ts`: registration -> real verification -> wallet funding -> owner policy -> agent payment -> owner revocation -> rejected previously signed request. Provide a runnable invocation and named configuration.

**Gate:** a fresh-checkout CLI example completes the whole transfer flow with real local-network signatures and separate roles. The sponsor cannot mutate the action or gain authority. Unknown transaction status never appears as success or causes an automatic duplicate payment.

### P6. Durable history and audit verification (days 18-20)

**Files:** `services/indexer/src/{index,events,storage,audit}.ts`; `packages/sdk/src/history.ts`; new database migrations and indexer tests.

- Use SQLite for the single-instance demo with a persistent disk and explicit migrations. Add transactionally stored raw events, normalized audit entries, transaction attempts and per-network/deployment cursors. A multi-instance production database is later work.
- Ingest from the deployment start ledger, paginate with opaque cursors, deduplicate by network/deployment/event ID, and save a cursor only in the same database transaction as its events. Decode only known versioned contract schemas; quarantine unknown versions.
- Recompute each wallet's audit chain in ledger/transaction/event order and compare the head and sequence at the same ledger snapshot. If reads and ingestion cover different ledgers, report syncing and retry rather than a false mismatch. Test altered, missing, duplicate and reordered entries.
- Keep rejected simulations/failed transactions in a separate attempts table. They are operational observations, not committed wallet audit entries. Show an unknown failure reason when diagnostic detail is unavailable.
- Expose only the history/status reads needed by the demo with schema validation and stable pagination. Add health, ingestion-lag, retention-gap and audit-mismatch status.
- Detect an RPC retention gap using its advertised oldest ledger. Stop claiming complete history and require an archival source, backup or explicit incomplete checkpoint; a hash chain detects missing data but cannot recover it. Stellar RPC event history is bounded, so ongoing ingestion and database backup are required. See [getEvents](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents).

**Gate:** restart and duplicate ingestion preserve counts; interrupted ingestion loses no cursor-covered data; reconstructed history matches the on-chain head; missing history is visibly incomplete.

### P7. Focused owner demo (days 20-23)

**Files:** `apps/demo/src/{index,app}.ts`, existing view modules, new browser entry/config/styles and UI tests.

- Add a minimal Vite + TypeScript application. Keep the existing view boundaries; a larger UI framework is optional and not required for the payment demonstration. Configure browser/DOM types separately from Node service packages.
- Connect an owner wallet using a Stellar wallet adapter; verify the selected network and account. Never request an owner seed in the UI. Run agent/verifier/sponsor signing in separately configured demo processes, exposing only narrowly scoped demo operations.
- Agent view: signer/controller, revision, metadata hash, trusted provider, coverage limitations, latest result, age/expiry and fixture labels. Wallet view: network, exact test asset/issuer/contract, decimals, balance, funding and owner withdrawal.
- Policy view: plain-language 5/20/seven-day permission, allowed and blocked destinations, maximum risk/age, total exposure across policies, explicit approval, pause and revocation. Clearly show the difference between submitting revocation and confirmed revocation.
- History view: confirmed transfers, pending/failed attempts, source transaction links and audit completeness. Rejections display the rule that blocked execution; they do not invent committed contract events.
- Provide repeatable buttons/scripts for one allowed payment, over-limit, unknown recipient, daily-limit, pause and post-revocation cases. Use independent/reset fixtures so an earlier failure or spend does not accidentally mask the intended rejection.
- Add a browser smoke test for connection, read state, policy approval, allowed/rejected outcomes and revocation. Cover loading, network mismatch, expired verification and unknown transaction state.

**Gate:** a developer follows the guide to run the demo; the owner approves one policy and stops agent access; the UI accurately reports confirmed and rejected outcomes without exposing signing secrets.

### P8. Final Testnet release and evidence (days 24-27; days 28-30 reserved)

**Files:** `deployments/testnet/{deploy,addresses}.ts`; versioned deployment manifests; `readme.md`, `docs/DEVELOPMENT.md`; new setup, operations, threat-model and evidence docs; CI workflows.

- Deploy only after fast and local signed acceptance suites pass. Use pinned contract artifacts and an idempotent script: inspect an existing deployment before retrying; never overwrite evidence from a different deployment.
- Deploy agent registry -> verification registry -> approve provider -> test asset/SAC setup -> wallet with immutable references. Add demo-service only when P9 passes. Use deployment-specific salts/epochs and record the actual order and constructor values.
- Record network/passphrase hash, protocol/tool versions, source baseline identifier plus working-tree/artifact hash, WASM hashes, contract IDs, public role addresses, test asset identity/decimals, creation ledger, transaction hashes and explorer links. Do not claim an uncommitted tree is represented by the baseline Git commit alone.
- Initialize the indexer at deployment, fund known test accounts/wallet, publish real limited assessment and run the acceptance scenario. Verify every manifest address/readback against the network.
- Capture one successful payment and the three SOW-required rejections: over-limit, unknown recipient, after confirmed revocation. Include test results, screenshots/recording and direct transaction links where a transaction was actually submitted. Simulation-only failures receive captured diagnostics, not fabricated transaction links; use signed failed submissions for the core rejection evidence where possible.
- Document setup from a clean checkout, key roles, supported coverage, error meanings, maintenance/restoration, database backup/retention recovery and Testnet reset/redeployment. Clearly identify the test asset and the absence of a security audit.
- Keep deterministic/local suites in required CI. Make public Testnet checks explicit scheduled/manual jobs with isolated secrets and retained artifacts; avoid making merge checks depend on public faucet/RPC uptime.

**Gate / SOW deliverable 3:** reviewer can use the SDK/CLI/demo, inspect real contract IDs and evidence, reproduce all required cases and follow the setup guide. All SOW requirements map to passing tests or concrete evidence. Full repository milestone status is reported separately.

### P9. Restricted service-contract adapter (after P4-P5; estimated 2-4 engineering days)

**Files:** `contracts/demo-service/src/{lib,service}.rs`; wallet typed action/adapter rules; SDK/CLI service commands; integration/adversarial tests and demo example.

- Define a single versioned `pay_for_service(wallet, asset, recipient, amount, service_id)` interface with bounded service IDs and fixed payment semantics. The wallet validates exact asset, recipient, amount, target and method; the service validates its configured recipient/price and requests wallet authorization.
- Authorize only the precise deeper token-transfer invocation needed by that service call, using native contract-invoker authorization where appropriate. Do not allow caller-supplied arbitrary symbols, `Vec<Val>` invocation payloads, approvals or arbitrary authorization trees.
- Charge the same per-policy/per-asset budget as transfers. Bind all service arguments into the agent's action authorization and audit entry. Require exact expected return semantics and abort the transaction on downstream failure.
- Test an allowed call, unsupported method, altered arguments/price/recipient, wrong asset, extra downstream debit, unauthorized direct wallet debit and complete rollback on failure. Prevent using the adapter path to bypass direct-transfer recipient restrictions.
- Add one SDK example/CLI command and recorded Testnet service transaction, then update milestone 3 evidence.

**Gate:** the restricted call succeeds with a real agent signature; every unsupported invocation is rejected and all spending/audit invariants remain true. Only then mark the service integration complete.

## 5. Required acceptance matrix

Rust contract tests exercise state and boundary behavior. TS tests exercise encoding, SDK/services/CLI. Local-network integration tests use real account signatures for authorization-sensitive cases; mocked auth is acceptable for isolated policy arithmetic tests, not as the sole proof of access control.

| ID | Case | Required evidence |
| --- | --- | --- |
| A01 | Register/read identity; unauthorized update; new signer proof | Registry tests plus signed integration |
| A02 | Metadata/key/disable revision changes | Old verification and already signed old-policy requests fail |
| A03 | Unapproved/disabled/wrong provider; unauthorized publish/revoke | Registry and signed authorization tests |
| A04 | Current result, expiry boundary, stale age, future issue time | Ledger-time-controlled contract tests |
| A05 | New failure replaces pass; revoked result; old publication sequence | No fallback to an older passing result |
| A06 | Required unsupported/absent/inconclusive/not-applicable check | All deny; actual unsupported coverage visible |
| A07 | Risk at threshold/above threshold; serious wallet-risk flag | Boundary passes/fails; flag blocks regardless of average |
| A08 | Unauthorized policy/withdraw/pause/resume/replacement | Distinct roles; sponsor and agent cannot act as owner |
| A09 | Fund and withdraw while agents paused | Exact balance changes; funding grants no authority |
| A10 | Allowed signed 3-unit transfer | Recipient/wallet balances, budget, sequence and audit increment once |
| A11 | Invalid/missing signature, mutated fields, wrong wallet/network | Real signed entry mutation matrix rejects every case |
| A12 | Same auth replay, duplicate action with fresh auth, wrong application sequence | One committed action; no double spending |
| A13 | Authorization ledger expiry, action deadline, policy start/end | Separate exact-boundary tests |
| A14 | Empty allowlists, unapproved asset/recipient, explicit block override | Fail closed in contract, independent of SDK |
| A15 | Per-transfer cap; zero/negative/overflow amounts | Exact cap accepted; above cap and malformed amounts rejected |
| A16 | Cumulative daily cap, independent assets/policies, UTC rollover | Exact limit and midnight boundaries; no cross-asset arithmetic |
| A17 | Multiple pending requests near a cap or with the same sequence | Final total never exceeds cap; one winner per sequence |
| A18 | Pause then resume; terminal revocation; revoked policy-ID reuse | Resume restores only eligible policies; revocation stays effective |
| A19 | Request signed before confirmed revocation/provider failure/identity update | Later execution blocked against live state |
| A20 | Failed token/service call after provisional accounting | Balances, budgets, sequence and audit head unchanged |
| A21 | Archived/restored policy, counters, revocation, result and contract | No budget reset or permission resurrection; expired items still fail |
| A22 | Policy replacement and additive owner exposure | Old policy revoked atomically; new budget explicit |
| A23 | Rust/TS encoding, large integers, collection bounds | Golden hashes, exact decimal conversion, resource-bound tests |
| A24 | Sponsor tampering, sequence collision, uncertain submission/retry | No authority gain or duplicate committed action |
| A25 | Metadata hash mismatch, redirects/private IP, timeout/oversized body | Verifier input tests; no unsafe fetch accepted |
| A26 | Index restart/duplicates/crash/cursor transaction | Durable, idempotent event history |
| A27 | Audit mutation/missing entries/retention gap | Correct mismatch or incomplete status; no false completeness |
| A28 | Clean checkout SDK import/CLI example/browser smoke | Full verify -> authorize -> execute -> revoke workflow |
| A29 | Testnet SOW scenario and deployment/readback | Contract IDs, real transaction/result evidence and guide |
| A30 | Restricted service call and all argument/auth bypass attempts | P9 tests plus actual service-call evidence for milestone 3 |

Include seeded property tests for budget accounting, monotonic revisions/publications/sequences, terminal revocation and hash determinism. Test behavior through public contract/client APIs rather than duplicating private implementation logic. Check representative resource budgets after each ABI change.

## 6. Schedule, gates and risk management

The 30-day schedule assumes one engineer with working Soroban/TypeScript experience, a narrowly scoped demo, and no external provider procurement. It is an aggressive delivery target, not an estimate for a production wallet.

| Calendar days | Primary work | Exit evidence |
| --- | --- | --- |
| 1-3 | P0-P1: reproducible build, interfaces, real sponsor/agent auth spike | Non-empty CI, matching hash vectors, signed call and tamper failures |
| 4-7 | P2-P3: identity and verification | First Testnet registry/result checkpoint; local tests already pass |
| 8-14 | P4: wallet and rejection/rollback tests | Signed allowed payment and complete wallet acceptance gate |
| 15-18 | P5: SDK, transaction pipeline, CLI | Reproducible transfer/revocation example |
| 19-20 | P6: durable history | Restart-safe indexing and verified audit head |
| 21-23 | P7: simple demo | Accurate end-to-end browser walkthrough |
| 24-27 | P8: final Testnet release, documentation and evidence | SOW acceptance bundle |
| 28-30 | Defect correction and reproducibility buffer | Clean-checkout rerun and final evidence review |

P9 may start after P5 only if the signed wallet gate is already stable and release buffer remains protected. Otherwise schedule it immediately after the SOW baseline, with full milestone 3/4 acceptance still open. Do not count the same day's capacity twice to make the plan appear to fit.

| Risk | Early trigger | Response |
| --- | --- | --- |
| Native authorization or wallet adapter mismatch | P1 cannot sign/replay-protect the exact request | Resolve before broader contracts/UI; retain the simplest native account signer model |
| Scope exceeds sprint capacity | Registry gate slips past day 7 or wallet gate past day 14 | Reduce UI polish and hosted service surface; retain core safety tests; explicitly defer P9 if needed |
| Limited verifier coverage mistaken for safety | Unsupported checks rendered as pass or generic verified badge | Expose check-by-check coverage and provider trust; block unsupported required checks |
| Storage restoration or event gap | Archived access fails or ingestion falls outside retention | Re-simulate restoration; preserve security state; restore index backup/archive or report incomplete history |
| Public Testnet reset/RPC outage | Deployment IDs disappear or retained ledger window changes | Version deployment epochs; redeploy documented artifacts; keep deterministic CI independent |
| Sponsor retry ambiguity | Submitted transaction status unknown | Persist/query existing hash; wait for definitive outcome/expiry before rebuilding |
| Unsafe demo keys/fee relay | Private key enters frontend or unrestricted sponsor endpoint | Separate headless signing processes; narrow operations/contracts/fees; retain key references only |

## 7. Definition of done and handoff

- SOW requirements map to concrete evidence; every corresponding automated test is executable and passes. No placeholder test is counted as coverage.
- Contracts build to deployable WASM; SDK package imports and CLI commands work from a clean checkout; demo uses those same public workflows.
- Owner and agent sign independently. No owner secret is shared with agent, verifier, sponsor or frontend. Sponsor fees grant no spending authority.
- The full negative matrix is enforced on-chain. A failing downstream call leaves no partial security or balance state.
- Current identity and provider status are checked at execution; revoked and expired permissions cannot return through retries or restoration.
- History is either verifiably complete for the advertised range or explicitly marked incomplete; rejected attempts remain separate from committed events.
- Final Testnet manifest, setup guide, test results, transaction evidence and short recording are present and reproducible. Supported verification coverage and deferred EIP features are stated accurately.
- Full README milestone completion additionally requires P9 and all remaining architecture acceptance cases. Record actual status rather than implying SOW completion proves the broader architecture is finished.

### First implementation session

1. Resolve local Git credential hygiene without recording its value.
2. Add requirements/decision records and select a compatible pinned toolchain.
3. Add locked dependency installation, deployable contract configuration and non-empty CI/test wiring.
4. Implement shared v1 types and canonical vectors, then prove the distinct agent/sponsor signed invocation on the local network.
5. Begin the agent registry only after the authorization and ABI gate is passing.

This review ends with the plan. Implementation, deployment and any future source-control commits are separate work; no commit was created or staged here.
