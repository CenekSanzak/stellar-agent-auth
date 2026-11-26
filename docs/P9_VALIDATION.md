# P9 validation

P9 gives the smart wallet a second payment path, as a custom account, and makes the last changes to the contract interface before the indexer, the demo and the final deployment are built on it. The plan was revised on 2026-11-25 to put it here ([implementation plan](IMPLEMENTATION_PLAN.md)). It has four parts:

- the account payment path and service payments ([ADR 0007](decisions/0007-account-payment-path.md));
- a demo service that pulls its payment, and the CLI command `execute pay`;
- one error code per cause ([ADR 0008](decisions/0008-error-codes.md));
- an optional total cap on each asset limit (ADR 0008).

The spike that led to it is recorded in [ADR 0006](decisions/0006-custom-account-spike.md).

## What was run

On 2026-11-25, on macOS arm64 with Node 24.22.2, Rust 1.98.0 and Stellar CLI 30.0.1:

| Suite | Result |
| --- | --- |
| `npm run check` | Passed: 437 unit tests in 14 files, 100 Rust tests, six WASM builds, 4 spec tests |
| `npm run test:integration`, protocol 29 Quickstart | Passed: 60 tests in 11 files |
| Wallet scenario on Testnet, protocol 30 (`RUN_TESTNET_WALLET=1`) | Passed: 5 tests |
| Default Testnet preflight (`RUN_TESTNET_TESTS=1`) | Passed: 1 test; the two transactional suites skipped, as intended |

The 100 Rust tests are 48 in the smart wallet, 23 in the verification registry, 14 in the agent registry, 8 in the spike's test contract, 5 in shared-types and 2 in the demo service. Of the wallet's 48, 30 are the P4 tests with their expected error codes updated and one case changed, and 18 are new for the account path and the total cap.

Each suite passed in its final run. Flakiness over repeated runs was not measured.

To reproduce: `npm run check`, `npm run dev`, `npm run test:integration`, `npm run local:down`, and for Testnet the command in [development setup](DEVELOPMENT.md).

## P9 gate

> A service is paid through the account path with a real agent signature on the local network and on Testnet. Every other context, asset, recipient, amount, policy or signature is refused. The two paths together never exceed a policy's caps, and a failed transfer leaves budgets and the audit head unchanged.

| Gate item | Evidence | Status |
| --- | --- | --- |
| A service is paid on the local network | `account-path.test.ts`: the demo service is paid in its own call through a sponsor configured only for the service's method. `payment-flow.test.ts` does the same through the built CLI and submitter. | Met |
| A service is paid on Testnet | The same scenario on protocol 30; transaction below. | Met, from a throwaway deployment |
| Everything else is refused | Host tests with enforced authorization: `approve`, `burn`, `transfer_from`, another holder's funds, a call on the wallet, another service or method, another service ID, terms that differ between call and transfer, the transfer before the call, an allowance below the call, two or three calls, no call, a deployment. On both networks: over the cap, an unlisted recipient, another key, an unknown policy, an allowance, an amount other than the signed one, no entry. | Met |
| The two paths never exceed the caps together | Host: `execute` and the account path alternate to the daily cap and to the total cap, then both refuse, across a day boundary. Both networks: the same for the daily cap. | Met |
| A failed transfer changes nothing | Host: a payment within every cap but above the balance leaves the policy state and audit head unchanged. | Met in host tests; not reproduced on a network |

## Testnet evidence

From the run on 2026-11-25. Every contract was deployed in that run from keys generated at runtime and funded by Friendbot. The keys were not kept, so nobody controls this deployment any more. It is evidence that the path works on Testnet, not the project's Testnet deployment; that is P8.

