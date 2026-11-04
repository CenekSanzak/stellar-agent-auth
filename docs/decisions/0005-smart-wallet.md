# ADR 0005 · Smart wallet

P4 implements `contracts/smart-wallet`. An owner holds funds in the wallet and approves policies. Each policy lets one verified agent signer make bounded transfers. The policy, action, audit and error types come from [ADR 0002](0002-v1-abi-and-authorization.md). Identity and verification rules come from [ADR 0003](0003-agent-registry.md) and [ADR 0004](0004-verification-registry.md). The SDK client is `packages/sdk/src/{wallet,policies}.ts`. Evidence is in the [P4 validation record](../P4_VALIDATION.md).

## Entry points

| Entry point | Authorization | Effect |
| --- | --- | --- |
| `__constructor(owner, agent_registry, verification_registry)` | Owner | Binds the three addresses permanently |
| `fund(from, asset, amount)` | `from`, covering exactly the asset transfer | Moves `amount` into the wallet; returns the new balance |
| `withdraw(asset, recipient, amount)` | Owner | Moves `amount` out; returns the new balance |
| `approve_policy(policy)` | Owner | Stores and activates the policy; returns its hash |
| `revoke_policy(policy_hash)` | Owner | Revokes the policy permanently; returns its state |
| `replace_policy(old_policy_hash, policy)` | Owner | Revokes the old policy and approves the new one atomically |
| `pause()`, `resume()` | Owner | Blocks or allows agent execution |
| `execute(request)` | The policy's signer, for exactly this request | One transfer under the policy; returns the action hash |
| `balance(asset)` | None | The wallet's balance, read from the asset contract |
| `owner`, `agent_registry`, `verification_registry`, `paused` | None | Bound configuration and pause state |
| `policies()` | None | Active policy hashes, oldest first |
| `policy(policy_hash)`, `policy_state(policy_hash)` | None | The stored policy, and its state as of the current ledger time |
| `audit_head()` | None | The latest audit sequence and hash |

The constructor checks that both registries are contracts and that the verification registry is bound to this agent registry. It panics with `InvalidInput` otherwise.

## Authorization

- Owner actions use native `require_auth` on the stored owner. The entry therefore covers the wallet address, the method and the complete arguments. The owner may be any address.
- The fee sponsor holds no role. The agent signer cannot act as the owner: the policy approval rules forbid a signer equal to the owner.
- `execute` first loads the policy that `request.policy_hash` names, failing with `NotFound` if there is none. It then requires that policy's signer to authorize `execute(request)` with no child entries. The asset contract sees the wallet as its direct invoker, so the wallet's debit needs no further entry.
- A changed amount, recipient, asset, sequence, deadline, policy or wallet field is a different request. So is the same request sent to another wallet. Each fails host authorization.
- Funding authenticates `from` once. The entry's single child is `asset.transfer(from, wallet, amount)`. Funding creates no spending permission, policy, role or audit entry.

## Policy approval

`approve_policy` checks, in order:

1. The shared canonical rules (`Policy::canonicalize`). These are the version, collection caps, required fields, a positive per-transfer cap no greater than the daily cap, and sorted sets without duplicates.
2. The wallet's own rules, all `InvalidInput`:
   - `Transfer` is the only action kind and the service permission is `Disabled`. Service payments arrive with the restricted service path in P9; until then such a policy is refused rather than stored unenforceable.
   - The signer is a standard account other than the owner.
   - Every asset is a contract.
   - The wallet is never an allowed or blocked recipient.
3. `now < valid_until` (`Expired`).
4. An unused policy ID. A reused ID fails with `Duplicate` while that policy is active and `Revoked` once it is revoked. IDs are reserved forever, so a revoked ID can never be approved again, even with different terms.
5. Fewer than `MAX_ACTIVE_POLICIES` (8) active policies (`LimitExceeded`).
6. The agent registry's `current(agent_id, revision)` returns the policy's signer. The registry's `NotFound`, `IdentityChanged` or `Revoked` pass through, and a different signer is `IdentityChanged`.

The policy hash is the canonical hash from ADR 0002, bound to this wallet and network. A new policy starts at sequence 1 with no spend on the day of approval. An empty allowlist is accepted, but it can pay no one.

## Execution

After the signer's authorization, `execute` checks, in order:

1. The request version (`UnsupportedVersion`), a positive amount (`InvalidInput`) and this wallet (`PolicyDenied`).
2. Not paused (`Paused`), then not revoked (`Revoked`).
3. Exactly the policy's next sequence (`InvalidSequence`).
4. Ledger time before the request deadline and before `valid_until`, both exclusive (`Expired`). Ledger time at or after `valid_after` (`PolicyDenied` before then).
5. A permitted action kind, an asset the policy names, and a recipient on the allowlist and not on the blocklist (`PolicyDenied`). The blocklist wins.
6. At most the per-transfer cap (`LimitExceeded`). Today's spend for that asset plus the amount, with checked arithmetic (`ArithmeticOverflow`), must be at most the daily cap (`LimitExceeded`).
7. The live identity and its signer, as in approval step 6. Then the verification registry's `check` with the policy's provider and requirement. Registry errors pass through; any other failure or mismatched result is `VerificationDenied`.

The wallet then advances the sequence, stores the spend, appends the audit entry and calls `asset.transfer(wallet, recipient, amount)`.

