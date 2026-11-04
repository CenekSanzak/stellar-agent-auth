import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BASE_FEE, Keypair, TransactionBuilder, rpc, type Transaction,
} from '@stellar/stellar-sdk';
import {
  buildResult, contractErrorName, decodeVerification, nextResultSequence, validatePublication,
  verificationOperation, VerificationRegistryError,
  type AgentIdentity, type AssessmentMode, type VerificationRead, type VerificationResult,
} from '@stellar-agent-auth/sdk';
import type { AccountSnapshot, CheckFinding } from './checks.js';

/**
 * Reports, results and publication. The detailed report is persisted under its own SHA-256 before the result that
 * commits to that hash is published, so every published evidence hash resolves to a stored report.
 */

export const REPORT_SCHEMA = 'stellar-agent-auth/verification-report/v1';
export const VERIFIER_VERSION = '0.1.0';
/** Default lifetime of a published result. Consumers apply their own, usually shorter, maximum age. */
export const DEFAULT_VALIDITY_SECONDS = 86_400n;

const SCORING = 'Each implemented check scores 0 when passed and 100 when failed. The risk score is the integer '
  + 'ceiling of the mean of scored checks. Inconclusive, not-applicable and unsupported checks are unscored.';
const LIMITATIONS = [
  'Limited assessment: metadata integrity, endpoint TLS and reachability, and signer account state only.',
  'Code, media, token and threat-feed checks are unsupported and are not passes.',
  'A passing assessment does not establish that the agent behaves safely or will in future.',
  'The evidence hash commits to this report; it is not a privacy or zero-knowledge proof.',
];

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Deterministic JSON: object keys sorted, `bigint` as decimal strings, `Uint8Array` as hex. */
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Uint8Array) return hex(item);
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().flatMap((key) => {
        const entry = (item as Record<string, unknown>)[key];
        return entry === undefined ? [] : [[key, normalize(entry)]];
      }));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export interface AssessmentInput {
  networkPassphrase: string;
  agentRegistry: string;
  verificationRegistry: string;
  provider: string;
  mode: AssessmentMode;
  identity: AgentIdentity;
  account: AccountSnapshot | null;
  findings: readonly CheckFinding[];
  sequence: bigint;
  /** Ledger close time used as the issue time, so the result is never issued in the ledger's future. */
  issuedAt: bigint;
  validitySeconds?: bigint | undefined;
}

export interface Assessment {
  result: VerificationResult;
  report: Uint8Array;
  evidenceHash: Uint8Array;
}

/** Builds the report and the result committing to its hash. The result passes the SDK's publication rules. */
export function prepareAssessment(input: AssessmentInput): Assessment {
  const validity = input.validitySeconds ?? DEFAULT_VALIDITY_SECONDS;
  if (validity <= 0n) throw new Error('Validity must be positive');
  const expiresAt = input.issuedAt + validity;
  const draft = {
    agent_id: input.identity.agent_id, revision: input.identity.revision, provider: input.provider,
    sequence: input.sequence, mode: input.mode, serious_wallet_risks: 0,
    checks: input.findings.map(({ kind, outcome, score }) => ({ kind, outcome, score })),
    issued_at: input.issuedAt, expires_at: expiresAt,
  };
  const preview = buildResult({ ...draft, evidence_hash: new Uint8Array(32) });
  const report = new TextEncoder().encode(canonicalJson({
    schema: REPORT_SCHEMA,
    verifier: { version: VERIFIER_VERSION, provider: input.provider, mode: input.mode },
    network_id: hex(createHash('sha256').update(input.networkPassphrase).digest()),
    contracts: { agent_registry: input.agentRegistry, verification_registry: input.verificationRegistry },
    agent: {
      agent_id: input.identity.agent_id, revision: input.identity.revision, controller: input.identity.controller,
      signer: input.identity.signer, metadata_uri: input.identity.metadata_uri,
      metadata_hash: input.identity.metadata_hash,
    },
    result: {
      sequence: input.sequence, issued_at: input.issuedAt, expires_at: expiresAt,
      risk_score: preview.risk_score, serious_wallet_risks: 0,
    },
    checks: [...input.findings].sort((a, b) =>
      preview.checks.findIndex(({ kind }) => kind === a.kind) - preview.checks.findIndex(({ kind }) => kind === b.kind)),
    scoring: SCORING,
    limitations: LIMITATIONS,
  }));
  const evidenceHash = Uint8Array.from(createHash('sha256').update(report).digest());
  const result = { ...preview, evidence_hash: evidenceHash };
  validatePublication(result, input.issuedAt);
  return { result, report, evidenceHash };
}

/** Content-addressed report files named `<sha256>.json`; writes are atomic and idempotent. */
export class ReportStore {
  constructor(readonly directory: string) {}

  path(hash: Uint8Array) {
    return join(this.directory, `${hex(hash)}.json`);
  }

  async save(report: Uint8Array): Promise<{ hash: Uint8Array; path: string }> {
    const hash = Uint8Array.from(createHash('sha256').update(report).digest());
    const path = this.path(hash);
    await mkdir(this.directory, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, report, { mode: 0o644 });
    await rename(temporary, path);
    return { hash, path };
  }

  /** The stored bytes, verified against their name. */
  async load(hash: Uint8Array): Promise<Uint8Array> {
    const bytes = Uint8Array.from(await readFile(this.path(hash)));
    if (hex(createHash('sha256').update(bytes).digest()) !== hex(hash)) throw new Error('Stored report is corrupt');
    return bytes;
  }
}

