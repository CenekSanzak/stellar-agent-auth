# x402 validation

This records what was built and run for x402 payments from the smart wallet and for a payee's own check on the paying agent. Both were listed as not covered in [P9 validation](P9_VALIDATION.md). The decisions, and what running x402's published code showed, are in [ADR 0012](decisions/0012-x402-and-payee-gate.md); how to use the package is in its [README](../packages/x402/README.md).

What exists:

- `packages/x402`: the paying side for a wallet, two facilitators that accept a wallet as payer, a payee's gate, and a paid resource over `node:http`;
- in the demo: a paid API under `/x402/` and two agent scenarios that buy from it.

The wallet contract did not change.

## What was run

On 2026-11-26, on macOS arm64 with Node 24.22.2, Rust 1.98.0, Stellar CLI 30.0.1 and Google Chrome, with `@x402/core` and `@x402/stellar` 2.32.0:

| Suite | Result |
| --- | --- |
| `npm run check` | Passed: 516 unit tests in 17 files, 100 Rust tests, six WASM builds, 4 spec tests, both package checks |
| `npm run test:integration`, protocol 29 Quickstart | Passed: 81 tests in 14 files; 1 more is opt-in and was skipped |
| `npm run test:browser`, headless Chrome on the same network | Passed: 8 tests |
| x402 on Testnet, protocol 30 (`RUN_TESTNET_X402=1`) | Passed: 4 tests |

This work adds 13 unit tests (`tests/unit/x402.test.ts`), 7 local-network tests (`tests/integration/x402.test.ts`) and 4 Testnet tests (`tests/testnet/x402.test.ts`), and extends the demo's server test and browser test with the two scenarios.

Each suite passed in its final run. Flakiness over repeated runs was not measured.

## What it shows

| Claim | Evidence | Where |
| --- | --- | --- |
| An agent pays an x402-protected HTTP API from the wallet | A service answers 402; x402's own client creates the payment with the wallet as payer; x402's own resource server verifies, serves and settles. The wallet's balance falls by the price, the payee's rises, and the wallet's audit head advances by one. | Local network, Testnet |
| The fee is paid by the facilitator | The settled transaction's source account is the facilitator's. | Local network |
| The wallet's policy still decides | A price above the per-payment limit throws `PaymentLimitExceeded` before anything is signed or sent to the service. A paused wallet refuses with `Paused`. After revocation the demo's agent is refused with `Revoked`. | Local network |
| A payee can refuse an agent on its own terms | A route that requires a code check refuses the agent with `payee_gate_CheckNotPassed`. The wallet would have paid; nothing is verified or settled, and the balance does not change. | Local network |
| A payee does not believe an unknown payer | The gate refuses a contract of unknown code, a wallet bound to other registries, a payment that names no policy, and a plain account. | Unit tests, local network, Testnet |
| One signed payment pays once | The same payment header sent again is refused, and the balance does not change. | Local network |
| The published facilitator refuses the wallet as it is | `invalid_exact_stellar_payload_event_not_transfer`, on Testnet, through the full HTTP flow. | Testnet |
| The published facilitator accepts it with one allowance | The same code, ignoring the payer's own events, settles the payment. | Testnet |
| This project's facilitator applies the scheme's rules | Unit tests for each rule: version, scheme, network, operation, asset, function, recipient, amount, transaction source, missing or unsigned or long-lived authorization, another signer, sub-invocations, a failed simulation, a fee above the ceiling, and events beyond the one transfer. | Unit tests |

## Testnet

From the run on 2026-11-26, against a deployment made in that run from keys generated at runtime and funded by Friendbot. The keys were not kept.

| What | Value |
| --- | --- |
| Smart wallet | `CCQO4LIV7TP3U72CM4ERWVRGEIG5KQKQJSDUAMYNJFPAARKVSDXJC377` |
| Published facilitator, as it is | HTTP 402, `invalid_exact_stellar_payload_event_not_transfer`; nothing paid |
| Published facilitator, payer's events ignored | Paid: [`459777c2…6b9c76`](https://stellar.expert/explorer/testnet/tx/459777c2d678d5bddd6508f9977ab8a3aa16f108a23cba78715f2400226b9c76) |
| This project's facilitator | Paid: [`543fe07e…4931e6`](https://stellar.expert/explorer/testnet/tx/543fe07e7ec0b3838c63089fc132c5f632d3842b5569c2f4df267129474931e6) |
| A plain account at the gated service, with the published client | HTTP 402, `payee_gate_unknown_payer`; nothing paid |

