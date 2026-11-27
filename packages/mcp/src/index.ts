#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StrKey, rpc } from '@stellar/stellar-sdk';
import { deployedAddress, loadConfig, networkContext, type Hash32 } from '@stellar-agent-auth/sdk';
import { isMainModule, loadKey } from '@stellar-agent-auth/sdk/node';
import { z } from 'zod';
import { createWalletAgent, type AgentOptions, type Offer, type WalletAgent } from './agent.js';

export { createWalletAgent, type AgentOptions, type Offer, type WalletAgent } from './agent.js';

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

/** What a market says about itself: the demo server's `GET /v1/config`, as far as it is used here. */
interface Market {
  rpc_url: string;
  passphrase: string;
  network: string;
  wallet_salt: string;
  agent?: { signer?: string };
  asset?: { code?: string };
  vendors?: { id: string; name: string }[];
  products?: { vendor: string; title: string; price: string; path?: string }[];
}

async function readMarket(base: URL, fetcher: typeof fetch): Promise<Market> {
  const response = await fetcher(new URL('v1/config', base));
  if (!response.ok) throw new Error(`The market at ${base.origin} answered ${response.status}`);
  const market = await response.json() as Market;
  if (typeof market.rpc_url !== 'string' || typeof market.passphrase !== 'string' || !/^[0-9a-f]{64}$/.test(market.wallet_salt ?? '')) {
    throw new Error(`The market at ${base.origin} did not describe its deployment`);
  }
  return market;
}

/**
 * Read the agent's settings from the environment:
 *
 * - `AGENT_KEY`: a reference to the agent's key (`file:<path>`, `env:<NAME>` or a name in the key directory). Never
 *   the key itself.
 * - `AGENT_MARKET`: the address of a market, such as the hosted demo. It names the network and lists the sellers.
 *   Without it, the network comes from `STELLAR_NETWORK` and the usual settings, and no sellers are listed.
 * - `AGENT_WALLET`: the wallet to pay from; or `AGENT_OWNER`, the owner's account, from which a market's wallet
 *   address is derived.
 * - `AGENT_POLICY`: pay under this policy only. Without it the newest policy in force for this key is used.
 */
export async function configure(env: Record<string, string | undefined>, fetcher: typeof fetch = fetch): Promise<AgentOptions> {
  const reference = env['AGENT_KEY'];
  if (!reference) throw new Error('Set AGENT_KEY to a reference to the agent\'s key, such as file:/path/to/agent.key');
  const agent = await loadKey(reference, env);
  const base = env['AGENT_MARKET'] ? new URL(env['AGENT_MARKET'].endsWith('/') ? env['AGENT_MARKET'] : `${env['AGENT_MARKET']}/`) : undefined;
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

if (isMainModule(import.meta.url)) {
  // Standard output carries the protocol. Anything said to a person goes to standard error.
  configure(process.env).then(async (options) => {
    await createMcpServer(createWalletAgent(options)).connect(new StdioServerTransport());
    console.error(`stellar-agent-wallet: agent ${options.agent.address} for wallet ${options.wallet}`);
  }, (error: unknown) => {
    console.error(`stellar-agent-wallet: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
