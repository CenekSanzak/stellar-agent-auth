import { Address, Keypair, Networks, SorobanDataBuilder, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  decodeProviderRecord, decodeVerification, encodeProviderRecord, encodeVerification, encodeVerificationArgs,
  encodeVerificationConstructorArgs,
} from '../../packages/sdk/src/encoding.js';
import type {
  CheckResult, ContractErrorName, VerificationRequirement, VerificationResult,
} from '../../packages/sdk/src/types.js';
import {
  VerificationRegistryError, buildResult, checkVerification, evaluateResult, nextResultSequence, readCurrentResult,
  readLatestResult, readProvider, riskScoreOf, signVerificationAuthorization, validatePublication,
  validateRequirement, verificationOperation,
} from '../../packages/sdk/src/verification.js';
import { account, bytes, contract, passphrase } from '../fixtures/abi-v1.js';
import { limitedChecks } from '../fixtures/verification.js';

const NOW = 1_800_000_000n;
const HOUR = 3_600n;
const registry = contract(50);
const provider = Keypair.random();

const result = (overrides: Partial<VerificationResult> = {}): VerificationResult => ({
  ...buildResult({
    agent_id: 4n, revision: 2n, provider: provider.publicKey(), sequence: 1n, mode: 'Live',
    checks: limitedChecks(), serious_wallet_risks: 0, evidence_hash: bytes(9), issued_at: NOW,
    expires_at: NOW + HOUR,
  }),
  ...overrides,
});

const check = (kind: CheckResult['kind'], outcome: CheckResult['outcome'], score: number | null = null) =>
  ({ kind, outcome, score });

function codeOf(run: () => unknown): ContractErrorName | 'ok' {
  try {
    run();
    return 'ok';
  } catch (error) {
    if (error instanceof VerificationRegistryError) return error.code;
    throw error;
  }
}

describe('risk scoring', () => {
  it.each<[string, (number | null)[], number | null]>([
    ['no scored check', [null, null], null],
    ['all passed', [0, 0, 0], 0],
    ['one of three failed', [100, 0, 0], 34],
    ['one of two failed', [100, 0], 50],
    ['ceiling of a fraction', [1, 0, 0], 1],
    ['unscored checks ignored', [100, null, 0], 50],
    ['all failed', [100, 100], 100],
  ])('%s', (_, scores, expected) => {
    const checks = scores.map((score, i) => check(['Code', 'Endpoint', 'Media'][i] as 'Code', 'Passed', score));
    expect(riskScoreOf(checks)).toBe(expected);
  });

  it('builds canonical results', () => {
    const built = buildResult({
      agent_id: 1n, revision: 1n, provider: provider.publicKey(), sequence: 1n, mode: 'Live',
      checks: [...limitedChecks()].reverse(), serious_wallet_risks: 0, evidence_hash: bytes(1), issued_at: NOW,
      expires_at: NOW + 1n,
    });
    expect(built.checks.map(({ kind }) => kind)).toEqual(limitedChecks().map(({ kind }) => kind));
    expect(built).toMatchObject({ schema_version: 1, risk_score: 0, revoked: false });
    expect(codeOf(() => validatePublication(built, NOW))).toBe('ok');
  });
});

