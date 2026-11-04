import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Address, Keypair, Operation, hash, xdr, type rpc } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_AUTH_WINDOW_LEDGERS } from '../../packages/sdk/src/actions.js';
import { readCurrent, registryOperation, signRegistryAuthorization } from '../../packages/sdk/src/agents.js';
import { contractErrorName } from '../../packages/sdk/src/contract-call.js';
import {
  decodeIdentity, decodeProviderRecord, decodeVerification, encodeProviderRecord, encodeRegistryArgs,
  encodeVerification,
  encodeVerificationArgs, encodeVerificationConstructorArgs,
} from '../../packages/sdk/src/encoding.js';
import type {
  AgentIdentity, ContractErrorName, RegistryArgs, RegistryAuthMethod, VerificationArgs, VerificationAuthMethod,
  VerificationResult,
} from '../../packages/sdk/src/types.js';
import {
  VerificationRegistryError, buildResult, checkVerification, readBoundAgentRegistry, readCurrentResult,
  readLatestResult, readProvider, readVerificationAdmin, signVerificationAuthorization, verificationOperation,
  type VerificationRead,
} from '../../packages/sdk/src/verification.js';
import { ReportStore } from '../../services/verifier/src/attestations.js';
import { assess, type VerifierContext } from '../../services/verifier/src/index.js';
import { AGENT_METADATA_SCHEMA } from '../../services/verifier/src/metadata.js';
import { readCapped, type Resolver, type Transport } from '../../services/verifier/src/net.js';
import { fixtureResult, type FixtureScenario } from '../fixtures/verification.js';
import { assertResourceFit, resourceLimits } from '../local/phase1-resources.js';
import {
  assertAuthFailure, contractEvents, localNetwork, readWasm, returnValue, successfulSimulation,
  type Confirmed, type LocalNetwork,
} from './support/local-network.js';

type Entry = xdr.SorobanAuthorizationEntry;
const TIMEOUT = 120_000;
const HOUR = 3_600n;

// Separate roles generated per run and funded by Friendbot. The sponsor only pays and signs envelopes.
const admin = Keypair.random();
const controller = Keypair.random();
const signer = Keypair.random();
const sponsor = Keypair.random();
const provider = Keypair.random();
const fixtureProvider = Keypair.random();
const attacker = Keypair.random();

/**
 * Public example metadata served by an in-process transport, because a local network cannot reach a public HTTPS
 * host. Every other part of the assessment is real: identities, signer accounts and publication on the ledger.
 */
const encoder = new TextEncoder();
const METADATA_URI = 'https://agent.example.test/agent.json';
const metadataDocument = (version: number) => encoder.encode(JSON.stringify({
  schema: AGENT_METADATA_SCHEMA, name: `stellar-agent-auth example agent v${version}`,
  description: 'Public test fixture for the verification flow; not a live agent and holds no secrets.',
  endpoints: [{ name: 'api', url: 'https://api.agent.example.test/v1' }],
}));
const resolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
let served = metadataDocument(1);
const transport: Transport = async ({ url, maxBytes }) => ({
  status: url.pathname === '/agent.json' ? 200 : 204, location: undefined, contentType: 'application/json',
  body: await readCapped(Readable.from([url.pathname === '/agent.json' ? served : new Uint8Array()]), maxBytes),
  tls: { protocol: 'TLSv1.3', authorized: true },
});

let net: LocalNetwork;
let limits: Awaited<ReturnType<typeof resourceLimits>>;
let agentRegistry: string;
let registry: string;
let read: VerificationRead;
let agent: AgentIdentity;
let stateDirectory: string;
let verifier: VerifierContext;

function credential(entry: Entry) {
  if (entry.credentials.type !== 'sorobanCredentialsAddress') throw new Error('Expected address credentials');
  return Address.fromScAddress(entry.credentials.address.address).toString();
}

function expectContractError(simulation: rpc.Api.SimulateTransactionResponse, code: ContractErrorName, label: string) {
  expect('error' in simulation ? contractErrorName(simulation.error) : 'success', label).toBe(code);
}

async function expectRegistryError(promise: Promise<unknown>, code: ContractErrorName) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(VerificationRegistryError);
  expect(error).toHaveProperty('code', code);
}

async function ledgerTime() {
  return BigInt((await net.server.getLatestLedger()).closeTime);
}

