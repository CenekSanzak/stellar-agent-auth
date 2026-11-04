import { Address, Contract, StrKey, type authorizeEntry, type xdr } from '@stellar/stellar-sdk';
import { signInvocation, simulateRead, type ContractRead } from './contract-call.js';
import { decodeProviderRecord, decodeVerification, encodeVerificationArgs } from './encoding.js';
import {
  CHECK_KINDS, MAX_CHECKS, MAX_RISK_SCORE, SCHEMA_VERSION, SERIOUS_WALLET_RISK_MASK, VERIFICATION_AUTH_METHODS,
  type CheckResult, type ContractErrorName, type ProviderRecord, type VerificationArgs,
  type VerificationAuthMethod, type VerificationMethod, type VerificationRequirement, type VerificationResult,
} from './types.js';

/**
 * Verification registry client. The rules here mirror `shared_types::attestation` in the same order and with the
 * same error codes, so a result the SDK accepts is one the contract accepts at the same ledger time. Enforcement is
 * in the contract; these checks only fail earlier.
 */

/** A verification registry contract error, or an SDK precheck for input the contract rejects with that error. */
export class VerificationRegistryError extends Error {
  override readonly name = 'VerificationRegistryError';
  readonly code: ContractErrorName;
  constructor(code: ContractErrorName, message: string) {
    super(message);
    this.code = code;
  }
}

const fail = (code: ContractErrorName, message: string): never => {
  throw new VerificationRegistryError(code, message);
};

const ASSESSED = new Set(['Passed', 'Failed']);
const kindIndex = (kind: string) => (CHECK_KINDS as readonly string[]).indexOf(kind);