| What | Value |
| --- | --- |
| Protocol | 30; simulation recorded CAP-71 `AddressV2` credentials |
| Smart wallet | `CBFOZEQRIKUFDWEJA32BC7ZI5QZLHPSTVATYVFOUMLIDLOJLPQKZZV3L` |
| Plain account payment | [`284a96a5…245592`](https://stellar.expert/explorer/testnet/tx/284a96a5365e2af99b10b4e7df3e94ee5ccbbcfb702f34dbec841a34ef245592), ledger 5,918,767 |
| Service payment | [`2f516516…7cd369`](https://stellar.expert/explorer/testnet/tx/2f516516411125ad3fd1b9b26abdb42755022c547411ab23fa10fc76f27cd369), ledger 5,918,784, to service `CA3DQJAVB2TWM4AEKSF7G6R5EYYNGLRNVZMPZITAPPUL6ZIRO5XHBTM5` |
| Cost of a plain account payment | 4,833,984 instructions, a minimum resource fee of 23,422 stroops |

The same run also made payments through `execute` on Testnet, as part of the shared-budget test.

On Testnet the RPC returns no diagnostics, so each refusal on the account path is seen only as `Error(Auth, InvalidAction)`. Where one of the wallet's own rules refuses, `check_payment` gave the reason there; on the local network the diagnostics give it for every case.

## Built contracts

| Contract | Bytes | SHA-256 |
| --- | --- | --- |
| Smart wallet | 41,377 | `568ccc8e662a83f0011ee6c265681e8d887780336cce0173962a61a0625dd4b9` |
| Agent registry | 11,081 | `b99cf6c5bbaa29e8ab586ab175343cdb637dcee4918ba0b728f3b728519d6928` |
| Verification registry | 18,806 | `41b7f41ffc66d6a17c8625ec81225ea6a772e09d4c2a1d589fe0df9d55af61dd` |
| Demo service | 8,734 | `0c6645b9057d681e6a6220e985f5a2f2c1ed7e778d584e731d3f76d5acbade34` |

The wallet was 27,858 bytes in P4. Both registries changed because the error list they export grew; the agent registry's behaviour changed only in the code it returns for a disabled identity, and the verification registry's only in its codes.

## Acceptance cases

| ID | Evidence | Status |
| --- | --- | --- |
| A30 | The P9 gate above. | Shown on the local network and on Testnet |
| A15 | The per-payment cap passes exactly and fails one unit above with `PaymentLimitExceeded`, on both paths. | Shown |
| A16 | The daily cap is `DailyLimitExceeded` and resets at UTC midnight. A total cap is `TotalLimitExceeded`, is charged by both paths and does not reset. Host tests show both paths across a day boundary; the local network shows it for `execute`. | Shown |
| A22 | `policyExposure` reports what is left of the total caps, or that the exposure is open-ended when a policy has none. | Shown in unit tests |
| A23 | The policy hash vector changed with the asset limit's new field. Rust and TypeScript each computed the new value before the fixture was updated. The spec test compares the SDK's encoding of the new entry points, the signature value and the 29 error codes with the built contracts. | Shown |

## Findings during P9

- **A plain transfer entry is not bound to a service.** Whoever holds it can make the transfer without the service running. The wallet therefore also authorizes a service's own call together with the transfer inside it, and the SDK signs that tree only.
- **The policy must be part of what the agent signs.** The host payload does not name it. A test approves two policies for one agent and shows that a signature made for the smaller one fails under the larger.
- **The public Testnet RPC gives no reason for an account-path refusal.** `check_payment` was added for that, and `execute pay` calls it before signing.
- **`wallet create` could fail when someone else uploaded the same code at the same moment.** It now treats that as harmless when the code is then installed.
- **The SDK's request check ran in a different order from the wallet's** for a request that was both past its deadline and not a transfer. It now follows the wallet.

## Not covered here

- A real x402 client or facilitator, and a payee-side verification gate, were not part of P9. Both were built afterwards: see [ADR 0012](decisions/0012-x402-and-payee-gate.md) and [x402 validation](X402_VALIDATION.md). Running x402's published code showed that the argument above was right about the payment's shape and incomplete about the rest: the published client and facilitator both refuse the wallet as they are.
- Rollback of a failed transfer on a network, for the account path. It is covered by host tests.
- The agent signing as an account. On the account path it signs as a key, and the signer account's own signers and thresholds are not applied. This is accepted and recorded in ADR 0007.
- Archival and restoration of the new state on a live network.
- A security review. This project does not include one.
