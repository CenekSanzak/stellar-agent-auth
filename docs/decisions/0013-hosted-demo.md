# ADR 0013 · A hosted demo with a real-looking product

Decided on 2026-11-27. It replaces the page and server of [ADR 0010](0010-owner-demo.md); what that ADR says about the owner signing in the browser and about showing only what was read from the network still holds.

## Problem

The demo of ADR 0010 ran on a developer's machine, for one owner at a time, and was laid out by feature: an agent card, a wallet card, a policy form, eight scenario buttons. Two things were wrong with that for the people who will judge the project.

They cannot run it. The acceptance evidence asks for a demo link, and reviewers are expected to need little technical knowledge. A link has to work in a browser with nothing installed.

And it did not look like anything anyone would use. Buttons named "pay above the per-payment limit" explain a test plan. They do not show why an owner would want a policy-limited wallet.

## Decision

### One product: Scout

The demo is a small product with one story. Scout is a research agent that buys briefs and datasets. The owner gives it an allowance: an amount per purchase, per day and in total, a list of sellers, and an end date. The owner can freeze Scout or end the allowance.

Every term on the page is the owner's. An allowance is a policy; freezing is the wallet's pause; ending an allowance is revocation; a seller is a permitted recipient. The contract's own words are one click away, under "Under the hood" and in the wallet's record.

Four sellers give the wallet something to decide about:

| Situation | How it arises |
| --- | --- |
| A purchase inside the allowance | Ledger Wire's brief costs 1 |
| Above the limit for one purchase | Deep Archive's dataset costs 8; the suggested limit is 5 |
| A recipient the owner did not approve | Bargain Data is cheapest and is not ticked in the suggested allowance |
| The day's limit | Digests at 3 each against a suggested 6 per day |
| A seller that refuses the agent | Audited Sources requires a `Code` check, which the project's verifier does not perform |
| After freezing, and after ending | Any task, once the owner has done either |

Nothing is scripted. The server holds five tasks, each a short piece of agent code: buy this, or ask the sellers for prices and try the cheapest first, or keep buying until told to stop. What comes back is whatever the wallet and the sellers answered. An owner who allows 10 per purchase sees the dataset bought.

Scout is not a language model. A model would add cost, a key to protect and answers that differ between runs, and it would show nothing about the wallet that fixed code does not. The page says so.

### Every purchase is an x402 payment

The sellers are x402 resources and Scout pays them with `packages/x402`. That is the path a real agent would use to pay for an API, and it removes the fee sponsor from the demo: an x402 facilitator pays the fees. The wallet's own `execute` call and the service that pulls its payment are no longer in the demo. They remain in the example, the CLI and the tests.

What a seller returns is read from the network when it is bought: the latest ledger, fee statistics, recent close times. A purchase is therefore worth looking at, and it is true.

### Many visitors, no accounts

The server keeps no accounts and no sessions. A visitor is an account address; their wallet's address is derived from it and the deployment's salt, and is checked on the network before anything is done for it.

What used to be started per owner is now shared:

- **One indexer** for every wallet. It follows wallets by the code they run (`INDEXER_WALLET_CODE`): it reads `audit_v1` events from the whole network and keeps those of contracts whose code hash is the deployment's wallet code. Events of other contracts are not stored. A reader still verifies the chain against the wallet's own head, so the indexer gains no authority by this.
- **One facilitator.** It is one fee-paying account, so settlements are made one at a time.
- **One agent key.** It only signs authorization entries, which need no ordering.

One task runs per wallet at a time. A second request for the same wallet is refused, not queued.

Since nobody signs in, anyone can ask Scout to run a task for any owner's wallet. This was accepted. Such a request can spend only what that owner allowed, at sellers that owner approved, in test money. Proving ownership would need a signed challenge, which wallets do not sign in one common way.

### Guests, and more wallets

A reviewer should not have to install a wallet. A guest is a key generated in the browser and kept in its local storage, so the same guest returns to the same wallet. ADR 0010 offered this on the local network only, because a tab-generated key on a public network looked like a bad habit to teach. It is now offered on Testnet too, named as what it is: a throwaway test-network key. The page still never asks for a secret key.

Freighter stays as it was. Other wallets come through Stellar Wallets Kit, loaded only when asked for. The owner signs nothing but whole transactions they are the source of, which is the one thing every wallet can do. A wallet that reports its network must be on the deployment's; one that cannot report it signs for the network the request names, and a signature for another network is useless here.

### Running in public

The server listens on loopback unless `DEMO_HOST` says otherwise, and then it requires `DEMO_PUBLIC_URL`. With a public name it accepts requests for that host only, takes the client's address from the proxy's headers, sends HSTS, and hides internal error messages.

Everything that costs it something is limited by client address: tasks, faucet payments, requests to the sellers and requests in general. The faucet also stops at a balance per wallet and at a number of payments per day. The page is served with a content security policy under which only its own scripts run.

The keys it needs are the agent's, the funder's and the facilitator's. They are named by reference (`env:NAME`), so a host supplies them as secrets and the deployment record in the repository holds public addresses only. The admin's, provider's, controller's and issuer's keys never leave the machine that made the deployment.

### Testnet, with the real verifier

The setup now runs on Testnet as well. There the provider is `Live`: the agent's metadata is fetched from a public address and assessed by the project's verifier, and the result is published. On a local network the result is still a labelled fixture.

A result lasts 30 days by default. `npm run demo:assess` publishes a new one, from the machine that holds the provider's key. The hosted server does not renew it: that would put the provider's key on the host, and the provider is the deployment's root of trust.

## Consequences

- The demo is one address that works in a browser with nothing installed.
- The page of ADR 0010, its scenarios, the per-owner sponsor and the per-owner indexer are gone. Its tests were rewritten.
- The hosted server holds three Testnet keys. If they leaked, someone could sign as Scout within owners' allowances, drain the faucet's test asset, or spend the facilitator's test XLM. None of it has value. The deployment would be replaced.
- The indexer reads one more filter, for audit events from the whole network, and makes one ledger read per contract it has not seen before.
- Stellar Wallets Kit is a large dependency with many transitive packages. It is a development dependency, bundled into a chunk the page loads on demand; the server's installation does not include it.
- A facilitator that someone else runs on the published x402 code still refuses the wallet ([ADR 0012](0012-x402-and-payee-gate.md)). The demo's own facilitator is the published code with the one allowance described there.

## Not done

- A refusal as a transaction on the ledger. Scout asks before it signs. If the acceptance evidence needs failed transactions to link to, making them belongs to the Testnet release (P8), not to the demo.
- Proof that a visitor owns the account they name.
- Automatic renewal of the agent's verification.
- More than one machine. The limits, the task table and the indexer's database are in one process.
