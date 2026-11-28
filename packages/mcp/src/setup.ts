import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StrKey, rpc } from '@stellar/stellar-sdk';
import {
  MemoryJournal, decodeIdentity, deployedAddress, invoke, keypairSigner, networkContext, pipelineLimits, readAgent,
  registryInvocation, registryOperation,
  type Signer,
} from '@stellar-agent-auth/sdk';
import { createNamedKey, loadKeypair } from '@stellar-agent-auth/sdk/node';

/**
 * Setting an agent up, from nothing: its keys, its identity in the agent registry, its verification, and a note to
 * the owner that it would like an allowance. Everything is done from the agent's own machine with the agent's own
 * keys; the owner's key is never involved, and nothing here can spend. Spending starts when the owner approves an
 * allowance for this agent, in their own wallet.
 *
 * What it leaves behind is a small directory: two key files and a settings file. The MCP server reads it, so an
 * agent host needs no settings of its own.
 */

/** What a market says about itself: its `GET /v1/config`, as far as an agent needs it. */
export interface Market {
  rpc_url: string;
  passphrase: string;
  network: string;
  wallet_salt: string;
  agent_registry?: string;
  own_agents?: { setup?: boolean; verify?: boolean };
  asset?: { code?: string };
  vendors?: { id: string; name: string }[];
  products?: { vendor: string; title: string; price: string; path?: string }[];
}

export const marketBase = (address: string) => new URL(address.endsWith('/') ? address : `${address}/`);

export async function readMarket(base: URL, fetcher: typeof fetch = fetch): Promise<Market> {
  const response = await fetcher(new URL('v1/config', base));
  if (!response.ok) throw new Error(`The market at ${base.origin} answered ${response.status}`);
  const market = await response.json() as Market;
  if (typeof market.rpc_url !== 'string' || typeof market.passphrase !== 'string' || !/^[0-9a-f]{64}$/.test(market.wallet_salt ?? '')) {
    throw new Error(`The market at ${base.origin} did not describe its deployment`);
  }
  return market;
}

/** What `init` writes and the MCP server reads. Nothing in it is secret. */
export interface AgentSettings {
  version: 1;
  market: string;
  owner: string;
  agent_id: string;
  signer: string;
  passphrase: string;
  agent_registry: string;
}

/** Where an agent's keys and settings are kept: `STELLAR_AGENT_WALLET_HOME`, or `.stellar-agent-wallet` in the home directory. */
export const agentHome = (env: Record<string, string | undefined>, chosen?: string) =>
  resolve(chosen ?? env['STELLAR_AGENT_WALLET_HOME'] ?? join(homedir(), '.stellar-agent-wallet'));

const settingsPath = (home: string) => join(home, 'agent.json');
export const keyReference = (home: string, name: 'agent' | 'controller') => `file:${join(home, 'keys', `${name}.key`)}`;

export async function readSettings(home: string): Promise<AgentSettings | undefined> {
  try {
    const stored = JSON.parse(await readFile(settingsPath(home), 'utf8')) as AgentSettings;
    return stored.version === 1 && typeof stored.market === 'string' && typeof stored.owner === 'string' ? stored : undefined;
  } catch {
    return undefined;
  }
}

async function ensureKey(home: string, name: 'agent' | 'controller'): Promise<Signer> {
  const env = { STELLAR_AGENT_AUTH_KEY_DIR: join(home, 'keys') };
  const exists = await stat(join(home, 'keys', `${name}.key`)).then(() => true, () => false);
  if (!exists) await createNamedKey(name, env);
  return keypairSigner(await loadKeypair(name, env));
}

