import { Asset, Contract, Operation, authorizeEntry, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeAction, encodePolicy } from '../../packages/sdk/src/encoding.js';
import type { ActionRequest, Hash32 } from '../../packages/sdk/src/types.js';
import { readPolicyState, readWalletBalance } from '../../packages/sdk/src/wallet.js';
import { successfulSimulation } from '../integration/support/local-network.js';
import {
  DAY, UNIT, expectContractError, unsignedEntry, walletWorld, type WalletWorld,
} from '../integration/support/wallet-world.js';

/**
 * Spending limits, recipient and asset restrictions, policy windows and concurrent requests on the local network,
 * with real agent signatures. Exact UTC midnight rollover needs ledger-time control and is covered by the contract
 * tests; here the budget is exercised within one day.
 */

const TIMEOUT = 180_000;

let w: WalletWorld;

/** Replace the transfer amount in an encoded request with raw `amount` XDR the SDK encoder would refuse. */
function withRawAmount(request: ActionRequest, amount: xdr.ScVal) {
  const patch = (value: xdr.ScVal, path: string[]): xdr.ScVal => {
    if (!path.length) return amount;
    if (value.type === 'scvMap') {
      return xdr.ScVal.scvMap((value.map ?? []).map((entry) =>
        entry.key.type === 'scvSymbol' && entry.key.sym.toString() === path[0]
          ? new xdr.ScMapEntry({ key: entry.key, val: patch(entry.val, path.slice(1)) }) : entry));
    }
    if (value.type === 'scvVec') return xdr.ScVal.scvVec((value.vec ?? []).map((item, i) => (i === 1 ? patch(item, path) : item)));
    return value;
  };
  return patch(encodeAction(request), ['action', 'amount']);
}

