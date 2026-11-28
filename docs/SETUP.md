# Setup guide

Five ways in, from the least effort to the most. Each stands on its own; take the one that fits what you want to do.

| I want to | Go to | Needs |
| --- | --- | --- |
| See it work | [Try the demo](#1-try-the-demo) | A browser |
| Let my own AI agent pay from a wallet I control | [Connect your own agent](#2-connect-your-own-ai-agent) | Node.js 20 or newer |
| Run all of it on my machine | [Run it locally](#3-run-it-locally) | Node.js, Rust, Docker |
| Use the contracts from my own code | [Use the SDK and the CLI](#4-use-the-sdk-and-the-cli) | Node.js |
| Have a deployment of my own | [Deploy your own](#5-deploy-your-own) | The local setup, and a public HTTPS address |

Everything here is on Stellar Testnet or a local network. The asset is tUSD, a test asset with no value. Nothing has been audited; see [what is not included](EVIDENCE.md#what-is-not-included).

## 1. Try the demo

Open <https://stellar-agent-wallet.fly.dev/> and choose **Try as a guest**. A guest is a key made in your browser; nothing is installed and the page never asks for a secret key. Freighter works too, set to Testnet. Other Stellar wallets can be picked from a list, but none of those was tried.

1. Press **Set up my wallet**. Your account gets test XLM, you create your wallet contract, and a faucet puts 100 tUSD in it.
2. Under **Agents**, choose **Try Scout**, the sample agent, and approve the allowance the form suggests: 5 per purchase, 6 per day, three of the four sellers.
3. Give Scout its tasks. The brief is bought. The dataset costs 8 and your wallet blocks it. The cheapest headlines are at a seller you did not approve, so the wallet blocks that and Scout buys elsewhere.
4. Press **End allowance**, ask again, and watch the wallet refuse.
5. Open **Record**. The page rebuilds the wallet's history from the ledger and checks it against what the wallet stores.

Change the allowance and the outcomes change with it. Nothing is scripted.

## 2. Connect your own AI agent

Your agent, in Claude Code, Codex or any MCP host, gets a key of its own on your machine and four tools: `allowance`, `sellers`, `price` and `buy`. It never sees your wallet's key, and it can spend nothing until you approve an allowance for it.

1. In the demo, set up your wallet as above.
2. Under **Agents**, choose **Your own AI agent**. Copy the sentence from the window and paste it into your agent. It points the agent at instructions that say exactly what will be run, where it leaves a trace and how to undo it.
3. When the agent has registered, the window turns into its allowance form. Approve it.
4. Ask your agent to buy something from the sellers. Its purchases appear in your wallet's record.

By hand, the same thing is:

```sh
npx -y stellar-agent-wallet init --market https://stellar-agent-wallet.fly.dev --owner <your G... address> --name "My agent"
claude mcp add agent-wallet -- npx -y stellar-agent-wallet mcp
```

To undo it: remove `agent-wallet` from your host's MCP servers and delete `~/.stellar-agent-wallet`. More in the [package's README](../packages/mcp/README.md).

## 3. Run it locally

### What you need

| | Version | Note |
| --- | --- | --- |
| Node.js | 24.22.2 | `nvm install` in the repository reads `.nvmrc` |
| Rust | 1.98.0 | `rustup show` in the repository installs what `rust-toolchain.toml` names |
| Stellar CLI | 30.0.1 | `cargo install stellar-cli --version 30.0.1 --locked`, or the release binary |
| Docker | With Compose v2 | For the local Stellar network |
| Google Chrome | Any recent | Only for the browser test |

### From a clean checkout

```sh
git clone https://github.com/CenekSanzak/stellar-agent-auth.git
cd stellar-agent-auth
nvm install && nvm use
npm ci --ignore-scripts
rustup show
npm run check
```

`npm run check` type-checks everything, builds the TypeScript packages and the contracts, and runs the unit tests and the contract tests. It needs no network once dependencies are downloaded. The first run compiles the contracts and takes several minutes.

### A local Stellar network

```sh
npm run dev                  # starts the network in Docker and waits until it answers
npm run test:integration     # every flow, with real signatures
npm run test:browser         # the demo in Chrome
npm run local:down           # stops the network and discards its state
```

### The whole flow from the command line

```sh
npm run example:payment
```

This registers an agent, verifies it, creates and funds a wallet, approves a policy, makes a payment, revokes the policy and shows a payment being refused, each step as a `stellar-agent-auth` command printed as it runs. It uses a separate key for every role and writes a summary under `.local/example/`.

### The demo on your machine

```sh
npm run demo:setup           # deploys the contracts and the sample sellers to the local network
npm run demo                 # http://127.0.0.1:8790/
```

Run `demo:setup` again whenever the local network has been restarted. More in the [demo's README](../apps/demo/README.md).

## 4. Use the SDK and the CLI

The kept Testnet deployment:

| | |
| --- | --- |
| Network | Testnet, `Test SDF Network ; September 2015`, RPC `https://soroban-testnet.stellar.org` |
| Agent registry | `CDQXY7OPSHKQGEVCIJI6UITZPD7B7U2G7SJHK2TJNXTKSE4T5WBZLE63` |
| Verification registry | `CDZDDHWQNZBZ7JCI5THJGU76ZTAXUOB3BXIXMVZJFKQP2ZPJ3SRTV6RS` |
| Verifier (provider) | `GBSJVKTMMTY52BQ7Q6MDRUPWSYA5GL74PS66RNVA4SRET6267RX33YHW` |
| Test asset, tUSD | `CCCDL5N5Z7DCJH3WWJHW2JMIJQOKMOCTE5FA77IOW2EJMEYLTTIZB5GI`, 7 decimals |
| Wallet code | `568ccc8e662a83f0011ee6c265681e8d887780336cce0173962a61a0625dd4b9`. There is no one wallet; each owner deploys their own from this code |

The same values, with every role's address and the transactions that made them, are in [`deployments/testnet/manifest.json`](../deployments/testnet/manifest.json), and typed in [`deployments/testnet/addresses.ts`](../deployments/testnet/addresses.ts).

### From code

Inside this repository, after `npm run build`:

```ts
import { rpc } from '@stellar/stellar-sdk';
import { readAgent, readCurrentResult } from '@stellar-agent-auth/sdk';

const server = new rpc.Server('https://soroban-testnet.stellar.org');
const read = {
  server, networkPassphrase: 'Test SDF Network ; September 2015',
  // Any funded account; reads are simulated and nothing is signed.
  source: 'GAYO232SY7TUOXY67WCMOAT2EKSVCQDCTCW6U2WCLR7RVCX22H65ZP5E',
};

const agent = await readAgent({ ...read, contractId: 'CDQXY7OPSHKQGEVCIJI6UITZPD7B7U2G7SJHK2TJNXTKSE4T5WBZLE63' }, 1n);
const result = await readCurrentResult(
  { ...read, contractId: 'CDZDDHWQNZBZ7JCI5THJGU76ZTAXUOB3BXIXMVZJFKQP2ZPJ3SRTV6RS' },
  { agent_id: 1n, revision: agent.revision, provider: 'GBSJVKTMMTY52BQ7Q6MDRUPWSYA5GL74PS66RNVA4SRET6267RX33YHW' },
);
console.log(agent.signer, result.checks.map(({ kind, outcome }) => `${kind}: ${outcome}`));
```

The packages are not published to npm, apart from the agent tool. To use the SDK elsewhere, pack it with `npm pack -w @stellar-agent-auth/sdk` and install the file. What each package offers is in its README: [SDK](../packages/sdk/README.md), [CLI](../packages/cli/README.md), [x402](../packages/x402/README.md), [agent tool](../packages/mcp/README.md). A complete flow written against the SDK, from a new owner to refused payments, is [`deployments/testnet/evidence.ts`](../deployments/testnet/evidence.ts).

### From the command line

```sh
export STELLAR_NETWORK=testnet
export AGENT_REGISTRY_ID=CDQXY7OPSHKQGEVCIJI6UITZPD7B7U2G7SJHK2TJNXTKSE4T5WBZLE63
export VERIFICATION_REGISTRY_ID=CDZDDHWQNZBZ7JCI5THJGU76ZTAXUOB3BXIXMVZJFKQP2ZPJ3SRTV6RS
export VERIFIER_PUBLIC_ADDRESS=GBSJVKTMMTY52BQ7Q6MDRUPWSYA5GL74PS66RNVA4SRET6267RX33YHW

node packages/cli/dist/index.js agent show --agent 1
node packages/cli/dist/index.js verify show --agent 1
WALLET_ID=CDA6MY2C6LUDOEDURJ5TTRW4ERTMDT5ORGGHFGQIQSUOYYMZ3GXOENDV \
  node packages/cli/dist/index.js history --indexer https://stellar-agent-wallet.fly.dev/indexer/
```

The last command reads the acceptance run's wallet history from the hosted indexer and verifies it against the wallet. Every command takes `--help` and `--json`. Commands that sign take a key by name, never a secret on the command line; see [keys](../packages/cli/README.md#keys).

### Repeat the acceptance run

```sh
npm run build
node deployments/testnet/evidence.ts --out my-evidence.json
```

This creates a new owner, a new agent and a new wallet on Testnet, makes one payment inside an allowance and has four refused, and writes every address and transaction to the file you name. It needs no secret: it uses Friendbot and the hosted service's agent setup, verifier and faucet. Without `--out` it replaces the record in `deployments/testnet/evidence.json`. What it shows is in [the evidence page](EVIDENCE.md#deliverable-2-a-wallet-the-owner-controls).

## 5. Deploy your own

A deployment is both registries, an approved verifier, a test asset, the installed wallet code, one registered and verified sample agent, and the sample sellers' accounts. One command makes it:

```sh
npm run build:contracts && npm run build
STELLAR_NETWORK=testnet DEMO_DIRECTORY=.local/my-deployment npm run demo:setup -- \
  --metadata-uri https://<your public host>/agent-metadata.json \
  --public-record my-deployment.json
```

- The metadata document must be served over HTTPS at a public address and must not change afterwards: the registry stores its hash, and the verifier fetches it. [`scout-metadata.json`](../deployments/testnet/scout-metadata.json) is a model.
- Keys are generated into the directory you name, one file per role, readable only by you. The record holds public addresses only. Never commit the key directory.
- `DEMO_DIRECTORY=.local/my-deployment npm run demo` then serves the demo against it. To put it on a public address, see [hosting](HOSTING.md).
- To check a deployment against the network and record how it was made, see [operations](OPERATIONS.md#checking-a-deployment).

## What a refusal means

A refused payment names its reason. The ones an owner or an agent will meet:

| Reason | Meaning | Who can fix it |
| --- | --- | --- |
| `PaymentLimitExceeded` | More than the allowance permits in one payment | The owner, with a new allowance |
| `DailyLimitExceeded` | Today's payments would pass the daily limit. It resets at midnight UTC | Wait, or the owner |
| `TotalLimitExceeded` | Everything paid under this allowance would pass its total. It never resets | The owner |
| `RecipientNotAllowed` | The recipient is not one the owner approved | The owner |
| `AssetNotAllowed` | The allowance does not cover this asset | The owner |
| `Paused` | The owner has frozen the wallet | The owner |
| `Revoked` | The owner ended this allowance. That is permanent | The owner, with a new allowance |
| `Expired` | The allowance's end date has passed | The owner |
| `ResultExpired` | The agent's check result is too old | The verifier, by checking the agent again |
| `CheckNotPassed` | A check the allowance requires did not pass, or was not performed | The agent's operator, then the verifier |
| `AgentDisabled`, `IdentityChanged` | The agent's identity was disabled or changed after the allowance was approved | The agent's operator, then the owner |
| `InvalidSequence`, `RequestExpired` | The signed request is out of order or too old | The agent, by signing again |

A seller can also refuse an agent on its own terms, before any payment; those reasons begin with `payee_gate_`. The complete list of the contracts' reasons, with their numbers, is in [ADR 0008](decisions/0008-error-codes.md) and in the SDK as `CONTRACT_ERROR_HELP`.

## If something goes wrong

| What you see | Why | What to do |
| --- | --- | --- |
| `npm run build:contracts` refuses the Stellar CLI | Another version is installed | Install 30.0.1 |
| `npm run dev` does not finish | Docker is not running, or port 8000 is taken | Start Docker; `docker compose ps` and `docker compose logs` |
| The integration tests fail right after a restart | A fresh local network has no contracts | Run `npm run demo:setup` again, or just rerun: each test deploys its own |
| Friendbot answers with an error | Testnet's faucet is busy | Wait a minute and try again |
| The demo says the wallet is on another network | Your browser wallet is set to the public network | Switch it to Testnet |
| The browser test cannot find a browser | No Chrome installed | Install Chrome, or set `DEMO_BROWSER_CHANNEL` to another Chromium channel |
| A payment is refused with `ResultExpired` | A check result counts for 30 days | Check the agent again; the hosted service does this itself for agents it verified |

For the pinned versions, the test layout and how the Testnet suites are switched on, see [development](DEVELOPMENT.md).
