# ADR 0012 · x402 payments from the wallet, and a payee's own check

Decided on 2026-11-26. It builds the two things [P9 validation](../P9_VALIDATION.md) listed as not covered: a real x402 client, and a payee-side verification gate.

## Problem

[ADR 0007](0007-account-payment-path.md) gave the wallet an account payment path so that a service could pull its payment, and said an x402 `exact` payment on Stellar has that shape. That was an argument from the specification. Nobody had run the wallet against x402's own code.

Separately, the wallet checks its agent's verification under the owner's policy. A service that is paid has no say in that: it cannot ask for a provider it trusts or checks it requires.

## What running the published code showed

x402's `exact` scheme on Stellar is `asset.transfer(payer, payee, amount)`. The payer signs only its authorization entry. A facilitator builds the transaction, pays the fee and submits it. The published packages are `@x402/core` and `@x402/stellar` (2.32.0).

Run on Testnet against a throwaway deployment:

| Tried | Result |
| --- | --- |
| A plain account, the published client and the published facilitator | Paid |
| The published client with the wallet as payer | Refused by the wallet. The client signs in the form a plain account uses; the wallet reads its own form, which names the policy |
| A wallet payment signed by this project's SDK, through the published facilitator | Refused: `invalid_exact_stellar_payload_event_not_transfer` |
| The same payment through the published facilitator with one allowance | Paid |

The third row is the important one. The facilitator simulates the payment and refuses it if any contract event is not the transfer. The wallet publishes its audit entry while it authorizes a payment, so there is always one more event. The scheme's specification asks for less than the code enforces: that the simulation show "only the expected balance changes" and no others. An audit entry is not a balance change.

Two smaller facts: the published code knows Testnet and mainnet only, and its default fee ceiling of 50,000 stroops is below the first payment a freshly deployed wallet makes (about 148,000, because of one-off rent; later payments cost about 23,000).

## Decision

A new package, `packages/x402`, with four parts. The wallet contract is not changed.

### The paying side

`WalletExactScheme` implements x402's client scheme for a wallet. It asks the wallet first (`check_payment`), so a payment the policy refuses fails with the wallet's reason before anything is signed. It then signs the wallet's entry with the agent's key for one policy, and returns the payload x402 expects. It plugs into `@x402/core`'s own client.

The client library's spend controls are switched off for it. They are a list in the agent's process, which the agent could change. The limits here are the owner's policy, enforced on the ledger.

### Two facilitators, one allowance

Both ignore contract events published by the payer itself, when the payer is a contract. Both still refuse events from any other contract, and events from the asset that are not the one transfer.

- **`tolerantUpstreamFacilitator`** is the published facilitator with its event check given that allowance, and nothing else changed. It is used on Testnet.
- **`StellarExactFacilitator`** applies the same rules, written on this project's SDK. It exists because the published code cannot be pointed at a local network, and a feature that runs only on Testnet cannot be tested in CI. It names the local network `stellar:standalone`, an identifier of this project's own.

The allowance is made in the facilitator and not in the wallet because the alternative is to stop the wallet publishing its audit entry during a payment, which is how the history is rebuilt ([ADR 0009](0009-durable-history.md)).

### A payee's own check

`payeeGate` is a hook for x402's resource server, run before a payment is verified. From the payment and the ledger it decides whether the paying agent meets the payee's requirement:

1. the payer is a contract running wallet code the payee knows, by code hash;
2. that wallet is bound to the registries the payee trusts;
3. the wallet's signed entry names a policy, the wallet says which agent the policy is for, and the verification registry says whether that agent has a result meeting the payee's requirement now.

Step 1 is what makes the rest worth anything. A contract of unknown code could name any agent it liked. A plain account is refused: it has no policy and no agent.

A refused payment is never verified or settled, so the payer is not charged.

### The demo

The demo server serves a paid API under `/x402/`, standing for someone else's service: it answers 402, is paid by whoever asks, and applies the gate. Two agent scenarios buy from it: one is served, and one meets a stricter requirement and is refused by the API without being charged.

## Consequences

- An agent with a policy-limited wallet can pay an x402-protected HTTP API, on a local network and on Testnet, with x402's own client and resource server.
- **A facilitator run by someone else, on the published code, refuses the wallet today.** The service chooses its facilitator, so the wallet pays only services whose facilitator makes the allowance. This is the main limit of the result. It would be removed by a change upstream, or by a wallet that does not publish during a payment.
- The allowance trusts a payer contract not to hide something in its own events. The facilitator's other checks do not depend on events from the payer: the transfer is read from the asset's event, and the balance moves or the transaction fails.
- A fee ceiling has to leave room for a new wallet's first payment, or one ordinary payment has to be made first.
- The gate trusts a list of wallet code hashes. A wallet upgraded to new code is refused until the payee adds its hash.
- `stellar:standalone` is understood by this package only.
- The hosted facilitators for Stellar were not tried.
