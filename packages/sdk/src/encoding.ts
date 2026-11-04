import { Address, StrKey, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  ACTION_KINDS, CHECK_KINDS, CHECK_OUTCOMES, MAX_ASSETS, MAX_METADATA_URI_BYTES, MAX_RECIPIENTS, SCHEMA_VERSION,
  SERIOUS_WALLET_RISK_MASK,
  type Action, type ActionRequest, type AgentIdentity, type AuditEntry, type AuditOutcome,
  type Hash32, type Policy, type ServiceRule, type Transfer, type VerificationResult,
} from './types.js';

const encoder = new TextEncoder();
const sym = xdr.ScVal.scvSymbol;
const vec = xdr.ScVal.scvVec;
const bool = xdr.ScVal.scvBool;

function address(value: string) {
  if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
    throw new Error('Expected a standard account or contract address');
  }
  return Address.fromString(value).toScVal();
}

function bytes32(value: Hash32) {
  if (value.length !== 32) throw new Error('Expected 32 bytes');
  return xdr.ScVal.scvBytes(value);
}

function u32(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error('Expected a u32');
  }
  return xdr.ScVal.scvU32(value);
}

function u64(value: bigint) {
  if (typeof value !== 'bigint' || value < 0n || value > (1n << 64n) - 1n) {
    throw new Error('Expected a u64 bigint');
  }
  return nativeToScVal(value, { type: 'u64' });
}

function positiveAmount(value: bigint) {
  if (typeof value !== 'bigint' || value <= 0n || value > (1n << 127n) - 1n) {
    throw new Error('Expected a positive i128 amount in contract units');
  }
  return nativeToScVal(value, { type: 'i128' });
}

function version(value: number) {
  if (value !== SCHEMA_VERSION) throw new Error('Unsupported schema version');
  return u32(value);
}

function riskScore(value: number) {
  if (value > 100) throw new Error('Risk score exceeds 100');
  return u32(value);
}

