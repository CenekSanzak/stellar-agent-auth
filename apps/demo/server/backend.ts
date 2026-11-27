import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { StrKey, rpc } from '@stellar/stellar-sdk';
import { startIndexer } from '@stellar-agent-auth/indexer';
import {
  MemoryJournal, deployedAddress, fromContractUnits, fundInvocation, invoke, keypairSigner, networkContext,
  pipelineLimits, readWalletBalance, readWalletOwner, readWalletRegistries, toContractUnits,
  type NetworkContext, type Signer,
} from '@stellar-agent-auth/sdk';
import { FileJournal, loadKey, loadKeypair } from '@stellar-agent-auth/sdk/node';
import {
  StellarExactFacilitator, createPaidService, inProcessFacilitator, payeeGate, tolerantUpstreamFacilitator, x402Network,
  type PayeeTerms,
} from '@stellar-agent-auth/x402';
import { ScoutAgent, TASKS, UnknownTask } from './agent.js';
import { agentReady } from './agent-ready.js';
import { AgentServiceError, createAgentService } from './agents.js';
import { LedgerWatch, PRODUCTS, VENDORS, backfill, observe, produce, vendorOf } from './catalogue.js';
import { hexToBytes, type Deployment } from './deployment.js';

/**
 * The demo's server side. It plays every part the owner does not: Scout the agent, the faucet that hands out the
 * test asset, the sellers and their x402 facilitator, and the indexer. Each has its own key. An owner's key never
 * comes here; owners sign in their browser.
 *
 * It serves many visitors at once. Each visitor has their own wallet, at an address derived from their account and
 * the deployment's salt, and is told apart by nothing else: there are no accounts and no sessions to keep.
 *
 * What a browser can ask of it is deliberately small:
 * - `GET /v1/config`: the deployment's public addresses, the sellers, and the tasks Scout can run;
 * - `POST /v1/session { owner }`: which wallet belongs to this owner, and whether it exists yet;
 * - `POST /v1/fund { owner }`: the faucet sends a fixed amount of the test asset to that owner's wallet;
 * - `POST /v1/tasks { owner, task, policy_hash }`: Scout runs one named task for that owner's wallet;
 * - `GET /indexer/v1/...`: the indexer's read routes, passed through.
 *
 * Under `/x402/` it serves the sellers. They are ordinary x402 resources: they answer 402, are paid by whoever
 * asks, and check the paying agent against their own requirement before they sell.
 *
 * Since anyone may name any owner, anyone can make Scout run a task for someone else's wallet. That spends only
 * what that wallet's owner allowed Scout to spend, on what the owner allowed, and it is test money; it is the price
 * of a demo with no sign-up. Everything that costs this server something is rate limited.
 */

export interface Limits {
  /** Whole units the faucet sends at a time, and the wallet balance at which it stops. */
  faucetAmount: string;
  faucetCeiling: string;
  /** Faucet payments one client address may ask for in an hour, and all clients together in a day. */
  faucetPerClientPerHour: number;
  faucetPerDay: number;
  /** Tasks one client address may start in a minute, and tasks running at the same moment. */
  tasksPerClientPerMinute: number;
  tasksAtOnce: number;
  /** Requests to the sellers one client address may make in a minute. */
  marketPerClientPerMinute: number;
  /** Every other request, per client address and minute. */
  requestsPerClientPerMinute: number;
  /** Agent set-up requests (metadata, verification, linking) one client address may make in an hour. */
  agentSetupPerClientPerHour: number;
  /** Verifications this server publishes in a day, for everyone together. */
  verificationsPerDay: number;
}

export const DEFAULT_LIMITS: Limits = {
  faucetAmount: '100', faucetCeiling: '200', faucetPerClientPerHour: 6, faucetPerDay: 400,
  tasksPerClientPerMinute: 12, tasksAtOnce: 6, marketPerClientPerMinute: 60, requestsPerClientPerMinute: 600,
  agentSetupPerClientPerHour: 30, verificationsPerDay: 500,
};

