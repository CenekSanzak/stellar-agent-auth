import { Address, Keypair, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { MAX_AUTH_WINDOW_LEDGERS } from '../../packages/sdk/src/actions.js';
import {
  decodeAuditHead, decodeHashList, decodePolicy, decodePolicyState, encodePolicy, encodePolicyState,
  encodeWalletArgs, encodeWalletConstructorArgs,
} from '../../packages/sdk/src/encoding.js';
import {
  WalletError, canonicalPolicy, evaluateRequest, policyExposure, stateAsOf, transferRequest, utcDay, validatePolicy,
} from '../../packages/sdk/src/policies.js';
import type { ActionRequest, ContractErrorName, Policy, PolicyState } from '../../packages/sdk/src/types.js';
import {
  signFundingAuthorization, signWalletAuthorization, walletOperation,
} from '../../packages/sdk/src/wallet.js';
import { bytes, contract, passphrase } from '../fixtures/abi-v1.js';
import {
  asset, otherAsset, owner, recipient, signer, stranger, transferPolicy, walletAddress,
} from '../fixtures/policies.js';

const NOW = 1_800_000_000n;
const policyHash = bytes(50);

function expectCode(run: () => unknown, code: ContractErrorName) {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WalletError);
  expect(thrown).toHaveProperty('code', code);
}

const freshState = (overrides: Partial<PolicyState> = {}): PolicyState => ({
  policy_hash: policyHash, revoked: false, next_sequence: 1n, utc_day: utcDay(NOW), daily_spend: [], ...overrides,
});

const request = (overrides: Partial<ActionRequest> = {}, amount = 3n, to = recipient, token = asset): ActionRequest => ({
  ...transferRequest({
    wallet: walletAddress, policyHash, sequence: 1n, deadline: NOW + 300n, asset: token, recipient: to, amount,
  }),
  ...overrides,
});

const context = (overrides: Partial<Parameters<typeof evaluateRequest>[3]> = {}) => ({
  wallet: walletAddress, policyHash, paused: false, now: NOW, ...overrides,
});

describe('wallet ABI encoding', () => {
  it('round-trips the canonical policy and rejects non-canonical XDR', () => {
    const canonical = canonicalPolicy(transferPolicy({
      allowed_recipients: [stranger, recipient], required_checks: ['SignerAccount', 'Endpoint', 'Metadata'],
    }));
    expect(decodePolicy(encodePolicy(canonical))).toEqual(canonical);
    const encoded = encodePolicy(canonical);
    if (encoded.type !== 'scvMap') throw new Error('Expected a map');
    const entries = encoded.map ?? [];
    expect(() => decodePolicy(xdr.ScVal.scvMap(entries.slice(1)))).toThrow('Policy map');
    const reversed = entries.map((entry) => entry.key.type === 'scvSymbol' && entry.key.sym.toString() === 'required_checks'
      ? new xdr.ScMapEntry({ key: entry.key, val: xdr.ScVal.scvVec([...(entry.val.type === 'scvVec' ? entry.val.vec ?? [] : [])].reverse()) })
      : entry);
    expect(() => decodePolicy(xdr.ScVal.scvMap(reversed))).toThrow('Non-canonical');
  });

  it('round-trips policy state with large spend and decodes audit heads and hash lists strictly', () => {
    const state = freshState({
      next_sequence: (1n << 64n) - 1n, daily_spend: [{ asset, amount: (1n << 127n) - 1n }, { asset: otherAsset, amount: 1n }],
    });
    expect(decodePolicyState(encodePolicyState(state))).toEqual(state);
    const head = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('hash'), val: xdr.ScVal.scvBytes(Buffer.from(bytes(7))) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('sequence'), val: xdr.ScVal.scvU64(9n) }),
    ]);
    expect(decodeAuditHead(head)).toEqual({ sequence: 9n, hash: bytes(7) });
    expect(() => decodeAuditHead(xdr.ScVal.scvMap([]))).toThrow('AuditHead');
    expect(decodeHashList(xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.from(bytes(1)))]))).toEqual([bytes(1)]);
    expect(() => decodeHashList(xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(31))]))).toThrow('32 bytes');
  });

  it('encodes wallet arguments and constructor arguments', () => {
    expect(encodeWalletArgs('pause', {})).toEqual([]);
    expect(encodeWalletArgs('fund', { from: owner, asset, amount: 5n })).toHaveLength(3);
    expect(() => encodeWalletArgs('fund', { from: owner, asset, amount: 0n })).toThrow('positive i128');
    expect(() => encodeWalletArgs('nope' as 'pause', {})).toThrow('Unknown wallet method');
    expect(encodeWalletConstructorArgs(owner, contract(1), contract(2))).toHaveLength(3);
    expect(() => encodeWalletConstructorArgs(owner, owner, contract(2))).toThrow('contract addresses');
  });
});

