/**
 * The complete payment flow on a local network, driven through the `stellar-agent-auth` CLI with a separate key for
 * every role:
 *
 *   registration -> real verification -> wallet funding -> owner policy -> sponsored agent payment
 *   -> owner revocation -> a request signed before the revocation is rejected
 *
 * Run from the repository root after `npm run build`, `npm run build:contracts` and `npm run dev`:
 *
 *   npm run example:payment
 *   node examples/payment-flow.ts --config examples/payment-flow.local.json
 *
 * The setup step deploys the registries, approves a Live provider and issues a test asset with the SDK, because a
 * fresh local network has none; everything after it is a CLI command, printed as it runs. Keys are generated into
 * `.local/example/<run>/keys` (owner-only, git-ignored) and referenced by name. Verification is real: the verifier
 * fetches the public metadata over HTTPS, so the machine needs internet access.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Address, Asset, Operation, TransactionBuilder, hash, rpc, type xdr,
} from '@stellar/stellar-sdk';
import {
  MemoryJournal, encodeVerificationConstructorArgs, fromContractUnits, invoke, keypairSigner, loadSource,
  networkContext, pipelineLimits, readAssetBalance, submit, uploadInvocation, verificationInvocation, verificationOperation,
  type NetworkContext, type Signer,
} from '@stellar-agent-auth/sdk';
import { createNamedKey, loadKeypair } from '@stellar-agent-auth/sdk/node';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'packages/cli/dist/index.js');
const SUBMITTER = join(ROOT, 'services/submitter/dist/index.js');
const WASM = join(ROOT, 'target/wasm32v1-none/release');
const ROLES = ['admin', 'provider', 'controller', 'agent', 'owner', 'funder', 'sponsor', 'issuer', 'recipient'] as const;
type Role = (typeof ROLES)[number];

export interface FlowConfig {
  network: 'local';
  rpc_url: string;
  metadata_uri: string;
  asset_code: string;
  issue: string;
  fund: string;
  policy: {
    required_checks: string[];
    max_assessment_age_seconds: number;
    max_risk_score: number;
    per_transfer: string;
    per_day: string;
    valid_for_seconds: number;
  };
  payment: string;
  presigned_payment: string;
}

export interface CliResult {
  code: number;
  json: Record<string, unknown>;
  stderr: string;
}

type Log = (line: string) => void;

/** Run one CLI command with `--json`, echoing it with key names only. */
function cli(env: NodeJS.ProcessEnv, args: string[], log: Log): Promise<CliResult> {
  log(`$ stellar-agent-auth ${args.join(' ')}`);
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--json'], { env, cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolveRun({ code: code ?? 1, json: JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}'), stderr });
      } catch {
        reject(new Error(`CLI printed no JSON (exit ${code}): ${stderr}`));
      }
    });
  });
}

async function expectOk(result: Promise<CliResult>, label: string): Promise<Record<string, unknown>> {
  const { code, json, stderr } = await result;
  if (code !== 0) throw new Error(`${label} failed with exit ${code}: ${stderr.trim()}`);
  return json;
}

/** Start the submitter for `wallet` with the sponsor key; resolves with its URL. */
function startSubmitter(env: NodeJS.ProcessEnv, wallet: string, stateDirectory: string, log: Log) {
  log(`$ stellar-agent-auth-submitter   (SUBMITTER_CONTRACTS=${wallet}, SUBMITTER_METHODS=execute)`);
  const child = spawn(process.execPath, [SUBMITTER], {
    cwd: ROOT,
    env: {
      ...env, SUBMITTER_SPONSOR_KEY: 'sponsor', SUBMITTER_CONTRACTS: wallet, SUBMITTER_METHODS: 'execute',
      SUBMITTER_PORT: '0', SUBMITTER_STATE_DIR: stateDirectory,
    },
  });
  return new Promise<{ url: string; stop: () => void }>((resolveStart, reject) => {
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('exit', (code) => reject(new Error(`Submitter exited (${code}): ${stderr}`)));
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
      const line = stdout.split('\n').find((candidate) => candidate.includes('"listening"'));
      if (line) resolveStart({ url: (JSON.parse(line) as { url: string }).url, stop: () => child.kill() });
    });
  });
}

