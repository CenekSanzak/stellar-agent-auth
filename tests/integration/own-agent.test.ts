import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend } from '../../apps/demo/server/backend.js';
import type { Deployment } from '../../apps/demo/server/deployment.js';
import { setupDeployment } from '../../apps/demo/server/setup.js';
import type { TaskResult } from '../../apps/demo/server/agent.js';
import { configure, createMcpServer, createWalletAgent, initAgent, main, readSettings } from '../../packages/mcp/src/index.js';
import { readAgent } from '../../packages/sdk/src/agents.js';
import { ownerInvocation, walletDeployment } from '../../packages/sdk/src/client.js';
import { policyHash } from '../../packages/sdk/src/encoding.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import { MemoryJournal, invoke, networkContext, pipelineLimits, type NetworkContext } from '../../packages/sdk/src/transactions.js';
import type { Policy } from '../../packages/sdk/src/types.js';
import { readWalletBalance } from '../../packages/sdk/src/wallet.js';
import { airdrop, localNetwork } from './support/local-network.js';

const TIMEOUT = 300_000;
const UNIT = 10_000_000n;
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');

/**
 * Someone brings their own agent. The agent's side runs as it would on their machine: one command creates its
 * keys, registers it, has it verified and tells the owner about it. The owner, a key held by the test, then
 * approves an allowance for it, and the agent pays through its MCP tools with no settings but its home directory.
 */
