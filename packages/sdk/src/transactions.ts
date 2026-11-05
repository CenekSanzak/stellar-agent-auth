import {
  Account, Address, Operation, StrKey, TransactionBuilder, rpc, xdr, type Transaction,
} from '@stellar/stellar-sdk';
import { MAX_AUTH_WINDOW_LEDGERS } from './actions.js';
import { contractErrorName } from './contract-call.js';
import { signingAddress } from './credentials.js';
import { explainContractError } from './errors.js';
import type { Signer } from './signers.js';
import type { ContractErrorName } from './types.js';

/**
 * The transaction pipeline: build, simulate, authorize, assemble, sign, submit and track. Each stage is exported so
 * that a browser owner, a headless agent and the sponsor process share one implementation.
 *
 * Status rules:
 * - A simulation rejection throws `SimulationRejected`; nothing was signed by the source or submitted.
 * - Every signed envelope is journaled before it is sent, so its hash can always be queried again.
 * - Only a confirmed successful transaction is `success`. A transaction that may still be included is `pending`, and
 *   one whose fate cannot be shown is `unknown`. Neither is ever retried with a new envelope automatically.
 * - `expired` and `rejected` are definitive: the envelope can never be included. Only then may a caller refresh state,
 *   re-simulate and obtain fresh authorization.
 */

export type RpcServer = Pick<rpc.Server,
  'getAccount' | 'simulateTransaction' | 'sendTransaction' | 'getTransaction' | 'getLatestLedger' | 'getNetwork'>;

export interface NetworkContext {
  server: RpcServer;
  networkPassphrase: string;
  /** Record CAP-71 address-bound credentials in simulation; supported from protocol 30. */
  upgradedAuth: boolean;
}

/** Connect to an RPC server, refusing a passphrase other than `networkPassphrase`. */
export async function networkContext(server: RpcServer, networkPassphrase: string): Promise<NetworkContext> {
  const network = await server.getNetwork();
  if (network.passphrase !== networkPassphrase) throw new Error('RPC server is on a different network');
  return { server, networkPassphrase, upgradedAuth: Number(network.protocolVersion) >= 30 };
}

export interface PipelineLimits {
  /** Highest total fee in stroops (inclusion plus resources) the fee payer accepts. */
  maxFee: bigint;
  /** Inclusion fee in stroops, added to the simulated resource fee. */
  inclusionFee: number;
  /** Transaction validity in seconds; also bounds how long a submission can stay pending. */
  timeoutSeconds: number;
  /** Ledgers an authorization signature stays valid, at most `MAX_AUTH_WINDOW_LEDGERS`. */
  authLedgers: number;
  pollIntervalMs: number;
}

/**
 * Defaults. The 5 XLM fee ceiling covers the one-off rent the first call on a new deployment pays to extend freshly
 * installed code (about 2.6 XLM on a protocol 29 network); steady-state calls cost well under 0.1 XLM, so callers
 * that never touch new deployments should pass a lower ceiling.
 */
export const DEFAULT_LIMITS: Readonly<PipelineLimits> = {
  maxFee: 50_000_000n, inclusionFee: 100, timeoutSeconds: 60, authLedgers: MAX_AUTH_WINDOW_LEDGERS,
  pollIntervalMs: 1_000,
};

export function pipelineLimits(overrides: Partial<PipelineLimits> = {}): PipelineLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (typeof limits.maxFee !== 'bigint' || limits.maxFee <= 0n
    || !Number.isSafeInteger(limits.inclusionFee) || limits.inclusionFee < 100
    || !Number.isInteger(limits.timeoutSeconds) || limits.timeoutSeconds < 5 || limits.timeoutSeconds > 600
    || !Number.isInteger(limits.authLedgers) || limits.authLedgers < 1 || limits.authLedgers > MAX_AUTH_WINDOW_LEDGERS
    || !Number.isInteger(limits.pollIntervalMs) || limits.pollIntervalMs < 0) {
    throw new Error('Invalid pipeline limits');
  }
  return limits;
}

// Errors.

const AUTH_FAILURES: [RegExp, AuthFailure][] = [
  [/nonce already exists/, 'replayed'],
  [/signature has expired|signature expiration/i, 'expired'],
  [/failed account authentication/, 'forged'],
  [/Unauthorized function call/, 'missing'],
];
export type AuthFailure = 'missing' | 'forged' | 'replayed' | 'expired' | 'other';

