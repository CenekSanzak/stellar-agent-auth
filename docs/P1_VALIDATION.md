# P1 validation

On 2026-11-04, `npm run check` passed with 15 TypeScript tests, two Rust tests and five WASM builds. The two local RPC tests also passed using those builds.

Run `npm run check`, then start the pinned protocol 29 Quickstart with `npm run dev` and run `npm run test:integration -- --disableConsoleIntercept` to reproduce the resource measurements. The Rust and TypeScript tests consume the same three digest fixtures. The fixtures cover mixed address types, unordered policy sets, an amount above JavaScript's safe integer range and the maximum `u64` sequence.

## Native authorization

The local probe deploys with owner authorization. A sponsor acting as the deployer cannot supply that authorization. The owner writes the representative policy, a separate agent signs the exact transfer invocation and a separate sponsor signs the transaction envelope. The RPC confirms a 123-unit native SAC transfer. Wallet and recipient balances change by exactly 123 units. The returned action hash and the emitted audit entry and hash match the SDK, including the previous audit hash.

The local RPC enforces real Soroban credentials in the negative cases. It rejects changes to the amount, recipient, asset, policy hash, sequence, deadline, wallet argument or target contract, and rejects sponsor-only credentials, an entry signed for Testnet, an expired entry and reuse of the confirmed entry's nonce. The SDK also refuses mutated actions before signing and rejects expiration outside its 20-ledger window.

## Resource measurements

The probe writes and emits representative records and a bounded maximum case. The maximum case uses four asset limits, 32 allowed and 32 blocked recipients, eight checks, both action kinds and a 2,048-byte URI. It submits the policy sets in reverse order so the transaction includes the cost of canonicalizing them on chain. The sponsored transfer measures the direct native asset path with an audit event.

The local Quickstart uses the Testnet limits profile. A read of public Testnet ledger 5,550,945 on 2026-11-04 returned matching limits for the dimensions measured here. The sample fees come from the local simulation and exclude the base inclusion fee. The instruction values are the simulated resource declarations. Event sizes are committed event XDR lengths.

| Resource | Representative records | Maximum records | Sponsored transfer | Transaction limit |
| --- | ---: | ---: | ---: | ---: |
| Policy value, XDR bytes | 912 | 4,480 | — | — |
| Identity value, XDR bytes | 336 | 2,356 | — | — |
| Assessment value, XDR bytes | 712 | 1,480 | — | — |
| Signed envelope, XDR bytes | 4,624 | 17,336 | 1,868 | 132,096 |
| Committed event XDR bytes | 1,824 | 4,612 | 1,044 | 16,384 |
| CPU instructions | 2,319,880 | 4,656,312 | 2,271,916 | 400,000,000 |
| Disk read bytes | 0 | 0 | 288 | 200,000 |
| Write bytes | 2,828 | 9,184 | 928 | 132,096 |
| Write entries | 5 | 5 | 4 | 200 |
| Footprint entries | 6 | 6 | 8 | 400 |
| Largest changed entry, XDR bytes | 996 | 4,564 | 484 | 65,536 |
| Minimum resource fee, stroops | 29,152 | 1,049,430 | 21,706 | — |

These measurements establish that the P1 interface fits at the chosen caps. The fixture covers authorization, direct transfer and representative storage and events. P4 must measure the full execution path with live registry reads, budget and revocation checks. The deeper service call remains a P9 gate. See [the ABI and signing decision](decisions/0002-v1-abi-and-authorization.md).
