import { Address, StrKey } from '@stellar/stellar-sdk';
import {
  ACTION_KINDS, MAX_ASSETS, MAX_CHECKS, MAX_RECIPIENTS, MAX_RISK_SCORE, SCHEMA_VERSION, SECONDS_PER_DAY,
  type ActionRequest, type AssetLimit, type ContractErrorName, type Hash32, type Policy, type PolicyState,
} from './types.js';

/**
 * Wallet policy rules. These mirror `Policy::canonicalize` and the smart wallet's approval and execution checks in
 * the same order and with the same error codes, so the SDK can explain a rejection before simulating. The contract
 * enforces every rule against live state; these checks only fail earlier.
 */

/** A smart wallet contract error, or an SDK precheck for input the wallet rejects with that error. */
export class WalletError extends Error {
  override readonly name = 'WalletError';
  readonly code: ContractErrorName;
  constructor(code: ContractErrorName, message: string) {
    super(message);
    this.code = code;
  }
}

const fail = (code: ContractErrorName, message: string): never => {
  throw new WalletError(code, message);
};

const I128_MAX = (1n << 127n) - 1n;

/** The UTC day number of a Unix timestamp; daily budgets reset when it changes. */
export function utcDay(timestamp: bigint): bigint {
  return timestamp / SECONDS_PER_DAY;
}

/** The ordering key the contract uses for addresses: accounts before contracts, then raw key bytes. */
function addressKey(value: string) {
  return Address.fromString(value).toScVal().toXdr('hex');
}

