# ADR 0015 · Bring your own agent

Decided on 2026-11-27, after the owner of the project tried the hosted demo and said what it was for.

## Problem

[ADR 0014](0014-agent-over-mcp.md) let a model be the wallet's agent, with one catch: it needed Scout's key, which only the machine that made the deployment has. So the one person who could use it was the project's author.

That missed the point of the project. Scout is a sample. What was promised is that someone can open the site, set up a wallet, and let their own AI agent, in their own Claude Code or Codex, spend from it inside rules they control. Nobody should need a key from us, a clone of the repository, or much thought.

## What an agent needs

A wallet pays for an agent only when three things are true. The agent has an identity in the agent registry. That identity carries the hash of a metadata document at a public address. And a provider the owner trusts has published a current verification result for it.

A stranger's agent could already do the first by itself: registration is open. It could not do the other two. It has nowhere public to put a document, and only the provider can publish a result.

## Decision

### The agent sets itself up, with its own keys

One command, `init`, run on the agent's machine. It creates the agent's key and registers the agent. The owner's key is never involved, and nothing in `init` can spend.

The registry refuses an identity whose controller is its own signer, so `init` creates two keys: the agent's, and a controller's that sits beside it. Making the owner's account the controller would be the better model, since the owner could then disable their agent in the registry. It was not done because registration needs both signatures in one transaction within about a hundred seconds, and the two keys are in different places: one in a browser wallet, one in a terminal. The owner already has a stronger control in any case: the allowance.

### The server does the two things the agent cannot

- **It serves the metadata document.** `init` asks for one by the agent's key and a name. The server writes it once and serves it at `/agents/<key>.json`; the bytes never change, because their hash is what the agent registers.
- **It verifies.** `init` asks, and the server runs the project's verifier against the registered agent: it fetches the document, compares it with the registered hash and the schema, checks the agent's account, and publishes the result. On a local network it publishes labelled fixture data, as the setup always has.

It verifies only agents whose metadata it serves, so it never fetches an address a stranger chose. A result lasts 30 days and is renewed when less than seven are left; the agent's tool asks each time it starts.

### The provider's key goes on the server

ADR 0013 kept the provider's key off the hosted server and said why: the provider is the deployment's root of trust. This reverses that. A verification service has to be able to sign when asked; a key that is only on a laptop cannot serve strangers.

What is exposed by it: someone who took the key from the server could publish results for any agent, which would make wallets pay for agents that were never checked. On Testnet that is test money, and the admin key, which stays on the laptop, can disable the provider. The gain is the product working at all, and one chore fewer: the server now keeps Scout's own verification current.

It is one provider, not a second one for visitors' agents. Two would mean policies and sellers choosing between them, for no gain on a test network.

### What is checked, said plainly

The verifier checks a self-made agent's metadata and its account. It does not check an endpoint, because such an agent declares none. So an allowance for one requires `Metadata` and `SignerAccount`, where Scout's also requires `Endpoint`. The page builds the requirement from the checks the agent actually passed, and shows them.

This is thin, and the page does not pretend otherwise. It says who vouches and for what. A seller that wants more, like Audited Sources, refuses.

### The owner finds the agent in their page

`init` tells the server which owner the agent would like to work for. The page lists such agents, each with its verification and an allowance of its own, beside Scout. The list is a hint with no authority: it is not authenticated, and an agent on it can spend only under a policy the owner signs. `init` also prints a link that opens the page on that agent's allowance form.

Each agent has its own policy. The wallet refuses a signature by any key but the policy's own, so one agent cannot spend another's allowance.

### One sentence to paste

The page shows a sentence to paste into an agent. It contains the address of `agent-ready.md` with the owner's account in it. The server generates that document with its own address and the owner filled into every command.

The first version of the document told the agent to do the set-up and not to explain it back first. The first model to read it, Claude Code, stopped, and said why: a web page was telling it to download and run a file it could not review, register something that could not be undone, and change its own configuration, without telling its user. It was right. A page is not who an agent takes orders from.

So the document does not instruct. It says what each of the three steps does, where it leaves a trace, how to undo it, what the tool is and how to check it, and that the decision is the person's. The go-ahead is in the sentence the owner pastes, in their own words to their own agent, naming the three steps; and the page shows the same three steps beside the sentence, so that the owner agrees to something they have read. An agent that still asks once before running anything is doing its job.

### One file

The tool is built into a single file with nothing to install beside it, and the server hands that file out. An agent host then starts `node <file> mcp`, which is immediate and does not depend on a package registry being reachable.

The same file is published to npm as `stellar-agent-wallet`, and the hosted instructions use `npx` (`DEMO_AGENT_NPM_PACKAGE`). It is not on PyPI: the tool is a Node program, and a Python package could only start Node.

### The page is about the wallet and its agents

The page began as Scout's: its allowance, its tasks, its sellers, with bringing an agent of one's own as one card far down a column. That put the sample in front of the product. It now has a wallet at the top and an **Agents** section under it, where each of the owner's agents is a card, and the two ways to get one, bringing your own and trying the sample, are cards of the same kind side by side. No allowance form is open until the owner picks an agent. The sample's tasks are inside its card.

A reload brings the owner back as they were. The page remembers how they connected and asks the wallet quietly, without opening it; and while it does not yet know whether they have a wallet, it shows neither the welcome page nor the set-up steps.

## Consequences

- Someone with a wallet on the site and an AI agent in a terminal can connect the two in about a minute, without a key from anyone.
- The hosted server holds a fourth key, the provider's, and is trusted for more than before.
- The server stores a small file per agent, and one list of which agents asked for which owners. Both are rate limited and bounded.
- Anyone can register agents and ask for them to be verified. Each costs the server a transaction fee in test XLM. The number published in a day is capped.
- Freezing moved from Scout's card to the wallet's: it stops every agent, and now there can be several.

## Not done

- The owner as the agent's controller, for the reason above.
- An owner removing an agent from their list. An agent they ignore can do nothing.
- A richer check of a self-made agent. The verifier's coverage is what it was.
- A complete run by a model. One model read the instructions and stopped to ask, which led to the rewrite above; none has yet gone through to a purchase.
