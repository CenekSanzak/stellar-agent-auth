# P8 validation

P8 is the Testnet release: a deployment that is kept, proof that the network holds what its record says, the statement of work's scenario run on it, and the guides a reviewer and another builder need. The reviewer's summary is [evidence of completion](EVIDENCE.md); this is the record of what was built and run.

It has five parts:

- a check of the kept deployment against the network (`deployments/testnet/deploy.ts`) and its record (`manifest.json`);
- the acceptance scenario, with its refusals submitted to the ledger (`deployments/testnet/evidence.ts`, `evidence.json`), and a local-network test of it;
- the [setup guide](SETUP.md), the [operations notes](OPERATIONS.md) and the [evidence page](EVIDENCE.md), with three screenshots of the hosted demo;
- a job in CI for the read-only Testnet checks, started by hand;
- a rerun of every suite from a clean checkout.

No contract changed. The deployment is the one made on 2026-11-27 for the hosted demo ([hosted demo validation](HOSTED_DEMO_VALIDATION.md)).

## What was run

On 2026-11-28, on macOS arm64 with Node 24.22.2, Rust 1.98.0, Stellar CLI 30.0.1, Docker Desktop and Google Chrome, from a fresh clone of the branch at `70e2505`:

| Suite | Result |
| --- | --- |
| `npm ci --ignore-scripts`, `npm run check` | Passed: 546 unit tests in 17 files, 100 Rust tests, six WASM builds, 4 spec tests, and both package checks |
| `npm run test:integration`, protocol 29 Quickstart | Passed: 102 tests in 17 files; 1 more is opt-in and was skipped |
| `npm run test:browser`, headless Chrome on the same network | Passed: 11 tests |
| `npm run example:payment` | Completed: the payment made, the later ones refused as `Revoked`, the history verified |
| `node deployments/testnet/deploy.ts`, Testnet, protocol 30, from the same clone | Passed: 11 checks, and all three contracts as built there equal the deployed ones |
| `node deployments/testnet/evidence.ts`, Testnet, against the hosted service | Completed: 1 payment applied, 4 refused on the ledger, the record verified |
| CI, started by hand on the branch | Passed at `e9180a2`: the full check, the local-network suites, and the new Testnet job, which ran the preflight and the deployment check on Linux |

This work adds 2 unit tests, 1 local-network test (`tests/integration/evidence.test.ts`) and 1 opt-in Testnet test file (`tests/testnet/x402-external.test.ts`, 3 tests, run on 2026-11-27 and recorded in [x402 validation](X402_VALIDATION.md)).

The 100 Rust tests are 48 in the smart wallet, 23 in the verification registry, 14 in the agent registry, 8 in the spike's test contract, 5 in shared-types and 2 in the demo service, as before.

The browser test was changed after that clone, as described under "Found and fixed" below, and passed twice more from the working tree.

Each suite passed in its final run. One CI run failed on the way, in the browser test, on a commit that passed in another run; see "Found and fixed" below. Flakiness over repeated runs was not otherwise measured.

## P8 gate

> A reviewer can use the SDK, CLI and demo, inspect real contract IDs and evidence, reproduce all required cases and follow the setup guide. All SOW requirements map to passing tests or concrete evidence.

| Gate item | Evidence | Status |
| --- | --- | --- |
| The deployment is kept and recorded | `demo.json` from the setup; `manifest.json` from the check: network ID, protocol, contract IDs, code hashes, role addresses, the asset, seven transactions with ledgers and links, tool versions | Met |
| Every address in the record is read back from the network | `deploy.ts`: 11 checks, listed below | Met |
| One allowed payment | A 3 tUSD payment under a 5-per-payment, 20-per-day, seven-day allowance, applied on Testnet | Met |
| Over the limit, unknown recipient, after revocation | Each refused by the wallet in simulation and then as a submitted transaction that failed with the same reason; a fourth, while paused, the same way | Met |
| Direct transaction links only where a transaction exists | Every link in the evidence is to a transaction on the ledger, applied or failed. Refusals in the demo, which are never sent, have none and are not given any | Met |
| A setup guide from a clean checkout | [SETUP.md](SETUP.md); its commands were run from a fresh clone, and its SDK snippet and CLI commands against Testnet | Met |
| Key roles, error meanings, maintenance, backup, reset | [OPERATIONS.md](OPERATIONS.md) and the refusal table in the setup guide | Met |
| The test asset and the absence of an audit are stated | On the evidence page, in both guides, on the demo page itself and in the readme | Met |
| Public Testnet is not a required check | The CI job for it runs only on a manual start | Met |
| Screenshots | Three, of the hosted demo, taken by a script as a guest | Met |
| A recording | Not made. The builder records it | Open |

## The deployment check

`deploy.ts` asks the network eleven things, and all eleven held:

