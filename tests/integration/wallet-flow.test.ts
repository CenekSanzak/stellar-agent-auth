import { Address, Operation, hash, scValToNative } from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { registryOperation } from '../../packages/sdk/src/agents.js';
import { actionHash, encodeAction, encodePolicy, policyHash } from '../../packages/sdk/src/encoding.js';
import { canonicalPolicy, policyExposure } from '../../packages/sdk/src/policies.js';
import type { AuditHead, Hash32 } from '../../packages/sdk/src/types.js';
import {
  readActivePolicies, readAuditHead, readPaused, readPolicy, readPolicyState, readWalletBalance, readWalletOwner,
  readWalletRegistries, walletOperation,
} from '../../packages/sdk/src/wallet.js';
import { assertResourceFit, resourceLimits } from '../local/phase1-resources.js';
import { assertAuthFailure, contractEvents, returnValue, successfulSimulation } from './support/local-network.js';
import { UNIT, expectContractError, walletWorld, type WalletWorld } from './support/wallet-world.js';

const TIMEOUT = 180_000;

let w: WalletWorld;
let head: AuditHead;
let gate: Hash32;

describe('smart wallet on local Stellar', () => {
  beforeAll(async () => {
    w = await walletWorld();
  }, TIMEOUT);

  it('deploys only with the owner constructor authorization and binds both registries', async () => {
    const { net, roles: { owner, sponsor }, walletWasm, constructorArgs } = w;
    const sponsored = await net.build(sponsor, Operation.createCustomContract({
      address: Address.fromString(sponsor.publicKey()), wasmHash: hash(walletWasm), salt: Buffer.alloc(32, 9),
      constructorArgs,
    }));
    successfulSimulation(await net.simulate(sponsored, 'record_allow_nonroot'));
    // Constructor authorization fails before the host names the address, so match the auth error class only.
    expect(await net.simulate(sponsored, 'enforce')).toHaveProperty('error', expect.stringMatching(/^HostError: Error\(Auth,/));

    expect(await readWalletOwner(w.read)).toBe(owner.publicKey());
    expect(await readWalletRegistries(w.read)).toEqual({
      agent_registry: w.agentRegistry, verification_registry: w.verificationRegistry,
    });
    expect(await readPaused(w.read)).toBe(false);
    expect(await readActivePolicies(w.read)).toEqual([]);
    head = await readAuditHead(w.read);
    expect(head).toEqual({ sequence: 0n, hash: new Uint8Array(32) });
  }, TIMEOUT);

  it('accepts funding signed by the funder alone, which grants no authority', async () => {
    const { roles: { funder, owner }, asset } = w;
    const before = await w.balanceOf(funder.publicKey());
    await w.fund(100n * UNIT);
    expect(await readWalletBalance(w.read, asset)).toBe(100n * UNIT);
    expect(await w.balanceOf(funder.publicKey())).toBe(before - 100n * UNIT);
    expect(await readAuditHead(w.read)).toEqual(head);

    // The funder cannot act as the owner.
    const [forged] = await w.ownerAuth('pause', {}, funder);
    assertAuthFailure(await w.net.simulate(await w.walletTx('pause', [], [forged!]), 'enforce'), 'forged',
      owner.publicKey(), 'funder signing as owner');
  }, TIMEOUT);

  it('SOW gate: a signed 3-unit payment succeeds under a 5 per payment, 20 per day, seven-day policy', async () => {
    const { roles: { owner, signer, recipient }, net, asset, wallet } = w;
    const policy = await w.policy(1);
    const approval = await w.ownerCall('approve_policy', { policy });
    gate = policyHash(net.passphrase, wallet, policy);
    head = await w.expectAudit(approval.confirmed, head, owner.publicKey(), [
      { kind: 'PolicyCreated', policy_hash: gate },
    ]);
    expect(await readPolicy(w.read, gate)).toEqual(canonicalPolicy(policy));
    expect(await readActivePolicies(w.read)).toEqual([gate]);

    const request = await w.payment(gate, 1n, 3n * UNIT);
    const { confirmed, prepared, enforced } = await w.execute(request);
    expect(Uint8Array.from(scValToNative(returnValue(confirmed)) as Buffer)).toEqual(actionHash(net.passphrase, request));
    expect(prepared.source).toBe(w.roles.sponsor.publicKey());
    head = await w.expectAudit(confirmed, head, signer.publicKey(), [{
      kind: 'Executed', policy_hash: gate, action_hash: actionHash(net.passphrase, request),
      action: request.action,
    }]);
    expect(await readWalletBalance(w.read, asset)).toBe(97n * UNIT);
    expect(await w.balanceOf(recipient.publicKey())).toBe(3n * UNIT);
    const state = await readPolicyState(w.read, gate);
    expect(state).toMatchObject({ revoked: false, next_sequence: 2n, daily_spend: [{ asset, amount: 3n * UNIT }] });
    // One audit event from the wallet; the asset contract publishes its own transfer event.
    expect(contractEvents(confirmed).length).toBeGreaterThanOrEqual(2);
    assertResourceFit('wallet execute', enforced, prepared, contractEvents(confirmed), await resourceLimits(net.server));
  }, TIMEOUT);

  it('rejects an over-limit payment and an unapproved recipient', async () => {
    const { roles: { stranger } } = w;
    await w.expectRejected(await w.payment(gate, 2n, 6n * UNIT), 'LimitExceeded', 'above 5 per payment');
    await w.expectRejected(await w.payment(gate, 2n, 1n * UNIT, stranger.publicKey()), 'PolicyDenied',
      'unapproved recipient');
    expect((await readPolicyState(w.read, gate)).next_sequence).toBe(2n);
  }, TIMEOUT);

  it('fails a payment signed and simulated before revocation once it reaches the ledger', async () => {
    const { roles: { owner, recipient, stranger }, net } = w;
    // A second fee payer keeps the sponsor's account sequence free for the revocation.
    const request = await w.payment(gate, 2n, 3n * UNIT);
    const { auth } = await w.agentAuth(request, w.roles.signer, stranger);
    const tx = await w.walletTx('execute', [encodeAction(request)], auth, stranger);
    const simulated = successfulSimulation(await net.simulate(tx, 'enforce'));

    const revocation = await w.ownerCall('revoke_policy', { policy_hash: gate });
    head = await w.expectAudit(revocation.confirmed, head, owner.publicKey(), [
      { kind: 'PolicyRevoked', policy_hash: gate },
    ]);
    const before = await w.snapshot(gate);
    await expect(net.submit(tx, simulated, stranger)).rejects.toThrow(/FAILED/);
    expect(await w.snapshot(gate)).toEqual(before);
    expect(before.state.revoked).toBe(true);
    expect(await w.balanceOf(recipient.publicKey())).toBe(3n * UNIT);
    expectContractError(await net.simulate(tx, 'enforce'), 'Revoked', 'after revocation');
    // Revocation is terminal: the ID cannot be approved again.
    const reused = await w.policy(1);
    const reuse = await w.ownerAuthByHand('approve_policy', { policy: reused });
    expectContractError(await net.simulate(await w.walletTx('approve_policy', [encodePolicy(reused)], reuse),
      'enforce'), 'Revoked', 'policy ID reuse');
  }, TIMEOUT);

  it('pauses agents while funding and withdrawal continue, and resumes only eligible policies', async () => {
    const { roles: { owner }, asset } = w;
    const live = await w.approve(await w.policy(2));
    head = await readAuditHead(w.read);

    const paused = await w.ownerCall('pause', {});
    head = await w.expectAudit(paused.confirmed, head, owner.publicKey(), [{ kind: 'PauseChanged', paused: true }]);
    await w.expectRejected(await w.payment(live, 1n, UNIT), 'Paused', 'paused wallet');

    await w.fund(10n * UNIT);
    const withdrawal = { asset, recipient: owner.publicKey(), amount: 5n * UNIT };
    const withdrawn = await w.ownerCall('withdraw', withdrawal);
    head = await w.expectAudit(withdrawn.confirmed, head, owner.publicKey(), [
      { kind: 'OwnerWithdrawal', transfer: withdrawal },
    ]);
    expect(await w.balanceOf(owner.publicKey())).toBe(5n * UNIT);
    expect(await readWalletBalance(w.read, asset)).toBe(102n * UNIT);

    const resumed = await w.ownerCall('resume', {});
    head = await w.expectAudit(resumed.confirmed, head, owner.publicKey(), [{ kind: 'PauseChanged', paused: false }]);
    await w.expectRejected(await w.payment(gate, 2n, UNIT), 'Revoked', 'revoked policy after resume');
    await w.execute(await w.payment(live, 1n, UNIT));
    head = await readAuditHead(w.read);
  }, TIMEOUT);

  it('replaces a policy atomically and reports the additive exposure', async () => {
    const { roles: { owner }, net, wallet, asset } = w;
    const [old] = await readActivePolicies(w.read);
    const replacement = await w.policy(3, {
      assets: [{ asset, per_transaction: 2n * UNIT, per_day: 4n * UNIT }],
    });
    const replaced = await w.ownerCall('replace_policy', { old_policy_hash: old!, policy: replacement });
    const fresh = policyHash(net.passphrase, wallet, replacement);
    head = await w.expectAudit(replaced.confirmed, head, owner.publicKey(), [
      { kind: 'PolicyRevoked', policy_hash: old! }, { kind: 'PolicyCreated', policy_hash: fresh },
    ]);
    expect(await readActivePolicies(w.read)).toEqual([fresh]);
    expect((await readPolicyState(w.read, old!)).revoked).toBe(true);

    // The replacement starts with a fresh budget the same day; the owner sees it explicitly.
    const now = await w.ledgerTime();
    const entries = await Promise.all([old!, fresh].map(async (policyHashValue) => ({
      policy: await readPolicy(w.read, policyHashValue), state: await readPolicyState(w.read, policyHashValue),
    })));
    expect(policyExposure(entries, now)).toEqual([{
      asset, daily_cap: 4n * UNIT, spent_today: 0n, remaining_today: 4n * UNIT, largest_transfer: 2n * UNIT,
      policies: 1,
    }]);
    await w.expectRejected(await w.payment(old!, 2n, UNIT), 'Revoked', 'replaced policy');
    await w.expectRejected(await w.payment(fresh, 1n, 3n * UNIT), 'LimitExceeded', 'new per-transfer cap');
  }, TIMEOUT);

  it('rolls back sequence, budget and audit head when the asset transfer fails on chain', async () => {
    const { roles: { owner, stranger }, net, asset } = w;
    const [active] = await readActivePolicies(w.read);
    const request = await w.payment(active!, 1n, 2n * UNIT);
    const { auth } = await w.agentAuth(request, w.roles.signer, stranger);
    const tx = await w.walletTx('execute', [encodeAction(request)], auth, stranger);
    const simulated = successfulSimulation(await net.simulate(tx, 'enforce'));

    // The owner empties the wallet after the agent's request was simulated and signed.
    const balance = await readWalletBalance(w.read, asset);
    await w.ownerCall('withdraw', { asset, recipient: owner.publicKey(), amount: balance });
    const before = await w.snapshot(active!);
    await expect(net.submit(tx, simulated, stranger)).rejects.toThrow(/FAILED/);
    expect(await w.snapshot(active!)).toEqual(before);
    expect(before.state).toMatchObject({ next_sequence: 1n, daily_spend: [] });
    expectContractError(await net.simulate(tx, 'enforce'), 'TransferFailed', 'empty wallet');
  }, TIMEOUT);

  it('blocks requests signed before an identity change, against live registry state', async () => {
    const { roles: { controller }, net, agent, agentRegistry, asset } = w;
    await w.fund(10n * UNIT);
    const [active] = await readActivePolicies(w.read);
    const request = await w.payment(active!, 1n, UNIT);
    const { auth } = await w.agentAuth(request);
    const signedTx = await w.walletTx('execute', [encodeAction(request)], auth);
    successfulSimulation(await net.simulate(signedTx, 'enforce'));

    const args = {
      agent_id: agent.agent_id, expected_revision: agent.revision,
      metadata_uri: 'https://agent.example.test/wallet-agent-v2.json', metadata_hash: new Uint8Array(32).fill(5),
    };
    // The controller authorizes as its own transaction source.
    await net.invoke(controller, registryOperation(agentRegistry, 'update_metadata', args));
    expectContractError(await net.simulate(signedTx, 'enforce'), 'IdentityChanged', 'old revision');
    // The owner cannot approve a policy for the old revision either: recording already fails.
    const stale = await net.simulate(await net.build(w.roles.sponsor,
      walletOperation(w.wallet, 'approve_policy', {
        policy: await w.policy(4),
      })), 'record');
    expectContractError(stale, 'IdentityChanged', 'policy for an old revision');
    expect(await readWalletBalance(w.read, asset)).toBe(10n * UNIT);
  }, TIMEOUT);
});