Both registries are consulted on every execution, so a request signed earlier is judged against live state. A revocation, provider disable, failed or flagged result, identity update or signer rotation confirmed before execution blocks it. The identity check and the verification check are deliberately both explicit. The verification registry's `check` also requires the live revision, but the wallet does not depend on that implementation detail to enforce its own signer binding.

## Budgets and exposure

- A budget belongs to one policy and one asset. The UTC day is `timestamp / 86,400`.
- On the first execution of a new day, the stored spend resets. `policy_state` shows the reset immediately, without a write.
- Budgets are never combined across assets or policies.
- An owner's daily exposure for an asset is the sum of its active policies' daily caps. A replacement policy starts with a fresh budget, so on the day of replacement the agent may spend up to the old policy's spent amount plus the new cap. `policyExposure` in the SDK shows this per asset.
- `MAX_ACTIVE_POLICIES` bounds the sum.

## Sequences, replay and concurrency

- The host nonce rejects reuse of a confirmed signed entry.
- The policy sequence rejects a second request for a used sequence, even with fresh authorization.
- Two requests signed for one sequence can both be valid until one commits. Only the first commits, and the other then fails on chain.
- Requests under one policy commit in sequence order. The daily cap is checked when each one executes, so requests signed in advance cannot together exceed it.
- The ledger expiry of the authorization (inclusive) and the request deadline (exclusive Unix time) are separate limits.

## Pause and revocation

- Pause blocks `execute` only. Funding, withdrawal and every policy operation remain available.
- `resume` lifts the pause. Revoked policies and policies past their window stay unusable. Pausing or resuming when already in that state is `Duplicate`.
- A policy past `valid_until` can no longer execute, but it stays in the active list and keeps one of the eight slots until the owner revokes it. The SDK's exposure view leaves it out.
- Revocation is permanent and removes the policy from the active list. The policy and its final state remain readable, and revoking it again is `Duplicate`.
- `replace_policy` runs the revocation and the approval in one invocation. If the approval fails, the revocation is rolled back too.

## Audit chain

Every successful owner action (policy creation, revocation, pause change, withdrawal) and every execution appends one `AuditEntry`:

- **Entry fields:** the next sequence, the previous head hash, the ledger sequence and timestamp, the actor and the outcome. The actor is the owner, or the policy signer for an execution.
- **Hash:** the canonical audit hash from ADR 0002.
- **Storage:** the wallet stores only the head, `AuditHead { sequence, hash }`. The entry is published as the `audit_v1` event with topics `audit_v1` and the sequence, and data `{ entry, hash }`.
- **Genesis:** sequence 0 and 32 zero bytes. The first entry has sequence 1. A replacement appends two entries: the revocation, then the approval.

The transaction hash is not available to a contract, so it is not hashed. The P6 indexer attaches it from transaction metadata. Funding, failed calls and reads append nothing.

## Rollback and asset failures

State changes are committed before the asset call:

- the sequence;
- the spend;
- the audit head;
- for a withdrawal, the audit entry.

The asset contract can still refuse, for example for an insufficient balance or a missing recipient trustline. The wallet calls it with `try_transfer` and turns any refusal into `TransferFailed` (error 14). Returning an error fails the invocation, and the host then discards every write the invocation made. The same applies to `fund`.

The asset's own error is not passed through for a reason. Asset contracts number their own errors, and the Stellar Asset Contract's insufficient balance is `Error(Contract, #10)`, which a wallet client would decode as `VerificationDenied`. The host's diagnostic events still name the asset's error.

## Storage, TTL and restoration

- **Instance storage** holds the owner, both registries, the pause flag, the active list and the audit head.
- **Persistent entries:** each policy has three:
  - the immutable policy;
  - its mutable state;
  - its ID reservation.
- **Missing entries:** they are never deleted. A missing policy or state is `NotFound`; there are no defaults that could recreate a permission.
- **TTL extension:**
  - Every entry point extends the instance and code.
  - Every load or store extends the persistent entry it touches.
  - Approval and revocation also extend the ID reservation.
  - An entry under 29 days of TTL is extended to 30 days, at 17,280 ledgers per day.
- **Archived entries:** an archived persistent entry is not absent. Since protocol 23, a transaction that touches one restores it first, with its stored value. An archived revocation, sequence, spend or ID reservation therefore comes back exactly as stored, and no budget resets and no permission returns. Time-based expiry is evaluated against the current ledger time after restoration.
- **Maintenance:** extensions persist only in a submitted transaction; a read simulation extends nothing. To keep a dormant wallet live, submit any wallet call, such as `policy_state` for each active policy, or an `ExtendFootprintTTL` operation for its instance, code and policy entries. Simulation adds any restoration a transaction needs.

## ABI additions

These keep schema version 1, because no wallet was deployed under ADR 0002. The policy, action and audit hash vectors are unchanged.

- `Error::TransferFailed = 14`.
- `AuditHead { sequence, hash }`.
- The constants `MAX_ACTIVE_POLICIES = 8` and `SECONDS_PER_DAY = 86,400`, and `utc_day`.
- `Action::kind`.

The new error variant changes the interface metadata of every contract that exports `Error`. The agent and verification registries rebuild with the same behavior but different WASM hashes; see the P4 validation record.

## Not in P4

- Service payments and the `wallet → service → asset` authorization path are P9.
- Transaction submission, retries and the CLI are P5.
- Durable event indexing and audit reconstruction are P6.
- The wallet has no upgrade entry point and no owner transfer. A new owner means a new wallet: the old owner withdraws, then funds the new one.