1. the RPC server is on the recorded network;
2. the agent registry exists;
3. the verification registry exists;
4. the wallet code is installed;
5. the verification registry is bound to the agent registry;
6. the provider is approved, as `Live`;
7. the agent is registered with the recorded signer, controller and metadata;
8. the agent's metadata is served and has the registered hash;
9. the agent has a current verification from the provider;
10. the asset contract is the Stellar Asset Contract of the recorded asset;
11. the asset has 7 decimals.

It then found the seven transactions that made the deployment in the network's history: both registries' creation, the provider's approval, the asset contract's creation and the issue, the agent's registration and its first verification. They are in `manifest.json`. The wallet code's upload was not looked for.

**The code hashes.** The contracts built on this machine have exactly the hashes on the network: `b99cf6c5…` for the agent registry, `41b7f41f…` for the verification registry and `568ccc8e…` for the wallet. The ones CI builds on Linux x86_64 from the same source do not, for two of the three: the agent registry is identical, and the wallet and the verification registry have the same size to the byte, the same interface and the same build metadata, and other bytes. Why was not investigated. The check therefore reports the comparison and does not require it.

## The acceptance scenario

Run on 2026-11-28 against the hosted service. The script made a new owner and a relayer, funded by Friendbot; had a new agent created, registered and verified exactly as `stellar-agent-wallet init` does it; created the owner's wallet; took 100 tUSD from the service's faucet; and approved an allowance of 5 per payment and 20 per day to one recipient for seven days.

