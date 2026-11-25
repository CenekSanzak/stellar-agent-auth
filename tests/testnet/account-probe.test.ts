import { accountProbeScenario } from '../integration/support/account-probe-scenario.js';
import { testnetNetwork } from '../integration/support/local-network.js';

/**
 * The custom account spike on public Testnet (ADR 0006). Unlike the read-only preflight beside it, this deploys
 * throwaway contracts and submits transactions from runtime-generated, Friendbot-funded keys, so it runs only with
 * `RUN_TESTNET_SPIKE=1` in addition to `RUN_TESTNET_TESTS=1`. It needs `npm run build:contracts` first.
 */
accountProbeScenario('testnet', testnetNetwork, 600_000, process.env['RUN_TESTNET_SPIKE'] === '1');
