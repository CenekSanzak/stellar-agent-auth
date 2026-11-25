import { Account, Address, FeeBumpTransaction, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { MAX_AUTH_WINDOW_LEDGERS } from './actions.js';
import { signingAddress } from './credentials.js';
import type { Signer } from './signers.js';
import {
  SimulationRejected, SubmissionUnsettled, assemble, authWindow, authorizeEntries, buildTransaction, isSettled,
  loadSource, networkIdOf, operationHash, pipelineLimits, settle, settleScope, simulate, submit, withAuth,
  type Invocation, type NetworkContext, type PipelineLimits, type TransactionJournal, type TransactionOutcome,
  type TransactionRecord, type TransactionStatus,
} from './transactions.js';

/**
 * Fee sponsorship. The client records and signs every authorization entry itself, with the sponsor's public address
 * as the simulated source, and sends only the signed operation. The sponsor rebuilds the transaction around it with
 * itself as source, enforces it in simulation, checks the fee ceiling, signs the envelope and submits it.
 *
 * The sponsor gains no authority and cannot change the action:
 * - every entry is bound by its signer to the exact call and arguments, so any change fails host authorization;
 * - source-account credentials are refused, so nothing the sponsor signs authorizes a contract call;
 * - an entry signed by the sponsor's own address is refused;
 * - only configured contracts and methods are sponsored.
 */

export interface SponsorPolicy {
  /** Contracts whose invocations may be sponsored. */
  contracts: readonly string[];
  /** Function names that may be sponsored; all functions of the allowed contracts when omitted. */
  methods?: readonly string[];
  maxAuthEntries: number;
  limits: PipelineLimits;
}

export class SponsorRefused extends Error {
  override readonly name = 'SponsorRefused';
}

export interface SponsoredCall {
  contract: string;
  method: string;
  args: xdr.ScVal[];
  /** Accounts that signed an authorization entry. */
  signers: string[];
}

const hex = (value: { toXdr(format: 'hex'): string }) => value.toXdr('hex');

/** Decode and check a sponsorship request without touching the network. */
export function inspectSponsoredOperation(operationXdr: string, sponsor: string, policy: SponsorPolicy): SponsoredCall {
  let operation: xdr.Operation;
  try {
    operation = xdr.Operation.fromXdr(operationXdr, 'base64');
  } catch {
    throw new SponsorRefused('Operation is not valid XDR');
  }
  if (operation.sourceAccount) throw new SponsorRefused('Operation-level source accounts are not sponsored');
  if (operation.body.type !== 'invokeHostFunction') throw new SponsorRefused('Only contract calls are sponsored');
  const op = operation.body.invokeHostFunctionOp;
  if (op.hostFunction.type !== 'hostFunctionTypeInvokeContract') {
    throw new SponsorRefused('Only contract calls are sponsored, not uploads or deployments');
  }
  const call = op.hostFunction.invokeContract;
  const contract = Address.fromScAddress(call.contractAddress).toString();
  const method = call.functionName.toString();
  if (!policy.contracts.includes(contract)) throw new SponsorRefused(`Contract ${contract} is not sponsored`);
  if (policy.methods && !policy.methods.includes(method)) throw new SponsorRefused(`Method ${method} is not sponsored`);
  const { auth } = op;
  if (!auth.length || auth.length > policy.maxAuthEntries) {
    throw new SponsorRefused(`Expected 1 to ${policy.maxAuthEntries} signed authorization entries`);
  }
  const signers: string[] = [];
  for (const entry of auth) {
    const address = signingAddress(entry);
    if (address === undefined) throw new SponsorRefused('Only address credentials are sponsored');
    if (address === sponsor) throw new SponsorRefused('The sponsor does not authorize sponsored calls');
    const { credentials } = entry;
    const signed = credentials.type === 'sorobanCredentialsAddress' ? credentials.address
      : credentials.type === 'sorobanCredentialsAddressV2' ? credentials.addressV2 : undefined;
    if (!signed || signed.signature.type === 'scvVoid') throw new SponsorRefused(`Entry for ${address} is unsigned`);
    const root = entry.rootInvocation.function;
    if (root.type !== 'sorobanAuthorizedFunctionTypeContractFn') {
      throw new SponsorRefused('Authorization must be for the sponsored contract call');
    }
    const authorized = root.contractFn;
    if (Address.fromScAddress(authorized.contractAddress).toString() !== contract
      || authorized.functionName.toString() !== method
      || authorized.args.map(hex).join() !== call.args.map(hex).join()) {
      throw new SponsorRefused('Authorization must be for the sponsored contract call');
    }
    signers.push(address);
  }
  return { contract, method, args: call.args, signers };
}

export interface SponsorshipResult {
  status: TransactionStatus;
  hash: string;
  record: TransactionRecord;
  /** Base64 `ScVal` returned by a successful call. */
  return_value?: string;
  /** Contract error name of a confirmed failure, when diagnostics name it. */
  code?: string;
}

const toResult = (outcome: TransactionOutcome): SponsorshipResult => ({
  status: outcome.status, hash: outcome.hash, record: outcome.record,
  ...(outcome.returnValue ? { return_value: outcome.returnValue.toXdr('base64') } : {}),
  ...(outcome.code ? { code: outcome.code } : {}),
});

/**
 * What a sponsor knows about an operation, asked by `operationHash`:
 * - a `SponsorshipResult`: it built a transaction around the operation, and this is that transaction;
 * - `in-progress`: it is handling the operation now and has not built a transaction yet;
 * - `not-submitted`: it has no transaction for the operation and is not handling it.
 */
export type SponsorLookup = SponsorshipResult | { status: 'in-progress' | 'not-submitted' };

/** Anything that sponsors a signed operation: the in-process `Sponsor`, or `httpSponsor` for the submitter. */
export interface SponsorEndpoint {
  readonly address: string;
  sponsor(operationXdr: string): Promise<SponsorshipResult>;
  status(hash: string): Promise<SponsorshipResult>;
  /** Absent on a sponsor that cannot answer it; a client then has no way to recover a lost answer. */
  lookup?(operationHash: string): Promise<SponsorLookup>;
}

/**
 * A private sponsor for configured contracts. Submissions are serialized: the next transaction is built only after
 * the previous one is final, so the sponsor's sequence numbers never collide or leave a gap. An unsettled earlier
 * transaction, including one left by a restart, blocks new work until it settles.
 */
export class Sponsor implements SponsorEndpoint {
  readonly address: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly scope: string;
  /** Operations being handled now, by operation hash. A repeat of one joins it instead of starting another. */
  private readonly inFlight = new Map<string, Promise<SponsorshipResult>>();

  constructor(
    private readonly context: NetworkContext, private readonly signer: Signer,
    private readonly policy: SponsorPolicy, private readonly journal: TransactionJournal,
  ) {
    this.address = signer.address;
    this.scope = `sponsor:${signer.address}`;
    if (!policy.contracts.length || policy.contracts.some((id) => !StrKey.isValidContract(id))) {
      throw new Error('Sponsor needs at least one contract address');
    }
    if (!Number.isInteger(policy.maxAuthEntries) || policy.maxAuthEntries < 1) throw new Error('Invalid entry limit');
  }

  /**
   * Validate, enforce and submit one signed operation. Simulation failures throw `SimulationRejected`.
   *
   * Sending the same operation again is safe. While the first is being handled, the repeat waits for the same
   * answer. Afterwards it gets the transaction already built for it, unless that transaction can never be included,
   * in which case a new one is built.
   */
  async sponsor(operationXdr: string): Promise<SponsorshipResult> {
    inspectSponsoredOperation(operationXdr, this.address, this.policy);
    const key = operationHash(xdr.Operation.fromXdr(operationXdr, 'base64'));
    const current = this.inFlight.get(key);
    if (current) return current;
    const run = this.tail.then(() => this.run(operationXdr, key));
    this.tail = run.catch(() => undefined);
    this.inFlight.set(key, run);
    const done = () => { this.inFlight.delete(key); };
    run.then(done, done);
    return run;
  }

  private async run(operationXdr: string, key: string): Promise<SponsorshipResult> {
    const { limits } = this.policy;
    await settleScope(this.context, this.journal, this.scope);
    const earlier = await this.journal.byOperation(this.scope, key);
    // Applied, or possibly still to be: answer with that transaction. Only a dead envelope allows a new one.
    if (earlier && earlier.status !== 'expired' && earlier.status !== 'rejected') return this.status(earlier.hash);
    const operation = xdr.Operation.fromXdr(operationXdr, 'base64');
    const account = await loadSource(this.context, this.address);
    const tx = buildTransaction(this.context, account, operation, limits);
    const enforced = await simulate(this.context, tx, 'enforce');
    assertSuppliedAuth(operation, enforced.result.auth);
    const prepared = assemble(tx, enforced, limits);
    const signed = await this.signer.signTransaction(prepared, this.context.networkPassphrase);
    return toResult(await submit(this.context, signed, this.journal, this.scope, limits));
  }

  /** Settle a hash this sponsor submitted. */
  async status(hash: string): Promise<SponsorshipResult> {
    const record = await this.journal.get(hash);
    if (!record || record.scope !== this.scope) throw new SponsorRefused('Unknown transaction');
    const outcome = await settle(this.context, record);
    await this.journal.put(outcome.record);
    return toResult(outcome);
  }

  /** What this sponsor did with the operation that has `key` as its `operationHash`. */
  async lookup(key: string): Promise<SponsorLookup> {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new SponsorRefused('Expected an operation hash');
    if (this.inFlight.has(key)) return { status: 'in-progress' };
    const record = await this.journal.byOperation(this.scope, key);
    return record ? this.status(record.hash) : { status: 'not-submitted' };
  }

  /** Settle anything left unsettled by an earlier run; throws `SubmissionUnsettled` while one is still open. */
  async recover(): Promise<void> {
    await settleScope(this.context, this.journal, this.scope);
  }
}

/** Enforced simulation reports the entries it used; any entry the client did not supply is refused. */
export function assertSuppliedAuth(operation: xdr.Operation, used: readonly xdr.SorobanAuthorizationEntry[]) {
  const { body } = operation;
  const supplied = new Set(body.type === 'invokeHostFunction'
    ? body.invokeHostFunctionOp.auth.map((entry) => entry.toXdr('base64')) : []);
  if (used.some((entry) => !supplied.has(entry.toXdr('base64')))) {
    throw new SponsorRefused('Simulation requires authorization the signed operation does not carry');
  }
}

/** A sponsor policy with validated limits. */
export function sponsorPolicy(
  contracts: readonly string[], options: { methods?: readonly string[]; maxAuthEntries?: number;
    limits?: Partial<PipelineLimits> } = {},
): SponsorPolicy {
  return {
    contracts: [...contracts], maxAuthEntries: options.maxAuthEntries ?? 4, limits: pipelineLimits(options.limits),
    ...(options.methods ? { methods: [...options.methods] } : {}),
  };
}

// Client side.

/**
 * Record `invocation` with the sponsor as simulated source, sign every entry with the caller's authorizers and
 * return the signed operation for the sponsor. Source-account credentials are refused here too.
 */
export async function signForSponsor(
  context: NetworkContext, sponsor: string, invocation: Invocation, limits: PipelineLimits,
): Promise<xdr.Operation> {
  const account = await loadSource(context, sponsor).catch(() => new Account(sponsor, '0'));
  const recording = await simulate(context, buildTransaction(context, account, invocation.operation, limits), 'record');
  const auth = await authorizeEntries(recording.result.auth, invocation.authorizers ?? {},
    authWindow(recording.latestLedger, limits));
  return withAuth(invocation.operation, auth);
}

/**
 * The sponsor did not give a usable answer, so whether it submitted the operation is not known. The operation stays
 * valid until `expirationLedger`; a new request signed before then could be applied as well as this one.
 */
export class SponsorOutcomeUnknown extends Error {
  override readonly name = 'SponsorOutcomeUnknown';
  constructor(
    readonly expirationLedger: number, readonly cause: unknown,
    /** `operationHash` of the signed operation; a sponsor that supports `lookup` can be asked about it later. */
    readonly operationHash?: string,
  ) {
    super('The sponsor did not answer, so this operation may or may not have been submitted. It can be applied '
      + `until ledger ${expirationLedger}. Sign nothing new for this action before then; afterwards read the `
      + 'on-chain state to see whether it was applied.');
  }
}

/** The last ledger at which any signed entry of `operation` is still valid. */
export function authExpiration(operation: xdr.Operation): number {
  const { body } = operation;
  const entries = body.type === 'invokeHostFunction' ? body.invokeHostFunctionOp.auth : [];
  return Math.max(0, ...entries.map(({ credentials }) =>
    credentials.type === 'sorobanCredentialsAddress' ? credentials.address.signatureExpirationLedger
      : credentials.type === 'sorobanCredentialsAddressV2' ? credentials.addressV2.signatureExpirationLedger : 0));
}

/**
 * The record a sponsor reported, rebuilt from what the client can check itself. The envelope must be a plain
 * transaction from the sponsor that carries exactly the one operation the client signed, and the reported hash must
 * be that envelope's hash on this network. The time bound comes from the envelope and the earliest possible ledger
 * from the client's own view, never from the sponsor's report.
 *
 * `operation` is the signed operation, or its `operationHash` when only that was kept.
 */
export function verifiedSponsorRecord(
  context: Pick<NetworkContext, 'networkPassphrase'>, sponsor: string, operation: xdr.Operation | string,
  reported: TransactionRecord, scope: string, submittedAfterLedger: number,
): TransactionRecord {
  const expected = typeof operation === 'string' ? operation : operationHash(operation);
  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(String(reported?.envelope), context.networkPassphrase);
  } catch {
    throw new Error('Sponsor returned an unreadable transaction');
  }
  const envelope = tx.toEnvelope();
  const operations = envelope.type === 'envelopeTypeTx' ? envelope.v1.tx.operations : [];
  const maxTime = 'timeBounds' in tx ? tx.timeBounds?.maxTime : undefined;
  if (tx instanceof FeeBumpTransaction || operations.length !== 1 || tx.source !== sponsor
    || operationHash(operations[0]!) !== expected
    || Array.from(tx.hash(), (byte) => byte.toString(16).padStart(2, '0')).join('') !== reported.hash
    || !maxTime || maxTime === '0') {
    throw new Error('Sponsor reported a transaction other than the one this client signed');
  }
  const created = new Date().toISOString();
  return {
    scope, hash: reported.hash, envelope: reported.envelope, source: sponsor, max_time: maxTime,
    submitted_after_ledger: submittedAfterLedger, status: 'pending', operation_hash: expected,
    network_id: networkIdOf(context.networkPassphrase), created_at: created, updated_at: created,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the sponsor what it did with an operation whose answer was lost. Returns its transaction for the operation,
 * or `undefined` when the sponsor cannot say. Throws `SponsorRefused` when the sponsor states that it submitted
 * nothing for it: that is the same assurance as any other refusal.
 */
async function lookupLost(
  endpoint: SponsorEndpoint, key: string, attempts: number, waitMs: number,
): Promise<SponsorshipResult | undefined> {
  if (!endpoint.lookup) return undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(waitMs);
    let found: SponsorLookup;
    try {
      found = await endpoint.lookup(key);
    } catch {
      continue;
    }
    if ('record' in found) return found;
    if (found.status === 'not-submitted') {
      throw new SponsorRefused('The sponsor reports that it submitted nothing for this operation');
    }
  }
  return undefined;
}

/**
 * Settle an operation a sponsor may have submitted, from its `operationHash` alone, and journal it under `scope`.
 * For use after `SponsorOutcomeUnknown`, including from another process. The sponsor's transaction is accepted only
 * if it carries exactly that operation, and its outcome is read from the network. Throws `SponsorRefused` if the
 * sponsor submitted nothing, and `SponsorOutcomeUnknown` if it still cannot say.
 */
export async function recoverSponsored(
  context: NetworkContext, endpoint: SponsorEndpoint, key: string, journal: TransactionJournal, scope: string,
  options: { attempts?: number; waitMs?: number } = {},
): Promise<TransactionOutcome> {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Expected an operation hash');
  const found = await lookupLost(endpoint, key, options.attempts ?? 3, options.waitMs ?? 1_000);
  if (!found) throw new SponsorOutcomeUnknown(0, new Error('The sponsor could not say what it did with the operation'), key);
  const verified = verifiedSponsorRecord(context, endpoint.address, key, found.record, scope, 0);
  // When the envelope was sent is not known here, and the sponsor's word for it is not taken. The operation itself
  // gives a bound: its entries were signed at most the longest authorization window before they expire, and the
  // envelope cannot be older than they are.
  const envelope = (TransactionBuilder.fromXDR(verified.envelope, context.networkPassphrase)).toEnvelope();
  const [operation] = envelope.type === 'envelopeTypeTx' ? envelope.v1.tx.operations : [];
  const expiration = operation ? authExpiration(operation) : 0;
  const record = { ...verified, submitted_after_ledger: Math.max(0, expiration - MAX_AUTH_WINDOW_LEDGERS - 1) };
  await journal.put(record);
  const outcome = await settle(context, record);
  await journal.put(outcome.record);
  return outcome;
}

/**
 * Submit through a sponsor and journal the transaction locally under `scope`, so a pending or unknown outcome blocks
 * the next request in that scope until the hash settles on the ledger.
 *
 * The sponsor's report is not trusted. Its transaction is checked against the operation this client signed
 * (`verifiedSponsorRecord`), and the outcome is then read from the network by that hash: a sponsor cannot pass off
 * another transaction as this one, and its `rejected` or `expired` counts only once the network shows the envelope
 * can no longer be included. Until then this throws `SubmissionUnsettled`. A sponsor that does not answer leaves
 * the outcome unknown (`SponsorOutcomeUnknown`).
 */
export async function sponsoredInvoke(
  context: NetworkContext, endpoint: SponsorEndpoint, operation: xdr.Operation, journal: TransactionJournal,
  scope: string, options: { lookupAttempts?: number; lookupWaitMs?: number } = {},
): Promise<TransactionOutcome> {
  await settleScope(context, journal, scope);
  const before = await context.server.getLatestLedger();
  const key = operationHash(operation);
  let result: SponsorshipResult;
  try {
    result = await endpoint.sponsor(operation.toXdr('base64'));
  } catch (error) {
    // A refusal is an answer: nothing was submitted. Anything else may have been lost after submission.
    if (error instanceof SponsorRefused || error instanceof SimulationRejected) throw error;
    // The answer was lost, not necessarily the request. Ask the sponsor what it did with this operation.
    const found = await lookupLost(endpoint, key, options.lookupAttempts ?? 3, options.lookupWaitMs ?? 1_000);
    if (!found) throw new SponsorOutcomeUnknown(authExpiration(operation), error, key);
    result = found;
  }
  let record: TransactionRecord;
  try {
    record = verifiedSponsorRecord(context, endpoint.address, operation, result?.record, scope, before.sequence);
  } catch (error) {
    throw new SponsorOutcomeUnknown(authExpiration(operation), error, key);
  }
  await journal.put(record);
  const outcome = await settle(context, record);
  await journal.put(outcome.record);
  if (!isSettled(outcome.status)) throw new SubmissionUnsettled(outcome.record);
  return outcome;
}

/** HTTP client for the submitter service. */
export function httpSponsor(
  baseUrl: string, address: string, options: { token?: string; fetch?: typeof fetch } = {},
): SponsorEndpoint {
  const url = new URL(baseUrl);
  const request = options.fetch ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  async function call(path: string, init: RequestInit) {
    const response = await request(new URL(path, url), { ...init, headers });
    const body = await response.json() as SponsorshipResult & { error?: string; detail?: string; kind?: string };
    if (response.status === 422 && body.kind === 'simulation') throw new SimulationRejected(body.detail ?? body.error ?? '');
    // Only a client error is a refusal. A server error can follow a submission, so it is not "nothing was sent".
    if (response.status >= 400 && response.status < 500) {
      throw new SponsorRefused(body.error ?? `Submitter answered HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(body.error ?? `Submitter answered HTTP ${response.status}`);
    return body;
  }
  return {
    address,
    sponsor: (operation) => call('v1/transactions', { method: 'POST', body: JSON.stringify({ operation }) }),
    status: (hash) => {
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Expected a transaction hash');
      return call(`v1/transactions/${hash}`, { method: 'GET' });
    },
    async lookup(key) {
      if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Expected an operation hash');
      // Read apart from `call`: a submitter without this route answers 404, and that must not be taken to mean
      // "nothing was submitted". Only an answer that says so in its body counts.
      const response = await request(new URL(`v1/operations/${key}`, url), { method: 'GET', headers });
      const body = await response.json().catch(() => undefined) as SponsorLookup | undefined;
      const status = (body as { status?: unknown } | undefined)?.status;
      if (!response.ok || typeof status !== 'string') throw new Error(`Submitter cannot look up operations (HTTP ${response.status})`);
      return body!;
    },
  };
}
