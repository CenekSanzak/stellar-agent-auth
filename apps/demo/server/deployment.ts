import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StrKey } from '@stellar/stellar-sdk';
import { VENDOR_IDS, type VendorId } from './catalogue.js';

/**
 * What the demo runs against: one deployment of the registries, a registered and assessed agent, a test asset, and
 * the accounts the sellers are paid at. Everything here is public, and a record for a public network can be kept
 * in the repository. Keys are kept apart and are named by reference when the server starts.
 *
 * There is no wallet in it: every owner creates their own, from the installed wallet code and the shared salt.
 */
export interface Deployment {
  network: 'local' | 'testnet';
  rpc_url: string;
  passphrase: string;
  /** Names this deployment's history in the indexer. */
  epoch: string;
  /** A ledger before anything was deployed; the indexer starts here. */
  start_ledger: number;
  agent_registry: string;
  verification_registry: string;
  asset: { contract: string; code: string; issuer: string; decimals: number };
  /** The installed smart wallet code, and the salt every owner's wallet is created with. */
  wallet_wasm_hash: string;
  wallet_salt: string;
  agent: { agent_id: string; revision: string; signer: string; controller: string; metadata_uri: string };
  provider: { address: string; mode: 'Live' | 'Fixture' };
  /** The account each seller is paid at. Each holds a trustline to the asset and nothing else of interest. */
  vendors: Record<VendorId, string>;
  /** `funder` hands out the test asset; `facilitator` pays the fees of x402 payments and authorizes nothing. */
  roles: { funder: string; facilitator: string };
  /** Where the setup wrote the role keys, when they are on this machine. A hosted server names its keys itself. */
  key_directory?: string;
  created_at: string;
}

const HEX32 = /^[0-9a-f]{64}$/;

/** Throws unless `value` has the shape and address formats of a deployment record. */
export function assertDeployment(value: unknown): asserts value is Deployment {
  const record = value as Deployment;
  const contract = (id: unknown) => typeof id === 'string' && StrKey.isValidContract(id);
  const account = (id: unknown) => typeof id === 'string' && StrKey.isValidEd25519PublicKey(id);
  const ok = typeof record === 'object' && record !== null
    && (record.network === 'local' || record.network === 'testnet')
    && typeof record.rpc_url === 'string' && typeof record.passphrase === 'string' && typeof record.epoch === 'string'
    && Number.isSafeInteger(record.start_ledger) && record.start_ledger > 0
    && contract(record.agent_registry) && contract(record.verification_registry)
    && contract(record.asset?.contract) && account(record.asset?.issuer) && typeof record.asset?.code === 'string'
    && Number.isInteger(record.asset?.decimals)
    && HEX32.test(record.wallet_wasm_hash) && HEX32.test(record.wallet_salt)
    && /^\d+$/.test(record.agent?.agent_id) && /^\d+$/.test(record.agent?.revision)
    && account(record.agent?.signer) && account(record.agent?.controller)
    && account(record.provider?.address) && (record.provider?.mode === 'Live' || record.provider?.mode === 'Fixture')
    && typeof record.vendors === 'object' && record.vendors !== null
    && VENDOR_IDS.every((id) => account(record.vendors[id]))
    && new Set(VENDOR_IDS.map((id) => record.vendors[id])).size === VENDOR_IDS.length
    && account(record.roles?.funder) && account(record.roles?.facilitator)
    && (record.key_directory === undefined || typeof record.key_directory === 'string');
  if (!ok) throw new Error('The deployment record is incomplete or malformed; run the demo setup again');
}

export async function loadDeployment(path: string): Promise<Deployment> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`No deployment record at ${path}; run the demo setup first`);
  }
  const value: unknown = JSON.parse(text);
  assertDeployment(value);
  return value;
}

export async function saveDeployment(path: string, deployment: Deployment) {
  assertDeployment(deployment);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(deployment, null, 2)}\n`);
}

export const hexToBytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
export const bytesToHex = (value: Uint8Array) => Buffer.from(value).toString('hex');
