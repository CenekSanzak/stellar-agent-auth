# SDK

P0 exports `loadConfig(environment)` for validated non-secret local/Testnet connection settings. Run `npm run build` at the repository root before importing the workspace package.

```ts
import { loadConfig } from '@stellar-agent-auth/sdk';
const config = loadConfig({ STELLAR_NETWORK: 'local' });
```

Configuration does not sign, deploy or submit transactions, and does not implicitly load .env. Registration, verification, policies and signed-action APIs remain planned. See docs/DEVELOPMENT.md from the repository root for configuration and test commands.


P1 exports v1 ABI types, canonical XDR encoders, `policyHash`, `actionHash`, `auditHash` and `signActionAuthorization`. Use `bigint` for amounts, sequences and Unix timestamps. The authorization helper checks the entire expected `execute(request)` call before passing its payload to an agent signer. [ABI and signing flow](../../docs/decisions/0002-v1-abi-and-authorization.md)

P2 adds agent registry helpers. `registryOperation(contractId, method, args)` builds any registry call after the stateless checks the contract also enforces: `validateAgentMetadata` (non-empty `https://` URI of visible ASCII, at most 2,048 UTF-8 bytes, non-zero 32-byte hash), distinct controller and signer, and standard-account signers. `encodeRegistryArgs` returns the raw argument XDR. `signRegistryAuthorization` signs a controller, signer or new-signer entry only after matching the account credential, registry address, mutating method, exact arguments, absence of child invocations and an expiry at most 20 ledgers ahead. `readAgent`, `readCurrent` and `readAgentCount` simulate the read entry points and decode results with the strict `decodeIdentity`. Contract failures throw `AgentRegistryError` with the v1 error name, and `contractErrorName` maps `Error(Contract, #N)` text. Every mutation increments the revision, so pass the revision you last read as `expected_revision`. Transaction submission remains P5.
