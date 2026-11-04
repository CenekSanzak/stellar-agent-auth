# P3 validation

On 2026-11-04, `npm run check` passed:

- 319 TypeScript unit tests in seven files;
- 43 Rust tests: 23 verification registry, 14 agent registry, 3 shared-types attestation, and one each for the ABI vectors, metadata validation and the auth probe;
- five WASM builds with the pinned Stellar CLI 30.0.1.

The typecheck, Rust format check and clippy with warnings denied also passed. On a freshly started protocol 29 Quickstart, the local suite passed 24 tests in four files: 12 verification registry tests plus the P1 and P2 suites. A second run on a new network also passed all 24.

To reproduce, run `npm run check` and start the network with `npm run dev`. Then run `npm run test:integration -- --disableConsoleIntercept` to print the resource measurements, and remove the network with `npm run local:down`. Every role key is generated at runtime and funded by the local Friendbot: admin, live provider, fixture provider, controller, agent signer, sponsor and attacker. No key material is committed. Nothing was deployed to a public network.

The validated tree is uncommitted P3 work on top of 5e91f1e. The verification registry WASM is 16,352 bytes, with SHA-256 `8a5a342b6bd48fb1d0953fe88ff0dd0864c54eff1a59ce3f9a774db503c91c02`. It exports the ten entry points and constructor in [ADR 0004](decisions/0004-verification-registry.md). The agent registry WASM is now 8,632 bytes, with SHA-256 `1acf5293f85810204aa4153f5701406523d7d8e1dd77e0957c7b4b19cf4bb8aa`. That is one byte smaller than in P2, because the account check moved into shared-types; its 14 host tests and 10 local tests pass unchanged.

## Host tests

The 23 host tests run the verification registry against a real `AgentRegistry` instance with controlled ledger time:

- **Constructor and providers:**
  - the constructor binding, and the exact recorded admin authorization of the constructor;
  - rejection of an account as the agent registry;
  - admin-only approval and disabling, checked with enforcing mocks against the attacker, candidate and provider;
  - mode binding, terminal disabling, and the `Duplicate`, `Revoked` and `NotFound` transitions.
- **Publication:**
  - only the named provider can publish, and an unapproved or disabled provider and a mode mismatch fail;
  - a 19-case matrix covers every publication rule, plus the passing one-second-validity and ceiling-of-34 boundaries;
  - live identity revisions only;
  - exact-next sequences and non-decreasing issue times, with overflow at `u64::MAX`.
- **Supersession:** a newer failure replaces a pass, and revocation is terminal, provider-only and latest-only.
- **`check` requirements:**
  - expiry at `expires_at`, and the maximum-age boundary;
  - each non-passing required outcome;
  - the risk threshold boundary, serious flags, and an absent aggregate;
  - requirement validation.
- **Fail-closed behaviour:** an agent registry that answers with the wrong revision, or that lacks `current`, causes a denial.
- **TTL extension** on every touched entry.

Three shared-types tests cover the scoring rounding, requirement bounds, and the account and contract address checks.

## TypeScript tests

- **`tests/unit/verification.test.ts`, 64 tests:**
  - scoring, and the same publication and evaluation matrices as the contract, with the same error codes;
  - strict decoding of results and provider records, including missing, reordered and retyped fields;
  - argument encoding and SDK prechecks;
  - authorization signing, which never calls the signer for a mutated sequence, another contract, a read-only method, an over-long expiry, or a result or revocation naming another provider;
  - decoded reads and error mapping.
- **`tests/unit/verifier-net.test.ts`, 115 tests:**
  - IPv4 and IPv6 special-range boundaries, including IPv4-mapped addresses, zone IDs and documentation ranges;
  - URL rules;
  - DNS answers with any private address;
  - redirect revalidation;
  - DNS rebinding: the transport only ever receives vetted addresses;
  - one deadline across hops, caller aborts and exact body limits.
- **`tests/unit/verifier-metadata.test.ts`, 41 tests:**
  - hashing before parsing (a mismatched body is never parsed);
  - every schema rule;
  - the 64 KiB boundary;
  - mapping fetch failures to outcomes.
- **`tests/unit/verifier-attestations.test.ts`, 14 tests:**
  - each check adapter's outcomes and scores;
  - every check kind reported;
  - deterministic report bytes and `evidence_hash = SHA-256(report)`;
  - atomic, content-addressed and tamper-detecting report storage;
  - owner-only key files;
  - the publication journal: one submission, a pending outcome kept and settled without a second transaction, and an expired attempt cleared.

## Signed local flow

The sponsor is the transaction source for admin and provider calls signed through `signVerificationAuthorization`. The verifier publishes as its own transaction source.

