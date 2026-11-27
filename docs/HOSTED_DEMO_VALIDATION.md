# Hosted demo validation

The demo was rebuilt so that it can be hosted and tried by anyone: Scout, a research agent that buys from sellers over x402 on an allowance its owner sets. The decisions are in [ADR 0013](decisions/0013-hosted-demo.md), how to run it in the [demo README](../apps/demo/README.md), and how to host it in [hosting](HOSTING.md). It has six parts:

- the indexer can follow every wallet that runs given code (`services/indexer`, `INDEXER_WALLET_CODE`);
- a catalogue of four sellers and what they sell, read from the network when bought (`apps/demo/server/catalogue.ts`);
- Scout's five tasks (`server/agent.ts`) and a server for many visitors (`server/backend.ts`);
- a setup that also runs on Testnet, with the real verifier (`server/setup.ts`);
- the page: a welcome, a one-button setup, the wallet, the allowance, the sellers, the tasks, the activity and the wallet's record, with a guest key, Freighter and Stellar Wallets Kit (`src/`);
- a container image and a Fly.io configuration (`Dockerfile`, `fly.toml`).

No contract changed. It is hosted at <https://scout-agent-demo.fly.dev/>; see "Hosted" below for what was run there and for the two faults that only the hosted run showed.

## What was run

On 2026-11-27, on macOS arm64 with Node 24.22.2, Rust 1.98.0, Stellar CLI 30.0.1, Docker Desktop and Google Chrome:

| Suite | Result |
| --- | --- |
| `npm run check` | Passed: 537 unit tests in 17 files, 100 Rust tests, six WASM builds, 4 spec tests, and both package checks |
| `npm run test:integration`, protocol 29 Quickstart | Passed: 83 tests in 14 files; 1 more is opt-in and was skipped |
| `npm run test:browser`, headless Chrome on the same network | Passed: 10 tests |
| `docker build` | Built; 459 MB |

The change adds 21 unit tests (6 for the indexer, 15 for the demo), 2 local-network tests and 2 browser tests; the demo's earlier tests were rewritten, not kept.

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

## Hosted

Deployed on 2026-11-27 to Fly.io: one `shared-cpu-1x` machine with 512 MB in Ashburn and a 1 GB volume, from the image built by Fly's builder (304 MB). The owner set the three secrets; nothing else was entered by hand.

Run against <https://scout-agent-demo.fly.dev/> from a browser, as a guest:

| Shown | Result |
| --- | --- |
| The address answers over HTTPS only | 200 for the page, 301 from HTTP, HSTS and the content security policy sent |
| A seller is reachable as an x402 resource | 402 at `/x402/ledger-wire/brief` |
| Setup | Test XLM, wallet and 100 tUSD, in about 30 seconds |
| The suggested allowance | Approved |
| Cheapest headlines | Blocked at Bargain Data (`RecipientNotAllowed`), bought from Ledger Wire |
| The dataset | Blocked (`PaymentLimitExceeded`) |
| The audited report | Refused by the seller (`payee_gate_CheckNotPassed`) |
| The weekly catch-up | One digest bought, the next blocked (`DailyLimitExceeded`) |
| Freezing, then unfreezing | The brief blocked (`Paused`) |
| Ending the allowance | The brief blocked (`Revoked`) |
| A new allowance of 10 per purchase with every seller | The dataset bought, 40 rows; the cheapest headlines bought at Bargain Data |
| The wallet's record | Verified against the wallet throughout, including after a redeploy: the history is on the volume |
| The indexer | Caught up, no lag, nothing quarantined |
| Memory after all of the above | 137 MB resident, of 472 MB |

Two faults appeared only here, and both were fixed:

- **The server could not have written its database.** Fly mounts a volume owned by root, which hides the ownership the image gave `/data`, and the server ran as an unprivileged user. An entrypoint now hands the directory to that user and drops to it. This was caught before the first deploy and tried locally against a root-owned mount.
- **The server ran out of memory on the first close-time digest, and restarted.** The digest asked the RPC for 120 ledgers. An RPC returns a ledger with everything that happened in it; on Testnet, decoding them used up the server's heap of about 256 MB, where the local network's empty ledgers had been nothing. The visitor saw "The demo server answered 502". The sellers now read recent ledgers from a watch that keeps a sequence, a close time and a hash per ledger, fed every five seconds and filled one ledger at a time at start; nothing in a ledger is decoded. A unit test checks that no more than one ledger is ever asked for at once. After the fix the same task ran on the hosted server and bought its digest.

The second fault is the kind the local network cannot show: its ledgers are empty. Anything that reads ledgers, transactions or events in bulk should be tried on Testnet before it is believed.

## An outside agent over MCP

[`packages/mcp`](../packages/mcp/README.md) lets an AI agent's host be the wallet's agent ([ADR 0014](decisions/0014-agent-over-mcp.md)). It was tested by an MCP client calling the tools a model would call.