describe('smart wallet limits and races', () => {
  beforeAll(async () => {
    w = await walletWorld();
    await w.fund(200n * UNIT);
  }, TIMEOUT);

  it('accepts exactly the per-transfer cap and rejects above it, zero and negative amounts', async () => {
    const { roles: { signer }, net } = w;
    const policyHash = await w.approve(await w.policy(1));
    await w.expectRejected(await w.payment(policyHash, 1n, 5n * UNIT + 1n), 'LimitExceeded', 'one above the cap');
    await w.execute(await w.payment(policyHash, 1n, 5n * UNIT));

    const request = await w.payment(policyHash, 2n, UNIT);
    for (const [label, raw] of [
      ['zero', nativeToScVal(0n, { type: 'i128' })], ['negative', nativeToScVal(-1n, { type: 'i128' })],
    ] as const) {
      const argument = withRawAmount(request, raw);
      const latestLedger = await net.latestLedger();
      // Signed directly: the SDK validator refuses to encode a non-positive amount.
      const entry = await authorizeEntry(unsignedEntry(signer.publicKey(), w.wallet, 'execute', [argument]), signer,
        latestLedger + 20, net.passphrase);
      expectContractError(await w.enforceExecute([entry], argument), 'InvalidInput', `${label} amount`);
    }
    expect((await readPolicyState(w.read, policyHash)).next_sequence).toBe(2n);
  }, TIMEOUT);

  it('spends exactly the daily cap and nothing more', async () => {
    const policyHash = await w.approve(await w.policy(2));
    for (const sequence of [1n, 2n, 3n, 4n]) await w.execute(await w.payment(policyHash, sequence, 5n * UNIT));
    const state = await readPolicyState(w.read, policyHash);
    expect(state.daily_spend).toEqual([{ asset: w.asset, amount: 20n * UNIT }]);
    await w.expectRejected(await w.payment(policyHash, 5n, 1n), 'LimitExceeded', 'one unit over the day');
  }, TIMEOUT);

  it('fails closed for unapproved assets, blocked recipients and an empty allowlist', async () => {
    const { roles: { stranger, recipient }, net } = w;
    const native = Asset.native();
    const nativeAsset = native.contractId(net.passphrase);
    const existing = await net.server.getLedgerEntries(new Contract(nativeAsset).getFootprint());
    if (!existing.entries.length) await net.invoke(w.roles.sponsor, Operation.createStellarAssetContract({ asset: native }));

    const policyHash = await w.approve(await w.policy(3, {
      allowed_recipients: [recipient.publicKey(), stranger.publicKey()], blocked_recipients: [stranger.publicKey()],
    }));
    const unapprovedAsset = { ...await w.payment(policyHash, 1n, UNIT) };
    if (unapprovedAsset.action.kind === 'Transfer') unapprovedAsset.action.transfer.asset = nativeAsset;
    await w.expectRejected(unapprovedAsset, 'PolicyDenied', 'unapproved asset');
    await w.expectRejected(await w.payment(policyHash, 1n, UNIT, stranger.publicKey()), 'PolicyDenied',
      'allowed and blocked recipient');

    const empty = await w.approve(await w.policy(4, { allowed_recipients: [] }));
    await w.expectRejected(await w.payment(empty, 1n, UNIT), 'PolicyDenied', 'empty allowlist');
  }, TIMEOUT);

  it('commits one of two requests signed for the same sequence when both are submitted together', async () => {
    const { roles: { sponsor, stranger, recipient }, net, asset } = w;
    const policyHash = await w.approve(await w.policy(5, {
      assets: [{ asset, per_transaction: 3n * UNIT, per_day: 5n * UNIT }],
    }));
    const recipientBefore = await w.balanceOf(recipient.publicKey());
    const walletBefore = await readWalletBalance(w.read, asset);
    // Two different requests for sequence 1, each within every cap on its own; together over the day.
    const first = await w.payment(policyHash, 1n, 3n * UNIT);
    const second = { ...first, deadline: first.deadline + 1n };
    const sources = [sponsor, stranger];
    const prepared = await Promise.all([first, second].map(async (request, i) => {
      const source = sources[i]!;
      const { auth } = await w.agentAuth(request, w.roles.signer, source);
      const tx = await w.walletTx('execute', [encodeAction(request)], auth, source);
      return { tx, simulation: successfulSimulation(await net.simulate(tx, 'enforce')), source };
    }));
    const outcomes = await Promise.allSettled(prepared.map(({ tx, simulation, source }) =>
      net.submit(tx, simulation, source)));
    expect(outcomes.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    const state = await readPolicyState(w.read, policyHash);
    expect(state).toMatchObject({ next_sequence: 2n, daily_spend: [{ asset, amount: 3n * UNIT }] });
    expect(await w.balanceOf(recipient.publicKey())).toBe(recipientBefore + 3n * UNIT);
    expect(await readWalletBalance(w.read, asset)).toBe(walletBefore - 3n * UNIT);

    // A request signed in advance for the next sequence still meets the cap when it arrives.
    const next = await w.payment(policyHash, 2n, 3n * UNIT);
    expectContractError(await w.enforceExecute(await w.agentAuthByHand(next), encodeAction(next)), 'LimitExceeded',
      'signed ahead, over the remaining budget');
  }, TIMEOUT);

  it('honors the policy window at approval and at execution', async () => {
    const { net } = w;
    const now = await w.ledgerTime();
    const later = await w.approve(await w.policy(6, { valid_after: now + DAY, valid_until: now + 2n * DAY }));
    await w.expectRejected(await w.payment(later, 1n, UNIT), 'PolicyDenied', 'before valid_after');

    const ended = await w.policy(7, { valid_after: now - 2n * DAY, valid_until: now - DAY });
    const auth = await w.ownerAuthByHand('approve_policy', { policy: ended });
    expectContractError(await net.simulate(await w.walletTx('approve_policy', [encodePolicy(ended)], auth), 'enforce'),
      'Expired', 'approving an ended window');
  }, TIMEOUT);
});
