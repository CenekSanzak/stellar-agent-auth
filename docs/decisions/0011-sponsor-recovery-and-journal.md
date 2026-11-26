# ADR 0011 · A lost sponsor answer, the journal, and what a sponsor may spend

Decided on 2026-11-25, before P8. It closes the points [P5 validation](../P5_VALIDATION.md) left open.

## Problem

Three things in P5 depended on nothing going wrong.

- **A lost answer could lead to a second payment.** A client learned a sponsored transaction's hash only from the sponsor's answer. If the answer was lost after the sponsor had submitted, the client had no hash, journaled nothing, and could only wait for the signed operation to expire. A user who signed a new request before then could pay twice.
- **The journal could be missed.** It lived in `.local/cli` under the working directory, so the same command run from another directory did not see an unsettled transaction. Its records did not say which network they were for, and a write was not flushed before the envelope was sent.
- **A sponsor's spending had no total bound**, and two submitters on one key took the same sequence numbers.

## Decision

### A sponsor submits an operation once, and can say what it did with it

An operation is identified by `operationHash`: the SHA-256 of its XDR, signed entries included. Every journal record carries the hash of the operation its envelope was built around.

- **`sponsor` is idempotent.** While an operation is being handled, the same operation sent again waits for the same answer. Afterwards it gets the transaction already built for it. A new transaction is built only if the earlier one can never be included.
- **`lookup(operationHash)`** answers one of three things: the transaction built for the operation, `in-progress`, or `not-submitted`. Over HTTP it is `GET /v1/operations/<hash>`, and it always answers 200 or 202 with a status in the body. A submitter without the route answers 404, and a client reads that as "cannot say", never as "nothing was submitted".

### The client asks, and still checks what comes back

When a sponsor's answer is lost, `sponsoredInvoke` asks `lookup` a few times.

- A transaction comes back: it is checked exactly as a direct answer is. It must be a plain transaction from the sponsor carrying the one operation the client signed, with the hash it claims, and its outcome is read from the network.
- `not-submitted`: this is treated as a refusal. It rests on the sponsor's word, as every refusal does.
- Anything else, or a sponsor without `lookup`: `SponsorOutcomeUnknown`, as before, now carrying the operation hash.

`recoverSponsored` does the same from the hash alone, for another process or a later day; the CLI's `tx status --operation <hash>` calls it. With only a hash, the client cannot know when the envelope was sent, and it does not take the sponsor's word for it. The operation gives a bound instead: its entries were signed at most the longest authorization window before they expire.

### The journal

- **Location.** `--state-dir`, `STELLAR_AGENT_AUTH_STATE_DIR`, or the user's state directory (`$XDG_STATE_HOME/stellar-agent-auth`, else `~/.local/state/stellar-agent-auth`). It no longer depends on the working directory.
- **One journal per network** inside it. Records also carry their network, and `settle` refuses a record signed for another one: asked on the wrong network, a hash is not found and would in time look expired.
- **Writes are flushed**: the file, then its directory entry, before the envelope is sent.
- **An unknowable record can be acknowledged.** A record whose outcome the RPC can no longer show holds its scope for ever. `tx acknowledge` releases it, only when the network cannot still include it. Its status stays `unknown`; it is not relabelled as expired. `tx list` shows what holds a scope.

### `SUBMITTER_URL` applies to the commands a sponsor pays for

`execute`, `wallet fund` and `tx status --operation`. Every other command ignores the variable and pays for itself, so an owner's command is no longer sent to a sponsor that refuses it. `--sponsor-url` on a command line applies to that command, whatever it is, and `--direct` uses no sponsor.

### What a sponsor and a provider may be charged

- **A fee budget over any 24 hours.** The sponsor sums the fees of the envelopes it signed in that time from its journal, leaving out those that can never be included, and refuses a transaction that would pass the budget before signing it. The submitter defaults to 100 XLM; `SUBMITTER_DAILY_BUDGET_STROOPS=0` removes it.
- **One submitter per key and state directory.** A lock file names the process that holds it; a lock left by a process that no longer runs is taken over.
- **The verifier has a fee ceiling** for a publication and a revocation, checked before signing. It keeps its own small journal for publications.

## Consequences

- A lost answer is recovered when the sponsor is reachable again. If the sponsor is gone for good, the outcome is still unknown until the operation expires, and the on-chain state must be read.
- `not-submitted` and every other refusal are the sponsor's word. A sponsor that lies can keep a signed operation and submit it later, until it expires. For `execute`, the policy sequence means a later request and the held one cannot both apply. On the account path there is no sequence, so a held entry can be applied as well as a new one; the policy's limits still bound both.
- The journal moved. Records under the old `.local/cli/journal` are not read; settle anything pending before upgrading.
- The lock cannot see a submitter that uses the same key with another state directory.
- The budget counts what could be charged, which is at least what was.
- `TransactionJournal` gained `byOperation` and `inScope`. An implementation outside this repository has to add them.
