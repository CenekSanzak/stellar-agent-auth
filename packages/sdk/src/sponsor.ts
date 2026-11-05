import { Account, Address, StrKey, xdr } from '@stellar/stellar-sdk';
import { signingAddress } from './credentials.js';
import type { Signer } from './signers.js';
import {
  SimulationRejected, SubmissionUnsettled, assemble, authWindow, authorizeEntries, buildTransaction, isSettled,
  loadSource, pipelineLimits, settle, settleScope, simulate, submit, withAuth,
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

/** Anything that sponsors a signed operation: the in-process `Sponsor`, or `httpSponsor` for the submitter. */
export interface SponsorEndpoint {
  readonly address: string;
  sponsor(operationXdr: string): Promise<SponsorshipResult>;
  status(hash: string): Promise<SponsorshipResult>;
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

  /** Validate, enforce and submit one signed operation. Simulation failures throw `SimulationRejected`. */
  async sponsor(operationXdr: string): Promise<SponsorshipResult> {
    inspectSponsoredOperation(operationXdr, this.address, this.policy);
    const run = this.tail.then(() => this.run(operationXdr));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async run(operationXdr: string): Promise<SponsorshipResult> {
    const { limits } = this.policy;
    await settleScope(this.context, this.journal, this.scope);
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
    authWindow(recording.latestLedger, limits), false);
  return withAuth(invocation.operation, auth);
}

/**
 * Submit through a sponsor and journal the result locally under `scope`, so a pending or unknown outcome blocks the
 * next request in that scope until the hash settles on the ledger.
 */
export async function sponsoredInvoke(
  context: NetworkContext, endpoint: SponsorEndpoint, operation: xdr.Operation, journal: TransactionJournal,
  scope: string,
): Promise<TransactionOutcome> {
  await settleScope(context, journal, scope);
  const result = await endpoint.sponsor(operation.toXdr('base64'));
  const record = { ...result.record, scope };
  await journal.put(record);
  if (!isSettled(result.status)) throw new SubmissionUnsettled(record);
  // Read the confirmed result directly from the network rather than trusting the sponsor's report.
  const outcome = await settle(context, { ...record, status: 'pending' });
  await journal.put(outcome.record);
  if (outcome.status !== result.status && !(result.status === 'expired' || result.status === 'rejected')) {
    throw new Error(`Sponsor reported ${result.status} but the network reports ${outcome.status}`);
  }
  return outcome.status === 'pending' ? { ...outcome, status: result.status, record } : outcome;
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
    if (!response.ok) throw new SponsorRefused(body.error ?? `Submitter answered HTTP ${response.status}`);
    return body;
  }
  return {
    address,
    sponsor: (operation) => call('v1/transactions', { method: 'POST', body: JSON.stringify({ operation }) }),
    status: (hash) => {
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Expected a transaction hash');
      return call(`v1/transactions/${hash}`, { method: 'GET' });
    },
  };
}
