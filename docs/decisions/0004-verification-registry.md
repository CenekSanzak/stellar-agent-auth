# ADR 0004 · Verification registry and limited verifier

P3 implements `contracts/verification-registry`, the verifier process in `services/verifier` and the SDK client in `packages/sdk/src/verification.ts`. It builds on the `VerificationResult` record and `assessment_v1` event from [ADR 0002](0002-v1-abi-and-authorization.md) and on the agent registry rules in [ADR 0003](0003-agent-registry.md). Check coverage and scoring are in [the coverage document](../VERIFICATION_COVERAGE.md). Evidence is in the [P3 validation record](../P3_VALIDATION.md).

## Entry points

| Entry point | Authorization | Effect |
| --- | --- | --- |
| `__constructor(admin, agent_registry)` | Admin | Binds both for the contract's lifetime; `agent_registry` must be a contract address |
| `approve_provider(provider, mode)` | Admin | Approves a never-approved address for `Live` or `Fixture` results |
| `disable_provider(provider)` | Admin | Disables a provider; terminal |
| `publish(result)` | `result.provider` | Stores the next result for `(agent_id, revision, provider)` |
| `revoke(agent_id, revision, provider, sequence)` | Provider | Marks the latest result revoked; terminal |
| `provider(provider)` | None | The provider record |
| `latest(agent_id, revision, provider)` | None | The latest result in any state, for display |
| `current(agent_id, revision, provider)` | None | The latest result only while usable |
| `check(agent_id, revision, provider, required_checks, max_age, max_risk_score)` | None | `current` plus a consumer requirement |
| `admin()`, `agent_registry()` | None | The constructor bindings |

There is no upgrade entry point, admin transfer or result deletion.

## ABI additions to v1

Nothing was deployed under ADR 0002, so these additions stay in schema version 1. The policy, action and audit hash vectors are unchanged.

- `ProviderRecord { mode: AssessmentMode, approved: bool }`.
- The `provider_v1` event data is the `ProviderRecord` after the change instead of a bare approval boolean, so indexers see which mode a provider was approved for.
- `shared_types::attestation` adds `risk_score`, `VerificationResult::validate_publication`, `VerificationResult::evaluate` and `validate_requirement`. The SDK mirrors them in the same order with the same error codes.
- `shared_types::identity` now holds `require_account` and adds `require_contract`. The agent registry re-exports `require_account` unchanged.

## Providers

- A provider address is approved once, for one mode. Approving an approved address fails with `Duplicate`, including an attempt to change its mode. The mode binding means fixture data can never appear under a live provider identity, or the reverse.
- Disabling is terminal. Re-approving a disabled address fails with `Revoked`, so results published before the disable can never become usable again. A replacement provider needs a new address. Disabling an unknown address fails with `NotFound`, and disabling twice with `Duplicate`.
- Each policy names the provider its owner trusts. Approval only means a provider may publish here; it does not make that provider trustworthy for every owner.

## Publication

`publish` checks, in order:

1. The provider named in the result authorizes the exact call (host `Error(Auth, …)` otherwise).
2. The provider is approved (`VerificationDenied` if never approved, `Revoked` once disabled) and the result's `mode` equals its approved mode (`InvalidInput`).
3. `validate_publication` at the ledger timestamp:
   - the v1 shape (`UnsupportedVersion`, `LimitExceeded`, `InvalidInput`, `Duplicate`);
   - at least one check, in strictly ascending `CheckKind` order;
   - a score only on a `Passed` or `Failed` check;
   - `risk_score` equal to the ceiling of the mean of the check scores, or absent when no check is scored;
   - `revoked` false;
   - `issued_at <= now` and `issued_at < expires_at` (each `InvalidInput`);
   - `now < expires_at` (`Expired`).
4. `current(agent_id, revision)` on the bound agent registry. Its `NotFound`, `IdentityChanged` and `Revoked` pass through unchanged. Any other failure, or an identity that does not match the request, denies with `VerificationDenied`.
5. Sequence: exactly one past the stored latest, starting at 1 (`InvalidSequence`, with `ArithmeticOverflow` at `u64::MAX`). The issue time must not be earlier than the latest result's (`InvalidSequence`); an equal issue time is allowed.

