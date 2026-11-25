import {
  Address, Operation, contract, hash, nativeToScVal, rpc, xdr, type Keypair,
} from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import { Sponsor, sponsorPolicy } from '../../packages/sdk/src/sponsor.js';
import { MemoryJournal, networkContext } from '../../packages/sdk/src/transactions.js';
import { verificationOperation } from '../../packages/sdk/src/verification.js';
import { assertResourceFit, resourceLimits } from '../local/phase1-resources.js';
import { contractEvents, readWasm, successfulSimulation } from './support/local-network.js';
import { DAY, UNIT, walletWorld, type WalletWorld } from './support/wallet-world.js';

/**
 * Spike (ADR 0006): a custom account that enforces a cut-down policy in `__check_auth` pays through a plain
 * `asset.transfer(account, payee, amount)`. The relayer and the asset know nothing about the account; the agent's
 * key signs the one authorization entry. This is the shape of an x402 `exact` payment on Stellar.
 */

const TIMEOUT = 240_000;
const AUTH_LEDGERS = 20;
const policyId = new Uint8Array(32).fill(1);

let w: WalletWorld;
let probe: string;
let spec: contract.Spec;

const address = (value: string) => Address.fromString(value).toScVal();
const unit = (tag: string) => ({ tag, values: undefined });

beforeAll(async () => {
  w = await walletWorld();
  const { net, roles: { sponsor, signer, provider, recipient, funder }, agent, agentRegistry, verificationRegistry,
    asset } = w;
  const wasm = readWasm('account_probe');
  spec = contract.Spec.fromWasm(wasm);
  probe = await net.deploy(sponsor, wasm, spec.funcArgsToScVals('__constructor', {
    config: {
      policy_id: Buffer.from(policyId), signer_key: signer.rawPublicKey(), agent_id: agent.agent_id,
      revision: agent.revision, agent_registry: agentRegistry, verification_registry: verificationRegistry,
      provider: provider.publicKey(), required_checks: [unit('Metadata'), unit('SignerAccount')],
      max_assessment_age: 30n * DAY, max_risk_score: 10, asset, per_transaction: 5n * UNIT, per_day: 20n * UNIT,
      recipients: [recipient.publicKey()],
    },
  }));
  // Fund the account with an ordinary transfer; a contract holds an asset balance without a trustline.
  await net.invoke(funder, transferOperation(funder.publicKey(), probe, 50n * UNIT));
}, TIMEOUT);

function transferOperation(from: string, to: string, amount: bigint, auth: xdr.SorobanAuthorizationEntry[] = []) {
  return Operation.invokeContractFunction({
    contract: w.asset, function: 'transfer',
    args: [address(from), address(to), nativeToScVal(amount, { type: 'i128' })], auth,
  });
}

const pay = (to: string, amount: bigint, auth: xdr.SorobanAuthorizationEntry[] = []) =>
  transferOperation(probe, to, amount, auth);

/** What recording mode asks the account to authorize for `operation`: one entry, for the account, with no children. */
async function recorded(operation: xdr.Operation) {
  const recording = successfulSimulation(await w.net.simulate(
    await w.net.build(w.roles.sponsor, operation), 'record'));
  expect(recording.result.auth).toHaveLength(1);
  const [entry] = recording.result.auth;
  const credentials = entry!.credentials;
  if (credentials.type !== 'sorobanCredentialsAddress') throw new Error('Expected address credentials');
  expect(Address.fromScAddress(credentials.address.address).toString()).toBe(probe);
  expect(entry!.rootInvocation.subInvocations).toHaveLength(0);
  return { entry: entry!, expiration: recording.latestLedger + AUTH_LEDGERS };
}

/**
 * Sign `entry` as the account expects: an ed25519 signature by `key` over the host's payload hash followed by the
 * policy ID, carried with the policy ID as the credential's signature value.
 */
function sign(
  entry: xdr.SorobanAuthorizationEntry, expiration: number, key: Keypair,
  options: { policy?: Uint8Array; bindPolicy?: boolean } = {},
) {
  const { policy = policyId, bindPolicy = true } = options;
  const credentials = entry.credentials;
  if (credentials.type !== 'sorobanCredentialsAddress') throw new Error('Expected address credentials');
  const { address: account, nonce } = credentials.address;
  const payload = hash(xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(w.net.passphrase)), nonce, signatureExpirationLedger: expiration,
      invocation: entry.rootInvocation,
    })).toXDR());
  const signature = key.sign(bindPolicy ? Buffer.concat([payload, Buffer.from(policy)]) : payload);
  const value = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('policy_id'), val: xdr.ScVal.scvBytes(Buffer.from(policy)) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('signature'), val: xdr.ScVal.scvBytes(signature) }),
  ]);
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      address: account, nonce, signatureExpirationLedger: expiration, signature: value,
    })),
    rootInvocation: entry.rootInvocation,
  });
}

async function signedPayment(to: string, amount: bigint, key = w.roles.signer, options: Parameters<typeof sign>[3] = {}) {
  const { entry, expiration } = await recorded(pay(to, amount));
  return sign(entry, expiration, key, options);
}

const enforce = async (operation: xdr.Operation) =>
  w.net.simulate(await w.net.build(w.roles.sponsor, operation), 'enforce');

const errorOf = (simulation: rpc.Api.SimulateTransactionResponse) => ('error' in simulation ? simulation.error : 'success');

