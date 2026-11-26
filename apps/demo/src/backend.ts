/** The demo server, as the page sees it. Types mirror `apps/demo/server`. */

export interface Scenario {
  id: string;
  label: string;
  description: string;
  expected: string;
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
  service: { contract: string; service_id: string; price: string };
  roles: { recipient: string; stranger: string; sponsor: string };
  scenarios: Scenario[];
  faucet_amount: string;
  explorer: string | null;
}

export interface Session {
  wallet: string;
  deployed: boolean;
  indexer_url: string | null;
}

export interface Step {
  path: 'execute' | 'account' | 'service' | 'x402';
  amount: string;
  recipient: string;
  status: 'paid' | 'refused' | 'failed' | 'unsettled';
  error: string | null;
  detail: string | null;
  tx_hash: string | null;
}

export interface ScenarioResult {
  scenario: string;
  expected: string;
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
  fund: () => call<{ status: string; tx_hash: string; amount: string; asset: string }>('/v1/fund', {}),
  pay: (scenario: string, policyHash: string) => call<ScenarioResult>('/v1/payments', { scenario, policy_hash: policyHash }),
};

/** Attempts the indexer was told about: refusals and failures, which are never part of the audit chain. */
export async function readAttempts(indexerUrl: string, wallet: string): Promise<Attempt[]> {
  const response = await fetch(new URL(`v1/wallets/${wallet}/attempts?limit=200`, indexerUrl));
  if (!response.ok) throw new Error(`The indexer answered ${response.status}`);
  return ((await response.json()) as { attempts: Attempt[] }).attempts;
}