/** The integer ceiling of the mean of scored checks, or `null` when none is scored. Unscored never means zero. */
export function riskScoreOf(checks: readonly CheckResult[]): number | null {
  const scores = checks.flatMap(({ score }) => (score === null ? [] : [Math.min(score, MAX_RISK_SCORE)]));
  if (!scores.length) return null;
  return Math.ceil(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

export type ResultDraft = Omit<VerificationResult, 'schema_version' | 'checks' | 'risk_score' | 'revoked'> & {
  checks: readonly CheckResult[];
};

/** A v1 result with checks in canonical kind order and the aggregate computed by `riskScoreOf`. */
export function buildResult(draft: ResultDraft): VerificationResult {
  const checks = [...draft.checks].sort((a, b) => kindIndex(a.kind) - kindIndex(b.kind));
  return { ...draft, schema_version: SCHEMA_VERSION, checks, risk_score: riskScoreOf(checks), revoked: false };
}

/**
 * Mirrors `VerificationResult::validate_publication`. Without `now`, only the time-independent rules run and the
 * issue and expiry checks against the ledger are left to the contract.
 */
export function validatePublication(result: VerificationResult, now?: bigint): void {
  if (result.schema_version !== SCHEMA_VERSION) fail('UnsupportedVersion', 'Unsupported schema version');
  if (result.checks.length > MAX_CHECKS) fail('LimitExceeded', `At most ${MAX_CHECKS} checks are allowed`);
  if ((result.serious_wallet_risks & ~SERIOUS_WALLET_RISK_MASK) !== 0 || result.serious_wallet_risks < 0
    || (result.risk_score !== null && result.risk_score > MAX_RISK_SCORE)) {
    fail('InvalidInput', 'Unknown serious wallet risk flag or risk score above 100');
  }
  const seen = new Set<string>();
  for (const check of result.checks) {
    if (seen.has(check.kind)) fail('Duplicate', `Duplicate ${check.kind} check`);
    seen.add(check.kind);
    if (check.score !== null && check.score > MAX_RISK_SCORE) fail('InvalidInput', 'Check score above 100');
  }
  if (!result.checks.length) fail('InvalidInput', 'A result must report at least one check');
  result.checks.forEach((check, i) => {
    if (i > 0 && kindIndex(result.checks[i - 1]!.kind) >= kindIndex(check.kind)) {
      fail('InvalidInput', 'Checks must be in ascending kind order');
    }
    if (check.score !== null && !ASSESSED.has(check.outcome)) {
      fail('InvalidInput', `A ${check.outcome} check cannot carry a score`);
    }
  });
  if (result.risk_score !== riskScoreOf(result.checks)) {
    fail('InvalidInput', 'Risk score must be the ceiling of the mean of scored checks');
  }
  if (result.revoked) fail('InvalidInput', 'A new result cannot be revoked');
  if (result.expires_at <= result.issued_at) fail('InvalidInput', 'Expiry must follow the issue time');
  if (now === undefined) return;
  if (result.issued_at > now) fail('InvalidInput', 'Issue time is in the future');
  if (result.expires_at <= now) fail('Expired', 'Result has already expired');
}

/** Mirrors `validate_requirement`: one to eight distinct checks, a positive age and a threshold of at most 100. */
export function validateRequirement(requirement: VerificationRequirement): void {
  const { required_checks, max_age, max_risk_score } = requirement;
  if (required_checks.length > MAX_CHECKS) fail('LimitExceeded', `At most ${MAX_CHECKS} required checks`);
  if (new Set(required_checks).size !== required_checks.length) fail('Duplicate', 'Duplicate required check');
  if (!required_checks.length || max_age <= 0n || !Number.isInteger(max_risk_score) || max_risk_score < 0
    || max_risk_score > MAX_RISK_SCORE) {
    fail('InvalidInput', 'A requirement needs a required check, a positive age and a threshold of 0-100');
  }
}

/**
 * Mirrors `VerificationResult::evaluate` for off-chain display; the wallet and `check` decide on chain. Throws the
 * code the contract would return at ledger time `now`.
 */
export function evaluateResult(result: VerificationResult, now: bigint, requirement: VerificationRequirement): void {
  validateRequirement(requirement);
  if (result.revoked) fail('Revoked', 'Result is revoked');
  if (now >= result.expires_at) fail('Expired', 'Result has expired');
  if (now < result.issued_at) fail('InvalidInput', 'Result is issued in the future');
  if (now - result.issued_at > requirement.max_age) fail('Expired', 'Result is older than the maximum age');
  if (result.serious_wallet_risks !== 0) fail('VerificationDenied', 'A serious wallet risk is flagged');
  for (const kind of requirement.required_checks) {
    if (!result.checks.some((check) => check.kind === kind && check.outcome === 'Passed')) {
      fail('VerificationDenied', `Required check ${kind} did not pass`);
    }
  }
  if (result.risk_score === null || result.risk_score > requirement.max_risk_score) {
    fail('VerificationDenied', 'Risk score is absent or above the threshold');
  }
}

function address(value: string, label: string) {
  if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
    fail('InvalidInput', `${label} must be a standard account or contract address`);
  }
}

type VerificationCall = { [M in VerificationMethod]: { method: M; args: VerificationArgs[M] } }[VerificationMethod];

/** Build `registry.method(args)` after the stateless checks the contract also enforces. */
export function verificationOperation<M extends VerificationMethod>(
  contractId: string, method: M, args: VerificationArgs[M],
): xdr.Operation {
  if (!StrKey.isValidContract(contractId)) throw new Error('Expected a verification registry contract address');
  const call = { method, args } as VerificationCall;
  switch (call.method) {
    case 'approve_provider':
    case 'disable_provider':
    case 'provider':
      address(call.args.provider, 'Provider');
      break;
    case 'publish':
      address(call.args.result.provider, 'Provider');
      validatePublication(call.args.result);
      break;
    case 'check':
      validateRequirement(call.args);
      break;
  }
  return new Contract(contractId).call(method, ...encodeVerificationArgs(method, args));
}

interface VerificationAuthorization<M extends VerificationAuthMethod> {
  entry: xdr.SorobanAuthorizationEntry;
  contractId: string;
  method: M;
  args: VerificationArgs[M];
  address: string;
  networkPassphrase: string;
  latestLedger: number;
  expirationLedger: number;
  signer: Parameters<typeof authorizeEntry>[1];
}

/**
 * Inspect a recording-mode entry before giving an admin or provider key any bytes. A provider signs `publish` only
 * as the result's own provider.
 */
export async function signVerificationAuthorization<M extends VerificationAuthMethod>(
  input: VerificationAuthorization<M>,
): Promise<xdr.SorobanAuthorizationEntry> {
  const call = { method: input.method, args: input.args } as VerificationCall;
  if ((call.method === 'publish' && call.args.result.provider !== input.address)
    || (call.method === 'revoke' && call.args.provider !== input.address)) {
    throw new Error('Only the named provider may authorize its own results');
  }
  return signInvocation({
    ...input, methods: VERIFICATION_AUTH_METHODS,
    expectedArgs: () => encodeVerificationArgs(input.method, input.args), label: 'verification registry',
  });
}

export type VerificationRead = ContractRead;

function read<M extends VerificationMethod>(target: VerificationRead, method: M, args: VerificationArgs[M]) {
  return simulateRead(target, verificationOperation(target.contractId, method, args), `Verification registry ${method}`,
    (code) => new VerificationRegistryError(code, `Verification registry ${method} failed: ${code}`));
}

type ResultKey = VerificationArgs['current'];

function matching(result: VerificationResult, key: ResultKey) {
  if (result.agent_id !== key.agent_id || result.revision !== key.revision || result.provider !== key.provider) {
    throw new Error('Verification registry returned a different result');
  }
  return result;
}

/** A provider's approval record; `NotFound` if it was never approved. */
export async function readProvider(target: VerificationRead, provider: string): Promise<ProviderRecord> {
  return decodeProviderRecord(await read(target, 'provider', { provider }));
}

/** The latest result in any state, including revoked or expired, for display only. */
export async function readLatestResult(target: VerificationRead, key: ResultKey): Promise<VerificationResult> {
  return matching(decodeVerification(await read(target, 'latest', key)), key);
}

/**
 * The latest result only while usable: `VerificationDenied` or `Revoked` for an unapproved or disabled provider,
 * `NotFound`, `IdentityChanged` or `Revoked` from the agent registry, then `NotFound`, `Revoked` or `Expired`.
 */
export async function readCurrentResult(target: VerificationRead, key: ResultKey): Promise<VerificationResult> {
  const result = matching(decodeVerification(await read(target, 'current', key)), key);
  if (result.revoked) throw new Error('Verification registry returned a revoked result as current');
  return result;
}

/** `current` plus the requirement, evaluated on chain at the simulated ledger time. */
export async function checkVerification(
  target: VerificationRead, key: ResultKey, requirement: VerificationRequirement,
): Promise<VerificationResult> {
  const result = matching(decodeVerification(await read(target, 'check', { ...key, ...requirement })), key);
  if (result.revoked) throw new Error('Verification registry returned a revoked result as current');
  return result;
}

/** The next sequence to publish for `key`: one past the latest, or 1 when none exists. */
export async function nextResultSequence(target: VerificationRead, key: ResultKey): Promise<bigint> {
  try {
    return (await readLatestResult(target, key)).sequence + 1n;
  } catch (error) {
    if (error instanceof VerificationRegistryError && error.code === 'NotFound') return 1n;
    throw error;
  }
}

async function readAddress(target: VerificationRead, method: 'admin' | 'agent_registry') {
  const value = await read(target, method, {});
  if (value.type !== 'scvAddress') throw new Error('Expected an address');
  return Address.fromScAddress(value.address).toString();
}

export const readVerificationAdmin = (target: VerificationRead) => readAddress(target, 'admin');
export const readBoundAgentRegistry = (target: VerificationRead) => readAddress(target, 'agent_registry');