describe('policy rules mirror the wallet contract', () => {
  it('canonicalizes sets in the contract order and keeps the hash input stable', () => {
    const canonical = canonicalPolicy(transferPolicy({
      assets: [{ asset: otherAsset, per_transaction: 1n, per_day: 1n }, { asset, per_transaction: 5n, per_day: 20n }],
      allowed_recipients: [contract(9), stranger, recipient],
    }));
    expect(canonical.assets.map(({ asset: token }) => token)).toEqual([asset, otherAsset]);
    // Accounts sort before contracts, then by key bytes.
    expect(canonical.allowed_recipients).toEqual([recipient, stranger, contract(9)]);
    expect(encodePolicy(canonical).toXdr('hex')).toBe(encodePolicy(transferPolicy({
      assets: [{ asset, per_transaction: 5n, per_day: 20n }, { asset: otherAsset, per_transaction: 1n, per_day: 1n }],
      allowed_recipients: [recipient, contract(9), stranger],
    })).toXdr('hex'));
  });

  it.each<[string, Partial<Policy>, ContractErrorName]>([
    ['schema', { schema_version: 2 }, 'UnsupportedVersion'],
    ['too many assets', { assets: [1, 2, 3, 4, 5].map((i) => ({ asset: contract(i), per_transaction: 1n, per_day: 1n })) }, 'LimitExceeded'],
    ['empty window', { valid_after: NOW, valid_until: NOW }, 'InvalidInput'],
    ['zero age', { max_assessment_age: 0n }, 'InvalidInput'],
    ['risk above 100', { max_risk_score: 101 }, 'InvalidInput'],
    ['no required checks', { required_checks: [] }, 'InvalidInput'],
    ['zero cap', { assets: [{ asset, per_transaction: 0n, per_day: 1n }] }, 'InvalidInput'],
    ['cap above daily', { assets: [{ asset, per_transaction: 6n, per_day: 5n }] }, 'InvalidInput'],
    ['service without rule', { action_kinds: ['ServicePayment'] }, 'InvalidInput'],
    ['duplicate recipient', { allowed_recipients: [recipient, recipient] }, 'Duplicate'],
    ['duplicate check', { required_checks: ['Endpoint', 'Endpoint'] }, 'Duplicate'],
  ])('rejects %s like Policy::canonicalize', (_label, overrides, code) => {
    expectCode(() => canonicalPolicy(transferPolicy(overrides)), code);
  });

  it.each<[string, Partial<Policy>, ContractErrorName]>([
    ['service payments', { action_kinds: ['ServicePayment', 'Transfer'], service: { contract: contract(3), service_id: bytes(3) } }, 'InvalidInput'],
    ['contract signer', { signer: contract(4) }, 'InvalidInput'],
    ['owner as signer', { signer: owner }, 'InvalidInput'],
    ['account asset', { assets: [{ asset: recipient, per_transaction: 1n, per_day: 1n }] }, 'InvalidInput'],
    ['wallet as recipient', { allowed_recipients: [walletAddress] }, 'InvalidInput'],
    ['wallet as blocked recipient', { blocked_recipients: [walletAddress] }, 'InvalidInput'],
    ['ended window', { valid_after: NOW - 100n, valid_until: NOW }, 'Expired'],
  ])('rejects %s like the wallet approval', (_label, overrides, code) => {
    expectCode(() => validatePolicy(transferPolicy(overrides), { wallet: walletAddress, owner, now: NOW }), code);
  });

  it('accepts the SOW policy', () => {
    expect(validatePolicy(transferPolicy(), { wallet: walletAddress, owner, now: NOW })).toEqual(
      canonicalPolicy(transferPolicy()));
  });
});

