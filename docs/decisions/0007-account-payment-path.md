# ADR 0007 · Account payment path

The smart wallet gains a second way to pay. [ADR 0006](0006-custom-account-spike.md) decided it and showed it on a test contract; this record describes what is built into `contracts/smart-wallet`. The wallet's first path, `execute`, is unchanged and is described in [ADR 0005](0005-smart-wallet.md). The SDK side is `packages/sdk/src/account.ts`.

**Status:** the contract path, the SDK signing helper and the payment check are built and tested on the local network. A service contract that pulls its payment, the CLI command, finer error codes, the lifetime cap and a Testnet payment from the real wallet are the rest of P9 and are not built yet.

## Why two paths

`execute` covers a payment the agent pushes: the agent signs a request and the wallet moves the funds. A service that pulls its payment works the other way round. Inside its own call it transfers from the payer, and the payer must authorize that transfer. An x402 `exact` payment on Stellar has this shape.

The wallet answers that as a custom account. When an asset contract requires the wallet's authorization, the host calls the wallet's `__check_auth`, and the wallet's policy decides. The asset, the service and the relayer need to know nothing about the wallet.

## What `__check_auth` authorizes

One thing: a single `transfer(wallet, recipient, amount)` call on a contract, where the named policy lists that contract as an asset and the recipient as allowed. It checks, in order:

1. The policy named in the signature exists (`NotFound`).
2. The policy signer's ed25519 key signed the host payload followed by the policy hash. A wrong signature fails with a host crypto error.
3. There is exactly one context, it is a contract call named `transfer` with three arguments, the first is this wallet and the amount is positive (`PolicyDenied`; `InvalidInput` for the amount).
4. Everything `execute` checks about the wallet, the policy and the transfer: not paused, not revoked, inside the validity window, an asset the policy lists, a recipient on the allowlist and not on the blocklist, the per-payment cap, today's budget, the live identity and signer, and the provider's current verification result.

It then stores the spend and appends an audit entry. The asset contract moves the funds only after `__check_auth` returns; if that transfer fails, the invocation fails and the spend and the audit entry are rolled back.

Everything else is refused: `approve`, `burn`, `transfer_from`, a transfer of another holder's funds, a call on the wallet itself, two calls under one signature, no call, and any deployment. The wallet is not a general signer.

## One budget

`execute` and the account path run the same two functions, `execution::gate` and `execution::permit`, on the same stored policy state. Neither can spend what the other has spent, and a rule changed in one place changes for both.

The account path does not use or advance the policy sequence. The sequence orders `execute` requests, and an account payment must not invalidate one that is already signed.

## The signature

The wallet's credential carries an `AccountSignature { policy_hash, signature }`. The agent key signs 64 bytes: the host's signature payload, then the policy hash.

- The host payload covers the network, a nonce, the expiry ledger and the exact invocation. It does not say which policy applies. Without the policy hash in the signed message, whoever relays the entry could move it to another policy of the same agent, such as one with a higher cap. A test approves a small and a large policy for one agent and shows a signature for the small one fails under the large one.
- The policy hash is already bound to this wallet and this network ([ADR 0002](0002-v1-abi-and-authorization.md)).
- The message is 64 bytes, so it cannot be confused with the 32-byte hashes the same key signs for `execute` or for a transaction.

## What differs from `execute`, and is accepted

- **The agent signs as a key, not as an account.** `execute` uses `require_auth` on the signer's Stellar account, so the host applies that account's signers and thresholds. Here the wallet verifies the signature itself against the 32-byte key of the registered signer account. An account that has disabled or replaced its master key can still sign on this path. The owner-facing text must say so, and the verifier's `SignerAccount` check does not cover it.
- **No sequence and no request deadline.** A plain transfer has no place for them. The host nonce prevents replay. The entry's expiry ledger bounds its life; the agent chooses it and `__check_auth` cannot see it. The SDK signs for at most 20 ledgers. The daily cap is checked when a payment executes, so entries signed ahead cannot exceed it together.
- **A refusal is an authorization failure.** Every refusal from `__check_auth` reaches the caller as `HostError: Error(Auth, InvalidAction)`. The wallet's own code is only in the diagnostic events, which the public Testnet RPC does not return.

## Explaining a refusal: `check_payment`

`check_payment(policy_hash, asset, recipient, amount)` runs step 4 above for a prospective payment, authenticates nobody, stores nothing, and returns the state the payment would leave or the wallet's own error. A client calls it before signing; the SDK's `readPaymentCheck` wraps it. It is the only place a client learns that a payment would fail for the daily cap and not for a bad signature.

It reports what would happen now. A payment can still be refused later if the state changes before it is included.

## Audit

An account payment appends `AuditOutcome::AccountPayment { policy_hash, authorization, transfer }`, with the policy signer as actor. `authorization` is the host payload hash, which is unique to the authorization and lets an indexer tie the entry to the transaction that carried it. The chain, the head and the `audit_v1` event are as in ADR 0005.

## ABI additions

Schema version 1 is kept, because no wallet has been deployed to Testnet. The policy, action and existing audit vectors are unchanged.

- `AccountSignature { policy_hash, signature }`.
- `AuditOutcome::AccountPayment(AccountPayment)` and `AccountPayment { policy_hash, authorization, transfer }`.
- Wallet entry points `__check_auth` and `check_payment`.
- `identity::account_key`, the key of a standard account address.

## Evidence

- **Host tests:** 10 in `contracts/smart-wallet/src/test_account.rs`, with authorization enforced. They make real `asset.transfer` calls carrying a signed entry, and call `__check_auth` as the host would. The 30 existing wallet tests pass unchanged.
- **Unit tests:** `tests/unit/account.test.ts` for signing and the payment check; the spec test compares the SDK's `AccountSignature` and `check_payment` encoding with the wallet's published interface.
- **Local network:** 4 tests in `tests/integration/account-path.test.ts`. The agent signs through the SDK, and an SDK `Sponsor` configured only for the asset's `transfer` submits. `execute` and the account path alternate up to the daily cap and then both refuse.
- **Cost on the local network:** 4,737,045 instructions and a minimum resource fee of 23,253 stroops for an account payment, against 4,849,451 instructions for `execute` in the [P4 record](../P4_VALIDATION.md).

Not shown yet: a Testnet payment from the real wallet, a service contract that pulls the payment, and protocol 30 credentials on the real wallet. The spike showed the last on the test contract.
