# ADR 0008 · One error code per cause, and a total cap

Decided on 2026-11-25, in P9, before any wallet is deployed to Testnet. Both parts change the v1 interface, so they are made together.

## Problem

The v1 error list in [ADR 0002](0002-v1-abi-and-authorization.md) had 14 codes, and five of them stood for several causes each. `Revoked` could mean a revoked policy, a disabled agent, a disabled provider or a revoked result. `Expired` could mean a request deadline, the end of a policy window or a stale result. A client could report that a payment was refused, but not which rule refused it, and the demo exists to show exactly that.

## Decision

Keep codes 1 to 14 and their numbers. Add codes 15 to 29, so that each names one cause. The five overloaded codes keep one meaning each. Code 29 belongs to the total cap described below.

| Code | Name | Raised by | Meaning |
| --- | --- | --- | --- |
| 3 | `LimitExceeded` | all | A structural limit: too many assets, recipients, checks or active policies, or a value too long |
| 7 | `Expired` | wallet | The policy's validity window has ended |
| 8 | `Revoked` | wallet | The policy is revoked |
| 10 | `VerificationDenied` | wallet, verification registry | A registry answered in a way the caller did not expect |
| 11 | `PolicyDenied` | wallet | The policy does not permit this kind of action or this wallet; on the account path, the wallet was asked to authorize something other than a permitted payment |
| 15 | `AgentDisabled` | agent registry | The identity is disabled |
| 16 | `ProviderNotApproved` | verification registry | The provider was never approved |
| 17 | `ProviderDisabled` | verification registry | The provider was approved and later disabled |
| 18 | `ResultRevoked` | verification registry | The provider revoked its latest result |
| 19 | `ResultExpired` | verification registry | The result has passed its expiry, or is older than the consumer allows |
| 20 | `RiskFlagged` | verification registry | The result carries a serious wallet-risk flag |
| 21 | `CheckNotPassed` | verification registry | A required check is not `Passed` |
| 22 | `RiskTooHigh` | verification registry | The aggregate risk is absent or above the threshold |
| 23 | `RequestExpired` | wallet | The request's own deadline has passed |
| 24 | `NotYetValid` | wallet | The policy's validity window has not started |
| 25 | `AssetNotAllowed` | wallet | The policy does not list the asset |
| 26 | `RecipientNotAllowed` | wallet | The recipient is not on the allowlist, or is on the blocklist |
| 27 | `PaymentLimitExceeded` | wallet | The amount is above the cap for one payment |
| 28 | `DailyLimitExceeded` | wallet | The amount would take today's spend above the daily cap |
| 29 | `TotalLimitExceeded` | wallet | The amount would take everything spent under the policy above its total cap |

The other codes (`UnsupportedVersion`, `InvalidInput`, `Duplicate`, `NotFound`, `InvalidSequence`, `IdentityChanged`, `Paused`, `ArithmeticOverflow`, `TransferFailed`) are unchanged.

The wallet passes a registry's error through unchanged, so an agent payment refused for a revoked result fails with `ResultRevoked` at the wallet too.

## A total cap

A policy bounded each payment and each day, but not its whole life. A seven-day policy at 20 a day exposed 140, and nothing in the policy said so. A calendar-day budget also lets an agent spend one day's cap just before midnight UTC and another just after.

Each asset limit now has an optional `total`: the most that may ever be spent of that asset under the policy. The policy state keeps `total_spend` per asset, which never resets. Both payment paths charge it, after the daily cap, through the same `add_spend`.

- `total` must be at least the per-payment cap; a total that one payment could not fit under is refused at approval (`InvalidInput`). It may be below the daily cap.
- A policy without a `total` behaves as before. Its total spend is still counted.
- Replacing a policy starts a fresh total, as it starts a fresh daily budget. The owner's exposure view sums what is left of the totals, and says so when any policy has none.

This changes the policy and policy-state encodings, so the policy hash vector changed. Rust and TypeScript each computed the new one independently before the fixture was updated. The action and audit vectors are unchanged.

## What did not change

- The order of checks in every contract, apart from the total cap being checked after the daily cap. Only the code a check returns changed.
- Schema version 1, and the action and audit encodings and their hash vectors.
- `ResultExpired` still covers both a result past its own expiry and one older than the policy's maximum age. Both have the same remedy: run the verifier again.

## Consequences

- Earlier records use the old names. [ADR 0003](0003-agent-registry.md), [ADR 0004](0004-verification-registry.md), [ADR 0005](0005-smart-wallet.md) and the P2 to P5 validation records describe the same checks; where they say `Revoked`, `Expired`, `VerificationDenied`, `PolicyDenied` or `LimitExceeded` for one of the causes in the table, the code is now the one in the table.
- The registries deployed at the P3 Testnet checkpoint return the old codes. The final deployment in P8 replaces them.
- The SDK's `CONTRACT_ERRORS`, its explanations and its mirrors of the contract rules follow the table. The spec test fails if the SDK's list and a contract's published errors differ.
- On the wallet's account path a refusal still reaches the caller as a host authorization failure ([ADR 0007](0007-account-payment-path.md)). `check_payment` returns these codes for the same payment in advance.

## Evidence

Every Rust and TypeScript test that asserts a refusal asserts the specific code. The total cap has host tests on both payment paths across a day boundary, unit tests of the SDK mirror and the exposure view, and a local-network test. The counts for the whole of P9 are in the [P9 validation record](../P9_VALIDATION.md).