/** The simulation refused the call; nothing was submitted. */
export class SimulationRejected extends Error {
  override readonly name = 'SimulationRejected';
  /** The v1 contract error, when the contract itself refused. */
  readonly code: ContractErrorName | undefined;
  /** The host authorization failure, when authorization was refused. */
  readonly auth: AuthFailure | undefined;
  readonly detail: string;
  constructor(detail: string) {
    const code = contractErrorName(detail);
    const authError = /^HostError: Error\(Auth, /.test(detail);
    const auth = authError ? AUTH_FAILURES.find(([pattern]) => pattern.test(detail))?.[1] ?? 'other' : undefined;
    super(code ? `Simulation rejected: ${explainContractError(code)}`
      : auth ? `Simulation rejected: authorization ${auth}` : `Simulation failed: ${firstLine(detail)}`);
    this.code = code;
    this.auth = auth;
    this.detail = detail;
  }
}

/** The assembled fee is above the fee payer's ceiling; nothing was signed. */
export class FeeCeilingExceeded extends Error {
  override readonly name = 'FeeCeilingExceeded';
  constructor(readonly fee: bigint, readonly maxFee: bigint) {
    super(`Transaction fee ${fee} stroops exceeds the ceiling of ${maxFee}`);
  }
}

/**
 * An earlier submission in the same scope has not settled. Retrying could commit the action twice, so nothing new is
 * built until that hash is confirmed, failed or definitively expired.
 */
export class SubmissionUnsettled extends Error {
  override readonly name = 'SubmissionUnsettled';
  constructor(readonly record: TransactionRecord) {
    super(`Transaction ${record.hash} is ${record.status}; settle it before submitting again`);
  }
}

const firstLine = (text: string) => text.split('\n', 1)[0]!.slice(0, 400);

// Building and simulation.

export type Simulated = rpc.Api.SimulateTransactionSuccessResponse & { result: rpc.Api.SimulateHostFunctionResult };

/** The source account's current sequence; transactions built from it share that sequence. */
export async function loadSource(context: NetworkContext, address: string): Promise<Account> {
  if (!StrKey.isValidEd25519PublicKey(address)) throw new Error('Transaction source must be a standard account');
  const account = await context.server.getAccount(address);
  return new Account(address, account.sequenceNumber());
}

/** One-operation transaction from `source` at its next sequence; `source` is not mutated. */
export function buildTransaction(
  context: NetworkContext, source: Account, operation: xdr.Operation, limits: PipelineLimits,
): Transaction {
  return new TransactionBuilder(new Account(source.accountId(), source.sequenceNumber()), {
    fee: String(limits.inclusionFee), networkPassphrase: context.networkPassphrase,
  }).addOperation(operation).setTimeout(limits.timeoutSeconds).build();
}

export async function simulate(
  context: NetworkContext, tx: Transaction, mode: rpc.Api.SimulationAuthMode,
): Promise<Simulated> {
  const response = await context.server.simulateTransaction(tx, undefined, mode, context.upgradedAuth);
  if (rpc.Api.isSimulationError(response)) throw new SimulationRejected(response.error);
  if (!rpc.Api.isSimulationSuccess(response) || !response.result) {
    throw new SimulationRejected('Simulation returned no result; restore archived state and retry');
  }
  return response as Simulated;
}

// Authorization.

export interface AuthWindow {
  latestLedger: number;
  /** Inclusive last ledger the signature is valid for. */
  expirationLedger: number;
}

/** Validates a recorded entry for one account and signs it; must throw rather than sign anything unexpected. */
export type EntryAuthorizer = (entry: xdr.SorobanAuthorizationEntry, window: AuthWindow) =>
  Promise<xdr.SorobanAuthorizationEntry>;

/** Entry authorizers keyed by the account each one signs for. */
export type Authorizers = Readonly<Record<string, EntryAuthorizer>>;

/**
 * Sign every recorded entry with the authorizer for its account. Source-account credentials are accepted only when
 * `allowSource`: in a sponsored transaction the source is the sponsor, which must never authorize anything.
 */
export async function authorizeEntries(
  entries: readonly xdr.SorobanAuthorizationEntry[], authorizers: Authorizers, window: AuthWindow,
  allowSource: boolean,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  const signed: xdr.SorobanAuthorizationEntry[] = [];
  for (const entry of entries) {
    const address = signingAddress(entry);
    if (address === undefined) {
      if (entry.credentials.type !== 'sorobanCredentialsSourceAccount' || !allowSource) {
        throw new Error('Simulation asked the transaction source to authorize; refusing');
      }
      signed.push(entry);
      continue;
    }
    const authorizer = Object.hasOwn(authorizers, address) ? authorizers[address] : undefined;
    if (!authorizer) throw new Error(`The call needs authorization from ${address}, which no signer covers`);
    signed.push(await authorizer(entry, window));
  }
  return signed;
}

/** `operation` with its authorization list replaced; only contract invocations carry authorization. */
export function withAuth(operation: xdr.Operation, auth: xdr.SorobanAuthorizationEntry[]): xdr.Operation {
  const { body } = operation;
  if (body.type !== 'invokeHostFunction') throw new Error('Expected a contract invocation');
  if (operation.sourceAccount) throw new Error('Operation-level source accounts are not supported');
  return Operation.invokeHostFunction({ func: body.invokeHostFunctionOp.hostFunction, auth });
}

/** Attach the simulated footprint and resource fee, refusing a total above `limits.maxFee`. */
export function assemble(tx: Transaction, simulation: Simulated, limits: PipelineLimits): Transaction {
  const prepared = rpc.assembleTransaction(tx, simulation).build();
  const fee = BigInt(prepared.fee);
  if (fee > limits.maxFee) throw new FeeCeilingExceeded(fee, limits.maxFee);
  return prepared;
}

// Submission and tracking.

export type TransactionStatus = 'pending' | 'success' | 'failed' | 'expired' | 'rejected' | 'unknown';
const FINAL: ReadonlySet<TransactionStatus> = new Set(['success', 'failed', 'expired', 'rejected']);
export const isSettled = (status: TransactionStatus) => FINAL.has(status);

/** What is persisted for every signed envelope. It contains no key material. */
export interface TransactionRecord {
  /** Caller-chosen scope; a new submission in a scope waits for every earlier one to settle. */
  scope: string;
  hash: string;
  envelope: string;
  source: string;
  /** Unix seconds after which the envelope can no longer be included. */
  max_time: string;
  /** Latest ledger seen just before submission; the envelope cannot be in an earlier one. */
  submitted_after_ledger: number;
  status: TransactionStatus;
  ledger?: number;
  /** A contract error name, a result code or a reason the status is unknown. */
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface TransactionJournal {
  get(hash: string): Promise<TransactionRecord | undefined>;
  /** Records in `scope` that are not settled, oldest first. */
  unsettled(scope: string): Promise<TransactionRecord[]>;
  put(record: TransactionRecord): Promise<void>;
}

/** A journal for one process; use a durable journal wherever a restart must not lose a pending hash. */
export class MemoryJournal implements TransactionJournal {
  readonly records = new Map<string, TransactionRecord>();
  async get(hash: string) {
    const record = this.records.get(hash);
    return record && { ...record };
  }
  async unsettled(scope: string) {
    return [...this.records.values()].filter((record) => record.scope === scope && !isSettled(record.status))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)).map((record) => ({ ...record }));
  }
  async put(record: TransactionRecord) {
    this.records.set(record.hash, { ...record });
  }
}

