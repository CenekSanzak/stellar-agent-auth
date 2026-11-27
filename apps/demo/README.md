# Agent Wallet, the demo

A smart wallet that AI agents can pay from, inside allowances its owner sets: how much per purchase, per day and in total, which sellers, and until when. The owner can freeze the wallet or end an allowance at any time. Two kinds of agent use it. The owner's own, in Claude Code, Codex or any MCP host; and Scout, a sample agent that runs on the site, for seeing an allowance at work without setting anything up. Agents buy from sample sellers over x402.

It is hosted at **<https://stellar-agent-wallet.fly.dev/>**, on Stellar Testnet, and can be tried there as a guest with nothing installed.

The page is a small Vite and TypeScript app with no framework. Behind it runs one server that plays every part the owner does not. It runs on a local network and on Testnet, and it can be hosted so that anyone can try it. The design is in [ADR 0013](../../docs/decisions/0013-hosted-demo.md), what was tested in [the validation record](../../docs/HOSTED_DEMO_VALIDATION.md), and how to host it in [hosting](../../docs/HOSTING.md).

## Run it on a local network

From the repository root, with Docker running:

```sh
npm run build:contracts     # once, and after a contract changes
npm run build
npm run dev                 # starts the local Stellar network
npm run demo:setup          # deploys everything except the owners' wallets
npm run demo                # http://127.0.0.1:8790/
```

`demo:setup` writes `.local/demo/deployment.json`, a record of public addresses, and puts one key per role in a directory beside it. Run it again whenever the local network has been restarted: a fresh network has none of the contracts.

While working on the page itself, run `npm run dev -w @stellar-agent-auth/demo` next to `npm run demo` and open `http://127.0.0.1:5173/`. Vite serves the page and passes `/v1` and `/indexer` to the demo server.

To connect Freighter to the local network, start the network with `npm run dev:horizon` instead of `npm run dev`; Freighter needs Horizon.

## Run it against Testnet

The Testnet deployment is recorded in [`deployments/testnet/demo.json`](../../deployments/testnet/demo.json). Its keys are on the machine that made it. To make a deployment of your own:

```sh
STELLAR_NETWORK=testnet DEMO_DIRECTORY=.local/testnet-demo npm run demo:setup -- \
  --metadata-uri https://<public host>/scout-metadata.json \
  --public-record deployments/testnet/demo.json
DEMO_DIRECTORY=.local/testnet-demo npm run demo
```

On Testnet the agent is assessed for real. The metadata document must be served at a public HTTPS address and follow the v1 schema in [verification coverage](../../docs/VERIFICATION_COVERAGE.md); [`scout-metadata.json`](../../deployments/testnet/scout-metadata.json) is the one in use, served from this repository at a fixed commit. The project's verifier fetches it, runs its checks and publishes the result, which is valid for 30 days unless `--validity-days` says otherwise. To publish a new result before the old one expires:

```sh
DEMO_DIRECTORY=.local/testnet-demo npm run demo:assess
```

## What you do in the page