describe('request evaluation mirrors wallet execution', () => {
  const policy = canonicalPolicy(transferPolicy({ blocked_recipients: [stranger], allowed_recipients: [recipient, stranger] }));

  it('accepts a request within every limit, including exactly the caps', () => {
    evaluateRequest(policy, freshState(), request(), context());
    evaluateRequest(policy, freshState(), request({}, 5n), context());
    evaluateRequest(policy, freshState({ daily_spend: [{ asset, amount: 15n }] }), request({}, 5n), context());
  });

  it.each<[string, () => [Policy, PolicyState, ActionRequest, ReturnType<typeof context>], ContractErrorName]>([
    ['another policy', () => [policy, freshState(), request({ policy_hash: bytes(1) }), context()], 'NotFound'],
    ['schema', () => [policy, freshState(), request({ schema_version: 2 }), context()], 'UnsupportedVersion'],
    ['zero amount', () => [policy, freshState(), request({}, 0n), context()], 'InvalidInput'],
    ['another wallet', () => [policy, freshState(), request({ wallet: contract(5) }), context()], 'PolicyDenied'],
    ['paused', () => [policy, freshState(), request(), context({ paused: true })], 'Paused'],
    ['revoked', () => [policy, freshState({ revoked: true }), request(), context()], 'Revoked'],
    ['old sequence', () => [policy, freshState({ next_sequence: 2n }), request(), context()], 'InvalidSequence'],
    ['deadline', () => [policy, freshState(), request({ deadline: NOW }), context()], 'Expired'],
    ['window end', () => [policy, freshState(), request(), context({ now: policy.valid_until })], 'Expired'],
    ['before start', () => [policy, freshState(), request(), context({ now: policy.valid_after - 1n })], 'PolicyDenied'],
    ['unapproved asset', () => [policy, freshState(), request({}, 3n, recipient, otherAsset), context()], 'PolicyDenied'],
    ['blocked recipient', () => [policy, freshState(), request({}, 3n, stranger), context()], 'PolicyDenied'],
    ['unlisted recipient', () => [policy, freshState(), request({}, 3n, owner), context()], 'PolicyDenied'],
    ['above the cap', () => [policy, freshState(), request({}, 6n), context()], 'LimitExceeded'],
    ['over the day', () => [policy, freshState({ daily_spend: [{ asset, amount: 18n }] }), request(), context()], 'LimitExceeded'],
  ])('rejects %s', (_label, input, code) => {
    expectCode(() => evaluateRequest(...input()), code);
  });

  it('resets the day at UTC midnight', () => {
    const spent = freshState({ daily_spend: [{ asset, amount: 20n }] });
    const midnight = (utcDay(NOW) + 1n) * 86_400n;
    expectCode(() => evaluateRequest(policy, spent, request({ deadline: midnight }), context({ now: midnight - 1n })),
      'LimitExceeded');
    evaluateRequest(policy, spent, request({ deadline: midnight + 300n }), context({ now: midnight }));
    expect(stateAsOf(spent, midnight)).toMatchObject({ utc_day: utcDay(midnight), daily_spend: [] });
    expect(stateAsOf(spent, midnight - 1n)).toBe(spent);
  });
});

describe('owner exposure', () => {
  it('adds budgets across active policies and leaves out revoked and ended ones', () => {
    const first = canonicalPolicy(transferPolicy());
    const second = canonicalPolicy(transferPolicy({
      policy_id: bytes(2), assets: [{ asset, per_transaction: 2n, per_day: 4n }, { asset: otherAsset, per_transaction: 1n, per_day: 3n }],
    }));
    const ended = canonicalPolicy(transferPolicy({ policy_id: bytes(3), valid_after: NOW - 100n, valid_until: NOW }));
    const rows = policyExposure([
      { policy: first, state: freshState({ daily_spend: [{ asset, amount: 7n }] }) },
      { policy: second, state: freshState() },
      { policy: first, state: freshState({ revoked: true }) },
      { policy: ended, state: freshState() },
    ], NOW);
    expect(rows).toEqual([
      { asset, daily_cap: 24n, spent_today: 7n, remaining_today: 17n, largest_transfer: 5n, policies: 2 },
      { asset: otherAsset, daily_cap: 3n, spent_today: 0n, remaining_today: 3n, largest_transfer: 1n, policies: 1 },
    ]);
  });
});

