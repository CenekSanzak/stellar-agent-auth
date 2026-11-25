import { accountProbeScenario } from './support/account-probe-scenario.js';
import { localNetwork } from './support/local-network.js';

accountProbeScenario('local', localNetwork, 240_000);
