# ADR 0014 · A real AI agent as the wallet's agent, over MCP

Decided on 2026-11-27, the day the demo was first hosted ([ADR 0013](0013-hosted-demo.md)).

## Problem

Scout, the agent in the demo, is five pieces of fixed code. That shows the wallet honestly, and it says so. But "AI agent" now means a model in a harness such as Claude Code or Codex, deciding for itself what to do. A reviewer will ask whether this works with one of those, and whether a model that wants to overspend can.

Nothing stood in the way. The demo's sellers are ordinary x402 resources on a public address, and `packages/x402` already pays them from a wallet. What was missing was a way for a model to call it.

## Decision

A new package, `packages/mcp`: a server that speaks the Model Context Protocol over standard input and output. An agent's host starts it as a child process. It is given the agent's key by reference and the wallet to pay from, and offers four tools: `allowance`, `sellers`, `price` and `buy`.

MCP was chosen because both hosts in question speak it, so one server serves both, and because a tool call is the natural shape of "buy this".

### No limits in the server

The server checks nothing about amounts or recipients. It could have: a spending cap in the tool is the usual way to make an agent safe. It would also be a second copy of the owner's rules, held in a process the agent's operator controls, and a reader could not tell which copy had stopped a payment.

So there is one copy, in the wallet contract. `buy` pays whatever the seller's 402 answer asks, if the wallet agrees. `price` asks the wallet the same question without signing, so a model can find out before it tries. When the wallet says no, the tool's answer says so, with the contract's reason.

The server's instructions tell the model not to work around a refusal. That is manners. It is not the control.

### Refusals are answers

A blocked or declined purchase is returned as the tool's result, not as a failed call. A model treats a failed call as something to retry or route around; it treats an answer as a fact to report. Only faults are failures: no network, a malformed address.

### The same agent identity

For the hosted demo the server runs with Scout's key, so a model in a terminal is Scout: the same registered agent, the same verification, the same allowance the owner approved in the page. Nothing in the page had to change, and the page's record shows the model's purchases as they happen, because the indexer follows the wallet whoever pays from it.

A different agent would need its own registration, its own assessment by the provider, and an allowance naming it. The contracts and the SDK support that. The demo's page offers an allowance for Scout only.

### What the server finds for itself

Given a market's address, it reads the network, the sellers and the wallet salt from the market's public configuration, derives the wallet from the owner's account, and uses the newest policy in force for its key. An operator sets three things: the key, the market and the owner.

## Consequences

- Claude Code, Codex or any MCP host can be the agent, with a few lines of configuration.
- Scout's key now has a second use outside the hosted server. Whoever holds it can spend what any owner allowed Scout. On Testnet that is test money; it is still the reason the key stays on the machine that made the deployment.
- What a seller returns goes to the model as text. A seller could put instructions in it. The wallet's limits bound what that can cost, which is the argument for keeping them outside the model.
- The demo's public configuration now lists the address each product is sold at.

## Not done

- A run with a model. The server was driven by an MCP client in tests, and once against the hosted demo on Testnet. No agent harness with a command-line mode was installed on the machine it was built on.
- Recording refusals. A blocked purchase leaves nothing on the ledger, and this server does not write to the demo's indexer; that route needs a token only the demo server has.
- Registering another agent from the page.
- A hosted, remote MCP endpoint. The server is a local process, because it holds a key.
