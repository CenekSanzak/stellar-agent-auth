# SDK

P0 exports `loadConfig(environment)` for validated non-secret local/Testnet connection settings. Run `npm run build` at the repository root before importing the workspace package.

```ts
import { loadConfig } from '@stellar-agent-auth/sdk';
const config = loadConfig({ STELLAR_NETWORK: 'local' });
```

Configuration does not sign, deploy or submit transactions, and does not implicitly load .env. Registration, verification, policies and signed-action APIs remain planned. See docs/DEVELOPMENT.md from the repository root for configuration and test commands.


P1 exports v1 ABI types, canonical XDR encoders, `policyHash`, `actionHash`, `auditHash` and `signActionAuthorization`. Use `bigint` for amounts, sequences and Unix timestamps. The authorization helper checks the entire expected `execute(request)` call before passing its payload to an agent signer. [ABI and signing flow](../../docs/decisions/0002-v1-abi-and-authorization.md)
