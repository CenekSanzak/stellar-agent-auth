#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Address, Asset, Operation, TransactionBuilder, hash, nativeToScVal, rpc, xdr,
} from '@stellar/stellar-sdk';
import {
  MemoryJournal, buildResult, contractDeployment, decodeIdentity, encodeVerificationConstructorArgs, invoke,
  keypairSigner, loadConfig, loadSource, networkContext, pipelineLimits, registryInvocation, registryOperation,
  submit, toContractUnits, uploadInvocation, verificationInvocation, verificationOperation,
  type CheckResult, type Invocation, type Signer,
} from '@stellar-agent-auth/sdk';
import { createNamedKey, isMainModule, loadKeypair } from '@stellar-agent-auth/sdk/node';
import { bytesToHex, saveDeployment, type Deployment } from './deployment.js';

/**
 * Creates everything the demo needs except the owner's wallet, which the owner creates in the browser with their
 * own signature: both registries, an approved provider, a registered agent with a published result, a test asset,
 * a service that pulls its price, and the installed wallet code.
 *
 * Every role gets its own key, generated here into an owner-only directory and funded by Friendbot. The result is
 * written as a deployment record of public addresses.
 *
 * On a local network the provider is a `Fixture` provider and its result is SIMULATED test data, labelled as such
 * wherever it is shown. A real assessment needs a public metadata URL and the verifier, which is how the Testnet
 * deployment is made.
 */

/** The built contracts: `target/wasm32v1-none/release` in the nearest directory above this file that has one. */
function wasmDirectory() {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, 'target/wasm32v1-none/release');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Contracts are not built; run npm run build:contracts');
    directory = parent;
  }
}
const ROLES = ['admin', 'provider', 'controller', 'agent', 'funder', 'issuer', 'sponsor', 'recipient', 'stranger'] as const;
type Role = (typeof ROLES)[number];

export const FIXTURE_LABEL = 'SIMULATED fixture - not a real assessment';

/**
 * Ask Friendbot to fund `address`, trying again when it fails: a busy Friendbot answers 500. Asking again is safe,
 * since for an account that already exists it does nothing.
 */
export async function airdrop(server: rpc.Server, address: string, attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      await server.requestAirdrop(address);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}
const DAY = 86_400n;

/** What the project's limited verifier covers, all implemented checks passing. */
const FIXTURE_CHECKS: CheckResult[] = [
  { kind: 'Code', outcome: 'Unsupported', score: null },
  { kind: 'Endpoint', outcome: 'Passed', score: 0 },
  { kind: 'Media', outcome: 'Unsupported', score: null },
  { kind: 'Metadata', outcome: 'Passed', score: 0 },
  { kind: 'SignerAccount', outcome: 'Passed', score: 0 },
  { kind: 'SignerHistory', outcome: 'Inconclusive', score: null },
  { kind: 'ThreatFeed', outcome: 'Unsupported', score: null },
  { kind: 'Token', outcome: 'Unsupported', score: null },
];

export interface SetupOptions {
  env: Record<string, string | undefined>;
  /** Where the run's keys and record go; a new directory per run. */
  directory: string;
  /** Where the deployment record is written. */
  record: string;
  assetCode?: string;
  /** Whole units of the test asset issued to the funder. */
  issue?: string;
  servicePrice?: string;
  log?: (line: string) => void;
}

