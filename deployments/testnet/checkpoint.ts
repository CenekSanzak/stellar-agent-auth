/**
 * P3 Testnet checkpoint: deploy both registries, approve the live provider, register an agent whose metadata is
 * publicly hosted, run a real limited assessment and record every ID and transaction. This is a development
 * checkpoint, not the final deployment.
 *
 *   npm run build
 *   node deployments/testnet/checkpoint.ts deploy
 *   node deployments/testnet/checkpoint.ts register --metadata-uri https://<public host>/agent.json
 *   node deployments/testnet/checkpoint.ts assess
 *
 * Keys are generated on first use into `.local/testnet/<role>.key` (owner-only, git-ignored) and funded by the
 * Testnet Friendbot. Only public addresses, IDs and transaction hashes are written to `p3-checkpoint.json`.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  Address, BASE_FEE, Keypair, Operation, TransactionBuilder, hash, rpc, type Transaction, type xdr,
} from '@stellar/stellar-sdk';
import {
  decodeIdentity, encodeRegistryArgs, encodeVerificationConstructorArgs, loadConfig, readProvider, registryOperation,
  signRegistryAuthorization, verificationOperation, MAX_AUTH_WINDOW_LEDGERS,
} from '@stellar-agent-auth/sdk';
import { ReportStore, assess, safeFetch } from '@stellar-agent-auth/verifier';

const RECORD = new URL('./p3-checkpoint.json', import.meta.url);
const KEYS = new URL('../../.local/testnet/', import.meta.url);
const WASM = new URL('../../target/wasm32v1-none/release/', import.meta.url);
const EXPLORER = 'https://stellar.expert/explorer/testnet';

interface Checkpoint {
  network: 'testnet';
  network_passphrase: string;
  protocol_version?: number;
  roles: Record<string, string>;
  wasm_sha256?: Record<string, string>;
  contracts?: { agent_registry: string; verification_registry: string };
  agent?: { agent_id: string; revision: string; metadata_uri: string; metadata_sha256: string };
  assessment?: {
    sequence: string; risk_score: number | null; evidence_hash: string; issued_at: string; expires_at: string;
    checks: { kind: string; outcome: string; score: number | null }[];
  };
  transactions: { step: string; hash: string; ledger: number; link: string }[];
}

const config = loadConfig({ ...process.env, STELLAR_NETWORK: 'testnet' });
const server = new rpc.Server(config.rpcUrl);

async function load(): Promise<Checkpoint> {
  try {
    return JSON.parse(await readFile(RECORD, 'utf8')) as Checkpoint;
  } catch {
    return { network: 'testnet', network_passphrase: config.passphrase, roles: {}, transactions: [] };
  }
}

const save = (record: Checkpoint) => writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);

/** An owner-only local key for `role`, generated and Friendbot-funded on first use. */
async function role(record: Checkpoint, name: string): Promise<Keypair> {
  const path = new URL(`${name}.key`, KEYS);
  try {
    return Keypair.fromSecret((await readFile(path, 'utf8')).trim());
  } catch {
    const key = Keypair.random();
    await mkdir(KEYS, { recursive: true });
    await writeFile(path, `${key.secret()}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    await server.requestAirdrop(key.publicKey());
    record.roles[name] = key.publicKey();
    return key;
  }
}

async function submit(record: Checkpoint, step: string, source: Keypair, operation: xdr.Operation) {
  const account = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: config.passphrase })
    .addOperation(operation).setTimeout(120).build();
  const prepared = await server.prepareTransaction(tx) as Transaction;
  prepared.sign(source);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`${step} rejected before inclusion`);
  const confirmed = await server.pollTransaction(sent.hash, { attempts: 60, sleepStrategy: () => 2_000 });
  if (confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${step} ${sent.hash}: ${confirmed.status}`);
  record.transactions.push({ step, hash: sent.hash, ledger: confirmed.ledger, link: `${EXPLORER}/tx/${sent.hash}` });
  await save(record);
  return confirmed;
}

async function deploy(record: Checkpoint) {
  if (record.contracts) throw new Error('Contracts already deployed; remove p3-checkpoint.json to start a new epoch');
  const network = await server.getNetwork();
  record.protocol_version = Number(network.protocolVersion);
  const admin = await role(record, 'admin');
  const provider = await role(record, 'provider');
  record.wasm_sha256 = {};
  const ids: string[] = [];
  for (const [name, args] of [
    ['agent_registry', () => []],
    ['verification_registry', () => encodeVerificationConstructorArgs(admin.publicKey(), ids[0]!)],
  ] as const) {
    const wasm = await readFile(new URL(`stellar_agent_auth_${name}.wasm`, WASM));
    record.wasm_sha256[name] = Buffer.from(hash(wasm)).toString('hex');
    await submit(record, `upload ${name}`, admin, Operation.uploadContractWasm({ wasm }));
    const created = await submit(record, `deploy ${name}`, admin, Operation.createCustomContract({
      address: Address.fromString(admin.publicKey()), wasmHash: hash(wasm), salt: randomBytes(32),
      constructorArgs: args(),
    }));
    ids.push(Address.fromScVal(created.returnValue!).toString());
  }
  record.contracts = { agent_registry: ids[0]!, verification_registry: ids[1]! };
  await save(record);
  await submit(record, 'approve live provider', admin, verificationOperation(ids[1]!, 'approve_provider', {
    provider: provider.publicKey(), mode: 'Live',
  }));
  const approval = await readProvider({
    server, contractId: ids[1]!, source: admin.publicKey(), networkPassphrase: config.passphrase,
  }, provider.publicKey());
  console.log(JSON.stringify({ contracts: record.contracts, provider: approval }, null, 2));
}

async function register(record: Checkpoint, metadataUri: string) {
  if (!record.contracts) throw new Error('Run deploy first');
  // The same SSRF-safe fetch the verifier uses; the registered hash is of the exact bytes served now.
  const response = await safeFetch(metadataUri);
  if (response.status !== 200) throw new Error(`Metadata URI answered HTTP ${response.status}`);
  const metadataHash = Uint8Array.from(hash(Buffer.from(response.body)));
  const controller = await role(record, 'controller');
  const signer = await role(record, 'agent_signer');
  const args = {
    controller: controller.publicKey(), signer: signer.publicKey(), metadata_uri: metadataUri,
    metadata_hash: metadataHash,
  };
  const contractId = record.contracts.agent_registry;
  const account = await server.getAccount(controller.publicKey());
  const draft = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: config.passphrase })
    .addOperation(registryOperation(contractId, 'register', args)).setTimeout(120).build();
  const recording = await server.simulateTransaction(draft);
  if (!rpc.Api.isSimulationSuccess(recording) || !recording.result) throw new Error('Registration simulation failed');
  // The controller authorizes as transaction source; the signer proves control with its own entry.
  const auth = await Promise.all(recording.result.auth.map((entry) => entry.credentials.type === 'sorobanCredentialsAddress'
    ? signRegistryAuthorization({
      entry, contractId, method: 'register', args, address: signer.publicKey(), networkPassphrase: config.passphrase,
      latestLedger: recording.latestLedger, expirationLedger: recording.latestLedger + MAX_AUTH_WINDOW_LEDGERS, signer,
    })
    : entry));
  const confirmed = await submit(record, 'register agent', controller, Operation.invokeContractFunction({
    contract: contractId, function: 'register', args: encodeRegistryArgs('register', args), auth,
  }));
  const identity = decodeIdentity(confirmed.returnValue!);
  record.agent = {
    agent_id: identity.agent_id.toString(), revision: identity.revision.toString(), metadata_uri: metadataUri,
    metadata_sha256: Buffer.from(metadataHash).toString('hex'),
  };
  await save(record);
  console.log(JSON.stringify(record.agent, null, 2));
}

