#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StrKey, rpc } from '@stellar/stellar-sdk';
import { deployedAddress, loadConfig, networkContext, type Hash32 } from '@stellar-agent-auth/sdk';
import { isMainModule, loadKey } from '@stellar-agent-auth/sdk/node';
import { z } from 'zod';
import { createWalletAgent, type AgentOptions, type Offer, type WalletAgent } from './agent.js';
import { agentHome, initAgent, keyReference, marketBase, readMarket, readSettings, type InitResult } from './setup.js';

export { createWalletAgent, type AgentOptions, type Offer, type WalletAgent } from './agent.js';
export { agentHome, initAgent, readSettings, type AgentSettings, type InitOptions, type InitResult } from './setup.js';

/**
 * An MCP server that makes an AI agent, such as Claude Code or Codex, the agent of a policy-limited wallet. The
 * model decides what to buy; the wallet decides whether it is paid for.
 *
 * It speaks MCP over standard input and output, so an agent's host starts it as a child process. It is given the
 * agent's key by reference and the wallet to pay from, and offers four tools: `allowance`, `sellers`, `price` and
 * `buy`. It never holds the owner's key, and it cannot widen what the owner allowed.
 */

const INSTRUCTIONS = [
  'You act as the agent of a smart wallet on Stellar that belongs to someone else, its owner.',
  'The owner has set an allowance: how much you may spend per purchase, per day and in total, which sellers you may pay, and until when.',
  'The wallet contract enforces that allowance. You cannot change it, and a purchase outside it is refused before any money moves.',
  'Call `allowance` to see what you may spend, `sellers` to see what is on offer, `price` to ask what something costs and whether the wallet would pay it, and `buy` to buy it.',
  'A refusal by the wallet or by a seller is a normal answer. Report it plainly, with its reason; do not retry it and do not look for a way around it.',
  'Spend only on what you were asked to get, and prefer the cheaper seller when two sell the same thing.',
].join(' ');

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

/** Wrap a tool so that a fault is reported to the model as a failed call, with its message, and nothing else leaks. */
const tool = <Args>(work: (args: Args) => Promise<unknown>) => async (args: Args) => {
  try {
    return text(await work(args));
  } catch (error) {
    return { ...text({ error: error instanceof Error ? error.message : String(error) }), isError: true };
  }
};

