import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend } from '../../apps/demo/server/backend.js';
import type { Deployment } from '../../apps/demo/server/deployment.js';
import { setupDeployment } from '../../apps/demo/server/setup.js';
import type { ScenarioResult } from '../../apps/demo/server/agent.js';
import { ownerInvocation, walletDeployment } from '../../packages/sdk/src/client.js';
import { policyHash } from '../../packages/sdk/src/encoding.js';
import { readIndexedHistory } from '../../packages/sdk/src/history.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import { MemoryJournal, invoke, networkContext, pipelineLimits, type NetworkContext } from '../../packages/sdk/src/transactions.js';
import type { Policy, WalletArgs, WalletOwnerMethod } from '../../packages/sdk/src/types.js';
import { readWalletBalance } from '../../packages/sdk/src/wallet.js';
import { localNetwork } from './support/local-network.js';

const TIMEOUT = 240_000;
const UNIT = 10_000_000n;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));

/**
 * The demo's server side on a local network, driven as the browser drives it. The owner here is a key held by the
 * test, standing in for the browser wallet: it creates the wallet and approves, pauses and revokes with its own
 * signature, and the server never sees it.
 */
describe('demo backend on local Stellar', () => {
  let directory: string;
  let deployment: Deployment;
  let backend: Awaited<ReturnType<typeof createBackend>>;
  let http: Server;
  let base: string;
  let context: NetworkContext;
  let server: rpc.Server;
  let wallet: string;
  let policy: Uint8Array;
  let indexerUrl: string;
  const owner = Keypair.random();
  const ownerSigner = keypairSigner(owner);
  const journal = new MemoryJournal();
  const limits = pipelineLimits({ maxFee: 100_000_000n });

  const post = async (path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
    const response = await fetch(new URL(path, base), { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const scenario = async (id: string) => {
    const { status, body } = await post('v1/payments', { scenario: id, policy_hash: hex(policy) });
    expect(status, JSON.stringify(body)).toBe(200);
    return body as unknown as ScenarioResult;
  };
  const ownerCall = async <M extends WalletOwnerMethod>(method: M, args: WalletArgs[M]) => {
    const outcome = await invoke(context, ownerSigner, ownerInvocation(context, wallet, method, args, ownerSigner), journal, { limits });
    expect(outcome.status, method).toBe('success');
    return outcome;
  };
  const read = () => ({ server, contractId: wallet, source: owner.publicKey(), networkPassphrase: deployment.passphrase });

  beforeAll(async () => {
    const net = await localNetwork();
    server = net.server;
    directory = mkdtempSync(join(tmpdir(), 'demo-backend-'));
    deployment = await setupDeployment({
      env: process.env, directory: join(directory, 'run'), record: join(directory, 'deployment.json'), log: () => {},
    });
    context = await networkContext(server, deployment.passphrase);
    backend = await createBackend({ deployment, directory: join(directory, 'state'), env: process.env });
    http = createServer((request, response) => { void backend.handler(request, response); });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
    await server.requestAirdrop(owner.publicKey());
  }, TIMEOUT);

  afterAll(async () => {
    await backend?.stop();
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('describes the deployment without any key material', async () => {
    const config = await (await fetch(new URL('v1/config', base))).json() as Record<string, any>;
    expect(config).toMatchObject({
      network: 'local', agent_registry: deployment.agent_registry, asset: { code: 'DEMO', decimals: 7 },
      provider: { mode: 'Fixture' }, agent: { agent_id: deployment.agent.agent_id },
    });
    expect(config['scenarios'].map((item: { id: string }) => item.id))
      .toEqual(['allowed', 'over-limit', 'unknown-recipient', 'daily-limit', 'account-transfer', 'service']);
    expect(JSON.stringify(config)).not.toMatch(/S[A-Z2-7]{55}/);
    expect(JSON.stringify(config)).not.toContain(deployment.key_directory);
  }, TIMEOUT);

  it('names the owner\'s wallet before it exists and follows it once the owner has created it', async () => {
    const before = await post('v1/session', { owner: owner.publicKey() });
    expect(before.body).toMatchObject({ deployed: false, indexer_url: null });
    wallet = before.body['wallet'];
    expect(wallet).toBe(backend.walletOf(owner.publicKey()));
    // Nothing can be asked of the agent or the funder before there is a wallet.
    expect((await post('v1/fund', {})).status).toBe(409);
    expect((await post('v1/payments', { scenario: 'allowed', policy_hash: '00'.repeat(32) })).status).toBe(409);

    const created = await invoke(context, ownerSigner, walletDeployment(deployment.passphrase, owner.publicKey(),
      bytes(deployment.wallet_wasm_hash), deployment.agent_registry, deployment.verification_registry,
      bytes(deployment.wallet_salt)), journal, { limits });
    expect(created.status).toBe('success');

    const after = await post('v1/session', { owner: owner.publicKey() });
    expect(after.body).toMatchObject({ wallet, deployed: true });
    indexerUrl = after.body['indexer_url'];
    expect(indexerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  }, TIMEOUT);

  it('refuses requests another page could send, and malformed ones', async () => {
    expect((await post('v1/session', { owner: owner.publicKey() }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post('v1/session', { owner: owner.publicKey() },
      { 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(403);
    // A domain pointed at this machine arrives with its own name as the host.
    const rebound = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(new URL('v1/config', base), { headers: { host: 'evil.example' } },
        (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on('error', reject);
      request.end();
    });
    expect(rebound).toBe(403);
    expect((await post('v1/session', { owner: 'nobody' })).status).toBe(400);
    expect((await post('v1/payments', { scenario: 'allowed', policy_hash: 'short' })).status).toBe(400);
    expect((await post('v1/payments', { scenario: 'send-everything', policy_hash: '00'.repeat(32) })).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(new URL('v1/nothing', base))).status).toBe(404);
  }, TIMEOUT);

  it('funds the wallet from the funder, a fixed amount at a time', async () => {
    const funded = await post('v1/fund', {});
    expect(funded.body).toMatchObject({ status: 'success', amount: '100', asset: 'DEMO' });
    expect(await readWalletBalance(read(), deployment.asset.contract)).toBe(100n * UNIT);
  }, TIMEOUT);

  it('pays inside the policy and is refused outside it, each with the wallet\'s own reason', async () => {
    const now = BigInt((await server.getLatestLedger()).closeTime);
    const value: Policy = {
      schema_version: 1, policy_id: new Uint8Array(32).fill(1), agent_id: BigInt(deployment.agent.agent_id),
      revision: BigInt(deployment.agent.revision), signer: deployment.agent.signer, provider: deployment.provider.address,
      required_checks: ['Endpoint', 'Metadata', 'SignerAccount'], max_assessment_age: 30n * 86_400n, max_risk_score: 10,
      assets: [{ asset: deployment.asset.contract, per_transaction: 5n * UNIT, per_day: 20n * UNIT, total: null }],
      allowed_recipients: [deployment.roles.recipient], blocked_recipients: [],
      valid_after: now - 60n, valid_until: now + 7n * 86_400n, action_kinds: ['ServicePayment', 'Transfer'],
      service: { contract: deployment.service.contract, service_id: bytes(deployment.service.service_id) },
    };
    await ownerCall('approve_policy', { policy: value });
    policy = policyHash(deployment.passphrase, wallet, value);

    expect((await scenario('allowed')).steps).toMatchObject([
      { path: 'execute', status: 'paid', amount: '3', recipient: deployment.roles.recipient, error: null },
    ]);
    expect((await scenario('over-limit')).steps).toMatchObject([
      { status: 'refused', amount: '6', error: 'PaymentLimitExceeded', tx_hash: null },
    ]);
    expect((await scenario('unknown-recipient')).steps).toMatchObject([
      { status: 'refused', recipient: deployment.roles.stranger, error: 'RecipientNotAllowed' },
    ]);
    expect((await scenario('account-transfer')).steps).toMatchObject([{ path: 'account', status: 'paid', amount: '1' }]);
    expect((await scenario('service')).steps).toMatchObject([{ path: 'service', status: 'paid', amount: '1' }]);
    // 3 + 1 + 1 spent of 20: three more payments of 5 fit, and the fourth would pass the daily limit.
    const daily = await scenario('daily-limit');
    expect(daily.steps.map((step) => step.status)).toEqual(['paid', 'paid', 'paid', 'refused']);
    expect(daily.steps.at(-1)).toMatchObject({ error: 'DailyLimitExceeded', tx_hash: null });
    expect(await readWalletBalance(read(), deployment.asset.contract)).toBe(80n * UNIT);
  }, TIMEOUT);

  it('stops paying when the owner pauses, and for good when the owner revokes', async () => {
    await ownerCall('pause', {});
    expect((await scenario('account-transfer')).steps).toMatchObject([{ status: 'refused', error: 'Paused' }]);
    await ownerCall('resume', {});
    await ownerCall('revoke_policy', { policy_hash: policy });
    expect((await scenario('allowed')).steps).toMatchObject([{ status: 'refused', error: 'Revoked' }]);
    expect((await scenario('service')).steps).toMatchObject([{ status: 'refused', error: 'Revoked' }]);
    expect(await readWalletBalance(read(), deployment.asset.contract)).toBe(80n * UNIT);
  }, TIMEOUT);

  it('leaves a history that verifies, with refusals kept apart as attempts', async () => {
    const history = await readIndexedHistory(read(), indexerUrl);
    expect(history.status).toBe('verified');
    // One policy, six payments (3, 1, 1, 5, 5, 5), pause, resume, revocation.
    expect(history.entries.map((record) => record.entry.outcome.kind)).toEqual([
      'PolicyCreated', 'Executed', 'AccountPayment', 'AccountPayment', 'Executed', 'Executed', 'Executed',
      'PauseChanged', 'PauseChanged', 'PolicyRevoked',
    ]);
    const attempts = await (await fetch(new URL(`v1/wallets/${wallet}/attempts`, indexerUrl))).json() as
      { attempts: { error: string | null; kind: string }[] };
    expect(attempts.attempts.map((attempt) => attempt.error)).toEqual([
      'PaymentLimitExceeded', 'RecipientNotAllowed', 'DailyLimitExceeded', 'Paused', 'Revoked', 'Revoked',
    ]);
    expect(attempts.attempts.every((attempt) => attempt.kind === 'simulation')).toBe(true);
  }, TIMEOUT);
});
