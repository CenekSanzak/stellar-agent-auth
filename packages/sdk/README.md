# SDK

P0 exports `loadConfig(environment)` for validated non-secret local/Testnet connection settings. Run `npm run build` at the repository root before importing the workspace package.

```ts
import { loadConfig } from '@stellar-agent-auth/sdk';
const config = loadConfig({ STELLAR_NETWORK: 'local' });
```

Configuration does not sign, deploy or submit transactions, and does not implicitly load .env. See docs/DEVELOPMENT.md from the repository root for configuration and test commands.


P1 exports v1 ABI types, canonical XDR encoders, `policyHash`, `actionHash`, `auditHash` and `signActionAuthorization`. Use `bigint` for amounts, sequences and Unix timestamps. The authorization helper checks the entire expected `execute(request)` call before passing its payload to an agent signer. [ABI and signing flow](../../docs/decisions/0002-v1-abi-and-authorization.md)

P2 adds agent registry helpers. `registryOperation(contractId, method, args)` builds any registry call after the stateless checks the contract also enforces: `validateAgentMetadata` (non-empty `https://` URI of visible ASCII, at most 2,048 UTF-8 bytes, non-zero 32-byte hash), distinct controller and signer, and standard-account signers. `encodeRegistryArgs` returns the raw argument XDR. `signRegistryAuthorization` signs a controller, signer or new-signer entry only after matching the account credential, registry address, mutating method, exact arguments, absence of child invocations and an expiry at most 20 ledgers ahead. `readAgent`, `readCurrent` and `readAgentCount` simulate the read entry points and decode results with the strict `decodeIdentity`. Contract failures throw `AgentRegistryError` with the v1 error name, and `contractErrorName` maps `Error(Contract, #N)` text. Every mutation increments the revision, so pass the revision you last read as `expected_revision`.

P3 adds the verification registry client. `verificationOperation(contractId, method, args)` builds any call after the contract's stateless checks; `signVerificationAuthorization` signs an admin or provider entry only for the exact expected call, and a provider only for its own results. `buildResult` sorts checks and computes the aggregate with `riskScoreOf` (the ceiling of the mean of scored checks; absent, not zero, without any). `validatePublication`, `validateRequirement` and `evaluateResult` mirror the contract rules in order with the same error codes. `readProvider`, `readLatestResult`, `readCurrentResult`, `checkVerification` and `nextResultSequence` simulate reads and decode strictly with `decodeVerification` and `decodeProviderRecord`; failures throw `VerificationRegistryError`. Never authorize anything from `readLatestResult`. [ADR 0004](../../docs/decisions/0004-verification-registry.md)

P4 adds the smart wallet client.

- **Building calls:** `walletOperation(contractId, method, args)` builds any wallet call after the contract's stateless checks. `encodeWalletConstructorArgs` returns the deployment arguments.
- **Policy rules:** `canonicalPolicy` and `validatePolicy` mirror the wallet's approval rules, and `evaluateRequest` mirrors `execute` before its registry and asset calls. All three run in the same order and use the same error codes, throwing `WalletError`.
- **Requests and exposure:** `transferRequest` builds a request for the agent to sign with `signActionAuthorization`. `policyExposure` sums the daily caps and today's spend per asset across active policies, including the fresh budget a replacement starts.
- **Signing:**
  - `signWalletAuthorization` signs an owner entry only for the exact owner call.
  - `signFundingAuthorization` signs a funder entry only for `fund` with exactly one child, `asset.transfer(from, wallet, amount)`.
- **Reads:** `readWalletOwner`, `readWalletRegistries`, `readPaused`, `readActivePolicies`, `readPolicy`, `readPolicyState`, `readAuditHead` and `readWalletBalance` decode strictly.

A refused asset transfer is `TransferFailed`, never the asset's own error number. [ADR 0005](../../docs/decisions/0005-smart-wallet.md)

P5 adds the transaction pipeline, the fee sponsor and the domain invocations. Node-only helpers (a file journal and key references) are exported from `@stellar-agent-auth/sdk/node`.

- **Invocations:** `ownerInvocation`, `fundInvocation`, `executeInvocation`, `registryInvocation`, `verificationInvocation`, `contractDeployment` and `walletDeployment` each pair an operation with what every account involved agrees to. `authorizers` validate and sign an address entry. `checks` validate the tree an account authorizes through the envelope signature when it is the transaction source. A source without a check may authorize nothing.
- **Direct pipeline:** `invoke(context, source, invocation, journal)` records, authorizes, enforces, assembles under a fee ceiling, signs and submits. `prepare` stops before signing. `invokeSigned` submits an operation whose entries are already signed.
- **Statuses:** only a confirmed transaction is `success`. `failed`, `expired` and `rejected` are final. `pending` and `unknown` are not, and nothing is rebuilt while one is open in the same scope (`SubmissionUnsettled`). `settle` queries one journaled hash; `settleScope` settles a scope and returns what settled, which a caller must look at before building a new request.
- **Sponsorship:** `signForSponsor` signs every entry with the sponsor as simulated source. `Sponsor` admits, enforces and submits one operation at a time. `sponsoredInvoke` submits through a `SponsorEndpoint` (`httpSponsor` for the submitter), checks the returned transaction against the signed operation with `verifiedSponsorRecord`, and reads the outcome from the network. A sponsor that does not answer is `SponsorOutcomeUnknown`.
- **History:** `readAuditHistory` reads `audit_v1` events within RPC retention and `verifyAuditChain` recomputes the chain against the stored head. It is a live view, not durable history.
- **Amounts:** `toContractUnits` and `fromContractUnits` convert decimal strings exactly; there is no floating-point path.

[P5 validation](../../docs/P5_VALIDATION.md) lists what is tested and what is still open.

P9 adds the wallet's account payment path, for services that pull their payment.

- **Paying:** `accountPaymentInvocation(context, payment, agent)` builds the plain `asset.transfer(wallet, recipient, amount)` and signs the wallet's one entry as the policy's agent key. Pass it to `signForSponsor`; the wallet is never the transaction source. `accountPaymentOperation` and `signAccountPayment` are the two halves.
- **The agent key:** it signs the host payload followed by the policy hash, through `Signer.signMessage`, which only headless keys offer. The signer account's own signers and thresholds are not applied on this path.
- **Before signing:** `readPaymentCheck(wallet, { policy_hash, asset, recipient, amount })` returns the state the payment would leave or throws `WalletError` with the wallet's code. A refusal on the account path itself is only a host authorization failure.
- **History:** an account payment is the `AccountPayment` audit outcome.

[ADR 0007](../../docs/decisions/0007-account-payment-path.md) has the rules and what differs from `execute`.
