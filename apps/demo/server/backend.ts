import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { StrKey, rpc } from '@stellar/stellar-sdk';
import { startIndexer, type RunningIndexer } from '@stellar-agent-auth/indexer';
import {
  MemoryJournal, deployedAddress, fromContractUnits, fundInvocation, httpSponsor, invoke, networkContext,
  pipelineLimits, readWalletBalance, readWalletOwner, readWalletRegistries, toContractUnits,
  type NetworkContext, type Signer,
} from '@stellar-agent-auth/sdk';
import { loadKey } from '@stellar-agent-auth/sdk/node';
import { startSubmitter } from '@stellar-agent-auth/submitter';
import { DemoAgent, SCENARIOS, UnknownScenario } from './agent.js';
import { hexToBytes, type Deployment } from './deployment.js';

/**
 * The demo's server side. It plays the parts the owner does not: the agent, the fee sponsor, the funder that hands
 * out the test asset, and the indexer. Each has its own key. The owner's key never comes here; the owner signs in
 * the browser.
 *
 * What a browser can ask of it is deliberately small:
 * - `GET /v1/config`: the deployment's public addresses and the scenarios the agent can run;
 * - `POST /v1/session { owner }`: which wallet belongs to this owner, and start following it once it exists;
 * - `POST /v1/fund`: the funder sends a fixed amount of the test asset to the session's wallet;
 * - `POST /v1/payments { scenario, policy_hash }`: the agent runs one named scenario.
 *
 * The wallet address is derived here from the owner's address and the deployment's salt, and it is checked on the
 * network before anything is started for it. It listens on loopback only.
 */

const FAUCET_AMOUNT = '100';
const FAUCET_CEILING = '1000';
const MAX_BODY_BYTES = 4_096;

interface Session {
  owner: string;
  wallet: string;
  indexer: RunningIndexer;
  submitter: { server: Server; url: string };
  agent: DemoAgent;
}

class Rejected extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface BackendOptions {
  deployment: Deployment;
  /** Where per-wallet state goes: the indexer's database and the sponsor's journal. */
  directory: string;
  /** The built web app, served at `/` when present. */
  webRoot?: string;
  /** Origins a browser may call from, besides this server's own: the Vite dev server. */
  allowedOrigins?: readonly string[];
  env: Record<string, string | undefined>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.ico': 'image/x-icon',
};

