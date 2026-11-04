#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { BASE_FEE, Keypair, TransactionBuilder, rpc } from '@stellar/stellar-sdk';
import {
  contractErrorName, decodeVerification, loadConfig, readAgent, readCurrent, readLatestResult,
  verificationOperation, VerificationRegistryError,
  type AgentIdentity, type Environment, type RegistryRead, type VerificationResult,
} from '@stellar-agent-auth/sdk';
import {
  PublicationPending, ReportStore, prepareAssessment, publishResult, readAccountSnapshot, settlePending,
  nextResultSequence, type Assessment, type Published, type PublishTarget,
} from './attestations.js';
import { runChecks, type CheckFinding, type NetworkOptions } from './checks.js';

export { ReportStore, readAccountSnapshot, settlePending, PublicationPending } from './attestations.js';
export { safeFetch } from './net.js';

/**
 * Verifier process: an explicit job that assesses one agent revision, stores the report and, only with `--publish`,
 * publishes the result as the provider. The provider key is read from a file named by `VERIFIER_SECRET_KEY_FILE`
 * and is never accepted on the command line or from public configuration.
 */

export interface VerifierContext {
  server: rpc.Server;
  networkPassphrase: string;
  agentRegistry: string;
  verificationRegistry: string;
  /** Public provider address; the key is needed only to publish or revoke. */
  provider: string;
  reports: ReportStore;
  stateDirectory: string;
  network?: NetworkOptions;
}

export interface AssessOptions {
  agentId: bigint;
  /** Defaults to the agent's live revision; an explicit stale revision fails with `IdentityChanged`. */
  revision?: bigint | undefined;
  validitySeconds?: bigint | undefined;
  /** Publishes with this key when present; otherwise a dry run. */
  publisher?: Keypair | undefined;
}

export interface AssessOutcome {
  identity: AgentIdentity;
  findings: CheckFinding[];
  assessment: Assessment;
  reportPath: string;
  published?: Published;
  /** An earlier interrupted publication for this agent revision that committed before this run. */
  settled?: Published;
}

const reader = (context: VerifierContext, contractId: string): RegistryRead => ({
  server: context.server, contractId, source: context.provider, networkPassphrase: context.networkPassphrase,
});

function publishTarget(context: VerifierContext, publisher: Keypair): PublishTarget {
  if (publisher.publicKey() !== context.provider) throw new Error('Signing key does not match VERIFIER_PUBLIC_ADDRESS');
  return {
    server: context.server, contractId: context.verificationRegistry, networkPassphrase: context.networkPassphrase,
    provider: publisher, stateDirectory: context.stateDirectory,
  };
}

/** Assess one live agent revision; the report is stored before anything is published. */
export async function assess(context: VerifierContext, options: AssessOptions): Promise<AssessOutcome> {
  const agents = reader(context, context.agentRegistry);
  const revision = options.revision ?? (await readAgent(agents, options.agentId)).revision;
  const identity = await readCurrent(agents, options.agentId, revision);
  const target = options.publisher ? publishTarget(context, options.publisher) : undefined;
  const settled = target ? await settlePending(target, identity) : undefined;

  const [account, latest] = await Promise.all([
    readAccountSnapshot(context.server, identity.signer), context.server.getLatestLedger(),
  ]);
  const findings = await runChecks({ ...context.network, identity, account, latestLedger: latest.sequence });
  const sequence = await nextResultSequence(reader(context, context.verificationRegistry), {
    agent_id: identity.agent_id, revision: identity.revision, provider: context.provider,
  });
  const assessment = prepareAssessment({
    networkPassphrase: context.networkPassphrase, agentRegistry: context.agentRegistry,
    verificationRegistry: context.verificationRegistry, provider: context.provider, mode: 'Live', identity, account,
    findings, sequence, issuedAt: BigInt(latest.closeTime), validitySeconds: options.validitySeconds,
  });
  const { path: reportPath } = await context.reports.save(assessment.report);
  const outcome: AssessOutcome = {
    identity, findings, assessment, reportPath, ...(settled ? { settled } : {}),
  };
  if (target) outcome.published = await publishResult(target, assessment.result);
  return outcome;
}

/** Revoke the provider's latest result for an agent revision. Terminal for that result. */
export async function revoke(
  context: VerifierContext, publisher: Keypair, agentId: bigint, revision: bigint, sequence: bigint,
): Promise<{ hash: string; result: VerificationResult }> {
  const target = publishTarget(context, publisher);
  const source = await context.server.getAccount(publisher.publicKey());
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: context.networkPassphrase })
    .addOperation(verificationOperation(target.contractId, 'revoke', {
      agent_id: agentId, revision, provider: context.provider, sequence,
    }))
    .setTimeout(60)
    .build();
  const simulation = await context.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    const code = contractErrorName(simulation.error);
    if (code) throw new VerificationRegistryError(code, `Revocation rejected: ${code}`);
    throw new Error(`Revocation simulation failed: ${simulation.error}`);
  }
  const prepared = rpc.assembleTransaction(tx, simulation).build();
  prepared.sign(publisher);
  const sent = await context.server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error('Revocation rejected before inclusion');
  const status = await context.server.pollTransaction(sent.hash, { attempts: 30, sleepStrategy: () => 1_000 });
  if (status.status !== rpc.Api.GetTransactionStatus.SUCCESS || !status.returnValue) {
    throw new Error(`Revocation ${sent.hash} did not succeed: ${status.status}`);
  }
  return { hash: sent.hash, result: decodeVerification(status.returnValue) };
}