describe('publication rules mirror VerificationResult::validate_publication', () => {
  const nine = [...limitedChecks(), check('Code', 'Unsupported')];
  const withChecks = (checks: CheckResult[]) => result({ checks, risk_score: riskScoreOf(checks) });
  it.each<[string, VerificationResult, ContractErrorName | 'ok']>([
    ['the limited result', result(), 'ok'],
    ['schema version 2', result({ schema_version: 2 }), 'UnsupportedVersion'],
    ['nine checks', withChecks(nine), 'LimitExceeded'],
    ['duplicate kind', withChecks([check('Metadata', 'Passed', 0), check('Metadata', 'Passed', 0)]), 'Duplicate'],
    ['check score 101', withChecks([check('Metadata', 'Failed', 101)]), 'InvalidInput'],
    ['risk score 101', result({ risk_score: 101 }), 'InvalidInput'],
    ['unknown risk flag', result({ serious_wallet_risks: 1 << 3 }), 'InvalidInput'],
    ['no checks', withChecks([]), 'InvalidInput'],
    ['descending kinds', withChecks([check('Metadata', 'Passed', 0), check('Endpoint', 'Passed', 0)]), 'InvalidInput'],
    ['scored unsupported', withChecks([check('Token', 'Unsupported', 0)]), 'InvalidInput'],
    ['scored inconclusive', withChecks([check('Token', 'Inconclusive', 50)]), 'InvalidInput'],
    ['scored not applicable', withChecks([check('Token', 'NotApplicable', 0)]), 'InvalidInput'],
    ['aggregate too low', { ...withChecks([check('Metadata', 'Failed', 1)]), risk_score: 0 }, 'InvalidInput'],
    ['aggregate missing', result({ risk_score: null }), 'InvalidInput'],
    ['aggregate without scores', { ...withChecks([check('Token', 'Unsupported')]), risk_score: 0 }, 'InvalidInput'],
    ['published revoked', result({ revoked: true }), 'InvalidInput'],
    ['issued in the future', result({ issued_at: NOW + 1n }), 'InvalidInput'],
    ['expires at issue', result({ issued_at: NOW - 10n, expires_at: NOW - 10n }), 'InvalidInput'],
    ['expires before issue', result({ expires_at: NOW - 1n }), 'InvalidInput'],
    ['expires now', result({ issued_at: NOW - 10n, expires_at: NOW }), 'Expired'],
    ['one second of validity', result({ expires_at: NOW + 1n }), 'ok'],
  ])('%s', (_, value, expected) => {
    expect(codeOf(() => validatePublication(value, NOW))).toBe(expected);
  });

  it('skips only the ledger-time rules without a time', () => {
    expect(codeOf(() => validatePublication(result({ issued_at: NOW + 1n })))).toBe('ok');
    expect(codeOf(() => validatePublication(result({ issued_at: NOW - 10n, expires_at: NOW })))).toBe('ok');
    expect(codeOf(() => validatePublication(result({ expires_at: NOW - 1n })))).toBe('InvalidInput');
  });
});

describe('requirement evaluation mirrors VerificationResult::evaluate', () => {
  const requirement = (overrides: Partial<VerificationRequirement> = {}): VerificationRequirement => ({
    required_checks: ['Metadata'], max_age: HOUR, max_risk_score: 0, ...overrides,
  });
  const scored = result({
    checks: [check('Endpoint', 'Failed', 100), check('Metadata', 'Passed', 0), check('SignerAccount', 'Passed', 0)],
    risk_score: 34,
  });
  it.each<[string, VerificationResult, bigint, VerificationRequirement, ContractErrorName | 'ok']>([
    ['passing', result(), NOW, requirement(), 'ok'],
    ['empty requirement', result(), NOW, requirement({ required_checks: [] }), 'InvalidInput'],
    ['duplicate requirement', result(), NOW, requirement({ required_checks: ['Metadata', 'Metadata'] }), 'Duplicate'],
    ['zero age', result(), NOW, requirement({ max_age: 0n }), 'InvalidInput'],
    ['threshold 101', result(), NOW, requirement({ max_risk_score: 101 }), 'InvalidInput'],
    ['revoked', result({ revoked: true }), NOW, requirement(), 'Revoked'],
    ['one second before expiry', result(), NOW + HOUR - 1n, requirement(), 'ok'],
    ['at expiry', result(), NOW + HOUR, requirement({ max_age: 2n * HOUR }), 'Expired'],
    ['issued in the future', result(), NOW - 1n, requirement(), 'InvalidInput'],
    ['age at the maximum', result(), NOW + 600n, requirement({ max_age: 600n }), 'ok'],
    ['age above the maximum', result(), NOW + 600n, requirement({ max_age: 599n }), 'Expired'],
    ['serious wallet risk', result({ serious_wallet_risks: 1 }), NOW, requirement({ max_risk_score: 100 }), 'VerificationDenied'],
    ['failed required check', scored, NOW, requirement({ required_checks: ['Endpoint'], max_risk_score: 100 }), 'VerificationDenied'],
    ['inconclusive required check', result(), NOW, requirement({ required_checks: ['SignerHistory'] }), 'VerificationDenied'],
    ['unsupported required check', result(), NOW, requirement({ required_checks: ['ThreatFeed'] }), 'VerificationDenied'],
    ['absent required check', scored, NOW, requirement({ required_checks: ['Token'], max_risk_score: 100 }), 'VerificationDenied'],
    ['risk at threshold', scored, NOW, requirement({ max_risk_score: 34 }), 'ok'],
    ['risk above threshold', scored, NOW, requirement({ max_risk_score: 33 }), 'VerificationDenied'],
    ['no aggregate', result({ checks: [check('Metadata', 'Passed')], risk_score: null }), NOW, requirement({ max_risk_score: 100 }), 'VerificationDenied'],
  ])('%s', (_, value, now, req, expected) => {
    expect(codeOf(() => evaluateResult(value, now, req))).toBe(expected);
  });

  it('bounds the requirement size', () => {
    const nine = [...limitedChecks().map(({ kind }) => kind), 'Code' as const];
    expect(codeOf(() => validateRequirement(requirement({ required_checks: nine })))).toBe('LimitExceeded');
  });
});

