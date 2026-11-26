# P7 validation

P7 adds the owner demo: a page where an owner creates a wallet, approves a policy, watches the agent pay and be refused, and stops it, and the server behind that page. The decisions are in [ADR 0010](decisions/0010-owner-demo.md) and how to run it in the [demo README](../apps/demo/README.md). It has four parts:

- a setup that deploys everything the demo needs except the owner's wallet (`apps/demo/server/setup.ts`);
- a server that plays the agent, the sponsor, the funder and the indexer, and does a fixed set of things (`server/agent.ts`, `server/backend.ts`);
- the page: views for the agent, the wallet, policies and history, with the owner signing in the browser (`src/`);
- a browser test that drives the built page in Chrome (`tests/browser/demo.test.ts`).

It runs on the local network. Nothing in P7 was run on Testnet.

## What was run

On 2026-11-25, on macOS arm64 with Node 24.22.2, Rust 1.98.0, Stellar CLI 30.0.1 and Google Chrome:

| Suite | Result |
| --- | --- |
| `npm run check` | Passed: 503 unit tests in 16 files, 100 Rust tests, six WASM builds, 4 spec tests, and both package checks |
| `npm run test:integration`, protocol 29 Quickstart | Passed: 74 tests in 13 files; 1 more is opt-in and was skipped |
| `npm run test:browser`, headless Chrome on the same network | Passed: 8 tests |

P7 adds 21 unit tests (`tests/unit/demo.test.ts`), 7 local-network tests (`tests/integration/demo-backend.test.ts`) and the 8 browser tests. The same branch then closed most of what P5 had left open, which added 15 unit tests; see "Also in this branch" below. No contract changed.

Each suite passed in its final run, which was made on a freshly started local network. Two things failed on the way and were fixed:

- The browser test failed one step in each of its first two runs: a request for a page icon that did not exist, and a check in the test itself that read a list before the page had refreshed. It has passed in every run since.
- One full run of the local-network suite failed in `tests/local/phase1-authorization.test.ts` with "contract already exists". That test and `tests/adversarial/limits.test.ts` each created the native asset's contract when they found it missing, and on a fresh network both could find it missing. The race is older than P7; the new test files changed the timing. Both now use one helper that accepts a failed creation when the contract exists afterwards.

Flakiness beyond that was not measured.

To reproduce: `npm run check`, `npm run dev`, `npm run test:integration`, `npm run test:browser`, `npm run local:down`.

## Also in this branch

After the demo, the points [P5 validation](P5_VALIDATION.md) listed as still open were worked through; the decisions are in [ADR 0011](decisions/0011-sponsor-recovery-and-journal.md).

| Point | What changed | Evidence |
| --- | --- | --- |
| A lost sponsor answer could lead to a second payment | A sponsor submits an operation once however often it is sent, and answers what it did with one. The client asks when an answer is lost; `tx status --operation` asks later. | Unit tests: one transaction for repeated sends, across a restart; recovery of a lost answer; a forged or foreign transaction still refused; a submitter without the route read as "cannot say" |
| The gate test needed a public host | The example has an offline mode that runs the real verifier over a transport serving the metadata from the repository | `payment-flow.test.ts` on the local network; the online variant is opt-in |
| `SUBMITTER_URL` captured owner commands | It applies to `execute`, `wallet fund` and `tx status --operation` only; `--direct` added | Unit tests over every command |
| The journal depended on the working directory | User state directory, one journal per network, flushed writes, records name their network, `tx list` and `tx acknowledge` | Unit tests |
| No total bound on a sponsor's spending | A fee budget over 24 hours, counted from the journal | Unit tests, including after a restart |
| Two submitters on one key | A lock per key and state directory | Unit tests with a live and an exited holder |
| The verifier had no fee ceiling | Checked before signing a publication or revocation | Unit test |
| The CLI and services were not shown to install | `npm run check:service-packages` packs them, installs them outside the workspace and runs each | Part of `npm run check` |

That last check found a real defect: a command installed in `node_modules/.bin` is a symbolic link, and every entry point compared its own path with the unresolved one. An installed `stellar-agent-auth` therefore did nothing and exited 0. All entry points now resolve the link first.

The recovery of a lost sponsor answer is shown in unit tests with a stand-in RPC. It was not reproduced on a network by cutting a real connection.

## P7 gate

> A developer follows the guide to run the demo; the owner approves one policy and stops agent access; the UI accurately reports confirmed and rejected outcomes without exposing signing secrets.

