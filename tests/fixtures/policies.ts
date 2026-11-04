import type { Policy } from '../../packages/sdk/src/types.js';
import { account, bytes, contract } from './abi-v1.js';

/** Public example roles for wallet policy tests: deterministic addresses with no keys behind them. */
export const owner = account(40);
export const walletAddress = contract(41);
export const asset = contract(42);
export const otherAsset = contract(43);
export const recipient = account(44);
export const stranger = account(45);
export const signer = account(46);
export const provider = account(47);

/** The SOW example: 5 per transfer and 20 per UTC day of one asset to one recipient, for seven days. */
export function transferPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    schema_version: 1, policy_id: bytes(48), agent_id: 1n, revision: 1n, signer, provider,
    required_checks: ['Endpoint', 'Metadata', 'SignerAccount'], max_assessment_age: 86_400n, max_risk_score: 10,
    assets: [{ asset, per_transaction: 5n, per_day: 20n }],
    allowed_recipients: [recipient], blocked_recipients: [],
    valid_after: 1_800_000_000n, valid_until: 1_800_000_000n + 7n * 86_400n, action_kinds: ['Transfer'], service: null,
    ...overrides,
  };
}