async function runAssessment(record: Checkpoint) {
  if (!record.contracts || !record.agent) throw new Error('Run deploy and register first');
  const provider = await role(record, 'provider');
  const outcome = await assess({
    server, networkPassphrase: config.passphrase, agentRegistry: record.contracts.agent_registry,
    verificationRegistry: record.contracts.verification_registry, provider: provider.publicKey(),
    reports: new ReportStore(new URL('../../.local/testnet/reports', import.meta.url).pathname),
    stateDirectory: new URL('../../.local/testnet/pending', import.meta.url).pathname,
  }, { agentId: BigInt(record.agent.agent_id), publisher: provider });
  const { result } = outcome.assessment;
  const published = outcome.published!;
  record.transactions.push({
    step: 'publish assessment', hash: published.hash, ledger: published.ledger, link: `${EXPLORER}/tx/${published.hash}`,
  });
  record.assessment = {
    sequence: result.sequence.toString(), risk_score: result.risk_score,
    evidence_hash: Buffer.from(result.evidence_hash).toString('hex'), issued_at: result.issued_at.toString(),
    expires_at: result.expires_at.toString(), checks: result.checks.map(({ kind, outcome, score }) => ({ kind, outcome, score })),
  };
  await save(record);
  console.log(JSON.stringify({ report: outcome.reportPath, assessment: record.assessment }, null, 2));
}

const { positionals, values } = parseArgs({
  allowPositionals: true, options: { 'metadata-uri': { type: 'string' } },
});
const record = await load();
switch (positionals[0]) {
  case 'deploy': await deploy(record); break;
  case 'register': await register(record, values['metadata-uri'] ?? ''); break;
  case 'assess': await runAssessment(record); break;
  default: console.error('Usage: checkpoint.ts deploy | register --metadata-uri <https URL> | assess'); process.exitCode = 2;
}
