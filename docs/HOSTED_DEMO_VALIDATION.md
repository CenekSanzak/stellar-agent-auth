# Hosted demo validation

The demo was rebuilt so that it can be hosted and tried by anyone: Scout, a research agent that buys from sellers over x402 on an allowance its owner sets. The decisions are in [ADR 0013](decisions/0013-hosted-demo.md), how to run it in the [demo README](../apps/demo/README.md), and how to host it in [hosting](HOSTING.md). It has six parts:

- the indexer can follow every wallet that runs given code (`services/indexer`, `INDEXER_WALLET_CODE`);
- a catalogue of four sellers and what they sell, read from the network when bought (`apps/demo/server/catalogue.ts`);
- Scout's five tasks (`server/agent.ts`) and a server for many visitors (`server/backend.ts`);
- a setup that also runs on Testnet, with the real verifier (`server/setup.ts`);
- the page: a welcome, a one-button setup, the wallet, the allowance, the sellers, the tasks, the activity and the wallet's record, with a guest key, Freighter and Stellar Wallets Kit (`src/`);
- a container image and a Fly.io configuration (`Dockerfile`, `fly.toml`).

No contract changed. It is not hosted yet: that needs the owner's hosting account.

## What was run

On 2026-11-27, on macOS arm64 with Node 24.22.2, Rust 1.98.0, Stellar CLI 30.0.1, Docker Desktop and Google Chrome:

| Suite | Result |
| --- | --- |
| `npm run check` | Passed: 536 unit tests in 17 files, 100 Rust tests, six WASM builds, 4 spec tests, and both package checks |
| `npm run test:integration`, protocol 29 Quickstart | Passed: 83 tests in 14 files; 1 more is opt-in and was skipped |
| `npm run test:browser`, headless Chrome on the same network | Passed: 10 tests |
| `docker build` | Built; 459 MB |

The change adds 20 unit tests (6 for the indexer, 14 for the demo), 2 local-network tests and 2 browser tests; the demo's earlier tests were rewritten, not kept.

Things that failed on the way and were fixed:

- The backend test started more tasks in a minute than one client address is allowed, and was refused with 429. The limit was right; the test now raises it for itself, since the whole suite is one address.
- A test expected a seller's refusal where the wallet refused first: the report cost 2 and 1 was left of the day's allowance. The wallet is asked before the seller, so the test was wrong.
- Closing the wallet picker without choosing was shown as an error. It is now treated as a cancellation.
- Two type errors in the rewritten tests, found by `npm run check`.

## What the tests show

**The indexer, following wallets by code** (`tests/unit/indexer.test.ts`). With two wallets and one foreign contract all publishing `audit_v1` events, the two wallets' histories are stored and verify, and nothing of the foreign contract is stored. A failed code read stores nothing from its page, and the next pass reads it again. Each contract's code is read once. Any contract address can be asked about; recording an attempt needs the token even from loopback.

**The server, for two visitors** (`tests/integration/demo-backend.test.ts`). Two owner keys held by the test stand in for two browsers:

| Shown | How |
| --- | --- |
| An owner's wallet is named before it exists and known once created | `POST /v1/session` before and after the owner deploys it |
| Nothing is done for a wallet that does not exist | The faucet and tasks answer 409 |
| Requests another page could send are refused | Wrong content type, foreign origin, foreign host name |
| Only the indexer's wallet read routes pass through | `/indexer/v1/events` and a `POST` through `/indexer/` answer 404 |
| The faucet pays a fixed amount up to a ceiling | Two payments of 100; the third is refused at 200 |
| A purchase inside the allowance | The brief: paid, 1 tUSD, with a transaction and content read from the network |
| Above the limit for one purchase | The dataset at 8 against 5: `PaymentLimitExceeded`, nothing sent |
| A seller's own refusal | The audited report: `payee_gate_CheckNotPassed`, nothing paid |
| An unapproved recipient, then a fallback | Cheapest first: `RecipientNotAllowed` at Bargain Data, then paid at Ledger Wire |
| The day's limit | Two digests: the first paid, the second `DailyLimitExceeded` |
| Two visitors at once | Three requests together: one of the second visitor's two is refused with 409, the first visitor's runs alongside |
| A different allowance gives different outcomes | The second visitor allows 10 and every seller: the dataset and the cheapest headlines are bought |
| Freezing and ending | `Paused`, then paid again after unfreezing, then `Revoked`, with the balance unchanged |
| Each wallet's history verifies, apart from the other's | Read through `/indexer/` with the SDK and checked against each wallet's head; refusals are listed as attempts |
| Hosted behaviour | With a public URL: the public host name is accepted and another refused, visitors are limited separately by the proxy's header, HSTS is sent, `/healthz` answers for any host |