Each facilitator had its own fee-paying account. One ordinary payment was made from the wallet before these, so that the one-off rent of a new deployment was not counted against the facilitators' fee ceilings; the published facilitator was also given a ceiling of 2,000,000 stroops in place of its default 50,000.

An earlier exploratory run, kept on the `spike-x402` branch, measured the fees: 16,652 stroops for a plain account's payment, 23,426 for the wallet's, and 148,197 for the first payment from a freshly deployed wallet.

## Sellers this project does not run

From the run on 2026-11-27 (`tests/testnet/x402-external.test.ts`, with `RUN_TESTNET_X402_EXTERNAL=1`). Three services registered in the [stellar-8004](https://github.com/trionlabs/stellar-8004) identity registry on Testnet (`CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH`), run by three different operators, each selling over x402 for Testnet USDC through a facilitator of its own choosing.

A throwaway wallet was deployed, its owner bought Testnet USDC for Testnet XLM on the network's exchange and put 1 USDC into the wallet, and approved an allowance in USDC for exactly these three payees. Each seller was asked to sell to the wallet, and then to a plain account using the published client.

| Seller | 8004 agent | Price | The wallet as payer | A plain account as payer |
| --- | --- | --- | --- | --- |
| RenderGate | 0 | 0.001 USDC | HTTP 402, `invalid_exact_stellar_payload_event_not_transfer`; nothing paid | Paid: [`3f5a8e62…27d10e`](https://stellar.expert/explorer/testnet/tx/3f5a8e621accb845c684d5f20833e23660c2cd7b246812f30ed0f8847427d10e) |
| Stellar Agent Services example | 163 | 0.01 USDC | HTTP 402, the same reason; nothing paid | Paid: [`2074a36e…0f78d2`](https://stellar.expert/explorer/testnet/tx/2074a36e2136d3441216653377c72a9b10cdae3931a6b5fd52bb836d700f78d2) |
| AgentEnact, EVM balance | 190 | 0.01 USDC | HTTP 402, the same reason, in the body; nothing paid | Paid: [`9440b355…3b706b`](https://stellar.expert/explorer/testnet/tx/9440b355394b978f53b23909f115a607c0223a2bf1fb5037538ca404263b706b) |

The wallet was `CCYNJ5B3IOMZ24S22ECRVXLHC7HFZNCMC43QA5YS5FMGLIXT4PH42TT5`. Its balance did not change. The keys were generated at runtime and not kept.

So the wallet's own check passed each time, the payment reached each seller, and each seller's facilitator refused it for the one reason measured above with the published code: the wallet's audit entry is an event beyond the transfer. The sellers work; they sold to a plain account minutes later. This is three sellers on one day, and says nothing about the rest.

The third seller answered its refusal without repeating its terms in x402's form. `fetchPaying` threw on that; it now returns the answer as a refusal, and the agent's tool reads the reason from the body.

## In the demo

The browser test buys from the paid API in the page: the purchase shows as confirmed with the API's answer and the transaction, the balance falls by 1 DEMO, and the history gains an account payment that verifies. The stricter API's refusal shows as refused, with the text that it was the API's own check and that nothing was paid; the balance does not change, and the refusal is listed with the other attempts.

## Limits and open points

- **Someone else's facilitator refuses the wallet.** A service chooses its facilitator. One that runs the published `@x402/stellar` code as it is refuses a payer that publishes events of its own, and the wallet publishes its audit entry on every payment. The specification asks only that there be no other balance change, so this may be stricter than intended, but it is what the code does. The wallet therefore pays only services whose facilitator makes the allowance.
- **Three sellers outside this project were tried, and all three refused the wallet** for that reason; see above. Other sellers and other facilitators were not tried.
- **The local facilitator is this project's code.** On a local network the protocol flow, the client and the resource server are x402's; the facilitator is not, because the published one cannot be pointed at a local network. Its rules are tested one by one, and it also settled a payment on Testnet.
- **`stellar:standalone`** is this project's own name for a local network.
- **Fee ceilings.** A new wallet's first payment costs several times a later one. A facilitator with a low ceiling refuses it.
- **The gate trusts a list of code hashes.** A wallet running other code is refused, whatever it would say about itself.
- **No refund path.** If a service fails after settlement, the payer has paid. x402 leaves that to the service.
- **The demo's Testnet setup does not exist yet.** The demo runs the paid API on the local network; on Testnet the same package is shown by the Testnet test. The kept deployment is P8.
- Not reviewed by anyone else.
