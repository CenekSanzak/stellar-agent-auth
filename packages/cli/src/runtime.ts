import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Keypair, StrKey, rpc, type xdr } from '@stellar/stellar-sdk';
import {
  AgentRegistryError, FeeCeilingExceeded, SimulationRejected, SponsorRefused, SubmissionUnsettled,
  VerificationRegistryError, WalletError, buildTransaction, explainContractError, fromContractUnits, httpSponsor,
  invoke, invokeSigned, loadConfig, loadSource, networkContext, pipelineLimits, prepare, readAssetDecimals,
  settleScope, signForSponsor, simulate, sponsoredInvoke, toContractUnits,
  type ContractRead, type Environment, type Invocation, type NetworkContext, type PipelineLimits, type Signer,
  type SponsorEndpoint, type TransactionOutcome,
} from '@stellar-agent-auth/sdk';
import { FileJournal, KeyReferenceError, loadKey, loadKeypair } from '@stellar-agent-auth/sdk/node';

/** Exit codes. Scripts can rely on these; anything not listed is 1. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  /** Refused before submission: nothing was signed by a fee payer or sent. */
  rejected: 3,
  /** Submitted and definitively not applied: failed on the ledger, rejected by the network or expired. */
  failed: 4,
  /** Submitted with an outcome not yet known. Do not retry; rerun the command later to settle it. */
  pending: 75,
} as const;

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** A command result that is not a success; carries the outcome so it is still printed. */
export class OutcomeError extends Error {
  override readonly name = 'OutcomeError';
  constructor(readonly exitCode: number, message: string, readonly result: Record<string, unknown>) {
    super(message);
  }
}

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface GlobalOptions {
  json: boolean;
  dryRun: boolean;
  network?: string | undefined;
  rpcUrl?: string | undefined;
  source?: string | undefined;
  sponsorUrl?: string | undefined;
  stateDir?: string | undefined;
  maxFee?: string | undefined;
}

/** Serialize results: bigints as decimal strings, bytes as hex. */
export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Uint8Array) return Buffer.from(item).toString('hex');
    return item;
  }, space);
}

