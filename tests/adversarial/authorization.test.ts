import { Networks, Operation, authorizeEntry } from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { signActionAuthorization } from '../../packages/sdk/src/actions.js';
import { encodeAction, encodePolicy, encodeWalletArgs, policyHash } from '../../packages/sdk/src/encoding.js';
import type { ActionRequest, Hash32, WalletArgs, WalletOwnerMethod } from '../../packages/sdk/src/types.js';
import {
  readPolicyState, readWalletBalance, signWalletAuthorization, walletOperation,
} from '../../packages/sdk/src/wallet.js';
import { assertAuthFailure, successfulSimulation } from '../integration/support/local-network.js';
import {
  UNIT, expectContractError, unsignedEntry, walletWorld, type WalletWorld,
} from '../integration/support/wallet-world.js';

/**
 * Authorization attacks against the smart wallet with real account signatures on the local network: every tampered,
 * replayed, expired or misattributed entry must fail in the host or the wallet, and nothing may commit.
 */

const TIMEOUT = 180_000;
const AUTH_ERROR = /^HostError: Error\(Auth,/;

let w: WalletWorld;
let primary: Hash32;
let secondary: Hash32;

describe('smart wallet authorization attacks', () => {
  beforeAll(async () => {
    w = await walletWorld();
    await w.fund(100n * UNIT);
    primary = await w.approve(await w.policy(1));
    secondary = await w.approve(await w.policy(2));
  }, TIMEOUT);

  it('rejects every mutation of a signed request, and signatures for another key, network or wallet', async () => {
    const { roles: { signer, stranger, attacker, owner, sponsor }, net } = w;
    const request = await w.payment(primary, 1n, 3n * UNIT);
    const { auth } = await w.agentAuth(request);
    const mutate = (change: (copy: ActionRequest) => void): ActionRequest => {
      const copy = structuredClone(request);
      change(copy);
      return copy;
    };
    const mutations: [string, ActionRequest][] = [
      ['amount', mutate((r) => { if (r.action.kind === 'Transfer') r.action.transfer.amount = 4n * UNIT; })],
      ['recipient', mutate((r) => { if (r.action.kind === 'Transfer') r.action.transfer.recipient = stranger.publicKey(); })],
      ['asset', mutate((r) => { if (r.action.kind === 'Transfer') r.action.transfer.asset = w.verificationRegistry; })],
      ['sequence', mutate((r) => { r.sequence = 2n; })],
      ['deadline', mutate((r) => { r.deadline += 1n; })],
      ['policy', mutate((r) => { r.policy_hash = secondary; })],
      ['wallet field', mutate((r) => { r.wallet = w.agentRegistry; })],
    ];
    for (const [label, mutated] of mutations) {
      assertAuthFailure(await w.enforceExecute(auth, encodeAction(mutated)), 'missing', signer.publicKey(),
        `mutated ${label}`);
    }

    for (const [label, entries] of [
      ['attacker key', await w.agentAuthByHand(request, attacker)],
      ['owner key', await w.agentAuthByHand(request, owner)],
      ['Testnet passphrase', await w.agentAuthByHand(request, signer, Networks.TESTNET)],
    ] as const) {
      assertAuthFailure(await w.enforceExecute([...entries], encodeAction(request)), 'forged', signer.publicKey(), label);
    }
    assertAuthFailure(await w.enforceExecute([], encodeAction(request)), 'missing', signer.publicKey(), 'no entry');

    // The same entry presented to another wallet holding identical policy terms.
    const other = await net.deploy(w.roles.owner, w.walletWasm, w.constructorArgs);
    const terms = await w.policy(1);
    const ownerArgs = { policy: terms };
    const rec = successfulSimulation(await net.simulate(
      await net.build(sponsor, walletOperation(other, 'approve_policy', ownerArgs)), 'record'));
    const ownerEntries = await Promise.all(rec.result.auth.map((entry) => signWalletAuthorization({
      entry, contractId: other, method: 'approve_policy', args: ownerArgs, address: owner.publicKey(),
      networkPassphrase: net.passphrase, latestLedger: rec.latestLedger, expirationLedger: rec.latestLedger + 20,
      signer: owner,
    })));
    const approveOther = await net.build(sponsor, Operation.invokeContractFunction({
      contract: other, function: 'approve_policy', args: [encodePolicy(terms)], auth: ownerEntries,
    }));
    await net.submit(approveOther, successfulSimulation(await net.simulate(approveOther, 'enforce')), sponsor);
    const elsewhere = { ...request, wallet: other, policy_hash: policyHash(net.passphrase, other, terms) };
    const misdirected = await net.build(sponsor, Operation.invokeContractFunction({
      contract: other, function: 'execute', args: [encodeAction(elsewhere)], auth,
    }));
    assertAuthFailure(await net.simulate(misdirected, 'enforce'), 'missing', signer.publicKey(), 'other wallet');

    expect(await readWalletBalance(w.read, w.asset)).toBe(100n * UNIT);
    expect((await readPolicyState(w.read, primary)).next_sequence).toBe(1n);
  }, TIMEOUT);

  it('commits one action: a replayed entry fails on the host nonce and a fresh one on the wallet sequence', async () => {
    const { roles: { signer, recipient }, net, asset } = w;
    const request = await w.payment(primary, 1n, 3n * UNIT);
    const { auth } = await w.agentAuth(request);
    const tx = await w.walletTx('execute', [encodeAction(request)], auth);
    await net.submit(tx, successfulSimulation(await net.simulate(tx, 'enforce')), w.roles.sponsor);

    const replay = await w.walletTx('execute', [encodeAction(request)], auth);
    assertAuthFailure(await net.simulate(replay, 'enforce'), 'replayed', signer.publicKey(), 'replayed entry');
    const fresh = await w.agentAuthByHand(request);
    expectContractError(await w.enforceExecute(fresh, encodeAction(request)), 'InvalidSequence', 'fresh duplicate');
    expect(await w.balanceOf(recipient.publicKey())).toBe(3n * UNIT);
    expect(await readWalletBalance(w.read, asset)).toBe(97n * UNIT);
    expect((await readPolicyState(w.read, primary)).next_sequence).toBe(2n);
  }, TIMEOUT);

  it('expires a signature at its ledger and a request at its deadline, separately', async () => {
    const { roles: { signer }, net } = w;
    const request = await w.payment(primary, 2n, UNIT);
    const latestLedger = await net.latestLedger();
    const entry = unsignedEntry(signer.publicKey(), w.wallet, 'execute', [encodeAction(request)]);
    const shortLived = await signActionAuthorization({
      entry, request, agentAddress: signer.publicKey(), networkPassphrase: net.passphrase, latestLedger,
      expirationLedger: latestLedger + 1, signer,
    });
    while (await net.latestLedger() <= latestLedger + 1) await new Promise((resolve) => setTimeout(resolve, 500));
    const expired = await w.enforceExecute([shortLived], encodeAction(request));
    expect(expired).toHaveProperty('error', expect.stringMatching(AUTH_ERROR));

    const late = { ...request, deadline: await w.ledgerTime() };
    expectContractError(await w.enforceExecute(await w.agentAuthByHand(late), encodeAction(late)), 'Expired',
      'deadline reached');
  }, TIMEOUT);

  it('lets neither the agent nor the sponsor act as the owner', async () => {
    const { roles: { owner, signer, sponsor }, net, asset } = w;
    const cases: { [M in WalletOwnerMethod]?: WalletArgs[M] } = {
      pause: {},
      withdraw: { asset, recipient: signer.publicKey(), amount: UNIT },
      revoke_policy: { policy_hash: primary },
      approve_policy: { policy: await w.policy(3) },
    };
    for (const [method, args] of Object.entries(cases) as [WalletOwnerMethod, never][]) {
      const forged = await w.ownerAuthByHand(method, args, signer);
      const encoded = encodeWalletArgs(method, args);
      assertAuthFailure(await net.simulate(await w.walletTx(method, encoded, forged), 'enforce'), 'forged',
        owner.publicKey(), `agent signing ${method}`);
      assertAuthFailure(await net.simulate(await w.walletTx(method, encoded, [], sponsor), 'enforce'), 'missing',
        owner.publicKey(), `sponsor submitting ${method}`);
      assertAuthFailure(await net.simulate(await w.walletTx(method, encoded, [], signer), 'enforce'), 'missing',
        owner.publicKey(), `agent as source of ${method}`);
    }
    expect((await readPolicyState(w.read, primary)).revoked).toBe(false);
  }, TIMEOUT);

  it('binds a funding signature to its exact transfer', async () => {
    const { roles: { funder }, net, asset } = w;
    const args = { from: funder.publicKey(), asset, amount: 5n * UNIT };
    const rec = successfulSimulation(await net.simulate(
      await net.build(w.roles.sponsor, walletOperation(w.wallet, 'fund', args)), 'record'));
    const [entry] = rec.result.auth;
    const signed = await authorizeEntry(entry!, funder, rec.latestLedger + 20, net.passphrase);
    const more = encodeWalletArgs('fund', { ...args, amount: 6n * UNIT });
    assertAuthFailure(await net.simulate(await w.walletTx('fund', more, [signed]), 'enforce'), 'missing',
      funder.publicKey(), 'larger funding amount');
    const fromOther = encodeWalletArgs('fund', { ...args, from: w.roles.stranger.publicKey() });
    assertAuthFailure(await net.simulate(await w.walletTx('fund', fromOther, [signed]), 'enforce'), 'missing',
      w.roles.stranger.publicKey(), 'funding from another account');
  }, TIMEOUT);
});