/** Local infrastructure the CLI expects to exist: both registries, an approved Live provider and a test asset. */
async function setup(context: NetworkContext, keys: Record<Role, Signer>, config: FlowConfig, log: Log) {
  const journal = new MemoryJournal();
  const limits = pipelineLimits({ maxFee: 100_000_000n });
  const keypair = async (role: Role) => loadKeypair(role, process.env);

  async function deploy(name: string, deployer: Signer, args: xdr.ScVal[]) {
    const wasm = await readFile(join(WASM, `stellar_agent_auth_${name}.wasm`));
    const upload = await invoke(context, deployer, uploadInvocation(wasm), journal, { limits });
    if (upload.status !== 'success') throw new Error(`Upload ${name}: ${upload.status}`);
    const created = await invoke(context, deployer, {
      operation: Operation.createCustomContract({
        address: Address.fromString(deployer.address), wasmHash: hash(wasm),
        salt: hash(Buffer.from(`${name}:${Date.now()}:${Math.random()}`)), constructorArgs: args,
      }),
    }, journal, { limits });
    if (created.status !== 'success' || !created.returnValue) throw new Error(`Deploy ${name}: ${created.status}`);
    return Address.fromScVal(created.returnValue).toString();
  }

  log('Setup (SDK): deploy registries, approve the Live provider, issue the test asset');
  const agentRegistry = await deploy('agent_registry', keys.admin, []);
  const verificationRegistry = await deploy('verification_registry', keys.admin,
    encodeVerificationConstructorArgs(keys.admin.address, agentRegistry));
  const approval = { provider: keys.provider.address, mode: 'Live' as const };
  const approved = await invoke(context, keys.admin, verificationInvocation(context, verificationRegistry,
    'approve_provider', approval, keys.admin, verificationOperation(verificationRegistry, 'approve_provider', approval)),
  journal, { limits });
  if (approved.status !== 'success') throw new Error('Provider approval failed');

  const asset = new Asset(config.asset_code, keys.issuer.address);
  async function classic(source: Role, operations: xdr.Operation[]) {
    const builder = new TransactionBuilder(await loadSource(context, keys[source].address), {
      fee: '100', networkPassphrase: context.networkPassphrase,
    });
    operations.forEach((operation) => builder.addOperation(operation));
    const tx = builder.setTimeout(60).build();
    tx.sign(await keypair(source));
    const outcome = await submit(context, tx, journal, `source:${keys[source].address}`, limits);
    if (outcome.status !== 'success') throw new Error(`Classic transaction by ${source}: ${outcome.status}`);
  }
  for (const holder of ['funder', 'recipient'] as const) await classic(holder, [Operation.changeTrust({ asset })]);
  await classic('issuer', [Operation.payment({ destination: keys.funder.address, asset, amount: config.issue })]);
  const sac = await invoke(context, keys.admin, { operation: Operation.createStellarAssetContract({ asset }) }, journal,
    { limits });
  if (sac.status !== 'success') throw new Error('Asset contract deployment failed');
  return { agentRegistry, verificationRegistry, asset: asset.contractId(context.networkPassphrase) };
}

export interface FlowSummary {
  run: string;
  contracts: { agent_registry: string; verification_registry: string; wallet: string; asset: string };
  roles: Record<Role, string>;
  agent_id: string;
  verification: { sequence: string; risk_score: unknown; checks: unknown };
  policy_hash: string;
  payment: Record<string, unknown>;
  presigned_rejection: Record<string, unknown>;
  balances: { recipient: string; wallet: string };
  history: Record<string, unknown>;
}