- Deploying with the sponsor as deployer fails without the admin's constructor authorization. The admin's own deployment binds the admin and the agent registry, as readback confirms.
- **Provider approval:**
  - Approval succeeds only with the admin's entry; the attacker, provider and sponsor keys signing as admin each fail with the expected host cause.
  - `provider_v1` carries the `ProviderRecord`.
  - Re-approving an approved provider in either mode fails with `Duplicate`.
- **Limited verifier run:**
  - The verifier runs against the deployed contracts. Its dry run publishes nothing.
  - The published run reports metadata, endpoint and signer account `Passed`, signer history `Inconclusive` for the fresh account, and the other four checks `Unsupported`.
  - The result has risk 0 and sequence 1. Its evidence hash resolves to the stored report, and the confirmed `assessment_v1` event matches it.
  - `check` passes for metadata and signer account. It denies when signer history, threat feed or token is required.
- **Rejected publications:**
  - an attacker's key signing as the provider;
  - no provider entry at all;
  - an unapproved provider;
  - a live provider publishing fixture data, and the reverse;
  - ten malformed results submitted from raw XDR with valid authorization: a mismatched aggregate, an aggregate of 101, an unknown flag, schema version 2, a future issue time, expiry at issue, an already-expired result, `revoked` set, a scored unsupported check and unsorted checks.
- **Sequences:** repeated and skipped sequences, and an issue time earlier than the latest, fail with `InvalidSequence`.
- **Supersession and revocation:**
  - A newer failure replaces the pass: `check` denies on the failed endpoint and on a threshold below 34.
  - Revocation by the attacker's key fails. Revoking a superseded sequence fails with `InvalidSequence`, and a second revocation with `Duplicate`.
  - `current` returns `Revoked`, until a fresh verifier run publishes sequence 3.
- **Ledger time:** a fixture result with six seconds of validity fails `check` with `Expired` once its age exceeds a one-second maximum, then fails `current` and `check` with `Expired` at `expires_at`.
- **Fixture risk:** fixture high-risk (100) and serious-flag (risk 0) results are denied.
- **Identity change (completing A02 for verification):**
  - A publication signed and enforced at revision 1 fails with `IdentityChanged` after a metadata update, while its authorization is still within its ledger window.
  - Revision 1 results fail `current` and `check`. Revision 2 has no result until the verifier assesses it; its sequence starts again at 1, and an explicit stale revision fails with `IdentityChanged`.
  - Disabling the agent makes revision 3 `Revoked`. Reactivating makes revision 4 start with no result.
- **Provider disable:** the attacker cannot disable a provider. Once the admin disables the fixture provider, its unexpired result fails with `Revoked`, publication fails with `Revoked`, re-approval fails with `Revoked`, and disabling again fails with `Duplicate`. The history stays readable through `latest`.

## Resource measurements

The values are simulated resource declarations and committed event XDR lengths, checked against the protocol 29 limits read from the local network. The fee comes from local simulation and excludes the base inclusion fee.

| Resource | Publish, eight checks | Transaction limit |
| --- | ---: | ---: |
| Result value, XDR bytes | 1,448 | — |
| Signed envelope, XDR bytes | 4,116 | 132,096 |
| Committed event XDR bytes | 1,580 | 16,384 |
| CPU instructions, including the agent registry call | 3,345,338 | 400,000,000 |
| Disk read bytes | 144 | 200,000 |
| Write bytes | 1,736 | 132,096 |
| Write entries | 2 | 200 |
| Footprint entries | 9 | 400 |
| Largest changed entry, XDR bytes | 1,660 | 65,536 |
| Minimum resource fee, stroops | 826,476 | — |

The measured publication is the first by a provider for a new revision, so it creates its result entry. `check`, `revoke`, provider calls and Testnet fees were not measured.

## Limits

- **No Testnet checkpoint yet.** The P3 gate's initial Testnet registration and real limited assessment have not been run. `deployments/testnet/checkpoint.ts` performs them once metadata is hosted at a public HTTPS URL and a Testnet deployment is approved.
- **Network calls are simulated locally.** The local flow serves metadata and endpoint answers through an in-process transport, because the network cannot reach a public host. `nodeTransport`, the real `node:https` path with address pinning, SNI and TLS error mapping, has not been exercised against a live server.
- **Rejections are simulations.** As in P1 and P2, rejections are full-check simulations against the live ledger, not failed submitted transactions.
- **Host tests do not enforce constructor authorization.** `env.register` skips that enforcement, so the host test asserts the recorded requirement and the local flow shows the enforcement.
- **A02 is complete for verification only.** Already signed old-policy requests need P4.
- **Signer-history check:** the history check is an estimate from the sequence number and never fails. On fresh local accounts it is always `Inconclusive`.
- **Archival and restoration are untested.**
