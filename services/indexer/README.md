# Indexer

Keeps a deployment's contract events in a SQLite file and checks each wallet's audit chain against the head the wallet stores. An RPC server retains events for a limited window, about seven days on Testnet, and the wallet keeps only the latest hash. Without a process like this one, the history is gone once the RPC drops it. The design is in [ADR 0009](../../docs/decisions/0009-durable-history.md) and what was tested in [P6 validation](../../docs/P6_VALIDATION.md).

It holds no keys and has no authority. It reads the network and answers questions about what it has read. A client does not have to believe it: the SDK's `readIndexedHistory` hashes and links every entry again and compares the last one with the head read from the network.

```sh
npm run build
export STELLAR_NETWORK=testnet
export WALLET_ID=C...                    # the wallet to follow
export AGENT_REGISTRY_ID=C...            # optional: its events are kept as raw events
export VERIFICATION_REGISTRY_ID=C...
export INDEXER_START_LEDGER=5918000      # the ledger the deployment was created in, or earlier
export DEPLOYMENT_EPOCH=testnet-2026-12
node services/indexer/dist/index.js
```

Then:

```sh
curl http://127.0.0.1:8788/v1/health
stellar-agent-auth history --wallet C... --indexer http://127.0.0.1:8788/
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `INDEXER_START_LEDGER` | required | First ledger to read. There is no default, because starting late silently drops the start of the history |
| `INDEXER_WALLETS` | `WALLET_ID` | Comma-separated wallet contracts; their `audit_v1` events become audit entries |
| `INDEXER_WALLET_CODE` | none | Comma-separated hex hashes of wallet code. Every contract that runs one of them is followed as a wallet, without being named. See "Following wallets by code" below |
| `INDEXER_CONTRACTS` | none | More contracts to keep raw events for, such as a service. `AGENT_REGISTRY_ID` and `VERIFICATION_REGISTRY_ID` are added when set. At most 25 contracts in all |
| `INDEXER_DATABASE_PATH` | `.local/history.sqlite` | The database file. Keep it on a persistent disk |
| `DEPLOYMENT_EPOCH` | `<network>-p0` | Names the stream, as `<network>:<epoch>`. A new deployment needs a new epoch |
| `INDEXER_POLL_SECONDS` | `5` | Time between passes |
| `INDEXER_HOST`, `INDEXER_PORT` | `127.0.0.1`, `8788` | Listen address |
| `INDEXER_TOKEN_FILE` | none | Owner-only file with a bearer token of at least 32 characters, for recording attempts; required beyond loopback |

Network settings come from the same variables as the SDK (`STELLAR_NETWORK`, `STELLAR_RPC_URL`). It needs Node 24, whose built-in SQLite it uses; there is no native module to compile.

A stream belongs to one network and one start ledger. Opening an existing stream with another of either is refused: use a new `DEPLOYMENT_EPOCH`, or a new database file.

## HTTP

| Route | Result |
| --- | --- |
| `GET /v1/health` | Ingested and latest ledger, lag, any retention gap, row counts and each wallet's audit status |
| `GET /v1/wallets/<wallet>/history?after=<sequence>&limit=<n>` | Audit entries in sequence order, each with the entry as published (`entry_xdr`), its published hash, ledger and transaction |
| `GET /v1/wallets/<wallet>/attempts?after=<id>&limit=<n>` | Recorded attempts, oldest first |
| `POST /v1/wallets/<wallet>/attempts` | Records an attempt: `{ "kind": "simulation" \| "transaction", "status", "error"?, "detail"?, "tx_hash"? }` |
| `GET /v1/events?contract=<C...>&topic=<name>&after=<event id>&limit=<n>` | Raw events in event ID order |

`limit` is 1 to 200 and defaults to 50. A list answers with `next_after`, which is the `after` of the next page, or `null` at the end. Reads need no token and send `access-control-allow-origin: *`: everything they return is already public on the network.

`status` in `/v1/health` is `ok`, `incomplete` (a retention gap, or a wallet with entries missing), `audit-mismatch` or `error` (the last pass failed; `ingestion_error` says why).

## Audit status

| Status | Meaning |
| --- | --- |
| `verified` | Every entry from the first to the stored head is present, hashes to its published hash and links to the one before |
| `syncing` | What is stored checks, and the wallet's head is ahead of it or behind it. Look again after the next pass |
| `incomplete` | Entries are missing and waiting will not bring them: they were never read, or were removed |
| `mismatch` | An entry contradicts its hash, its neighbour or the stored head |

A hash chain shows that entries are missing or changed. It cannot bring them back.

## Attempts

A payment the wallet refuses leaves nothing on the ledger: a refused simulation is never submitted, and a failed transaction publishes no events. A client that wants those shown next to the history reports them here. They are kept in their own table and are never part of the audit chain. They are what a client said, not what the network recorded, so the indexer cannot vouch for them. `error` is optional because the public Testnet RPC returns no diagnostics, so the reason for a failure is often unknown. A transaction hash is recorded once.

Without a token, only a loopback client may record. With `INDEXER_TOKEN_FILE`, recording needs `Authorization: Bearer <token>`. Behind a reverse proxy on the same host every client looks like loopback, so set the token there.

## Keeping the history

- **Keep it running.** If it is down for longer than the RPC retains events, the ledgers in between cannot be read. The indexer records them as a gap, shows it in `/v1/health`, and continues from the oldest ledger the RPC still has. A gap is never removed.
- **Back up the file.** Stop the process, or use SQLite's online backup, and copy the database file (in WAL mode, a plain copy of a running database also needs the `-wal` file). After restoring a backup, start the indexer: it continues from the stored cursor, and events it already has are not stored twice.
- **A gap does not always mean loss.** If every audit entry from the first to the head is stored, the wallet is `verified` whatever ledgers were skipped. The chain decides, not the gap.
- **One process per file.** This is a single-instance service. Two processes on one file, or one stream fed from two places, is not supported.
- **Unknown events are quarantined.** An event whose first topic is not a schema this version knows, or an `audit_v1` event that does not decode, is kept as a raw event and counted under `quarantined` in `/v1/health`. It is never guessed at.

## Following wallets by code

A deployment where each owner creates their own wallet cannot name its wallets in advance. With `INDEXER_WALLET_CODE` set, the indexer adds one filter that reads `audit_v1` events from the whole network. For each contract it has not seen, it reads the contract's code hash once; events of contracts that run the named code are kept, and all others are dropped without being stored. `INDEXER_WALLETS` may be left empty, and at most 20 other contracts can be named.

In this mode:

- `GET /v1/wallets/<wallet>/history` answers for any contract address. One that was never seen has an empty history.
- Recording an attempt always needs the token. Being a local caller is not enough, since any wallet could be named.
- A wallet's audit status is checked in the pass that brings it new entries, not in every pass. A reader verifies the chain against the wallet's head itself in any case; `readIndexedHistory` in the SDK does.
- A failed code read stops the pass before its page is stored. The next pass reads the page again.

Only a contract running known wallet code can be believed about its own history, which is why the code hash is the test and the event's shape is not.

