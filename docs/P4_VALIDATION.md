# P4 validation

On 2026-11-04, `npm run check` passed:

- 369 TypeScript unit tests in nine files;
- 73 Rust tests:
  - 30 smart wallet;
  - 23 verification registry;
  - 14 agent registry;
  - 3 shared-types attestation;
  - one each for the ABI vectors, metadata validation and the auth probe;
- five WASM builds with the pinned Stellar CLI 30.0.1.

The typecheck, Rust format check and clippy with warnings denied also passed. On freshly started protocol 29 Quickstart networks, the local project passed 43 tests in seven files in two consecutive runs, about 65 seconds each:

- 9 in `tests/integration/wallet-flow.test.ts`;
- 5 in `tests/adversarial/authorization.test.ts`;
- 5 in `tests/adversarial/limits.test.ts`;
- the 24 P1–P3 tests, unchanged.

To reproduce:

1. Run `npm run check`.
2. Start the network with `npm run dev`.
3. Run `npm run test:integration -- --disableConsoleIntercept` to print the resource measurements.
4. Remove the network with `npm run local:down`.

Every role is a separate account generated at runtime and funded by the local Friendbot: admin, owner, controller, agent signer, sponsor, provider, funder, asset issuer, recipient, stranger and attacker. No key material is committed. Each suite issues its own test asset, sets up trustlines and deploys its Stellar Asset Contract. The provider is a `Fixture` provider whose results are labelled SIMULATED, because the wallet consumes results, not assessments. The real limited verifier is exercised in P3. Nothing is deployed to a public network in P4.

The validated tree is uncommitted P4 work on top of 26a521f.

- **Smart wallet WASM:** 27,858 bytes, SHA-256 `9c4525117a8239ac2c118bdb13879d49acbed0f392d38c9cbae3af1ce683563f`. It exports the constructor and the entry points in [ADR 0005](decisions/0005-smart-wallet.md).
- **Agent registry:** 8,912 bytes, `bfde5a8959fcac85f74195689164c95b52ef05bee78739c90ef0e696896d4e4d`.
- **Verification registry:** 16,632 bytes, `6d22a4a57354ef3b6381e3ff4ea34f933c5203bc7572e1209a70c541d6010dd0`.

Both registries now differ from the code deployed at the P3 Testnet checkpoint. I compared the deployed bytes with the rebuilt ones section by section:

- **Interface specification:** grows by exactly 280 bytes in each, for the new `TransferFailed` error.
- **Data section:** 8 bytes differ in each.
- **Code section:** the agent registry's is byte-identical. The verification registry's differs in one byte, consistent with its contract-error range check moving from 13 to 14.

The checkpoint therefore remains a record of the earlier build. The final Testnet deployment in P8 redeploys all three contracts.

## SOW deliverable 2 gate

| Gate item | Evidence |
| --- | --- |
| A signed 3-unit payment under a 5-per-payment, 20-per-UTC-day, seven-day policy succeeds | `wallet-flow` "SOW gate" with real agent and owner signatures, sponsor-submitted; host `signed_three_unit_payment_succeeds_once` |
| Over-limit payment fails | `wallet-flow` (6 units: `LimitExceeded`); `limits` (cap + 1 stroop, and one unit over the 20-unit day) |
| Unapproved-recipient payment fails | `wallet-flow` and `limits` (`PolicyDenied`) |
| Post-revocation payment fails | `wallet-flow`: a payment signed and simulated before revocation is submitted after it and fails on the ledger, with no state or balance change |
| Wallet security cases in section 5 pass | A08–A22 below |
| Rollback of balances, counters, sequence and audit head | `wallet-flow` on-chain failure after a successful simulation; host tests with a failing asset contract and with an insufficient balance |

In the gate payment, units are whole asset units of seven decimals, so the 3-unit payment moves 30,000,000 contract units. The test checks that it changes the following exactly once:

- the recipient's balance and the wallet's balance;
- the policy's next sequence, from 1 to 2;
- today's spend, set to 3 units;
- the audit head.

The `audit_v1` event's entry is rebuilt by the SDK byte for byte, chained to the previous head and hashed to the stored head.

## Acceptance cases

