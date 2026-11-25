# P6 validation

P6 adds durable history: an indexer that keeps a deployment's contract events past the RPC's retention window and verifies each wallet's audit chain against the head the wallet stores. The design is in [ADR 0009](decisions/0009-durable-history.md) and how to run it in the [indexer README](../services/indexer/README.md). It has four parts:

- a SQLite store with migrations, written a page and its cursor at a time (`services/indexer/src/storage.ts`);
- ingestion from the RPC, with retention-gap detection and quarantine of unknown events (`events.ts`);
- audit verification with four statuses (`audit.ts`), and an HTTP API and process over them (`api.ts`, `index.ts`);
- in the SDK, `readIndexedHistory`, which verifies what an indexer returns, and `history --indexer` in the CLI.

## What was run

On 2026-11-25, on macOS arm64 with Node 24.22.2, Rust 1.98.0 and Stellar CLI 30.0.1:

| Suite | Result |
| --- | --- |
| `npm run check` | Passed: 467 unit tests in 15 files, 100 Rust tests, six WASM builds, 4 spec tests |
| `npm run test:integration`, protocol 29 Quickstart | Passed: 67 tests in 12 files |
| The built indexer as a process against the public Testnet RPC | Indexed and verified the P9 wallet; see below. A manual run, not a test suite |

P6 adds 30 unit tests (29 in `tests/unit/indexer.test.ts` and one for the CLI option) and 7 local-network tests (`tests/integration/indexer.test.ts`). No contract changed, so the Rust tests and the built contracts are those of [P9](P9_VALIDATION.md).

Each suite passed in its final run. Flakiness over repeated runs was not measured.

To reproduce: `npm run check`, `npm run dev`, `npm run test:integration`, `npm run local:down`.

## P6 gate

> Restart and duplicate ingestion preserve counts; interrupted ingestion loses no cursor-covered data; reconstructed history matches the on-chain head; missing history is visibly incomplete.

| Gate item | Evidence | Status |
| --- | --- | --- |
| Restart preserves counts | Unit: a store on disk is closed and reopened; the next pass reads only by cursor and adds only the new events. Local network: the indexer is stopped, two transactions are published, and after a restart the wallet has entries 1 to 6, each once, verified. | Met |
| Duplicate ingestion preserves counts | Unit: the same page stored again adds no rows and does not move the stream backwards. Local network: a second pass with nothing new adds nothing. | Met |
| Interrupted ingestion loses no cursor-covered data | Unit: the RPC fails between pages; what the cursor covers is stored, the status is `syncing`, and the next pass completes and verifies. A page whose second row cannot be stored leaves neither its first row nor its cursor. | Met in unit tests; a killed process was not tested |
| Reconstructed history matches the on-chain head | Local network: after a policy approval, a payment, a pause and a resume, the stored chain hashes to the head read from the wallet, and the entries equal those read directly from the RPC. Testnet: the same for the P9 wallet's 13 entries. | Met |
| Missing history is visibly incomplete | Unit: a start after the RPC's oldest ledger, and a stop longer than its retention, each record a gap and report `incomplete` with the missing sequences, even when the stored tail matches the head. Local network: a deleted row is reported `incomplete` by the indexer and refused by the SDK. | Met; a retention gap is not reproduced on a network |

## What the audit check catches

`tests/unit/indexer.test.ts`, against stored rows:

| Change to the stored history | Result |
| --- | --- |
| None | `verified` |
| An entry's content changed, its hash changed, or it no longer decodes | `mismatch` |
| An entry replaced by one from another, internally valid chain | `mismatch`: it does not follow its predecessor |
| Two different entries with one sequence | `mismatch` |
| An entry filed under another sequence | `mismatch` |
| The last entry is not the stored head | `mismatch` |
| An entry missing in the middle or at the start | `incomplete`, with the missing range; what is present is still checked |
| The entries stop before the head, no gap recorded | `syncing` |
| The entries stop before the head, a gap recorded | `incomplete` |
| The head read is behind the stored entries | `syncing` |

Read through the SDK's `readIndexedHistory`, an indexer that withholds the last entries, the first entry or a middle entry, alters or garbles one, or serves a whole substituted chain gets `incomplete` or `mismatch`, including when it reports `verified` itself.

## Testnet

The built indexer was started as a process against `https://soroban-testnet.stellar.org` for the wallet of the P9 run, `CBFOZEQRIKUFDWEJA32BC7ZI5QZLHPSTVATYVFOUMLIDLOJLPQKZZV3L`, with `INDEXER_START_LEDGER=5900000`. That is about 19,000 ledgers before the RPC's latest ledger at the time.

| What | Value |
| --- | --- |
| Events stored | 13, all `audit_v1`, none quarantined |
| Audit status | `verified`: 13 entries from the first match the head the wallet stores |
| Stored head | sequence 13, `9b1cd8cda052a69f666f532f40f148bc9c7737c3a8d20d2076fe13fc70d38fa8` |
| Entry 2 | transaction `284a96a5…`, ledger 5,918,767: the plain account payment in the P9 record |
| Entry 13 | transaction `2f516516…`, ledger 5,918,784: the service payment in the P9 record |
| Ingested to | ledger 5,919,117, lag 0 |

This run also shows why a short page cannot be taken as the end. The Testnet RPC scans 10,000 ledgers per request: asked from ledger 5,900,000, it answered with no events and a cursor at ledger 5,909,999, and the 13 events came on the next request. The SDK's `readAuditHistory` stopped at the first short page before P6 and would have reported this wallet's history as empty; it now reads on until the cursor reaches the latest ledger.

That wallet is from a throwaway deployment, and the RPC will drop its events about seven days after 2026-11-25. Indexing the kept deployment from its first ledger is part of P8.

## Acceptance cases

| ID | Evidence | Status |
| --- | --- | --- |
| A26 | The first three gate rows above. | Shown in unit tests and on the local network |
| A27 | The table of changes above, the retention-gap tests, and a deleted and an altered row on the local network. | Shown; a retention gap only in unit tests |

## Limits and open points

- **One process, one file.** Running two indexers on one database is not supported and not tested.
- **A killed process is not tested.** Atomicity rests on SQLite transactions with `synchronous = FULL`; the tests fail the RPC and the write, not the process.
- **Lost history is not recovered.** The indexer does not read a history archive. A gap stays until the file is replaced from a backup.
- **Attempts are unverified.** They are what a client reported. Nothing in P6 reports them yet; the demo (P7) will.
- **The retention-gap tests use a stand-in RPC** that pages like the real one: a bounded scan per request, a cursor at the end of the scanned range after a short page, and a refusal to start before the oldest ledger. The paging behaviour it copies was observed on the local network and on Testnet.
- **`node:sqlite`** is built into Node 24, and Node does not yet mark it stable. The repository pins Node 24.22.2, where it loads without a warning; a Node upgrade should rerun the indexer tests.
- **No rate limit on the HTTP API.** It binds to loopback by default.
- Open from earlier phases and unchanged: the lost sponsor response, the payment flow test's fetch from a public host, and the payee-side verification gate ([P5 validation](P5_VALIDATION.md), [P9 validation](P9_VALIDATION.md)).
