import {
  Address, Operation, authorizeEntry, contract, nativeToScVal, rpc, scValToNative, xdr, type Keypair,
} from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  accountPaymentAction, accountPaymentOperation, signAccountPayment, type AccountPayment,
} from '../../packages/sdk/src/account.js';
import { accountPaymentInvocation } from '../../packages/sdk/src/client.js';
import { encodeAccountSignature } from '../../packages/sdk/src/encoding.js';
import { WalletError } from '../../packages/sdk/src/policies.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import { Sponsor, signForSponsor, sponsorPolicy, sponsoredInvoke } from '../../packages/sdk/src/sponsor.js';
import {
  MemoryJournal, networkContext, pipelineLimits, type NetworkContext,
} from '../../packages/sdk/src/transactions.js';
import type { ContractErrorName, Hash32 } from '../../packages/sdk/src/types.js';
import { readPaymentCheck, readPolicyState } from '../../packages/sdk/src/wallet.js';
import { assertResourceFit, resourceLimits } from '../local/phase1-resources.js';
import { contractEvents, readWasm, successfulSimulation } from './support/local-network.js';
import { UNIT, unsignedEntry, walletWorld, type WalletWorld } from './support/wallet-world.js';

/**
 * A30 on the local network: the smart wallet pays as a custom account. The agent's key signs the wallet's one
 * authorization entry, and a sponsor that knows nothing about the wallet submits it. Two shapes are paid: a plain
 * `asset.transfer(wallet, payee, amount)`, and a service's own call with the transfer inside it. Both payment paths
 * draw on one budget, and everything else the wallet is asked to authorize is refused.
 */

const TIMEOUT = 240_000;
const AUTH_LEDGERS = 20;
const limits = pipelineLimits({ pollIntervalMs: 500 });

let w: WalletWorld;
let context: NetworkContext;
let policyHash: Hash32;

beforeAll(async () => {
  w = await walletWorld();
  context = await networkContext(w.net.server, w.net.passphrase);
  await w.fund(100n * UNIT);
  policyHash = await w.approve(await w.policy(1));
}, TIMEOUT);

const agent = () => keypairSigner(w.roles.signer);
const payment = (amount: bigint, overrides: Partial<AccountPayment> = {}): AccountPayment => ({
  wallet: w.wallet, policyHash, asset: w.asset, recipient: w.roles.recipient.publicKey(), amount, ...overrides,
});

/** The relayer: sponsors the asset's `transfer` and nothing of the wallet's. */
const relayer = () => new Sponsor(context, keypairSigner(w.roles.sponsor),
  sponsorPolicy([w.asset], { methods: ['transfer'], limits: { pollIntervalMs: 500 } }), new MemoryJournal());

/** The full client path: record, sign as the agent, and hand the signed operation to the sponsor. */
async function pay(amount: bigint) {
  const operation = await signForSponsor(context, w.roles.sponsor.publicKey(),
    accountPaymentInvocation(context, payment(amount), agent()), limits);
  const outcome = await sponsoredInvoke(context, relayer(), operation, new MemoryJournal(), 'account:test');
  expect(outcome.status).toBe('success');
  return { operation, outcome };
}

/** The host payload hash of a signed entry, which the wallet records as the payment's `authorization`. */
async function payloadOf(entry: xdr.SorobanAuthorizationEntry): Promise<Hash32> {
  const { credentials } = entry;
  if (credentials.type !== 'sorobanCredentialsAddress') throw new Error('Expected address credentials');
  let payload: Uint8Array | undefined;
  await authorizeEntry(entry, async (_preimage, value) => {
    payload = value;
    return { signatureScVal: credentials.address.signature };
  }, credentials.address.signatureExpirationLedger, w.net.passphrase, w.wallet);
  return payload!;
}

const entriesOf = (operation: xdr.Operation) =>
  (operation.body.type === 'invokeHostFunction' ? operation.body.invokeHostFunctionOp.auth : []);