| ID | Evidence |
| --- | --- |
| A02 (old policy) | A request signed before a metadata update fails with `IdentityChanged` on the local ledger. Approving a policy for the old revision fails too. In host tests, a signer rotation and a disable also fail. |
| A08 | In host tests, the funder, controller, provider and attacker cannot approve, revoke, replace, pause, resume or withdraw. On the local network, the agent signing as owner fails as forged; the sponsor submitting, and the agent as transaction source, fail as missing. A funder signing as owner fails as forged. |
| A09 | Funding and withdrawal while paused move exact amounts. Funding needs only the funder, adds no audit entry and grants no authority. A funding signature cannot cover a larger amount or another source. |
| A10 | The gate above. |
| A11 | A real signed entry is rejected when its request is mutated: amount, recipient, asset, sequence, deadline, policy, or wallet field. It is also rejected when sent to another wallet holding identical terms, when signed by an attacker or owner key, when signed under the Testnet passphrase, and when missing. |
| A12 | A replayed confirmed entry fails on the host nonce. The same request with fresh authorization fails with `InvalidSequence`. The balances show one committed transfer. |
| A13 | An authorization expiring one ledger ahead fails once the ledger passes it. A request at its deadline fails with `Expired`. Host tests cover the exact `valid_after`, `valid_until` and deadline boundaries, and the local network covers a not-yet-valid policy and approval of an ended window. |
| A14 | An unapproved asset (native XLM's asset contract), a recipient both allowed and blocked, an unlisted recipient and an empty allowlist all fail with `PolicyDenied`. This holds in host tests and on the local network, without the SDK. |
| A15 | The per-transfer cap passes exactly and fails one unit above. Zero and negative amounts signed directly fail with `InvalidInput`. Daily-spend overflow fails with `ArithmeticOverflow` in host tests. |
| A16 | The exact 20-unit day passes and one more stroop fails. In host tests, one second before UTC midnight still fails and midnight resets the budget. Two assets in one policy, and two policies, keep separate budgets. |
| A17 | Two different requests signed for one sequence are submitted together from two fee payers: one commits and the other fails on chain. A request signed in advance for the next sequence fails `LimitExceeded` when it would cross the cap. A seeded 300-step property test checks every committed and rejected payment against a model of the caps. |
| A18 | Pausing blocks execution, and resuming restores only active, in-window policies. Revocation is permanent. A revoked policy ID cannot be approved again, even with different terms. |
| A19 | Requests signed before a revocation, identity update, provider disable, result revocation, newer failing or flagged result, or result expiry fail against live state. The first two are tested on the local ledger, the rest in host tests. |
| A20 | On the local network, an agent request was simulated and signed, then the owner emptied the wallet. The request failed on chain with no change to sequence, spend, audit head or balances, and re-simulation reports `TransferFailed`. Host tests show the same for a failing asset contract after every wallet check passed. |
| A21 | In host tests, ledgers advance past every entry's TTL and the host restores entries automatically, as protocol 23 transactions do. The revoked state, sequence, spend, audit head and ID reservation come back as stored, a revoked ID stays reserved, and an ended window stays expired. Host tests also check that every touched entry is extended to 30 days. Local-network archival is not exercised, because the minimum persistent TTL makes it impractical in a test run; the [maintenance notes](decisions/0005-smart-wallet.md#storage-ttl-and-restoration) cover operations. |
| A22 | Replacement revokes the old policy and approves the new one in one transaction, with two chained audit entries. A replacement that fails rolls back the revocation. `policyExposure` reports the fresh budget and the summed daily cap per asset. |
| A23 (wallet) | SDK decoders for `Policy`, `PolicyState` and `AuditHead` are strict and round-trip `u64::MAX` sequences and `i128::MAX` amounts. Every SDK signer handles legacy and CAP-71 AddressV2 credentials. Resource figures are below. |

## Resources

Measured by simulation on the local protocol 29 network for the gate payment, which includes cross-contract calls to both registries and the asset contract:

- 4,849,451 instructions;
- 2,640 transaction bytes;
- 1,104 event bytes;
- 268 disk read bytes and 1,432 write bytes;
- 5 written entries out of 16 footprint entries;
- a largest entry of 584 bytes;
- a minimum resource fee of 75,624 stroops.

All are well inside the network limits checked by `assertResourceFit`.

## Findings during P4

- **Asset errors were decoded as wallet errors.** The Stellar Asset Contract reports an insufficient balance as `Error(Contract, #10)`, which a wallet client reads as `VerificationDenied`. The wallet now turns any asset refusal into `TransferFailed` and still rolls back. The host test that found this now asserts the specific error.
- **Recording-mode simulation returns no authorization entries for calls the contract rejects.** Rejection tests on the local network build the expected entry by hand and sign it through the same SDK validator, as the P3 suite does.
- **Parallel suites raced to install the same contract code.** One upload failed on chain because it needed 119 more instructions than simulated, after another suite's identical upload landed first. The local-network helper now skips installing code that is already present, and accepts a failed upload only if the code is then on the ledger. The P3 suite uses the same helper.
- **The test host cannot mock a specific account's authorization.** Host tests therefore assert the exact recorded authorization of `execute`: the signer, the request and no child calls. Real signed entries and their tampering are tested on the local network.

## Not covered here

- UTC midnight on a live ledger. The local clock cannot be moved, so the boundary is covered by host tests.
- Archival and restoration on a live network. These are covered by host emulation; P8 covers maintenance on Testnet.
- Whether the two racing requests land in the same ledger. The test shows one commit either way.
- A Testnet wallet deployment. The SOW gate does not require one; it is part of P8.