/** Agent registry mutation with each role signing its own entry, submitted by the sponsor. */
async function agentCall<M extends RegistryAuthMethod>(method: M, args: RegistryArgs[M], keys: Keypair[]) {
  const recording = successfulSimulation(await net.simulate(
    await net.build(sponsor, registryOperation(agentRegistry, method, args)), 'record'));
  const auth = await Promise.all(recording.result.auth.map((entry, i) => signRegistryAuthorization({
    entry, contractId: agentRegistry, method, args, address: keys[i]!.publicKey(), networkPassphrase: net.passphrase,
    latestLedger: recording.latestLedger, expirationLedger: recording.latestLedger + MAX_AUTH_WINDOW_LEDGERS,
    signer: keys[i]!,
  })));
  const tx = await net.build(sponsor, Operation.invokeContractFunction({
    contract: agentRegistry, function: method, args: encodeRegistryArgs(method, args), auth,
  }));
  const { confirmed } = await net.submit(tx, successfulSimulation(await net.simulate(tx, 'enforce')), sponsor);
  return decodeIdentity(returnValue(confirmed));
}

/** A raw sponsor-sourced verification call; it bypasses SDK prechecks so the contract's own checks run. */
const callTx = <M extends VerificationAuthMethod>(method: M, args: xdr.ScVal[], auth: Entry[] = []) =>
  net.build(sponsor, Operation.invokeContractFunction({ contract: registry, function: method, args, auth }));

/** Records `method(args)`, has `key` sign its entry through the SDK validator, and returns the signed entries. */
async function signed<M extends VerificationAuthMethod>(
  method: M, args: VerificationArgs[M], key: Keypair, address = key.publicKey(),
) {
  const recording = successfulSimulation(await net.simulate(
    await net.build(sponsor, verificationOperation(registry, method, args)), 'record'));
  expect(recording.result.auth.map(credential), method).toEqual([address]);
  const auth = await Promise.all(recording.result.auth.map((entry) => signVerificationAuthorization({
    entry, contractId: registry, method, args, address, networkPassphrase: net.passphrase,
    latestLedger: recording.latestLedger, expirationLedger: recording.latestLedger + MAX_AUTH_WINDOW_LEDGERS,
    signer: key,
  })));
  return { auth, expirationLedger: recording.latestLedger + MAX_AUTH_WINDOW_LEDGERS };
}

/** Sign as `key`, enforce, submit as the sponsor and confirm. */
async function verificationCall<M extends VerificationAuthMethod>(method: M, args: VerificationArgs[M], key: Keypair) {
  const { auth } = await signed(method, args, key);
  const tx = await callTx(method, encodeVerificationArgs(method, args), auth);
  const enforced = successfulSimulation(await net.simulate(tx, 'enforce'));
  const { confirmed, prepared } = await net.submit(tx, enforced, sponsor);
  expect(prepared.source).toBe(sponsor.publicKey());
  return { confirmed, prepared, enforced };
}

/** A hand-built entry for `address`, signed by `key` through the SDK validator, for calls recording mode rejects. */
async function signedByHand<M extends VerificationAuthMethod>(
  method: M, args: VerificationArgs[M], key: Keypair, address = key.publicKey(),
) {
  const ledger = await net.latestLedger();
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      address: Address.fromString(address).toScAddress(), nonce: randomBytes(8).readBigInt64BE(),
      signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid(),
    })),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(registry).toScAddress(), functionName: method,
        args: encodeVerificationArgs(method, args),
      })),
      subInvocations: [],
    }),
  });
  return [await signVerificationAuthorization({
    entry, contractId: registry, method, args, address, networkPassphrase: net.passphrase, latestLedger: ledger,
    expirationLedger: ledger + MAX_AUTH_WINDOW_LEDGERS, signer: key,
  })];
}

/** A correctly signed call that must still fail inside the contract with `code`. */
async function expectSignedFailure<M extends VerificationAuthMethod>(
  method: M, args: VerificationArgs[M], key: Keypair, code: ContractErrorName, label: string,
) {
  const auth = await signedByHand(method, args, key);
  expectContractError(await enforce(method, encodeVerificationArgs(method, args), auth), code, label);
}

const enforce = async (method: VerificationAuthMethod, args: xdr.ScVal[], auth: Entry[]) =>
  net.simulate(await callTx(method, args, auth), 'enforce');

