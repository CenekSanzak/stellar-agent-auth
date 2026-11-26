import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StrKey } from '@stellar/stellar-sdk';

/**
 * What the demo runs against: one deployment of the registries, a registered and assessed agent, a test asset and
 * the accounts that play each role. Everything here is public. Keys are kept apart, in `key_directory`, and are
 * referenced by role name.
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
  /** A service that pulls its price from the paying wallet in its own call. */
  service: { contract: string; service_id: string; price: string };
  /** `facilitator` pays the fees of x402 payments; like the sponsor it authorizes nothing. */
  roles: { recipient: string; stranger: string; funder: string; sponsor: string; facilitator: string };
  key_directory: string;
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
    && contract(record.service?.contract) && HEX32.test(record.service?.service_id)
    && typeof record.service?.price === 'string'
    && account(record.roles?.recipient) && account(record.roles?.stranger) && account(record.roles?.funder)
    && account(record.roles?.sponsor) && account(record.roles?.facilitator) && typeof record.key_directory === 'string';
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
