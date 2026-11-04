import { Networks, StrKey } from '@stellar/stellar-sdk';
import type { ActionRequest, AuditEntry, Policy } from '../../packages/sdk/src/types.js';

export const bytes = (value: number) => new Uint8Array(32).fill(value);
export const account = (value: number) => StrKey.encodeEd25519PublicKey(bytes(value));
export const contract = (value: number) => StrKey.encodeContract(bytes(value));
export const passphrase = Networks.STANDALONE;
export const wallet = contract(11);

export const policy: Policy = {
  schema_version: 1,
  policy_id: bytes(12),
  agent_id: 5n,
  revision: 2n,
  signer: account(13),
  provider: account(14),
  required_checks: ['SignerHistory', 'Metadata', 'Endpoint'],
  max_assessment_age: 120n,
  max_risk_score: 25,
  assets: [
    { asset: contract(16), per_transaction: 70n, per_day: 100n },
    { asset: contract(15), per_transaction: 9_007_199_254_740_993n, per_day: (1n << 127n) - 1n },
  ],
  allowed_recipients: [contract(19), account(18), account(17)],
  blocked_recipients: [contract(21), account(20)],
  valid_after: 1_700_000_000n,
  valid_until: 1_700_000_600n,
  action_kinds: ['Transfer', 'ServicePayment'],
  service: { contract: contract(22), service_id: bytes(23) },
};

export const action: ActionRequest = {
  schema_version: 1,
  wallet,
  policy_hash: bytes(24),
  sequence: (1n << 64n) - 1n,
  deadline: 1_700_000_100n,
  action: {
    kind: 'Transfer',
    transfer: { asset: contract(15), recipient: account(17), amount: 9_007_199_254_740_993n },
  },
};

export const audit: AuditEntry = {
  schema_version: 1,
  wallet,
  sequence: 3n,
  previous_hash: bytes(25),
  ledger: 42,
  timestamp: 1_700_000_011n,
  actor: policy.signer,
  outcome: {
    kind: 'Executed',
    policy_hash: action.policy_hash,
    action_hash: bytes(26),
    action: action.action,
  },
};
