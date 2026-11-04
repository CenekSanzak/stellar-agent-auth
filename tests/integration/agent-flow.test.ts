import { randomBytes } from 'node:crypto';
import { Address, Contract, Keypair, Operation, hash, xdr, type rpc } from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_AUTH_WINDOW_LEDGERS } from '../../packages/sdk/src/actions.js';
import {
  AgentRegistryError, contractErrorName, readAgent, readAgentCount, readCurrent, registryOperation,
  signRegistryAuthorization, type RegistryRead,
} from '../../packages/sdk/src/agents.js';
import { decodeIdentity, encodeIdentity, encodeRegistryArgs } from '../../packages/sdk/src/encoding.js';
import {
  MAX_METADATA_URI_BYTES,
  type AgentIdentity, type ContractErrorName, type RegistryArgs, type RegistryAuthMethod,
} from '../../packages/sdk/src/types.js';
import { exampleMetadata, metadataUriOfLength } from '../fixtures/agents.js';
import { assertResourceFit, resourceLimits } from '../local/phase1-resources.js';
import {
  assertAuthFailure, contractEvents, localNetwork, readWasm, returnValue, successfulSimulation,
  type Confirmed, type LocalNetwork,
} from './support/local-network.js';

type Entry = xdr.SorobanAuthorizationEntry;
const TIMEOUT = 120_000;
const DAY_IN_LEDGERS = 17_280;

// Separate roles, generated per run and funded by Friendbot. The sponsor only pays and signs envelopes.
const controller = Keypair.random();
const signer = Keypair.random();
const newSigner = Keypair.random();
const sponsor = Keypair.random();
const attacker = Keypair.random();
const roles = { controller: controller.publicKey(), signer: signer.publicKey() };
const v1 = exampleMetadata(1);
const v2 = exampleMetadata(2);
const v3 = exampleMetadata(3);

let net: LocalNetwork;
let limits: Awaited<ReturnType<typeof resourceLimits>>;
let registry: string;
let codeKey: xdr.LedgerKey;
let read: RegistryRead;
let registration: { args: RegistryArgs['register']; auth: Entry[]; expirationLedger: number };

const identityKey = (agentId: bigint) => xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
  contract: Address.fromString(registry).toScAddress(),
  key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Identity'), xdr.ScVal.scvU64(agentId)]),
  durability: xdr.ContractDataDurability.persistent,
}));

async function liveUntil(key: xdr.LedgerKey) {
  const [entry] = (await net.server.getLedgerEntries(key)).entries;
  if (entry?.liveUntilLedgerSeq === undefined) throw new Error('Missing live ledger entry');
  return entry.liveUntilLedgerSeq;
}

function credential(entry: Entry) {
  if (entry.credentials.type !== 'sorobanCredentialsAddress') throw new Error('Expected address credentials');
  return Address.fromScAddress(entry.credentials.address.address).toString();
}

/** Raw sponsor-sourced call. It bypasses SDK prechecks so the contract's own checks are exercised. */
const callTx = <M extends RegistryAuthMethod>(method: M, args: RegistryArgs[M], auth: Entry[] = []) =>
  net.build(sponsor, Operation.invokeContractFunction({
    contract: registry, function: method, args: encodeRegistryArgs(method, args), auth,
  }));

const enforce = async <M extends RegistryAuthMethod>(method: M, args: RegistryArgs[M], auth: Entry[]) =>
  net.simulate(await callTx(method, args, auth), 'enforce');

/** Recording-mode simulation of the SDK-checked operation. */
const recordCall = async <M extends RegistryAuthMethod>(method: M, args: RegistryArgs[M]) =>
  net.simulate(await net.build(sponsor, registryOperation(registry, method, args)), 'record');

const record = async <M extends RegistryAuthMethod>(method: M, args: RegistryArgs[M]) =>
  successfulSimulation(await recordCall(method, args));

