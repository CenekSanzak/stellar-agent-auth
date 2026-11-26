# Demo

An owner funds a wallet, lets one verified agent pay within limits, watches what it does, and stops it. The page is a small Vite and TypeScript app with no framework; behind it runs a server that plays the parts the owner does not. The design is in [ADR 0010](../../docs/decisions/0010-owner-demo.md) and what was tested in [P7 validation](../../docs/P7_VALIDATION.md).

It runs on the local network. The Testnet deployment, with a real assessment in place of the fixture, is P8.

## Run it

From the repository root, with Docker running:

```sh
npm run build:contracts     # once, and after a contract changes
npm run build
npm run dev                 # starts the local Stellar network
npm run demo:setup          # deploys everything except your wallet
npm run demo                # http://127.0.0.1:8790/
```

`demo:setup` writes `.local/demo/deployment.json`, a record of public addresses, and puts one key per role in a directory beside it. Run it again whenever the local network has been restarted: a fresh network has none of the contracts.

While working on the page itself, run `npm run dev -w @stellar-agent-auth/demo` next to `npm run demo` and open `http://127.0.0.1:5173/`. Vite serves the page and passes `/v1` to the demo server.

## What you do in the page

1. **Connect as the owner.** With Freighter, or on the local network with a key generated in the tab. The page never asks for a secret key.
2. **Create your wallet.** You sign the deployment; the wallet is yours and is bound to this deployment's registries.
3. **Add test funds.** The faucet's funder pays in 100 DEMO. That is the funder's signature, not yours.
4. **Approve a policy.** The form starts at 5 per payment, 20 per UTC day, seven days, to one recipient.
5. **Ask the agent to pay.** Eight buttons, each a fixed scenario: a payment within the limits, one above the per-payment limit, one to an unlisted recipient, payments up to the daily limit and one past it, a payment as an account, a payment to the demo service, a purchase from a paid API over x402, and a purchase from a stricter API that refuses the agent.
6. **Pause, resume, revoke.** Then ask the agent again and watch it be refused.
7. **Read the history.** Entries on the ledger are verified in the page against the wallet's stored head. Refusals are listed separately: they left nothing on the ledger.

## Who signs what

| Role | Where its key is | What it signs |
| --- | --- | --- |
| Owner | Your wallet extension, or the tab on the local network | Wallet creation, policies, pause, resume, revocation, withdrawals |
| Agent | The demo server | Payment requests, for the named scenarios only |
| Sponsor | The demo server, as the submitter | Transaction envelopes; it pays fees and authorizes nothing |
| Funder | The demo server | Faucet payments into the wallet |
| Facilitator | The demo server | Envelopes of x402 payments; it pays their fees and authorizes nothing |
| Admin, provider, controller, issuer | Used by the setup only | Deployment, provider approval, registration, the result, the asset |

The page reads balances, policies, the agent's identity and its verification result from the network itself, through the RPC. It takes only the deployment's addresses and the scenario list from the demo server.

## The demo server

`apps/demo/server`. It listens on loopback only.

| Route | What it does |
| --- | --- |
| `GET /v1/config` | The deployment's public addresses and the scenarios |
| `POST /v1/session { owner }` | Names the owner's wallet address. Once the wallet exists on the network, starts the sponsor and the indexer for it |
| `POST /v1/fund` | The funder sends 100 DEMO to the session's wallet, unless it already holds 1,000 or more |
| `POST /v1/payments { scenario, policy_hash }` | The agent runs one named scenario under that policy |

It also serves a paid API, which stands for someone else's service and takes no part in the session:

| Route | What it does |
| --- | --- |
| `GET /x402/report` | Answers 402 with a price of 1 DEMO. Paid through x402, it checks that the payer is a known wallet whose agent has a current result covering its metadata and signer account, then answers with the latest ledger |
| `GET /x402/audited-agents-only` | The same, but it also requires a code check. The demo's agent has none, so it is refused and not charged |

The agent buys from it with the wallet ([ADR 0012](../../docs/decisions/0012-x402-and-payee-gate.md)). On the local network the facilitator is this project's own; the published x402 code does not know a local network.

A caller chooses a scenario and a policy and nothing else. Amounts and recipients are decided in the server from the policy as the wallet stores it, so the server cannot be used to sign an arbitrary payment. It accepts JSON bodies only and checks the request's origin, so another page open in the same browser cannot drive the agent.

The sponsor is the same code as `services/submitter` and the indexer the same as `services/indexer`. The demo server starts both in its own process, because the wallet they serve is not known until the owner creates it. A deployment whose wallet is known in advance runs them as separate processes.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEMO_DIRECTORY` | `.local/demo` | Where the setup writes keys and the record, and the server keeps per-wallet state |
| `DEMO_DEPLOYMENT` | `<DEMO_DIRECTORY>/deployment.json` | The deployment record to serve |
| `DEMO_PORT` | `8790` | Port on `127.0.0.1` |
| `DEMO_ALLOWED_ORIGINS` | the Vite dev server | Other origins a browser may call from |

## What it does not show

- **The result is simulated.** On the local network the provider is a fixture provider and the page says so wherever the result appears. A local network cannot reach a public metadata URL, which a real assessment needs.
- **A refusal has no transaction.** The agent finds a refusal in simulation and submits nothing, as an agent should. The page shows the wallet's reason and no transaction link. A payment signed before a revocation and submitted after it, which fails on the ledger, is shown by `examples/payment-flow.ts`, not here.
- **Freighter is not covered by the automated tests.** They run in a browser without the extension and use the local demo key. It was tried by hand on the local network; see below and [P7 validation](../../docs/P7_VALIDATION.md). Signing through Freighter goes through the SDK's wallet adapter, which checks every signature it gets back.
- **One owner at a time.** A second owner connecting replaces the first one's session in the server.
- **The paid API uses a facilitator that accepts the wallet.** A service whose facilitator runs the published x402 code as it is would refuse the wallet's payment.

## Trying it with Freighter

Freighter accepts a custom network only with a Horizon address, and the default local network runs the RPC alone. Start it with Horizon instead:

```sh
npm run local:down
npm run dev:horizon
npm run demo:setup
npm run demo
```

In Freighter, add a custom network and select it:

| Field | Value |
| --- | --- |
| Horizon URL | `http://localhost:8000` |
| Soroban RPC URL | `http://localhost:8000/rpc` |
| Passphrase | `Standalone Network ; February 2017` |
| Friendbot URL | `http://localhost:8000/friendbot` |
| Allow HTTP | on |

Open `http://localhost:8790/` in the browser that has the extension and choose "Connect Freighter". Every owner action then opens Freighter's signing window. With Freighter switched to another network, connecting is refused with a message that names both networks.

## Tests

```sh
npx vitest run --project unit tests/unit/demo.test.ts                  # the wording of every state
npx vitest run --project local tests/integration/demo-backend.test.ts  # the server on the local network
npm run test:browser                                                   # the page in Chrome on the local network
```

The browser test uses the Chrome installed on the machine, through `playwright-core`. Set `DEMO_BROWSER_CHANNEL` to use another installed browser, such as `msedge`.
