import { readFileSync } from 'node:fs';
import { contract, type xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  decodeAuditHead, decodeHashList, decodeIdentity, decodePolicy, decodePolicyState, decodeProviderRecord,
  decodeVerification, encodeRegistryArgs, encodeVerificationArgs, encodeVerificationConstructorArgs,
  encodeWalletArgs, encodeWalletConstructorArgs,
} from '../../packages/sdk/src/encoding.js';
import { canonicalPolicy } from '../../packages/sdk/src/policies.js';
import {
  CONTRACT_ERRORS, type ActionRequest, type AgentIdentity, type Policy, type RegistryArgs, type VerificationArgs,
  type VerificationResult, type WalletArgs,
} from '../../packages/sdk/src/types.js';
import { account, action, bytes, contract as contractId, policy } from '../fixtures/abi-v1.js';

/**
 * The SDK's hand-written, strict encoders checked against the interface each built contract publishes in its WASM.
 * The Stellar SDK's spec-driven encoder (what generated bindings use) must produce byte-identical arguments for every
 * entry point, and spec-encoded return values must pass the SDK's strict decoders. A contract interface change that
 * the SDK does not follow fails here. Requires `npm run build:contracts`.
 */

const spec = (name: string) => contract.Spec.fromWasm(readFileSync(new URL(
  `../../target/wasm32v1-none/release/stellar_agent_auth_${name}.wasm`, import.meta.url)));

/** Spec-native forms: unions are `{ tag, values }`, fixed bytes are buffers. */
const unit = (tag: string) => ({ tag, values: undefined });
const tuple = (tag: string, ...values: unknown[]) => ({ tag, values });
const buf = (value: Uint8Array) => Buffer.from(value);

function nativeTransfer(transfer: { asset: string; recipient: string; amount: bigint }) {
  return { asset: transfer.asset, recipient: transfer.recipient, amount: transfer.amount };
}

function nativeAction(request: ActionRequest) {
  if (request.action.kind !== 'Transfer') throw new Error('Fixture uses a transfer');
  return {
    schema_version: request.schema_version, wallet: request.wallet, policy_hash: buf(request.policy_hash),
    sequence: request.sequence, deadline: request.deadline,
    action: tuple('Transfer', nativeTransfer(request.action.transfer)),
  };
}

function nativePolicy(value: Policy) {
  return {
    schema_version: value.schema_version, policy_id: buf(value.policy_id), agent_id: value.agent_id,
    revision: value.revision, signer: value.signer, provider: value.provider,
    required_checks: value.required_checks.map(unit), max_assessment_age: value.max_assessment_age,
    max_risk_score: value.max_risk_score,
    assets: value.assets.map(({ asset, per_transaction, per_day }) => ({ asset, per_transaction, per_day })),
    allowed_recipients: [...value.allowed_recipients], blocked_recipients: [...value.blocked_recipients],
    valid_after: value.valid_after, valid_until: value.valid_until, action_kinds: value.action_kinds.map(unit),
    service: value.service === null ? unit('Disabled')
      : tuple('Restricted', { contract: value.service.contract, service_id: buf(value.service.service_id) }),
  };
}

const result: VerificationResult = {
  schema_version: 1, agent_id: 7n, revision: 2n, provider: account(3), sequence: 4n, mode: 'Live',
  checks: [
    { kind: 'Endpoint', outcome: 'Passed', score: 0 }, { kind: 'Metadata', outcome: 'Failed', score: 100 },
    { kind: 'SignerHistory', outcome: 'Inconclusive', score: null },
  ],
  risk_score: 50, serious_wallet_risks: 0, evidence_hash: bytes(5), issued_at: 1_700_000_000n,
  expires_at: 1_700_086_400n, revoked: false,
};

function nativeResult(value: VerificationResult) {
  return {
    ...value, mode: unit(value.mode), evidence_hash: buf(value.evidence_hash),
    checks: value.checks.map((check) => ({ kind: unit(check.kind), outcome: unit(check.outcome), score: check.score ?? undefined })),
    risk_score: value.risk_score ?? undefined,
  };
}

const identity: AgentIdentity = {
  agent_id: 7n, controller: account(1), signer: account(2), metadata_uri: 'https://agent.example.test/a.json',
  metadata_hash: bytes(9), revision: 3n, disabled: false,
};

