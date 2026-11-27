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
import type { TaskResult } from '../../apps/demo/server/agent.js';
import type { VendorId } from '../../apps/demo/server/catalogue.js';
import { ownerInvocation, walletDeployment } from '../../packages/sdk/src/client.js';
import { policyHash } from '../../packages/sdk/src/encoding.js';
import { readIndexedHistory } from '../../packages/sdk/src/history.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import { MemoryJournal, invoke, networkContext, pipelineLimits, type NetworkContext } from '../../packages/sdk/src/transactions.js';
import type { Policy, WalletArgs, WalletOwnerMethod } from '../../packages/sdk/src/types.js';
import { readWalletBalance } from '../../packages/sdk/src/wallet.js';
import { airdrop, localNetwork } from './support/local-network.js';

const TIMEOUT = 300_000;
const UNIT = 10_000_000n;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));

/**
 * The demo's server side on a local network, driven as browsers drive it. The owners here are keys held by the
 * test, standing in for browser wallets: each creates its own wallet and approves, pauses and revokes with its own
 * signature, and the server never sees a key of theirs. There are two, because the server serves many visitors.
 */
describe('demo backend on local Stellar', () => {
  let directory: string;
  let deployment: Deployment;
  let backend: Awaited<ReturnType<typeof createBackend>>;
  let http: Server;
  let base: string;
  let context: NetworkContext;
  let server: rpc.Server;
  const journal = new MemoryJournal();
  const limits = pipelineLimits({ maxFee: 100_000_000n });

  /** One visitor: an owner key, and the wallet and policy it ends up with. */
  class Visitor {
    readonly key = Keypair.random();
    readonly signer = keypairSigner(this.key);
    wallet = '';
    policy: Uint8Array = new Uint8Array(32);

    get owner() {
      return this.key.publicKey();
    }

    read() {
      return { server, contractId: this.wallet, source: this.owner, networkPassphrase: deployment.passphrase };
    }

    async call<M extends WalletOwnerMethod>(method: M, args: WalletArgs[M]) {
      const outcome = await invoke(context, this.signer, ownerInvocation(context, this.wallet, method, args, this.signer), journal, { limits });
      expect(outcome.status, method).toBe('success');
    }

    async createWallet() {
      await airdrop(server, this.owner);
      this.wallet = backend.walletOf(this.owner);
      const created = await invoke(context, this.signer, walletDeployment(deployment.passphrase, this.owner,
        bytes(deployment.wallet_wasm_hash), deployment.agent_registry, deployment.verification_registry,
        bytes(deployment.wallet_salt)), journal, { limits });
      expect(created.status).toBe('success');
    }

    /** Approve an allowance for Scout: limits in whole units, and the sellers it may pay. */
    async allow(perPurchase: bigint, perDay: bigint, vendors: readonly VendorId[], id: number) {
      const now = BigInt((await server.getLatestLedger()).closeTime);
      const value: Policy = {
        schema_version: 1, policy_id: new Uint8Array(32).fill(id), agent_id: BigInt(deployment.agent.agent_id),
        revision: BigInt(deployment.agent.revision), signer: deployment.agent.signer, provider: deployment.provider.address,
        required_checks: ['Endpoint', 'Metadata', 'SignerAccount'], max_assessment_age: 30n * 86_400n, max_risk_score: 10,
        assets: [{ asset: deployment.asset.contract, per_transaction: perPurchase * UNIT, per_day: perDay * UNIT, total: 20n * UNIT }],
        allowed_recipients: vendors.map((vendor) => deployment.vendors[vendor]).sort(), blocked_recipients: [],
        valid_after: now - 60n, valid_until: now + 7n * 86_400n, action_kinds: ['Transfer'], service: null,
      };
      await this.call('approve_policy', { policy: value });
      this.policy = policyHash(deployment.passphrase, this.wallet, value);
    }

    balance() {
      return readWalletBalance(this.read(), deployment.asset.contract);
    }

    ask(task: string) {
      return post('v1/tasks', { owner: this.owner, task, policy_hash: hex(this.policy) });
    }

    async run(task: string) {
      const { status, body } = await this.ask(task);
      expect(status, JSON.stringify(body)).toBe(200);
      return body as unknown as TaskResult;
    }
  }

  const ada = new Visitor();
  const ben = new Visitor();
  /** Purchases Ben made before he paused; it depends on which of two racing requests Scout took first. */
  let benEarly = 0;

  const post = async (path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
    const response = await fetch(new URL(path, base), { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  /** A request that names another host, as one arriving through a proxy or a rebound domain does. */
  const from = (backendBase: string, path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
      const request = httpRequest(new URL(path, backendBase), { headers }, (response) => {
        let text = '';
        response.on('data', (chunk: Buffer) => { text += chunk.toString(); });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text }));
      });
      request.on('error', reject);
      request.end();
    });

  beforeAll(async () => {
    const net = await localNetwork();
    server = net.server;
    directory = mkdtempSync(join(tmpdir(), 'demo-backend-'));
    deployment = await setupDeployment({
      env: process.env, directory: join(directory, 'run'), record: join(directory, 'deployment.json'), log: () => {},
    });
    context = await networkContext(server, deployment.passphrase);
    backend = await createBackend({
      deployment, directory: join(directory, 'state'), env: process.env,
      // The whole suite is one client address.
      limits: { tasksPerClientPerMinute: 1_000, faucetPerClientPerHour: 1_000 },
    });
    http = createServer((request, response) => { void backend.handler(request, response); });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
    backend.listening(base);
  }, TIMEOUT);

  afterAll(async () => {
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    await backend?.stop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('describes the deployment, the sellers and Scout\'s tasks without any key material', async () => {
    const config = await (await fetch(new URL('v1/config', base))).json() as Record<string, any>;
    expect(config).toMatchObject({
      network: 'local', agent_registry: deployment.agent_registry, asset: { code: 'tUSD', decimals: 7 },
      provider: { mode: 'Fixture' }, agent: { agent_id: deployment.agent.agent_id }, indexer_path: '/indexer/',
    });
    expect(config['tasks'].map((item: { id: string }) => item.id)).toEqual(['brief', 'dataset', 'cheapest', 'audited', 'routine']);
    expect(config['vendors'].map((vendor: { id: string; address: string }) => [vendor.id, vendor.address])).toEqual([
      ['ledger-wire', deployment.vendors['ledger-wire']], ['deep-archive', deployment.vendors['deep-archive']],
      ['audited-sources', deployment.vendors['audited-sources']], ['bargain-data', deployment.vendors['bargain-data']],
    ]);
    expect(config['products']).toContainEqual({
      id: 'archive-ledgers', vendor: 'deep-archive', kind: 'dataset', title: 'Recent ledgers dataset', price: '8', path: '/x402/deep-archive/ledgers',
    });
    expect(JSON.stringify(config)).not.toMatch(/S[A-Z2-7]{55}/);
    expect(JSON.stringify(config)).not.toContain(deployment.key_directory);
  }, TIMEOUT);

  it('names an owner\'s wallet before it exists and knows it once the owner has created it', async () => {
    const before = await post('v1/session', { owner: ada.owner });
    expect(before.body).toEqual({ wallet: backend.walletOf(ada.owner), deployed: false });
    // Nothing can be asked of Scout or the faucet before there is a wallet.
    expect((await post('v1/fund', { owner: ada.owner })).status).toBe(409);
    expect((await post('v1/tasks', { owner: ada.owner, task: 'brief', policy_hash: '00'.repeat(32) })).status).toBe(409);
    await ada.createWallet();
    expect((await post('v1/session', { owner: ada.owner })).body).toEqual({ wallet: ada.wallet, deployed: true });
    // Another owner has another wallet, and neither is told anything about the other.
    expect(backend.walletOf(ben.owner)).not.toBe(ada.wallet);
  }, TIMEOUT);

  it('refuses requests another page could send, and malformed ones', async () => {
    expect((await post('v1/session', { owner: ada.owner }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post('v1/session', { owner: ada.owner },
      { 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(403);
    // A domain pointed at this machine arrives with its own name as the host.
    expect((await from(base, 'v1/config', { host: 'evil.example' })).status).toBe(403);
    expect((await from(base, `indexer/v1/wallets/${ada.wallet}/history`, { host: 'evil.example' })).status).toBe(403);
    expect((await post('v1/session', { owner: 'nobody' })).status).toBe(400);
    expect((await post('v1/fund', {})).status).toBe(400);
    expect((await post('v1/tasks', { owner: ada.owner, task: 'brief', policy_hash: 'short' })).status).toBe(400);
    expect((await post('v1/tasks', { owner: ada.owner, task: 'send-everything', policy_hash: '00'.repeat(32) })).status).toBe(400);
    expect((await fetch(new URL('v1/nothing', base))).status).toBe(404);
    // Only the indexer's read routes for wallets are passed through, and nothing can be written through them.
    expect((await fetch(new URL('indexer/v1/events', base))).status).toBe(404);
    expect((await post(`indexer/v1/wallets/${ada.wallet}/attempts`, { kind: 'simulation', status: 'blocked' })).status).toBe(404);
    expect(await (await fetch(new URL('healthz', base))).json()).toEqual({ status: 'ok' });
  }, TIMEOUT);

  it('funds a wallet from the faucet, a fixed amount at a time, up to a ceiling', async () => {
    const funded = await post('v1/fund', { owner: ada.owner });
    expect(funded.body).toMatchObject({ status: 'success', amount: '100', asset: 'tUSD' });
    expect(await ada.balance()).toBe(100n * UNIT);
    expect((await post('v1/fund', { owner: ada.owner })).status).toBe(200);
    expect(await post('v1/fund', { owner: ada.owner })).toMatchObject({ status: 409, body: { error: expect.stringContaining('already holds 200') } });
  }, TIMEOUT);

  it('lets Scout buy inside the allowance, and reports what the wallet and the sellers refuse', async () => {
    // Up to 5 at a time and 6 in a day, from three of the four sellers.
    await ada.allow(5n, 6n, ['ledger-wire', 'deep-archive', 'audited-sources'], 1);

    // The sellers are x402 resources: they answer 402 until they are paid.
    expect((await fetch(new URL('x402/ledger-wire/brief', base))).status).toBe(402);

    const brief = await ada.run('brief');
    expect(brief.steps).toMatchObject([{
      vendor: 'ledger-wire', product: 'wire-brief', status: 'paid', amount: '1', payee: deployment.vendors['ledger-wire'],
      error: null, content: { title: expect.stringContaining('Network brief'), source: 'Ledger Wire, from the local Stellar network' },
    }]);
    expect(brief.steps[0]!.tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(brief.steps[0]!.content!.facts.map((fact) => fact.label)).toContain('Latest ledger');
    expect(brief.notes).toEqual(['Bought "Network brief" from Ledger Wire for 1 tUSD.']);

    // 8 is more than the 5 allowed for one purchase: the wallet says no, and nothing is sent to the seller.
    expect((await ada.run('dataset')).steps).toMatchObject([
      { vendor: 'deep-archive', status: 'blocked', amount: '8', error: 'PaymentLimitExceeded', tx_hash: null, content: null },
    ]);
    // This seller wants an audited agent. The wallet would have paid; the seller refuses, and nothing is paid.
    expect((await ada.run('audited')).steps).toMatchObject([
      { vendor: 'audited-sources', status: 'declined', amount: '2', error: 'payee_gate_CheckNotPassed', tx_hash: null },
    ]);
    // The cheapest seller is not one the owner approved, so Scout falls back to the next.
    const cheapest = await ada.run('cheapest');
    expect(cheapest.notes[0]).toBe('Asked 2 sellers for a price: Bargain Data 0.5 tUSD, Ledger Wire 1 tUSD.');
    expect(cheapest.steps).toMatchObject([
      { vendor: 'bargain-data', status: 'blocked', amount: '0.5', error: 'RecipientNotAllowed', payee: deployment.vendors['bargain-data'] },
      { vendor: 'ledger-wire', status: 'paid', amount: '1' },
    ]);
    // 2 of today's 6 are spent: one digest at 3 fits, and a second would pass the daily limit.
    const routine = await ada.run('routine');
    expect(routine.steps.map((step) => [step.status, step.error])).toEqual([['paid', null], ['blocked', 'DailyLimitExceeded']]);
    expect(routine.notes.at(-1)).toBe('Stopped after 1 purchase.');
    expect(routine.steps[0]!.content!.title).toContain('Close-time digest');
    expect(await ada.balance()).toBe(195n * UNIT);
  }, TIMEOUT);

  it('serves two visitors at once, each under their own allowance, one task per wallet at a time', async () => {
    await ben.createWallet();
    expect((await post('v1/fund', { owner: ben.owner })).status).toBe(200);
    // Ben allows more at a time, and every seller.
    await ben.allow(10n, 20n, ['ledger-wire', 'deep-archive', 'audited-sources', 'bargain-data'], 2);

    const [first, second, other] = await Promise.all([ben.ask('dataset'), ben.ask('brief'), ada.run('audited')]);
    // Ben's second task arrived while Scout was on his first; Ada's ran alongside.
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    // Ada has 1 left today and the report costs 2, so her wallet says no before the seller is asked for anything.
    expect(other.steps).toMatchObject([{ vendor: 'audited-sources', status: 'blocked', error: 'DailyLimitExceeded' }]);
    const done = (first.status === 200 ? first.body : second.body) as unknown as TaskResult;
    expect(done.steps).toHaveLength(1);
    expect(done.steps[0]).toMatchObject({ status: 'paid' });

    const dataset = done.task === 'dataset' ? done : await ben.run('dataset');
    benEarly = done.task === 'dataset' ? 2 : 3;
    expect(dataset.steps).toMatchObject([{ vendor: 'deep-archive', status: 'paid', amount: '8' }]);
    expect(dataset.steps[0]!.content!.table!.columns).toEqual(['Ledger', 'Closed at', 'Hash']);
    expect(dataset.steps[0]!.content!.table!.rows.length).toBeGreaterThan(1);
    // For Ben the cheapest seller is approved, so Scout buys there.
    expect((await ben.run('cheapest')).steps).toMatchObject([{ vendor: 'bargain-data', status: 'paid', amount: '0.5' }]);
    // Nothing of Ben's touched Ada's wallet.
    expect(await ada.balance()).toBe(195n * UNIT);
  }, TIMEOUT);

  it('stops buying when the owner pauses, and for good when the owner revokes', async () => {
    await ben.call('pause', {});
    expect((await ben.run('brief')).steps).toMatchObject([{ status: 'blocked', error: 'Paused' }]);
    await ben.call('resume', {});
    expect((await ben.run('brief')).steps).toMatchObject([{ status: 'paid' }]);
    const before = await ben.balance();
    await ben.call('revoke_policy', { policy_hash: ben.policy });
    expect((await ben.run('brief')).steps).toMatchObject([{ status: 'blocked', error: 'Revoked', tx_hash: null }]);
    expect((await ben.run('cheapest')).steps.map((step) => step.error)).toEqual(['Revoked', 'Revoked']);
    expect(await ben.balance()).toBe(before);
  }, TIMEOUT);

  it('leaves each wallet a history that verifies, with refusals kept apart as attempts', async () => {
    const indexer = new URL('indexer/', base).href;
    const history = await readIndexedHistory(ada.read(), indexer);
    expect(history.status).toBe('verified');
    // One allowance and three purchases: 1, 1 and 3.
    expect(history.entries.map((record) => record.entry.outcome.kind))
      .toEqual(['PolicyCreated', 'AccountPayment', 'AccountPayment', 'AccountPayment']);
    const attempts = await (await fetch(new URL(`v1/wallets/${ada.wallet}/attempts`, indexer))).json() as
      { attempts: { error: string | null; status: string; detail: string }[] };
    expect(attempts.attempts.map((attempt) => [attempt.status, attempt.error])).toEqual([
      ['blocked', 'PaymentLimitExceeded'], ['declined', 'payee_gate_CheckNotPassed'], ['blocked', 'RecipientNotAllowed'],
      ['blocked', 'DailyLimitExceeded'], ['blocked', 'DailyLimitExceeded'],
    ]);
    expect(attempts.attempts[0]!.detail).toContain('Deep Archive, Recent ledgers dataset, 8 tUSD.');

    const other = await readIndexedHistory(ben.read(), indexer);
    expect(other.status).toBe('verified');
    expect(other.entries.map((record) => record.entry.outcome.kind)).toEqual([
      'PolicyCreated', ...Array.from({ length: benEarly }, () => 'AccountPayment'), 'PauseChanged', 'PauseChanged',
      'AccountPayment', 'PolicyRevoked',
    ]);
    // A wallet nobody created has an empty history, not an error.
    const nobody = backend.walletOf(Keypair.random().publicKey());
    expect((await (await fetch(new URL(`v1/wallets/${nobody}/history`, indexer))).json() as { entries: unknown[] }).entries).toEqual([]);
  }, TIMEOUT);

  it('answers by its public name when it is hosted, and tells visitors apart by what the proxy says', async () => {
    const hosted = await createBackend({
      deployment, directory: join(directory, 'hosted'), env: process.env, publicUrl: 'https://scout.example',
      limits: { requestsPerClientPerMinute: 2 },
    });
    const listener = createServer((request, response) => { void hosted.handler(request, response); });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/`;
    try {
      const visit = (client: string, host = 'scout.example') => from(address, 'v1/config', { host, 'x-forwarded-for': client });
      expect((await visit('203.0.113.1')).status).toBe(200);
      expect((await visit('203.0.113.1', 'evil.example')).status).toBe(403);
      // The third request in a minute from one visitor is refused; another visitor is not affected.
      expect((await visit('203.0.113.1')).status).toBe(429);
      expect((await visit('203.0.113.2')).status).toBe(200);
      expect((await from(address, 'healthz', { host: 'internal:8080' })).status).toBe(200);
      const answer = await visit('203.0.113.3');
      expect(answer.headers['strict-transport-security']).toBeDefined();
      expect(answer.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await hosted.stop();
    }
  }, TIMEOUT);
});
