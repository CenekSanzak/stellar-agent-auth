# ADR 0002 · v1 ABI and native authorization

The P1 interface uses Soroban contract values for the registry records, wallet policies, actions and events. The ABI lives in `contracts/shared-types` and the SDK mirrors it in `packages/sdk/src/types.ts` and `encoding.ts`. Registry lifecycle rules and wallet policy enforcement are implemented in later phases.

## Canonical hashes

A policy, action or audit hash is SHA-256 of one `ScVal` XDR vector:

```text
[Symbol("stellar_agent_auth"), U32(1), Symbol(purpose), Bytes(network_id), Address(wallet), record]
```

The purpose is `policy`, `action` or `audit`. The network ID is SHA-256 of the exact Stellar network passphrase. The contract takes the network ID from the ledger. Actions and audit records also carry their wallet address inside the record. Structs encode as symbol-keyed maps in byte order. Enums encode as vectors beginning with a variant symbol. An absent optional score encodes as void. The service permission encodes as `Disabled` or `Restricted(ServiceRule)` so the selected SDK can expose a stable ABI in both WASM and host tests.

Policy hashes use the immutable policy only. Sort asset limits by asset address and recipient lists by address. Standard account addresses sort before contract addresses, then by their raw 32-byte IDs. Sort required checks and action kinds by variant name. Reject duplicates within each list. The blocked list takes precedence when a recipient appears in both lists. Cap the payload at four assets, 32 allowed recipients, 32 blocked recipients, eight check kinds and two action kinds. A metadata URI is at most 2,048 bytes. The evidence and metadata hashes link to external bytes. The audit genesis predecessor is 32 zero bytes.

Use `u64` for application sequences, agent IDs, revisions and Unix seconds, and positive `i128` contract units for transfers and caps. The SDK uses `bigint` for both. A JSON transport represents these values as decimal strings. The verification record separates live assessments from fixture data and distinguishes absent scores from zero. The serious wallet risk mask reserves bits 0, 1 and 2 for known compromise, confirmed malicious activity and a threat feed match. Unknown bits are invalid in v1.

## Events

| Topics in order | XDR data |
| --- | --- |
| `identity_v1`, agent ID | `AgentIdentity` after the change |
| `provider_v1`, provider address | `ProviderRecord` (mode and approval) after the change; amended by [ADR 0004](0004-verification-registry.md) |
| `assessment_v1`, agent ID, provider address | `VerificationResult` after publication or revocation |
| `audit_v1`, audit sequence | Map with `entry` and `hash`. The entry includes the outcome, wallet, actor, previous hash, ledger and timestamp. |

## Signing and execution

1. Build `wallet.execute(request)` using the sponsor as the transaction source. Simulate in recording mode to obtain the native agent authorization entry.
2. Before signing, match the account credential, wallet address, `execute` method, single encoded argument and empty list of child invocations against the expected transfer. Sign the authorization entry using the configured network passphrase. The SDK caps its validity at 20 ledgers beyond the observed ledger.
3. Attach the agent entry, simulate with authorization enforcement to obtain the footprint and resource fee, then have the sponsor sign and submit the transaction envelope. The sponsor pays the fee as the transaction source. A separate fee-bump envelope is unnecessary for this flow.
4. Confirm the transaction by hash. The host uses the signed entry's nonce and expiration ledger to guard replay. The expiration ledger is inclusive. The wallet independently uses the next policy sequence and an exclusive Unix timestamp deadline. Policy validity uses `valid_after <= ledger_time < valid_until`.

An owner-authorized constructor binds the initial roles atomically. If the deployer is a different account, recording its distinct owner's constructor authorization requires `record_allow_nonroot`. The action signer uses ordinary recording mode and expects a single wallet root invocation. [Stellar authorization example](https://developers.stellar.org/docs/build/smart-contracts/example-contracts/auth)

For `wallet → token.transfer(wallet, recipient, amount)`, the token sees the wallet as its direct invoker and can authorize that wallet's debit. For the future `wallet → service → token.transfer(...)` path, the token's direct invoker is the service. After validating the typed service request, the wallet must use `authorize_as_current_contract` before calling the service to grant the exact nested token call with the fixed asset, method and `(wallet, recipient, amount)` arguments. The P9 service adapter will need its own deeper-call tests. [Stellar composable authorization model](https://stellar.org/blog/foundation-news/stellars-composable-auth-model)