describe('verification encoding', () => {
  it('round-trips results and provider records strictly', () => {
    const value = result({ risk_score: null, checks: [check('Metadata', 'Passed')] });
    expect(decodeVerification(encodeVerification(value))).toEqual(value);
    expect(decodeVerification(encodeVerification(result()))).toEqual(result());
    for (const record of [{ mode: 'Live', approved: true }, { mode: 'Fixture', approved: false }] as const) {
      expect(decodeProviderRecord(encodeProviderRecord(record))).toEqual(record);
    }
  });

  it('rejects non-canonical or malformed values', () => {
    const encoded = encodeVerification(result());
    if (encoded.type !== 'scvMap') throw new Error('Expected a map');
    const entries = encoded.map ?? [];
    const without = xdr.ScVal.scvMap(entries.slice(1));
    expect(() => decodeVerification(without)).toThrow('map');
    const reordered = xdr.ScVal.scvMap([entries[1]!, entries[0]!, ...entries.slice(2)]);
    expect(() => decodeVerification(reordered)).toThrow('field');
    const retyped = xdr.ScVal.scvMap(entries.map((entry) => entry.key.type === 'scvSymbol'
      && entry.key.sym.toString() === 'risk_score'
      ? new xdr.ScMapEntry({ key: entry.key, val: xdr.ScVal.scvU64(0n) }) : entry));
    expect(() => decodeVerification(retyped)).toThrow('u32');
    expect(() => decodeProviderRecord(xdr.ScVal.scvVoid())).toThrow('ProviderRecord');
    const badMode = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('approved'), val: xdr.ScVal.scvBool(true) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('mode'), val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Simulated')]) }),
    ]);
    expect(() => decodeProviderRecord(badMode)).toThrow('variant');
  });

  it('encodes every entry point argument list', () => {
    const key = { agent_id: 4n, revision: 2n, provider: provider.publicKey() };
    expect(encodeVerificationArgs('approve_provider', { provider: account(1), mode: 'Fixture' })).toHaveLength(2);
    expect(encodeVerificationArgs('publish', { result: result() })[0]!.toXdr('hex'))
      .toBe(encodeVerification(result()).toXdr('hex'));
    expect(encodeVerificationArgs('revoke', { ...key, sequence: 3n })).toHaveLength(4);
    expect(encodeVerificationArgs('check', { ...key, required_checks: ['Metadata'], max_age: 1n, max_risk_score: 0 }))
      .toHaveLength(6);
    expect(encodeVerificationArgs('admin', {})).toEqual([]);
    expect(() => encodeVerificationArgs('toString' as 'admin', {})).toThrow('Unknown');
    expect(encodeVerificationConstructorArgs(account(1), registry)).toHaveLength(2);
    expect(() => encodeVerificationConstructorArgs(account(1), account(2))).toThrow('contract');
  });
});

describe('verification operations', () => {
  it('prechecks what the contract rejects', () => {
    expect(() => verificationOperation(account(1), 'admin', {})).toThrow('contract address');
    expect(codeOf(() => verificationOperation(registry, 'publish', { result: result({ risk_score: 5 }) })))
      .toBe('InvalidInput');
    expect(codeOf(() => verificationOperation(registry, 'publish', { result: result({ provider: 'GBAD' }) })))
      .toBe('InvalidInput');
    expect(codeOf(() => verificationOperation(registry, 'check', {
      agent_id: 1n, revision: 1n, provider: account(1), required_checks: [], max_age: 1n, max_risk_score: 0,
    }))).toBe('InvalidInput');
    expect(codeOf(() => verificationOperation(registry, 'approve_provider', { provider: 'nope', mode: 'Live' })))
      .toBe('InvalidInput');
    // Ledger-time rules are the contract's: a future issue time still builds.
    expect(codeOf(() => verificationOperation(registry, 'publish', { result: result({ issued_at: NOW * 2n, expires_at: NOW * 3n }) })))
      .toBe('ok');
  });
});