type Case<A> = { [M in keyof A]: { sdk: A[M]; native: Record<string, unknown> } };

const registryCases: Case<RegistryArgs> = {
  register: {
    sdk: { controller: account(1), signer: account(2), metadata_uri: identity.metadata_uri, metadata_hash: bytes(9) },
    native: { controller: account(1), signer: account(2), metadata_uri: identity.metadata_uri, metadata_hash: buf(bytes(9)) },
  },
  update_metadata: {
    sdk: { agent_id: 7n, expected_revision: 3n, metadata_uri: identity.metadata_uri, metadata_hash: bytes(8) },
    native: { agent_id: 7n, expected_revision: 3n, metadata_uri: identity.metadata_uri, metadata_hash: buf(bytes(8)) },
  },
  rotate_signer: {
    sdk: { agent_id: 7n, expected_revision: 3n, new_signer: account(4) },
    native: { agent_id: 7n, expected_revision: 3n, new_signer: account(4) },
  },
  disable: { sdk: { agent_id: 7n, expected_revision: 3n }, native: { agent_id: 7n, expected_revision: 3n } },
  reactivate: { sdk: { agent_id: 7n, expected_revision: 3n }, native: { agent_id: 7n, expected_revision: 3n } },
  get: { sdk: { agent_id: (1n << 64n) - 1n }, native: { agent_id: (1n << 64n) - 1n } },
  current: { sdk: { agent_id: 7n, revision: 3n }, native: { agent_id: 7n, revision: 3n } },
  agent_count: { sdk: {}, native: {} },
};

const key = { agent_id: 7n, revision: 2n, provider: account(3) };
const verificationCases: Case<VerificationArgs> = {
  approve_provider: { sdk: { provider: account(3), mode: 'Fixture' }, native: { provider: account(3), mode: unit('Fixture') } },
  disable_provider: { sdk: { provider: account(3) }, native: { provider: account(3) } },
  publish: { sdk: { result }, native: { result: nativeResult(result) } },
  revoke: { sdk: { ...key, sequence: 4n }, native: { ...key, sequence: 4n } },
  provider: { sdk: { provider: contractId(3) }, native: { provider: contractId(3) } },
  latest: { sdk: key, native: key },
  current: { sdk: key, native: key },
  check: {
    sdk: { ...key, required_checks: ['Metadata', 'SignerAccount'], max_age: 3_600n, max_risk_score: 10 },
    native: { ...key, required_checks: [unit('Metadata'), unit('SignerAccount')], max_age: 3_600n, max_risk_score: 10 },
  },
  admin: { sdk: {}, native: {} },
  agent_registry: { sdk: {}, native: {} },
};

const canonical = canonicalPolicy(policy);
const transfer = { asset: contractId(15), recipient: account(17), amount: 9_007_199_254_740_993n };
const walletCases: Case<WalletArgs> = {
  fund: { sdk: { from: account(1), ...{ asset: transfer.asset, amount: transfer.amount } },
    native: { from: account(1), asset: transfer.asset, amount: transfer.amount } },
  withdraw: { sdk: transfer, native: transfer },
  balance: { sdk: { asset: transfer.asset }, native: { asset: transfer.asset } },
  approve_policy: { sdk: { policy: canonical }, native: { policy: nativePolicy(canonical) } },
  revoke_policy: { sdk: { policy_hash: bytes(6) }, native: { policy_hash: buf(bytes(6)) } },
  replace_policy: {
    sdk: { old_policy_hash: bytes(6), policy: canonical },
    native: { old_policy_hash: buf(bytes(6)), policy: nativePolicy(canonical) },
  },
  pause: { sdk: {}, native: {} },
  resume: { sdk: {}, native: {} },
  execute: { sdk: { request: action }, native: { request: nativeAction(action) } },
  owner: { sdk: {}, native: {} },
  agent_registry: { sdk: {}, native: {} },
  verification_registry: { sdk: {}, native: {} },
  paused: { sdk: {}, native: {} },
  policies: { sdk: {}, native: {} },
  policy: { sdk: { policy_hash: bytes(6) }, native: { policy_hash: buf(bytes(6)) } },
  policy_state: { sdk: { policy_hash: bytes(6) }, native: { policy_hash: buf(bytes(6)) } },
  audit_head: { sdk: {}, native: {} },
};

const hex = (values: xdr.ScVal[]) => values.map((value) => value.toXdr('hex'));

