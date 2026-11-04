import type { AgentIdentity, CheckKind, CheckOutcome } from '@stellar-agent-auth/sdk';
import { resolveMetadata, type AgentMetadataV1, type MetadataResolution } from './metadata.js';
import {
  ENDPOINT_LIMITS, FetchRejected, safeFetch, type FetchRejection, type Resolver, type Transport,
} from './net.js';

/**
 * The verifier's limited check adapters. Each implemented check scores 0 when it passes and 100 when it fails, so
 * the aggregate is the share of failed scored checks, rounded up. Inconclusive, not-applicable and unsupported
 * checks are unscored and never count as passes. These checks establish metadata integrity, endpoint TLS and
 * reachability and the signer account's state; they are not vulnerability scans or threat assessments.
 */

export const PASS_SCORE = 0;
export const FAIL_SCORE = 100;
/** A signer account younger than about one day of ledgers has too little history to assess. */
export const MIN_SIGNER_AGE_LEDGERS = 17_280;
const ACCEPTED_TLS = new Set(['TLSv1.2', 'TLSv1.3']);

export interface CheckFinding {
  kind: CheckKind;
  outcome: CheckOutcome;
  score: number | null;
  /** One sentence for the report reader. */
  summary: string;
  /** Machine-readable detail; public data only. */
  evidence: Record<string, unknown>;
}

const passed = (kind: CheckKind, summary: string, evidence: Record<string, unknown> = {}): CheckFinding =>
  ({ kind, outcome: 'Passed', score: PASS_SCORE, summary, evidence });
const failed = (kind: CheckKind, summary: string, evidence: Record<string, unknown> = {}): CheckFinding =>
  ({ kind, outcome: 'Failed', score: FAIL_SCORE, summary, evidence });
const unscored = (
  kind: CheckKind, outcome: 'Inconclusive' | 'NotApplicable' | 'Unsupported', summary: string,
  evidence: Record<string, unknown> = {},
): CheckFinding => ({ kind, outcome, score: null, summary, evidence });

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Rejections that say something about the registered location itself rather than a transient condition. */
const DEFINITIVE: ReadonlySet<FetchRejection> = new Set(['url', 'private-address', 'tls', 'redirect', 'too-large']);

export function metadataFinding(resolution: MetadataResolution, registeredHash: Uint8Array): CheckFinding {
  const registered = hex(registeredHash);
  switch (resolution.status) {
    case 'verified':
      return passed('Metadata', 'Registered metadata matches its hash and the v1 schema.', {
        sha256: hex(resolution.sha256), bytes: resolution.bytes, final_url: resolution.finalUrl,
      });
    case 'hash-mismatch':
      return failed('Metadata', 'Metadata served at the registered URI does not match the registered hash.', {
        registered_sha256: registered, served_sha256: hex(resolution.sha256), bytes: resolution.bytes,
        final_url: resolution.finalUrl,
      });
    case 'invalid':
      return failed('Metadata', 'Metadata matches its hash but is not a valid v1 document.', {
        sha256: hex(resolution.sha256), error: resolution.error, path: resolution.path,
      });
    case 'unavailable':
      return DEFINITIVE.has(resolution.reason)
        ? failed('Metadata', 'The registered metadata URI cannot be fetched safely.', {
          reason: resolution.reason, detail: resolution.detail,
        })
        : unscored('Metadata', 'Inconclusive', 'The registered metadata could not be retrieved.', {
          reason: resolution.reason, detail: resolution.detail,
        });
  }
}

export interface NetworkOptions {
  resolver?: Resolver | undefined;
  transport?: Transport | undefined;
}

async function probeEndpoint(url: string, options: NetworkOptions) {
  try {
    const response = await safeFetch(url, {
      method: 'HEAD', limits: ENDPOINT_LIMITS, resolver: options.resolver, transport: options.transport,
    });
    const tls = response.tls.protocol;
    const ok = response.status >= 100 && response.status < 500 && response.tls.authorized
      && tls !== null && ACCEPTED_TLS.has(tls);
    return { url, ok, status: response.status, tls, final_url: response.url.href };
  } catch (error) {
    if (!(error instanceof FetchRejected)) throw error;
    return { url, ok: false, reason: error.reason, detail: error.message };
  }
}

