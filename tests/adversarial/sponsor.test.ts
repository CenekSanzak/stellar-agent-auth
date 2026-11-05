import { Address, Operation, nativeToScVal, rpc, xdr, type Keypair } from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { executeInvocation, fundInvocation } from '../../packages/sdk/src/client.js';
import { encodeAction } from '../../packages/sdk/src/encoding.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import {
  Sponsor, SponsorRefused, signForSponsor, sponsorPolicy, sponsoredInvoke,
} from '../../packages/sdk/src/sponsor.js';
import {
  FeeCeilingExceeded, MemoryJournal, SimulationRejected, networkContext, pipelineLimits, type NetworkContext,
} from '../../packages/sdk/src/transactions.js';
import type { ActionRequest, Hash32 } from '../../packages/sdk/src/types.js';
import { readPolicyState } from '../../packages/sdk/src/wallet.js';
import { UNIT, walletWorld, type WalletWorld } from '../integration/support/wallet-world.js';

/**
 * A24 on the local network: the sponsor pays and submits but gains no authority, cannot change an action, and
 * neither a sequence race nor an uncertain submission commits an action twice.
 */

const TIMEOUT = 240_000;
const limits = pipelineLimits({ pollIntervalMs: 500 });

let world: WalletWorld;
let context: NetworkContext;
let policyHash: Hash32;
let sponsorKey: Keypair;

beforeAll(async () => {
  world = await walletWorld();
  context = await networkContext(world.net.server, world.net.passphrase);
  sponsorKey = world.roles.sponsor;
  await world.fund(100n * UNIT);
  policyHash = await world.approve(await world.policy(1));
}, TIMEOUT);

const sponsor = (overrides: Partial<Parameters<typeof sponsorPolicy>[1]> = {}, server = context.server) =>
  new Sponsor({ ...context, server }, keypairSigner(sponsorKey), sponsorPolicy([world.wallet], {
    methods: ['execute', 'fund'], limits: { pollIntervalMs: 500 }, ...overrides,
  }), new MemoryJournal());

const agent = () => keypairSigner(world.roles.signer);
const signed = (request: ActionRequest) =>
  signForSponsor(context, sponsorKey.publicKey(), executeInvocation(context, request, agent()), limits);
const nextSequence = async () => (await readPolicyState(world.read, policyHash)).next_sequence;

/** The operation with its single argument replaced, keeping the original signed entries. */
function withArgument(operation: xdr.Operation, argument: xdr.ScVal, rewriteEntry = false) {
  if (operation.body.type !== 'invokeHostFunction') throw new Error('Expected an invocation');
  const { hostFunction, auth } = operation.body.invokeHostFunctionOp;
  if (hostFunction.type !== 'hostFunctionTypeInvokeContract') throw new Error('Expected a contract call');
  const call = hostFunction.invokeContract;
  const entries = rewriteEntry ? auth.map((entry) => {
    const fn = entry.rootInvocation.function;
    if (fn.type !== 'sorobanAuthorizedFunctionTypeContractFn') throw new Error('Expected a contract call');
    return new xdr.SorobanAuthorizationEntry({
      credentials: entry.credentials,
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
          contractAddress: fn.contractFn.contractAddress, functionName: fn.contractFn.functionName, args: [argument],
        })),
        subInvocations: [],
      }),
    });
  }) : auth;
  return Operation.invokeContractFunction({
    contract: Address.fromScAddress(call.contractAddress).toString(), function: call.functionName.toString(),
    args: [argument], auth: entries,
  });
}