async function spend() {
  const tx = await w.net.build(w.roles.sponsor, Operation.invokeContractFunction({
    contract: probe, function: 'spend', args: [],
  }));
  return spec.funcResToNative('spend', successfulSimulation(await w.net.simulate(tx, 'record')).result.retval) as
    { utc_day: bigint; amount: bigint; count: number };
}

describe('custom account spike', () => {
  it('pays a plain asset transfer under the policy, submitted by a relayer that authorizes nothing', async () => {
    const { net, roles: { sponsor, signer, recipient } } = w;
    const before = await w.balanceOf(recipient.publicKey());
    const entry = await signedPayment(recipient.publicKey(), 3n * UNIT, signer);
    const tx = await net.build(sponsor, pay(recipient.publicKey(), 3n * UNIT, [entry]));
    const enforced = successfulSimulation(await net.simulate(tx, 'enforce'));
    const { prepared, confirmed } = await net.submit(tx, enforced, sponsor);

    expect(await w.balanceOf(recipient.publicKey())).toBe(before + 3n * UNIT);
    expect(await w.balanceOf(probe)).toBe(47n * UNIT);
    expect(await spend()).toMatchObject({ amount: 3n * UNIT, count: 1 });
    // The relayer is only the fee-paying source: one operation, one entry, and that entry is the account's.
    expect(prepared.source).toBe(sponsor.publicKey());
    expect(prepared.operations).toHaveLength(1);
    // The account's own event, published from inside `__check_auth`, is in the transaction's events.
    const events = contractEvents(confirmed);
    const own = events.filter((event) => event.contractId
      && Address.contract(event.contractId.value).toString() === probe);
    expect(own).toHaveLength(1);
    assertResourceFit('Custom account transfer (registries consulted in __check_auth)', enforced, prepared, events,
      await resourceLimits(net.server));
  }, TIMEOUT);

  it('refuses what the policy, the key or the signed invocation does not cover', async () => {
    const { roles: { signer, recipient, stranger, attacker } } = w;
    const before = await spend();
    const to = recipient.publicKey();

    const cases: [string, xdr.Operation, RegExp][] = [
      ['over the per-payment cap', pay(to, 6n * UNIT, [await signedPayment(to, 6n * UNIT)]), /Error\(Contract, #3\)/],
      ['an unlisted recipient', pay(stranger.publicKey(), UNIT, [await signedPayment(stranger.publicKey(), UNIT)]),
        /Error\(Contract, #11\)/],
      ['another key', pay(to, UNIT, [await signedPayment(to, UNIT, attacker)]), /Error\(Crypto, InvalidInput\)/],
      ['a signature that does not cover the policy', pay(to, UNIT, [await signedPayment(to, UNIT, signer,
        { bindPolicy: false })]), /Error\(Crypto, InvalidInput\)/],
      ['another policy ID', pay(to, UNIT, [await signedPayment(to, UNIT, signer,
        { policy: new Uint8Array(32).fill(2) })]), /Error\(Contract, #11\)/],
      // The entry was signed for 3 units; the operation asks for 4.
      ['an amount other than the signed one', pay(to, 4n * UNIT, [await signedPayment(to, 3n * UNIT)]),
        /Error\(Auth, InvalidAction\)/],
      ['no entry', pay(to, UNIT), /Error\(Auth, InvalidAction\)/],
    ];
    for (const [label, operation, expected] of cases) {
      const error = errorOf(await enforce(operation));
      expect(error, label).toMatch(/^HostError: /);
      expect(error, label).toMatch(expected);
    }
    expect(await spend()).toEqual(before);
  }, TIMEOUT);

  it('is paid through the SDK sponsor unchanged, and a spent entry cannot be replayed', async () => {
    const { net, roles: { sponsor, recipient }, asset } = w;
    const context = await networkContext(net.server, net.passphrase);
    // The sponsor is configured for the asset's `transfer`. It has never heard of the account contract.
    const relayer = new Sponsor(context, keypairSigner(sponsor),
      sponsorPolicy([asset], { methods: ['transfer'], limits: { pollIntervalMs: 500 } }), new MemoryJournal());
    const before = await spend();
    const entry = await signedPayment(recipient.publicKey(), 2n * UNIT);
    const operation = pay(recipient.publicKey(), 2n * UNIT, [entry]);

    const result = await relayer.sponsor(operation.toXdr('base64'));
    expect(result.status).toBe('success');
    expect(await spend()).toMatchObject({ amount: before.amount + 2n * UNIT, count: before.count + 1 });

    // The host consumed the entry's nonce.
    expect(errorOf(await enforce(operation))).toMatch(/^HostError: Error\(Auth, ExistingValue\)/);
    expect((await spend()).count).toBe(before.count + 1);
  }, TIMEOUT);

  it('judges every payment against the live verification result', async () => {
    const { net, roles: { provider, recipient }, agent, verificationRegistry } = w;
    const before = await spend();
    // Signed while the result was current.
    const entry = await signedPayment(recipient.publicKey(), UNIT);
    await net.invoke(provider, verificationOperation(verificationRegistry, 'revoke', {
      agent_id: agent.agent_id, revision: agent.revision, provider: provider.publicKey(), sequence: 1n,
    }));
    const error = errorOf(await enforce(pay(recipient.publicKey(), UNIT, [entry])));
    expect(error).toMatch(/Error\(Contract, #8\)/);
    expect(await spend()).toEqual(before);
  }, TIMEOUT);
});