/** Run the whole flow; returns what each step established. */
export async function runPaymentFlow(config: FlowConfig, log: Log = console.log): Promise<FlowSummary> {
  if (config.network !== 'local') throw new Error('The example runs on the local network only');
  const run = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = resolve(ROOT, '.local/example', run);
  const keyDirectory = join(directory, 'keys');
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env, STELLAR_NETWORK: 'local', STELLAR_NETWORK_PASSPHRASE: undefined, STELLAR_RPC_URL: config.rpc_url,
    STELLAR_AGENT_AUTH_KEY_DIR: keyDirectory, STELLAR_AGENT_AUTH_STATE_DIR: join(directory, 'state'),
    SUBMITTER_URL: undefined, WALLET_ID: undefined,
  };
  process.env['STELLAR_AGENT_AUTH_KEY_DIR'] = keyDirectory;
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const server = new rpc.Server(config.rpc_url, { allowHttp: true });
  const context = await networkContext(server, (await server.getNetwork()).passphrase);
  log(`Run ${run}: generating one key per role in ${keyDirectory}`);
  const keys = {} as Record<Role, Signer>;
  for (const role of ROLES) {
    await createNamedKey(role, baseEnv);
    keys[role] = keypairSigner(await loadKeypair(role, baseEnv));
    await server.requestAirdrop(keys[role].address);
  }
  const contracts = await setup(context, keys, config, log);
  const env: NodeJS.ProcessEnv = {
    ...baseEnv, AGENT_REGISTRY_ID: contracts.agentRegistry, VERIFICATION_REGISTRY_ID: contracts.verificationRegistry,
    VERIFIER_PUBLIC_ADDRESS: keys.provider.address,
  };

  log('\n1. The controller registers the agent; the agent key proves control of its signer');
  const registered = await expectOk(cli(env, ['agent', 'register', '--controller', 'controller', '--signer', 'agent',
    '--metadata-uri', config.metadata_uri], log), 'agent register');
  const identity = registered['identity'] as { agent_id: string; revision: string };

  log('\n2. The verifier assesses the live identity and publishes the result as the approved provider');
  const verified = await expectOk(cli(env, ['verify', 'run', '--agent', identity.agent_id, '--publish',
    '--provider', 'provider'], log), 'verify run');
  const result = verified['result'] as { sequence: string; risk_score: unknown; checks: unknown };

  log('\n3. The owner deploys a wallet, and a separate funder funds it');
  const created = await expectOk(cli(env, ['wallet', 'create', '--owner', 'owner'], log), 'wallet create');
  const wallet = created['wallet'] as string;
  env['WALLET_ID'] = wallet;
  await expectOk(cli(env, ['wallet', 'fund', '--from', 'funder', '--asset', contracts.asset, '--amount', config.fund],
    log), 'wallet fund');

  log('\n4. The owner approves a policy for the agent');
  const policyFile = join(directory, 'policy.json');
  await writeFile(policyFile, `${JSON.stringify({
    agent_id: identity.agent_id, provider: keys.provider.address, required_checks: config.policy.required_checks,
    max_assessment_age_seconds: config.policy.max_assessment_age_seconds, max_risk_score: config.policy.max_risk_score,
    assets: [{ asset: contracts.asset, per_transfer: config.policy.per_transfer, per_day: config.policy.per_day }],
    allowed_recipients: [keys.recipient.address], valid_for_seconds: config.policy.valid_for_seconds,
  }, null, 2)}\n`);
  const approved = await expectOk(cli(env, ['policy', 'approve', '--owner', 'owner', '--file', policyFile], log),
    'policy approve');
  const policyHash = approved['policy_hash'] as string;

  const submitter = await startSubmitter(env, wallet, join(directory, 'submitter'), log);
  try {
    log('\n5. The agent signs a payment; the sponsor pays the fee and submits it');
    // Only the agent's commands go through the sponsor; the owner pays for its own transactions.
    const transfer = ['--agent-key', 'agent', '--policy', policyHash, '--to', keys.recipient.address,
      '--asset', contracts.asset, '--sponsor-url', submitter.url];
    const payment = await expectOk(cli(env, ['execute', 'transfer', ...transfer, '--amount', config.payment], log),
      'execute transfer');

    log('\n6. The agent signs a second payment but does not submit it yet');
    const signedFile = join(directory, 'presigned-payment.json');
    await expectOk(cli(env, ['execute', 'sign', ...transfer, '--amount', config.presigned_payment, '--out', signedFile],
      log), 'execute sign');

    log('\n7. The owner revokes the policy');
    await expectOk(cli(env, ['policy', 'revoke', '--owner', 'owner', '--policy', policyHash], log), 'policy revoke');

    log('\n8. The previously signed payment is submitted and rejected against the live revocation');
    const rejected = await cli(env, ['execute', 'submit', '--file', signedFile, '--sponsor-url', submitter.url], log);
    if (rejected.code !== 3 || rejected.json['error'] !== 'Revoked') {
      throw new Error(`Expected the presigned payment to be rejected as Revoked, got exit ${rejected.code}: ${rejected.stderr}`);
    }
    log(`   rejected (exit ${rejected.code}): ${String(rejected.json['message'])}`);

    log('\n9. History and balances');
    const history = await expectOk(cli(env, ['history'], log), 'history');
    if (history['status'] !== 'verified') throw new Error(`History is ${String(history['status'])}`);
    const shown = await expectOk(cli(env, ['wallet', 'show', '--asset', contracts.asset], log), 'wallet show');
    const recipientUnits = await readAssetBalance({
      server, source: keys.admin.address, networkPassphrase: context.networkPassphrase,
    }, contracts.asset, keys.recipient.address);

    const summary: FlowSummary = {
      run,
      contracts: {
        agent_registry: contracts.agentRegistry, verification_registry: contracts.verificationRegistry, wallet,
        asset: contracts.asset,
      },
      roles: Object.fromEntries(ROLES.map((role) => [role, keys[role].address])) as Record<Role, string>,
      agent_id: identity.agent_id,
      verification: { sequence: result.sequence, risk_score: result.risk_score, checks: result.checks },
      policy_hash: policyHash,
      payment: { transaction: payment['transaction'], ledger: payment['ledger'], request: payment['request'] },
      presigned_rejection: { exit_code: rejected.code, error: rejected.json['error'] },
      balances: { recipient: fromContractUnits(recipientUnits, 7), wallet: String(shown['balance']) },
      history: { status: history['status'], detail: history['detail'], entries: (history['entries'] as unknown[]).length },
    };
    await writeFile(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    log(`\nDone. Recipient holds ${summary.balances.recipient}, the wallet ${summary.balances.wallet}. `
      + `Summary: ${join(directory, 'summary.json')}`);
    return summary;
  } finally {
    submitter.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  const path = resolve(values.config ?? join(ROOT, 'examples/payment-flow.local.json'));
  runPaymentFlow(JSON.parse(await readFile(path, 'utf8')) as FlowConfig).catch((error: unknown) => {
    console.error(`payment-flow: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
