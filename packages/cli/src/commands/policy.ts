import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { scValToNative, type xdr } from '@stellar/stellar-sdk';
import {
  CHECK_KINDS, SCHEMA_VERSION, policyExposure, policyHash, readActivePolicies, readAgent, readPolicy,
  readPolicyState, readWalletOwner, readWalletRegistries, validatePolicy,
  type CheckKind, type Hash32, type Policy,
} from '@stellar-agent-auth/sdk';
import type { Command } from '../index.js';
import { UsageError, address, contractAddress, hex32, integer, required, type Runtime } from '../runtime.js';
import { ownerCall, walletId } from './wallet.js';

/**
 * Policies. A policy file is JSON with amounts in asset units, converted exactly with each asset's decimals:
 *
 * {
 *   "agent_id": "1",                       // revision and signer default to the live identity
 *   "provider": "G...",
 *   "required_checks": ["Metadata", "SignerAccount"],
 *   "max_assessment_age_seconds": 86400,
 *   "max_risk_score": 10,
 *   "assets": [{ "asset": "C...", "per_transfer": "5", "per_day": "20" }],
 *   "allowed_recipients": ["G..."],
 *   "blocked_recipients": [],
 *   "valid_for_seconds": 604800            // or "valid_after" / "valid_until" in Unix seconds
 * }
 *
 * An optional "policy_id" (64 hex characters) names the policy; otherwise a random one is generated. IDs are
 * reserved forever by the wallet, even after revocation.
 */

interface PolicyFile {
  policy_id?: string;
  agent_id: string | number;
  revision?: string | number;
  signer?: string;
  provider: string;
  required_checks: string[];
  max_assessment_age_seconds: string | number;
  max_risk_score: number;
  assets: { asset: string; per_transfer: string; per_day: string }[];
  allowed_recipients?: string[];
  blocked_recipients?: string[];
  valid_after?: string | number;
  valid_until?: string | number;
  valid_for_seconds?: string | number;
}

const ALLOWED = new Set([
  'policy_id', 'agent_id', 'revision', 'signer', 'provider', 'required_checks', 'max_assessment_age_seconds',
  'max_risk_score', 'assets', 'allowed_recipients', 'blocked_recipients', 'valid_after', 'valid_until',
  'valid_for_seconds',
]);

const text = (value: string | number | undefined) => (value === undefined ? undefined : String(value));

