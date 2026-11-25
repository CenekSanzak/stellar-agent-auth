# ADR 0010 · The owner demo

Decided on 2026-11-25, in P7.

## Problem

The contracts, SDK and CLI show that the wallet works. They do not show an owner what they are agreeing to, or what happens when they change their mind. The demo has to do that in a browser, and it has to stay honest about three things: who signs what, what is really on the ledger, and how far an action has got.

## Decision

`apps/demo` has two parts: a page (`src/`) and a server (`server/`).

### The owner signs in the browser, as the transaction source

Every owner action is one transaction with the owner's account as its source. The owner signs the envelope once, and that signature is also the owner's authorization for the call. The SDK's pipeline does the rest in the page: it simulates, checks that the owner would authorize exactly the call that was built, assembles and submits.

The owner's signer is one of two:

- **Freighter**, through `@stellar/freighter-api` and the SDK's `walletAdapterSigner`, which accepts a signed transaction only if its hash is unchanged and the signature verifies against the owner's address. The page refuses a wallet that is on another network.
- **A key generated in the tab**, on the local network only. A browser wallet has to be configured by hand for a private network, and the tests run in a browser with no extension. The key lives in the tab's session storage and is worth nothing elsewhere. It is never offered on Testnet.

The page never has a field for a secret key.

### The page reads the network itself

Balances, the pause flag, policies and their budgets, the agent's identity and its verification result are read from the contracts through the RPC, in the page. From the demo server the page takes only the deployment's addresses and the list of scenarios. After every action the page reads everything back; it does not show what an action's result says should now be true.

History comes from the indexer and is verified in the page with `readIndexedHistory` ([ADR 0009](0009-durable-history.md)): the entries are hashed and linked again and compared with the head read from the wallet.

### The owner creates the wallet

The setup deploys everything except the wallet and installs the wallet's code. The owner deploys their own wallet from the page, because the wallet's constructor requires the owner's authorization. Every owner's wallet uses the deployment's salt, so the wallet address follows from the owner's address, and the server can work it out without being told.

### The server does a fixed set of things

The server holds the agent's key, the sponsor's and the funder's. What can be asked of it:

- which wallet belongs to an owner address;
- one faucet payment of a fixed amount into that wallet;
- one of six named scenarios, under a named policy.

A scenario's recipient and amount are decided in the server, from the deployment and from the policy as the wallet stores it. Nothing a caller sends becomes part of what the agent signs, apart from the choice of policy. The server listens on loopback, accepts JSON bodies only, and checks the request's origin: a JSON content type cannot be sent by a cross-site form, so another page in the same browser cannot make the agent pay.

Before it starts anything for a wallet, the server reads the wallet's owner and registries from the network and compares them with the session's owner and the deployment.

### The sponsor and the indexer run inside the server

They are the code of `services/submitter` and `services/indexer`, started through the functions those packages export, each with its own key and state. They are not separate processes here because both are configured for a wallet, and the wallet does not exist until the owner creates it. A deployment whose wallet is known in advance runs them separately, which is how they are built and tested.

### A refusal is found before anything is submitted

The agent simulates each payment. If the wallet refuses, nothing is signed for submission and nothing reaches the ledger. The server reports the refusal to the indexer as an attempt, and the page lists attempts apart from the ledger's entries, with no transaction link, because there is no transaction. On the account path the agent asks the wallet first with `check_payment`, since a refusal there carries no reason ([ADR 0007](0007-account-payment-path.md)).

### Stages are shown as they are reached

An owner action moves through: preparing, waiting for a signature, submitted, and then confirmed, failed, refused or not yet known. "Submitted" is shown as not yet in effect. This matters most for revocation: until it is confirmed, an agent payment can still go through. An outcome that is not known is shown as not known, with a warning not to repeat the action. Unsettled transactions are kept in the browser's local storage, so a reload does not forget one.

### No framework

The views are functions from one state object to HTML text, and a section is replaced when its text changes. The policy form is drawn once per wallet and read when submitted, so a refresh never clears what the owner is typing. Everything rendered is escaped. Because the views are plain functions, the wording of states that a live network rarely produces, such as an expired result or an unsettled transaction, is covered by unit tests.

## Consequences

- The demo shows the SOW's cases in a browser: one allowed payment, a payment over the limit, a payment to an unknown recipient, and a payment after revocation, plus the daily limit, a pause, and both account-path payments.
- The refusals have no transactions. Evidence of a failed transaction on the ledger comes from a payment signed before a revocation and submitted after it, which the CLI example does and P8 records.
- Signing through Freighter is not exercised by any test in the repository. It has to be tried by hand, and P8 does that on Testnet.
- The server holds three keys in one process and serves one owner at a time. It is a demo server, not a pattern for running an agent.
- The setup publishes a fixture result and runs on the local network only. The Testnet deployment, with the real verifier, is P8.
- The browser test needs an installed Chrome. `playwright-core` drives it and downloads nothing.