**The page, in Chrome** (`tests/browser/demo.test.ts`). It is served with the content security policy a hosted server sends. A guest goes from the welcome page to a funded wallet with one button; approves the suggested allowance; runs all five tasks and sees each outcome with its reason in the owner's numbers ("more than your limit of 5 tUSD for one purchase"); a second guest in a second browser context sets a larger allowance and both ask Scout at once; the first guest freezes, unfreezes and ends the allowance and is refused accordingly; the record is shown verified with seven entries and seven refusals; a reload brings the same guest back with what was bought still shown; and at 375 pixels wide nothing scrolls sideways and the tasks come before the reading. No page logged an error and no request of its own failed.

**Wording** (`tests/unit/demo.test.ts`). Every state the views can be in, including those hard to reach on a live network: no wallet, no allowance, an ended one, a frozen one, an expired verification, an incomplete or mismatching record, an unsettled payment, and hostile text in a title.

## On Testnet

Run by hand on 2026-11-27 against `https://soroban-testnet.stellar.org/` (protocol 30):

1. `demo:setup` deployed both registries, approved a `Live` provider, registered Scout with [`scout-metadata.json`](../deployments/testnet/scout-metadata.json) at a fixed commit, ran the project's verifier and published its result, issued tUSD, opened the sellers' trustlines and installed the wallet code. The record is [`deployments/testnet/demo.json`](../deployments/testnet/demo.json).
2. The verifier's result, as the page read it from the registry: `Endpoint`, `Metadata` and `SignerAccount` passed; `SignerHistory` inconclusive; `Code`, `Media`, `ThreatFeed` and `Token` not checked; valid until 2026-12-27 10:59 UTC.
3. The demo server was started against that record and opened in a browser. As a guest: the setup button took about 30 seconds from nothing to a wallet holding 100 tUSD; the suggested allowance was approved; "Find the cheapest headlines" was blocked at Bargain Data with `RecipientNotAllowed` and bought from Ledger Wire for 1 tUSD. The payment was settled by the published `@x402/stellar` facilitator with the allowance of ADR 0012: [`a72c1d7b…159efb16`](https://stellar.expert/explorer/testnet/tx/a72c1d7bc94b3d97e0f0674c30eb6f0dd569d7dc83c033e6a8e71464159efb16). The brief it bought described ledger 5,950,725. The wallet's record showed two entries, verified against the wallet.
4. The container image was run with the same record and the three keys given as environment secrets. It listened in under 12 seconds, served the page and the configuration, answered 402 at a seller, reported the indexer caught up with no lag, used about 117 MiB, and exited with status 0 within a second of `docker stop`.

## Not covered

- **The hosted address itself.** The image and the configuration were tested locally. Deploying needs the owner's Fly.io account; the proxy headers and TLS in front of it were not exercised.
- **Wallets other than a guest key and Freighter.** The wallet picker opens under the content security policy and lists the wallets; no wallet in it was used to sign. Freighter was last used by hand with the earlier page, on a local network; the code that connects it is unchanged.
- **The other four tasks on Testnet, and freezing and ending there.** They run the same code as the one that was tried, and all of it is covered on the local network.
- **Load.** Two visitors at once were tested. The limits are set for a demo that a few reviewers use; the public Testnet RPC's own limits were not measured.
- **A long-running deployment.** Nothing was left running for days. What needs doing over time is listed in [hosting](HOSTING.md).
- **A refusal as a transaction on the ledger**, as before: Scout asks the wallet before it signs.