describe('sponsored execution', () => {
  it('pays and submits a signed payment, authorizing nothing itself', async () => {
    const before = await world.snapshot(policyHash);
    const request = await world.payment(policyHash, await nextSequence(), 3n * UNIT);
    const operation = await signed(request);
    const outcome = await sponsoredInvoke(context, sponsor(), operation, new MemoryJournal(), 'execute:a');
    expect(outcome.status).toBe('success');
    const envelope = xdr.TransactionEnvelope.fromXdr(outcome.record.envelope, 'base64');
    if (envelope.type !== 'envelopeTypeTx') throw new Error('Expected a v1 envelope');
    expect(outcome.record.source).toBe(sponsorKey.publicKey());
    const [op] = envelope.v1.tx.operations;
    const auth = op?.body.type === 'invokeHostFunction' ? op.body.invokeHostFunctionOp.auth : [];
    expect(auth.map((entry) => entry.credentials.type)).toEqual(['sorobanCredentialsAddress']);
    const after = await world.snapshot(policyHash);
    expect(after.recipient - before.recipient).toBe(3n * UNIT);
    expect(after.state.next_sequence).toBe(before.state.next_sequence + 1n);
  }, TIMEOUT);

  it('cannot change the amount or recipient of a signed request', async () => {
    const request = await world.payment(policyHash, await nextSequence(), 2n * UNIT);
    const operation = await signed(request);
    const before = await world.snapshot(policyHash);
    const larger = encodeAction({ ...request, action: { kind: 'Transfer', transfer: {
      ...(request.action as { transfer: { asset: string; recipient: string; amount: bigint } }).transfer,
      amount: 5n * UNIT,
    } } });
    const redirected = encodeAction({ ...request, action: { kind: 'Transfer', transfer: {
      ...(request.action as { transfer: { asset: string; recipient: string; amount: bigint } }).transfer,
      recipient: world.roles.attacker.publicKey(),
    } } });
    for (const argument of [larger, redirected]) {
      // Keeping the signed entry: it no longer matches the call. Rewriting it: the signature no longer verifies.
      for (const rewrite of [false, true]) {
        const tampered = withArgument(operation, argument, rewrite).toXdr('base64');
        const error = await sponsor().sponsor(tampered).catch((thrown: unknown) => thrown);
        expect(error, `rewrite ${rewrite}`).toBeInstanceOf(rewrite ? SimulationRejected : SponsorRefused);
        if (rewrite) expect(error).toHaveProperty('auth', 'forged');
      }
    }
    // A sponsor bypassing its own checks fares no better: the network refuses the tampered call.
    const tamperedTx = await world.net.build(sponsorKey, withArgument(operation, larger, true));
    expect('error' in await world.net.simulate(tamperedTx, 'enforce')).toBe(true);
    expect(await world.snapshot(policyHash)).toEqual(before);
  }, TIMEOUT);

  it('cannot be made to authorize anything, and sponsors only configured calls', async () => {
    const funder = world.roles.funder;
    // A funding signed by the funder, re-pointed to draw from the sponsor: the sponsor would have to authorize it.
    const args = { from: funder.publicKey(), asset: world.asset, amount: UNIT };
    const funding = await signForSponsor(context, sponsorKey.publicKey(),
      fundInvocation(context, world.wallet, args, keypairSigner(funder)), limits);
    if (funding.body.type !== 'invokeHostFunction') throw new Error('Expected an invocation');
    const call = funding.body.invokeHostFunctionOp.hostFunction;
    if (call.type !== 'hostFunctionTypeInvokeContract') throw new Error('Expected a contract call');
    const fromSponsor = Operation.invokeContractFunction({
      contract: world.wallet, function: 'fund',
      args: [Address.fromString(sponsorKey.publicKey()).toScVal(), ...call.invokeContract.args.slice(1)],
      auth: funding.body.invokeHostFunctionOp.auth,
    }).toXdr('base64');
    await expect(sponsor().sponsor(fromSponsor)).rejects.toThrow('sponsored contract call');

    // Source-account credentials would be satisfied by the sponsor's envelope signature: refused outright.
    const sourceEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: funding.body.invokeHostFunctionOp.auth[0]!.rootInvocation,
    });
    const smuggled = Operation.invokeContractFunction({
      contract: world.wallet, function: 'fund', args: call.invokeContract.args, auth: [sourceEntry],
    }).toXdr('base64');
    await expect(sponsor().sponsor(smuggled)).rejects.toThrow('address credentials');

    // Calls outside the configuration are refused before simulation.
    await expect(sponsor({ methods: ['execute'] }).sponsor(funding.toXdr('base64'))).rejects.toThrow('Method fund');
    const assetCall = Operation.invokeContractFunction({
      contract: world.asset, function: 'transfer',
      args: [Address.fromString(sponsorKey.publicKey()).toScVal(), Address.fromString(funder.publicKey()).toScVal(),
        nativeToScVal(UNIT, { type: 'i128' })],
      auth: funding.body.invokeHostFunctionOp.auth,
    }).toXdr('base64');
    await expect(sponsor().sponsor(assetCall)).rejects.toThrow('is not sponsored');

    // The legitimate funding still goes through: the checks above refused only what was wrong.
    expect((await sponsor().sponsor(funding.toXdr('base64'))).status).toBe('success');
  }, TIMEOUT);

  it('refuses a fee above its ceiling without submitting', async () => {
    const request = await world.payment(policyHash, await nextSequence(), UNIT);
    const strict = sponsor({ limits: { maxFee: 10_000n } });
    await expect(strict.sponsor((await signed(request)).toXdr('base64'))).rejects.toBeInstanceOf(FeeCeilingExceeded);
    expect((await readPolicyState(world.read, policyHash)).next_sequence).toBe(request.sequence);
  }, TIMEOUT);
});

