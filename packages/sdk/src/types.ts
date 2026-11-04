export const SCHEMA_VERSION = 1;
export const MAX_ASSETS = 4;
export const MAX_RECIPIENTS = 32;
export const MAX_METADATA_URI_BYTES = 2_048;
export const SERIOUS_WALLET_RISKS = {
  KnownCompromise: 1 << 0,
  ConfirmedMaliciousActivity: 1 << 1,
  ThreatFeedMatch: 1 << 2,
} as const;
export const SERIOUS_WALLET_RISK_MASK = Object.values(SERIOUS_WALLET_RISKS).reduce((mask, flag) => mask | flag, 0);

export const CHECK_KINDS = [
  'Code', 'Endpoint', 'Media', 'Metadata', 'SignerAccount', 'SignerHistory', 'ThreatFeed', 'Token',
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const CHECK_OUTCOMES = ['Passed', 'Failed', 'Inconclusive', 'NotApplicable', 'Unsupported'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export const ASSESSMENT_MODES = ['Live', 'Fixture'] as const;
export type AssessmentMode = (typeof ASSESSMENT_MODES)[number];
export const MAX_CHECKS = 8;
export const MAX_RISK_SCORE = 100;

export const ACTION_KINDS = ['ServicePayment', 'Transfer'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type Hash32 = Uint8Array;

export interface AgentIdentity {
  agent_id: bigint;
  controller: string;
  signer: string;
  metadata_uri: string;
  metadata_hash: Hash32;
  revision: bigint;
  disabled: boolean;
}

export interface CheckResult {
  kind: CheckKind;
  outcome: CheckOutcome;
  score: number | null;
}

export interface VerificationResult {
  schema_version: number;
  agent_id: bigint;
  revision: bigint;
  provider: string;
  sequence: bigint;
  mode: AssessmentMode;
  checks: readonly CheckResult[];
  risk_score: number | null;
  serious_wallet_risks: number;
  evidence_hash: Hash32;
  issued_at: bigint;
  expires_at: bigint;
  revoked: boolean;
}

/** A provider's approval; the mode is fixed for the provider address's lifetime and disabling is terminal. */
export interface ProviderRecord {
  mode: AssessmentMode;
  approved: boolean;
}

/** A consumer's verification requirement, as a wallet policy states it. */
export interface VerificationRequirement {
  required_checks: readonly CheckKind[];
  /** Maximum result age in seconds at the time of use. */
  max_age: bigint;
  max_risk_score: number;
}

export interface Transfer {
  asset: string;
  recipient: string;
  amount: bigint;
}

export interface ServiceRule {
  contract: string;
  service_id: Hash32;
}

export type Action =
  | { kind: 'Transfer'; transfer: Transfer }
  | { kind: 'ServicePayment'; service: ServiceRule; payment: Transfer };

export interface ActionRequest {
  schema_version: number;
  wallet: string;
  policy_hash: Hash32;
  sequence: bigint;
  deadline: bigint;
  action: Action;
}

export interface AssetLimit {
  asset: string;
  per_transaction: bigint;
  per_day: bigint;
}

export interface Policy {
  schema_version: number;
  policy_id: Hash32;
  agent_id: bigint;
  revision: bigint;
  signer: string;
  provider: string;
  required_checks: readonly CheckKind[];
  max_assessment_age: bigint;
  max_risk_score: number;
  assets: readonly AssetLimit[];
  allowed_recipients: readonly string[];
  blocked_recipients: readonly string[];
  valid_after: bigint;
  valid_until: bigint;
  action_kinds: readonly ActionKind[];
  service: ServiceRule | null;
}

export interface PolicyState {
  policy_hash: Hash32;
  revoked: boolean;
  next_sequence: bigint;
  utc_day: bigint;
  daily_spend: readonly { asset: string; amount: bigint }[];
}

export type AuditOutcome =
  | { kind: 'PolicyCreated' | 'PolicyRevoked'; policy_hash: Hash32 }
  | { kind: 'PauseChanged'; paused: boolean }
  | { kind: 'OwnerWithdrawal'; transfer: Transfer }
  | { kind: 'Executed'; policy_hash: Hash32; action_hash: Hash32; action: Action };

export interface AuditEntry {
  schema_version: number;
  wallet: string;
  sequence: bigint;
  previous_hash: Hash32;
  ledger: number;
  timestamp: bigint;
  actor: string;
  outcome: AuditOutcome;
}

/** Contract error names in `shared_types::errors::Error` code order, starting at 1. */
export const CONTRACT_ERRORS = [
  'UnsupportedVersion', 'InvalidInput', 'LimitExceeded', 'Duplicate', 'NotFound', 'InvalidSequence', 'Expired',
  'Revoked', 'IdentityChanged', 'VerificationDenied', 'PolicyDenied', 'Paused', 'ArithmeticOverflow',
] as const;
export type ContractErrorName = (typeof CONTRACT_ERRORS)[number];

export interface RegistryArgs {
  register: { controller: string; signer: string; metadata_uri: string; metadata_hash: Hash32 };
  update_metadata: { agent_id: bigint; expected_revision: bigint; metadata_uri: string; metadata_hash: Hash32 };
  rotate_signer: { agent_id: bigint; expected_revision: bigint; new_signer: string };
  disable: { agent_id: bigint; expected_revision: bigint };
  reactivate: { agent_id: bigint; expected_revision: bigint };
  get: { agent_id: bigint };
  current: { agent_id: bigint; revision: bigint };
  agent_count: Record<string, never>;
}
export type RegistryMethod = keyof RegistryArgs;

export const REGISTRY_AUTH_METHODS = ['register', 'update_metadata', 'rotate_signer', 'disable', 'reactivate'] as const;
export type RegistryAuthMethod = (typeof REGISTRY_AUTH_METHODS)[number];

type ResultKey = { agent_id: bigint; revision: bigint; provider: string };

export interface VerificationArgs {
  approve_provider: { provider: string; mode: AssessmentMode };
  disable_provider: { provider: string };
  publish: { result: VerificationResult };
  revoke: ResultKey & { sequence: bigint };
  provider: { provider: string };
  latest: ResultKey;
  current: ResultKey;
  check: ResultKey & VerificationRequirement;
  admin: Record<string, never>;
  agent_registry: Record<string, never>;
}
export type VerificationMethod = keyof VerificationArgs;

export const VERIFICATION_AUTH_METHODS = ['approve_provider', 'disable_provider', 'publish', 'revoke'] as const;
export type VerificationAuthMethod = (typeof VERIFICATION_AUTH_METHODS)[number];
