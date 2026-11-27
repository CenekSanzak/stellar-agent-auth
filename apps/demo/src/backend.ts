/** The demo server, as the page sees it. Types mirror `apps/demo/server`. */

export interface Vendor {
  id: string;
  name: string;
  tagline: string;
  /** The checks this seller requires of a paying agent. */
  requires: string[];
  sells_to: string;
  /** Whether the allowance form ticks this seller to begin with. */
  suggested: boolean;
  /** The account it is paid at. */
  address: string;
}

export interface Product {
  id: string;
  vendor: string;
  kind: string;
  title: string;
  /** Whole units of the demo asset. */
  price: string;
  /** Where it is sold over x402, on this server. */
  path: string;
}

export interface Task {
  id: string;
  label: string;
  description: string;
}

export interface Config {
  network: 'local' | 'testnet';
  rpc_url: string;
  passphrase: string;
  agent_registry: string;
  verification_registry: string;
  asset: { contract: string; code: string; issuer: string; decimals: number };
  wallet_wasm_hash: string;
  wallet_salt: string;
  agent: { agent_id: string; revision: string; signer: string; controller: string; metadata_uri: string };
  provider: { address: string; mode: 'Live' | 'Fixture' };
  vendors: Vendor[];
  products: Product[];
  tasks: Task[];
  faucet_amount: string;
  /** Where the indexer's read routes are, relative to this page. */
  indexer_path: string;
  /** An account that exists, to name as the source of read-only simulations. */
  read_source: string;
  /** Whether someone can bring an agent of their own to this server, and whether it can verify one. */
  own_agents: { setup: boolean; verify: boolean };
  /** The address this server is reached at by others, when it has one. */
  public_url: string | null;
  explorer: string | null;
}

/** An agent someone set up on their own machine, which asked to work for this owner. */
export interface LinkedAgent {
  agent_id: string;
  name: string;
  signer: string;
}

export interface Session {
  wallet: string;
  deployed: boolean;
}

/** What a purchase returned: something the seller read from the network when it was bought. */
export interface Content {
  title: string;
  summary: string;
  facts: { label: string; value: string }[];
  table?: { columns: string[]; rows: string[][] };
  as_of_ledger: number;
  source: string;
}

export interface Step {
  vendor: string;
  product: string;
  title: string;
  amount: string | null;
  payee: string | null;
  /** `blocked`: the wallet refused. `declined`: the seller refused. Neither moved any money. */
  status: 'paid' | 'blocked' | 'declined' | 'unsettled';
  error: string | null;
  detail: string | null;
  tx_hash: string | null;
  content: Content | null;
}

export interface TaskResult {
  task: string;
  notes: string[];
  steps: Step[];
}

export interface Attempt {
  id: number;
  kind: 'simulation' | 'transaction';
  status: string;
  error: string | null;
  detail: string | null;
  tx_hash: string | null;
  recorded_at: string;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(answer.error ?? `The demo server answered ${response.status}`);
  return answer;
}

export const demoServer = {
  config: () => call<Config>('/v1/config'),
  session: (owner: string) => call<Session>('/v1/session', { owner }),
  agents: (owner: string) => call<{ agents: LinkedAgent[] }>(`/v1/agents?owner=${encodeURIComponent(owner)}`).then((answer) => answer.agents),
  fund: (owner: string) => call<{ status: string; tx_hash: string; amount: string; asset: string }>('/v1/fund', { owner }),
  task: (owner: string, task: string, policyHash: string) =>
    call<TaskResult>('/v1/tasks', { owner, task, policy_hash: policyHash }),
};

/** Where the indexer is, as an absolute address the SDK can build requests on. */
export const indexerUrl = (config: Config, origin: string = location.origin) => new URL(config.indexer_path, origin).href;

/** Purchases that did not happen: refusals, which are never part of the audit chain. */
export async function readAttempts(indexer: string, wallet: string): Promise<Attempt[]> {
  const response = await fetch(new URL(`v1/wallets/${wallet}/attempts?limit=200`, indexer));
  if (!response.ok) throw new Error(`The indexer answered ${response.status}`);
  return ((await response.json()) as { attempts: Attempt[] }).attempts;
}
