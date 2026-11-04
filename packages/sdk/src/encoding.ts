import { Address, StrKey, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  ACTION_KINDS, ASSESSMENT_MODES, CHECK_KINDS, CHECK_OUTCOMES, MAX_ASSETS, MAX_METADATA_URI_BYTES, MAX_RECIPIENTS,
  SCHEMA_VERSION, SERIOUS_WALLET_RISK_MASK,
  type Action, type ActionRequest, type AgentIdentity, type AuditEntry, type AuditOutcome, type CheckResult,
  type Hash32, type Policy, type ProviderRecord, type RegistryArgs, type RegistryMethod, type ServiceRule,
  type Transfer, type VerificationArgs, type VerificationMethod, type VerificationResult,
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

const IDENTITY_FIELDS = [
  'agent_id', 'controller', 'disabled', 'metadata_hash', 'metadata_uri', 'revision', 'signer',
] as const;

function decodeU64(value: xdr.ScVal) {
  if (value.type !== 'scvU64') throw new Error('Expected a u64');
  return value.u64;
}

function decodeAddress(value: xdr.ScVal) {
  if (value.type !== 'scvAddress'
    || (value.address.type !== 'scAddressTypeAccount' && value.address.type !== 'scAddressTypeContract')) {
    throw new Error('Expected a standard account or contract address');
  }
  return Address.fromScAddress(value.address).toString();
}

/** Strict inverse of `encodeIdentity`: exact canonical fields and types only. */
export function decodeIdentity(value: xdr.ScVal): AgentIdentity {
  const entries = value.type === 'scvMap' ? value.map ?? [] : [];
  if (entries.length !== IDENTITY_FIELDS.length) throw new Error('Expected an AgentIdentity map');
  entries.forEach(({ key }, i) => {
    if (key.type !== 'scvSymbol' || key.sym.toString() !== IDENTITY_FIELDS[i]) {
      throw new Error('Unexpected AgentIdentity field');
    }
  });
  const field = (name: (typeof IDENTITY_FIELDS)[number]) => entries[IDENTITY_FIELDS.indexOf(name)]!.val;
  const disabled = field('disabled');
  const uri = field('metadata_uri');
  const metadataHash = field('metadata_hash');
  if (disabled.type !== 'scvBool' || uri.type !== 'scvString'
    || metadataHash.type !== 'scvBytes' || metadataHash.bytes.value.length !== 32) {
    throw new Error('Unexpected AgentIdentity field type');
  }
  const identity: AgentIdentity = {
    agent_id: decodeU64(field('agent_id')), controller: decodeAddress(field('controller')),
    signer: decodeAddress(field('signer')), metadata_uri: uri.str.toStringStrict(),
    metadata_hash: Uint8Array.from(metadataHash.bytes.value), revision: decodeU64(field('revision')),
    disabled: disabled.value,
  };
  if (encodeIdentity(identity).toXdr('hex') !== value.toXdr('hex')) throw new Error('Non-canonical AgentIdentity');
  return identity;
}

function metadataUri(value: string) {
  if (typeof value !== 'string') throw new Error('Expected a metadata URI string');
  return xdr.ScVal.scvString(value);
}

const REGISTRY_ENCODERS: { [M in RegistryMethod]: (args: RegistryArgs[M]) => xdr.ScVal[] } = {
  register: (a) => [address(a.controller), address(a.signer), metadataUri(a.metadata_uri), bytes32(a.metadata_hash)],
  update_metadata: (a) => [
    u64(a.agent_id), u64(a.expected_revision), metadataUri(a.metadata_uri), bytes32(a.metadata_hash),
  ],
  rotate_signer: (a) => [u64(a.agent_id), u64(a.expected_revision), address(a.new_signer)],
  disable: (a) => [u64(a.agent_id), u64(a.expected_revision)],
  reactivate: (a) => [u64(a.agent_id), u64(a.expected_revision)],
  get: (a) => [u64(a.agent_id)],
  current: (a) => [u64(a.agent_id), u64(a.revision)],
  agent_count: () => [],
};

/** Structural agent-registry argument XDR. Semantic prechecks live in `registryOperation`. */
export function encodeRegistryArgs<M extends RegistryMethod>(method: M, args: RegistryArgs[M]): xdr.ScVal[] {
  if (!Object.hasOwn(REGISTRY_ENCODERS, method)) throw new Error('Unknown agent registry method');
  return REGISTRY_ENCODERS[method](args);
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
    mode: variant(result.mode, ASSESSMENT_MODES),
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

/** Exact canonical map fields in order, or throw naming `type`. */
function fields<const F extends readonly string[]>(value: xdr.ScVal, names: F, type: string) {
  const entries = value.type === 'scvMap' ? value.map ?? [] : [];
  if (entries.length !== names.length) throw new Error(`Expected a ${type} map`);
  entries.forEach(({ key }, i) => {
    if (key.type !== 'scvSymbol' || key.sym.toString() !== names[i]) throw new Error(`Unexpected ${type} field`);
  });
  return (name: F[number]) => entries[names.indexOf(name)]!.val;
}

function decodeU32(value: xdr.ScVal) {
  if (value.type !== 'scvU32') throw new Error('Expected a u32');
  return value.u32;
}

function decodeBool(value: xdr.ScVal) {
  if (value.type !== 'scvBool') throw new Error('Expected a bool');
  return value.b;
}

function decodeBytes32(value: xdr.ScVal) {
  if (value.type !== 'scvBytes' || value.bytes.value.length !== 32) throw new Error('Expected 32 bytes');
  return Uint8Array.from(value.bytes.value);
}

function decodeVariant<T extends string>(value: xdr.ScVal, tags: readonly T[]): T {
  const items = value.type === 'scvVec' ? value.vec ?? [] : [];
  const [item] = items;
  const tag = items.length === 1 && item?.type === 'scvSymbol' ? item.sym.toString() : undefined;
  if (tag === undefined || !(tags as readonly string[]).includes(tag)) throw new Error('Unknown ABI variant');
  return tag as T;
}

function decodeScore(value: xdr.ScVal) {
  return value.type === 'scvVoid' ? null : decodeU32(value);
}

const CHECK_FIELDS = ['kind', 'outcome', 'score'] as const;
const VERIFICATION_FIELDS = [
  'agent_id', 'checks', 'evidence_hash', 'expires_at', 'issued_at', 'mode', 'provider', 'revision', 'revoked',
  'risk_score', 'schema_version', 'sequence', 'serious_wallet_risks',
] as const;

function decodeCheck(value: xdr.ScVal): CheckResult {
  const field = fields(value, CHECK_FIELDS, 'CheckResult');
  return {
    kind: decodeVariant(field('kind'), CHECK_KINDS),
    outcome: decodeVariant(field('outcome'), CHECK_OUTCOMES),
    score: decodeScore(field('score')),
  };
}

/** Strict inverse of `encodeVerification`: exact canonical fields and types only. */
export function decodeVerification(value: xdr.ScVal): VerificationResult {
  const field = fields(value, VERIFICATION_FIELDS, 'VerificationResult');
  const checks = field('checks');
  if (checks.type !== 'scvVec') throw new Error('Expected a check list');
  const result: VerificationResult = {
    schema_version: decodeU32(field('schema_version')),
    agent_id: decodeU64(field('agent_id')),
    revision: decodeU64(field('revision')),
    provider: decodeAddress(field('provider')),
    sequence: decodeU64(field('sequence')),
    mode: decodeVariant(field('mode'), ASSESSMENT_MODES),
    checks: (checks.vec ?? []).map(decodeCheck),
    risk_score: decodeScore(field('risk_score')),
    serious_wallet_risks: decodeU32(field('serious_wallet_risks')),
    evidence_hash: decodeBytes32(field('evidence_hash')),
    issued_at: decodeU64(field('issued_at')),
    expires_at: decodeU64(field('expires_at')),
    revoked: decodeBool(field('revoked')),
  };
  if (encodeVerification(result).toXdr('hex') !== value.toXdr('hex')) {
    throw new Error('Non-canonical VerificationResult');
  }
  return result;
}

export function encodeProviderRecord(provider: ProviderRecord): xdr.ScVal {
  return record({ mode: variant(provider.mode, ASSESSMENT_MODES), approved: bool(provider.approved) });
}

/** Strict inverse of `encodeProviderRecord`. */
export function decodeProviderRecord(value: xdr.ScVal): ProviderRecord {
  const field = fields(value, ['approved', 'mode'] as const, 'ProviderRecord');
  return { mode: decodeVariant(field('mode'), ASSESSMENT_MODES), approved: decodeBool(field('approved')) };
}

const VERIFICATION_ENCODERS: { [M in VerificationMethod]: (args: VerificationArgs[M]) => xdr.ScVal[] } = {
  approve_provider: (a) => [address(a.provider), variant(a.mode, ASSESSMENT_MODES)],
  disable_provider: (a) => [address(a.provider)],
  publish: (a) => [encodeVerification(a.result)],
  revoke: (a) => [u64(a.agent_id), u64(a.revision), address(a.provider), u64(a.sequence)],
  provider: (a) => [address(a.provider)],
  latest: (a) => [u64(a.agent_id), u64(a.revision), address(a.provider)],
  current: (a) => [u64(a.agent_id), u64(a.revision), address(a.provider)],
  check: (a) => [
    u64(a.agent_id), u64(a.revision), address(a.provider),
    vec(a.required_checks.map((kind) => variant(kind, CHECK_KINDS))), u64(a.max_age), u32(a.max_risk_score),
  ],
  admin: () => [],
  agent_registry: () => [],
};

/** Structural verification-registry argument XDR. Semantic prechecks live in `verificationOperation`. */
export function encodeVerificationArgs<M extends VerificationMethod>(
  method: M, args: VerificationArgs[M],
): xdr.ScVal[] {
  if (!Object.hasOwn(VERIFICATION_ENCODERS, method)) throw new Error('Unknown verification registry method');
  return VERIFICATION_ENCODERS[method](args);
}

/** Constructor arguments `(admin, agent_registry)` for deploying the verification registry. */
export function encodeVerificationConstructorArgs(admin: string, agentRegistry: string): xdr.ScVal[] {
  if (!StrKey.isValidContract(agentRegistry)) throw new Error('Expected an agent registry contract address');
  return [address(admin), address(agentRegistry)];
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
