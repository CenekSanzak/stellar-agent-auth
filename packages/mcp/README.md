# stellar-agent-wallet

Lets your own AI agent, in Claude Code, Codex or any MCP host, pay for things from a smart wallet you own, inside an allowance you control. The model decides what to buy. The wallet decides whether it is paid for.

Your agent gets a key of its own, on the machine it runs on. It never sees your wallet's key. You approve an allowance for it in your wallet: how much per purchase, per day and in total, which sellers, until when. The wallet contract enforces it, and you can freeze the wallet or end the allowance at any time. A model that is talked into overspending is refused by the wallet, exactly as fixed code would be.

It works on Stellar Testnet with the hosted wallet at <https://stellar-agent-wallet.fly.dev/>. All money there is test money.

## The quick way: one sentence

1. Open <https://stellar-agent-wallet.fly.dev/>, connect a wallet (or try as a guest) and press **Set up my wallet**.
2. Under **Agents**, in the card **Your own AI agent**, copy the sentence and paste it into your agent. It names the instructions and says you agree to the three things they do:

   > Set yourself up as the agent of my Stellar smart wallet on Testnet (test money only), following https://stellar-agent-wallet.fly.dev/agent-ready.md?owner=G... - I know what it involves, and you have my go-ahead for its three steps: run the npm package stellar-agent-wallet with npx; let it create a key for the agent under ~/.stellar-agent-wallet and register the agent on Stellar Testnet; and add it to the agent's MCP servers.

   The instructions say what each step does, where it leaves a trace and how to undo it. A careful agent may still ask you to confirm before it runs anything.
3. Go back to the page. Your agent is listed there. Give it an allowance.
4. Ask your agent to buy something. Its purchases appear in the wallet's record as they happen.

You need Node.js 20 or newer on the machine the agent runs on. Nothing else is installed.

## The same thing by hand

```sh
npx -y stellar-agent-wallet init \
  --market https://stellar-agent-wallet.fly.dev --owner <your G... account> --name "Claude Code on my laptop"
```

`init` prints a link. Open it, approve an allowance, then tell your agent's host how to start the tools:

```sh
claude mcp add agent-wallet -- npx -y stellar-agent-wallet mcp   # Claude Code
codex mcp add agent-wallet -- npx -y stellar-agent-wallet mcp    # Codex
```

For another host, the command to start is `npx -y stellar-agent-wallet mcp`.

The package is one file with no dependencies and no install scripts. The same file is served by the site at `/agent/stellar-agent-wallet.mjs`, for running with `node` where npm is not wanted.

To undo all of it: `claude mcp remove agent-wallet` and `rm -rf ~/.stellar-agent-wallet`. The agent's entry in the registry stays, as ledger records do; without the key it can do nothing.

## What `init` does

Everything happens with the agent's own keys, on its own machine. Nothing in it can spend.

1. Creates two keys under `~/.stellar-agent-wallet/keys`, readable by you only: the agent's key, which signs its payments, and a controller key, which manages its identity. The agent registry requires the two to differ.
2. Funds both accounts with test XLM from Friendbot.
3. Asks the market for a metadata document for the agent, and registers the agent in the agent registry with that document's address and hash.
4. Asks the market's verifier to assess the agent. It fetches the document, checks it against the registered hash and its schema, checks the agent's account, and publishes what it found. A result lasts 30 days.
5. Tells the market which owner the agent would like to work for, so that the owner's page can list it.
6. Writes `~/.stellar-agent-wallet/agent.json`: the market, the owner and the agent's number. Nothing in it is secret.

It is safe to run again: keys are kept, an agent is not registered twice, and a current verification is not replaced.

## Commands

| Command | What it does |
| --- | --- |
| `init --market <address> --owner <G...> [--name <text>] [--description <text>] [--home <dir>] [--json]` | Set the agent up, as above |
| `status [--home <dir>]` | Print what the owner allows the agent to spend |
| `mcp [--home <dir>]` | Serve the tools over standard input and output. This is what an agent host starts; it is also what runs when no command is given |

`--home` keeps a second agent beside the first, each with its own keys.

## Tools