1. **Come in.** As a guest, with Freighter, or with any wallet [Stellar Wallets Kit](https://stellarwalletskit.dev/) knows (xBull, Albedo, Lobstr, Rabet, Hana and others). A guest is a key generated in the browser; the page never asks for a secret key. A reload brings you back as you were, without asking again.
2. **Set up your wallet.** One button: Friendbot funds your account, you create your wallet, and the faucet adds 100 tUSD. A guest's steps need no approval; a wallet asks you once, for the wallet's creation.
3. **Give an agent an allowance.** Under **Agents** there are two cards of the same kind: **Your own AI agent**, with a sentence to paste into it, and **Scout**, the sample. Each agent you have is a card there, with its verification and its allowance. The form starts at 5 per purchase, 6 per day, 20 in total, for seven days, with three of the four sellers ticked.
4. **Watch it buy.** Your own agent buys when you ask it to, from wherever it runs. Scout has five tasks in its card. With the suggested allowance: the brief is bought; the dataset costs 8 and is blocked by your wallet; the audited report is refused by its seller; the cheapest headlines are blocked at the unapproved seller and bought from the next; and the weekly catch-up buys until the day's limit stops it.
5. **Freeze, unfreeze, end.** Freezing is the wallet's and stops every agent; ending is one allowance's. Then ask an agent again and watch the wallet refuse.
6. **Read the wallet's record.** Entries on the ledger are verified in the page against the wallet's stored head, each under the name of the agent that made it. Refusals are listed separately: they left nothing on the ledger.

What happens is not scripted. Change an allowance and the outcomes change with it: allow 10 per purchase and the dataset is bought; tick Bargain Data and Scout buys the cheapest headlines there.

## Use your own AI agent

Scout is a sample. The point is your own agent: in Claude Code, Codex or any MCP host, with a key of its own on your machine, spending from your wallet inside an allowance you approve in the page.

In the page, under **Agents**, copy the sentence from the card **Your own AI agent** and paste it into your agent. The sentence names [`/agent-ready.md`](https://stellar-agent-wallet.fly.dev/agent-ready.md) and carries your go-ahead for the three things it does; the document says what each does, where it leaves a trace and how to undo it. The agent runs a one-file tool from npm, creates and registers itself, and has itself verified. It then appears in the page as a card of its own; give it an allowance. Its purchases show in the wallet's record as they happen. The tool, what it does and what to know before trusting it are in [`packages/mcp`](../../packages/mcp/README.md); the design is in [ADR 0015](../../docs/decisions/0015-bring-your-own-agent.md).

## The sellers

Four sellers stand for other people's businesses. Each has its own account, its own price and its own rule about which agents it sells to. They are ordinary x402 resources under `/x402/`: they answer 402, are paid by whoever asks, and check the paying agent before they sell (see [ADR 0012](../../docs/decisions/0012-x402-and-payee-gate.md)). What they sell is read from the network when it is bought.

| Seller | Sells | Price, tUSD | Sells to |
| --- | --- | --- | --- |
| Ledger Wire | Network brief; close-time digest | 1; 3 | Any agent with a current verification |
| Deep Archive | Recent ledgers dataset | 8 | Any agent with a current verification |
| Audited Sources | Audited fee report | 2 | Only agents with a passed `Code` check, which the project's verifier does not perform |
| Bargain Data | Headlines | 0.5 | Any agent with a current verification; not ticked in the suggested allowance |

## Who signs what

| Role | Where its key is | What it signs |
| --- | --- | --- |
| Owner | Your wallet, or your browser as a guest | Wallet creation, allowances, freezing, ending, withdrawals |
| Agent (Scout) | The demo server | Authorization entries for purchases, for the named tasks only |
| Your own agent | Your machine, in `~/.stellar-agent-wallet` | Its own registration, and authorization entries for its purchases |
| Provider | The demo server, when it is given the key | Verification results |
| Facilitator | The demo server | Envelopes of x402 payments; it pays their fees and authorizes nothing |
| Funder | The demo server | Faucet payments into wallets |
| Admin, controller, issuer, sellers | Used by the setup only | Deployment, provider approval, registration, the result, the asset, trustlines |

The page reads balances, allowances, the agent's identity and its verification from the network itself, through the RPC. It takes only the deployment's addresses, the sellers and the task list from the demo server.

## The demo server

`apps/demo/server`. It serves many visitors at once and keeps no accounts: a visitor is known by their account address, and their wallet's address is derived from it.

| Route | What it does |
| --- | --- |
| `GET /v1/config` | The deployment's public addresses, the sellers and the tasks |
| `POST /v1/session { owner }` | Names the owner's wallet address and says whether the wallet exists |
| `POST /v1/fund { owner }` | The funder sends 100 tUSD to that owner's wallet, unless it already holds 200 or more |
| `POST /v1/tasks { owner, task, policy_hash }` | Scout runs one named task for that owner's wallet under that allowance |
| `GET /indexer/v1/...` | The indexer's read routes for a wallet, passed through |
| `GET /agent-ready.md?owner=<G...>` | Instructions for an AI agent to set itself up, with this server and that owner filled in |
| `GET /agent/stellar-agent-wallet.mjs` | The agent tool as one file |
| `POST /v1/agents/metadata { signer, name, description? }` | Writes the metadata document for an agent's key, once, and returns its address and hash |
| `GET /agents/<signer>.json` | That document |
| `POST /v1/agents/verify { agent_id }` | Runs the verifier for an agent whose metadata this server serves, unless its result is current |
| `POST /v1/agents/link { owner, agent_id }` | Notes that the agent would like to work for the owner |
| `GET /v1/agents?owner=<G...>` | The agents that asked to work for the owner |
| `GET /x402/<seller>/<product>` | A seller. 402 until paid |
| `GET /healthz` | For a host's health check |

One indexer follows every wallet that runs the deployment's wallet code (`INDEXER_WALLET_CODE`; see the [indexer](../../services/indexer/README.md)).

What protects it:

- It refuses any host name but loopback and its configured public name, and any origin but its own.
- Bodies must be JSON, which a cross-site form cannot send.
- Scout signs for five named tasks and nothing else. The recipient and the amount come from the sellers, not from the request.
- One task runs per wallet at a time, and six at once in all.
- It verifies only agents whose metadata it serves itself, so it never fetches an address a visitor chose.
- Everything that costs the server something is rate limited by client address: tasks, faucet payments, requests to the sellers, and requests in general. The faucet also has a ceiling per wallet and per day.
- The page is served with a content security policy that lets it run only its own scripts.

What it does not protect: anyone may name any owner, so anyone can have Scout run a task for someone else's wallet. That spends only what that wallet's owner allowed, where the owner allowed it, and it is test money. A demo with no sign-up cannot tell the visitors apart any better.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DEMO_PORT` (or `PORT`) | `8790` | Port to listen on |
| `DEMO_HOST` | `127.0.0.1` | Address to listen on. Anything beyond loopback requires `DEMO_PUBLIC_URL` |
| `DEMO_PUBLIC_URL` | none | The origin visitors use, such as `https://scout.example`. With it the server accepts that host name and reads client addresses from the proxy's headers |
| `DEMO_DEPLOYMENT` | `.local/demo/deployment.json` | The deployment record |
| `DEMO_DIRECTORY` | `.local/demo` | Where the setup writes, and where the record and state are looked for |
| `DEMO_STATE_DIRECTORY` | `<DEMO_DIRECTORY>/state/<epoch>` | The indexer's database and the facilitator's journal |
| `DEMO_AGENT_KEY`, `DEMO_FUNDER_KEY`, `DEMO_FACILITATOR_KEY` | `agent`, `funder`, `facilitator` | Key references: a name in the record's key directory, `file:<path>`, or `env:<NAME>` |
| `DEMO_PROVIDER_KEY` | `provider`, when the record names a key directory | The provider's key. With it the server verifies agents people bring and keeps Scout's verification current; without it, agents can register and are not verified |
| `DEMO_AGENT_NPM_PACKAGE` | none | The agent tool's name on npm, once published. The agent instructions then use `npx` in place of the downloaded file |
| `DEMO_ALLOWED_ORIGINS` | the Vite dev server, on loopback only | More origins a browser may call from |

## What it does not show

- **A refusal on the ledger.** Scout asks the wallet before it signs, so a refused purchase is never sent. What the wallet does with a refused payment that is submitted anyway is covered by the contract and integration tests.
- **The wallet's own `execute` call and a service that pulls its payment.** Every purchase here is an x402 payment on the account path. The other paths are in the [payment flow example](../../examples/payment-flow.ts) and the CLI.
- **A model, in the page.** Scout's tasks there are fixed code. A model is the agent from a terminal, as above.
- **Wallets other than a guest key and Freighter, tested.** The other wallets go through Stellar Wallets Kit and need only transaction signing, which every wallet does; none of them was tried here by hand.
