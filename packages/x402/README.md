# x402

Payments over [x402](https://x402.org) from a policy-limited smart wallet on Stellar. The agent holds no funds: it signs with its key for one policy, the wallet's limits apply on the ledger, and a facilitator pays the fee. The design and what was found on the way are in [ADR 0012](../../docs/decisions/0012-x402-and-payee-gate.md).

It uses x402's own packages, `@x402/core` and `@x402/stellar`, and adds what the wallet needs.

| Part | What it is |
| --- | --- |
| `walletClient`, `WalletExactScheme`, `fetchPaying` | The paying side. An x402 client whose payer is the wallet |
| `StellarExactFacilitator` | A facilitator for any network, including a local one |
| `tolerantUpstreamFacilitator` | The published facilitator, accepting a wallet as payer; Testnet and mainnet |
| `payeeGate`, `checkPayer` | A payee's own check on the paying agent |
| `createPaidService` | A paid resource over `node:http`, served by x402's resource server |

## Paying

```ts
import { walletClient, fetchPaying } from '@stellar-agent-auth/x402';

const client = walletClient({ wallet, policyHash, agent, context, server });
const { response, settlement } = await fetchPaying(client, 'https://api.example/report');
```

`fetchPaying` makes the request, and if the answer is 402 pays once and asks again. Three things can happen instead of a paid answer:

- **The wallet refuses.** `fetchPaying` throws a `WalletError` with the wallet's reason, such as `PaymentLimitExceeded`. Nothing was signed or sent to the service.
- **The service refuses the payment.** The response is 402 again and `required.error` says why, such as `payee_gate_CheckNotPassed`. Nothing was settled.
- **The service fails after taking a payment.** `settlement` carries the transaction to ask about.

## Being paid

```ts
import { createPaidService, inProcessFacilitator, StellarExactFacilitator, payeeGate } from '@stellar-agent-auth/x402';

const facilitator = inProcessFacilitator(network, new StellarExactFacilitator({ context, signer, journal }));
const service = await createPaidService(network, facilitator, [{
  path: '/report', description: 'A report', price: { asset, amount: '10000000' }, payTo,
  gate: payeeGate({ server, networkPassphrase, walletCode, agentRegistry, verificationRegistry, provider, requirement }),
  handler: (payer) => ({ report: '...' }),
}]);
// In a node:http handler: if (await service.handle(request, response)) return;
```

The facilitator's signer pays fees and authorizes nothing. A payment is refused if the signer appears in it anywhere.

## Which facilitator

- On a **local network**, `StellarExactFacilitator`. The published code does not know a local network. Its network name here is `stellar:standalone`.
- On **Testnet or mainnet**, either. `tolerantUpstreamFacilitator` is the published code with one allowance; give it a fee ceiling that leaves room for a new wallet's first payment.
- **Someone else's facilitator** on the published code refuses a wallet as payer, because the wallet publishes its audit entry while it authorizes the payment. That is the limit of this package: it works where the facilitator makes the allowance.

## Tests

```sh
npx vitest run --project unit tests/unit/x402.test.ts          # the rules, without a network
npx vitest run --project local tests/integration/x402.test.ts  # end to end on the local network
RUN_TESTNET_TESTS=1 RUN_TESTNET_X402=1 npx vitest run --project testnet tests/testnet/x402.test.ts
```

The Testnet test deploys a throwaway world and submits transactions. Set `X402_EVIDENCE` to a file path to keep the transactions it made.
