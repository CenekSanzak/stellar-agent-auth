#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  Address, Asset, Operation, TransactionBuilder, hash, rpc, xdr,
} from '@stellar/stellar-sdk';
import {
  MemoryJournal, buildResult, contractDeployment, decodeIdentity, encodeVerificationConstructorArgs, invoke,
  keypairSigner, loadConfig, loadSource, networkContext, pipelineLimits, registryInvocation, registryOperation,
  submit, uploadInvocation, verificationInvocation, verificationOperation,
  type CheckResult, type Invocation, type Signer,
} from '@stellar-agent-auth/sdk';
import { createNamedKey, isMainModule, loadKeypair } from '@stellar-agent-auth/sdk/node';
import { ReportStore, assess, safeFetch } from '@stellar-agent-auth/verifier';
import { VENDOR_IDS, type VendorId } from './catalogue.js';
import { bytesToHex, loadDeployment, saveDeployment, type Deployment } from './deployment.js';

/**
 * Creates everything the demo needs except the owners' wallets, which each owner creates in the browser with their
 * own signature: both registries, an approved provider, a registered agent with a published result, a test asset,
 * an account for each seller, and the installed wallet code.
 *
 * Every role gets its own key, generated here into an owner-only directory and funded by Friendbot. The result is
 * written as a deployment record of public addresses.
 *
 * On a local network the provider is a `Fixture` provider and its result is SIMULATED test data, labelled as such
 * wherever it is shown. On Testnet the provider is `Live`: the agent's metadata must be at a public address, and
 * the project's verifier fetches it, runs its checks and publishes what it found.
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
const vendorRole = (id: VendorId) => `vendor-${id}` as const;
const ROLES = [
  'admin', 'provider', 'controller', 'agent', 'funder', 'issuer', 'facilitator', ...VENDOR_IDS.map(vendorRole),
] as const;
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
export const FIXTURE_CHECKS: CheckResult[] = [
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
  /** On a public network: where the agent's metadata document is served. It is fetched and assessed for real. */
  metadataUri?: string;
  /** How long the published result lasts. A result is time-limited; `renewAssessment` publishes a new one. */
  validityDays?: number;
  /** Also write the record without the key directory, for keeping in the repository. */
  publicRecord?: string;
  log?: (line: string) => void;
}

/** The verifier's working files for a deployment: its reports, and what it needs to resume a publication. */
export const verifierContext = (deployment: Pick<Deployment, 'passphrase' | 'agent_registry' | 'verification_registry' | 'provider'>,
  server: rpc.Server, directory: string) => ({
  server, networkPassphrase: deployment.passphrase, agentRegistry: deployment.agent_registry,
  verificationRegistry: deployment.verification_registry, provider: deployment.provider.address,
  reports: new ReportStore(join(directory, 'reports')), stateDirectory: join(directory, 'pending'),
});

export async function setupDeployment(options: SetupOptions): Promise<Deployment> {
  const log = options.log ?? console.log;
  const config = loadConfig(options.env);
  if (config.network !== 'local' && config.network !== 'testnet') {
    throw new Error('The demo is set up on a local network or on Testnet only');
  }
  const live = config.network === 'testnet';
  if (live && !options.metadataUri) {
    throw new Error('On Testnet the agent is assessed for real: pass --metadata-uri with the public address of its metadata');
  }
  const validity = BigInt(options.validityDays ?? 30) * DAY;
  if (validity <= 0n) throw new Error('The result must be valid for at least a day');
  const keyDirectory = join(options.directory, 'keys');
  const keyEnv = { ...options.env, STELLAR_AGENT_AUTH_KEY_DIR: keyDirectory };
  const server = new rpc.Server(config.rpcUrl, { allowHttp: !live, timeout: 30_000 });
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

  log(`Approving the ${live ? 'live' : 'fixture'} provider`);
  const approval = { provider: keys.provider.address, mode: live ? 'Live' as const : 'Fixture' as const };
  await run(keys.admin, verificationInvocation(context, verificationRegistry, 'approve_provider', approval, keys.admin,
    verificationOperation(verificationRegistry, 'approve_provider', approval)), 'Approve provider');

  log('Registering the agent: the controller and the agent key both sign');
  const metadataUri = options.metadataUri ?? 'https://agent.example.test/scout.json';
  let metadata = Buffer.from(`${FIXTURE_LABEL}: demo agent metadata`);
  if (live) {
    // The same guarded fetch the verifier uses; the registered hash is of the exact bytes served now.
    const response = await safeFetch(metadataUri);
    if (response.status !== 200) throw new Error(`The metadata address answered HTTP ${response.status}`);
    metadata = Buffer.from(response.body);
  }
  const registration = {
    controller: keys.controller.address, signer: keys.agent.address, metadata_uri: metadataUri,
    metadata_hash: Uint8Array.from(hash(metadata)),
  };
  const registered = await run(keys.controller, registryInvocation(context, agentRegistry, 'register', registration,
    [keys.controller, keys.agent], registryOperation(agentRegistry, 'register', registration)), 'Register agent');
  const identity = decodeIdentity(registered.returnValue!);

  if (live) {
    log('Assessing the agent with the verifier and publishing what it found');
    const outcome = await assess(verifierContext({
      passphrase: config.passphrase, agent_registry: agentRegistry, verification_registry: verificationRegistry,
      provider: { address: keys.provider.address, mode: 'Live' },
    }, server, join(options.directory, 'verifier')), {
      agentId: identity.agent_id, publisher: await loadKeypair('provider', keyEnv), validitySeconds: validity,
    });
    const failed = outcome.assessment.result.checks.filter((check) => check.outcome === 'Failed').map((check) => check.kind);
    if (failed.length) throw new Error(`The agent failed its assessment (${failed.join(', ')}); see ${outcome.reportPath}`);
    log(`Assessment report: ${outcome.reportPath}`);
  } else {
    log('Publishing a SIMULATED fixture result for the agent');
    const now = BigInt((await server.getLatestLedger()).closeTime);
    const result = buildResult({
      agent_id: identity.agent_id, revision: identity.revision, provider: keys.provider.address, sequence: 1n,
      mode: 'Fixture', checks: FIXTURE_CHECKS, serious_wallet_risks: 0,
      evidence_hash: Uint8Array.from(hash(Buffer.from(`${FIXTURE_LABEL}: passing`))),
      issued_at: now, expires_at: now + validity,
    });
    await run(keys.provider, verificationInvocation(context, verificationRegistry, 'publish', { result }, keys.provider,
      verificationOperation(verificationRegistry, 'publish', { result })), 'Publish result');
  }

  log('Issuing the test asset and deploying its asset contract');
  const assetCode = options.assetCode ?? 'tUSD';
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
  // Every seller can hold the asset, approved by an owner or not: a payment to one that is not approved is then
  // refused by the wallet's policy and by nothing else.
  for (const holder of ['funder', ...VENDOR_IDS.map(vendorRole)] as const) await classic(holder, [Operation.changeTrust({ asset })]);
  await classic('issuer', [Operation.payment({
    destination: keys.funder.address, asset, amount: options.issue ?? '10000000',
  })]);
  await run(keys.admin, { operation: Operation.createStellarAssetContract({ asset }) }, 'Deploy asset contract');
  const assetId = asset.contractId(context.networkPassphrase);

  log('Installing the wallet code');
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
    provider: { address: keys.provider.address, mode: live ? 'Live' : 'Fixture' },
    vendors: Object.fromEntries(VENDOR_IDS.map((id) => [id, keys[vendorRole(id)].address])) as Record<VendorId, string>,
    roles: { funder: keys.funder.address, facilitator: keys.facilitator.address },
    key_directory: keyDirectory, created_at: new Date().toISOString(),
  };
  await saveDeployment(options.record, deployment);
  log(`Deployment record written to ${options.record}`);
  if (options.publicRecord) {
    const { key_directory: _local, ...shared } = deployment;
    await saveDeployment(options.publicRecord, shared);
    log(`Public record, without the key directory, written to ${options.publicRecord}`);
  }
  return deployment;
}