| Gate item | Evidence | Status |
| --- | --- | --- |
| A developer runs the demo from the guide | The README's five commands were run on a clean local network: setup, then the server, then the page in a browser, by hand, through wallet creation, funding, a policy, a payment and a refusal. | Met on the machine it was written on; not tried by a second person |
| The owner approves one policy | Browser test: the form's default policy is approved with the owner's signature and then read back from the wallet and shown as "may pay up to 5 DEMO at a time and 20 DEMO per UTC day", valid for seven days. | Met |
| The owner stops agent access | Browser test: after a pause the agent is refused with `Paused`; after a confirmed revocation the policy shows as revoked, the revoke button is gone, and the agent is refused with `Revoked`. The balance does not change. | Met |
| Confirmed and rejected outcomes are reported accurately | Browser test: a paid payment lowers the balance read from the network by its amount; each refusal shows the wallet's own error and leaves the balance unchanged. The history lists six ledger entries and is verified in the page; four refusals are listed apart from it. | Met |
| No signing secret is exposed | The page has no field for a secret, checked in a unit test over its forms. The server's configuration answer carries no secret and no key path, checked on the local network. The owner's key never reaches the server: in the server test it is held by the test alone. | Met |

## The cases the page shows

From the browser test and the server test, on the local network:

| Case | Shown as |
| --- | --- |
| A payment within the limits (3 of 5) | Paid; the balance drops by 3; an `Executed` entry on the ledger |
| Above the per-payment limit (6 of 5) | Refused, `PaymentLimitExceeded`; nothing submitted |
| To a recipient not on the list | Refused, `RecipientNotAllowed`; nothing submitted |
| Up to the daily limit, then one more | Payments until today's limit is reached, then refused, `DailyLimitExceeded` (server test) |
| A payment as an account | Paid; an `AccountPayment` entry (server test) |
| A payment to the demo service | Paid in the service's own call; an `AccountPayment` entry |
| Any payment while paused | Refused, `Paused` |
| Any payment after revocation | Refused, `Revoked`, on both payment paths |

## Freighter, by hand

On 2026-11-26 the owner ran the demo with the Freighter extension on the local network, started with Horizon (`npm run dev:horizon`), following the steps in the [demo README](../apps/demo/README.md). Every step did what the guide says: connecting, test XLM, creating the wallet, the faucet, approving the default policy, a payment and a refusal, pause, resume, and revocation. With Freighter switched to Testnet, connecting was refused with the network message.

Afterwards the wallet was read from the network, not from the page:

| What | Read back |
| --- | --- |
| Wallet owner | The Freighter account |
| Audit history through the indexer, verified by the SDK | `verified`: 5 entries from the first match the stored head |
| Entries | Policy approved, one 3 DEMO payment by the agent, paused, resumed, policy revoked |
| Owner transactions | Four, each successful, each carrying one signature |
| Refusals recorded as attempts | `PaymentLimitExceeded`, `Paused`, `Revoked`; none on the ledger |
| Wallet state | Not paused, 97 DEMO, no active policy |
| Demo server log | No errors |

This is one run by one person, on a local network whose transactions are not kept. It shows that the Freighter path works end to end; it is not a regression test.

## States covered only by unit tests

A live local network does not produce these in the time a test runs, so their wording is tested on the view functions directly (`tests/unit/demo.test.ts`):

- a verification result that is expired, revoked, for an earlier revision, risk-flagged, or with a failed check; a disabled agent; an unapproved provider;
- a connected wallet that is on another network, or reports none;
- an action that is submitted and not confirmed, and one whose outcome is not known;
- a history that is incomplete, or does not match the wallet; a history that cannot be read;
- a refusal for which the network gave no reason;
- an unsettled transaction surviving a reload in the page's journal.

The browser test does cover two failure states in the real page: the demo server being unreachable, and a browser with no wallet extension.

## Acceptance cases

| ID | Evidence | Status |
| --- | --- | --- |
| A28 | The browser smoke test above, with P5's clean-checkout SDK import and CLI example. | Shown on the local network |
| A01–A03, A14–A19 | Not new evidence; the demo shows these rules through the page. Their evidence is in the P2, P4 and P9 records. | Unchanged |

## Limits and open points

- **Freighter is tried by hand, not by a test.** No test in the repository signs through it: the browser test runs without the extension and uses the page's local demo key. The owner ran the flow with Freighter on 2026-11-26; see "Freighter, by hand" above. It has not been tried on Testnet.
- **Local network only.** The setup refuses any other network, because it publishes a fixture result. The page labels that result as simulated.
- **Refusals have no transactions.** The agent stops at simulation. A failed transaction on the ledger is produced by the CLI example's presigned payment, not by the page.
- **The server holds three keys in one process** and follows one owner at a time. It is a demo server.
- **The sponsor and indexer run inside the demo server.** As separate processes they are tested by P5 and P6.
- **Not reviewed by anyone else, and not usability-tested.** The wording was written and checked by the author.
- **CI.** The browser test is added to the local-network job and uses the runner's Chrome. The pull request's first run failed before reaching it: Friendbot answered 500 while the suites funded their accounts in parallel. Funding is now retried.
- Open from earlier phases and unchanged: the payee-side verification gate and a real x402 client.