function sortedUnique<T>(items: readonly T[], key: (item: T) => string, label: string): T[] {
  const keyed = items.map((item) => ({ item, key: key(item) }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (keyed.some(({ key: value }, i) => i > 0 && value === keyed[i - 1]!.key)) fail('Duplicate', `Duplicate ${label}`);
  return keyed.map(({ item }) => item);
}

/**
 * Mirrors `Policy::canonicalize`: the v1 shape, collection caps, required fields and caps, then sorted sets without
 * duplicates. Returns the canonical policy the wallet stores and hashes.
 */
export function canonicalPolicy(policy: Policy): Policy {
  if (policy.schema_version !== SCHEMA_VERSION) fail('UnsupportedVersion', 'Unsupported policy schema version');
  if (policy.assets.length > MAX_ASSETS || policy.allowed_recipients.length > MAX_RECIPIENTS
    || policy.blocked_recipients.length > MAX_RECIPIENTS || policy.required_checks.length > MAX_CHECKS
    || policy.action_kinds.length > ACTION_KINDS.length) {
    fail('LimitExceeded', 'Policy exceeds the v1 collection limits');
  }
  if (policy.valid_after >= policy.valid_until || policy.max_assessment_age <= 0n
    || !Number.isInteger(policy.max_risk_score) || policy.max_risk_score < 0 || policy.max_risk_score > MAX_RISK_SCORE
    || !policy.required_checks.length || !policy.assets.length || !policy.action_kinds.length
    || policy.action_kinds.includes('ServicePayment') !== (policy.service !== null)) {
    fail('InvalidInput', 'Policy needs a validity window, a verification requirement, assets and action kinds');
  }
  for (const limit of policy.assets) {
    if (limit.per_transaction <= 0n || limit.per_transaction > limit.per_day || limit.per_day > I128_MAX) {
      fail('InvalidInput', 'Each asset needs a positive per-transfer cap no greater than its daily cap');
    }
  }
  return {
    ...policy,
    assets: sortedUnique(policy.assets, (limit) => addressKey(limit.asset), 'asset'),
    allowed_recipients: sortedUnique(policy.allowed_recipients, addressKey, 'allowed recipient'),
    blocked_recipients: sortedUnique(policy.blocked_recipients, addressKey, 'blocked recipient'),
    required_checks: sortedUnique(policy.required_checks, (kind) => kind, 'required check'),
    action_kinds: sortedUnique(policy.action_kinds, (kind) => kind, 'action kind'),
  };
}

export interface PolicyContext {
  wallet: string;
  owner: string;
  /** Ledger time; when given, a policy whose window has already ended fails with `Expired`. */
  now?: bigint;
}

/**
 * Mirrors the wallet's approval checks that need no ledger reads: `canonicalPolicy`, then the v1 wallet rules
 * (transfers only, a standard-account signer other than the owner, contract assets, never the wallet as a
 * recipient), then an unexpired window. The contract additionally rejects a reused policy ID, a full active set and
 * an identity whose live revision or signer differs.
 */
export function validatePolicy(policy: Policy, context: PolicyContext): Policy {
  const canonical = canonicalPolicy(policy);
  if (canonical.action_kinds.length !== 1 || canonical.action_kinds[0] !== 'Transfer' || canonical.service !== null) {
    fail('InvalidInput', 'The v1 wallet executes plain transfers only');
  }
  if (!StrKey.isValidEd25519PublicKey(canonical.signer) || canonical.signer === context.owner) {
    fail('InvalidInput', 'The agent signer must be a standard account other than the owner');
  }
  if (canonical.assets.some(({ asset }) => !StrKey.isValidContract(asset))) {
    fail('InvalidInput', 'Every asset must be an asset contract address');
  }
  if ([...canonical.allowed_recipients, ...canonical.blocked_recipients].includes(context.wallet)) {
    fail('InvalidInput', 'The wallet cannot be its own recipient');
  }
  if (context.now !== undefined && context.now >= canonical.valid_until) fail('Expired', 'Policy window has ended');
  return canonical;
}

/** The state as of ledger time `now`: after a UTC day change, nothing has been spent today. */
export function stateAsOf(state: PolicyState, now: bigint): PolicyState {
  const today = utcDay(now);
  return state.utc_day === today ? state : { ...state, utc_day: today, daily_spend: [] };
}

export interface RequestContext {
  wallet: string;
  /** Hash of `policy` as the wallet stores it; requests must name it. */
  policyHash: Hash32;
  paused: boolean;
  now: bigint;
}

const sameHash = (a: Hash32, b: Hash32) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Mirrors the wallet's `execute` checks that need no other contract, in order, throwing the code the wallet would
 * return at ledger time `now`. The wallet then also requires the live identity, the policy signer and a passing
 * verification result, and the asset contract must accept the transfer.
 */
export function evaluateRequest(
  policy: Policy, state: PolicyState, request: ActionRequest, context: RequestContext,
): void {
  if (!sameHash(request.policy_hash, context.policyHash) || !sameHash(state.policy_hash, context.policyHash)) {
    fail('NotFound', 'Request names a different policy');
  }
  if (request.schema_version !== SCHEMA_VERSION) fail('UnsupportedVersion', 'Unsupported request schema version');
  const transfer = request.action.kind === 'Transfer' ? request.action.transfer : request.action.payment;
  if (transfer.amount <= 0n) fail('InvalidInput', 'Amount must be positive');
  if (request.wallet !== context.wallet) fail('PolicyDenied', 'Request names a different wallet');
  if (context.paused) fail('Paused', 'Wallet is paused');
  const current = stateAsOf(state, context.now);
  if (current.revoked) fail('Revoked', 'Policy is revoked');
  if (request.sequence !== current.next_sequence) {
    fail('InvalidSequence', `Expected sequence ${current.next_sequence}`);
  }
  if (context.now >= request.deadline || context.now >= policy.valid_until) fail('Expired', 'Request or policy expired');
  if (context.now < policy.valid_after) fail('PolicyDenied', 'Policy is not yet valid');
  if (!policy.action_kinds.includes(request.action.kind) || request.action.kind !== 'Transfer') {
    fail('PolicyDenied', `Policy does not permit ${request.action.kind}`);
  }
  const limit = policy.assets.find(({ asset }) => asset === transfer.asset);
  if (!limit) fail('PolicyDenied', 'Asset is not approved by the policy');
  if (policy.blocked_recipients.includes(transfer.recipient) || !policy.allowed_recipients.includes(transfer.recipient)) {
    fail('PolicyDenied', 'Recipient is not approved by the policy');
  }
  const { per_transaction, per_day } = limit as AssetLimit;
  if (transfer.amount > per_transaction) fail('LimitExceeded', `Amount exceeds the per-transfer cap ${per_transaction}`);
  const spent = current.daily_spend.find(({ asset }) => asset === transfer.asset)?.amount ?? 0n;
  if (spent + transfer.amount > I128_MAX) fail('ArithmeticOverflow', 'Daily spend overflows');
  if (spent + transfer.amount > per_day) fail('LimitExceeded', `Amount exceeds today's remaining ${per_day - spent}`);
}

export interface Exposure {
  asset: string;
  /** Sum of the daily caps of every active policy naming the asset. */
  daily_cap: bigint;
  /** Spent today across those policies. */
  spent_today: bigint;
  /** What the agents could still move today if every policy were used to its cap. */
  remaining_today: bigint;
  /** The largest single transfer any policy allows. */
  largest_transfer: bigint;
  policies: number;
}

/**
 * The owner's combined daily exposure per asset across active policies at ledger time `now`. Budgets are per policy
 * and additive: a replacement policy starts a fresh budget, so the day it is approved the agent may spend up to both
 * caps. Revoked policies contribute nothing.
 */
export function policyExposure(entries: readonly { policy: Policy; state: PolicyState }[], now: bigint): Exposure[] {
  const rows = new Map<string, Exposure>();
  for (const { policy, state } of entries) {
    const current = stateAsOf(state, now);
    if (current.revoked || now >= policy.valid_until) continue;
    for (const limit of policy.assets) {
      const spent = current.daily_spend.find(({ asset }) => asset === limit.asset)?.amount ?? 0n;
      const row = rows.get(limit.asset) ?? {
        asset: limit.asset, daily_cap: 0n, spent_today: 0n, remaining_today: 0n, largest_transfer: 0n, policies: 0,
      };
      row.daily_cap += limit.per_day;
      row.spent_today += spent;
      row.remaining_today += limit.per_day > spent ? limit.per_day - spent : 0n;
      row.largest_transfer = limit.per_transaction > row.largest_transfer ? limit.per_transaction : row.largest_transfer;
      row.policies += 1;
      rows.set(limit.asset, row);
    }
  }
  return [...rows.values()].sort((a, b) => (addressKey(a.asset) < addressKey(b.asset) ? -1 : 1));
}

export interface TransferDraft {
  wallet: string;
  policyHash: Hash32;
  sequence: bigint;
  /** Exclusive Unix-seconds deadline. */
  deadline: bigint;
  asset: string;
  recipient: string;
  amount: bigint;
}

/** A v1 transfer request for the agent to sign. */
export function transferRequest(draft: TransferDraft): ActionRequest {
  return {
    schema_version: SCHEMA_VERSION,
    wallet: draft.wallet,
    policy_hash: draft.policyHash,
    sequence: draft.sequence,
    deadline: draft.deadline,
    action: { kind: 'Transfer', transfer: { asset: draft.asset, recipient: draft.recipient, amount: draft.amount } },
  };
}