export interface TransactionOutcome {
  status: TransactionStatus;
  hash: string;
  record: TransactionRecord;
  /** Present for `success`. */
  returnValue?: xdr.ScVal;
  response?: rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse;
  /** The contract error behind a `failed` transaction, when diagnostics name one. */
  code?: ContractErrorName;
}

const now = () => new Date().toISOString();
const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function invokedContract(envelope: xdr.TransactionEnvelope): string | undefined {
  if (envelope.type !== 'envelopeTypeTx') return undefined;
  const [operation] = envelope.v1.tx.operations;
  if (operation?.body.type !== 'invokeHostFunction') return undefined;
  const fn = operation.body.invokeHostFunctionOp.hostFunction;
  return fn.type === 'hostFunctionTypeInvokeContract' ? Address.fromScAddress(fn.invokeContract.contractAddress).toString()
    : undefined;
}

/**
 * The invoked contract's own error in a failed transaction's diagnostic events, if the network emitted them. Errors
 * raised by nested contracts are skipped: an asset contract's `#10` is not the wallet's `VerificationDenied`.
 */
export function failureCode(response: rpc.Api.GetFailedTransactionResponse): ContractErrorName | undefined {
  const contract = invokedContract(response.envelopeXdr);
  let code: ContractErrorName | undefined;
  for (const { event } of response.diagnosticEventsXdr ?? []) {
    if (!contract || !event.contractId || Address.contract(event.contractId.value).toString() !== contract) continue;
    if (event.body.type !== 'v0') continue;
    const [topic, error] = event.body.v0.topics;
    if (topic?.type !== 'scvSymbol' || topic.sym.toString() !== 'error') continue;
    if (error?.type !== 'scvError' || error.error.type !== 'sceContract') continue;
    code = contractErrorName(`Error(Contract, #${error.error.contractCode})`) ?? code;
  }
  return code;
}