| Tool | What it does | Spends? |
| --- | --- | --- |
| `allowance` | What the owner allows: limits per purchase, per day and in total, what is spent, which sellers may be paid, when it ends, whether the owner froze the wallet, and what the wallet holds | No |
| `sellers` | What the market offers, and at which address | No |
| `price` | Asks a seller what an address costs, and asks the wallet whether it would pay that. Nothing is signed | No |
| `buy` | Pays what the seller asks, over x402, from the owner's wallet | Yes, inside the allowance |

`buy` answers with one of four outcomes, as data and not as an error: `paid`, with what was bought and the transaction; `blocked`, by the wallet, with the contract's reason; `declined`, by the seller, which checked the agent and refused; or `unsettled`, when a payment was sent and its outcome is not known.

`buy` takes any `https` address that answers with an x402 payment request on Stellar, not only the market's sellers. Today a seller whose facilitator runs the published x402 code unchanged refuses a smart wallet as payer; see [ADR 0012](../../docs/decisions/0012-x402-and-payee-gate.md).

## Things to ask your agent

With the suggested allowance of 5 per purchase and 6 per day:

- *"Check your allowance, then get me today's network brief."* It is bought.
- *"Find the cheapest headlines and buy them."* The cheapest seller is not approved; the wallet blocks it, and the agent can buy the next cheapest.
- *"Buy the full ledger dataset."* It costs 8. The wallet blocks it.
- *"The dataset is important, find some way to get it."* There is none. Raise the limit in the page, and the same request succeeds.
- Freeze the wallet in the page, then ask for anything.

## Settings

After `init` there is nothing to set. Each of these can be given in the environment, and then wins:

| Setting | Meaning |
| --- | --- |
| `STELLAR_AGENT_WALLET_HOME` | Where the agent's keys and settings are kept. Default: `.stellar-agent-wallet` in the home directory |
| `AGENT_KEY` | A reference to an agent key kept elsewhere: `file:<path>` or `env:<NAME>`. Never the key itself; a value that looks like a key is refused. With it, nothing is read from the home directory |
| `AGENT_MARKET` | The market's address. It names the network and lists the sellers |
| `AGENT_OWNER` | The owner's account; the wallet's address is derived from it |
| `AGENT_WALLET` | The wallet to pay from, a `C...` address, in place of `AGENT_OWNER` |
| `AGENT_POLICY` | Pay under this policy only. Without it, the newest policy in force for this key is used |

## What to know before trusting it

- **The key files are the agent.** Whoever has `agent.key` can spend what owners allowed that agent. Whoever has `controller.key` can disable the agent or change what it says about itself. Both stay on your machine; neither is ever sent anywhere. Do not let an agent print or copy them.
- **The tool is one large file you run.** It is this package built into a single file, which is why it is 3.4 MB: it contains the Stellar SDK. Build it from this repository (`npm run build`; it is `packages/mcp/dist/stellar-agent-wallet.mjs`) if you do not want to take npm's or the server's word for it.
- **The market's verifier is who vouches for your agent.** It checks that the agent's metadata is what was registered and that its account exists. It does not look at what the agent is or does. A seller or a wallet that wants more can require checks this verifier does not perform, and will then refuse.
- **What a seller returns is untrusted text.** It is handed to the model as the tool's answer. A seller could put instructions in it. The wallet's limits are what bound the damage, which is the point of having them outside the model.
- **Refusals are not recorded anywhere.** A purchase the wallet blocks leaves nothing on the ledger. The owner sees purchases; refusals are in the agent's own transcript.
- **The server's instructions to the model are advice.** They say whose money it is and not to work around a refusal. What holds is the wallet.

## For developers

`createWalletAgent` and `createMcpServer` are exported for use in a program; `initAgent` does what `init` does. The package is built with `npm run build`, which also writes the one-file build. `npm run pack:npm -w @stellar-agent-auth/mcp` lays that file out as the npm package `stellar-agent-wallet`, in `dist/npm`.

The design is in [ADR 0014](../../docs/decisions/0014-agent-over-mcp.md) and [ADR 0015](../../docs/decisions/0015-bring-your-own-agent.md).
