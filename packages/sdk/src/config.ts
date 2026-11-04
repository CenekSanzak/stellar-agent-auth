import { hash, Networks, StrKey } from '@stellar/stellar-sdk';

export type Environment = Record<string, string | undefined>;

const CONTRACT_KEYS = [
  'AGENT_REGISTRY_ID',
  'VERIFICATION_REGISTRY_ID',
  'WALLET_ID',
  'TEST_ASSET_CONTRACT_ID',
] as const;

/** Read non-secret connection settings without loading or mutating process.env. */
export function loadConfig(env: Environment) {
  const network = env['STELLAR_NETWORK'] ?? 'local';
  if (network !== 'local' && network !== 'testnet') {
    throw new Error('STELLAR_NETWORK must be local or testnet');
  }
  const passphrase = network === 'local' ? Networks.STANDALONE : Networks.TESTNET;
  const suppliedPassphrase = env['STELLAR_NETWORK_PASSPHRASE'];
  if (suppliedPassphrase && suppliedPassphrase !== passphrase) {
    throw new Error('Network passphrase mismatch');
  }

  const defaultRpc = network === 'local'
    ? 'http://localhost:8000/rpc'
    : 'https://soroban-testnet.stellar.org';
  const rpcUrl = new URL(env['STELLAR_RPC_URL'] ?? defaultRpc);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(rpcUrl.hostname);
  if (rpcUrl.username || rpcUrl.password || rpcUrl.search || rpcUrl.hash) {
    throw new Error('RPC URL must not contain credentials, query or fragment');
  }
  const localHttp = network === 'local' && loopback && rpcUrl.protocol === 'http:';
  if (rpcUrl.protocol !== 'https:' && !localHttp) {
    throw new Error('RPC requires HTTPS except local loopback');
  }

  const networkId = Buffer.from(hash(Buffer.from(passphrase))).toString('hex');
  if (env['STELLAR_NETWORK_ID'] && env['STELLAR_NETWORK_ID'] !== networkId) {
    throw new Error('Network ID mismatch');
  }
  const contracts: Partial<Record<typeof CONTRACT_KEYS[number], string>> = {};
  for (const key of CONTRACT_KEYS) {
    const value = env[key];
    if (value) {
      if (!StrKey.isValidContract(value)) throw new Error(`Invalid contract address: ${key}`);
      contracts[key] = value;
    }
  }
  const provider = env['VERIFIER_PUBLIC_ADDRESS'];
  if (provider && !StrKey.isValidEd25519PublicKey(provider)) {
    throw new Error('Invalid verifier public address');
  }

  return {
    network,
    passphrase,
    networkId,
    rpcUrl: rpcUrl.toString(),
    contracts,
    provider,
    databasePath: env['INDEXER_DATABASE_PATH'] ?? '.local/history.sqlite',
    deploymentEpoch: env['DEPLOYMENT_EPOCH'] ?? `${network}-p0`,
  };
}