/**
 * A wallet entry for `contract.method(args)` signed by `key` for `policy`, built by hand. Recording mode returns
 * no entries for a call the wallet refuses, and the SDK signer refuses anything but a payment, so refusals are
 * signed here the way a hostile client would.
 */
async function handSigned(
  contract: string, method: string, args: xdr.ScVal[], key: Keypair = w.roles.signer, policy: Hash32 = policyHash,
) {
  const expiration = await w.net.latestLedger() + AUTH_LEDGERS;
  return authorizeEntry(unsignedEntry(w.wallet, contract, method, args), async (_preimage, payload) => {
    const signature = key.sign(Buffer.concat([Buffer.from(payload), Buffer.from(policy)]));
    return { signatureScVal: encodeAccountSignature(policy, signature) };
  }, expiration, w.net.passphrase, w.wallet);
}

const transferArgs = (to: string, amount: bigint, from = w.wallet) =>
  [Address.fromString(from).toScVal(), Address.fromString(to).toScVal(), nativeToScVal(amount, { type: 'i128' })];

const enforce = async (contract: string, method: string, args: xdr.ScVal[], auth: xdr.SorobanAuthorizationEntry[]) =>
  w.net.simulate(await w.net.build(w.roles.sponsor,
    Operation.invokeContractFunction({ contract, function: method, args, auth })), 'enforce');

function expectAuthRefusal(simulation: rpc.Api.SimulateTransactionResponse, label: string, reason?: RegExp) {
  const error = 'error' in simulation ? simulation.error : 'success';
  expect(error, label).toMatch(/^HostError: Error\(Auth, InvalidAction\)/);
  if (reason) expect(error, label).toMatch(reason);
}

async function expectCheck(overrides: Partial<AccountPayment> & { amount: bigint }, code: ContractErrorName) {
  const asked = payment(overrides.amount, overrides);
  const refusal = await readPaymentCheck(w.read, { policy_hash: asked.policyHash, action: accountPaymentAction(asked) })
    .catch((error: unknown) => error);
  expect(refusal, code).toBeInstanceOf(WalletError);
  expect(refusal, code).toHaveProperty('code', code);
}