/** Read the provider key from a file only its owner can read. */
export async function loadProviderKey(path: string): Promise<Keypair> {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error('VERIFIER_SECRET_KEY_FILE must not be readable by group or others');
  return Keypair.fromSecret((await readFile(path, 'utf8')).trim());
}

function contextFromEnvironment(env: Environment): VerifierContext {
  const config = loadConfig(env);
  const agentRegistry = config.contracts.AGENT_REGISTRY_ID;
  const verificationRegistry = config.contracts.VERIFICATION_REGISTRY_ID;
  if (!agentRegistry || !verificationRegistry || !config.provider) {
    throw new Error('Set AGENT_REGISTRY_ID, VERIFICATION_REGISTRY_ID and VERIFIER_PUBLIC_ADDRESS');
  }
  const state = resolve(env['VERIFIER_STATE_DIR'] ?? '.local/verifier');
  return {
    server: new rpc.Server(config.rpcUrl, { allowHttp: config.network === 'local' }),
    networkPassphrase: config.passphrase, agentRegistry, verificationRegistry, provider: config.provider,
    reports: new ReportStore(resolve(state, 'reports')), stateDirectory: resolve(state, 'pending'),
  };
}

const json = (value: unknown) => JSON.stringify(value, (_, item: unknown) => {
  if (typeof item === 'bigint') return item.toString();
  if (item instanceof Uint8Array) return Buffer.from(item).toString('hex');
  return item;
}, 2);

const USAGE = `Usage:
  verifier assess --agent <id> [--revision <n>] [--validity <seconds>] [--publish]
  verifier show --agent <id> --revision <n>
  verifier revoke --agent <id> --revision <n> --sequence <n>

Environment: STELLAR_NETWORK, STELLAR_RPC_URL, AGENT_REGISTRY_ID, VERIFICATION_REGISTRY_ID,
VERIFIER_PUBLIC_ADDRESS, VERIFIER_SECRET_KEY_FILE (assess --publish and revoke), VERIFIER_STATE_DIR.
assess without --publish is a dry run: it stores the report and prints the result without signing.`;

export async function main(argv: string[], env: Environment): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      agent: { type: 'string' }, revision: { type: 'string' }, sequence: { type: 'string' },
      validity: { type: 'string' }, publish: { type: 'boolean', default: false }, help: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const integer = (name: string, value: string | undefined) => {
    if (value === undefined || !/^\d{1,20}$/.test(value)) throw new Error(`--${name} must be a non-negative integer`);
    return BigInt(value);
  };
  const context = contextFromEnvironment(env);
  const key = async () => {
    const path = env['VERIFIER_SECRET_KEY_FILE'];
    if (!path) throw new Error('Set VERIFIER_SECRET_KEY_FILE to sign as the provider');
    return loadProviderKey(path);
  };

  switch (command) {
    case 'assess': {
      const outcome = await assess(context, {
        agentId: integer('agent', values.agent),
        revision: values.revision === undefined ? undefined : integer('revision', values.revision),
        validitySeconds: values.validity === undefined ? undefined : integer('validity', values.validity),
        publisher: values.publish ? await key() : undefined,
      });
      console.log(json({
        mode: values.publish ? 'published' : 'dry-run', report: outcome.reportPath,
        result: outcome.assessment.result, findings: outcome.findings, published: outcome.published,
        settled: outcome.settled,
      }));
      return 0;
    }
    case 'show': {
      const result = await readLatestResult(reader(context, context.verificationRegistry), {
        agent_id: integer('agent', values.agent), revision: integer('revision', values.revision),
        provider: context.provider,
      });
      console.log(json({ result, report: context.reports.path(result.evidence_hash) }));
      return 0;
    }
    case 'revoke': {
      const revoked = await revoke(context, await key(), integer('agent', values.agent),
        integer('revision', values.revision), integer('sequence', values.sequence));
      console.log(json(revoked));
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (error: unknown) => {
    if (error instanceof PublicationPending) {
      console.error(`${error.message}\nThe report is stored; rerun the same command to settle the publication.`);
      process.exitCode = 75;
      return;
    }
    const code = error instanceof VerificationRegistryError ? ` (${error.code})` : '';
    console.error(`verifier: ${error instanceof Error ? error.message : String(error)}${code}`);
    process.exitCode = 1;
  });
}