/** A publication signed by the provider as transaction source, from raw argument XDR. */
async function publishRaw(key: Keypair, value: xdr.ScVal) {
  const tx = await net.build(key, Operation.invokeContractFunction({
    contract: registry, function: 'publish', args: [value], auth: [],
  }));
  return net.simulate(tx, 'record');
}

function expectEvent(confirmed: Confirmed, topics: xdr.ScVal[], data: xdr.ScVal) {
  const events = contractEvents(confirmed);
  expect(events).toHaveLength(1);
  const { contractId, body } = events[0]!;
  expect(contractId && Address.contract(contractId.value).toString()).toBe(registry);
  expect(body.v0.topics.map((topic) => topic.toXdr('hex'))).toEqual(topics.map((topic) => topic.toXdr('hex')));
  expect(body.v0.data.toXdr('hex')).toBe(data.toXdr('hex'));
}

const assessmentTopics = (result: VerificationResult) => [
  xdr.ScVal.scvSymbol('assessment_v1'), xdr.ScVal.scvU64(result.agent_id),
  Address.fromString(result.provider).toScVal(),
];

async function publish(result: VerificationResult, key: Keypair) {
  const call = await verificationCall('publish', { result }, key);
  const confirmed = decodeVerification(returnValue(call.confirmed));
  expect(confirmed).toEqual(result);
  expectEvent(call.confirmed, assessmentTopics(result), encodeVerification(result));
  return call;
}

const key = (identity: AgentIdentity, who = provider) =>
  ({ agent_id: identity.agent_id, revision: identity.revision, provider: who.publicKey() });

async function fixture(scenario: FixtureScenario, identity: AgentIdentity, sequence: bigint, lifetime = HOUR) {
  const now = await ledgerTime();
  return fixtureResult(scenario, {
    agent_id: identity.agent_id, revision: identity.revision, provider: fixtureProvider.publicKey(), sequence,
    issued_at: now, expires_at: now + lifetime,
  });
}

/** A passing live-mode result from `provider` at the current ledger time, built directly rather than assessed. */
async function liveResult(identity: AgentIdentity, sequence: bigint, overrides: Partial<VerificationResult> = {}) {
  const now = await ledgerTime();
  const value = buildResult({
    agent_id: identity.agent_id, revision: identity.revision, provider: provider.publicKey(), sequence, mode: 'Live',
    checks: [
      { kind: 'Endpoint', outcome: 'Passed', score: 0 }, { kind: 'Metadata', outcome: 'Passed', score: 0 },
      { kind: 'SignerAccount', outcome: 'Passed', score: 0 },
    ],
    serious_wallet_risks: 0, evidence_hash: new Uint8Array(32).fill(Number(sequence % 255n) + 1), issued_at: now,
    expires_at: now + HOUR,
  });
  return { ...value, ...overrides };
}

/** Replace one field of an encoded result, producing argument XDR the SDK encoder would refuse to build. */
function patched(value: VerificationResult, field: string, replacement: xdr.ScVal) {
  const encoded = encodeVerification(value);
  if (encoded.type !== 'scvMap') throw new Error('Expected a map');
  return xdr.ScVal.scvMap((encoded.map ?? []).map((entry) =>
    entry.key.type === 'scvSymbol' && entry.key.sym.toString() === field
      ? new xdr.ScMapEntry({ key: entry.key, val: replacement }) : entry));
}

