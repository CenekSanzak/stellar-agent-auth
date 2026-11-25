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
| `npm run check` | Passed: 488 unit tests in 16 files, 100 Rust tests, six WASM builds, 4 spec tests |
| `npm run test:integration`, protocol 29 Quickstart | Passed: 74 tests in 13 files |
| `npm run test:browser`, headless Chrome on the same network | Passed: 8 tests |

P7 adds 21 unit tests (`tests/unit/demo.test.ts`), 7 local-network tests (`tests/integration/demo-backend.test.ts`) and the 8 browser tests. No contract changed.

Each suite passed in its final run, which was made on a freshly started local network. Two things failed on the way and were fixed:

- The browser test failed one step in each of its first two runs: a request for a page icon that did not exist, and a check in the test itself that read a list before the page had refreshed. It has passed in every run since.
- One full run of the local-network suite failed in `tests/local/phase1-authorization.test.ts` with "contract already exists". That test and `tests/adversarial/limits.test.ts` each created the native asset's contract when they found it missing, and on a fresh network both could find it missing. The race is older than P7; the new test files changed the timing. Both now use one helper that accepts a failed creation when the contract exists afterwards.

Flakiness beyond that was not measured.

To reproduce: `npm run check`, `npm run dev`, `npm run test:integration`, `npm run test:browser`, `npm run local:down`.

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

- **Freighter is not tested.** No test in the repository signs through it: the browser test runs without the extension and uses the page's local demo key. Connecting, the network check and signing through Freighter have to be tried by hand, and must be before P8 relies on them.
- **Local network only.** The setup refuses any other network, because it publishes a fixture result. The page labels that result as simulated.
- **Refusals have no transactions.** The agent stops at simulation. A failed transaction on the ledger is produced by the CLI example's presigned payment, not by the page.
- **The server holds three keys in one process** and follows one owner at a time. It is a demo server.
- **The sponsor and indexer run inside the demo server.** As separate processes they are tested by P5 and P6.
- **Not reviewed by anyone else, and not usability-tested.** The wording was written and checked by the author.
- **CI.** The browser test is added to the local-network job and uses the runner's Chrome. That step has not run in CI yet; the pull request's run is its first.
- Open from earlier phases and unchanged: the lost sponsor response, the payment flow test's fetch from a public host, and the payee-side verification gate.