function resultCode(response: rpc.Api.GetFailedTransactionResponse) {
  const { result } = response.resultXdr;
  if (result.type !== 'txFailed') return result.type;
  const [first] = result.results;
  const inner = first?.type === 'opInner' && first.tr.type === 'invokeHostFunction'
    ? first.tr.invokeHostFunctionResult.type : undefined;
  return inner ? `${result.type}/${inner}` : `${result.type}/unknown failure reason`;
}

function fromResponse(
  record: TransactionRecord, response: rpc.Api.GetTransactionResponse,
): TransactionOutcome | undefined {
  if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    const settled: TransactionRecord = { ...record, status: 'success', ledger: response.ledger, updated_at: now() };
    delete settled.error;
    return {
      status: 'success', hash: record.hash, record: settled, response,
      ...(response.returnValue ? { returnValue: response.returnValue } : {}),
    };
  }
  if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
    const code = failureCode(response);
    return {
      status: 'failed', hash: record.hash, response, ...(code ? { code } : {}),
      record: { ...record, status: 'failed', ledger: response.ledger, error: code ?? resultCode(response), updated_at: now() },
    };
  }
  return undefined;
}

/**
 * Query a journaled hash once. `NOT_FOUND` is `expired` only when the RPC still covers the ledger before submission
 * and has closed a ledger after the envelope's time bound; if its retention no longer covers the submission, the
 * outcome is `unknown`, never assumed.
 */
export async function settle(context: NetworkContext, record: TransactionRecord): Promise<TransactionOutcome> {
  if (isSettled(record.status)) return { status: record.status, hash: record.hash, record };
  const response = await context.server.getTransaction(record.hash);
  const final = fromResponse(record, response);
  if (final) return final;
  if (response.oldestLedger > record.submitted_after_ledger + 1) {
    const unknown = { ...record, status: 'unknown' as const, error: 'RPC retention no longer covers this submission',
      updated_at: now() };
    return { status: 'unknown', hash: record.hash, record: unknown };
  }
  if (BigInt(response.latestLedgerCloseTime) > BigInt(record.max_time)) {
    const expired = { ...record, status: 'expired' as const, error: 'time bound passed without inclusion',
      updated_at: now() };
    return { status: 'expired', hash: record.hash, record: expired };
  }
  return { status: 'pending', hash: record.hash, record: { ...record, status: 'pending', updated_at: now() } };
}

/** Settle and persist every unsettled record in `scope`; throws `SubmissionUnsettled` for the first still open. */
export async function settleScope(context: NetworkContext, journal: TransactionJournal, scope: string) {
  const settled: TransactionOutcome[] = [];
  for (const record of await journal.unsettled(scope)) {
    let outcome: TransactionOutcome;
    try {
      outcome = await settle(context, record);
    } catch (error) {
      throw new SubmissionUnsettled({ ...record, error: `status query failed: ${String(error)}` });
    }
    await journal.put(outcome.record);
    if (!isSettled(outcome.status)) throw new SubmissionUnsettled(outcome.record);
    settled.push(outcome);
  }
  return settled;
}

/** Poll a journaled submission until it settles or its time bound passes, persisting each change. */
export async function track(
  context: NetworkContext, journal: TransactionJournal, record: TransactionRecord, limits: PipelineLimits,
): Promise<TransactionOutcome> {
  let current: TransactionOutcome = { status: record.status, hash: record.hash, record };
  // The time bound plus a few ledgers is the longest an envelope can stay includable.
  const deadline = Date.now() + (limits.timeoutSeconds + 15) * 1_000;
  let failures = 0;
  for (;;) {
    try {
      current = await settle(context, current.record);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= 5) {
        const unknown = { ...current.record, status: 'unknown' as const, error: `status query failed: ${String(error)}`,
          updated_at: now() };
        await journal.put(unknown);
        return { status: 'unknown', hash: record.hash, record: unknown };
      }
    }
    if (current.status !== 'pending' || Date.now() >= deadline) break;
    await sleep(limits.pollIntervalMs);
  }
  await journal.put(current.record);
  return current;
}

/**
 * Journal and send a signed transaction, then track it. Refuses to send while an earlier submission in `scope` is
 * unsettled. A send that throws is not assumed lost: the journaled hash is tracked like any other.
 */