export function createMcpServer(agent: WalletAgent): McpServer {
  const server = new McpServer({ name: 'stellar-agent-wallet', version: '0.0.0' }, { instructions: INSTRUCTIONS });
  const url = { url: z.string().url().describe('The address of the thing to buy, as `sellers` lists it') };

  server.registerTool('allowance', {
    title: 'What you may spend',
    description: 'The allowance the wallet\'s owner has set for you: limits per purchase, per day and in total, what is already spent, '
      + 'which sellers you may pay, when it ends, whether the owner has frozen it, and what the wallet holds. Read-only.',
    annotations: { readOnlyHint: true },
  }, tool(() => agent.allowance()));

  server.registerTool('sellers', {
    title: 'What is on offer',
    description: 'The sellers this wallet\'s market knows, what each sells and at which address. Prices listed here are for '
      + 'information; `price` asks the seller itself. Read-only.',
    annotations: { readOnlyHint: true },
  }, tool(() => agent.offers()));

  server.registerTool('price', {
    title: 'Ask a price',
    description: 'Ask a seller what the thing at an address costs, and ask the wallet whether it would pay that under your '
      + 'allowance. Nothing is signed or paid. Use it to compare sellers before buying.',
    inputSchema: url, annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(({ url: target }: { url: string }) => agent.price(target)));

  server.registerTool('buy', {
    title: 'Buy',
    description: 'Buy the thing at an address, paying what the seller asks from the owner\'s wallet. The wallet pays only inside '
      + 'your allowance, and the seller may refuse you. The answer says which happened: `paid` with what was bought, '
      + '`blocked` by the wallet, `declined` by the seller, or `unsettled`. This spends the owner\'s money.',
    inputSchema: url, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, tool(({ url: target }: { url: string }) => agent.buy(target)));

  return server;
}

/**
 * Read the agent's settings. After `init` there is nothing to set: the key, the market and the owner are read from
 * the agent's home directory. Each can also be given in the environment, which then wins:
 *
 * - `AGENT_KEY`: a reference to the agent's key (`file:<path>`, `env:<NAME>` or a name in the key directory). Never
 *   the key itself.
 * - `AGENT_MARKET`: the address of a market, such as the hosted demo. It names the network and lists the sellers.
 *   Without it, the network comes from `STELLAR_NETWORK` and the usual settings, and no sellers are listed.
 * - `AGENT_WALLET`: the wallet to pay from; or `AGENT_OWNER`, the owner's account, from which a market's wallet
 *   address is derived.
 * - `AGENT_POLICY`: pay under this policy only. Without it the newest policy in force for this key is used.
 */
export async function configure(given: Record<string, string | undefined>, fetcher: typeof fetch = fetch, home?: string): Promise<AgentOptions> {
  // What `init` left, unless the environment names a key of its own.
  const stored = given['AGENT_KEY'] ? undefined : await readSettings(agentHome(given, home));
  const env = stored ? {
    ...given, AGENT_KEY: keyReference(agentHome(given, home), 'agent'), AGENT_MARKET: given['AGENT_MARKET'] ?? stored.market,
    ...(given['AGENT_WALLET'] ? {} : { AGENT_OWNER: given['AGENT_OWNER'] ?? stored.owner }),
  } : given;
  const reference = env['AGENT_KEY'];
  if (!reference) {
    throw new Error('This agent has not been set up. Run `init --market <address> --owner <G...>` first, or set AGENT_KEY to a reference to its key.');
  }
  const agent = await loadKey(reference, env);
  const base = env['AGENT_MARKET'] ? marketBase(env['AGENT_MARKET']) : undefined;
  const market = base ? await readMarket(base, fetcher) : undefined;
  const settings = market ? { rpcUrl: market.rpc_url, passphrase: market.passphrase, local: market.network === 'local' }
    : (({ rpcUrl, passphrase, network }) => ({ rpcUrl, passphrase, local: network === 'local' }))(loadConfig(env));

  let wallet = env['AGENT_WALLET'];
  if (!wallet) {
    const owner = env['AGENT_OWNER'];
    if (!owner || !market) throw new Error('Set AGENT_WALLET to the wallet to pay from, or AGENT_OWNER together with AGENT_MARKET');
    if (!StrKey.isValidEd25519PublicKey(owner)) throw new Error('AGENT_OWNER must be a G... account address');
    wallet = deployedAddress(market.passphrase, owner, Uint8Array.from(Buffer.from(market.wallet_salt, 'hex')));
  }
  if (!StrKey.isValidContract(wallet)) throw new Error('AGENT_WALLET must be a C... contract address');
  const pinned = env['AGENT_POLICY'];
  if (pinned !== undefined && !/^[0-9a-f]{64}$/.test(pinned)) throw new Error('AGENT_POLICY must be a 64-character hex policy hash');

  const server = new rpc.Server(settings.rpcUrl, { allowHttp: settings.local, timeout: 30_000 });
  const context = await networkContext(server, settings.passphrase);
  const offers = async (): Promise<Offer[]> => {
    if (!base) return [];
    // Read again each time: a market's prices can change while an agent runs.
    const now = await readMarket(base, fetcher);
    const names = new Map((now.vendors ?? []).map((vendor) => [vendor.id, vendor.name]));
    return (now.products ?? []).filter((product) => typeof product.path === 'string').map((product) => ({
      seller: names.get(product.vendor) ?? product.vendor, title: product.title,
      url: new URL(product.path!.replace(/^\//, ''), base).href,
      listed_price: `${product.price}${now.asset?.code ? ` ${now.asset.code}` : ''}`,
    }));
  };
  return {
    server, context, agent, wallet, offers, fetch: fetcher,
    ...(pinned ? { policyHash: Uint8Array.from(Buffer.from(pinned, 'hex')) as Hash32 } : {}),
  };
}

const USAGE = `Usage:
  stellar-agent-wallet init --market <address> --owner <G...> [--name <text>] [--description <text>] [--home <dir>] [--json]
      Create this machine's agent, register and verify it, and tell the owner it would like an allowance.
  stellar-agent-wallet status [--home <dir>]
      Show what the owner allows this agent to spend.
  stellar-agent-wallet mcp [--home <dir>]
      Serve the agent's tools to an agent host, over standard input and output. This is what a host starts.`;

function describe(result: InitResult, tool: string, defaultHome: string): string {
  // An agent kept somewhere other than the usual place has to be started with the same place named.
  // Run through npx, the tool sits in npm's cache, which is not a place to point a host at; name the package.
  const start = /[\\/]_npx[\\/]/.test(tool) ? 'npx -y stellar-agent-wallet' : `node ${tool}`;
  const script = result.home === defaultHome ? start : `${start} --home ${result.home}`;
  const verified = 'error' in result.verification ? `not verified yet: ${result.verification.error}`
    : `${result.verification.status === 'current' ? 'already verified' : 'verified'}; ${(result.verification.checks ?? [])
      .filter((check) => check.outcome === 'Passed').map((check) => check.kind).join(', ') || 'no checks'} passed`;
  return [
    `Agent ${result.agent_id} is ${result.registered === 'now' ? 'registered' : 'already registered'}, and ${verified}.`,
    `  Agent key      ${result.signer}   (kept in ${result.home}; never share the key files)`,
    `  Owner's wallet ${result.wallet}`,
    '',
    'It cannot spend anything yet. Two things are left:',
    '',
    `1. The owner approves an allowance for it, in their own wallet, at:`,
    `     ${result.approve_at}`,
    '',
    '2. The agent host is told how to start its tools:',
    `     Claude Code:  claude mcp add agent-wallet -- ${script} mcp`,
    `     Codex:        codex mcp add agent-wallet -- ${script} mcp`,
    `     Any other:    start it with: ${script} mcp`,
    '',
    'Then ask the agent to call its `allowance` tool.',
  ].join('\n');
}

/** Run the command line. Returns the process exit code. */
export async function main(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void = console.log): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      market: { type: 'string' }, owner: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
      home: { type: 'string' }, json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    },
  });
  const command = positionals[0] ?? 'mcp';
  if (values.help || positionals.length > 1) {
    out(USAGE);
    return values.help ? 0 : 2;
  }
  const home = agentHome(env, values.home);
  if (command === 'init') {
    if (!values.market || !values.owner) {
      out(USAGE);
      return 2;
    }
    const result = await initAgent({
      market: values.market, owner: values.owner, home, log: (line) => console.error(line),
      ...(values.name ? { name: values.name } : {}), ...(values.description ? { description: values.description } : {}),
    });
    out(values.json ? JSON.stringify(result, null, 2) : describe(result, realpathSync(process.argv[1] ?? 'stellar-agent-wallet'), agentHome(env)));
    return 0;
  }
  if (command === 'status') {
    out(JSON.stringify(await createWalletAgent(await configure(env, fetch, values.home)).allowance(), null, 2));
    return 0;
  }
  if (command === 'mcp') {
    // Standard output carries the protocol. Anything said to a person goes to standard error.
    const options = await configure(env, fetch, values.home);
    await createMcpServer(createWalletAgent(options)).connect(new StdioServerTransport());
    console.error(`stellar-agent-wallet: agent ${options.agent.address} for wallet ${options.wallet}`);
    // A verification is time-limited. Asking costs nothing while it is current, and renews it when it is not.
    const stored = await readSettings(home);
    if (stored && !env['AGENT_KEY']) {
      void fetch(new URL('v1/agents/verify', stored.market), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: stored.agent_id }),
      }).catch(() => undefined);
    }
    return -1;
  }
  out(USAGE);
  return 2;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2), process.env).then((code) => {
    // The MCP server keeps running until its host closes it.
    if (code >= 0) process.exitCode = code;
  }, (error: unknown) => {
    console.error(`stellar-agent-wallet: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