describe('verification authorization signing', () => {
  const latestLedger = 1_000;
  const value = result();

  function entry(method: string, args: xdr.ScVal[], address = provider.publicKey(), target = registry) {
    return new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(), nonce: 7n, signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(target).toScAddress(), functionName: method, args,
        })),
        subInvocations: [],
      }),
    });
  }

  const publish = {
    entry: entry('publish', encodeVerificationArgs('publish', { result: value })), contractId: registry,
    method: 'publish' as const, args: { result: value }, address: provider.publicKey(), networkPassphrase: passphrase,
    latestLedger, expirationLedger: latestLedger + 20, signer: provider,
  };

  it('signs the exact publication for its own provider', async () => {
    const signed = await signVerificationAuthorization(publish);
    expect(signed.credentials.type === 'sorobanCredentialsAddress' && signed.credentials.address.signature.type)
      .toBe('scvVec');
  });

  it.each<[string, Partial<typeof publish>, string]>([
    ['a result naming another provider', { args: { result: { ...value, provider: account(3) } } }, 'named provider'],
    ['a mutated sequence', { entry: entry('publish', encodeVerificationArgs('publish', { result: { ...value, sequence: 2n } })) }, 'does not match'],
    ['another contract', { entry: entry('publish', encodeVerificationArgs('publish', { result: value }), undefined, contract(51)) }, 'does not match'],
    ['a read-only method', { method: 'current' as 'publish' }, 'single'],
    ['expiry beyond the window', { expirationLedger: latestLedger + 21 }, '20 ledgers'],
  ])('rejects %s before signing', async (_, override, message) => {
    let called = false;
    const spy = async () => { called = true; return new Uint8Array(64); };
    await expect(signVerificationAuthorization({ ...publish, ...override, signer: spy })).rejects.toThrow(message);
    expect(called).toBe(false);
  });

  it('lets a provider sign revocation of its own results only', async () => {
    const args = { agent_id: 4n, revision: 2n, provider: provider.publicKey(), sequence: 1n };
    const revoke = {
      ...publish, method: 'revoke' as const, args, entry: entry('revoke', encodeVerificationArgs('revoke', args)),
    };
    await expect(signVerificationAuthorization(revoke)).resolves.toBeDefined();
    await expect(signVerificationAuthorization({ ...revoke, args: { ...args, provider: account(3) } }))
      .rejects.toThrow('named provider');
  });
});

describe('verification reads', () => {
  const key = { agent_id: 4n, revision: 2n, provider: provider.publicKey() };
  const base = { id: '1', latestLedger: 10, events: [], _parsed: true };
  const reader = (response: object) => ({
    server: { simulateTransaction: async () => response as never },
    contractId: registry, source: Keypair.random().publicKey(), networkPassphrase: Networks.STANDALONE,
  });
  const success = (retval: xdr.ScVal) => reader({
    ...base, transactionData: new SorobanDataBuilder(), minResourceFee: '0', result: { auth: [], retval },
  });

  it('decodes results and provider records', async () => {
    await expect(readLatestResult(success(encodeVerification(result({ revoked: true }))), key))
      .resolves.toEqual(result({ revoked: true }));
    await expect(readCurrentResult(success(encodeVerification(result())), key)).resolves.toEqual(result());
    await expect(checkVerification(success(encodeVerification(result())), key, {
      required_checks: ['Metadata'], max_age: 1n, max_risk_score: 0,
    })).resolves.toEqual(result());
    await expect(readProvider(success(encodeProviderRecord({ mode: 'Live', approved: true })), account(1)))
      .resolves.toEqual({ mode: 'Live', approved: true });
  });

  it('rejects mismatched or revoked current results', async () => {
    await expect(readCurrentResult(success(encodeVerification(result({ revision: 3n }))), key))
      .rejects.toThrow('different result');
    await expect(readCurrentResult(success(encodeVerification(result({ revoked: true }))), key))
      .rejects.toThrow('revoked');
  });

  it('maps contract errors and derives the next sequence', async () => {
    for (const [code, name] of [[7, 'Expired'], [8, 'Revoked'], [9, 'IdentityChanged'], [10, 'VerificationDenied']] as const) {
      const failure = readCurrentResult(reader({ ...base, error: `HostError: Error(Contract, #${code})` }), key);
      await expect(failure).rejects.toBeInstanceOf(VerificationRegistryError);
      await expect(failure).rejects.toHaveProperty('code', name);
    }
    await expect(nextResultSequence(reader({ ...base, error: 'HostError: Error(Contract, #5)' }), key)).resolves.toBe(1n);
    await expect(nextResultSequence(success(encodeVerification(result({ sequence: 6n }))), key)).resolves.toBe(7n);
    await expect(nextResultSequence(reader({ ...base, error: 'HostError: Error(Contract, #9)' }), key))
      .rejects.toHaveProperty('code', 'IdentityChanged');
  });
});
