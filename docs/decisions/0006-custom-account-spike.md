# ADR 0006 · Custom account spike

**Status:** spike finished and decided on 2026-11-25: the smart wallet will gain this path. It is planned as P9 and not built yet; nothing in the smart wallet has changed.

## Question

The smart wallet pays only through its own `execute` entry point ([ADR 0005](0005-smart-wallet.md)). A service that expects the payer to authorize `asset.transfer(payer, payee, amount)` directly cannot be paid that way. That is the shape of an x402 `exact` payment on Stellar: the payer signs one authorization entry for the transfer, and a fee-paying facilitator submits it. [The ERC compatibility notes](../erc-compatibility.md) (T5) and [issue #2](https://github.com/CenekSanzak/stellar-agent-auth/issues/2) ask for exactly this.

Can a contract enforce an owner's policy as the *payer* of a plain token transfer, with the asset and the relayer knowing nothing about it?

## What was built

`tests/contracts/account-probe` is a throwaway custom account. The host calls its `__check_auth` when the asset requires the contract's authorization. It holds one fixed policy and has no owner. Inside `__check_auth` it:

1. verifies the agent's ed25519 signature over the host's payload hash followed by the policy ID;
2. admits exactly one context: `asset.transfer(this, recipient, amount)` for the policy's asset and a listed recipient;
3. applies the per-payment cap and the per-UTC-day budget;
4. calls the agent registry's `current` and the verification registry's `check`, as the wallet does;
5. stores the new spend and publishes an event.

It is not a product contract. It has no policy approval, revocation, pause, audit chain or TTL handling.

## Evidence

- **Host tests:** 8 in `tests/contracts/account-probe/src/test.rs`. Authorization is enforced, not mocked. Four tests make a real `asset.transfer` carrying a signed authorization entry; the rest call `__check_auth` as the host would.
- **Local network:** 4 in `tests/integration/account-probe.test.ts`, on the protocol 29 Quickstart with real keys, both registries and an issued asset.
- **Testnet:** the same 4, run on 2026-11-25 against protocol 30 with `RUN_TESTNET_SPIKE=1`. Simulation recorded CAP-71 `AddressV2` credentials. The payment is transaction [`34478d4c…f3122c`](https://stellar.expert/explorer/testnet/tx/34478d4ca31102d1bd1d335e67bbe85269ea1acaab38bb004836e1ec67f3122c) in ledger 5,917,983, from the test account `CDRB7SY52F4GCRBKRT4SENDY4IK24KLKLV4CBKJPUDRA6BEUN7ASFKHS`. Everything in that run was deployed from keys generated at runtime and is throwaway.

`npm run check` and `npm run test:integration` passed with the spike included. The scenario is shared by both networks in `tests/integration/support/account-probe-scenario.ts`.

## Answers

| Question | Answer | Evidence |
| --- | --- | --- |
| Can `__check_auth` call other contracts? | Yes. It calls both registries, and the verification registry calls the agent registry in turn. | Host and local network |
| Can it write state and publish events? | Yes. The spend is stored and the event is in the transaction's events. | Host and local network |
| Does a failed transfer roll the spend back? | Yes. A payment within every cap but above the balance leaves the spend unchanged. | Host |
| Is the authorization tree free of sub-invocations? | Yes. Recording mode returns one entry, for the account, with no children. | Local network |
| Can an unmodified relayer submit it? | Yes. The SDK `Sponsor`, configured only for the asset's `transfer`, sponsored the payment. It authorizes nothing. | Local network |
| Is replay prevented? | Yes, by the host nonce. A spent entry fails with `Error(Auth, ExistingValue)`. | Host and local network |
| Is the signature bound to the exact payment? | Yes. Another amount or recipient is another payload hash. | Host and local network |
| Can the account be made to authorize anything else? | Not in this probe. `approve`, `burn`, another asset, another holder's funds, two calls under one signature, no call, and a deployment are all refused. | Host |
| Is live state consulted? | Yes. A payment signed before a result revocation is refused after it, and an identity update is refused. | Host; revocation also on the local network |
| Does it fit the network limits? | Yes: 3,914,760 instructions, 13 footprint entries, 4 writes, a minimum resource fee of 19,495 stroops. Testnet measured 3,917,920 instructions and 19,499 stroops. | Local network and Testnet |
| Does it work with protocol 30 credentials? | Yes. The Stellar SDK's `authorizeEntry` builds the payload for either credential type and takes the account's signature value from a callback. | Testnet |
| Can a client learn why a payment was refused? | Not from the error. See below. | Local network and Testnet |

The cost is not comparable with the wallet's `execute` figure in the [P4 record](../P4_VALIDATION.md) (4,849,451 instructions). The probe's policy is smaller and it keeps no audit chain.

## What this path changes

These are the differences from `execute` that a wallet with `__check_auth` would have to accept or design around.

- **The agent signs as a key, not as an account.** `execute` uses `require_auth` on the signer's Stellar account, so the host applies that account's signers and thresholds. Inside `__check_auth` the contract verifies a raw ed25519 signature itself. The registered signer account is matched to the key by its 32 bytes. An account that has disabled or replaced its master key would still be able to sign here. The verifier's `SignerAccount` check does not cover that.
- **The policy must be named in what is signed.** The host's payload covers the network, the nonce, the expiry and the invocation, but not which policy applies. Without binding the policy ID into the signed message, a relayer could pick among an agent's policies. The probe signs `payload || policy_id`.
- **There is no policy sequence and no request deadline.** A plain transfer has no place for them. Replay is prevented by the host nonce, and the daily cap is checked at execution, so signing ahead cannot exceed it. What is lost is ordering between payments, and a deadline in Unix time: the signature's expiry ledger is chosen by the agent and is not visible to `__check_auth`.
- **Denials are reported as authorization failures.** Every refusal from `__check_auth` surfaces as `HostError: Error(Auth, InvalidAction)`. The contract's own code, such as `Error(Contract, #3)`, is only in the diagnostic events. The local RPC appends those to the error text; the public Testnet RPC returned the bare authorization error for all eight refusals. So on Testnet a client cannot tell an over-limit payment from a bad signature. The wallet needs a read-only entry point that evaluates a prospective payment and returns its own error, and the SDK should call it before signing.
- **`__check_auth` is a second way to spend.** Adding it makes the wallet's address something any contract can ask to authorize. It must deny by default and share the budgets with `execute`, or the two paths add up.
- **Clients sign differently.** The agent does not sign the payload hash alone, and the signature value is the account's own type, not the one a Stellar account uses. The Stellar SDK's `authorizeEntry` supports this through a signing callback that returns the signature value, which is what the test uses. The SDK in this repository has no helper for it yet.

## Not shown

- A real x402 client, facilitator or HTTP flow. The `@x402/stellar` package was not used; this tests the on-chain shape only.
- The reason for each refusal on Testnet. Its RPC does not return diagnostics, so those eight refusals are known to be refusals, and their reasons are known only from the local network and the host tests.
- Whether recording-mode simulation alone gives a sufficient footprint. The tests assemble from the enforced simulation.
- Everything the probe leaves out: an owner, policy approval and revocation, pause, several policies, the audit chain, TTL extension and archival.
- A payee-side verification gate, which the compatibility notes also ask for.
- Any security review of this path.

## Decision

Decided on 2026-11-25: **add `__check_auth` to the smart wallet** as a second path that shares policy state with `execute`. The alternative was to keep `execute` only and record the incompatibility; nothing in the SOW requires this path.

Reasons:

- It is the general answer to what the plan's restricted service adapter was a narrow answer to. A service that pulls its payment needs the payer's authorization for the transfer, and with this path the service does not have to know the wallet.
- It is what the integrating project asks for ([compatibility notes](../erc-compatibility.md), T5; [issue #2](https://github.com/CenekSanzak/stellar-agent-auth/issues/2)).
- The contract interface freezes at the final Testnet deployment (P8). Adding the path afterwards would mean a new deployment and rework of the indexer and demo.

Consequences:

- The path replaces the restricted service adapter as P9, and P9 moves ahead of P6. The revised work package, with the other interface changes made in the same revision, is in the [implementation plan](../IMPLEMENTATION_PLAN.md).
- `execute` stays as it is. It keeps the properties the account path lacks: account-level signer rules, a policy sequence, a request deadline and precise errors.
- Accepted, and to be stated wherever the path is described: on the account path the agent signs as a key, so the signer account's own signers and thresholds are not applied.
- To be built with the path, from the findings above: the policy bound into the signed message, deny-by-default contexts, one budget for both paths, an audit entry for account payments, and a read-only preflight that explains a refusal.
- Still not shown and to be shown in P9: a recorded Testnet payment from the real wallet, and the path under a security review of the whole wallet, which this project does not include.