export function hex32(value: string | undefined, label: string): Uint8Array {
  if (value === undefined || !/^[0-9a-f]{64}$/i.test(value)) throw new UsageError(`--${label} must be 64 hex characters`);
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

export function integer(value: string | undefined, label: string): bigint {
  if (value === undefined || !/^\d{1,20}$/.test(value)) throw new UsageError(`--${label} must be a non-negative integer`);
  const parsed = BigInt(value);
  if (parsed > (1n << 64n) - 1n) throw new UsageError(`--${label} is out of range`);
  return parsed;
}

export function required(value: string | undefined, label: string): string {
  if (value === undefined || value === '') throw new UsageError(`--${label} is required`);
  return value;
}

export function address(value: string | undefined, label: string): string {
  const text = required(value, label);
  if (!StrKey.isValidEd25519PublicKey(text) && !StrKey.isValidContract(text)) {
    throw new UsageError(`--${label} must be a G... account or C... contract address`);
  }
  return text;
}

export function contractAddress(value: string | undefined, label: string): string {
  const text = required(value, label);
  if (!StrKey.isValidContract(text)) throw new UsageError(`--${label} must be a C... contract address`);
  return text;
}

/** Shared state for one CLI invocation: configuration, network, keys, journal and submission. */
export class Runtime {
  readonly config: ReturnType<typeof loadConfig>;
  readonly server: rpc.Server;
  readonly limits: PipelineLimits;
  /** Code uploads and deployments cost far more than calls; their default ceiling is 10 XLM. */
  readonly deployLimits: PipelineLimits;
  readonly journal: FileJournal;
  readonly stateDirectory: string;
  private network?: Promise<NetworkContext>;
  private sponsorEndpoint?: Promise<SponsorEndpoint>;

  constructor(readonly env: Environment, readonly options: GlobalOptions) {
    this.config = loadConfig({
      ...env,
      ...(options.network ? { STELLAR_NETWORK: options.network, STELLAR_NETWORK_PASSPHRASE: undefined } : {}),
      ...(options.rpcUrl ? { STELLAR_RPC_URL: options.rpcUrl } : {}),
    });
    this.server = new rpc.Server(this.config.rpcUrl, { allowHttp: this.config.network === 'local', timeout: 30_000 });
    const maxFee = options.maxFee ?? env['STELLAR_AGENT_AUTH_MAX_FEE'];
    this.limits = pipelineLimits(maxFee ? { maxFee: integer(maxFee, 'max-fee') } : {});
    this.deployLimits = pipelineLimits({ maxFee: maxFee ? integer(maxFee, 'max-fee') : 100_000_000n });
    this.stateDirectory = resolve(options.stateDir ?? env['STELLAR_AGENT_AUTH_STATE_DIR'] ?? '.local/cli');
    this.journal = new FileJournal(resolve(this.stateDirectory, 'journal'));
  }

  context(): Promise<NetworkContext> {
    this.network ??= networkContext(this.server, this.config.passphrase);
    return this.network;
  }

  async key(reference: string | undefined, label: string): Promise<Signer> {
    try {
      return await loadKey(required(reference, label), this.env);
    } catch (error) {
      if (error instanceof KeyReferenceError) throw new UsageError(`--${label}: ${error.message}`);
      throw error;
    }
  }

  /** The raw key pair, for the verifier's own publication APIs. */
  async keypair(reference: string | undefined, label: string): Promise<Keypair> {
    try {
      return await loadKeypair(required(reference, label), this.env);
    } catch (error) {
      if (error instanceof KeyReferenceError) throw new UsageError(`--${label}: ${error.message}`);
      throw error;
    }
  }

  /** A configured contract: the flag, else the environment variable. */
  contract(flag: string | undefined, key: keyof ReturnType<typeof loadConfig>['contracts'], label: string): string {
    return contractAddress(flag ?? this.config.contracts[key], `${label} (or ${key})`);
  }

  /** Read-only simulation target; any well-formed account works as the simulated source. */
  read(contractId: string): ContractRead {
    return {
      server: this.server, contractId, source: this.env['STELLAR_READ_SOURCE'] ?? Keypair.random().publicKey(),
      networkPassphrase: this.config.passphrase,
    };
  }

  async decimals(asset: string): Promise<number> {
    const { server, source, networkPassphrase } = this.read(asset);
    return readAssetDecimals({ server, source, networkPassphrase }, asset);
  }

  async units(asset: string, amount: string | undefined, label: string): Promise<bigint> {
    try {
      return toContractUnits(required(amount, label), await this.decimals(asset));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(`--${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async format(asset: string, units: bigint): Promise<string> {
    return fromContractUnits(units, await this.decimals(asset));
  }

  /** The submitter configured by `--sponsor-url` or `SUBMITTER_URL`, if any. */
  sponsor(): Promise<SponsorEndpoint> | undefined {
    const url = this.options.sponsorUrl ?? this.env['SUBMITTER_URL'];
    if (!url) return undefined;
    this.sponsorEndpoint ??= (async () => {
      const response = await fetch(new URL('v1/health', url));
      const health = await response.json() as { sponsor?: string; network?: string };
      if (!response.ok || !health.sponsor || !StrKey.isValidEd25519PublicKey(health.sponsor)) {
        throw new Error(`Submitter at ${url} is not available`);
      }
      if (health.network !== this.config.network) throw new Error('Submitter is on a different network');
      const token = this.env['SUBMITTER_TOKEN'];
      return httpSponsor(url, health.sponsor, token ? { token } : {});
    })();
    return this.sponsorEndpoint;
  }

  /**
   * Run an invocation. With a sponsor, every entry is signed by its principal and the sponsor pays; otherwise
   * `payer` (the `--source` key, else the acting principal) is the transaction source and signs the envelope.
   * `--dry-run` stops after enforced simulation.
   */
  async run(
    invocation: Invocation, payer: Signer | undefined, scope: string, mode: 'any' | 'direct' = 'any',
    limits: PipelineLimits = this.limits,
  ): Promise<Submitted> {
    const context = await this.context();
    const sponsor = mode === 'any' ? this.sponsor() : undefined;
    if (sponsor) {
      const endpoint = await sponsor;
      const operation = await signForSponsor(context, endpoint.address, invocation, this.limits);
      if (this.options.dryRun) return this.dryRunSigned(operation, endpoint.address);
      return { outcome: await sponsoredInvoke(context, endpoint, operation, this.journal, scope) };
    }
    const source = this.options.source && mode === 'any' ? await this.key(this.options.source, 'source') : payer;
    if (!source) throw new UsageError('Set --sponsor-url or SUBMITTER_URL, or pass --source to pay fees');
    if (this.options.dryRun) {
      const prepared = await prepare(context, source.address, invocation, limits);
      return { dryRun: { fee: prepared.fee, source: source.address, return_value: prepared.simulation.result.retval } };
    }
    // The record is kept under the action's scope, and the source's earlier submissions must settle first too.
    await settleScope(context, this.journal, `source:${source.address}`);
    return { outcome: await invoke(context, source, invocation, this.journal, { limits, scope }) };
  }

  /** Submit an operation whose entries are already signed. */
  async runSigned(operation: xdr.Operation, scope: string): Promise<Submitted> {
    const context = await this.context();
    const sponsor = this.sponsor();
    if (sponsor) {
      const endpoint = await sponsor;
      if (this.options.dryRun) return this.dryRunSigned(operation, endpoint.address);
      return { outcome: await sponsoredInvoke(context, endpoint, operation, this.journal, scope) };
    }
    if (!this.options.source) throw new UsageError('Set --sponsor-url or SUBMITTER_URL, or pass --source to pay fees');
    const source = await this.key(this.options.source, 'source');
    if (this.options.dryRun) return this.dryRunSigned(operation, source.address);
    await settleScope(context, this.journal, `source:${source.address}`);
    return { outcome: await invokeSigned(context, source, operation, this.journal, scope, this.limits) };
  }

  private async dryRunSigned(operation: xdr.Operation, source: string): Promise<Submitted> {
    const context = await this.context();
    const tx = buildTransaction(context, await loadSource(context, source), operation, this.limits);
    const simulation = await simulate(context, tx, 'enforce');
    return { dryRun: { fee: BigInt(simulation.minResourceFee), source, return_value: simulation.result.retval } };
  }

  async ensureState() {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
  }
}

export interface Submitted {
  outcome?: TransactionOutcome;
  dryRun?: { fee: bigint; source: string; return_value: xdr.ScVal };
}

/** Turn a submission into the command result, or throw `OutcomeError` for anything but success. */
export function settled(submitted: Submitted, extra: (value: xdr.ScVal) => Record<string, unknown> = () => ({})) {
  if (submitted.dryRun) {
    return { status: 'simulated', fee_stroops: submitted.dryRun.fee, source: submitted.dryRun.source,
      ...extra(submitted.dryRun.return_value) };
  }
  const outcome = submitted.outcome!;
  const base = {
    status: outcome.status, transaction: outcome.hash, ledger: outcome.record.ledger ?? null,
    ...(outcome.response ? { fee_charged_stroops: outcome.response.resultXdr.feeCharged } : {}),
  };
  if (outcome.status === 'success') return { ...base, ...(outcome.returnValue ? extra(outcome.returnValue) : {}) };
  const reason = outcome.code ? explainContractError(outcome.code) : outcome.record.error ?? 'no reason reported';
  const result = { ...base, ...(outcome.code ? { error: outcome.code } : {}), reason };
  if (outcome.status === 'pending' || outcome.status === 'unknown') {
    throw new OutcomeError(EXIT.pending, `Transaction ${outcome.hash} is ${outcome.status}. Do not retry: rerun the `
      + 'same command later, or query the hash, to settle it.', result);
  }
  throw new OutcomeError(EXIT.failed, `Transaction ${outcome.hash} ${outcome.status}: ${reason}`, result);
}

/** Map any error to an exit code and a printable result. */
export function classify(error: unknown): { code: number; message: string; result: Record<string, unknown> } {
  if (error instanceof OutcomeError) return { code: error.exitCode, message: error.message, result: error.result };
  if (error instanceof UsageError) return { code: EXIT.usage, message: error.message, result: { status: 'usage' } };
  if (error instanceof SimulationRejected) {
    return {
      code: EXIT.rejected, message: error.message,
      result: { status: 'rejected', stage: 'simulation', error: error.code ?? error.auth ?? 'simulation', detail: error.message },
    };
  }
  if (error instanceof AgentRegistryError || error instanceof VerificationRegistryError || error instanceof WalletError) {
    return {
      code: EXIT.rejected, message: `${error.message}. ${explainContractError(error.code)}`,
      result: { status: 'rejected', stage: 'precheck', error: error.code },
    };
  }
  if (error instanceof FeeCeilingExceeded || error instanceof SponsorRefused) {
    return { code: EXIT.rejected, message: error.message, result: { status: 'rejected', stage: 'sponsor-or-fee' } };
  }
  if (error instanceof SubmissionUnsettled) {
    return {
      code: EXIT.pending, message: `${error.message}. Rerun later; nothing new was submitted.`,
      result: { status: 'unsettled', transaction: error.record.hash, record_status: error.record.status },
    };
  }
  return { code: EXIT.error, message: error instanceof Error ? error.message : String(error), result: { status: 'error' } };
}