/**
 * Assess the deployment's agent again and publish the new result. A result is valid for a limited time; this is
 * how a live deployment is kept current. It needs the provider's key, which stays where the setup wrote it.
 */
export async function renewAssessment(
  deployment: Deployment, options: { validityDays?: number; log?: (line: string) => void } = {},
) {
  if (deployment.provider.mode !== 'Live') throw new Error('Only a live provider assesses; set a local deployment up again instead');
  if (!deployment.key_directory) throw new Error('This record names no key directory; use the record the setup wrote on this machine');
  const server = new rpc.Server(deployment.rpc_url, { timeout: 30_000 });
  const publisher = await loadKeypair('provider', { STELLAR_AGENT_AUTH_KEY_DIR: deployment.key_directory });
  const outcome = await assess(verifierContext(deployment, server, join(dirname(deployment.key_directory), 'verifier')), {
    agentId: BigInt(deployment.agent.agent_id), publisher, validitySeconds: BigInt(options.validityDays ?? 30) * DAY,
  });
  (options.log ?? console.log)(`Published result ${outcome.assessment.result.sequence}; report at ${outcome.reportPath}`);
  return outcome;
}

/** `.local/demo` under the working directory, or `DEMO_DIRECTORY`. */
export const demoDirectory = (env: Record<string, string | undefined>) => resolve(env['DEMO_DIRECTORY'] ?? '.local/demo');
export const recordPath = (env: Record<string, string | undefined>) => join(demoDirectory(env), 'deployment.json');

if (isMainModule(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'metadata-uri': { type: 'string' }, 'validity-days': { type: 'string' }, 'public-record': { type: 'string' },
      'asset-code': { type: 'string' },
    },
  });
  const days = values['validity-days'] === undefined ? undefined : Number(values['validity-days']);
  const validityDays = days !== undefined && Number.isInteger(days) && days > 0 ? { validityDays: days } : {};
  const work = async () => {
    if (days !== undefined && !('validityDays' in validityDays)) throw new Error('--validity-days must be a whole number of days');
    if (positionals[0] === 'assess') {
      await renewAssessment(await loadDeployment(process.env['DEMO_DEPLOYMENT'] ?? recordPath(process.env)), validityDays);
      return;
    }
    if (positionals.length) throw new Error('Usage: setup [assess] [--metadata-uri <https URL>] [--validity-days <n>] [--public-record <path>]');
    const run = new Date().toISOString().replace(/[:.]/g, '-');
    const deployment = await setupDeployment({
      env: process.env, directory: join(demoDirectory(process.env), run), record: recordPath(process.env), ...validityDays,
      ...(values['metadata-uri'] ? { metadataUri: values['metadata-uri'] } : {}),
      ...(values['public-record'] ? { publicRecord: resolve(values['public-record']) } : {}),
      ...(values['asset-code'] ? { assetCode: values['asset-code'] } : {}),
    });
    console.log(`Ready: agent ${deployment.agent.agent_id}, asset ${deployment.asset.code}. Start the demo with npm run demo.`);
  };
  work().catch((error: unknown) => {
    console.error(`demo setup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