/** Ask Friendbot to create `address`, trying again when it is busy. Only test networks have one. */
async function fund(server: rpc.Server, address: string) {
  if (await server.getAccount(address).then(() => true, () => false)) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await server.requestAirdrop(address);
      return;
    } catch (error) {
      if (attempt >= 5) throw new Error(`Friendbot did not fund ${address}: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((done) => setTimeout(done, 700 * attempt));
    }
  }
}

async function post<T>(base: URL, path: string, body: unknown, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(new URL(path, base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(answer.error ?? `${base.origin} answered ${response.status}`);
  return answer;
}

export interface InitOptions {
  market: string;
  owner: string;
  /** How the agent is named to the owner, such as `Claude on my laptop`. */
  name?: string;
  description?: string;
  home: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface InitResult {
  agent_id: string;
  signer: string;
  wallet: string;
  /** Whether this run registered the agent, or found it already registered. */
  registered: 'now' | 'earlier';
  /** The registration's transaction, when this run made it. */
  registration_transaction?: string;
  /** The verification the market published, or why there is none yet. */
  verification: { status: string; checks?: { kind: string; outcome: string }[]; expires_at?: string } | { error: string };
  /** Where the owner approves an allowance for this agent. */
  approve_at: string;
  home: string;
}

/**
 * Set this machine's agent up for `owner` at `market`. Safe to run again: keys are kept, an agent that is already
 * registered is not registered twice, and verification is only renewed when it is close to expiring.
 */
export async function initAgent(options: InitOptions): Promise<InitResult> {
  const fetcher = options.fetch ?? fetch;
  const log = options.log ?? (() => undefined);
  if (!StrKey.isValidEd25519PublicKey(options.owner)) throw new Error('--owner must be the G... address of the account that owns the wallet');
  const base = marketBase(options.market);
  const market = await readMarket(base, fetcher);
  if (!market.agent_registry || !market.own_agents?.setup) throw new Error(`${base.origin} does not set agents up`);
  const earlier = await readSettings(options.home);
  if (earlier && (earlier.market !== base.href || earlier.passphrase !== market.passphrase)) {
    throw new Error(`${options.home} already holds an agent for ${earlier.market}. Use --home <another directory> to keep `
      + 'a second agent beside it, or delete that directory if the first is no longer wanted: it holds that agent\'s keys.');
  }

  await mkdir(options.home, { recursive: true, mode: 0o700 });
  const agent = await ensureKey(options.home, 'agent');
  // The registry wants an identity managed by a key other than the one that pays: the controller can disable the
  // agent or change what it says about itself. It is kept beside the agent's key.
  const controller = await ensureKey(options.home, 'controller');
  const server = new rpc.Server(market.rpc_url, { allowHttp: market.network === 'local', timeout: 30_000 });
  const context = await networkContext(server, market.passphrase);
  log('Funding the agent\'s accounts with test XLM');
  await fund(server, agent.address);
  await fund(server, controller.address);

  const registry = { server, contractId: market.agent_registry, source: agent.address, networkPassphrase: market.passphrase };
  let agentId = earlier?.agent_registry === market.agent_registry ? earlier.agent_id : undefined;
  if (agentId && (await readAgent(registry, BigInt(agentId)).then((identity) => identity.signer, () => undefined)) !== agent.address) {
    // A fresh deployment at the same address: the old number means nothing there.
    agentId = undefined;
  }
  const registered = agentId ? 'earlier' : 'now';
  let registrationTransaction: string | undefined;
  if (!agentId) {
    log('Registering the agent in the agent registry');
    const document = await post<{ metadata_uri: string; metadata_hash: string }>(base, 'v1/agents/metadata', {
      signer: agent.address, name: options.name ?? 'My agent', ...(options.description ? { description: options.description } : {}),
    }, fetcher);
    const registration = {
      controller: controller.address, signer: agent.address, metadata_uri: document.metadata_uri,
      metadata_hash: Uint8Array.from(Buffer.from(document.metadata_hash, 'hex')),
    };
    const outcome = await invoke(context, controller, registryInvocation(context, market.agent_registry, 'register', registration,
      [controller, agent], registryOperation(market.agent_registry, 'register', registration)), new MemoryJournal(),
    { limits: pipelineLimits({ maxFee: 50_000_000n }) });
    if (outcome.status !== 'success') throw new Error(`The agent was not registered: ${outcome.status}${outcome.code ? ` (${outcome.code})` : ''}`);
    agentId = decodeIdentity(outcome.returnValue!).agent_id.toString();
    registrationTransaction = outcome.hash;
  }
  const settings: AgentSettings = {
    version: 1, market: base.href, owner: options.owner, agent_id: agentId, signer: agent.address,
    passphrase: market.passphrase, agent_registry: market.agent_registry,
  };
  await writeFile(settingsPath(options.home), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

  log('Asking for the agent to be verified');
  const verification = await post<{ status: string; result: { checks: { kind: string; outcome: string }[]; expires_at: string } }>(
    base, 'v1/agents/verify', { agent_id: agentId }, fetcher,
  ).then((answer) => ({ status: answer.status, checks: answer.result.checks, expires_at: answer.result.expires_at }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  await post(base, 'v1/agents/link', { owner: options.owner, agent_id: agentId }, fetcher);

  return {
    agent_id: agentId, signer: agent.address, registered, verification, home: options.home,
    ...(registrationTransaction ? { registration_transaction: registrationTransaction } : {}),
    wallet: deployedAddress(market.passphrase, options.owner, Uint8Array.from(Buffer.from(market.wallet_salt, 'hex'))),
    approve_at: new URL(`?agent=${agentId}`, base).href,
  };
}
