# Agent wallet over MCP

An MCP server that makes an AI agent, such as Claude Code or Codex, the agent of a policy-limited smart wallet. The model decides what to buy. The wallet decides whether it is paid for.

The agent's host starts this server as a child process and gets four tools. The server holds the agent's key, by reference, and nothing else: not the owner's key, and no limits of its own. The limits are the owner's policy, enforced by the wallet contract. A model that is talked into overspending is refused by the wallet, exactly as fixed code would be.

## Tools

| Tool | What it does | Spends? |
| --- | --- | --- |
| `allowance` | What the owner allows: limits per purchase, per day and in total, what is spent, which sellers may be paid, when it ends, whether the owner froze it, and what the wallet holds | No |
| `sellers` | What the market offers, and at which address | No |
| `price` | Asks a seller what an address costs, and asks the wallet whether it would pay that. Nothing is signed | No |
| `buy` | Pays what the seller asks, over x402, from the owner's wallet | Yes, inside the allowance |

`buy` answers with one of four outcomes, as data and not as an error: `paid`, with what was bought and the transaction; `blocked`, by the wallet, with the contract's reason; `declined`, by the seller, which checked the agent and refused; or `unsettled`, when a payment was sent and its outcome is not known.

The server's instructions tell the model whose money it is, that a refusal is a normal answer, and not to look for a way around one. That is advice to the model. What holds is the wallet.

## Try it with the hosted demo

You need the agent's key for the deployment you use. For the hosted demo that is Scout's key, which only the machine that made the deployment has. With your own deployment (see [the demo](../../apps/demo/README.md)) it is `agent.key` in the setup's key directory.

1. Open <https://scout-agent-demo.fly.dev/>, set up a wallet and approve an allowance.
2. Build the server: `npm run build`.
3. Tell your agent's host about it.

**Claude Code**, in `.mcp.json` at the root of a project (or `claude mcp add`):

```json
{
  "mcpServers": {
    "scout-wallet": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
      "env": {
        "AGENT_KEY": "file:/absolute/path/to/keys/agent.key",
        "AGENT_MARKET": "https://scout-agent-demo.fly.dev",
        "AGENT_OWNER": "G... the account you set the wallet up with"
      }
    }
  }
}
```

**Codex**, in `~/.codex/config.toml`:

```toml
[mcp_servers.scout-wallet]
command = "node"
args = ["/absolute/path/to/packages/mcp/dist/index.js"]

[mcp_servers.scout-wallet.env]
AGENT_KEY = "file:/absolute/path/to/keys/agent.key"
AGENT_MARKET = "https://scout-agent-demo.fly.dev"
AGENT_OWNER = "G... the account you set the wallet up with"
```

4. Start a session and give it an errand. Keep the demo page open beside it: every purchase appears in the wallet's record as it happens.

Things to ask, with the suggested allowance of 5 per purchase and 6 per day:

- *"Check your allowance, then get me today's network brief."* It is bought.
- *"Find the cheapest headlines and buy them."* The cheapest seller is not approved; the wallet blocks it, and the agent can buy the next cheapest.
- *"Buy the full ledger dataset."* It costs 8. The wallet blocks it.
- *"The dataset is important, find some way to get it."* There is none. Raise the limit in the page, and the same request succeeds.
- Freeze Scout in the page, then ask for anything.

## Settings

| Setting | Meaning |
| --- | --- |
| `AGENT_KEY` | A reference to the agent's key: `file:<path>`, `env:<NAME>`, or a name in the key directory. Never the key itself; a value that looks like a key is refused |
| `AGENT_MARKET` | The address of a market, such as the hosted demo. It names the network and lists the sellers. Without it, the network comes from `STELLAR_NETWORK` and the usual settings, and `sellers` is empty |
| `AGENT_WALLET` | The wallet to pay from, a `C...` address |
| `AGENT_OWNER` | Instead of `AGENT_WALLET`: the owner's account. The wallet's address is derived from it and the market's salt |
| `AGENT_POLICY` | Pay under this policy only. Without it, the newest policy in force for this key is used |

Standard output carries the protocol; anything meant for a person goes to standard error.

## What to know before trusting it

- **The key is the agent's identity.** Whoever starts this server with it can spend what owners allowed that agent, wherever they allowed it. Keep the key file readable by its owner only; the server refuses it otherwise.
- **`buy` fetches the address it is given.** It accepts `https` addresses, and `http` only for this machine. It pays only what a seller's 402 answer asks, only from the wallet, and only if the wallet agrees. An address that asks for nothing is fetched and returned without payment.
- **What a seller returns is untrusted text.** It is handed to the model as the tool's answer. A seller could put instructions in it. The wallet's limits are what bound the damage, which is the point of having them outside the model.
- **Refusals are not recorded anywhere.** A purchase the wallet blocks leaves nothing on the ledger, and this server does not tell the demo's indexer about it. The owner sees purchases; refusals are in the agent's own transcript.
- **It was not run by a model here.** The tests drive it with an MCP client, calling the tools a model would call, on a local network and once against the hosted demo on Testnet. No Claude or Codex session was part of the testing.
