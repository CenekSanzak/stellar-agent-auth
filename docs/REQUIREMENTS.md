# Requirements and evidence ledger

Status: P0 infrastructure implemented; domain acceptance remains pending. Do not mark a milestone complete because its scaffold builds.

| Source requirement | Acceptance IDs | Evidence required | Implementation phase |
| --- | --- | --- | --- |
| SOW D1 / README M1: identities, signer and time-limited approved verifier | A01-A07, A25 | Signed registration/result readback; provider/revision/expiry failures; coverage mapping | P2-P3 |
| SOW D2 / README M2: custody, limits, approved assets/recipients, pause and revocation | A08-A22 | Signed success and rejections; exact balance/state assertions; rollback and restoration | P4 |
| SOW D3: developer kit, demo, tests, deployment and guide | A23-A29 | External SDK import, CLI/browser flow, Testnet IDs/links, clean setup and recording | P5-P8 |
| README M3: restricted service-contract integration | A30 | Actual service transaction and method/argument/auth rejection tests | P9 |
| README M4 / architecture: durable audit and all CI acceptance | A26-A30 | Reconstructed audit head, gap/restart tests, CI results and final deployment evidence | P6-P9 |
| Architecture: per-asset UTC budgets and combined exposure | A15-A17, A22 | Boundary/concurrency tests and owner policy display | P4, P7 |
| Architecture: persistent revocation and storage maintenance | A18-A21 | Archived/restored security state and maintenance guide | P4, P8 |
| Architecture: unsupported verification is not a pass | A04-A07, A25 | Explicit coverage outcomes, report hashes, visible fixture labels | P3, P7 |
| SOW exclusions | N/A | No security-audit/full-ERC/consumer-wallet claims | All phases |

## Acceptance cases (all pending domain implementation)

| ID | Case | Required evidence |
| --- | --- | --- |
| Additional repository milestone work | One restricted service-contract adapter and its argument/auth tests; complete the corresponding SDK/CLI/demo flow | Required before claiming README milestone 3 in full |
| A01 | Register/read identity; unauthorized update; new signer proof | Registry tests plus signed integration |
| A02 | Metadata/key/disable revision changes | Old verification and already signed old-policy requests fail |
| A03 | Unapproved/disabled/wrong provider; unauthorized publish/revoke | Registry and signed authorization tests |
| A04 | Current result, expiry boundary, stale age, future issue time | Ledger-time-controlled contract tests |
| A05 | New failure replaces pass; revoked result; old publication sequence | No fallback to an older passing result |
| A06 | Required unsupported/absent/inconclusive/not-applicable check | All deny; actual unsupported coverage visible |
| A07 | Risk at threshold/above threshold; serious wallet-risk flag | Boundary passes/fails; flag blocks regardless of average |
| A08 | Unauthorized policy/withdraw/pause/resume/replacement | Distinct roles; sponsor and agent cannot act as owner |
| A09 | Fund and withdraw while agents paused | Exact balance changes; funding grants no authority |
| A10 | Allowed signed 3-unit transfer | Recipient/wallet balances, budget, sequence and audit increment once |
| A11 | Invalid/missing signature, mutated fields, wrong wallet/network | Real signed entry mutation matrix rejects every case |
| A12 | Same auth replay, duplicate action with fresh auth, wrong application sequence | One committed action; no double spending |
| A13 | Authorization ledger expiry, action deadline, policy start/end | Separate exact-boundary tests |
| A14 | Empty allowlists, unapproved asset/recipient, explicit block override | Fail closed in contract, independent of SDK |
| A15 | Per-transfer cap; zero/negative/overflow amounts | Exact cap accepted; above cap and malformed amounts rejected |
| A16 | Cumulative daily cap, independent assets/policies, UTC rollover | Exact limit and midnight boundaries; no cross-asset arithmetic |
| A17 | Multiple pending requests near a cap or with the same sequence | Final total never exceeds cap; one winner per sequence |
| A18 | Pause then resume; terminal revocation; revoked policy-ID reuse | Resume restores only eligible policies; revocation stays effective |
| A19 | Request signed before confirmed revocation/provider failure/identity update | Later execution blocked against live state |
| A20 | Failed token/service call after provisional accounting | Balances, budgets, sequence and audit head unchanged |
| A21 | Archived/restored policy, counters, revocation, result and contract | No budget reset or permission resurrection; expired items still fail |
| A22 | Policy replacement and additive owner exposure | Old policy revoked atomically; new budget explicit |
| A23 | Rust/TS encoding, large integers, collection bounds | Golden hashes, exact decimal conversion, resource-bound tests |
| A24 | Sponsor tampering, sequence collision, uncertain submission/retry | No authority gain or duplicate committed action |
| A25 | Metadata hash mismatch, redirects/private IP, timeout/oversized body | Verifier input tests; no unsafe fetch accepted |
| A26 | Index restart/duplicates/crash/cursor transaction | Durable, idempotent event history |
| A27 | Audit mutation/missing entries/retention gap | Correct mismatch or incomplete status; no false completeness |
| A28 | Clean checkout SDK import/CLI example/browser smoke | Full verify -> authorize -> execute -> revoke workflow |
| A29 | Testnet SOW scenario and deployment/readback | Contract IDs, real transaction/result evidence and guide |
| A30 | Restricted service call and all argument/auth bypass attempts | P9 tests plus actual service-call evidence for milestone 3 |

## P0 evidence

See [the local validation record](P0_VALIDATION.md) for commands, results and limits.

- F01: locked npm installation and workspace/source/test typecheck.
- F02: deterministic SDK configuration tests reject inconsistent signing domains and invalid public configuration.
- F03: Rust Soroban host dispatch test executes the probe through a generated contract client.
- F04: four WASM artifacts build with the pinned CLI; these do not implement the planned business entry points.
- F05: local-network test checks live RPC health, passphrase and protocol. Requires a working Docker daemon.
- F06: separate opt-in Testnet metadata check; no secrets or payments.
- F07: CI scripts reject empty test suites, and public network availability is excluded from required checks.

The included local SOW is a source document, not a public deployment artifact. The full scope and relative-day schedule are in IMPLEMENTATION_PLAN.md. No P0 test substitutes for A01-A30.
