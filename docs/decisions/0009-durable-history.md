# ADR 0009 · Durable history and audit verification

Decided on 2026-11-25, in P6.

## Problem

The wallet appends every owner change and every payment to a hash chain and publishes each entry as an `audit_v1` event. It stores only the latest hash and sequence ([ADR 0005](0005-smart-wallet.md)). The entries themselves live in the RPC's event history, and an RPC keeps that for a limited window: 120,960 ledgers on the public Testnet RPC, about seven days. After that, the SDK's `readAuditHistory` can still say that entries are missing, and nobody can say what they were.

The demo and the final deployment need the whole history, and they need to know whether what they show is complete.

## Decision

`services/indexer` is one process that follows a deployment's events into one SQLite file, verifies each wallet's chain against its stored head, and serves both over HTTP. It holds no keys.

### Storage

- **SQLite through Node's built-in `node:sqlite`.** The repository installs with `npm ci --ignore-scripts`, which rules out a native module that compiles on install. Node 24, which the repository pins, ships SQLite. The database runs in WAL mode with `synchronous = FULL`.
- **Numbered migrations**, each applied in its own transaction and recorded. A database newer than the code is refused, not guessed at.
- **A stream** is one deployment's history: `<network>:<DEPLOYMENT_EPOCH>`, bound to the network ID and a start ledger. Opening it with another network or start ledger is refused. Every row carries its stream, so one file can hold several deployments and none can mix.
- **The start ledger has no default.** A default of "the oldest ledger the RPC has" would quietly drop the beginning of a history. The operator names the deployment's first ledger.

### Ingestion

- **A page and its cursor are written in one transaction.** The cursor never claims more than what is stored. A crash between pages loses nothing, and a crash inside a page leaves neither its rows nor its cursor.
- **Rows are keyed by stream and event ID**, with `INSERT OR IGNORE`. Reading a page twice, or restoring a backup and reading again, adds nothing.
- **A short page is not the end.** An RPC scans a bounded number of ledgers per request (10,000 on Testnet), so a page can be short, or empty, with more events further on. Reading stops only when the cursor has reached the RPC's latest ledger, or no longer moves. The cursor's ledger is read from its high 32 bits; a cursor that cannot be read is treated as unknown, never as caught up. The same fix went into the SDK's `readAuditHistory`, which had stopped at the first short page.
- **A full page may end inside a ledger**, so after one, only the ledgers before its last event count as complete.
- **Unknown schemas are quarantined.** An event from a followed contract is always kept raw. If its first topic is not one of `audit_v1`, `identity_v1`, `provider_v1`, `assessment_v1` or `service_paid_v1`, or it is an `audit_v1` event that does not decode, it is also listed in a quarantine table with the reason. Only `audit_v1` events from a followed wallet become audit entries.

### Retention gaps

Before reading, the indexer asks the RPC for its oldest retained ledger. If the next ledger it needs is older, the ledgers in between are recorded on the stream as a gap, reading resumes at the oldest retained ledger, and `/v1/health` reports `incomplete`. A gap only ever widens. It is removed by nothing, because nothing in this process can read those ledgers again.

A gap is a statement about ledgers, not about a wallet. If every audit entry from the first to the head is stored, that wallet is still `verified`: the chain proves it complete.

### Audit status

For each wallet, the stored entries are decoded and hashed again, each link is followed from the first entry, and the last entry is compared with the head read from the network after the ingestion pass.

| Status | When |
| --- | --- |
| `verified` | Entries 1 to the head's sequence are all present, each hashes to its published hash and names the hash before it, and the last hash is the head |
| `syncing` | The stored entries check and stop before the head with no recorded gap, or reach past a head read from a lagging RPC |
| `incomplete` | A sequence is absent between stored entries or before the first; or the entries stop before the head and a gap is recorded |
| `mismatch` | An entry does not decode, names another wallet or sequence, does not hash to its published hash, does not follow its predecessor, shares its sequence with a different entry, or the last entry is not the head |

Entries arrive in ledger order, one page at a time, so a hole in the middle is never a matter of waiting. That is why it is `incomplete` and not `syncing`.

The plan asked for the head and the entries to be compared at the same ledger. The RPC offers no read at a chosen ledger, so the comparison is by sequence instead: a hash for a given sequence never changes, so a head at sequence *n* either equals stored entry *n* or contradicts it, whatever ledger each was read at. Only a difference in sequence is treated as a difference in time.

### The indexer is not trusted

The HTTP API returns each entry exactly as published (`entry_xdr`) with its published hash. The SDK's `readIndexedHistory` decodes and hashes every entry again, follows the links, and reads the head from the network itself. An indexer that withholds, alters, reorders or substitutes entries gets `incomplete` or `mismatch` from the client, whatever status it reports. The CLI does this with `history --indexer <url>`.

### Attempts

A refused simulation is never submitted and a failed transaction publishes no events, so neither is in the chain. A client may report them to `POST /v1/wallets/<wallet>/attempts`. They go to their own table, are returned by their own route, and are never mixed with audit entries. They are a client's observation and the indexer cannot check them. The failure reason is optional, since the public RPC returns no diagnostics. Recording needs a bearer token unless the client is on loopback, and the process refuses to listen beyond loopback without one.

## Consequences

- The history survives RPC retention as long as the indexer runs at least once per retention window and its file is kept. Backup is a copy of one file.
- Lost history stays lost. The indexer does not read from a history archive or another indexer; it reports the gap. Ingesting from an archival source is later work.
- It is a single process over a single file. A shared database for several instances is later work.
- The stored head is read at the RPC's latest ledger, once per pass. A wallet that publishes between ingestion and the head read shows `syncing` for one pass.
- Reads are public and unauthenticated. Everything they return is already public on the network.
- Stellar ledgers are final when closed, so there is no reorganisation handling.
- The indexer's HTTP API has no rate limit. It binds to loopback by default; put a reverse proxy in front of it before exposing it.