/**
 * Every declared endpoint must answer over verified TLS 1.2+ with a status below 500. Without verified metadata
 * the declared endpoints are unknown, so the check is inconclusive.
 */
export async function endpointFinding(
  document: AgentMetadataV1 | undefined, options: NetworkOptions = {},
): Promise<CheckFinding> {
  if (!document) return unscored('Endpoint', 'Inconclusive', 'Endpoints are unknown without verified metadata.');
  if (!document.endpoints.length) {
    return unscored('Endpoint', 'NotApplicable', 'The metadata declares no endpoints.');
  }
  const probes = [];
  for (const endpoint of document.endpoints) probes.push(await probeEndpoint(endpoint.url, options));
  return probes.every(({ ok }) => ok)
    ? passed('Endpoint', 'Every declared endpoint answers over verified TLS.', { endpoints: probes })
    : failed('Endpoint', 'A declared endpoint is unreachable, refused or lacks verified TLS 1.2+.', {
      endpoints: probes,
    });
}

/** The on-ledger state of the agent's signing account, or `null` when it does not exist. */
export interface AccountSnapshot {
  /** Master key, low, medium and high threshold weights. */
  thresholds: { master: number; low: number; medium: number; high: number };
  /** Additional signers besides the master key. */
  extraSigners: number;
  sequence: bigint;
}

/**
 * The registered signer must exist and its key alone must meet the medium threshold that Soroban account
 * authorization requires, so the registered key really controls the agent's authorizations.
 */
export function signerAccountFinding(signer: string, account: AccountSnapshot | null): CheckFinding {
  if (!account) return failed('SignerAccount', 'The registered signer account does not exist on the ledger.', { signer });
  const { master, medium } = account.thresholds;
  const evidence = { signer, thresholds: account.thresholds, extra_signers: account.extraSigners };
  if (master === 0 || master < medium) {
    return failed('SignerAccount', 'The registered signer key cannot authorize alone at the medium threshold.', evidence);
  }
  return passed('SignerAccount', 'The registered signer account exists and its key can authorize.', evidence);
}

/**
 * Account age from its sequence number: a new account starts at `creation_ledger << 32`, and sequence numbers only
 * increase, so the estimate can make an account look younger but never older.
 */
export function signerHistoryFinding(account: AccountSnapshot | null, latestLedger: number): CheckFinding {
  if (!account) return unscored('SignerHistory', 'Inconclusive', 'No signer account history exists.');
  const created = Number(account.sequence >> 32n);
  const age = Math.max(0, latestLedger - created);
  const evidence = { estimated_creation_ledger: created, age_ledgers: age, minimum_ledgers: MIN_SIGNER_AGE_LEDGERS };
  return age >= MIN_SIGNER_AGE_LEDGERS
    ? passed('SignerHistory', 'The signer account has an established ledger history.', evidence)
    : unscored('SignerHistory', 'Inconclusive', 'The signer account is too new to assess its history.', evidence);
}

/** ERC-8126 check families this verifier does not implement. They are reported, never passed. */
export const UNSUPPORTED_CHECKS = {
  Code: 'No code analysis adapter is implemented.',
  Media: 'No media analysis adapter is implemented.',
  ThreatFeed: 'No threat-intelligence feed is integrated; serious wallet-risk flags are never set.',
  Token: 'No token analysis adapter is implemented.',
} as const satisfies Partial<Record<CheckKind, string>>;

export interface CheckContext extends NetworkOptions {
  identity: AgentIdentity;
  account: AccountSnapshot | null;
  latestLedger: number;
}

/** Runs every adapter once and reports all eight check kinds. */
export async function runChecks(context: CheckContext): Promise<CheckFinding[]> {
  const { identity } = context;
  const resolution = await resolveMetadata(identity, context);
  const document = resolution.status === 'verified' ? resolution.document : undefined;
  return [
    metadataFinding(resolution, identity.metadata_hash),
    await endpointFinding(document, context),
    signerAccountFinding(identity.signer, context.account),
    signerHistoryFinding(context.account, context.latestLedger),
    ...Object.entries(UNSUPPORTED_CHECKS).map(([kind, summary]) =>
      unscored(kind as keyof typeof UNSUPPORTED_CHECKS, 'Unsupported', summary)),
  ];
}
