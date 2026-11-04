# ADR 0003 · Agent registry

P2 implements `contracts/agent-registry` with the `AgentIdentity` record, error codes and `identity_v1` event from [ADR 0002](0002-v1-abi-and-authorization.md). The contract has no constructor, admin, upgrade entry point or controller transfer. The SDK wrappers live in `packages/sdk/src/agents.ts`. Evidence is in the [P2 validation record](../P2_VALIDATION.md).

## Entry points

| Entry point | Authorization | Effect |
| --- | --- | --- |
| `register(controller, signer, metadata_uri, metadata_hash)` | Controller, then signer | Allocates the next ID at revision 1, enabled |
| `update_metadata(agent_id, expected_revision, metadata_uri, metadata_hash)` | Controller | Replaces the URI and hash |
| `rotate_signer(agent_id, expected_revision, new_signer)` | Controller, then new signer | Replaces the signer |
| `disable(agent_id, expected_revision)` | Controller | Sets `disabled` |
| `reactivate(agent_id, expected_revision)` | Controller | Clears `disabled` |
| `get(agent_id)` | None | The identity in any state |
| `current(agent_id, revision)` | None | The identity only while enabled at exactly `revision` |
| `agent_count()` | None | Highest allocated ID; 0 before the first registration |

The four lifecycle calls increment the revision by one. Every mutation returns the identity after the change.

## Authorization

Role checks use native `require_auth`, so each authorization entry covers the registry address, method and complete arguments. The fee sponsor holds no role: paying for and signing the envelope authorizes nothing. The SDK's `registryOperation` repeats the stateless checks and `signRegistryAuthorization` signs only an entry that matches the expected call, but enforcement is in the contract.

- `register` requires the controller. It then rejects a signer equal to the controller, or one that is not a standard account, with `InvalidInput`, and only then requires the signer. The signer's authorization proves control of its key. An invalid signer is never asked for one.
- Lifecycle calls load the identity and require its stored controller. The agent signer cannot update, rotate, disable or reactivate.
- `rotate_signer` also requires the new signer, before the revision and signer checks. With those authorizations present, a stale revision fails with `IdentityChanged` whatever the new signer is. A new signer equal to the controller is covered by the controller's entry and fails with `InvalidInput` at the current revision. A contract new signer must authorize before it is rejected with `InvalidInput`; without its entry the host rejects the call.
- Lifecycle calls carry `expected_revision`, and a mismatch fails with `IdentityChanged`. A signed entry therefore applies only to the revision its signer saw. Once any change commits, entries signed for the earlier revision fail even within their ledger validity, and of two changes signed for one revision only the first can commit. The host nonce rejects reuse of a confirmed entry, including a registration's.
- A missing or forged authorization fails as a host `Error(Auth, …)`, which has no contract error code.

`register` checks, in order: controller authorization; a signer that differs from the controller and is a standard account (`InvalidInput`); signer authorization; metadata (`InvalidInput`, `LimitExceeded`); ID overflow (`ArithmeticOverflow`). Lifecycle calls check, in order: the identity exists (`NotFound`); controller authorization; new-signer authorization (rotation only); the revision (`IdentityChanged`); input (`InvalidInput`, `LimitExceeded`); a no-op (`Duplicate`); revision overflow (`ArithmeticOverflow`).

## Revisions and disabling

- Each lifecycle change increments the revision with checked arithmetic. A no-op change (the same URI and hash, the current signer or the current state) fails with `Duplicate` and consumes no revision. Changing only the URI or only the hash counts as a change.
- `disable` and `reactivate` are revision changes like the others. A disabled identity still accepts metadata updates and signer rotation, so its controller can recover from a signer compromise. It stays disabled until `reactivate`.
- Reactivation creates a new revision. No earlier revision, including the one before `disable`, becomes current again.
- Identities are never deleted, IDs are never reused and revisions only increase.

## Metadata

`validate_metadata` in shared-types applies these checks in order. The SDK's `validateAgentMetadata` uses the same order and error codes and counts UTF-8 bytes.

1. Empty URI: `InvalidInput`.
2. More than 2,048 bytes: `LimitExceeded`.
3. Not lowercase `https://` followed by at least one byte: `InvalidInput`. `HTTPS://` is rejected.
4. Any byte outside visible ASCII `0x21`–`0x7E`, such as a space, control character, DEL or non-ASCII byte: `InvalidInput`.
5. An all-zero 32-byte hash: `InvalidInput`.

The registry does not fetch, parse or normalize the URI, and does not compare the hash with the document. P3's verifier must check the fetched bytes against the registered hash.

## Storage and TTL

- Instance storage holds only `AgentCount`. Each identity is a separate persistent entry, `Identity(agent_id)`. IDs come from the checked `u64` counter and start at 1.
- Every entry point extends the contract instance and code, and every identity load or store extends that entry. An entry with less than 29 days of TTL is extended to 30 days, at 17,280 ledgers per day.
- An extension persists only in a submitted transaction. SDK reads simulate and extend nothing. A P3 or P4 transaction that calls `current` extends the identity it reads.
- Archival and restoration are untested; they belong to P4 and P8.

## Events

Each committed mutation emits one `identity_v1` event. Its topics are `identity_v1` and the agent ID, and its data is the `AgentIdentity` after the change, equal to the return value. Reads and failed calls emit nothing.

## Deferred

- Controller transfer. No entry point changes the controller. A compromised controller cannot be replaced; anything it changes creates a new revision that existing results and policies do not cover.
- Contract-address and muxed signers. `signer` and `new_signer` must be standard ed25519 accounts. The contract checks the address's XDR prefix because `Address::to_payload` requires soroban-sdk's `hazmat-address` feature. Controllers may be any address, including a contract.
- Signer uniqueness. One signer can be bound to several agent IDs, and each binding needs its own authorization. Consumers must key authority by agent ID and revision, never by signer alone.
- Registry administration, upgrades and identity deletion.

## Use by P3 and P4

- Bind every verification result and policy to `(agent_id, revision)`.
- P3 publication and every P4 `execute` must call `current(agent_id, revision)` on the live registry and deny on any error: `NotFound`, `IdentityChanged` for any other revision, or `Revoked` while disabled. Never substitute `get`, which also returns disabled and changed identities.
- P4 must authenticate the signer of the identity that `current` returns. A revision's signer never changes, so a policy may store the signer, but it must still match the signer from `current`.
- A metadata update, rotation, disable or reactivation therefore leaves every older result and policy unusable. A reactivated identity needs a fresh assessment and owner policy for its new revision.
