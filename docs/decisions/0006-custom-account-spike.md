# ADR 0006 · Custom account spike

**Status:** spike finished on 2026-11-25. Nothing in the smart wallet has changed. The decision at the end is open.

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

`npm run check` and `npm run test:integration` passed with the spike included.

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
| Does it fit the network limits? | Yes: 3,914,760 instructions, 13 footprint entries, 4 writes, a minimum resource fee of 19,495 stroops. | Local network |

The cost is not comparable with the wallet's `execute` figure in the [P4 record](../P4_VALIDATION.md) (4,849,451 instructions). The probe's policy is smaller and it keeps no audit chain.

## What this path changes

These are the differences from `execute` that a wallet with `__check_auth` would have to accept or design around.

- **The agent signs as a key, not as an account.** `execute` uses `require_auth` on the signer's Stellar account, so the host applies that account's signers and thresholds. Inside `__check_auth` the contract verifies a raw ed25519 signature itself. The registered signer account is matched to the key by its 32 bytes. An account that has disabled or replaced its master key would still be able to sign here. The verifier's `SignerAccount` check does not cover that.
- **The policy must be named in what is signed.** The host's payload covers the network, the nonce, the expiry and the invocation, but not which policy applies. Without binding the policy ID into the signed message, a relayer could pick among an agent's policies. The probe signs `payload || policy_id`.
- **There is no policy sequence and no request deadline.** A plain transfer has no place for them. Replay is prevented by the host nonce, and the daily cap is checked at execution, so signing ahead cannot exceed it. What is lost is ordering between payments, and a deadline in Unix time: the signature's expiry ledger is chosen by the agent and is not visible to `__check_auth`.
- **Denials are reported as authorization failures.** Every refusal from `__check_auth` surfaces as `HostError: Error(Auth, InvalidAction)`. The contract's own code, such as `Error(Contract, #3)`, is only in the diagnostic events. The SDK's `contractErrorName` reads the leading host error, so today it would report an authorization failure and not `LimitExceeded`.
- **`__check_auth` is a second way to spend.** Adding it makes the wallet's address something any contract can ask to authorize. It must deny by default and share the budgets with `execute`, or the two paths add up.
- **Clients sign differently.** The entry cannot be signed with the Stellar SDK's `authorizeEntry` as it stands for an account. The client builds the payload hash, signs it with the policy ID, and writes the account's own signature value into the entry. The test does this by hand.

## Not shown

- A real x402 client, facilitator or HTTP flow. The `@x402/stellar` package was not used; this tests the on-chain shape only.
- Protocol 30 and CAP-71 `AddressV2` credentials. The local network is protocol 29, where simulation records legacy address credentials. Testnet is on protocol 30.
- Whether recording-mode simulation alone gives a sufficient footprint. The tests assemble from the enforced simulation.
- Everything the probe leaves out: an owner, policy approval and revocation, pause, several policies, the audit chain, TTL extension and archival.
- A payee-side verification gate, which the compatibility notes also ask for.
- Any security review of this path.

## Decision to make

The spike answers "can it work" with yes. Whether to build it is open.

1. **Add `__check_auth` to the smart wallet** as a second path that shares policy state with `execute`. The wallet then pays x402-style services directly. It needs decisions on the points under "What this path changes", an SDK signing helper, and its own adversarial tests. It could replace the planned restricted service adapter (P9) as the "service payment" of README milestone 3, or sit beside it.
2. **Keep `execute` only** and record the incompatibility in the compatibility notes. Nothing in the SOW requires this path.

The contract interface freezes at the final Testnet deployment (P8), so option 1 is cheapest before then.
