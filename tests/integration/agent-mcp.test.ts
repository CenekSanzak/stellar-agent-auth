import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend } from '../../apps/demo/server/backend.js';
import type { Deployment } from '../../apps/demo/server/deployment.js';
import { setupDeployment } from '../../apps/demo/server/setup.js';
import { configure, createMcpServer, createWalletAgent } from '../../packages/mcp/src/index.js';
import { ownerInvocation, walletDeployment } from '../../packages/sdk/src/client.js';
import { policyHash } from '../../packages/sdk/src/encoding.js';
import { readIndexedHistory } from '../../packages/sdk/src/history.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import { MemoryJournal, invoke, networkContext, pipelineLimits, type NetworkContext } from '../../packages/sdk/src/transactions.js';
import type { Policy, WalletArgs, WalletOwnerMethod } from '../../packages/sdk/src/types.js';
import { airdrop, localNetwork } from './support/local-network.js';

const TIMEOUT = 300_000;
const UNIT = 10_000_000n;
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');

/**
 * An AI agent's side of the wallet, through the MCP server an agent host would start. The test is the host: it
 * connects an MCP client and calls the tools a model would call. The sellers are the demo's, on the local network,
 * and the owner is a key held by the test.
 */
describe('an agent over MCP, paying from a policy-limited wallet on local Stellar', () => {
  let directory: string;
  let deployment: Deployment;
  let backend: Awaited<ReturnType<typeof createBackend>>;
  let http: Server;
  let base: string;
  let server: rpc.Server;
  let context: NetworkContext;
  let wallet: string;
  let policy: Uint8Array;
  let env: Record<string, string>;
  let client: Client;
  const owner = Keypair.random();
  const signer = keypairSigner(owner);
  const journal = new MemoryJournal();
  const limits = pipelineLimits({ maxFee: 100_000_000n });
  const clients: Client[] = [];

  /** Start the agent's server with `settings` and connect a client to it, in this process. */
  async function connect(settings: Record<string, string>) {
    const mcp = createMcpServer(createWalletAgent(await configure(settings)));
    const [near, far] = InMemoryTransport.createLinkedPair();
    const connected = new Client({ name: 'test-host', version: '0.0.0' });
    await Promise.all([mcp.connect(far), connected.connect(near)]);
    clients.push(connected);
    return connected;
  }
  /** Call a tool as a model would, and read its answer. */
  async function call(tool: string, args: Record<string, unknown> = {}, on: Client = client) {
    const result = await on.callTool({ name: tool, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { failed: result.isError === true, answer: JSON.parse(content[0]!.text) as Record<string, any> };
  }
  const ownerCall = async <M extends WalletOwnerMethod>(method: M, args: WalletArgs[M]) => {
    const outcome = await invoke(context, signer, ownerInvocation(context, wallet, method, args, signer), journal, { limits });
    expect(outcome.status, method).toBe('success');
  };
  const at = (path: string) => new URL(path, base).href;

  beforeAll(async () => {
    const net = await localNetwork();
    server = net.server;
    directory = mkdtempSync(join(tmpdir(), 'agent-mcp-'));
    deployment = await setupDeployment({
      env: process.env, directory: join(directory, 'run'), record: join(directory, 'deployment.json'), log: () => {},
    });
    context = await networkContext(server, deployment.passphrase);
    backend = await createBackend({ deployment, directory: join(directory, 'state'), env: process.env });
    http = createServer((request, response) => { void backend.handler(request, response); });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
    backend.listening(base);
    wallet = backend.walletOf(owner.publicKey());
    // What an agent host is configured with: where the key is, which market, whose wallet.
    env = { AGENT_KEY: `file:${join(deployment.key_directory!, 'agent.key')}`, AGENT_MARKET: base, AGENT_OWNER: owner.publicKey() };
    client = await connect(env);
  }, TIMEOUT);

  afterAll(async () => {
    await Promise.all(clients.map((connected) => connected.close()));
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    await backend?.stop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('offers four tools and tells the model whose money it is', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['allowance', 'sellers', 'price', 'buy']);
    expect(tools.tools.find((tool) => tool.name === 'buy')!.description).toContain('This spends the owner\'s money');
    expect(client.getInstructions()).toContain('do not look for a way around it');
    const offers = (await call('sellers')).answer as unknown as { seller: string; title: string; url: string; listed_price: string }[];
    expect(offers).toHaveLength(5);
    expect(offers).toContainEqual({ seller: 'Deep Archive', title: 'Recent ledgers dataset', url: at('x402/deep-archive/ledgers'), listed_price: '8 tUSD' });
  }, TIMEOUT);

  it('can buy nothing before the owner has a wallet and an allowance', async () => {
    expect((await call('allowance')).answer).toMatchObject({ allowed: false, reason: expect.stringContaining('no wallet at this address yet') });
    expect((await call('buy', { url: at('x402/ledger-wire/brief') })).answer).toMatchObject({ outcome: 'blocked', by: 'wallet' });

    await airdrop(server, owner.publicKey());
    const created = await invoke(context, signer, walletDeployment(deployment.passphrase, owner.publicKey(),
      bytes(deployment.wallet_wasm_hash), deployment.agent_registry, deployment.verification_registry,
      bytes(deployment.wallet_salt)), journal, { limits });
    expect(created.status).toBe('success');
    const funded = await fetch(new URL('v1/fund', base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: owner.publicKey() }),
    });
    expect(funded.status).toBe(200);
    // A wallet with money and no allowance is still closed to the agent.
    expect((await call('allowance')).answer).toMatchObject({ allowed: false, reason: expect.stringContaining('has not approved an allowance') });
    expect((await call('price', { url: at('x402/ledger-wire/brief') })).answer).toMatchObject({ priced: false });
  }, TIMEOUT);

  it('reads the allowance the owner approved, in the owner\'s numbers', async () => {
    const now = BigInt((await server.getLatestLedger()).closeTime);
    const value: Policy = {
      schema_version: 1, policy_id: new Uint8Array(32).fill(7), agent_id: BigInt(deployment.agent.agent_id),
      revision: BigInt(deployment.agent.revision), signer: deployment.agent.signer, provider: deployment.provider.address,
      required_checks: ['Endpoint', 'Metadata', 'SignerAccount'], max_assessment_age: 30n * 86_400n, max_risk_score: 10,
      assets: [{ asset: deployment.asset.contract, per_transaction: 5n * UNIT, per_day: 6n * UNIT, total: 20n * UNIT }],
      allowed_recipients: (['ledger-wire', 'deep-archive', 'audited-sources'] as const).map((id) => deployment.vendors[id]).sort(),
      blocked_recipients: [], valid_after: now - 60n, valid_until: now + 7n * 86_400n, action_kinds: ['Transfer'], service: null,
    };
    await ownerCall('approve_policy', { policy: value });
    policy = policyHash(deployment.passphrase, wallet, value);
    const { answer } = await call('allowance');
    expect(answer).toMatchObject({
      wallet, agent: deployment.agent.signer, allowed: true, frozen: false, policy: hex(policy),
      assets: [{ asset: deployment.asset.contract, wallet_balance: '100', per_purchase: '5', per_day: '6', total: '20', spent_today: '0', left_today: '6' }],
    });
    expect(answer['may_pay']).toHaveLength(3);
    expect(answer['may_pay']).not.toContain(deployment.vendors['bargain-data']);
  }, TIMEOUT);

  it('learns from the wallet what it would pay, before buying anything', async () => {
    expect((await call('price', { url: at('x402/ledger-wire/brief') })).answer).toMatchObject({
      priced: true, amount: '1', asset: deployment.asset.contract, pay_to: deployment.vendors['ledger-wire'], wallet_would: 'pay',
    });
    expect((await call('price', { url: at('x402/deep-archive/ledgers') })).answer)
      .toMatchObject({ amount: '8', wallet_would: 'refuse', error: 'PaymentLimitExceeded' });
    expect((await call('price', { url: at('x402/bargain-data/headlines') })).answer)
      .toMatchObject({ amount: '0.5', wallet_would: 'refuse', error: 'RecipientNotAllowed' });
    expect((await call('price', { url: at('v1/config') })).answer).toMatchObject({ priced: false, reason: expect.stringContaining('does not ask for payment') });
    // Asking a price spent nothing.
    expect((await call('allowance')).answer['assets'][0]).toMatchObject({ spent_today: '0', wallet_balance: '100' });
  }, TIMEOUT);

  it('buys inside the allowance, and is told plainly when the wallet or a seller says no', async () => {
    const bought = (await call('buy', { url: at('x402/ledger-wire/brief') })).answer;
    expect(bought).toMatchObject({
      outcome: 'paid', amount: '1', pay_to: deployment.vendors['ledger-wire'], content: { title: expect.stringContaining('Network brief') },
    });
    expect(bought['transaction']).toMatch(/^[0-9a-f]{64}$/);
    expect((await call('allowance')).answer['assets'][0]).toMatchObject({ spent_today: '1', left_today: '5', wallet_balance: '99' });

    expect((await call('buy', { url: at('x402/deep-archive/ledgers') })).answer).toMatchObject({
      outcome: 'blocked', by: 'wallet', error: 'PaymentLimitExceeded', note: expect.stringContaining('do not try to get around it'),
    });
    expect((await call('buy', { url: at('x402/bargain-data/headlines') })).answer).toMatchObject({ outcome: 'blocked', error: 'RecipientNotAllowed' });
    expect((await call('buy', { url: at('x402/audited-sources/report') })).answer).toMatchObject({
      outcome: 'declined', by: 'seller', error: expect.stringContaining('payee_gate_CheckNotPassed'), note: 'Nothing was paid.',
    });
    // Three refusals moved nothing.
    expect((await call('allowance')).answer['assets'][0]).toMatchObject({ spent_today: '1', wallet_balance: '99' });
  }, TIMEOUT);

  it('refuses addresses it should not fetch, as a failed call and not as a purchase', async () => {
    const plain = await call('buy', { url: 'http://example.com/report' });
    expect(plain).toMatchObject({ failed: true, answer: { error: 'Only https addresses can be bought from' } });
    await expect(client.callTool({ name: 'buy', arguments: { url: 'not an address' } })).resolves.toMatchObject({ isError: true });
  }, TIMEOUT);

  it('stops when the owner freezes the wallet, and has nothing to buy under once the allowance is ended', async () => {
    await ownerCall('pause', {});
    expect((await call('allowance')).answer).toMatchObject({ frozen: true, note: expect.stringContaining('frozen') });
    expect((await call('buy', { url: at('x402/ledger-wire/brief') })).answer).toMatchObject({ outcome: 'blocked', error: 'Paused' });
    await ownerCall('resume', {});
    await ownerCall('revoke_policy', { policy_hash: policy });
    expect((await call('allowance')).answer).toMatchObject({ allowed: false });
    expect((await call('buy', { url: at('x402/ledger-wire/brief') })).answer).toMatchObject({ outcome: 'blocked', by: 'wallet' });
    // An agent that keeps hold of the ended policy and tries anyway is refused by the wallet itself.
    const stubborn = await connect({ ...env, AGENT_POLICY: hex(policy) });
    expect((await call('buy', { url: at('x402/ledger-wire/brief') }, stubborn)).answer).toMatchObject({ outcome: 'blocked', error: 'Revoked' });
  }, TIMEOUT);

  it('leaves its purchase in the wallet\'s own record, where the owner\'s page reads it', async () => {
    await backend.indexer.cycle();
    const history = await readIndexedHistory(
      { server, contractId: wallet, source: owner.publicKey(), networkPassphrase: deployment.passphrase }, new URL('indexer/', base).href);
    expect(history.status).toBe('verified');
    expect(history.entries.map((record) => record.entry.outcome.kind))
      .toEqual(['PolicyCreated', 'AccountPayment', 'PauseChanged', 'PauseChanged', 'PolicyRevoked']);
  }, TIMEOUT);

  it('runs as the process an agent host starts, speaking MCP over standard input and output', async () => {
    const built = fileURLToPath(new URL('../../packages/mcp/dist/index.js', import.meta.url));
    const host = new Client({ name: 'test-host', version: '0.0.0' });
    clients.push(host);
    await host.connect(new StdioClientTransport({ command: process.execPath, args: [built], env: { ...env, PATH: process.env['PATH'] ?? '' } }));
    expect((await host.listTools()).tools).toHaveLength(4);
    expect((await call('allowance', {}, host)).answer).toMatchObject({ wallet, allowed: false });
  }, TIMEOUT);

  it('still starts when its market cannot be reached, and says why through its tools', async () => {
    const built = fileURLToPath(new URL('../../packages/mcp/dist/index.js', import.meta.url));
    const host = new Client({ name: 'test-host', version: '0.0.0' });
    clients.push(host);
    // Nothing listens on this port. A server that failed to start would leave its host with nothing to say.
    await host.connect(new StdioClientTransport({
      command: process.execPath, args: [built], env: { ...env, AGENT_MARKET: 'http://127.0.0.1:9/', PATH: process.env['PATH'] ?? '' },
    }));
    expect((await host.listTools()).tools).toHaveLength(4);
    const answer = await call('allowance', {}, host);
    expect(answer.failed).toBe(true);
    expect(answer.answer['error']).toMatch(/fetch failed|ECONNREFUSED|market/i);
  }, TIMEOUT);

  it('will not start without knowing which key and which wallet', async () => {
    await expect(configure({})).rejects.toThrow('AGENT_KEY');
    await expect(configure({ AGENT_KEY: Keypair.random().secret() })).rejects.toThrow('never a secret key');
    await expect(configure({ AGENT_KEY: env['AGENT_KEY']!, AGENT_MARKET: base })).rejects.toThrow('AGENT_WALLET');
    await expect(configure({ ...env, AGENT_OWNER: 'nobody' })).rejects.toThrow('G... account address');
    await expect(configure({ ...env, AGENT_POLICY: 'short' })).rejects.toThrow('AGENT_POLICY');
  }, TIMEOUT);
});