/** Reads the public state of a signing account through RPC; `null` when it does not exist. */
export async function readAccountSnapshot(
  server: Pick<rpc.Server, 'getAccountEntry'>, address: string,
): Promise<AccountSnapshot | null> {
  let entry;
  try {
    entry = await server.getAccountEntry(address);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return null;
    throw error;
  }
  const [master = 0, low = 0, medium = 0, high = 0] = entry.thresholds.value;
  return {
    thresholds: { master, low, medium, high }, extraSigners: entry.signers.length, sequence: entry.seqNum,
  };
}

export interface PublishTarget {
  server: Pick<rpc.Server, 'getAccount' | 'simulateTransaction' | 'sendTransaction' | 'getTransaction'
    | 'getLatestLedger'>;
  contractId: string;
  networkPassphrase: string;
  /** The provider pays for and authorizes its own publication as transaction source. */
  provider: Keypair;
  /** Directory for the in-flight publication journal. */
  stateDirectory: string;
  /** Transaction validity window in seconds. */
  timeoutSeconds?: number;
  pollAttempts?: number;
}

export interface Published {
  hash: string;
  ledger: number;
  result: VerificationResult;
}

interface Journal {
  hash: string;
  envelope: string;
  max_time: string;
  agent_id: string;
  revision: string;
  sequence: string;
  evidence_hash: string;
}

const journalPath = (target: PublishTarget, result: Pick<VerificationResult, 'agent_id' | 'revision'>) =>
  join(target.stateDirectory, `publish-${result.agent_id}-${result.revision}-${target.provider.publicKey()}.json`);

async function readJournal(path: string): Promise<Journal | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Journal;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** A publication whose outcome is not yet known; retrying now could not be shown safe. */
export class PublicationPending extends Error {
  override readonly name = 'PublicationPending';
  constructor(readonly hash: string) {
    super(`Publication ${hash} is still pending; retry after its time bound passes`);
  }
}

function confirmedResult(response: rpc.Api.GetSuccessfulTransactionResponse) {
  if (!response.returnValue) throw new Error('Confirmed publication has no return value');
  return decodeVerification(response.returnValue);
}

/**
 * Settle an earlier attempt before any new one: a committed transaction is returned as the outcome, a failed one or
 * one past its time bound is cleared, and one still within its bound raises `PublicationPending`.
 */
export async function settlePending(
  target: PublishTarget, key: Pick<VerificationResult, 'agent_id' | 'revision'>,
): Promise<Published | undefined> {
  const path = journalPath(target, key);
  const journal = await readJournal(path);
  if (!journal) return undefined;
  const status = await target.server.getTransaction(journal.hash);
  if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    await rm(path, { force: true });
    return { hash: journal.hash, ledger: status.ledger, result: confirmedResult(status) };
  }
  if (status.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    const latest = await target.server.getLatestLedger();
    if (BigInt(latest.closeTime) <= BigInt(journal.max_time)) throw new PublicationPending(journal.hash);
  }
  await rm(path, { force: true });
  return undefined;
}

async function poll(target: PublishTarget, hash: string) {
  const attempts = target.pollAttempts ?? 30;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    const status = await target.server.getTransaction(hash);
    if (status.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return status;
  }
  return undefined;
}

/**
 * Publish `result` with the provider as transaction source. The signed envelope is journaled before submission, so
 * an interrupted run settles the same transaction instead of building another. The registry's exact-next sequence
 * rule independently rejects a duplicate.
 */
export async function publishResult(target: PublishTarget, result: VerificationResult): Promise<Published> {
  if (result.provider !== target.provider.publicKey()) throw new Error('Result names a different provider');
  const settled = await settlePending(target, result);
  if (settled) return settled;

  const source = await target.server.getAccount(target.provider.publicKey());
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: target.networkPassphrase })
    .addOperation(verificationOperation(target.contractId, 'publish', { result }))
    .setTimeout(target.timeoutSeconds ?? 60)
    .build();
  const simulation = await target.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    const code = contractErrorName(simulation.error);
    if (code) throw new VerificationRegistryError(code, `Publication rejected: ${code}`);
    throw new Error(`Publication simulation failed: ${simulation.error}`);
  }
  const prepared = rpc.assembleTransaction(tx, simulation).build() as Transaction;
  prepared.sign(target.provider);
  const hash = Buffer.from(prepared.hash()).toString('hex');
  const path = journalPath(target, result);
  await mkdir(target.stateDirectory, { recursive: true });
  const journal: Journal = {
    hash, envelope: prepared.toXDR(), max_time: prepared.timeBounds?.maxTime ?? '0',
    agent_id: result.agent_id.toString(), revision: result.revision.toString(), sequence: result.sequence.toString(),
    evidence_hash: hex(result.evidence_hash),
  };
  await writeFile(`${path}.tmp`, JSON.stringify(journal, null, 2), { mode: 0o600 });
  await rename(`${path}.tmp`, path);

  const sent = await target.server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    await rm(path, { force: true });
    throw new Error(`Publication rejected before inclusion: ${sent.errorResult ? Buffer.from(sent.errorResult.toXdr()).toString('base64') : 'no result'}`);
  }
  const status = await poll(target, hash);
  if (!status) throw new PublicationPending(hash);
  await rm(path, { force: true });
  if (status.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Publication ${hash} failed on ledger ${status.ledger}`);
  }
  return { hash, ledger: status.ledger, result: confirmedResult(status) };
}

export { nextResultSequence, type VerificationRead };
