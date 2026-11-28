/**
 * The kept Testnet deployment's public addresses, read from `demo.json` beside this file.
 *
 * `demo.json` is the record the deployment's setup wrote; this is the same record with its type, for scripts and
 * for anyone who wants the addresses in code. Whether the network still holds what it names is checked by
 * `deploy.ts`, which writes `manifest.json`.
 */
import { readFileSync } from 'node:fs';

export interface TestnetDeployment {
  network: 'testnet';
  rpc_url: string;
  passphrase: string;
  /** Names this deployment's history in the indexer. */
  epoch: string;
  /** A ledger before anything was deployed. */
  start_ledger: number;
  agent_registry: string;
  verification_registry: string;
  /** The test asset. It has no value. */
  asset: { contract: string; code: string; issuer: string; decimals: number };
  /** The installed smart wallet code, and the salt every owner's wallet is created with. */
  wallet_wasm_hash: string;
  wallet_salt: string;
  /** The sample agent. Agents people bring themselves are registered in the same registry, under later numbers. */
  agent: { agent_id: string; revision: string; signer: string; controller: string; metadata_uri: string };
  provider: { address: string; mode: 'Live' | 'Fixture' };
  /** The account each sample seller is paid at. */
  vendors: Record<string, string>;
  /** `funder` hands out the test asset; `facilitator` pays the fees of x402 payments and authorizes nothing. */
  roles: { funder: string; facilitator: string };
  created_at: string;
}

export const TESTNET = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url), 'utf8')) as TestnetDeployment;