describe('wallet operations and signing', () => {
  const key = Keypair.random();
  const latestLedger = 100;
  const window = { latestLedger, expirationLedger: latestLedger + MAX_AUTH_WINDOW_LEDGERS };

  const invocation = (contractId: string, method: string, args: xdr.ScVal[], children: xdr.SorobanAuthorizedInvocation[] = []) =>
    new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(), functionName: method, args,
      })),
      subInvocations: children,
    });

  const entry = (address: string, root: xdr.SorobanAuthorizedInvocation) => new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      address: Address.fromString(address).toScAddress(), nonce: 1n, signatureExpirationLedger: 0,
      signature: xdr.ScVal.scvVoid(),
    })),
    rootInvocation: root,
  });

  it('prechecks operations the contract would reject', () => {
    expect(() => walletOperation(owner, 'pause', {})).toThrow('smart wallet contract');
    expectCode(() => walletOperation(walletAddress, 'fund', { from: owner, asset: recipient, amount: 1n }), 'InvalidInput');
    expectCode(() => walletOperation(walletAddress, 'withdraw', { asset, recipient: walletAddress, amount: 1n }),
      'InvalidInput');
    expectCode(() => walletOperation(walletAddress, 'withdraw', { asset, recipient, amount: -1n }), 'InvalidInput');
    expectCode(() => walletOperation(walletAddress, 'approve_policy', { policy: transferPolicy({ max_risk_score: 101 }) }),
      'InvalidInput');
    expect(walletOperation(walletAddress, 'approve_policy', { policy: transferPolicy() })).toBeDefined();
  });

  it('signs only the exact owner call with no child invocations', async () => {
    const args = { policy_hash: policyHash };
    const root = invocation(walletAddress, 'revoke_policy', encodeWalletArgs('revoke_policy', args));
    const input = {
      contractId: walletAddress, method: 'revoke_policy' as const, args, address: key.publicKey(),
      networkPassphrase: passphrase, ...window, signer: key,
    };
    await expect(signWalletAuthorization({ ...input, entry: entry(key.publicKey(), root) })).resolves.toBeDefined();
    await expect(signWalletAuthorization({ ...input, args: { policy_hash: bytes(1) }, entry: entry(key.publicKey(), root) }))
      .rejects.toThrow('does not match');
    await expect(signWalletAuthorization({ ...input, entry: entry(owner, root) })).rejects.toThrow('signing account');
    const nested = invocation(walletAddress, 'revoke_policy', encodeWalletArgs('revoke_policy', args), [root]);
    await expect(signWalletAuthorization({ ...input, entry: entry(key.publicKey(), nested) })).rejects.toThrow('single');
    const executeRoot = invocation(walletAddress, 'execute', []);
    await expect(signWalletAuthorization({ ...input, method: 'execute' as 'pause', args: {}, entry: entry(key.publicKey(), executeRoot) }))
      .rejects.toThrow('single');
  });

  it('signs a funding entry only for exactly the transfer into the wallet', async () => {
    const args = { from: key.publicKey(), asset, amount: 5n };
    const transfer = (from: string, to: string, amount: bigint, token = asset, children: xdr.SorobanAuthorizedInvocation[] = []) =>
      invocation(token, 'transfer', [
        Address.fromString(from).toScVal(), Address.fromString(to).toScVal(), encodeWalletArgs('fund', { ...args, amount })[2]!,
      ], children);
    const fundRoot = (children: xdr.SorobanAuthorizedInvocation[], rootArgs = args) =>
      invocation(walletAddress, 'fund', encodeWalletArgs('fund', rootArgs), children);
    const sign = (root: xdr.SorobanAuthorizedInvocation, address = key.publicKey()) => signFundingAuthorization({
      entry: entry(address, root), contractId: walletAddress, args, networkPassphrase: passphrase, ...window, signer: key,
    });

    await expect(sign(fundRoot([transfer(key.publicKey(), walletAddress, 5n)]))).resolves.toBeDefined();
    for (const [label, root] of [
      ['no transfer', fundRoot([])],
      ['two transfers', fundRoot([transfer(key.publicKey(), walletAddress, 5n), transfer(key.publicKey(), walletAddress, 5n)])],
      ['larger transfer', fundRoot([transfer(key.publicKey(), walletAddress, 6n)])],
      ['other destination', fundRoot([transfer(key.publicKey(), recipient, 5n)])],
      ['other asset', fundRoot([transfer(key.publicKey(), walletAddress, 5n, otherAsset)])],
      ['nested call', fundRoot([transfer(key.publicKey(), walletAddress, 5n, asset, [invocation(asset, 'burn', [])])])],
      ['other root amount', fundRoot([transfer(key.publicKey(), walletAddress, 5n)], { ...args, amount: 6n })],
    ] as const) {
      await expect(sign(root), label).rejects.toThrow(/funding|asset transfer/);
    }
    await expect(sign(fundRoot([transfer(key.publicKey(), walletAddress, 5n)]), owner)).rejects.toThrow('funding account');
  });
});
