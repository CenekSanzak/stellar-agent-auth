import { accountPathScenario } from '../integration/support/account-path-scenario.js';
import { testnetNetwork } from '../integration/support/local-network.js';

/**
 * The smart wallet's account path on public Testnet (ADR 0007, A30). Unlike the read-only preflight beside it, this
 * deploys the registries, an asset, the wallet and the demo service from runtime-generated, Friendbot-funded keys
 * and submits transactions, so it runs only with `RUN_TESTNET_WALLET=1` in addition to `RUN_TESTNET_TESTS=1`. It
 * needs `npm run build:contracts` first. Everything it deploys is throwaway.
 */
accountPathScenario('testnet', testnetNetwork, 600_000, process.env['RUN_TESTNET_WALLET'] === '1');
