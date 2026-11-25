# ADR 0007 · Account payment path

The smart wallet gains a second way to pay. [ADR 0006](0006-custom-account-spike.md) decided it and showed it on a test contract; this record describes what is built into `contracts/smart-wallet`. The wallet's first path, `execute`, is unchanged and is described in [ADR 0005](0005-smart-wallet.md). The SDK side is `packages/sdk/src/account.ts`.

**Status:** built, and tested on the local network and on Testnet. The evidence for the whole of P9 is in the [P9 validation record](../P9_VALIDATION.md). The contracts are not part of a kept Testnet deployment yet; that is P8.

## Why two paths

`execute` covers a payment the agent pushes: the agent signs a request and the wallet moves the funds. A service that pulls its payment works the other way round. Inside its own call it transfers from the payer, and the payer must authorize that transfer. An x402 `exact` payment on Stellar has this shape.

The wallet answers that as a custom account. When an asset contract requires the wallet's authorization, the host calls the wallet's `__check_auth`, and the wallet's policy decides. The asset, the service and the relayer need to know nothing about the wallet.

## What `__check_auth` authorizes

Two shapes, and nothing else.

- **A plain transfer.** One context: `transfer(wallet, recipient, amount)` on a contract the named policy lists as an asset. Whoever holds the signed entry can make exactly that transfer. This is what an x402 `exact` payment needs: a facilitator makes the transfer and the service observes it.
- **A service payment.** Two contexts: `pay_for_service(wallet, asset, recipient, amount, service_id)` on the one service the policy permits, and below it the transfer of exactly that amount of that asset to that recipient. The entry is rooted at the service call, so the transfer cannot be made without it.

The second shape exists because the first does not bind the payment to anything. A plain transfer entry can be submitted by anyone who holds it, with or without the service running. For a service contract that must issue something in exchange, the payer has to authorize the service's own call.

It checks, in order:

1. The policy named in the signature exists (`NotFound`).
2. The policy signer's ed25519 key signed the host payload followed by the policy hash. A wrong signature fails with a host crypto error.
3. The contexts are one of the two shapes, moving this wallet's own funds, with a positive amount (`PolicyDenied`; `InvalidInput` for the amount). For a service payment the call must be on the policy's service contract, be named `pay_for_service`, carry the policy's service ID, and state the same asset, recipient and amount as the transfer below it.
4. Everything `execute` checks about the wallet, the policy and the transfer: not paused, not revoked, inside the validity window, the action kind permitted, an asset the policy lists, a recipient on the allowlist and not on the blocklist, the per-payment cap, today's budget, the live identity and signer, and the provider's current verification result. A service payment's transfer is held to the same rules as a plain one.

It then stores the spend and appends an audit entry. The asset contract moves the funds only after `__check_auth` returns; if that transfer fails, the invocation fails and the spend and the audit entry are rolled back.

Everything else is refused: `approve`, `burn`, `transfer_from`, a transfer of another holder's funds, a call on the wallet itself, another service or another method of the permitted one, the transfer before the call, an allowance below the call, three calls under one signature, no call, and any deployment. The wallet is not a general signer.

### Service permission in a policy

The v1 ABI has carried `ServicePermission::Restricted(ServiceRule { contract, service_id })` and the `ServicePayment` action kind since [ADR 0002](0002-v1-abi-and-authorization.md); the wallet used to refuse such policies. It now accepts them. A policy may permit plain transfers, one service, or both, and the service must be a contract other than the wallet. `execute` still pushes plain transfers only: a service payment has to be authorized together with the service's call, which only the account path can do.

`pay_for_service` is a fixed interface. A service that wants to be paid this way offers that method, requires the wallet's authorization for it, and transfers exactly the stated amount inside it. `contracts/demo-service` is one.

## One budget

`execute` and the account path run the same two functions, `execution::gate` and `execution::permit`, on the same stored policy state. Neither can spend what the other has spent, and a rule changed in one place changes for both.

That budget is the per-payment cap, the daily cap and, where the policy sets one, the total cap for the policy's whole life ([ADR 0008](0008-error-codes.md)).

The account path does not use or advance the policy sequence. The sequence orders `execute` requests, and an account payment must not invalidate one that is already signed.

## The signature

The wallet's credential carries an `AccountSignature { policy_hash, signature }`. The agent key signs 64 bytes: the host's signature payload, then the policy hash.

- The host payload covers the network, a nonce, the expiry ledger and the exact invocation. It does not say which policy applies. Without the policy hash in the signed message, whoever relays the entry could move it to another policy of the same agent, such as one with a higher cap. A test approves a small and a large policy for one agent and shows a signature for the small one fails under the large one.
- The policy hash is already bound to this wallet and this network ([ADR 0002](0002-v1-abi-and-authorization.md)).
- The message is 64 bytes, so it cannot be confused with the 32-byte hashes the same key signs for `execute` or for a transaction.

## What differs from `execute`, and is accepted

- **The agent signs as a key, not as an account.** `execute` uses `require_auth` on the signer's Stellar account, so the host applies that account's signers and thresholds. Here the wallet verifies the signature itself against the 32-byte key of the registered signer account. An account that has disabled or replaced its master key can still sign on this path. The owner-facing text must say so, and the verifier's `SignerAccount` check does not cover it.
- **No sequence and no request deadline.** A plain transfer has no place for them. The host nonce prevents replay. The entry's expiry ledger bounds its life; the agent chooses it and `__check_auth` cannot see it. The SDK signs for at most 20 ledgers. The daily cap is checked when a payment executes, so entries signed ahead cannot exceed it together.
- **A refusal is an authorization failure.** Every refusal from `__check_auth` reaches the caller as `HostError: Error(Auth, InvalidAction)`. The wallet's own code ([ADR 0008](0008-error-codes.md)) is only in the diagnostic events, which the public Testnet RPC does not return.

## Explaining a refusal: `check_payment`

`check_payment(policy_hash, action)` runs step 4 above for a prospective payment of either shape, authenticates nobody, stores nothing, and returns the state the payment would leave or the wallet's own error. For a service payment it also requires the action's service to be the one the policy permits. A client calls it before signing; the SDK's `readPaymentCheck` wraps it. It is the only place a client learns that a payment would fail for the daily cap and not for a bad signature.

It reports what would happen now. A payment can still be refused later if the state changes before it is included.

## Audit

An account payment appends `AuditOutcome::AccountPayment { policy_hash, authorization, action }`, with the policy signer as actor. `action` is the plain transfer, or the service payment with its service. `authorization` is the host payload hash, which is unique to the authorization and lets an indexer tie the entry to the transaction that carried it. The chain, the head and the `audit_v1` event are as in ADR 0005.

## ABI additions

Schema version 1 is kept, because no wallet has been deployed to Testnet. The policy, action and existing audit vectors are unchanged.

- `AccountSignature { policy_hash, signature }`.
- `AuditOutcome::AccountPayment(AccountPayment)` and `AccountPayment { policy_hash, authorization, action }`.
- Wallet entry points `__check_auth` and `check_payment`.
- `identity::account_key`, the key of a standard account address.
- The constant `SERVICE_PAYMENT_METHOD = "pay_for_service"`, and `Action::transfer`.
- The wallet now approves policies with a `Restricted` service permission.

## Evidence

The [P9 validation record](../P9_VALIDATION.md) has the counts, the Testnet transactions and what is not shown. In short: host tests with enforced authorization for every shape and refusal, unit and spec tests of the SDK side, a scenario that runs on the local network and on Testnet, and the CLI example driving the built CLI and submitter.