The registry stores only the latest result per `(agent_id, revision, provider)`. A newer result, passing or failing, replaces the earlier one immediately, and no read returns the replaced result. The exact-next sequence makes publication idempotent: a retried transaction that already committed fails with `InvalidSequence` rather than publishing twice. Each agent revision starts its own sequence at 1, and sequences are independent per provider.

## Revocation

`revoke` requires the provider's authorization and applies only to the latest sequence. An earlier sequence fails with `InvalidSequence`, a missing result with `NotFound`, and a second revocation with `Duplicate`. Revocation works whatever the provider or identity state, so a provider can always withdraw a result. Only a new publication with the next sequence supersedes it. The revoked result stays readable through `latest`.

## Lookups

- `current` checks, in order: provider approval (`VerificationDenied`, `Revoked`); the live identity through the agent registry (`NotFound`, `IdentityChanged`, `Revoked`); a stored result (`NotFound`); not revoked (`Revoked`); and `now < expires_at` (`Expired`).
- `check` first validates the requirement: one to eight distinct check kinds (`InvalidInput`, `Duplicate`, `LimitExceeded`), `max_age > 0` and `max_risk_score <= 100` (`InvalidInput`). It then calls `current` and applies `evaluate`:
  - an age of at most `max_age` seconds (`Expired`);
  - no serious wallet-risk flag;
  - every required check present with outcome `Passed`;
  - an aggregate risk present and at most `max_risk_score`.

  A failure among the last three returns `VerificationDenied`. An `Unsupported`, `Inconclusive`, `NotApplicable`, `Failed` or absent required check denies, as does a result with no scored check.
- `latest` returns a result in any state and must never be used to authorize anything.

P4's wallet will call `check` with its policy's `required_checks`, `max_assessment_age` and `max_risk_score` before every action, and must deny on any error.

## Storage, TTL and events

- Instance storage holds the admin and agent registry. Each provider record and each latest result is a separate persistent entry. Every entry point extends the instance and code, and every load or store extends the entry it touches, to 30 days once fewer than 29 remain. A cross-contract `current` call also extends the identity it reads.
- `provider_v1` (topics `provider_v1`, provider) carries the `ProviderRecord` after approval or disabling. `assessment_v1` (topics `assessment_v1`, agent ID, provider) carries the result after publication or revocation. Reads and failed calls emit nothing.

## Limited verifier

- The verifier is an explicit CLI job (`assess`, `show`, `revoke`), not a service with an open endpoint. `assess` is a dry run unless given `--publish`.
- The provider key is read from the file named by `VERIFIER_SECRET_KEY_FILE`, which must not be readable by group or others. It is never accepted as an argument or from public configuration, and never reaches browser code.
- Metadata is fetched only from the registered URI, and only over HTTPS on the default port. Every resolved address must be globally routable, and the connection is pinned to the vetted address to defeat DNS rebinding. Each redirect is revalidated (at most three), and the deadline, body size, encoding and TLS verification are fixed. The verifier hashes the original bytes before decoding and parses only a match, against the strict `stellar-agent-auth/agent-metadata/v1` schema. Fetched content is never executed, and endpoint probes are single `HEAD` requests.
- The detailed report is canonical JSON. It is stored under its SHA-256 before publication, and that hash is the result's `evidence_hash`.
- The issue time is the latest ledger's close time, so a result is never issued in the ledger's future.
- The provider is the transaction source and signs its own publication. Before submitting, the signed envelope is journaled. A later run settles the journaled transaction first: one that committed is the outcome, and one that failed, or is past its time bound and not found, is cleared. One still within its bound stops the run with `PublicationPending`. A new transaction is built only after that, so an unknown outcome never causes a blind retry.

## Deferred

- Admin transfer, provider metadata, and upgrades.
- Threat-feed, token, media and code adapters. The verifier never sets serious wallet-risk flags, so those checks remain `Unsupported`.
- ERC-8126 privacy proofs. The evidence hash links a result to a report; it proves nothing about the report's contents.
- A hosted verifier queue or HTTP endpoint, and multi-provider aggregation within one policy.
- Archival and restoration tests, which belong to P4 and P8.
