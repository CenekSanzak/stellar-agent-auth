# Stellar AI Agent Verification & Authenticated Wallet

An AI agent needs to pay for data or API services without asking its owner to sign every payment. The owner funds a Stellar smart wallet and approves a policy: **up to 5 USDC per payment, 20 USDC per day, only to approved providers, for seven days**. The agent can make payments within those limits, and the owner can revoke access at any time.

The demo will reproduce this scenario on Stellar Testnet using a clearly identified test asset. It will show a successful payment and rejected requests that exceed the budget, use an unapproved recipient, or arrive after revocation. This gives agent developers a concrete example they can integrate through the SDK.

**Current status:** P1 adds the shared v1 contract types, canonical hashes and a local probe for agent authorization and sponsored transfers. Registry and wallet implementation follow in P2–P4. See [development setup](docs/DEVELOPMENT.md) and [requirements](docs/REQUIREMENTS.md).

## Background

The idea for this project came while building **Algoria during the Stellar Pro Hackathon**, where we worked with a local wallet and started exploring how AI agents could safely interact with Stellar accounts.

During this work, we came across two recently finalized Ethereum standards:

- **ERC-8126 — AI Agent Verification**  
  [Read ERC-8126](https://eips.ethereum.org/EIPS/eip-8126)

- **ERC-8196 — AI Agent Authenticated Wallet**  
  [Read ERC-8196](https://eips.ethereum.org/EIPS/eip-8196)

Together, these ERCs introduce a model where AI agents can be verified and then given limited, policy-based authority to perform transactions without receiving unrestricted control over a user's wallet.

The project proposes to **implement these concepts natively on Stellar**, adapting the Ethereum-specific parts of the standards to Stellar accounts, Soroban smart contracts, Stellar assets, and programmable authorization.

The goal is to explore a Stellar-compatible implementation where AI agents can be verified and granted limited permissions such as spending limits, approved assets, approved contracts or addresses, expiration times, and revocation.

Rather than simply copying the Solidity implementations, the project would preserve the core behavior of ERC-8126 and ERC-8196 while designing the equivalent interfaces and flows around Stellar's architecture.

## What verification establishes

[ERC-8126](https://eips.ethereum.org/EIPS/eip-8126) assesses risks using registered agent metadata. Its checks cover tokens, media, code, web endpoints, and wallets. A provider's result describes the checks performed and the risks found at assessment time; its score runs from 0 to 100, with lower scores meaning lower risk.

A signature demonstrates control of the signing key. It does not prove that the agent's decisions are correct. A provider assessment does not guarantee future behavior. ERC-8126 also describes privacy proofs; the first release's evidence hashes do not provide those proofs.

[ERC-8196](https://eips.ethereum.org/EIPS/eip-8196) supplies the execution rules: check current verification before each action and enforce the owner's policy. Malicious wallet findings must block execution even if the overall score is acceptable. Verification and permission are both required.

The Stellar adaptation and deferred features are described in [ARCHITECTURE.md](ARCHITECTURE.md). Supported checks and missing coverage will be explicit, so an unperformed check is never presented as a pass.

## High-Level Architecture

```text
User / Wallet Owner
        ↓
Agent Verification Layer
(ERC-8126 inspired)
        ↓
Policy & Permission Layer
(ERC-8196 inspired)
        ↓
Soroban Smart Wallet
        ↓
Stellar Assets / Contracts
        ↓
Events & Audit History
```

The verification layer checks the AI agent's identity or attestations. The policy layer defines what the agent is allowed to do, such as spending limits, allowed assets, approved addresses, expiration, and revocation. The Soroban smart wallet enforces these rules before executing transactions.

## Deliverables

- **Stellar-compatible ERC-8126 implementation** for AI agent verification and attestations.
- **Stellar-compatible ERC-8196 implementation** for policy-based AI agent wallet authorization.
- **Soroban smart wallet contracts** with spending limits, allowlists, expiration, and revocation.
- **Agent verification + execution flow** demonstrating Verify → Authorize → Execute.
- **TypeScript SDK / CLI** for integrating and testing the contracts.
- **Testnet deployment and demo application** showing allowed and rejected agent transactions.
- **Open-source repository, tests, and documentation** for other Stellar developers.

## Grant milestones

These are proposed delivery targets. The scaffold is the starting point, not a completed milestone.

| Milestone | Deliverable | Evidence of completion |
| --- | --- | --- |
| 1. Agent registration and verification | Agent and verification registries, one provider integration, and a documented mapping to the EIPs. | A reproducible example registers an agent, publishes a result, and reads it back. Tests cover unauthorized publication, identity changes, expiry, and revocation. Documentation lists implemented and deferred checks. |
| 2. Policy-controlled payments | Wallet funding, per-payment and daily limits, approved recipients, expiry, owner pause, and revocation. | Automated signed tests demonstrate one permitted payment and all rejection cases listed in the architecture. A failed downstream call leaves balances and counters unchanged. |
| 3. Developer integration | TypeScript SDK, CLI, and one restricted service-contract integration. | A public example runs registration → verification → policy approval → payment → revocation from a documented setup. Both a transfer and the service call succeed; an unsupported method is rejected. |
| 4. Testnet demonstration | Demo application, audit history, deployment records, and developer documentation. | Published contract IDs, transaction links, a demo recording, and a repeatable walkthrough show the payment scenario. Audit events reconstruct the wallet's stored history hash. All milestone checks pass in CI. |

The architecture defines the acceptance cases for these milestones. Test fixtures will be labelled separately from real provider assessments.

# TODO
