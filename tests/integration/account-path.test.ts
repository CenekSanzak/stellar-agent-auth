import { accountPathScenario } from './support/account-path-scenario.js';
import { localNetwork } from './support/local-network.js';

accountPathScenario('local', localNetwork, 240_000);