| Step | Outcome | Wallet's reason | Transaction |
| --- | --- | --- | --- |
| The agent is registered (agent 7) | Applied | | [`186d5514…1edc10`](https://stellar.expert/explorer/testnet/tx/186d55143ed2b95b359e1fbbef3e1c15e7d369653e988af4ef00ff92971edc10) |
| Its verification is published | Applied | | [`a7e522d6…3aaf29`](https://stellar.expert/explorer/testnet/tx/a7e522d6f52411480c3090234d0bd5c79c770b0f09c0d801762134b4233aaf29) |
| The wallet is created | Applied | | [`6cf52834…38eb84`](https://stellar.expert/explorer/testnet/tx/6cf52834dfaeedde66617036c6670e82bfdbf1174a285e72070d9f017138eb84) |
| The faucet funds it | Applied | | [`458fab8a…b26d83`](https://stellar.expert/explorer/testnet/tx/458fab8ab95196346fbebae5fa0970424e15e9e443accda80e874c4591b26d83) |
| The allowance is approved | Applied | | [`bd0300c7…f61040`](https://stellar.expert/explorer/testnet/tx/bd0300c7b9f99338041be4a53cd0709256c6dfa321a14fd091375e9716f61040) |
| 3 tUSD to the approved recipient | Applied; wallet 100 → 97, recipient 19 → 22 | | [`c101e432…cec17a`](https://stellar.expert/explorer/testnet/tx/c101e432d08c292f5529ca5dae962670a7bc16165df71e17eabd5836a4cec17a) |
| 8 tUSD to the approved recipient | Failed; nothing moved | `PaymentLimitExceeded` | [`57bccc1b…3186d5`](https://stellar.expert/explorer/testnet/tx/57bccc1bbb6f2fe24717c2f9b8d330dc770526380f7e1fef55feedb6c03186d5) |
| 3 tUSD to another recipient | Failed; nothing moved | `RecipientNotAllowed` | [`4060ce3c…dc43e1`](https://stellar.expert/explorer/testnet/tx/4060ce3c027b8f2e97becb2d1571c9181d40294ec756544b8e44412547dc43e1) |
| The owner pauses | Applied | | [`34cc6408…81a864`](https://stellar.expert/explorer/testnet/tx/34cc64081a93d3048f6f3e26eeddc1b7775b7a902211888dead4a1fcb581a864) |
| 3 tUSD, signed before the pause | Failed; nothing moved | `Paused` | [`bccd4676…a3635b`](https://stellar.expert/explorer/testnet/tx/bccd467626f966e7cbf474cf8a2e5df059942c8a99ee9f930401fd38f0a3635b) |
| The owner resumes | Applied | | [`14fae717…e8815b`](https://stellar.expert/explorer/testnet/tx/14fae7174ce45ea5e8b2a1675f9322b0dcb10d0d852e49cd44a67b2847e8815b) |
| The owner revokes the allowance | Applied | | [`4535be2e…8657ba`](https://stellar.expert/explorer/testnet/tx/4535be2e3d4527e8a5d402ebf70917bba0168a059ea2b1ae47990741e78657ba) |
| 3 tUSD, signed before the revocation | Failed; nothing moved | `Revoked` | [`b946ce2e…9822a2`](https://stellar.expert/explorer/testnet/tx/b946ce2e00567c662902032d8f6ea9890b22e105481e282cb5cec1f4399822a2) |

The wallet is `CDA6MY2C6LUDOEDURJ5TTRW4ERTMDT5ORGGHFGQIQSUOYYMZ3GXOENDV`. At the end it held 97 tUSD, 3 had been spent under the allowance, the allowance was revoked, and its history, read from the hosted indexer and checked against the head the wallet stores, verified with 5 entries. Horizon reports each of the four refused payments as an unsuccessful transaction in its ledger.

**How a refusal gets onto the ledger.** A payment the wallet refuses fails in simulation, and a failed simulation does not say which ledger entries the transaction would touch, so it cannot be assembled in the usual way. The script simulates a payment the wallet would make, of the same shape, and keeps what that one needs. For the limit and the recipient cases it then has the agent sign the refused payment under the same nonce, so that the two need the same entries. For the pause and the revocation it is simpler: the payment that is submitted is the one that was simulated, and what changed in between is the owner's action. Each refused payment is simulated once more just before it is sent, and the script stops unless the wallet's answer there is the one expected; the reason in the tables is then read from the failed transaction's own diagnostic events.

**What the reasons are evidence of.** That the wallet contract refuses these payments on the ledger whoever submits them, with nothing in the SDK, the agent's tool or the server standing in the way: the script sends them deliberately.

An earlier run the same day, written to a scratch file while the script was being written, gave the same outcomes for agent 6.

## A model as the agent

The hosted demo's validation ended with no model having completed the set-up. On 2026-11-27 the owner reported that Claude Code, in the Claude desktop app, had set itself up from the pasted sentence with the published npm package and bought something. This was not observed here; what the ledger shows is consistent with it. The owner's wallet, `CAHTJC67Z5LDXNDS6WXAEHKIVFZORDKOPJOGLEN2337JRWLBKNSJCZI7`, has a purchase signed by agent 5's key, the one set up on that machine, at 16:46 UTC: [`e2e13aa6…5aa526`](https://stellar.expert/explorer/testnet/tx/e2e13aa62f17e9c09ef67b7086f1b159f0c4a683e2fe92a71063cf4d9e5aa526). An earlier agent of the same owner made one too: [`6e4363eb…73019f`](https://stellar.expert/explorer/testnet/tx/6e4363eb07f85c605cc226a401ab1d0d6f41499410b98869cb73f2992973019f). The wallet's history verifies with 7 entries.

## Screenshots

Taken on 2026-11-28 by a script driving headless Chrome through the hosted page as a guest: set up the wallet, approve the suggested allowance for the sample agent, give it the brief, the dataset and the cheapest headlines, end the allowance, and ask for the brief again. They are in `docs/evidence/`. The script is not in the repository; the browser test does the same on a local network.

## Found and fixed on the way

- **The agent's tool said an empty recipient list meant anyone.** The wallet pays only listed recipients. The `allowance` tool now reports the list as it is. Nothing was paid wrongly: the wallet decides, not the tool.
- **The page said "confirmed" a moment before it showed the result.** After an allowance was approved, the agent's row still read "No allowance" until the next read came back, about a second later on Testnet. An action now ends when the page has read its state back. Seen in the first screenshots.
- **The browser test could pick the wrong way to the sample agent.** It decided how to open the sample agent's form before the agents section was drawn, and then waited for a button that a first-time owner is never shown. One CI run failed on it. It now waits for the section first. The screenshot script had the same fault.
- **A test read the developer's own home directory**, and failed on a machine where an agent is set up. Fixed with the x402 work the day before.
- **The deployment check required a local build to match**, which fails on Linux for a reason that says nothing about the deployment. It now reports it.

## Acceptance cases

| ID | Status |
| --- | --- |
| A29: the SOW scenario on Testnet, with deployment and readback | Met |
| A28: clean checkout, SDK import, CLI example, browser smoke | Met from a fresh clone on this machine, and in CI |
| A21: archival and restoration | Unchanged: host emulation only. Not observed on a public network |

## Limits and open points

- **The demo video is not made.** The statement of work lists it as evidence for deliverable 2.
- **No outside review.** The operations notes say what the design is meant to withstand and where that is tested. That is the author's reasoning.
- **The acceptance scenario depends on the hosted service** for the agent's set-up, its verification and the faucet. With the service down it can be pointed at any server started from this repository, on a deployment of its own.
- **The refusals were sent on the wallet's `execute` path.** The account path, which x402 purchases use, refuses for the same reasons in the contract tests and in the local and Testnet suites; no failed account-path transaction was put on the kept deployment.
- **The daily and total limits** are not in the Testnet scenario. They are in the contract tests and the local suites, and the daily limit is in the demo.
- **Archival** was not observed on a network.
- **Three sellers outside this project refuse the wallet**, as recorded in [x402 validation](X402_VALIDATION.md). The demo's own sellers accept it.
- **The hosted page does not yet have the "confirmed" fix**; it is deployed with the next release of the server.
- **Linux builds differ** from the deployed contracts in two of three hashes; see above.