export async function createBackend(options: BackendOptions) {
  const { deployment } = options;
  const server = new rpc.Server(deployment.rpc_url, { allowHttp: deployment.network === 'local', timeout: 30_000 });
  const context: NetworkContext = await networkContext(server, deployment.passphrase);
  const keyEnv = {
    ...options.env, STELLAR_NETWORK: deployment.network, STELLAR_RPC_URL: deployment.rpc_url,
    STELLAR_NETWORK_PASSPHRASE: undefined, STELLAR_NETWORK_ID: undefined,
    STELLAR_AGENT_AUTH_KEY_DIR: deployment.key_directory,
  };
  const agentKey: Signer = await loadKey('agent', keyEnv);
  const funder: Signer = await loadKey('funder', keyEnv);
  if (agentKey.address !== deployment.agent.signer || funder.address !== deployment.roles.funder) {
    throw new Error('The keys in the key directory are not the ones this deployment names');
  }
  const journal = new MemoryJournal();
  const salt = hexToBytes(deployment.wallet_salt);
  let session: Session | undefined;
  /** Sessions and faucet payments are handled one at a time. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const walletOf = (owner: string) => deployedAddress(deployment.passphrase, owner, salt);
  const read = (wallet: string) => ({
    server, contractId: wallet, source: agentKey.address, networkPassphrase: deployment.passphrase,
  });

  /** True once the owner's wallet exists and is bound to this deployment's registries. */
  async function deployed(owner: string, wallet: string) {
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
    return true;
  }

  async function stopSession() {
    const current = session;
    session = undefined;
    if (!current) return;
    await current.indexer.stop();
    await new Promise<void>((resolve) => current.submitter.server.close(() => resolve()));
  }

  async function startSession(owner: string, wallet: string): Promise<Session> {
    const state = join(options.directory, wallet);
    const submitter = await startSubmitter({
      ...keyEnv, SUBMITTER_SPONSOR_KEY: 'sponsor',
      SUBMITTER_CONTRACTS: [wallet, deployment.asset.contract, deployment.service.contract].join(','),
      SUBMITTER_METHODS: 'execute,transfer,pay_for_service', SUBMITTER_HOST: '127.0.0.1', SUBMITTER_PORT: '0',
      SUBMITTER_STATE_DIR: join(state, 'submitter'), SUBMITTER_TOKEN_FILE: undefined,
    });
    let indexer: RunningIndexer;
    try {
      if (submitter.sponsor !== deployment.roles.sponsor) throw new Error('The sponsor key is not the deployment\'s sponsor');
      indexer = await startIndexer({
        ...keyEnv, WALLET_ID: wallet, INDEXER_WALLETS: undefined, AGENT_REGISTRY_ID: deployment.agent_registry,
        VERIFICATION_REGISTRY_ID: deployment.verification_registry, INDEXER_CONTRACTS: deployment.service.contract,
        INDEXER_START_LEDGER: String(deployment.start_ledger), INDEXER_DATABASE_PATH: join(state, 'history.sqlite'),
        INDEXER_HOST: '127.0.0.1', INDEXER_PORT: '0', INDEXER_POLL_SECONDS: '2', INDEXER_TOKEN_FILE: undefined,
        DEPLOYMENT_EPOCH: `${deployment.epoch}-${wallet.slice(0, 8)}`,
      });
    } catch (error) {
      // Do not leave a sponsor listening for a session that never started.
      await new Promise<void>((resolve) => submitter.server.close(() => resolve()));
      throw error;
    }
    const report = async (attempt: Record<string, unknown>) => {
      // An attempt is a note for the history view. Failing to record one must not turn a refusal into an error.
      await fetch(new URL(`v1/wallets/${wallet}/attempts`, indexer.url), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(attempt),
      }).catch((error: unknown) => console.error('demo: could not record an attempt:', error));
    };
    const agent = new DemoAgent(deployment, context, server, agentKey,
      httpSponsor(submitter.url, submitter.sponsor), journal, report);
    return { owner, wallet, indexer, submitter, agent };
  }

  /** The session for `owner`, started if its wallet exists. A different owner replaces the previous session. */
  const openSession = (owner: string) => serial(async () => {
    const wallet = walletOf(owner);
    if (session?.owner === owner) return { wallet, deployed: true, indexer_url: session.indexer.url };
    if (!(await deployed(owner, wallet))) return { wallet, deployed: false, indexer_url: null };
    await stopSession();
    session = await startSession(owner, wallet);
    return { wallet, deployed: true, indexer_url: session.indexer.url };
  });

  function current(): Session {
    if (!session) throw new Rejected(409, 'No wallet is being followed yet; connect an owner and create the wallet first');
    return session;
  }

  const fund = () => serial(async () => {
    const { wallet, indexer } = current();
    const balance = await readWalletBalance(read(wallet), deployment.asset.contract);
    if (balance >= toContractUnits(FAUCET_CEILING, deployment.asset.decimals)) {
      throw new Rejected(409, `The wallet already holds ${fromContractUnits(balance, deployment.asset.decimals)} ${deployment.asset.code}`);
    }
    const args = {
      from: funder.address, asset: deployment.asset.contract, amount: toContractUnits(FAUCET_AMOUNT, deployment.asset.decimals),
    };
    const outcome = await invoke(context, funder, fundInvocation(context, wallet, args, funder), journal,
      { limits: pipelineLimits({ maxFee: 10_000_000n }) });
    await indexer.cycle().catch(() => undefined);
    return { status: outcome.status, tx_hash: outcome.hash, amount: FAUCET_AMOUNT, asset: deployment.asset.code };
  });

  async function pay(body: Record<string, unknown>) {
    const { wallet, agent, indexer } = current();
    const scenario = body['scenario'];
    const policy = body['policy_hash'];
    if (typeof scenario !== 'string' || typeof policy !== 'string' || !/^[0-9a-f]{64}$/.test(policy)) {
      throw new Rejected(400, 'Expected { scenario, policy_hash } with a 64-character hex policy hash');
    }
    try {
      const result = await agent.run(scenario, wallet, hexToBytes(policy));
      // Bring the history up to date before answering, so the page that asked sees what just happened.
      await indexer.cycle().catch(() => undefined);
      return result;
    } catch (error) {
      if (error instanceof UnknownScenario) throw new Rejected(400, error.message);
      throw error;
    }
  }

  const config = () => ({
    network: deployment.network, rpc_url: deployment.rpc_url, passphrase: deployment.passphrase,
    agent_registry: deployment.agent_registry, verification_registry: deployment.verification_registry,
    asset: deployment.asset, wallet_wasm_hash: deployment.wallet_wasm_hash, wallet_salt: deployment.wallet_salt,
    agent: deployment.agent, provider: deployment.provider, service: deployment.service,
    roles: { recipient: deployment.roles.recipient, stranger: deployment.roles.stranger, sponsor: deployment.roles.sponsor },
    scenarios: SCENARIOS, faucet_amount: FAUCET_AMOUNT,
    explorer: deployment.network === 'testnet' ? 'https://stellar.expert/explorer/testnet' : null,
  });

  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
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

  function checkOrigin(request: IncomingMessage) {
    // The server is reached by a loopback name only. A page that points its own domain at 127.0.0.1 arrives with
    // that domain as the host, and is refused here.
    const host = request.headers['host'] ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) throw new Rejected(403, 'Host not allowed');
    const origin = request.headers['origin'];
    if (origin === undefined) return;
    const own = `http://${host}`;
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
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
    return true;
  }

  async function handler(request: IncomingMessage, response: ServerResponse) {
    try {
      const url = new URL(request.url ?? '/', 'http://demo.invalid');
      if (url.pathname.startsWith('/v1/')) {
        checkOrigin(request);
        if (request.method === 'GET' && url.pathname === '/v1/config') return json(response, 200, config());
        if (request.method === 'POST' && url.pathname === '/v1/session') {
          const { owner } = await readBody(request);
          if (typeof owner !== 'string' || !StrKey.isValidEd25519PublicKey(owner)) {
            throw new Rejected(400, 'Expected { owner } with a G... account address');
          }
          return json(response, 200, await openSession(owner));
        }
        if (request.method === 'POST' && url.pathname === '/v1/fund') {
          await readBody(request);
          return json(response, 200, await fund());
        }
        if (request.method === 'POST' && url.pathname === '/v1/payments') {
          return json(response, 200, await pay(await readBody(request)));
        }
        return json(response, 404, { error: 'Not found' });
      }
      if (request.method === 'GET' && await serveStatic(url.pathname, response)) return undefined;
      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof Rejected) return json(response, error.status, { error: error.message });
      console.error('demo:', error);
      return json(response, 500, { error: error instanceof Error ? error.message : 'Internal error' });
    }
  }

  return { handler, stop: () => serial(stopSession), walletOf };
}