export async function submit(
  context: NetworkContext, signed: Transaction, journal: TransactionJournal, scope: string, limits: PipelineLimits,
): Promise<TransactionOutcome> {
  await settleScope(context, journal, scope);
  const latest = await context.server.getLatestLedger();
  const created = now();
  const record: TransactionRecord = {
    scope, hash: toHex(signed.hash()), envelope: signed.toXDR(), source: signed.source,
    max_time: signed.timeBounds?.maxTime ?? '0', submitted_after_ledger: latest.sequence, status: 'pending',
    created_at: created, updated_at: created,
  };
  if (record.max_time === '0') throw new Error('Refusing to submit a transaction without a time bound');
  await journal.put(record);

  for (let attempt = 0; ; attempt++) {
    let sent: rpc.Api.SendTransactionResponse;
    try {
      sent = await context.server.sendTransaction(signed);
    } catch {
      // The envelope may or may not have reached the network; only its hash can tell.
      return track(context, journal, record, limits);
    }
    if (sent.status === 'PENDING' || sent.status === 'DUPLICATE') return track(context, journal, record, limits);
    if (sent.status === 'TRY_AGAIN_LATER' && attempt < 3) {
      // Resending the identical envelope is always safe: it has one hash and one sequence number.
      await sleep(limits.pollIntervalMs);
      continue;
    }
    const code = sent.status === 'ERROR' ? sent.errorResult?.result.type ?? 'ERROR' : sent.status;
    const rejected = { ...record, status: 'rejected' as const, error: code, updated_at: now() };
    await journal.put(rejected);
    return { status: 'rejected', hash: record.hash, record: rejected };
  }
}

// The complete direct pipeline.

export interface Invocation {
  /** A contract invocation without authorization entries. */
  operation: xdr.Operation;
  /** Signers for every account other than the transaction source that the call must authorize. */
  authorizers?: Authorizers;
}

export interface Prepared {
  transaction: Transaction;
  simulation: Simulated;
  /** The signed authorization entries carried by `transaction`. */
  auth: xdr.SorobanAuthorizationEntry[];
  fee: bigint;
}

/**
 * Build, record, authorize, enforce and assemble `invocation` with `source` as transaction source. The source's own
 * authorization comes from its envelope signature. The result is not yet signed by the source.
 */
export async function prepare(
  context: NetworkContext, source: string, invocation: Invocation, limits: PipelineLimits,
): Promise<Prepared> {
  const account = await loadSource(context, source);
  const recording = await simulate(context, buildTransaction(context, account, invocation.operation, limits), 'record');
  const window = authWindow(recording.latestLedger, limits);
  const auth = await authorizeEntries(recording.result.auth, invocation.authorizers ?? {}, window, true);
  const tx = buildTransaction(context, account, withAuth(invocation.operation, auth), limits);
  const enforced = await simulate(context, tx, 'enforce');
  const transaction = assemble(tx, enforced, limits);
  return { transaction, simulation: enforced, auth, fee: BigInt(transaction.fee) };
}

export function authWindow(latestLedger: number, limits: Pick<PipelineLimits, 'authLedgers'>): AuthWindow {
  return { latestLedger, expirationLedger: latestLedger + limits.authLedgers };
}

/**
 * Submit an operation whose authorization entries are already signed, with `source` paying and signing only the
 * envelope. Simulation must need no further authorization, so the source authorizes nothing.
 */
export async function invokeSigned(
  context: NetworkContext, source: Signer, operation: xdr.Operation, journal: TransactionJournal, scope: string,
  limits: PipelineLimits,
): Promise<TransactionOutcome> {
  await settleScope(context, journal, scope);
  const tx = buildTransaction(context, await loadSource(context, source.address), operation, limits);
  const enforced = await simulate(context, tx, 'enforce');
  const { body } = operation;
  const supplied = new Set(body.type === 'invokeHostFunction'
    ? body.invokeHostFunctionOp.auth.map((entry) => entry.toXdr('base64')) : []);
  if (enforced.result.auth.some((entry) => !supplied.has(entry.toXdr('base64')))) {
    throw new Error('The signed operation needs authorization it does not carry');
  }
  const signed = await source.signTransaction(assemble(tx, enforced, limits), context.networkPassphrase);
  return submit(context, signed, journal, scope, limits);
}

/** Prepare, sign with `source` and submit. The scope defaults to the source account. */
export async function invoke(
  context: NetworkContext, source: Signer, invocation: Invocation, journal: TransactionJournal,
  options: { limits?: PipelineLimits; scope?: string } = {},
): Promise<TransactionOutcome> {
  const limits = options.limits ?? pipelineLimits();
  const scope = options.scope ?? `source:${source.address}`;
  await settleScope(context, journal, scope);
  const { transaction } = await prepare(context, source.address, invocation, limits);
  const signed = await source.signTransaction(transaction, context.networkPassphrase);
  return submit(context, signed, journal, scope, limits);
}