describe('verification registry on local Stellar', () => {
  beforeAll(async () => {
    net = await localNetwork();
    limits = await resourceLimits(net.server);
    await net.fund(admin, controller, signer, sponsor, provider, fixtureProvider, attacker);
    agentRegistry = await net.deploy(sponsor, readWasm('agent_registry'));
    stateDirectory = await mkdtemp(join(tmpdir(), 'verifier-local-'));
  }, TIMEOUT);

  afterAll(async () => {
    if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
  });

  it('deploys only with the admin constructor authorization and binds the agent registry', async () => {
    const wasm = readWasm('verification_registry');
    await net.upload(sponsor, wasm);
    const deployment = (deployer: Keypair) => Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()), wasmHash: hash(wasm), salt: Buffer.alloc(32, 7),
      constructorArgs: encodeVerificationConstructorArgs(admin.publicKey(), agentRegistry),
    });
    const sponsored = await net.build(sponsor, deployment(sponsor));
    successfulSimulation(await net.simulate(sponsored, 'record_allow_nonroot'));
    const unauthorized = await net.simulate(sponsored, 'enforce');
    expect(unauthorized).toHaveProperty('error', expect.stringMatching(/Error\(Auth,/));

    registry = await net.deploy(admin, wasm, encodeVerificationConstructorArgs(admin.publicKey(), agentRegistry));
    read = { server: net.server, contractId: registry, source: sponsor.publicKey(), networkPassphrase: net.passphrase };
    expect(await readVerificationAdmin(read)).toBe(admin.publicKey());
    expect(await readBoundAgentRegistry(read)).toBe(agentRegistry);
    verifier = {
      server: net.server, networkPassphrase: net.passphrase, agentRegistry, verificationRegistry: registry,
      provider: provider.publicKey(), reports: new ReportStore(join(stateDirectory, 'reports')),
      stateDirectory: join(stateDirectory, 'pending'), network: { resolver, transport },
    };

    agent = await agentCall('register', {
      controller: controller.publicKey(), signer: signer.publicKey(), metadata_uri: METADATA_URI,
      metadata_hash: Uint8Array.from(hash(Buffer.from(served))),
    }, [controller, signer]);
    expect(agent).toMatchObject({ agent_id: 1n, revision: 1n, disabled: false });
  }, TIMEOUT);

  it('approves providers with the admin authorization only, each bound to one mode', async () => {
    await expectRegistryError(readProvider(read, provider.publicKey()), 'NotFound');
    const args = { provider: provider.publicKey(), mode: 'Live' as const };
    const recording = successfulSimulation(await net.simulate(
      await net.build(sponsor, verificationOperation(registry, 'approve_provider', args)), 'record'));
    for (const [label, forger] of [['attacker', attacker], ['provider', provider], ['sponsor', sponsor]] as const) {
      const forged = await signVerificationAuthorization({
        entry: recording.result.auth[0]!, contractId: registry, method: 'approve_provider', args,
        address: admin.publicKey(), networkPassphrase: net.passphrase, latestLedger: recording.latestLedger,
        expirationLedger: recording.latestLedger + MAX_AUTH_WINDOW_LEDGERS, signer: forger,
      });
      const simulation = await enforce('approve_provider', encodeVerificationArgs('approve_provider', args), [forged]);
      assertAuthFailure(simulation, 'forged', admin.publicKey(), `${label} key signing as admin`);
    }

    const { confirmed } = await verificationCall('approve_provider', args, admin);
    const record = { mode: 'Live', approved: true } as const;
    expect(decodeProviderRecord(returnValue(confirmed))).toEqual(record);
    expectEvent(confirmed, [xdr.ScVal.scvSymbol('provider_v1'), Address.fromString(provider.publicKey()).toScVal()],
      encodeProviderRecord(record));
    await verificationCall('approve_provider', { provider: fixtureProvider.publicKey(), mode: 'Fixture' }, admin);
    expect(await readProvider(read, provider.publicKey())).toEqual(record);
    expect(await readProvider(read, fixtureProvider.publicKey())).toEqual({ mode: 'Fixture', approved: true });
    for (const mode of ['Live', 'Fixture'] as const) {
      await expectSignedFailure('approve_provider', { provider: provider.publicKey(), mode }, admin, 'Duplicate',
        `approve again as ${mode}`);
    }
  }, TIMEOUT);

  it('runs the limited verifier and publishes its result as the provider', async () => {
    const dryRun = await assess(verifier, { agentId: agent.agent_id });
    expect(dryRun.published).toBeUndefined();
    await expectRegistryError(readLatestResult(read, key(agent)), 'NotFound');

    const outcome = await assess(verifier, { agentId: agent.agent_id, publisher: provider, validitySeconds: HOUR });
    const result = outcome.assessment.result;
    expect(outcome.findings.map(({ kind, outcome: verdict }) => [kind, verdict])).toEqual([
      ['Metadata', 'Passed'], ['Endpoint', 'Passed'], ['SignerAccount', 'Passed'], ['SignerHistory', 'Inconclusive'],
      ['Code', 'Unsupported'], ['Media', 'Unsupported'], ['ThreatFeed', 'Unsupported'], ['Token', 'Unsupported'],
    ]);
    expect(result).toMatchObject({ sequence: 1n, mode: 'Live', risk_score: 0, serious_wallet_risks: 0 });
    expect(outcome.published?.result).toEqual(result);
    expect(await readCurrentResult(read, key(agent))).toEqual(result);
    // The evidence hash resolves to the stored report.
    expect(Uint8Array.from(hash(Buffer.from(await verifier.reports.load(result.evidence_hash)))))
      .toEqual(result.evidence_hash);
    const confirmed = await net.server.getTransaction(outcome.published!.hash);
    if (confirmed.status !== 'SUCCESS') throw new Error('Publication not confirmed');
    expectEvent(confirmed, assessmentTopics(result), encodeVerification(result));

    const requirement = { required_checks: ['Metadata', 'SignerAccount'] as const, max_age: HOUR, max_risk_score: 0 };
    expect(await checkVerification(read, key(agent), { ...requirement, required_checks: [...requirement.required_checks] }))
      .toEqual(result);
    for (const kind of ['SignerHistory', 'ThreatFeed', 'Token'] as const) {
      await expectRegistryError(checkVerification(read, key(agent), { ...requirement, required_checks: [kind] }),
        'VerificationDenied');
    }
  }, TIMEOUT);

  it('measures publication of an eight-check result within network limits', async () => {
    const result = await fixture('passing', agent, 1n);
    const { enforced, prepared, confirmed } = await publish(result, fixtureProvider);
    console.info('publish (eight checks)', { resultXdrBytes: encodeVerification(result).toXdr().length });
    assertResourceFit('publish (eight checks)', enforced, prepared, contractEvents(confirmed), limits);
  }, TIMEOUT);

  it('rejects publication by anyone other than an approved provider of the same mode', async () => {
    const result = await liveResult(agent, 2n);
    const args = encodeVerificationArgs('publish', { result });
    const recording = successfulSimulation(await net.simulate(await callTx('publish', args), 'record'));
    const forged = await signVerificationAuthorization({
      entry: recording.result.auth[0]!, contractId: registry, method: 'publish', args: { result },
      address: provider.publicKey(), networkPassphrase: net.passphrase, latestLedger: recording.latestLedger,
      expirationLedger: recording.latestLedger + MAX_AUTH_WINDOW_LEDGERS, signer: attacker,
    });
    assertAuthFailure(await enforce('publish', args, [forged]), 'forged', provider.publicKey(), 'attacker as provider');
    assertAuthFailure(await enforce('publish', args, []), 'missing', provider.publicKey(), 'no provider authorization');

    const unapproved = { ...result, provider: attacker.publicKey() };
    expectContractError(await publishRaw(attacker, encodeVerification(unapproved)), 'VerificationDenied', 'unapproved');
    const wrongMode = { ...result, mode: 'Fixture' as const };
    expectContractError(await publishRaw(provider, encodeVerification(wrongMode)), 'InvalidInput', 'live provider fixture');
    const fixtureAsLive = { ...(await fixture('passing', agent, 2n)), mode: 'Live' as const };
    expectContractError(await publishRaw(fixtureProvider, encodeVerification(fixtureAsLive)), 'InvalidInput', 'fixture as live');
    expect((await readLatestResult(read, key(agent))).sequence).toBe(1n);
  }, TIMEOUT);

  it('rejects malformed results inside the contract', async () => {
    const base = await liveResult(agent, 2n);
    const now = base.issued_at;
    const u32 = xdr.ScVal.scvU32;
    const cases: [string, xdr.ScVal, ContractErrorName][] = [
      ['aggregate does not match the scores', patched(base, 'risk_score', u32(1)), 'InvalidInput'],
      ['aggregate above 100', patched(base, 'risk_score', u32(101)), 'InvalidInput'],
      ['unknown risk flag', patched(base, 'serious_wallet_risks', u32(8)), 'InvalidInput'],
      ['schema version 2', patched(base, 'schema_version', u32(2)), 'UnsupportedVersion'],
      ['issued in the future', encodeVerification({ ...base, issued_at: now + 600n, expires_at: now + HOUR }), 'InvalidInput'],
      ['expiry at issue', encodeVerification({ ...base, expires_at: base.issued_at }), 'InvalidInput'],
      ['already expired', encodeVerification({ ...base, issued_at: now - 20n, expires_at: now - 10n }), 'Expired'],
      ['published revoked', encodeVerification({ ...base, revoked: true }), 'InvalidInput'],
      ['scored unsupported check', encodeVerification({
        ...base, checks: [...base.checks, { kind: 'Token', outcome: 'Unsupported', score: 0 }],
      }), 'InvalidInput'],
      ['unsorted checks', encodeVerification({ ...base, checks: [...base.checks].reverse() }), 'InvalidInput'],
    ];
    for (const [label, value, code] of cases) {
      expectContractError(await publishRaw(provider, value), code, label);
    }
    expect((await readLatestResult(read, key(agent))).sequence).toBe(1n);
  }, TIMEOUT);

  it('accepts only the next sequence with non-decreasing issue times', async () => {
    for (const sequence of [1n, 3n]) {
      expectContractError(await publishRaw(provider, encodeVerification(await liveResult(agent, sequence))),
        'InvalidSequence', `sequence ${sequence}`);
    }
    const latest = await readLatestResult(read, key(agent));
    const backwards = await liveResult(agent, 2n, { issued_at: latest.issued_at - 1n });
    expectContractError(await publishRaw(provider, encodeVerification(backwards)), 'InvalidSequence', 'backwards');
  }, TIMEOUT);

  it('lets a newer failure replace a pass and makes revocation terminal', async () => {
    const failure = await liveResult(agent, 2n);
    failure.checks = failure.checks.map((check) =>
      check.kind === 'Endpoint' ? { ...check, outcome: 'Failed', score: 100 } : check);
    failure.risk_score = 34;
    await publish(failure, provider);
    await expectRegistryError(checkVerification(read, key(agent), {
      required_checks: ['Endpoint'], max_age: HOUR, max_risk_score: 100,
    }), 'VerificationDenied');
    await expectRegistryError(checkVerification(read, key(agent), {
      required_checks: ['Metadata'], max_age: HOUR, max_risk_score: 33,
    }), 'VerificationDenied');
    expect(await readLatestResult(read, key(agent))).toEqual(failure);

    const revoke = { ...key(agent), sequence: 2n };
    const { auth } = await signed('revoke', revoke, attacker, provider.publicKey());
    assertAuthFailure(await enforce('revoke', encodeVerificationArgs('revoke', revoke), auth), 'forged',
      provider.publicKey(), 'attacker revoking');
    await expectSignedFailure('revoke', { ...revoke, sequence: 1n }, provider, 'InvalidSequence',
      'revoke a superseded result');

    const { confirmed } = await verificationCall('revoke', revoke, provider);
    const revoked = { ...failure, revoked: true };
    expect(decodeVerification(returnValue(confirmed))).toEqual(revoked);
    expectEvent(confirmed, assessmentTopics(revoked), encodeVerification(revoked));
    await expectRegistryError(readCurrentResult(read, key(agent)), 'Revoked');
    expect(await readLatestResult(read, key(agent))).toEqual(revoked);
    await expectSignedFailure('revoke', revoke, provider, 'Duplicate', 'revoke twice');

    // Only a fresh, higher-sequence assessment supersedes the revocation.
    const outcome = await assess(verifier, { agentId: agent.agent_id, publisher: provider, validitySeconds: HOUR });
    expect(outcome.assessment.result.sequence).toBe(3n);
    expect(await readCurrentResult(read, key(agent))).toEqual(outcome.assessment.result);
  }, TIMEOUT);

  it('denies a result at its expiry and beyond the maximum age, by ledger time', async () => {
    const result = await fixture('passing', agent, 2n, 6n);
    await publish(result, fixtureProvider);
    const requirement = { required_checks: ['Metadata' as const], max_age: HOUR, max_risk_score: 0 };
    expect(await checkVerification(read, key(agent, fixtureProvider), requirement)).toEqual(result);
    while (await ledgerTime() < result.issued_at + 2n) await new Promise((resolve) => setTimeout(resolve, 500));
    await expectRegistryError(checkVerification(read, key(agent, fixtureProvider), { ...requirement, max_age: 1n }),
      'Expired');
    while (await ledgerTime() < result.expires_at) await new Promise((resolve) => setTimeout(resolve, 500));
    await expectRegistryError(readCurrentResult(read, key(agent, fixtureProvider)), 'Expired');
    await expectRegistryError(checkVerification(read, key(agent, fixtureProvider), requirement), 'Expired');
  }, TIMEOUT);

  it('denies high-risk and seriously flagged fixture results whatever their timestamps', async () => {
    const requirement = { required_checks: ['Metadata' as const], max_age: HOUR, max_risk_score: 50 };
    const highRisk = await fixture('high-risk', agent, 3n);
    expect(highRisk.risk_score).toBe(100);
    await publish({ ...highRisk, checks: highRisk.checks }, fixtureProvider);
    await expectRegistryError(checkVerification(read, key(agent, fixtureProvider), requirement), 'VerificationDenied');
    const flagged = await fixture('serious-wallet-risk', agent, 4n);
    expect(flagged.risk_score).toBe(0);
    await publish(flagged, fixtureProvider);
    await expectRegistryError(checkVerification(read, key(agent, fixtureProvider), { ...requirement, max_risk_score: 100 }),
      'VerificationDenied');
  }, TIMEOUT);

  it('retires results and already signed publications when the identity changes', async () => {
    const pending = await liveResult(agent, 4n);
    const { auth, expirationLedger } = await signed('publish', { result: pending }, provider);
    successfulSimulation(await enforce('publish', encodeVerificationArgs('publish', { result: pending }), auth));

    served = metadataDocument(2);
    const updated = await agentCall('update_metadata', {
      agent_id: agent.agent_id, expected_revision: agent.revision, metadata_uri: METADATA_URI,
      metadata_hash: Uint8Array.from(hash(Buffer.from(served))),
    }, [controller]);
    expect(updated.revision).toBe(2n);
    expect(await net.latestLedger() + 2).toBeLessThanOrEqual(expirationLedger);
    expectContractError(await enforce('publish', encodeVerificationArgs('publish', { result: pending }), auth),
      'IdentityChanged', 'publication signed before the update');
    await expectRegistryError(readCurrentResult(read, key(agent)), 'IdentityChanged');
    await expectRegistryError(checkVerification(read, key(agent), {
      required_checks: ['Metadata'], max_age: HOUR, max_risk_score: 100,
    }), 'IdentityChanged');
    expect((await readLatestResult(read, key(agent))).revision).toBe(1n);

    // The new revision has no result until it is assessed, and its sequence starts again at 1.
    await expectRegistryError(readCurrentResult(read, key(updated)), 'NotFound');
    await expect(assess(verifier, { agentId: agent.agent_id, revision: agent.revision })).rejects
      .toHaveProperty('code', 'IdentityChanged');
    const fresh = await assess(verifier, { agentId: agent.agent_id, publisher: provider, validitySeconds: HOUR });
    expect(fresh.assessment.result).toMatchObject({ revision: 2n, sequence: 1n });
    expect(await readCurrentResult(read, key(updated))).toEqual(fresh.assessment.result);

    const disabled = await agentCall('disable', { agent_id: agent.agent_id, expected_revision: 2n }, [controller]);
    await expectRegistryError(readCurrentResult(read, key(updated)), 'IdentityChanged');
    await expectRegistryError(readCurrentResult(read, key(disabled)), 'Revoked');
    await expect(readCurrent({ ...read, contractId: agentRegistry }, agent.agent_id, disabled.revision))
      .rejects.toHaveProperty('code', 'Revoked');
    const reactivated = await agentCall('reactivate', { agent_id: agent.agent_id, expected_revision: 3n }, [controller]);
    await expectRegistryError(readCurrentResult(read, key(reactivated)), 'NotFound');
    agent = reactivated;
  }, TIMEOUT);

  it('blocks a disabled provider immediately and permanently', async () => {
    const result = await fixture('passing', agent, 1n);
    await publish(result, fixtureProvider);
    expect(await readCurrentResult(read, key(agent, fixtureProvider))).toEqual(result);

    const args = { provider: fixtureProvider.publicKey() };
    const { auth } = await signed('disable_provider', args, attacker, admin.publicKey());
    assertAuthFailure(await enforce('disable_provider', encodeVerificationArgs('disable_provider', args), auth),
      'forged', admin.publicKey(), 'attacker disabling');
    await verificationCall('disable_provider', args, admin);
    expect(await readProvider(read, fixtureProvider.publicKey())).toEqual({ mode: 'Fixture', approved: false });
    await expectRegistryError(readCurrentResult(read, key(agent, fixtureProvider)), 'Revoked');
    expectContractError(await publishRaw(fixtureProvider, encodeVerification(await fixture('passing', agent, 2n))),
      'Revoked', 'publish after disable');
    await expectSignedFailure('approve_provider', { provider: fixtureProvider.publicKey(), mode: 'Fixture' }, admin,
      'Revoked', 're-approval');
    await expectSignedFailure('disable_provider', args, admin, 'Duplicate', 'disable twice');
    expect(await readLatestResult(read, key(agent, fixtureProvider))).toEqual(result);
  }, TIMEOUT);
});