On the local network (`tests/integration/agent-mcp.test.ts`, 10 tests): the four tools are offered with instructions that say whose money it is; nothing can be bought before the owner has a wallet and an allowance; the allowance is read in the owner's numbers; `price` reports what the wallet would pay and what it would refuse, and spends nothing; a purchase inside the allowance is paid and returns what was bought; a purchase above the limit and one to an unapproved seller are blocked by the wallet, and one is declined by its seller, all without moving money; an address that is not `https` is a failed call; freezing blocks, and after the allowance is ended an agent that keeps the ended policy is refused by the wallet with `Revoked`; the purchase is in the wallet's record, which verifies; and the built server runs as a child process over standard input and output.

Against the hosted demo on Testnet, run by hand on 2026-11-27 with Scout's key and a guest's wallet: `allowance` reported 10 per purchase, 20 per day and 8.5 spent; `sellers` listed the five products with their addresses; `price` for the digest answered 3 tUSD and that the wallet would pay; `buy` paid it ([`391a35e9…20dbd7af`](https://stellar.expert/explorer/testnet/tx/391a35e956c4c79b595d315effeffe23d8ca8cd2edcc280f1b74283820dbd7af)) and returned the digest; `buy` at Audited Sources was declined with `payee_gate_CheckNotPassed`; and `allowance` then reported 11.5 spent. The guest's page, open in a browser, showed the purchase as entry 10 of the wallet's record within seconds, verified against the wallet.

With this package the whole run on 2026-11-27 was: `npm run check` passed with 537 unit tests; `npm run test:integration` passed with 93 tests in 15 files and 1 opt-in skipped; `npm run test:browser` passed with 10.

No model took part. The machine this was built on has no agent harness with a command-line mode, so what a model does with these tools has not been observed.

## Bringing your own agent

Anyone can connect their own AI agent to their wallet ([ADR 0015](decisions/0015-bring-your-own-agent.md), [how to use it](../packages/mcp/README.md)). Run on 2026-11-27 on the local network: `npm run check` passed with 543 unit tests; `npm run test:integration` passed with 100 tests in 16 files and 1 opt-in skipped; `npm run test:browser` passed with 11.

**The agent's side and the server** (`tests/integration/own-agent.test.ts`, 7 tests). One call to `init` creates two key files readable by their owner only, registers a new agent whose identity carries the hash of the document the server serves for it, gets a result published for it (`Metadata` and `SignerAccount` passed, `Endpoint` not applicable), and puts it on the owner's list. Running it again registers nothing and publishes nothing. The command line says what is left to do and prints no key. The server refuses a name with markup in it, an unknown agent, linking the built-in agent, and a path that tries to leave the metadata directory. With an allowance the owner approves for it, the agent pays through its tools with no settings but its home directory; a purchase above its limit is blocked and a seller that wants more refuses it. The built-in agent, asked to pay under the new agent's allowance, pays nothing.

**In the page** (`tests/browser/demo.test.ts`, one new test). A guest's page shows the sentence to paste, naming the server and the guest's account. The instructions and the one-file tool are served. After `init` runs for that guest, the agent appears in the page by itself, verified, with no allowance. The guest approves Scout's allowance and then a smaller one for the new agent; the agent buys a brief and is blocked on a digest above its limit; its card shows 1 of 4 spent while Scout's shows 0 of 6; and the record names the agent.

**By hand, as an agent would do it.** The instructions were fetched from a running local server, the tool was downloaded from it with `curl` into an empty directory outside the repository and run with Node 24: `init` registered agent 2 and printed the link and the host commands; the link opened the page on that agent's allowance form; after approval the downloaded file, started as an MCP server by a client, reported the allowance, bought a brief and was blocked on a digest; the page showed the spend within seconds.

One fault was found by looking at the page and fixed: for a few seconds after any action the record was labelled "Incomplete", with a warning, because the indexer had not yet read the newest entries. A record that trails the wallet by its newest entries is now shown as catching up for up to 45 seconds, and as incomplete only if it stays that way.

Not run: any of this on Testnet or on the hosted server, where the verifier is the real one and fetches the agent's document over HTTPS from the server's own public address; and no model has followed the instructions. Both are the next things to try.

## Not covered

- **Rate limits behind the real proxy.** The hosted server takes the client's address from Fly's header; that two visitors are limited separately was tested with that header locally, not from two networks.
- **Wallets other than a guest key and Freighter.** The wallet picker opens under the content security policy and lists the wallets; no wallet in it was used to sign. Freighter was last used by hand with the earlier page, on a local network; the code that connects it is unchanged.
- **Load.** Two visitors at once were tested. The limits are set for a demo that a few reviewers use; the public Testnet RPC's own limits were not measured.
- **A long-running deployment.** It has been up for minutes, not days. What needs doing over time is listed in [hosting](HOSTING.md).
- **A refusal as a transaction on the ledger**, as before: Scout asks the wallet before it signs.