function compareAscii(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function record(fields: Record<string, xdr.ScVal>) {
  return xdr.ScVal.scvMap(Object.keys(fields).sort(compareAscii).map(
    (key) => new xdr.ScMapEntry({ key: sym(key), val: fields[key]! }),
  ));
}

function variant<T extends string>(value: T, tags: readonly T[]) {
  if (!tags.includes(value)) throw new Error('Unknown ABI variant');
  return vec([sym(value)]);
}

function sortedUnique<T>(items: readonly T[], key: (item: T) => string) {
  const keyed = items.map((item) => ({ item, key: key(item) }));
  keyed.sort((a, b) => compareAscii(a.key, b.key));
  if (keyed.some(({ key }, i) => i > 0 && key === keyed[i - 1]!.key)) {
    throw new Error('Duplicate set member');
  }
  return keyed.map(({ item }) => item);
}

function addressKey(value: string) {
  return address(value).toXdr('hex');
}

function serviceScVal(service: ServiceRule) {
  return record({ contract: address(service.contract), service_id: bytes32(service.service_id) });
}

function transferScVal(transfer: Transfer) {
  return record({
    asset: address(transfer.asset),
    recipient: address(transfer.recipient),
    amount: positiveAmount(transfer.amount),
  });
}

function actionScVal(action: Action): xdr.ScVal {
  switch (action.kind) {
    case 'Transfer':
      return vec([sym(action.kind), transferScVal(action.transfer)]);
    case 'ServicePayment':
      return vec([sym(action.kind), record({
        service: serviceScVal(action.service),
        payment: transferScVal(action.payment),
      })]);
    default:
      throw new Error('Unknown action kind');
  }
}

export function encodeIdentity(identity: AgentIdentity): xdr.ScVal {
  if (encoder.encode(identity.metadata_uri).length > MAX_METADATA_URI_BYTES) {
    throw new Error('Metadata URI exceeds the v1 limit');
  }
  return record({
    agent_id: u64(identity.agent_id), controller: address(identity.controller), signer: address(identity.signer),
    metadata_uri: xdr.ScVal.scvString(identity.metadata_uri), metadata_hash: bytes32(identity.metadata_hash),
    revision: u64(identity.revision), disabled: bool(identity.disabled),
  });
}

export function encodeVerification(result: VerificationResult): xdr.ScVal {
  if (result.checks.length > CHECK_KINDS.length) throw new Error('Too many checks');
  if (new Set(result.checks.map(({ kind }) => kind)).size !== result.checks.length) {
    throw new Error('Duplicate check kind');
  }
  if (result.serious_wallet_risks > SERIOUS_WALLET_RISK_MASK) throw new Error('Unknown serious wallet risk flag');
  return record({
    schema_version: version(result.schema_version),
    agent_id: u64(result.agent_id),
    revision: u64(result.revision),
    provider: address(result.provider),
    sequence: u64(result.sequence),
    mode: variant(result.mode, ['Live', 'Fixture']),
    checks: vec(result.checks.map((check) => record({
      kind: variant(check.kind, CHECK_KINDS),
      outcome: variant(check.outcome, CHECK_OUTCOMES),
      score: check.score === null ? xdr.ScVal.scvVoid() : riskScore(check.score),
    }))),
    risk_score: result.risk_score === null ? xdr.ScVal.scvVoid() : riskScore(result.risk_score),
    serious_wallet_risks: u32(result.serious_wallet_risks),
    evidence_hash: bytes32(result.evidence_hash),
    issued_at: u64(result.issued_at),
    expires_at: u64(result.expires_at),
    revoked: bool(result.revoked),
  });
}

export function encodePolicy(policy: Policy): xdr.ScVal {
  if (policy.assets.length > MAX_ASSETS
    || policy.allowed_recipients.length > MAX_RECIPIENTS
    || policy.blocked_recipients.length > MAX_RECIPIENTS
    || policy.required_checks.length > CHECK_KINDS.length
    || policy.action_kinds.length > ACTION_KINDS.length) {
    throw new Error('Policy exceeds v1 collection limits');
  }
  if (policy.valid_after >= policy.valid_until || policy.max_assessment_age <= 0n
    || !policy.required_checks.length || !policy.assets.length || !policy.action_kinds.length
    || policy.action_kinds.includes('ServicePayment') !== (policy.service !== null)) {
    throw new Error('Invalid policy');
  }
  const assets = sortedUnique(policy.assets, (limit) => addressKey(limit.asset));
  return record({
    schema_version: version(policy.schema_version),
    policy_id: bytes32(policy.policy_id),
    agent_id: u64(policy.agent_id),
    revision: u64(policy.revision),
    signer: address(policy.signer),
    provider: address(policy.provider),
    required_checks: vec(sortedUnique(policy.required_checks, (kind) => kind).map((kind) => variant(kind, CHECK_KINDS))),
    max_assessment_age: u64(policy.max_assessment_age),
    max_risk_score: riskScore(policy.max_risk_score),
    assets: vec(assets.map((limit) => {
      if (limit.per_transaction > limit.per_day) throw new Error('Daily cap is below the per-transaction cap');
      return record({
        asset: address(limit.asset),
        per_transaction: positiveAmount(limit.per_transaction),
        per_day: positiveAmount(limit.per_day),
      });
    })),
    allowed_recipients: vec(sortedUnique(policy.allowed_recipients, addressKey).map(address)),
    blocked_recipients: vec(sortedUnique(policy.blocked_recipients, addressKey).map(address)),
    valid_after: u64(policy.valid_after),
    valid_until: u64(policy.valid_until),
    action_kinds: vec(sortedUnique(policy.action_kinds, (kind) => kind).map((kind) => variant(kind, ACTION_KINDS))),
    service: policy.service === null
      ? vec([sym('Disabled')])
      : vec([sym('Restricted'), serviceScVal(policy.service)]),
  });
}

export function encodeAction(request: ActionRequest): xdr.ScVal {
  return record({
    schema_version: version(request.schema_version),
    wallet: address(request.wallet),
    policy_hash: bytes32(request.policy_hash),
    sequence: u64(request.sequence),
    deadline: u64(request.deadline),
    action: actionScVal(request.action),
  });
}

function auditOutcome(outcome: AuditOutcome): xdr.ScVal {
  switch (outcome.kind) {
    case 'PolicyCreated':
    case 'PolicyRevoked':
      return vec([sym(outcome.kind), bytes32(outcome.policy_hash)]);
    case 'PauseChanged':
      return vec([sym(outcome.kind), bool(outcome.paused)]);
    case 'OwnerWithdrawal':
      return vec([sym(outcome.kind), transferScVal(outcome.transfer)]);
    case 'Executed':
      return vec([sym(outcome.kind), record({
        policy_hash: bytes32(outcome.policy_hash),
        action_hash: bytes32(outcome.action_hash),
        action: actionScVal(outcome.action),
      })]);
    default:
      throw new Error('Unknown audit outcome');
  }
}

export function encodeAudit(entry: AuditEntry): xdr.ScVal {
  return record({
    schema_version: version(entry.schema_version),
    wallet: address(entry.wallet),
    sequence: u64(entry.sequence),
    previous_hash: bytes32(entry.previous_hash),
    ledger: u32(entry.ledger),
    timestamp: u64(entry.timestamp),
    actor: address(entry.actor),
    outcome: auditOutcome(entry.outcome),
  });
}

function digest(purpose: string, passphrase: string, wallet: string, value: xdr.ScVal): Hash32 {
  return hash(vec([
    sym('stellar_agent_auth'), u32(SCHEMA_VERSION), sym(purpose),
    bytes32(hash(encoder.encode(passphrase))), address(wallet), value,
  ]).toXdr());
}

export function policyHash(passphrase: string, wallet: string, policy: Policy): Hash32 {
  return digest('policy', passphrase, wallet, encodePolicy(policy));
}

export function actionHash(passphrase: string, request: ActionRequest): Hash32 {
  return digest('action', passphrase, request.wallet, encodeAction(request));
}

export function auditHash(passphrase: string, entry: AuditEntry): Hash32 {
  return digest('audit', passphrase, entry.wallet, encodeAudit(entry));
}