describe('sequence races and uncertain submission', () => {
  it('commits exactly one of two requests signed for the same sequence', async () => {
    const sequence = await nextSequence();
    const first = await signed(await world.payment(policyHash, sequence, UNIT));
    const second = await signed(await world.payment(policyHash, sequence, 2n * UNIT));
    const before = await world.snapshot(policyHash);
    const shared = sponsor();
    const results = await Promise.allSettled([shared.sponsor(first.toXdr('base64')),
      shared.sponsor(second.toXdr('base64'))]);
    const committed = results.filter((result) => result.status === 'fulfilled' && result.value.status === 'success');
    const refused = results.filter((result) => result.status === 'rejected');
    expect(committed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'InvalidSequence' });
    const after = await world.snapshot(policyHash);
    expect(after.state.next_sequence).toBe(sequence + 1n);
    expect(after.recipient - before.recipient).toBe(UNIT);
  }, TIMEOUT);

  it('settles a submission whose response was lost by its hash, and never commits it twice', async () => {
    const request = await world.payment(policyHash, await nextSequence(), UNIT);
    const operation = await signed(request);
    const before = await world.snapshot(policyHash);
    // The send reaches the network but the response is lost.
    const lossy: typeof context.server = {
      ...context.server,
      getAccount: (address) => context.server.getAccount(address),
      simulateTransaction: (...args) => context.server.simulateTransaction(...args),
      getTransaction: (hash) => context.server.getTransaction(hash),
      getLatestLedger: () => context.server.getLatestLedger(),
      getNetwork: () => context.server.getNetwork(),
      sendTransaction: async (tx) => {
        await context.server.sendTransaction(tx);
        throw new Error('connection reset after send');
      },
    };
    const outcome = await sponsor({}, lossy).sponsor(operation.toXdr('base64'));
    expect(outcome.status).toBe('success');
    const confirmed = await world.net.server.getTransaction(outcome.hash);
    expect(confirmed.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);

    // Submitting the same signed operation again cannot pay twice: its nonce is spent and its sequence used.
    const replay = await sponsor().sponsor(operation.toXdr('base64')).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(SimulationRejected);
    const after = await world.snapshot(policyHash);
    expect(after.recipient - before.recipient).toBe(UNIT);
    expect(after.state.next_sequence).toBe(request.sequence + 1n);
  }, TIMEOUT);
});