function checkArguments<A>(name: string, cases: Case<A>, encode: (method: keyof A, args: A[keyof A]) => xdr.ScVal[]) {
  const interfaceSpec = spec(name);
  const exported = interfaceSpec.funcs().map((fn) => fn.name.toString()).filter((fn) => fn !== '__constructor').sort();
  expect(exported, `${name} entry points`).toEqual(Object.keys(cases).sort());
  for (const method of Object.keys(cases) as (keyof A & string)[]) {
    const { sdk, native } = cases[method];
    expect(hex(encode(method, sdk)), `${name}.${method}`).toEqual(hex(interfaceSpec.funcArgsToScVals(method, native)));
  }
  expect(interfaceSpec.errorCases().map((error) => [error.name.toString(), error.value]), `${name} errors`)
    .toEqual(CONTRACT_ERRORS.map((error, i) => [error, i + 1]));
  return interfaceSpec;
}

/** Encode `native` as the ok type `method` returns. */
function returned(interfaceSpec: contract.Spec, method: string, native: unknown): xdr.ScVal {
  const [output] = interfaceSpec.getFunc(method).outputs;
  const type = output?.type === 'scSpecTypeResult' ? output.result.okType : output;
  if (!type) throw new Error(`${method} returns nothing`);
  return interfaceSpec.nativeToScVal(native, type);
}

describe('SDK conformance with the contracts\' published interfaces', () => {
  it('agent registry', () => {
    const interfaceSpec = checkArguments('agent_registry', registryCases, (method, args) => encodeRegistryArgs(method, args));
    const native = { ...identity, metadata_hash: buf(identity.metadata_hash) };
    for (const method of ['register', 'get', 'current', 'rotate_signer', 'disable']) {
      expect(decodeIdentity(returned(interfaceSpec, method, native))).toEqual(identity);
    }
  });

  it('verification registry', () => {
    const interfaceSpec = checkArguments('verification_registry', verificationCases,
      (method, args) => encodeVerificationArgs(method, args));
    for (const method of ['publish', 'latest', 'current', 'check', 'revoke']) {
      expect(decodeVerification(returned(interfaceSpec, method, nativeResult(result)))).toEqual(result);
    }
    expect(decodeProviderRecord(returned(interfaceSpec, 'provider', { mode: unit('Live'), approved: true })))
      .toEqual({ mode: 'Live', approved: true });
    const constructor = interfaceSpec.funcArgsToScVals('__constructor', { admin: account(1), agent_registry: contractId(2) });
    expect(hex(encodeVerificationConstructorArgs(account(1), contractId(2)))).toEqual(hex(constructor));
  });

  it('smart wallet', () => {
    const interfaceSpec = checkArguments('smart_wallet', walletCases, (method, args) => encodeWalletArgs(method, args));
    expect(decodePolicy(returned(interfaceSpec, 'policy', nativePolicy(canonical)))).toEqual(canonical);
    const state = {
      policy_hash: bytes(6), revoked: false, next_sequence: 3n, utc_day: 19_675n,
      daily_spend: [{ asset: contractId(15), amount: 20n }],
    };
    expect(decodePolicyState(returned(interfaceSpec, 'policy_state', { ...state, policy_hash: buf(state.policy_hash) })))
      .toEqual(state);
    expect(decodeAuditHead(returned(interfaceSpec, 'audit_head', { sequence: 9n, hash: buf(bytes(4)) })))
      .toEqual({ sequence: 9n, hash: bytes(4) });
    expect(decodeHashList(returned(interfaceSpec, 'policies', [buf(bytes(1)), buf(bytes(2))])))
      .toEqual([bytes(1), bytes(2)]);
    // `execute` returns the action hash, which the CLI reports as `executed_action_hash`.
    const executed = returned(interfaceSpec, 'execute', buf(bytes(3)));
    expect(executed.type === 'scvBytes' && Uint8Array.from(executed.bytes.value)).toEqual(bytes(3));
    const constructor = interfaceSpec.funcArgsToScVals('__constructor', {
      owner: account(1), agent_registry: contractId(2), verification_registry: contractId(3),
    });
    expect(hex(encodeWalletConstructorArgs(account(1), contractId(2), contractId(3)))).toEqual(hex(constructor));
    expect(interfaceSpec.events().map((event) => event.name.toString())).toContain('WalletAudit');
  });
});