/** Read a policy file and resolve it against the live identity, the asset decimals and the ledger time. */
export async function loadPolicy(runtime: Runtime, path: string, wallet: string): Promise<Policy> {
  let file: PolicyFile;
  try {
    file = JSON.parse(await readFile(path, 'utf8')) as PolicyFile;
  } catch (error) {
    throw new UsageError(`Cannot read policy file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const unknown = Object.keys(file).filter((key) => !ALLOWED.has(key));
  if (unknown.length) throw new UsageError(`Unknown policy field(s): ${unknown.join(', ')}`);
  if (!Array.isArray(file.assets) || !Array.isArray(file.required_checks)) {
    throw new UsageError('Policy needs "assets" and "required_checks" lists');
  }
  const read = runtime.read(wallet);
  const { agent_registry: agentRegistry } = await readWalletRegistries(read);
  const identity = await readAgent(runtime.read(agentRegistry), integer(text(file.agent_id), 'agent_id'));
  const checks = file.required_checks.map((kind) => {
    if (!(CHECK_KINDS as readonly string[]).includes(kind)) throw new UsageError(`Unknown check kind ${kind}`);
    return kind as CheckKind;
  });
  const now = BigInt((await runtime.server.getLatestLedger()).closeTime);
  const validAfter = file.valid_after === undefined ? now - 60n : integer(text(file.valid_after), 'valid_after');
  const validUntil = file.valid_until !== undefined ? integer(text(file.valid_until), 'valid_until')
    : validAfter + integer(text(file.valid_for_seconds ?? 7 * 86_400), 'valid_for_seconds');
  const assets = [];
  for (const limit of file.assets) {
    const asset = contractAddress(limit.asset, 'assets[].asset');
    assets.push({
      asset, per_transaction: await runtime.units(asset, limit.per_transfer, 'assets[].per_transfer'),
      per_day: await runtime.units(asset, limit.per_day, 'assets[].per_day'),
    });
  }
  const policy: Policy = {
    schema_version: SCHEMA_VERSION,
    policy_id: file.policy_id === undefined ? Uint8Array.from(randomBytes(32)) : hex32(file.policy_id, 'policy_id'),
    agent_id: identity.agent_id,
    revision: file.revision === undefined ? identity.revision : integer(text(file.revision), 'revision'),
    signer: file.signer ?? identity.signer,
    provider: address(file.provider, 'provider'),
    required_checks: checks,
    max_assessment_age: integer(text(file.max_assessment_age_seconds), 'max_assessment_age_seconds'),
    max_risk_score: Number(file.max_risk_score),
    assets,
    allowed_recipients: (file.allowed_recipients ?? []).map((value) => address(value, 'allowed_recipients[]')),
    blocked_recipients: (file.blocked_recipients ?? []).map((value) => address(value, 'blocked_recipients[]')),
    valid_after: validAfter,
    valid_until: validUntil,
    action_kinds: ['Transfer'],
    service: null,
  };
  return validatePolicy(policy, { wallet, owner: await readWalletOwner(read), now });
}

const hashResult = (value: xdr.ScVal) => ({ policy_hash: Uint8Array.from(scValToNative(value) as Uint8Array) });

async function describe(runtime: Runtime, wallet: string, policyHashValue: Hash32) {
  const read = runtime.read(wallet);
  const policy = await readPolicy(read, policyHashValue);
  const state = await readPolicyState(read, policyHashValue);
  return { policy_hash: policyHashValue, policy, state };
}

export const policyCommands: Record<string, Command> = {
  approve: {
    summary: 'Approve a policy: --owner <key> --file <policy.json>',
    options: { wallet: 'string', owner: 'string', file: 'string' },
    async run(runtime, values) {
      const wallet = walletId(runtime, values['wallet']);
      const policy = await loadPolicy(runtime, required(values['file'], 'file'), wallet);
      const expected = policyHash(runtime.config.passphrase, wallet, policy);
      const result = await ownerCall(runtime, wallet, 'approve_policy', { policy }, values['owner'], hashResult);
      return { ...result, policy_hash: expected, policy };
    },
  },
  show: {
    summary: 'Show one policy (--policy <hash>) or every active policy with the combined daily exposure',
    options: { wallet: 'string', policy: 'string' },
    async run(runtime, values) {
      const wallet = walletId(runtime, values['wallet']);
      if (values['policy'] !== undefined) return describe(runtime, wallet, hex32(values['policy'], 'policy'));
      const hashes = await readActivePolicies(runtime.read(wallet));
      const policies = [];
      for (const value of hashes) policies.push(await describe(runtime, wallet, value));
      const now = BigInt((await runtime.server.getLatestLedger()).closeTime);
      return { wallet, policies, exposure: policyExposure(policies, now) };
    },
  },
  revoke: {
    summary: 'Revoke a policy permanently: --owner <key> --policy <hash>',
    options: { wallet: 'string', owner: 'string', policy: 'string' },
    async run(runtime, values) {
      const wallet = walletId(runtime, values['wallet']);
      const policy_hash = hex32(values['policy'], 'policy');
      return { ...await ownerCall(runtime, wallet, 'revoke_policy', { policy_hash }, values['owner']), policy_hash };
    },
  },
  replace: {
    summary: 'Atomically revoke --policy <hash> and approve --file <policy.json>: --owner <key>',
    options: { wallet: 'string', owner: 'string', policy: 'string', file: 'string' },
    async run(runtime, values) {
      const wallet = walletId(runtime, values['wallet']);
      const old_policy_hash = hex32(values['policy'], 'policy');
      const policy = await loadPolicy(runtime, required(values['file'], 'file'), wallet);
      const result = await ownerCall(runtime, wallet, 'replace_policy', { old_policy_hash, policy }, values['owner'],
        hashResult);
      return { ...result, revoked: old_policy_hash, policy_hash: policyHash(runtime.config.passphrase, wallet, policy) };
    },
  },
};
