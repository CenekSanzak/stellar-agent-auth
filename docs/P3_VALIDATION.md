# P3 validation

On 2026-11-04, `npm run check` passed:

- 319 TypeScript unit tests in seven files;
- 43 Rust tests: 23 verification registry, 14 agent registry, 3 shared-types attestation, and one each for the ABI vectors, metadata validation and the auth probe;
- five WASM builds with the pinned Stellar CLI 30.0.1.

The typecheck, Rust format check and clippy with warnings denied also passed. On a freshly started protocol 29 Quickstart, the local suite passed 24 tests in four files: 12 verification registry tests plus the P1 and P2 suites. A second run on a new network also passed all 24.

To reproduce, run `npm run check` and start the network with `npm run dev`. Then run `npm run test:integration -- --disableConsoleIntercept` to print the resource measurements, and remove the network with `npm run local:down`. Every role key is generated at runtime and funded by the local Friendbot: admin, live provider, fixture provider, controller, agent signer, sponsor and attacker. No key material is committed. The local runs deploy nothing to a public network; the Testnet checkpoint is described below.

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

## Testnet checkpoint

On 2026-11-04, `deployments/testnet/checkpoint.ts` ran the P3 gate's development checkpoint on Testnet, which reported protocol 30. The whole run, contract IDs, transactions, WASM hashes and the assessment, is recorded in [`p3-checkpoint.json`](../deployments/testnet/p3-checkpoint.json). The WASM hashes match the local build above.

| Step | Transaction |
| --- | --- |
| Upload and deploy the agent registry `CBQ2URTR67ILCZYLJKPLCLZ5PBXFWVD5FCQSVW6TX6B4DPFUPFTZP5JL` | [upload](https://stellar.expert/explorer/testnet/tx/5a2fd0b11c69c2c882ab6997a2b1b2136b972601d943ed20621a153354445893), [deploy](https://stellar.expert/explorer/testnet/tx/c9317a7e74d8e7596560d369015a2d7c2774c45ec30a37a73b60a356498ed236) |
| Upload and deploy the verification registry `CA24ELDWDJOJNDG3ALQLOQQUXBDALS7PSJQROMWGWR25R46KJEJZJ6VY` with the admin's constructor authorization | [upload](https://stellar.expert/explorer/testnet/tx/87b6425288865b3b167c03f6d6e0966c92e7419c9d92b0d1236a71c2a61de20c), [deploy](https://stellar.expert/explorer/testnet/tx/ab7f7dae73fd2f0aa89550fb6d2b203fb1b7e95d8f11ccf50ce9d2accb780059) |
| Approve the live provider `GAJQD7OYQ7TL2WW26QSISEULCIYVIDRBOFM2EXDZFELD6UQDNFPQ74VY` | [approve](https://stellar.expert/explorer/testnet/tx/645f3c247b83c19349fa33878e6520a94f5a7c35238701c1910cd1c1f410486b) |
| Register agent 1, revision 1, with controller and signer authorization | [register](https://stellar.expert/explorer/testnet/tx/39284ba60c80929600bb73549c1a2bb629a4156e08dca3b33bfe6d8a84f07c39) |
| Publish the limited assessment, sequence 1 | [publish](https://stellar.expert/explorer/testnet/tx/203252458af7b9cddb3fb3092c39c52130e26d5d6a269cc5fc78441a6bed57cf) |

- **Metadata:** the agent's metadata is [`agent-metadata.json`](../deployments/testnet/agent-metadata.json), registered by its raw URL pinned to commit a5e6b4b, so the served bytes cannot change. Its SHA-256 is `758b655a35a4c82170fe125bb7ccba6b8a86a43293bbb6cd4d38495984686b79`.
- **A live run:** the verifier fetched the metadata over real HTTPS, matched the hash and parsed the document. It probed the declared endpoint, the project's GitHub page, which answered HTTP 200 over TLS 1.3. This was the first exercise of the real `nodeTransport`.
- **Results:**
  - metadata, endpoint and signer account `Passed`;
  - signer history `Inconclusive`, because the account was minutes old;
  - code, media, threat feed and token `Unsupported`;
  - risk 0, valid for 24 hours.
- **Report:** the report is committed as [`reports/83abc79e….json`](../deployments/testnet/reports/83abc79eccaa19f2517cb4a107f156eb1397a69f25afc2ab2c1f26db7588ed76.json), and its SHA-256 equals the published evidence hash.
- **Readback:** all seven transactions reported `SUCCESS`, and a separate read from Testnet matched the record:
  - the admin and agent registry bindings;
  - the live provider record;
  - the identity's controller, signer and metadata hash;
  - `current` with the evidence hash;
  - `check` passing for metadata, endpoint and signer account at risk 0, and `VerificationDenied` when a threat-feed check is required.

Testnet RPC records the signer's entry with CAP-71 `AddressV2` credentials, which bind the address into the signed payload; the local protocol 29 Quickstart records legacy `Address` credentials. The first registration attempt failed in simulation because the SDK's signature validators accepted only the legacy kind, so the entry went unsigned. Nothing was submitted. The SDK now validates and signs both kinds through `signingAddress`, still refusing delegated credentials; `tests/unit/credentials.test.ts` checks each signer against the address-bound preimage. The local suite still runs only legacy credentials until the local baseline moves to protocol 30.

The roles' keys are owner-only files in the git-ignored `.local/testnet/` and were funded by the Testnet Friendbot. The checkpoint is a development record, not the final P8 deployment.

## Limits

- **Local network calls are simulated.** The local flow serves metadata and endpoint answers through an in-process transport. The real `nodeTransport` succeeded once on Testnet, but its rejection paths (TLS errors, oversized bodies) are covered only through the injected transport.
- **Protocol mismatch:** Testnet runs protocol 30 and the local baseline protocol 29, so the local suite does not cover `AddressV2` credentials. The checkpoint shows the SDK 29 contracts work on protocol 30.
- **Rejections are simulations.** As in P1 and P2, rejections are full-check simulations against the live ledger, not failed submitted transactions.
- **Host tests do not enforce constructor authorization.** `env.register` skips that enforcement, so the host test asserts the recorded requirement and the local flow shows the enforcement.
- **A02 is complete for verification only.** Already signed old-policy requests need P4.
- **Signer-history check:** the history check is an estimate from the sequence number and never fails. On fresh local accounts it is always `Inconclusive`.
- **Archival and restoration are untested.**
