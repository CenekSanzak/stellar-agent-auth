import { hash } from '@stellar/stellar-sdk';
import { buildResult, type ResultDraft } from '../../packages/sdk/src/verification.js';
import type { CheckResult, VerificationResult } from '../../packages/sdk/src/types.js';

/**
 * Public verification fixtures. Every result here is SIMULATED test data for `Fixture` providers; none is a real
 * assessment of any agent, and none may be published under a live provider.
 */

export const FIXTURE_LABEL = 'SIMULATED fixture - not a real assessment';

/** The coverage of the project's limited live verifier, all implemented checks passing. */
export const limitedChecks = (): CheckResult[] => [
  { kind: 'Code', outcome: 'Unsupported', score: null },
  { kind: 'Endpoint', outcome: 'Passed', score: 0 },
  { kind: 'Media', outcome: 'Unsupported', score: null },
  { kind: 'Metadata', outcome: 'Passed', score: 0 },
  { kind: 'SignerAccount', outcome: 'Passed', score: 0 },
  { kind: 'SignerHistory', outcome: 'Inconclusive', score: null },
  { kind: 'ThreatFeed', outcome: 'Unsupported', score: null },
  { kind: 'Token', outcome: 'Unsupported', score: null },
];

const withCheck = (kind: CheckResult['kind'], outcome: CheckResult['outcome'], score: number | null) =>
  limitedChecks().map((check) => (check.kind === kind ? { kind, outcome, score } : check));

/** Deterministic fixture scenarios; `evidence` is a hash of the scenario label, not of a report. */
export const FIXTURE_SCENARIOS = {
  passing: { checks: limitedChecks(), serious_wallet_risks: 0 },
  'failed-endpoint': { checks: withCheck('Endpoint', 'Failed', 100), serious_wallet_risks: 0 },
  'high-risk': {
    checks: limitedChecks().map((check) => (check.score === 0 ? { ...check, outcome: 'Failed' as const, score: 100 } : check)),
    serious_wallet_risks: 0,
  },
  'serious-wallet-risk': { checks: limitedChecks(), serious_wallet_risks: 1 },
} as const;

export type FixtureScenario = keyof typeof FIXTURE_SCENARIOS;

export function fixtureResult(
  scenario: FixtureScenario,
  draft: Omit<ResultDraft, 'mode' | 'checks' | 'serious_wallet_risks' | 'evidence_hash'>,
): VerificationResult {
  const { checks, serious_wallet_risks } = FIXTURE_SCENARIOS[scenario];
  return buildResult({
    ...draft, mode: 'Fixture', checks, serious_wallet_risks,
    evidence_hash: Uint8Array.from(hash(new TextEncoder().encode(`${FIXTURE_LABEL}: ${scenario}`))),
  });
}