describe('bringing your own agent, on local Stellar', () => {
  let directory: string;
  let home: string;
  let deployment: Deployment;
  let backend: Awaited<ReturnType<typeof createBackend>>;
  let http: Server;
  let base: string;
  let server: rpc.Server;
  let context: NetworkContext;
  let wallet: string;
  let agentId: string;
  let signer: string;
  let policy: Uint8Array;
  const owner = Keypair.random();
  const ownerSigner = keypairSigner(owner);
  const journal = new MemoryJournal();
  const limits = pipelineLimits({ maxFee: 100_000_000n });
  const clients: Client[] = [];

  const post = async (path: string, body: unknown) => {
    const response = await fetch(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const get = async (path: string) => {
    const response = await fetch(new URL(path, base));
    return { status: response.status, text: await response.text() };
  };
  const at = (path: string) => new URL(path, base).href;

  beforeAll(async () => {
    const net = await localNetwork();
    server = net.server;
    directory = mkdtempSync(join(tmpdir(), 'own-agent-'));
    home = join(directory, 'agent-home');
    deployment = await setupDeployment({
      env: process.env, directory: join(directory, 'run'), record: join(directory, 'deployment.json'), log: () => {},
    });
    context = await networkContext(server, deployment.passphrase);
    backend = await createBackend({
      deployment, directory: join(directory, 'state'), env: process.env,
      limits: { tasksPerClientPerMinute: 1_000, agentSetupPerClientPerHour: 1_000 },
    });
    http = createServer((request, response) => { void backend.handler(request, response); });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
    backend.listening(base);
    wallet = backend.walletOf(owner.publicKey());
  }, TIMEOUT);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    await backend?.stop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('says that agents can be brought here and verified', async () => {
    const config = JSON.parse((await get('v1/config')).text) as Record<string, any>;
    expect(config['own_agents']).toEqual({ setup: true, verify: true });
    expect(config['agent_registry']).toBe(deployment.agent_registry);
    expect(JSON.parse((await get(`v1/agents?owner=${owner.publicKey()}`)).text)).toEqual({ agents: [] });
  }, TIMEOUT);

  it('sets an agent up with one command: keys, identity, verification, and a note to the owner', async () => {
    const result = await initAgent({ market: base, owner: owner.publicKey(), name: 'Test agent', description: 'An agent in a test', home });
    ({ agent_id: agentId, signer } = result);
    expect(result).toMatchObject({ registered: 'now', wallet, approve_at: at(`?agent=${agentId}`), verification: { status: 'published' } });
    expect((result.verification as { checks: { kind: string; outcome: string }[] }).checks).toEqual(expect.arrayContaining([
      { kind: 'Metadata', outcome: 'Passed' }, { kind: 'SignerAccount', outcome: 'Passed' }, { kind: 'Endpoint', outcome: 'NotApplicable' },
      { kind: 'Code', outcome: 'Unsupported' },
    ]));
    // It is a new identity, not the built-in agent's, with a key that never left this directory.
    expect(agentId).not.toBe(deployment.agent.agent_id);
    expect(signer).not.toBe(deployment.agent.signer);
    for (const name of ['agent', 'controller']) expect(statSync(join(home, 'keys', `${name}.key`)).mode & 0o077).toBe(0);
    expect(await readSettings(home)).toMatchObject({ market: base, owner: owner.publicKey(), agent_id: agentId, signer });

    // The identity carries the hash of the document the market serves for it.
    const identity = await readAgent({ server, contractId: deployment.agent_registry, source: owner.publicKey(), networkPassphrase: deployment.passphrase }, BigInt(agentId));
    const document = await get(`agents/${signer}.json`);
    expect(JSON.parse(document.text)).toEqual({
      schema: 'stellar-agent-auth/agent-metadata/v1', name: 'Test agent', description: 'An agent in a test', endpoints: [],
    });
    expect(hex(identity.metadata_hash)).toBe(createHash('sha256').update(document.text).digest('hex'));
    expect(identity).toMatchObject({ signer, disabled: false, revision: 1n });
    expect(identity.controller).not.toBe(signer);
    // The owner's page can now list it.
    expect(JSON.parse((await get(`v1/agents?owner=${owner.publicKey()}`)).text)).toEqual({ agents: [{ agent_id: agentId, name: 'Test agent', signer }] });
  }, TIMEOUT);

  it('can be run again without making a second agent or a second result', async () => {
    const again = await initAgent({ market: base, owner: owner.publicKey(), name: 'Another name', home });
    expect(again).toMatchObject({ agent_id: agentId, signer, registered: 'earlier', verification: { status: 'current' } });
    // The document is what was registered; a new name does not rewrite it.
    expect(JSON.parse((await get(`agents/${signer}.json`)).text).name).toBe('Test agent');
    await expect(initAgent({ market: 'https://other.example/', owner: owner.publicKey(), home, fetch: async () => Response.json({
      rpc_url: 'x', passphrase: 'another network', network: 'testnet', wallet_salt: 'ab'.repeat(32), agent_registry: deployment.agent_registry, own_agents: { setup: true },
    }) })).rejects.toThrow('already holds an agent');
    await expect(initAgent({ market: base, owner: 'someone', home })).rejects.toThrow('--owner must be');
  }, TIMEOUT);

  it('explains the two steps that are left, to whoever ran the command', async () => {
    const lines: string[] = [];
    expect(await main(['init', '--market', base, '--owner', owner.publicKey(), '--home', home], {}, (line) => lines.push(line))).toBe(0);
    const said = lines.join('\n');
    expect(said).toContain(`Agent ${agentId} is already registered, and already verified`);
    expect(said).toContain('It cannot spend anything yet');
    expect(said).toContain(at(`?agent=${agentId}`));
    expect(said).toMatch(/claude mcp add agent-wallet -- node .+ mcp/);
    expect(said).not.toMatch(/S[A-Z2-7]{55}/);
    expect(await main(['init'], {}, (line) => lines.push(line))).toBe(2);
  }, TIMEOUT);

  it('refuses what an agent service should not do for a stranger', async () => {
    expect(await post('v1/agents/metadata', { signer: 'nobody', name: 'x' })).toMatchObject({ status: 400 });
    expect(await post('v1/agents/metadata', { signer, name: '<script>alert(1)</script>' })).toMatchObject({ status: 400 });
    expect(await post('v1/agents/metadata', { signer, name: 'x'.repeat(65) })).toMatchObject({ status: 400 });
    expect(await post('v1/agents/verify', { agent_id: '999999' })).toMatchObject({ status: 404 });
    expect(await post('v1/agents/verify', { agent_id: 'one' })).toMatchObject({ status: 400 });
    // The built-in agent is not something a visitor links to themselves.
    expect(await post('v1/agents/link', { owner: owner.publicKey(), agent_id: deployment.agent.agent_id })).toMatchObject({ status: 403 });
    expect(await post('v1/agents/link', { owner: 'nobody', agent_id: agentId })).toMatchObject({ status: 400 });
    expect((await get('v1/agents?owner=nobody')).status).toBe(400);
    expect((await get(`agents/${Keypair.random().publicKey()}.json`)).status).toBe(404);
    expect((await get('agents/..%2F..%2Fdeployment.json')).status).toBe(404);
  }, TIMEOUT);

  it('pays under an allowance the owner approves for it, with no settings but its home directory', async () => {
    await airdrop(server, owner.publicKey());
    expect((await invoke(context, ownerSigner, walletDeployment(deployment.passphrase, owner.publicKey(), bytes(deployment.wallet_wasm_hash),
      deployment.agent_registry, deployment.verification_registry, bytes(deployment.wallet_salt)), journal, { limits })).status).toBe('success');
    expect((await post('v1/fund', { owner: owner.publicKey() })).status).toBe(200);

    const mcp = createMcpServer(createWalletAgent(await configure({ STELLAR_AGENT_WALLET_HOME: home })));
    const [near, far] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-host', version: '0.0.0' });
    await Promise.all([mcp.connect(far), client.connect(near)]);
    clients.push(client);
    const call = async (tool: string, args: Record<string, unknown> = {}) =>
      JSON.parse(((await client.callTool({ name: tool, arguments: args })).content as { text: string }[])[0]!.text) as Record<string, any>;

    // Registered and verified is not allowed: the wallet is closed to it until the owner says otherwise.
    expect(await call('allowance')).toMatchObject({ wallet, agent: signer, allowed: false });

    const now = BigInt((await server.getLatestLedger()).closeTime);
    const value: Policy = {
      schema_version: 1, policy_id: new Uint8Array(32).fill(9), agent_id: BigInt(agentId), revision: 1n, signer,
      provider: deployment.provider.address, required_checks: ['Metadata', 'SignerAccount'], max_assessment_age: 30n * 86_400n,
      max_risk_score: 10, assets: [{ asset: deployment.asset.contract, per_transaction: 5n * UNIT, per_day: 6n * UNIT, total: 20n * UNIT }],
      allowed_recipients: (['ledger-wire', 'deep-archive', 'audited-sources'] as const).map((id) => deployment.vendors[id]).sort(),
      blocked_recipients: [], valid_after: now - 60n, valid_until: now + 7n * 86_400n, action_kinds: ['Transfer'], service: null,
    };
    const approved = await invoke(context, ownerSigner, ownerInvocation(context, wallet, 'approve_policy', { policy: value }, ownerSigner), journal, { limits });
    expect(approved.status).toBe('success');
    policy = policyHash(deployment.passphrase, wallet, value);

    expect(await call('allowance')).toMatchObject({ allowed: true, policy: hex(policy), assets: [{ per_purchase: '5', left_today: '6' }] });
    // The seller checks this agent's own verification, and sells to it.
    expect(await call('buy', { url: at('x402/ledger-wire/brief') })).toMatchObject({ outcome: 'paid', amount: '1' });
    expect(await call('buy', { url: at('x402/deep-archive/ledgers') })).toMatchObject({ outcome: 'blocked', error: 'PaymentLimitExceeded' });
    expect(await call('buy', { url: at('x402/audited-sources/report') })).toMatchObject({ outcome: 'declined', by: 'seller' });
    expect((await call('allowance'))['assets'][0]).toMatchObject({ spent_today: '1', wallet_balance: '99' });
  }, TIMEOUT);

  it('keeps each agent to its own allowance: the built-in agent cannot spend under this one', async () => {
    const before = await readWalletBalance({ server, contractId: wallet, source: owner.publicKey(), networkPassphrase: deployment.passphrase }, deployment.asset.contract);
    const tried = await post('v1/tasks', { owner: owner.publicKey(), task: 'brief', policy_hash: hex(policy) });
    expect(tried.status).toBe(200);
    const result = tried.body as unknown as TaskResult;
    // The policy would allow the payment, so the wallet's read-only check passes; the wallet then refuses the
    // signature, which is not this policy's agent's, when the payment is simulated for the seller. Nothing is paid.
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ tx_hash: null, content: null });
    expect(result.steps[0]!.status).not.toBe('paid');
    expect(await readWalletBalance({ server, contractId: wallet, source: owner.publicKey(), networkPassphrase: deployment.passphrase }, deployment.asset.contract)).toBe(before);
  }, TIMEOUT);
});