/** Signs only through the SDK validator. `address` differs from the key's own address only when forging. */
const sign = <M extends RegistryAuthMethod>(
  entry: Entry, latestLedger: number, method: M, args: RegistryArgs[M], key: Keypair, address = key.publicKey(),
) => signRegistryAuthorization({
  entry, contractId: registry, method, args, address, networkPassphrase: net.passphrase,
  latestLedger, expirationLedger: latestLedger + MAX_AUTH_WINDOW_LEDGERS, signer: key,
});

/** Each key signs its own hand-built entry, for calls that recording mode refuses to simulate. */
async function signedByHand<M extends RegistryAuthMethod>(method: M, args: RegistryArgs[M], keys: Keypair[]) {
  const ledger = await net.latestLedger();
  return Promise.all(keys.map((key) => sign(new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      address: Address.fromString(key.publicKey()).toScAddress(), nonce: randomBytes(8).readBigInt64BE(),
      signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid(),
    })),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(registry).toScAddress(), functionName: method,
        args: encodeRegistryArgs(method, args),
      })),
      subInvocations: [],
    }),
  }), ledger, method, args, key)));
}

function expectContractError(simulation: rpc.Api.SimulateTransactionResponse, code: ContractErrorName, label: string) {
  expect('error' in simulation ? contractErrorName(simulation.error) : 'success', label).toBe(code);
}

async function expectRegistryError(promise: Promise<unknown>, code: ContractErrorName) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(AgentRegistryError);
  expect(error).toHaveProperty('code', code);
}

function precheck(run: () => unknown) {
  try {
    run();
    return 'built';
  } catch (error) {
    if (error instanceof AgentRegistryError) return error.code;
    throw error;
  }
}

function expectIdentityEvent(confirmed: Confirmed, identity: AgentIdentity) {
  const events = contractEvents(confirmed);
  expect(events).toHaveLength(1);
  const { contractId, body } = events[0]!;
  expect(contractId && Address.contract(contractId.value).toString()).toBe(registry);
  expect(body.v0.topics.map((topic) => topic.toXdr('hex'))).toEqual(
    [xdr.ScVal.scvSymbol('identity_v1'), xdr.ScVal.scvU64(identity.agent_id)].map((topic) => topic.toXdr('hex')),
  );
  expect(body.v0.data.toXdr('hex')).toBe(encodeIdentity(identity).toXdr('hex'));
}

/** Record, have each role sign its own entry via the SDK, enforce, submit as sponsor and read back. */
async function mutate<M extends RegistryAuthMethod>(method: M, args: RegistryArgs[M], keys: Keypair[]) {
  const recording = await record(method, args);
  expect(recording.result.auth.map(credential), method).toEqual(keys.map((key) => key.publicKey()));
  const auth = await Promise.all(recording.result.auth.map((entry, i) =>
    sign(entry, recording.latestLedger, method, args, keys[i]!)));
  const tx = await callTx(method, args, auth);
  const enforced = successfulSimulation(await net.simulate(tx, 'enforce'));
  const { confirmed, prepared } = await net.submit(tx, enforced, sponsor);
  expect(prepared.source).toBe(sponsor.publicKey());
  expect(prepared.signatures).toHaveLength(1);
  const identity = decodeIdentity(returnValue(confirmed));
  const stored = await readAgent(read, identity.agent_id);
  expect(stored).toEqual(identity);
  expectIdentityEvent(confirmed, stored);
  return { identity, auth, enforced, prepared, confirmed, expirationLedger: recording.latestLedger + MAX_AUTH_WINDOW_LEDGERS };
}

function measure(label: string, { identity, enforced, prepared, confirmed }: Awaited<ReturnType<typeof mutate>>) {
  console.info(label, {
    metadataUriBytes: identity.metadata_uri.length, identityXdrBytes: encodeIdentity(identity).toXdr().length,
  });
  assertResourceFit(label, enforced, prepared, contractEvents(confirmed), limits);
}