export async function setupDeployment(options: SetupOptions): Promise<Deployment> {
  const log = options.log ?? console.log;
  const config = loadConfig(options.env);
  if (config.network !== 'local') {
    throw new Error('This setup publishes a fixture result and runs on the local network only');
  }
  const keyDirectory = join(options.directory, 'keys');
  const keyEnv = { ...options.env, STELLAR_AGENT_AUTH_KEY_DIR: keyDirectory };
  const server = new rpc.Server(config.rpcUrl, { allowHttp: true, timeout: 30_000 });
  const context = await networkContext(server, config.passphrase);
  const journal = new MemoryJournal();
  const limits = pipelineLimits({ maxFee: 100_000_000n });
  const startLedger = (await server.getLatestLedger()).sequence;

  log(`Generating one key per role in ${keyDirectory}`);
  const keys = {} as Record<Role, Signer>;
  for (const role of ROLES) {
    await createNamedKey(role, keyEnv);
    keys[role] = keypairSigner(await loadKeypair(role, keyEnv));
    await airdrop(server, keys[role].address);
  }

  const run = async (source: Signer, invocation: Invocation, label: string) => {
    const outcome = await invoke(context, source, invocation, journal, { limits });
    if (outcome.status !== 'success') throw new Error(`${label}: ${outcome.status}${outcome.code ? ` (${outcome.code})` : ''}`);
    return outcome;
  };
  const wasmRoot = wasmDirectory();
  const wasmOf = (name: string) => readFile(join(wasmRoot, `stellar_agent_auth_${name}.wasm`)).catch(() => {
    throw new Error(`Contract ${name} is not built; run npm run build:contracts`);
  });
  async function install(wasm: Uint8Array, label: string) {
    const code = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: hash(Buffer.from(wasm)) }));
    const installed = async () => (await server.getLedgerEntries(code)).entries.length > 0;
    if (await installed()) return;
    // Another deployer installing the same code at the same moment can fail this upload; that is harmless exactly
    // when the code is then installed.
    const upload = await invoke(context, keys.admin, uploadInvocation(wasm), journal, { limits });
    if (upload.status !== 'success' && !(await installed())) throw new Error(`Install ${label}: ${upload.status}`);
  }
  async function deploy(name: string, args: xdr.ScVal[]) {
    const wasm = await wasmOf(name);
    await install(wasm, name);
    const salt = hash(Buffer.from(`${name}:${Date.now()}:${Math.random()}`));
    const created = await run(keys.admin,
      contractDeployment(context.networkPassphrase, keys.admin.address, hash(wasm), salt, args), `Deploy ${name}`);
    return Address.fromScVal(created.returnValue!).toString();
  }

  log('Deploying the agent registry and the verification registry');
  const agentRegistry = await deploy('agent_registry', []);
  const verificationRegistry = await deploy('verification_registry',
    encodeVerificationConstructorArgs(keys.admin.address, agentRegistry));

  log('Approving the fixture provider');
  const approval = { provider: keys.provider.address, mode: 'Fixture' as const };
  await run(keys.admin, verificationInvocation(context, verificationRegistry, 'approve_provider', approval, keys.admin,
    verificationOperation(verificationRegistry, 'approve_provider', approval)), 'Approve provider');

  log('Registering the agent: the controller and the agent key both sign');
  const metadataUri = 'https://agent.example.test/demo-agent.json';
  const registration = {
    controller: keys.controller.address, signer: keys.agent.address, metadata_uri: metadataUri,
    metadata_hash: Uint8Array.from(hash(Buffer.from(`${FIXTURE_LABEL}: demo agent metadata`))),
  };
  const registered = await run(keys.controller, registryInvocation(context, agentRegistry, 'register', registration,
    [keys.controller, keys.agent], registryOperation(agentRegistry, 'register', registration)), 'Register agent');
  const identity = decodeIdentity(registered.returnValue!);

  log('Publishing a SIMULATED fixture result for the agent');
  const now = BigInt((await server.getLatestLedger()).closeTime);
  const result = buildResult({
    agent_id: identity.agent_id, revision: identity.revision, provider: keys.provider.address, sequence: 1n,
    mode: 'Fixture', checks: FIXTURE_CHECKS, serious_wallet_risks: 0,
    evidence_hash: Uint8Array.from(hash(Buffer.from(`${FIXTURE_LABEL}: passing`))),
    issued_at: now, expires_at: now + 30n * DAY,
  });
  await run(keys.provider, verificationInvocation(context, verificationRegistry, 'publish', { result }, keys.provider,
    verificationOperation(verificationRegistry, 'publish', { result })), 'Publish result');

  log('Issuing the test asset and deploying its asset contract');
  const assetCode = options.assetCode ?? 'DEMO';
  const asset = new Asset(assetCode, keys.issuer.address);
  async function classic(source: Role, operations: xdr.Operation[]) {
    const builder = new TransactionBuilder(await loadSource(context, keys[source].address), {
      fee: '100', networkPassphrase: context.networkPassphrase,
    });
    operations.forEach((operation) => builder.addOperation(operation));
    const tx = builder.setTimeout(60).build();
    tx.sign(await loadKeypair(source, keyEnv));
    const outcome = await submit(context, tx, journal, `source:${keys[source].address}`, limits);
    if (outcome.status !== 'success') throw new Error(`Classic transaction by ${source}: ${outcome.status}`);
  }
  // The stranger holds the asset too, so a payment to it is refused by the policy and by nothing else.
  for (const holder of ['funder', 'recipient', 'stranger'] as const) await classic(holder, [Operation.changeTrust({ asset })]);
  await classic('issuer', [Operation.payment({
    destination: keys.funder.address, asset, amount: options.issue ?? '100000',
  })]);
  await run(keys.admin, { operation: Operation.createStellarAssetContract({ asset }) }, 'Deploy asset contract');
  const assetId = asset.contractId(context.networkPassphrase);

  log('Deploying the demo service and installing the wallet code');
  const price = options.servicePrice ?? '1';
  const serviceId = hash(Buffer.from('stellar-agent-auth demo service'));
  const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  const service = await deploy('demo_service', [xdr.ScVal.scvMap([
    entry('asset', Address.fromString(assetId).toScVal()),
    entry('payee', Address.fromString(keys.recipient.address).toScVal()),
    entry('price', nativeToScVal(toContractUnits(price, 7), { type: 'i128' })),
    entry('service_id', xdr.ScVal.scvBytes(serviceId)),
  ])]);
  const walletWasm = await wasmOf('smart_wallet');
  await install(walletWasm, 'smart_wallet');

  const epoch = `demo-${startLedger}`;
  const deployment: Deployment = {
    network: config.network, rpc_url: config.rpcUrl, passphrase: config.passphrase, epoch, start_ledger: startLedger,
    agent_registry: agentRegistry, verification_registry: verificationRegistry,
    asset: { contract: assetId, code: assetCode, issuer: keys.issuer.address, decimals: 7 },
    wallet_wasm_hash: bytesToHex(hash(walletWasm)),
    wallet_salt: bytesToHex(hash(Buffer.from(`stellar-agent-auth demo wallet:${epoch}`))),
    agent: {
      agent_id: identity.agent_id.toString(), revision: identity.revision.toString(), signer: identity.signer,
      controller: identity.controller, metadata_uri: metadataUri,
    },
    provider: { address: keys.provider.address, mode: 'Fixture' },
    service: { contract: service, service_id: bytesToHex(serviceId), price },
    roles: {
      recipient: keys.recipient.address, stranger: keys.stranger.address, funder: keys.funder.address,
      sponsor: keys.sponsor.address,
    },
    key_directory: keyDirectory, created_at: new Date().toISOString(),
  };
  await saveDeployment(options.record, deployment);
  log(`Deployment record written to ${options.record}`);
  return deployment;
}

/** `.local/demo` under the working directory, or `DEMO_DIRECTORY`. */
export const demoDirectory = (env: Record<string, string | undefined>) => resolve(env['DEMO_DIRECTORY'] ?? '.local/demo');
export const recordPath = (env: Record<string, string | undefined>) => join(demoDirectory(env), 'deployment.json');

if (isMainModule(import.meta.url)) {
  const run = new Date().toISOString().replace(/[:.]/g, '-');
  setupDeployment({
    env: process.env, directory: join(demoDirectory(process.env), run), record: recordPath(process.env),
  }).then((deployment) => {
    console.log(`Ready: agent ${deployment.agent.agent_id}, asset ${deployment.asset.code}. Start the demo with npm run demo.`);
  }, (error: unknown) => {
    console.error(`demo setup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