describe('account payment path', () => {
  it('pays a plain transfer through a sponsor that authorizes nothing, and records it', async () => {
    const { roles: { signer, sponsor, recipient }, read, asset } = w;
    const before = await w.snapshot(policyHash);
    // The wallet says in advance what the payment would leave.
    const preview = await readPaymentCheck(read,
      { policy_hash: policyHash, action: accountPaymentAction(payment(3n * UNIT)) });
    expect(preview.daily_spend).toEqual([{ asset, amount: 3n * UNIT }]);

    const { operation, outcome } = await pay(3n * UNIT);

    const after = await w.snapshot(policyHash);
    expect(after.recipient).toBe(before.recipient + 3n * UNIT);
    expect(after.wallet).toBe(before.wallet - 3n * UNIT);
    // The spend is charged. The policy sequence, which orders `execute` requests, is untouched.
    expect(after.state).toEqual({ ...before.state, daily_spend: [{ asset, amount: 3n * UNIT }] });
    expect(after.state).toEqual(preview);

    // One operation from the sponsor, carrying one entry, and that entry is the wallet's own.
    const envelope = xdr.TransactionEnvelope.fromXdr(outcome.record.envelope, 'base64');
    if (envelope.type !== 'envelopeTypeTx') throw new Error('Expected a v1 envelope');
    expect(outcome.record.source).toBe(sponsor.publicKey());
    expect(envelope.v1.tx.operations).toHaveLength(1);
    const [entry] = entriesOf(operation);
    expect(entriesOf(operation)).toHaveLength(1);
    expect(entry!.rootInvocation.subInvocations).toHaveLength(0);

    // The audit chain has one more entry: the payment, by the agent, naming this authorization.
    const confirmed = outcome.response as rpc.Api.GetSuccessfulTransactionResponse;
    await w.expectAudit(confirmed, before.head, signer.publicKey(), [{
      kind: 'AccountPayment', policy_hash: policyHash, authorization: await payloadOf(entry!),
      action: accountPaymentAction(payment(3n * UNIT)),
    }]);

    const tx = await w.net.build(sponsor, accountPaymentOperation(payment(1n)));
    const signedOne = await signAccountPayment({
      entry: successfulSimulation(await w.net.simulate(tx, 'record')).result.auth[0]!, payment: payment(1n),
      agent: agent(), networkPassphrase: w.net.passphrase, latestLedger: await w.net.latestLedger(),
      expirationLedger: await w.net.latestLedger() + AUTH_LEDGERS,
    });
    const measured = await w.net.build(sponsor, Operation.invokeContractFunction({
      contract: asset, function: 'transfer', args: transferArgs(recipient.publicKey(), 1n), auth: [signedOne],
    }));
    assertResourceFit('Wallet account payment', successfulSimulation(await w.net.simulate(measured, 'enforce')),
      measured, contractEvents(confirmed), await resourceLimits(w.net.server));
  }, TIMEOUT);

  it('charges the same budget as execute', async () => {
    const { roles: { recipient } } = w;
    const sequence = async () => (await readPolicyState(w.read, policyHash)).next_sequence;
    // 3 units are spent. `execute` and the account path take turns up to the 20-unit day.
    await w.execute(await w.payment(policyHash, await sequence(), 5n * UNIT));
    await pay(5n * UNIT);
    await w.execute(await w.payment(policyHash, await sequence(), 5n * UNIT));
    const state = await readPolicyState(w.read, policyHash);
    expect(state.daily_spend).toEqual([{ asset: w.asset, amount: 18n * UNIT }]);

    // Two units are left, whichever path asks.
    await expectCheck({ amount: 2n * UNIT + 1n }, 'DailyLimitExceeded');
    await w.expectRejected(await w.payment(policyHash, await sequence(), 2n * UNIT + 1n), 'DailyLimitExceeded',
      'execute over the shared budget');
    expectAuthRefusal(await enforce(w.asset, 'transfer', transferArgs(recipient.publicKey(), 2n * UNIT + 1n),
      [await handSigned(w.asset, 'transfer', transferArgs(recipient.publicKey(), 2n * UNIT + 1n))]),
    'account path over the shared budget', /Error\(Contract, #28\)/);
    await pay(2n * UNIT);
    await expectCheck({ amount: 1n }, 'DailyLimitExceeded');
    await w.expectRejected(await w.payment(policyHash, await sequence(), 1n), 'DailyLimitExceeded',
      'execute after the account path used the last unit');
    expect((await readPolicyState(w.read, policyHash)).daily_spend).toEqual([{ asset: w.asset, amount: 20n * UNIT }]);
  }, TIMEOUT);

  it('refuses everything but a transfer of its own funds that the policy and the agent key cover', async () => {
    const { roles: { recipient, stranger, attacker }, asset } = w;
    // A second policy with room left, so the refusals below are not the spent budget of the first.
    const roomy = await w.approve(await w.policy(2));
    const before = await w.snapshot(roomy);
    const to = recipient.publicKey();
    const refused = async (label: string, contract: string, method: string, args: xdr.ScVal[],
      auth: xdr.SorobanAuthorizationEntry[], reason?: RegExp) =>
      expectAuthRefusal(await enforce(contract, method, args, auth), label, reason);

    await refused('over the per-payment cap', asset, 'transfer', transferArgs(to, 6n * UNIT),
      [await handSigned(asset, 'transfer', transferArgs(to, 6n * UNIT), undefined, roomy)], /Error\(Contract, #27\)/);
    await refused('an unlisted recipient', asset, 'transfer', transferArgs(stranger.publicKey(), UNIT),
      [await handSigned(asset, 'transfer', transferArgs(stranger.publicKey(), UNIT), undefined, roomy)],
      /Error\(Contract, #26\)/);
    await refused('another key', asset, 'transfer', transferArgs(to, UNIT),
      [await handSigned(asset, 'transfer', transferArgs(to, UNIT), attacker, roomy)], /Error\(Crypto, InvalidInput\)/);
    await refused('a policy this wallet does not hold', asset, 'transfer', transferArgs(to, UNIT),
      [await handSigned(asset, 'transfer', transferArgs(to, UNIT), undefined, new Uint8Array(32).fill(9))],
      /Error\(Contract, #5\)/);
    // An allowance would let the spender take funds later, outside every cap.
    const approval = [Address.fromString(w.wallet).toScVal(), Address.fromString(attacker.publicKey()).toScVal(),
      nativeToScVal(UNIT, { type: 'i128' }), nativeToScVal(await w.net.latestLedger() + 1_000, { type: 'u32' })];
    await refused('an allowance', asset, 'approve', approval,
      [await handSigned(asset, 'approve', approval, undefined, roomy)], /Error\(Contract, #11\)/);
    // The entry was signed for one unit; the operation asks for two.
    await refused('an amount other than the signed one', asset, 'transfer', transferArgs(to, 2n * UNIT),
      [await handSigned(asset, 'transfer', transferArgs(to, UNIT), undefined, roomy)]);
    await refused('no entry', asset, 'transfer', transferArgs(to, UNIT), []);

    // The wallet explains the policy refusals itself, without any signature.
    await expectCheck({ amount: 6n * UNIT, policyHash: roomy }, 'PaymentLimitExceeded');
    await expectCheck({ amount: UNIT, policyHash: roomy, recipient: stranger.publicKey() }, 'RecipientNotAllowed');
    await expectCheck({ amount: UNIT, policyHash: new Uint8Array(32).fill(9) }, 'NotFound');
    expect(await w.snapshot(roomy)).toEqual(before);
  }, TIMEOUT);

  it('judges a payment signed earlier against the pause and the revocation that came after', async () => {
    const { roles: { recipient } } = w;
    const policy = await w.approve(await w.policy(3));
    const to = recipient.publicKey();
    const signed = await handSigned(w.asset, 'transfer', transferArgs(to, UNIT), undefined, policy);
    const attempt = () => enforce(w.asset, 'transfer', transferArgs(to, UNIT), [signed]);
    expect('error' in await attempt()).toBe(false);

    await w.ownerCall('pause', {});
    expectAuthRefusal(await attempt(), 'paused', /Error\(Contract, #12\)/);
    await expectCheck({ amount: UNIT, policyHash: policy }, 'Paused');
    await w.ownerCall('resume', {});
    expect('error' in await attempt()).toBe(false);

    await w.ownerCall('revoke_policy', { policy_hash: policy });
    expectAuthRefusal(await attempt(), 'revoked', /Error\(Contract, #8\)/);
    await expectCheck({ amount: UNIT, policyHash: policy }, 'Revoked');
  }, TIMEOUT);

  it('pays a service in the service\'s own call, and only in that shape', async () => {
    const { roles: { signer, sponsor, recipient, attacker }, asset, read } = w;
    // A service selling for 3 units, paid to the policy's recipient, and a policy that permits it.
    const wasm = readWasm('demo_service');
    const spec = contract.Spec.fromWasm(wasm);
    const serviceId = new Uint8Array(32).fill(7);
    const service = await w.net.deploy(sponsor, wasm, spec.funcArgsToScVals('__constructor', {
      terms: { asset, payee: recipient.publicKey(), price: 3n * UNIT, service_id: Buffer.from(serviceId) },
    }));
    const rule = { contract: service, service_id: serviceId };
    const policy = await w.approve(await w.policy(4, { action_kinds: ['ServicePayment', 'Transfer'], service: rule }));
    const purchase = payment(3n * UNIT, { policyHash: policy, service: rule });
    const receipts = async () => scValToNative(successfulSimulation(await w.net.simulate(await w.net.build(sponsor,
      Operation.invokeContractFunction({ contract: service, function: 'receipts', args: [] })), 'record'))
      .result.retval) as bigint;

    const before = await w.snapshot(policy);
    await readPaymentCheck(read, { policy_hash: policy, action: accountPaymentAction(purchase) });
    const sign = () => signForSponsor(context, sponsor.publicKey(),
      accountPaymentInvocation(context, purchase, agent()), limits);

    // An entry signed for the purchase is rooted at the service call: it does not authorize the transfer alone,
    // so the payment cannot be taken without the service running.
    const [unused] = entriesOf(await sign());
    expect(unused!.rootInvocation.subInvocations).toHaveLength(1);
    expectAuthRefusal(await enforce(asset, 'transfer', transferArgs(recipient.publicKey(), 3n * UNIT), [unused!]),
      'the transfer without the service call');

    // The sponsor is configured for the service's method only. It knows nothing about the wallet.
    const operation = await sign();
    const outcome = await sponsoredInvoke(context, new Sponsor(context, keypairSigner(sponsor),
      sponsorPolicy([service], { methods: ['pay_for_service'], limits: { pollIntervalMs: 500 } }), new MemoryJournal()),
    operation, new MemoryJournal(), 'account:service');
    expect(outcome.status).toBe('success');

    // The service took its price and issued its receipt in the same transaction.
    expect(scValToNative(outcome.returnValue!)).toMatchObject({ number: 1n, wallet: w.wallet, amount: 3n * UNIT });
    expect(await receipts()).toBe(1n);
    const after = await w.snapshot(policy);
    expect(after.recipient).toBe(before.recipient + 3n * UNIT);
    expect(after.wallet).toBe(before.wallet - 3n * UNIT);
    expect(after.state.daily_spend).toEqual([{ asset, amount: 3n * UNIT }]);
    const confirmed = outcome.response as rpc.Api.GetSuccessfulTransactionResponse;
    await w.expectAudit(confirmed, before.head, signer.publicKey(), [{
      kind: 'AccountPayment', policy_hash: policy, authorization: await payloadOf(entriesOf(operation)[0]!),
      action: accountPaymentAction(purchase),
    }]);

    // The service also has a method that asks the wallet for an allowance. The agent key signs exactly the tree
    // that call needs, and the wallet still refuses: it is not a payment.
    const live = await w.net.latestLedger() + 1_000;
    const amount = nativeToScVal(50n * UNIT, { type: 'i128' });
    const ask = [Address.fromString(w.wallet).toScVal(), amount, nativeToScVal(live, { type: 'u32' })];
    const approval = unsignedEntry(w.wallet, asset, 'approve',
      [Address.fromString(w.wallet).toScVal(), Address.fromString(service).toScVal(), amount,
        nativeToScVal(live, { type: 'u32' })]).rootInvocation;
    const base = unsignedEntry(w.wallet, service, 'open_allowance', ask);
    const tree = new xdr.SorobanAuthorizationEntry({
      credentials: base.credentials,
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: base.rootInvocation.function, subInvocations: [approval],
      }),
    });
    const expiration = await w.net.latestLedger() + AUTH_LEDGERS;
    const signedTree = await authorizeEntry(tree, async (_preimage, payload) => ({
      signatureScVal: encodeAccountSignature(policy,
        w.roles.signer.sign(Buffer.concat([Buffer.from(payload), Buffer.from(policy)]))),
    }), expiration, w.net.passphrase, w.wallet);
    expectAuthRefusal(await enforce(service, 'open_allowance', ask, [signedTree]), 'an allowance for the service',
      /Error\(Contract, #11\)/);

    // Another service's call, or this service under a policy that does not permit it, is refused before signing.
    await expectCheck({ amount: 3n * UNIT, policyHash: policy, service: { contract: asset, service_id: serviceId } },
      'PolicyDenied');
    await expectCheck({ amount: 3n * UNIT, service: rule }, 'PolicyDenied');
    expect(await receipts()).toBe(1n);
    expect(attacker.publicKey()).not.toBe(signer.publicKey());
  }, TIMEOUT);
});