class Rejected extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface BackendOptions {
  deployment: Deployment;
  /** Where state goes: the indexer's database and the facilitator's journal. */
  directory: string;
  /** The built web app, served at `/` when present. */
  webRoot?: string;
  /** The agent tool as one file, handed to an agent that is setting itself up. */
  agentTool?: string;
  /** Origins a browser may call from, besides this server's own: the Vite dev server. */
  allowedOrigins?: readonly string[];
  /**
   * The address visitors use, such as `https://scout.example`, when the server is reached through a proxy. Requests
   * for that host are then accepted, and the client's address is read from the proxy's headers.
   */
  publicUrl?: string;
  limits?: Partial<Limits>;
  env: Record<string, string | undefined>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.ico': 'image/x-icon',
  '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const MAX_BODY_BYTES = 4_096;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Counts events per key in a fixed window. Memory is bounded: a full table is cleared, which only loosens it. */
export function rateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const seen = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const at = now();
    const entry = seen.get(key);
    if (!entry || at - entry.start >= windowMs) {
      if (seen.size >= 50_000) seen.clear();
      seen.set(key, { start: at, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

export async function createBackend(options: BackendOptions) {
  const { deployment } = options;
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const server = new rpc.Server(deployment.rpc_url, { allowHttp: deployment.network === 'local', timeout: 30_000 });
  const context: NetworkContext = await networkContext(server, deployment.passphrase);
  const keyDirectory = deployment.key_directory ?? options.env['STELLAR_AGENT_AUTH_KEY_DIR'];
  const keyEnv = {
    ...options.env, STELLAR_NETWORK: deployment.network, STELLAR_RPC_URL: deployment.rpc_url,
    STELLAR_NETWORK_PASSPHRASE: undefined, STELLAR_NETWORK_ID: undefined,
    ...(keyDirectory ? { STELLAR_AGENT_AUTH_KEY_DIR: keyDirectory } : {}),
  };
  // Key references, not keys: a name in the key directory, or `env:NAME` where secrets are given as environment.
  const reference = (role: string) => options.env[`DEMO_${role.toUpperCase()}_KEY`] || role;
  const agentKey: Signer = await loadKey(reference('agent'), keyEnv);
  const funder: Signer = await loadKey(reference('funder'), keyEnv);
  const facilitatorKey = await loadKeypair(reference('facilitator'), keyEnv);
  if (agentKey.address !== deployment.agent.signer || funder.address !== deployment.roles.funder
    || facilitatorKey.publicKey() !== deployment.roles.facilitator) {
    throw new Error('The agent, funder or facilitator key is not the one this deployment names');
  }
  const journal = new MemoryJournal();
  // The provider's key is optional: with it this server can verify agents that people bring, and keep its own
  // agent's verification current. It is used when named, or when the setup left it beside the other keys.
  const providerReference = options.env['DEMO_PROVIDER_KEY'] || (deployment.key_directory ? 'provider' : undefined);
  const providerKey = providerReference ? await loadKeypair(providerReference, keyEnv).catch((error: unknown) => {
    if (options.env['DEMO_PROVIDER_KEY']) throw error;
    return undefined;
  }) : undefined;
  if (providerKey && providerKey.publicKey() !== deployment.provider.address) {
    throw new Error('The provider key is not the one this deployment names');
  }

  // The sellers. The published x402 code knows Testnet and mainnet only, and refuses a payer that publishes its own
  // events. On those networks it is used with that one allowance; on a local network this project's facilitator
  // does the same job.
  const network = x402Network(deployment.passphrase);
  const facilitator = deployment.network === 'local'
    ? new StellarExactFacilitator({
      context, signer: keypairSigner(facilitatorKey),
      journal: new FileJournal(join(options.directory, 'x402-facilitator', 'journal')),
    })
    : tolerantUpstreamFacilitator(facilitatorKey.secret(), network, { rpcUrl: deployment.rpc_url, maxTransactionFeeStroops: 2_000_000 });
  const terms: PayeeTerms = {
    server, networkPassphrase: deployment.passphrase, walletCode: [deployment.wallet_wasm_hash],
    agentRegistry: deployment.agent_registry, verificationRegistry: deployment.verification_registry,
    provider: deployment.provider.address,
    requirement: { required_checks: [], max_age: 30n * 86_400n, max_risk_score: 10 },
  };
  const networkName = deployment.network === 'testnet' ? 'Stellar Testnet' : 'local Stellar';
  // The sellers' view of recent ledgers: a few numbers per ledger, gathered as ledgers close.
  const watch = new LedgerWatch();
  void backfill(server, watch).catch((error: unknown) => console.error('demo: could not read recent ledgers:', error));
  const watching = setInterval(() => { void observe(server, watch).catch(() => undefined); }, 5_000);
  watching.unref();
  const market = await createPaidService(network, inProcessFacilitator(network, facilitator), PRODUCTS.map((product) => {
    const vendor = vendorOf(product.vendor);
    return {
      path: product.path, description: `${product.title}, from ${vendor.name}`,
      price: { asset: deployment.asset.contract, amount: toContractUnits(product.price, deployment.asset.decimals).toString() },
      payTo: deployment.vendors[product.vendor],
      gate: payeeGate({ ...terms, requirement: { ...terms.requirement, required_checks: [...vendor.requires] } }),
      handler: () => produce(product, server, networkName, watch),
    };
  }));

  // One indexer for every wallet that runs this deployment's wallet code.
  const indexerToken = randomBytes(32).toString('hex');
  const indexer = await startIndexer({
    ...keyEnv, WALLET_ID: undefined, INDEXER_WALLETS: undefined, INDEXER_WALLET_CODE: deployment.wallet_wasm_hash,
    AGENT_REGISTRY_ID: deployment.agent_registry, VERIFICATION_REGISTRY_ID: deployment.verification_registry,
    INDEXER_CONTRACTS: undefined, INDEXER_START_LEDGER: String(deployment.start_ledger),
    INDEXER_DATABASE_PATH: join(options.directory, 'history.sqlite'), INDEXER_HOST: '127.0.0.1', INDEXER_PORT: '0',
    INDEXER_POLL_SECONDS: options.env['DEMO_INDEXER_POLL_SECONDS'] || '5', INDEXER_TOKEN_FILE: undefined,
    DEPLOYMENT_EPOCH: deployment.epoch,
  }, { token: indexerToken });

  const publicOrigin = options.publicUrl ? new URL(options.publicUrl).origin : undefined;
  const verificationsToday = rateLimiter(limits.verificationsPerDay, 86_400_000);
  const agentService = createAgentService({
    deployment, server, context, directory: options.directory, journal, allowPublish: () => verificationsToday('all'),
    ...(publicOrigin ? { publicOrigin } : {}), ...(providerKey ? { provider: providerKey } : {}),
  });
  // The built-in agent's verification is time-limited like anyone's; renew it before it runs out.
  const renewOwn = () => {
    if (!providerKey) return;
    void agentService.verify(deployment.agent.agent_id).catch((error: unknown) => console.error('demo: could not renew the agent\'s verification:', error));
  };
  renewOwn();
  const renewing = setInterval(renewOwn, 3_600_000);
  renewing.unref();

  let marketUrl: string | undefined;
  const agent = new ScoutAgent(deployment, context, server, agentKey, () => {
    if (!marketUrl) throw new Error('The demo server has not been told its own address');
    return marketUrl;
  });

  const salt = hexToBytes(deployment.wallet_salt);
  const walletOf = (owner: string) => deployedAddress(deployment.passphrase, owner, salt);
  const read = (wallet: string) => ({
    server, contractId: wallet, source: agentKey.address, networkPassphrase: deployment.passphrase,
  });

  /** Owners whose wallet is known to exist and to be bound to this deployment. A wallet cannot stop being either. */
  const confirmed = new Map<string, string>();

  /** True once the owner's wallet exists and is bound to this deployment's registries. */
  async function deployed(owner: string, wallet: string) {
    if (confirmed.get(owner) === wallet) return true;
    let actualOwner: string;
    try {
      actualOwner = await readWalletOwner(read(wallet));
    } catch {
      return false;
    }
    const registries = await readWalletRegistries(read(wallet));
    if (actualOwner !== owner || registries.agent_registry !== deployment.agent_registry
      || registries.verification_registry !== deployment.verification_registry) {
      throw new Rejected(409, 'The contract at the wallet address is not this owner\'s wallet for this deployment');
    }
    if (confirmed.size >= 20_000) confirmed.clear();
    confirmed.set(owner, wallet);
    return true;
  }

  async function walletFor(owner: unknown): Promise<string> {
    if (typeof owner !== 'string' || !StrKey.isValidEd25519PublicKey(owner)) {
      throw new Rejected(400, 'Expected { owner } with a G... account address');
    }
    const wallet = walletOf(owner);
    if (!(await deployed(owner, wallet))) throw new Rejected(409, 'This owner has no wallet yet; create it first');
    return wallet;
  }

  // The funder is one account: its payments are made one at a time.
  let faucetQueue: Promise<unknown> = Promise.resolve();
  const faucetToday = rateLimiter(limits.faucetPerDay, 86_400_000);
  const fund = (wallet: string) => {
    const work = async () => {
      const balance = await readWalletBalance(read(wallet), deployment.asset.contract);
      if (balance >= toContractUnits(limits.faucetCeiling, deployment.asset.decimals)) {
        throw new Rejected(409, `The wallet already holds ${fromContractUnits(balance, deployment.asset.decimals)} ${deployment.asset.code}`);
      }
      if (!faucetToday('all')) throw new Rejected(429, 'The faucet has given out all it gives in a day; try again tomorrow');
      const args = {
        from: funder.address, asset: deployment.asset.contract,
        amount: toContractUnits(limits.faucetAmount, deployment.asset.decimals),
      };
      const outcome = await invoke(context, funder, fundInvocation(context, wallet, args, funder), journal,
        { limits: pipelineLimits({ maxFee: 10_000_000n }) });
      await indexer.cycle().catch(() => undefined);
      return { status: outcome.status, tx_hash: outcome.hash, amount: limits.faucetAmount, asset: deployment.asset.code };
    };
    const next = faucetQueue.then(work, work);
    faucetQueue = next.catch(() => undefined);
    return next;
  };

  /** Wallets Scout is working for right now. One task per wallet at a time: its payments are ordered. */
  const working = new Set<string>();

  async function runTask(wallet: string, body: Record<string, unknown>) {
    const task = body['task'];
    const policy = body['policy_hash'];
    if (typeof task !== 'string' || typeof policy !== 'string' || !/^[0-9a-f]{64}$/.test(policy)) {
      throw new Rejected(400, 'Expected { owner, task, policy_hash } with a 64-character hex policy hash');
    }
    if (!TASKS.some(({ id }) => id === task)) throw new Rejected(400, `Unknown task ${task}`);
    if (working.has(wallet)) throw new Rejected(409, 'Scout is still on an earlier task for this wallet');
    if (working.size >= limits.tasksAtOnce) throw new Rejected(503, 'Scout is busy with other visitors; try again in a moment');
    working.add(wallet);
    try {
      const report: Parameters<ScoutAgent['run']>[3] = async (attempt) => {
        // An attempt is a note for the activity list. Failing to record one must not turn a refusal into an error.
        await fetch(new URL(`v1/wallets/${wallet}/attempts`, indexer.url), {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${indexerToken}` },
          body: JSON.stringify({ ...attempt, tx_hash: null }),
        }).then((response) => {
          if (!response.ok) console.error(`demo: the indexer answered ${response.status} to an attempt`);
        }, (error: unknown) => console.error('demo: could not record an attempt:', error));
      };
      const result = await agent.run(task, wallet, hexToBytes(policy), report);
      // Bring the history up to date before answering, so the page that asked sees what just happened.
      await indexer.cycle().catch(() => undefined);
      return result;
    } catch (error) {
      if (error instanceof UnknownTask) throw new Rejected(400, error.message);
      throw error;
    } finally {
      working.delete(wallet);
    }
  }

  const config = () => ({
    network: deployment.network, rpc_url: deployment.rpc_url, passphrase: deployment.passphrase,
    agent_registry: deployment.agent_registry, verification_registry: deployment.verification_registry,
    asset: deployment.asset, wallet_wasm_hash: deployment.wallet_wasm_hash, wallet_salt: deployment.wallet_salt,
    agent: deployment.agent, provider: deployment.provider,
    vendors: VENDORS.map((vendor) => ({ ...vendor, address: deployment.vendors[vendor.id] })),
    // The path is where the product is sold over x402, for a buyer that is not this page.
    products: PRODUCTS.map(({ id, vendor, kind, title, price, path }) => ({ id, vendor, kind, title, price, path })),
    tasks: TASKS, faucet_amount: limits.faucetAmount, indexer_path: '/indexer/',
    // Whether someone can bring an agent of their own here, and whether this server can verify it.
    own_agents: agentService.capabilities(), public_url: publicOrigin ?? null,
    // Reads are simulations and need the name of an account that exists; this one always does.
    read_source: deployment.roles.facilitator,
    explorer: deployment.network === 'testnet' ? 'https://stellar.expert/explorer/testnet' : null,
  });

  // ---- HTTP ----

  const publicUrl = options.publicUrl ? new URL(options.publicUrl) : undefined;
  const rpcOrigin = new URL(deployment.rpc_url).origin;
  const SECURITY_HEADERS = {
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    ...(publicUrl?.protocol === 'https:' ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
  // The page runs only its own scripts. It talks to this server, to the network's RPC and Friendbot, and to
  // whatever a browser wallet needs; wallets that sign in a window of their own are framed or opened by address.
  const CONTENT_POLICY = [
    'default-src \'self\'', 'script-src \'self\'', 'style-src \'self\' \'unsafe-inline\'', 'img-src \'self\' data: https:',
    'font-src \'self\' data:', `connect-src 'self' ${rpcOrigin} https: wss:`, 'frame-src https:', 'object-src \'none\'',
    'base-uri \'self\'', 'form-action \'self\'', 'frame-ancestors \'none\'',
  ].join('; ');

  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS });
    response.end(JSON.stringify(body));
  };

  async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    // A JSON content type is not something a cross-site form can send, so another page cannot drive the agent.
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
      throw new Rejected(415, 'Send application/json');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new Rejected(413, 'Body too large');
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw new Rejected(400, 'Body must be JSON');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Rejected(400, 'Expected an object');
    return body as Record<string, unknown>;
  }

  const header = (request: IncomingMessage, name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  /**
   * Who is asking, for rate limits. Behind a proxy that is what the proxy says; the proxy's own address would make
   * every visitor one client. Proxy headers are believed only when a public address is configured.
   */
  function clientOf(request: IncomingMessage): string {
    const socket = request.socket.remoteAddress ?? 'unknown';
    if (!publicUrl) return socket;
    return header(request, 'fly-client-ip') ?? header(request, 'x-forwarded-for')?.split(',')[0]?.trim() ?? socket;
  }

  /** The server's own calls to its sellers arrive from loopback with no proxy header; they are Scout's, not a visitor's. */
  const internal = (request: IncomingMessage) => LOOPBACK.has(request.socket.remoteAddress ?? '')
    && header(request, 'fly-client-ip') === undefined && header(request, 'x-forwarded-for') === undefined;

  function checkOrigin(request: IncomingMessage) {
    // The server is reached by a loopback name or by its public name. A page that points its own domain at this
    // server arrives with that domain as the host, and is refused here.
    const host = header(request, 'host') ?? '';
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
    if (!loopback && host !== publicUrl?.host) throw new Rejected(403, 'Host not allowed');
    const origin = header(request, 'origin');
    if (origin === undefined) return;
    const own = loopback ? `http://${host}` : publicUrl!.origin;
    if (origin !== own && !(options.allowedOrigins ?? []).includes(origin)) throw new Rejected(403, 'Origin not allowed');
  }

  async function serveStatic(pathname: string, response: ServerResponse) {
    if (!options.webRoot) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    const relative = normalize(decoded).replace(/^[/\\]+/, '') || 'index.html';
    const file = join(options.webRoot, relative);
    if (file !== options.webRoot && !file.startsWith(options.webRoot + sep)) return false;
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return false;
    const html = extname(file) === '.html';
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      // Built assets carry a hash of their content in their name; the page itself is always fetched fresh.
      'cache-control': relative.startsWith(`assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-store',
      ...SECURITY_HEADERS, ...(html ? { 'content-security-policy': CONTENT_POLICY } : {}),
    });
    createReadStream(file).pipe(response);
    return true;
  }

  /** The indexer's read routes, passed through. It has no keys and no authority; the page checks what it returns. */
  async function passToIndexer(url: URL, response: ServerResponse) {
    const path = url.pathname.slice('/indexer'.length);
    if (path !== '/v1/health' && !/^\/v1\/wallets\/[A-Z0-9]{56}\/(history|attempts)$/.test(path)) return false;
    const answer = await fetch(new URL(`${path.slice(1)}${url.search}`, indexer.url));
    response.writeHead(answer.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS });
    response.end(await answer.text());
    return true;
  }

  const allow = {
    any: rateLimiter(limits.requestsPerClientPerMinute, 60_000),
    market: rateLimiter(limits.marketPerClientPerMinute, 60_000),
    tasks: rateLimiter(limits.tasksPerClientPerMinute, 60_000),
    faucet: rateLimiter(limits.faucetPerClientPerHour, 3_600_000),
    agents: rateLimiter(limits.agentSetupPerClientPerHour, 3_600_000),
  };

  const limited = (bucket: keyof typeof allow, client: string) => {
    if (!allow[bucket](client)) throw new Rejected(429, 'Too many requests; wait a little and try again');
  };

  async function handler(request: IncomingMessage, response: ServerResponse) {
    try {
      const url = new URL(request.url ?? '/', 'http://demo.invalid');
      const client = clientOf(request);
      // For the host's health check, which does not come by the public name.
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return json(response, 200, { status: indexer.state.ingestionError ? 'degraded' : 'ok' });
      }
      // The sellers take no owner and no origin check: whoever pays, through x402, is served.
      if (url.pathname.startsWith('/x402/')) {
        if (!internal(request)) limited('market', client);
        if (await market.handle(request, response)) return undefined;
        return json(response, 404, { error: 'Not found' });
      }
      limited('any', client);
      // An agent's metadata document, at the address its identity names. It is public by nature: the verifier and
      // anyone checking the agent fetch it by this address.
      if (request.method === 'GET' && url.pathname === '/agent-ready.md') {
        // Written for an AI agent to read. The commands in it name this server as its visitors reach it.
        const asked = url.searchParams.get('owner') ?? undefined;
        const host = header(request, 'host') ?? '';
        const origin = publicOrigin ?? (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host) ? `http://${host}` : undefined);
        if (!origin) throw new Rejected(403, 'Host not allowed');
        response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return response.end(agentReady({
          origin, owner: asked && StrKey.isValidEd25519PublicKey(asked) ? asked : undefined, network: networkName,
          verifies: agentService.capabilities().verify, npmPackage: options.env['DEMO_AGENT_NPM_PACKAGE'] || undefined,
        }));
      }
      if (request.method === 'GET' && url.pathname === '/agent/stellar-agent-wallet.mjs') {
        const info = options.agentTool ? await stat(options.agentTool).catch(() => undefined) : undefined;
        if (!info?.isFile()) return json(response, 404, { error: 'Not found' });
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return createReadStream(options.agentTool!).pipe(response);
      }
      const metadataRoute = /^\/agents\/(G[A-Z2-7]{55})\.json$/.exec(url.pathname);
      if (request.method === 'GET' && metadataRoute) {
        const bytes = await agentService.document(metadataRoute[1]!);
        if (!bytes) return json(response, 404, { error: 'Not found' });
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return response.end(bytes);
      }
      if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/indexer/')) {
        checkOrigin(request);
        if (request.method === 'GET' && url.pathname.startsWith('/indexer/') && await passToIndexer(url, response)) return undefined;
        if (request.method === 'GET' && url.pathname === '/v1/config') return json(response, 200, config());
        if (request.method === 'POST' && url.pathname === '/v1/session') {
          const { owner } = await readBody(request);
          if (typeof owner !== 'string' || !StrKey.isValidEd25519PublicKey(owner)) {
            throw new Rejected(400, 'Expected { owner } with a G... account address');
          }
          const wallet = walletOf(owner);
          return json(response, 200, { wallet, deployed: await deployed(owner, wallet) });
        }
        if (request.method === 'GET' && url.pathname === '/v1/agents') {
          const owner = url.searchParams.get('owner') ?? '';
          if (!StrKey.isValidEd25519PublicKey(owner)) throw new Rejected(400, 'Expected ?owner= with a G... account address');
          return json(response, 200, { agents: await agentService.linked(owner) });
        }
        if (request.method === 'POST' && url.pathname.startsWith('/v1/agents/')) {
          const body = await readBody(request);
          limited('agents', client);
          if (url.pathname === '/v1/agents/metadata') return json(response, 200, await agentService.metadata(body));
          if (url.pathname === '/v1/agents/link') return json(response, 200, await agentService.link(body));
          if (url.pathname === '/v1/agents/verify') return json(response, 200, await agentService.verify(body['agent_id']));
          return json(response, 404, { error: 'Not found' });
        }
        if (request.method === 'POST' && url.pathname === '/v1/fund') {
          const body = await readBody(request);
          const wallet = await walletFor(body['owner']);
          limited('faucet', client);
          return json(response, 200, await fund(wallet));
        }
        if (request.method === 'POST' && url.pathname === '/v1/tasks') {
          const body = await readBody(request);
          const wallet = await walletFor(body['owner']);
          limited('tasks', client);
          return json(response, 200, await runTask(wallet, body));
        }
        return json(response, 404, { error: 'Not found' });
      }
      if (request.method === 'GET' && await serveStatic(url.pathname, response)) return undefined;
      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof Rejected || error instanceof AgentServiceError) return json(response, error.status, { error: error.message });
      console.error('demo:', error);
      // What went wrong inside is for the log, not for whoever asked.
      return json(response, 500, { error: publicUrl ? 'Something went wrong on the demo server' : error instanceof Error ? error.message : 'Internal error' });
    }
  }

  return {
    handler, walletOf, indexer,
    async stop() {
      clearInterval(watching);
      clearInterval(renewing);
      await indexer.stop();
    },
    /** Tell the server where it is reachable, once it listens; Scout buys from the sellers at this address. */
    listening(url: string) {
      marketUrl = url;
    },
  };
}