describe('agent registry on local Stellar', () => {
  beforeAll(async () => {
    net = await localNetwork();
    limits = await resourceLimits(net.server);
    await net.fund(controller, signer, newSigner, sponsor, attacker);
    const wasm = readWasm('agent_registry');
    registry = await net.deploy(sponsor, wasm);
    codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: hash(wasm) }));
    read = { server: net.server, contractId: registry, source: sponsor.publicKey(), networkPassphrase: net.passphrase };
  }, TIMEOUT);

  it('extends the new instance and WASM to 30 days on the first submitted call', async () => {
    const instanceKey = new Contract(registry).getFootprint();
    const before = await liveUntil(instanceKey);
    const result = await net.invoke(sponsor, registryOperation(registry, 'agent_count', {}));
    expect(returnValue(result.confirmed).toXdr('hex')).toBe(xdr.ScVal.scvU64(0n).toXdr('hex'));
    const { ledger } = result.confirmed;
    expect(before).toBeLessThan(ledger + 29 * DAY_IN_LEDGERS);
    expect(await liveUntil(instanceKey)).toBe(ledger + 30 * DAY_IN_LEDGERS);
    // Exact on a fresh network; the code entry is shared with earlier runs on a reused one.
    expect(await liveUntil(codeKey)).toBeGreaterThanOrEqual(ledger + 29 * DAY_IN_LEDGERS);
    assertResourceFit('first registry call (instance and WASM TTL extension)',
      result.simulation, result.prepared, contractEvents(result.confirmed), limits);
  }, TIMEOUT);

  it('registers with controller authorization and signer proof, then reads the identity back', async () => {
    expect(await readAgentCount(read)).toBe(0n);
    await expectRegistryError(readAgent(read, 1n), 'NotFound');
    const args = { ...roles, metadata_uri: v1.uri, metadata_hash: v1.hash };
    const result = await mutate('register', args, [controller, signer]);
    expect(result.identity).toEqual({ agent_id: 1n, ...args, revision: 1n, disabled: false });
    expect(await readCurrent(read, 1n, 1n)).toEqual(result.identity);
    expect(await readAgentCount(read)).toBe(1n);
    expect(await liveUntil(identityKey(1n))).toBe(result.confirmed.ledger + 30 * DAY_IN_LEDGERS);
    measure('register (representative)', result);
    registration = { args, auth: result.auth, expirationLedger: result.expirationLedger };
  }, TIMEOUT);

  it('rejects reuse of a confirmed registration authorization', async () => {
    expect(await net.latestLedger()).toBeLessThanOrEqual(registration.expirationLedger);
    assertAuthFailure(await enforce('register', registration.args, registration.auth), 'replayed registration');
    expect(await readAgentCount(read)).toBe(1n);
  }, TIMEOUT);

  it('rejects registration without both role authorizations or with invalid roles', async () => {
    const args = { ...roles, metadata_uri: v2.uri, metadata_hash: v2.hash };
    const recording = await record('register', args);
    const [controllerEntry, signerEntry] = recording.result.auth;
    const at = recording.latestLedger;
    const controllerAuth = await sign(controllerEntry!, at, 'register', args, controller);
    const signerAuth = await sign(signerEntry!, at, 'register', args, signer);
    const forgedSigner = await sign(signerEntry!, at, 'register', args, controller, signer.publicKey());
    assertAuthFailure(await enforce('register', args, [controllerAuth]), 'no signer proof');
    assertAuthFailure(await enforce('register', args, [controllerAuth, forgedSigner]), 'signer entry signed by controller key');
    assertAuthFailure(await enforce('register', args, [signerAuth]), 'no controller authorization');
    for (const [label, role] of [['controller as signer', controller.publicKey()], ['contract signer', registry]] as const) {
      const invalid = { ...args, signer: role };
      expect(precheck(() => registryOperation(registry, 'register', invalid)), label).toBe('InvalidInput');
      expectContractError(await net.simulate(await callTx('register', invalid), 'record'), 'InvalidInput', label);
    }
    expect(await readAgentCount(read)).toBe(1n);
  }, TIMEOUT);

  it('rejects malformed metadata before signing and on chain', async () => {
    const before = await readAgent(read, 1n);
    const cases: [string, string, Uint8Array, ContractErrorName][] = [
      ['2,049-byte URI', metadataUriOfLength(MAX_METADATA_URI_BYTES + 1), v2.hash, 'LimitExceeded'],
      ['http URI', v2.uri.replace('https://', 'http://'), v2.hash, 'InvalidInput'],
      ['zero hash', v2.uri, new Uint8Array(32), 'InvalidInput'],
    ];
    for (const [label, metadata_uri, metadata_hash, code] of cases) {
      const register = { ...roles, metadata_uri, metadata_hash };
      const update = { agent_id: 1n, expected_revision: before.revision, metadata_uri, metadata_hash };
      expect(precheck(() => registryOperation(registry, 'register', register)), label).toBe(code);
      expect(precheck(() => registryOperation(registry, 'update_metadata', update)), label).toBe(code);
      // Correctly signed calls from raw arguments still fail inside the contract.
      const registerAuth = await signedByHand('register', register, [controller, signer]);
      expectContractError(await enforce('register', register, registerAuth), code, `register: ${label}`);
      const updateAuth = await signedByHand('update_metadata', update, [controller]);
      expectContractError(await enforce('update_metadata', update, updateAuth), code, `update: ${label}`);
    }
    expect(await readAgentCount(read)).toBe(1n);
    expect(await readAgent(read, 1n)).toEqual(before);
  }, TIMEOUT);

  it('registers a 2,048-byte metadata URI within network limits', async () => {
    const args = { ...roles, metadata_uri: metadataUriOfLength(MAX_METADATA_URI_BYTES), metadata_hash: v1.hash };
    const result = await mutate('register', args, [controller, signer]);
    expect(result.identity).toEqual({ agent_id: 2n, ...args, revision: 1n, disabled: false });
    expect(await readAgentCount(read)).toBe(2n);
    measure('register with a 2,048-byte metadata URI', result);
  }, TIMEOUT);

  it('rejects updates, rotation and disabling authorized by anyone but the controller', async () => {
    const before = await readAgent(read, 1n);
    const update = { agent_id: 1n, expected_revision: before.revision, metadata_uri: v2.uri, metadata_hash: v2.hash };
    const recording = await record('update_metadata', update);
    expect(recording.result.auth.map(credential)).toEqual([controller.publicKey()]);
    const entry = recording.result.auth[0]!;
    for (const [label, key] of [['attacker', attacker], ['agent signer', signer], ['sponsor', sponsor]] as const) {
      const forged = await sign(entry, recording.latestLedger, 'update_metadata', update, key, controller.publicKey());
      const simulation = await enforce('update_metadata', update, [forged]);
      assertAuthFailure(simulation, `${label} key signing as controller`);
      // The host's account check logs an internal code that must not read as a registry error.
      expect('error' in simulation && contractErrorName(simulation.error), label).toBeUndefined();
    }
    const attackerAuth = await signedByHand('update_metadata', update, [attacker]);
    assertAuthFailure(await enforce('update_metadata', update, attackerAuth), 'attacker credential');
    const sourceOnly = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: entry.rootInvocation,
    });
    assertAuthFailure(await enforce('update_metadata', update, [sourceOnly]), 'sponsor source account');

    const disable = { agent_id: 1n, expected_revision: before.revision };
    const disabling = await record('disable', disable);
    const forgedDisable = await sign(
      disabling.result.auth[0]!, disabling.latestLedger, 'disable', disable, attacker, controller.publicKey(),
    );
    assertAuthFailure(await enforce('disable', disable, [forgedDisable]), 'attacker disable');
    const rotate = { agent_id: 1n, expected_revision: before.revision, new_signer: attacker.publicKey() };
    const rotating = await record('rotate_signer', rotate);
    const rotateAuth = await Promise.all(rotating.result.auth.map((item) =>
      sign(item, rotating.latestLedger, 'rotate_signer', rotate, attacker, credential(item))));
    assertAuthFailure(await enforce('rotate_signer', rotate, rotateAuth), 'attacker rotating to its own key');
    expect(await readAgent(read, 1n)).toEqual(before);
  }, TIMEOUT);

  it('updates metadata, increments the revision and retires the old revision', async () => {
    const before = await readAgent(read, 1n);
    const update = { agent_id: 1n, expected_revision: 1n, metadata_uri: v2.uri, metadata_hash: v2.hash };
    const { identity } = await mutate('update_metadata', update, [controller]);
    expect(identity).toEqual({ ...before, metadata_uri: v2.uri, metadata_hash: v2.hash, revision: 2n });
    expect(await readCurrent(read, 1n, 2n)).toEqual(identity);
    await expectRegistryError(readCurrent(read, 1n, 1n), 'IdentityChanged');
    expectContractError(await recordCall('update_metadata', { ...update, expected_revision: 2n }), 'Duplicate', 'same metadata');
  }, TIMEOUT);

  it('rotates the signer only with the new signer authorization', async () => {
    const rotate = { agent_id: 1n, expected_revision: 2n, new_signer: newSigner.publicKey() };
    const recording = await record('rotate_signer', rotate);
    const [controllerEntry, newSignerEntry] = recording.result.auth;
    const at = recording.latestLedger;
    const controllerAuth = await sign(controllerEntry!, at, 'rotate_signer', rotate, controller);
    const forged = await sign(newSignerEntry!, at, 'rotate_signer', rotate, controller, newSigner.publicKey());
    assertAuthFailure(await enforce('rotate_signer', rotate, [controllerAuth]), 'no new signer proof');
    assertAuthFailure(await enforce('rotate_signer', rotate, [controllerAuth, forged]), 'new signer entry signed by controller key');

    const before = await readAgent(read, 1n);
    const { identity } = await mutate('rotate_signer', rotate, [controller, newSigner]);
    expect(identity).toEqual({ ...before, signer: newSigner.publicKey(), revision: 3n });
    await expectRegistryError(readCurrent(read, 1n, 2n), 'IdentityChanged');
    expectContractError(await recordCall('rotate_signer', { ...rotate, expected_revision: 3n }), 'Duplicate', 'current signer');
    expectContractError(
      await recordCall('rotate_signer', { ...rotate, expected_revision: 3n, new_signer: controller.publicKey() }),
      'InvalidInput', 'controller as signer',
    );
  }, TIMEOUT);

  it('disables and reactivates with new revisions and rejects requests signed for older ones', async () => {
    const stale = { agent_id: 1n, expected_revision: 3n, metadata_uri: v3.uri, metadata_hash: v3.hash };
    const recording = await record('update_metadata', stale);
    const staleAuth = [await sign(recording.result.auth[0]!, recording.latestLedger, 'update_metadata', stale, controller)];
    successfulSimulation(await enforce('update_metadata', stale, staleAuth));

    const { identity: disabled } = await mutate('disable', { agent_id: 1n, expected_revision: 3n }, [controller]);
    expect(disabled).toMatchObject({ signer: newSigner.publicKey(), revision: 4n, disabled: true });
    expect(await net.latestLedger()).toBeLessThanOrEqual(recording.latestLedger + MAX_AUTH_WINDOW_LEDGERS);
    expectContractError(await enforce('update_metadata', stale, staleAuth), 'IdentityChanged', 'update signed before disable');
    await expectRegistryError(readCurrent(read, 1n, 4n), 'Revoked');
    await expectRegistryError(readCurrent(read, 1n, 3n), 'IdentityChanged');
    expectContractError(await recordCall('disable', { agent_id: 1n, expected_revision: 4n }), 'Duplicate', 'disable twice');

    const { identity: active } = await mutate('reactivate', { agent_id: 1n, expected_revision: 4n }, [controller]);
    expect(active).toEqual({ ...disabled, revision: 5n, disabled: false });
    expect(await readCurrent(read, 1n, 5n)).toEqual(active);
    for (const revision of [1n, 2n, 3n, 4n]) await expectRegistryError(readCurrent(read, 1n, revision), 'IdentityChanged');
    // Reactivation revives no earlier revision, even for a freshly signed request.
    const freshAuth = await signedByHand('update_metadata', stale, [controller]);
    expectContractError(await enforce('update_metadata', stale, freshAuth), 'IdentityChanged', 'pre-disable revision');
    expectContractError(await recordCall('reactivate', { agent_id: 1n, expected_revision: 5n }), 'Duplicate', 'reactivate twice');
    expect(await readAgentCount(read)).toBe(2n);
  }, TIMEOUT);
});
