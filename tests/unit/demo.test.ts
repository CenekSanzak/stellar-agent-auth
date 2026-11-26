import { describe, expect, it } from 'vitest';
import { StorageJournal } from '../../apps/demo/src/chain.js';
import { addr, duration, esc, short, utc } from '../../apps/demo/src/format.js';
import {
  coverage, describeOutcome, explainRefusal, networkProblem, policyBudget, policySentences, policyStatus, stageVerdict,
  verificationVerdict,
} from '../../apps/demo/src/model.js';
import { connectLocalKey } from '../../apps/demo/src/owner.js';
import { initialState, type State } from '../../apps/demo/src/state.js';
import { renderAgent } from '../../apps/demo/src/views/agents.js';
import { renderActivity, renderConnection, renderHistory, renderNotice } from '../../apps/demo/src/views/history.js';
import { renderPolicies, renderPolicyForm } from '../../apps/demo/src/views/policies.js';
import { renderWallet } from '../../apps/demo/src/views/wallet.js';
import type { Config } from '../../apps/demo/src/backend.js';
import { assertDeployment } from '../../apps/demo/server/deployment.js';
import { SCENARIOS } from '../../apps/demo/server/agent.js';
import type {
  AgentIdentity, Policy, PolicyState, TransactionRecord, VerificationResult,
} from '../../packages/sdk/src/index.js';
import { account, bytes, contract } from '../fixtures/abi-v1.js';

const NOW = 1_800_000_000n;
const UNIT = 10_000_000n;
const asset = { contract: contract(3), code: 'DEMO', issuer: account(4), decimals: 7 };
const wallet = contract(11);

const config: Config = {
  network: 'local', rpc_url: 'http://localhost:8000/rpc', passphrase: 'Standalone Network ; February 2017',
  agent_registry: contract(1), verification_registry: contract(2), asset, wallet_wasm_hash: 'ab'.repeat(32),
  wallet_salt: 'cd'.repeat(32),
  agent: { agent_id: '1', revision: '1', signer: account(5), controller: account(6), metadata_uri: 'https://agent.example.test/a.json' },
  provider: { address: account(7), mode: 'Fixture' }, service: { contract: contract(8), service_id: 'ef'.repeat(32), price: '1' },
  roles: { recipient: account(9), stranger: account(10), sponsor: account(12) },
  scenarios: [...SCENARIOS], faucet_amount: '100', explorer: null,
};

const identity: AgentIdentity = {
  agent_id: 1n, controller: account(6), signer: account(5), metadata_uri: 'https://agent.example.test/a.json',
  metadata_hash: bytes(1), revision: 1n, disabled: false,
};
const result: VerificationResult = {
  schema_version: 1, agent_id: 1n, revision: 1n, provider: account(7), sequence: 1n, mode: 'Fixture',
  checks: [
    { kind: 'Code', outcome: 'Unsupported', score: null }, { kind: 'Endpoint', outcome: 'Passed', score: 0 },
    { kind: 'Metadata', outcome: 'Passed', score: 0 }, { kind: 'SignerHistory', outcome: 'Inconclusive', score: null },
  ],
  risk_score: 0, serious_wallet_risks: 0, evidence_hash: bytes(2), issued_at: NOW - 3_600n, expires_at: NOW + 86_400n * 29n,
  revoked: false,
};
const provider = { mode: 'Fixture' as const, approved: true };

const policy: Policy = {
  schema_version: 1, policy_id: bytes(1), agent_id: 1n, revision: 1n, signer: account(5), provider: account(7),
  required_checks: ['Endpoint', 'Metadata', 'SignerAccount'], max_assessment_age: 30n * 86_400n, max_risk_score: 10,
  assets: [{ asset: asset.contract, per_transaction: 5n * UNIT, per_day: 20n * UNIT, total: null }],
  allowed_recipients: [account(9)], blocked_recipients: [], valid_after: NOW - 60n, valid_until: NOW + 7n * 86_400n,
  action_kinds: ['Transfer'], service: null,
};
const policyState = (overrides: Partial<PolicyState> = {}): PolicyState => ({
  policy_hash: bytes(3), revoked: false, next_sequence: 2n, utc_day: NOW / 86_400n,
  daily_spend: [{ asset: asset.contract, amount: 3n * UNIT }], total_spend: [{ asset: asset.contract, amount: 3n * UNIT }],
  ...overrides,
});

const ready = (overrides: Partial<State> = {}): State => ({
  ...initialState(), config, now: NOW, owner: { kind: 'local', address: account(20) }, accountFunded: true,
  session: { wallet, deployed: true, indexer_url: 'http://127.0.0.1:9/' },
  agent: { identity, result, provider },
  wallet: { balance: 97n * UNIT, paused: false, head: { sequence: 2n, hash: bytes(9) } },
  ...overrides,
});

describe('verification wording', () => {
  const verdict = (overrides: Partial<Parameters<typeof verificationVerdict>[0]> = {}) =>
    verificationVerdict({ identity, result, provider, now: NOW, ...overrides });

  it('says verified only when the result can be relied on now', () => {
    expect(verdict()).toMatchObject({ tone: 'good', label: 'Verified', detail: expect.stringContaining('expires in 29 days') });
  });

  it('names each reason a result cannot be relied on', () => {
    expect(verdict({ now: result.expires_at })).toMatchObject({ tone: 'bad', label: 'Expired' });
    expect(verdict({ now: result.expires_at + 7_200n }).detail).toContain('expired 2 hours ago');
    expect(verdict({ result: { ...result, revoked: true } }).label).toBe('Revoked');
    expect(verdict({ result: undefined }).label).toBe('Not verified');
    expect(verdict({ identity: undefined }).label).toBe('No agent');
    expect(verdict({ identity: { ...identity, disabled: true } }).label).toBe('Agent disabled');
    expect(verdict({ identity: { ...identity, revision: 2n } })).toMatchObject({ label: 'Out of date', detail: expect.stringContaining('revision 2') });
    expect(verdict({ provider: { mode: 'Fixture', approved: false } }).label).toBe('Provider not approved');
    expect(verdict({ provider: undefined }).label).toBe('Provider not approved');
    expect(verdict({ result: { ...result, serious_wallet_risks: 1 } }).label).toBe('Risk flagged');
    expect(verdict({ result: { ...result, checks: [{ kind: 'Endpoint', outcome: 'Failed', score: 100 }] } }))
      .toMatchObject({ label: 'Check failed', detail: 'Failed: Endpoint.' });
  });

  it('separates what was checked from what was not', () => {
    expect(coverage(result)).toEqual({ passed: ['Endpoint', 'Metadata'], failed: [], inconclusive: ['SignerHistory'], notChecked: ['Code'] });
  });

  it('labels a fixture result as simulated and shows an expired one as expired', () => {
    const html = renderAgent(ready());
    expect(html).toContain('data-testid="fixture-label"');
    expect(html).toContain('Simulated result');
    expect(html).toContain('Not checked');
    const expired = renderAgent(ready({ now: result.expires_at + 10n }));
    expect(expired).toMatch(/data-testid="verification-status">Expired</);
    const live = renderAgent(ready({
      config: { ...config, provider: { ...config.provider, mode: 'Live' } }, agent: { identity, provider, result: { ...result, mode: 'Live' } },
    }));
    expect(live).not.toContain('fixture-label');
  });
});

describe('policy wording', () => {
  it('states the permission in plain sentences', () => {
    const lines = policySentences(policy, asset, NOW);
    expect(lines[0]).toBe('Agent 1 may pay up to 5 DEMO at a time and 20 DEMO per UTC day, with no overall cap.');
    expect(lines).toContain('Valid until 2027-01-22 08:00 UTC, 7 days from now.');
    expect(lines.join(' ')).toContain('no older than 30 days, with a risk score of at most 10, covering Endpoint, Metadata, SignerAccount');
    const capped = policySentences({
      ...policy, assets: [{ ...policy.assets[0]!, total: 100n * UNIT }], blocked_recipients: [account(10)],
      service: { contract: contract(8), service_id: bytes(4) },
    }, asset, NOW);
    expect(capped[0]).toContain('and 100 DEMO in total');
    expect(capped.join(' ')).toMatch(/Never to G.+…/);
    expect(capped.join(' ')).toContain('in the service\'s own call');
    expect(policySentences({ ...policy, assets: [] }, asset, NOW)[0]).toBe('Agent 1 may not pay in DEMO under this policy.');
    expect(policySentences(policy, asset, policy.valid_until + 1n).join(' ')).toContain('It ended on');
  });

  it('reports status and what is left today', () => {
    expect(policyStatus(policy, policyState(), NOW)).toBe('active');
    expect(policyStatus(policy, policyState({ revoked: true }), NOW)).toBe('revoked');
    expect(policyStatus(policy, policyState(), policy.valid_until)).toBe('expired');
    expect(policyStatus(policy, policyState(), policy.valid_after - 1n)).toBe('not-yet-valid');
    expect(policyBudget(policy, policyState(), asset)).toMatchObject({ spentToday: 3n * UNIT, leftToday: 17n * UNIT, share: 15, total: null });
    expect(policyBudget(policy, policyState({ daily_spend: [{ asset: asset.contract, amount: 25n * UNIT }] }), asset))
      .toMatchObject({ leftToday: 0n, share: 100 });
    expect(policyBudget({ ...policy, assets: [] }, policyState(), asset)).toBeUndefined();
  });

  it('offers revocation only for an active policy and the agent scenarios for every policy', () => {
    const hash = 'aa'.repeat(32);
    const active = renderPolicies(ready({ policies: [{ hash, policy, state: policyState() }] }));
    expect(active).toContain('data-action="revoke"');
    expect(active).toContain('data-status="active"');
    expect(active.match(/data-action="scenario"/g)).toHaveLength(SCENARIOS.length);
    const revoked = renderPolicies(ready({ policies: [{ hash, policy, state: policyState({ revoked: true }) }] }));
    expect(revoked).not.toContain('data-action="revoke"');
    expect(revoked).toContain('the wallet should refuse each of them');
    expect(renderPolicies(ready())).toContain('Without one, the agent can do nothing');
    expect(renderPolicyForm(ready())).toContain('value="5"');
    expect(renderPolicyForm(ready({ session: { wallet, deployed: false, indexer_url: null } }))).toBe('');
  });
});

describe('wallet view', () => {
  it('walks the owner from no connection to a wallet', () => {
    expect(renderWallet(ready({ owner: null }))).toContain('Connect as the owner');
    expect(renderWallet(ready({ accountFunded: false }))).toContain('data-action="test-xlm"');
    expect(renderWallet(ready({ session: { wallet, deployed: false, indexer_url: null } }))).toContain('data-action="create-wallet"');
    const html = renderWallet(ready());
    expect(html).toMatch(/data-testid="wallet-balance">97</);
    expect(html).toContain('test asset, no value');
    expect(html).toContain('No active policy: no agent can move anything.');
    expect(html).toContain('data-action="pause"');
  });

  it('shows a pause plainly and the combined exposure across policies', () => {
    const paused = renderWallet(ready({ wallet: { balance: 0n, paused: true, head: { sequence: 0n, hash: bytes(0) } } }));
    expect(paused).toMatch(/data-testid="wallet-status">Paused</);
    expect(paused).toContain('data-action="resume"');
    expect(paused).not.toContain('data-action="pause"');
    const exposed = renderWallet(ready({
      exposure: [{ asset: asset.contract, daily_cap: 40n * UNIT, spent_today: 3n * UNIT, remaining_today: 37n * UNIT,
        largest_transfer: 5n * UNIT, remaining_total: null, policies: 2 }],
    }));
    expect(exposed).toContain('Across 2 active policies');
    expect(exposed).toContain('<strong>37 DEMO</strong> today');
    expect(exposed).toContain('No overall cap');
  });
});

describe('history view', () => {
  const entry = (sequence: bigint, outcome: Parameters<typeof describeOutcome>[0]) => ({
    entry: { schema_version: 1, wallet, sequence, previous_hash: bytes(0), ledger: 10, timestamp: NOW, actor: account(5), outcome },
    hash: bytes(1), ledger: 10, transaction: 'ab'.repeat(32), event_id: `${sequence}`,
  });
  const transfer = { asset: asset.contract, recipient: account(9), amount: 3n * UNIT };

  it('describes each kind of entry', () => {
    expect(describeOutcome({ kind: 'Executed', policy_hash: bytes(1), action_hash: bytes(2), action: { kind: 'Transfer', transfer } }, asset))
      .toMatchObject({ title: 'Agent payment', detail: expect.stringMatching(/^3 DEMO to G/) });
    expect(describeOutcome({ kind: 'AccountPayment', policy_hash: bytes(1), authorization: bytes(2),
      action: { kind: 'ServicePayment', service: { contract: contract(8), service_id: bytes(4) }, payment: transfer } }, asset))
      .toMatchObject({ title: 'Service payment', detail: expect.stringContaining('through service') });
    expect(describeOutcome({ kind: 'AccountPayment', policy_hash: bytes(1), authorization: bytes(2), action: { kind: 'Transfer', transfer } }, asset).title)
      .toBe('Account payment');
    expect(describeOutcome({ kind: 'PauseChanged', paused: true }, asset).title).toBe('Wallet paused');
    expect(describeOutcome({ kind: 'PauseChanged', paused: false }, asset).title).toBe('Wallet resumed');
    expect(describeOutcome({ kind: 'PolicyRevoked', policy_hash: bytes(1) }, asset).title).toBe('Policy revoked');
    expect(describeOutcome({ kind: 'OwnerWithdrawal', transfer: { ...transfer, asset: contract(50) } }, asset).detail).toContain('units of');
  });

  it('says whether the list is the whole history, and keeps refusals apart', () => {
    const history = {
      status: 'verified' as const, detail: '2 entries from genesis match the stored head', head: { sequence: 2n, hash: bytes(1) },
      indexer: { status: 'verified', detail: 'ok' },
      entries: [entry(1n, { kind: 'PolicyCreated', policy_hash: bytes(1) }),
        entry(2n, { kind: 'Executed', policy_hash: bytes(1), action_hash: bytes(2), action: { kind: 'Transfer', transfer } })],
    };
    const attempts = [
      { id: 1, kind: 'simulation' as const, status: 'refused', error: 'PaymentLimitExceeded', detail: null, tx_hash: null, recorded_at: '2026-11-25T15:00:00.000Z' },
      { id: 2, kind: 'transaction' as const, status: 'failed', error: null, detail: null, tx_hash: 'cd'.repeat(32), recorded_at: '2026-11-25T15:01:00.000Z' },
    ];
    const html = renderHistory(ready({ history, attempts }));
    expect(html).toMatch(/data-testid="history-status">Complete and verified</);
    expect(html.indexOf('Agent payment')).toBeLessThan(html.indexOf('Policy approved'));
    expect(html).toContain('These are not on the ledger');
    expect(html).toContain('PaymentLimitExceeded:');
    expect(html).toContain('The network gave no reason.');
    expect(html).not.toContain('Do not treat this list');

    const partial = renderHistory(ready({ history: { ...history, status: 'incomplete', detail: 'Entries after 2 are not yet visible' } }));
    expect(partial).toMatch(/data-testid="history-status">Incomplete</);
    expect(partial).toContain('Do not treat this list as the whole history');
    expect(renderHistory(ready({ history: { ...history, status: 'mismatch', detail: 'Entry 2 does not hash' } })))
      .toMatch(/history-status">Does not match the wallet</);
    expect(renderHistory(ready({ historyError: 'offline' }))).toContain('The history could not be read: offline');
  });

  it('links to an explorer only where there is one', () => {
    const history = {
      status: 'verified' as const, detail: 'ok', head: { sequence: 1n, hash: bytes(1) }, indexer: null,
      entries: [entry(1n, { kind: 'PauseChanged', paused: true })],
    };
    expect(renderHistory(ready({ history }))).not.toContain('<a href');
    expect(renderHistory(ready({ history, config: { ...config, network: 'testnet', explorer: 'https://stellar.expert/explorer/testnet' } })))
      .toContain(`href="https://stellar.expert/explorer/testnet/tx/${'ab'.repeat(32)}"`);
  });
});

describe('progress and failure states', () => {
  it('never shows a submitted or unsettled action as done', () => {
    expect(stageVerdict('submitted')).toMatchObject({ tone: 'warn', label: 'Submitted, not confirmed' });
    expect(stageVerdict('unsettled')).toMatchObject({ tone: 'warn', detail: expect.stringContaining('Do not repeat it') });
    expect(stageVerdict('confirmed').tone).toBe('good');
    expect(stageVerdict('refused').detail).toBe('Nothing was submitted.');
    const html = renderActivity(ready({
      busy: 'Revoking', activity: [
        { id: 2, title: 'Revoke the policy', stage: 'submitted', detail: '', hash: 'ab'.repeat(32) },
        { id: 1, title: 'Agent: Pay above the per-payment limit', stage: 'refused', detail: '', hash: null, expected: 'PaymentLimitExceeded',
          steps: [{ path: 'execute', amount: '6', recipient: account(9), status: 'refused', error: 'PaymentLimitExceeded', detail: null, tx_hash: null }] },
      ],
    }));
    expect(html).toContain('Submitted, not confirmed');
    expect(html).toContain('It has not taken effect yet.');
    expect(html).toContain('data-testid="busy"');
    expect(html).toContain('Expected: refused with PaymentLimitExceeded.');
    expect(html).toContain('data-error="PaymentLimitExceeded"');
  });

  it('explains a refusal, and says so when the network gave no reason', () => {
    expect(explainRefusal('Revoked')).toMatch(/^Revoked: /);
    expect(explainRefusal(null)).toBe('The network gave no reason.');
    expect(explainRefusal('SomethingNew')).toBe('SomethingNew');
    // A paid API's own refusal is told apart from the wallet's.
    expect(explainRefusal('payee_gate_CheckNotPassed')).toMatch(/^The API's own check refused the agent, and nothing was paid\. CheckNotPassed: /);
    expect(explainRefusal('payee_gate_unknown_payer')).toContain('unknown payer');
  });

  it('refuses a wallet on another network', () => {
    expect(networkProblem(config.passphrase, config.passphrase)).toBeNull();
    expect(networkProblem(config.passphrase, 'Public Global Stellar Network ; September 2015')).toContain('Switch it to');
    expect(networkProblem(config.passphrase, undefined)).toContain('did not say which network');
  });

  it('shows loading, a missing server and a failed read', () => {
    expect(renderNotice(initialState())).toContain('data-testid="loading"');
    expect(renderNotice({ ...initialState(), fatal: 'The demo server could not be reached' })).toContain('data-testid="fatal"');
    expect(renderNotice(ready({ readError: 'timeout' }))).toContain('may be out of date: timeout');
    expect(renderNotice(ready())).toBe('');
  });

  it('offers a demo key on the local network only, and never asks for a secret', () => {
    expect(renderConnection(ready({ owner: null }))).toContain('data-action="connect-local"');
    const testnet = renderConnection(ready({ owner: null, config: { ...config, network: 'testnet' } }));
    expect(testnet).not.toContain('connect-local');
    expect(testnet).toContain('data-action="connect-freighter"');
    expect(renderConnection(ready({ owner: null, connectError: 'Freighter was not found' }))).toContain('data-testid="connect-error"');
    expect(renderConnection(ready())).toContain('local demo key');

    const stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
    const first = connectLocalKey('local', storage);
    expect(connectLocalKey('local', storage).address).toBe(first.address);
    expect(() => connectLocalKey('testnet', storage)).toThrow('local network only');
    for (const html of [renderWallet(ready()), renderPolicyForm(ready()), renderConnection(ready({ owner: null }))]) {
      expect(html).not.toMatch(/type="password"|secret|seed/i);
    }
  });
});

describe('formatting and storage', () => {
  it('escapes everything it renders', () => {
    expect(esc('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
    expect(addr('G<b>')).toContain('&lt;b&gt;');
    const html = renderAgent(ready({ agent: { identity: { ...identity, metadata_uri: 'https://x.test/<script>alert(1)</script>' }, result, provider } }));
    expect(html).not.toContain('<script>');
  });

  it('formats addresses, spans and times', () => {
    expect(short(account(9))).toMatch(/^G.{3}….{4}$/);
    expect(duration(30)).toBe('30 seconds');
    expect(duration(60 * 60 * 3)).toBe('3 hours');
    expect(duration(7n * 86_400n - 20n)).toBe('7 days');
    expect(duration(86_400n * 2n)).toBe('2 days');
    expect(utc(1_800_000_000n)).toBe('2027-01-15 08:00 UTC');
  });

  it('keeps an unsettled transaction across a reload and drops nothing that is pending', async () => {
    const stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
    const record = (hash: string, status: TransactionRecord['status'], created: string): TransactionRecord => ({
      scope: 'source:G', hash, envelope: '', source: 'G', max_time: '1', submitted_after_ledger: 1, status,
      created_at: created, updated_at: created,
    });
    const journal = new StorageJournal(storage, 'journal');
    await journal.put(record('a', 'pending', '2026-01-01T00:00:01Z'));
    await journal.put(record('b', 'success', '2026-01-01T00:00:02Z'));
    const reloaded = new StorageJournal(storage, 'journal');
    expect((await reloaded.unsettled('source:G')).map((item) => item.hash)).toEqual(['a']);
    await reloaded.put(record('a', 'success', '2026-01-01T00:00:01Z'));
    expect(await reloaded.unsettled('source:G')).toEqual([]);
    expect((await reloaded.get('a'))?.status).toBe('success');
    stored.set('journal', 'not json');
    expect(await new StorageJournal(storage, 'journal').unsettled('source:G')).toEqual([]);
  });
});

describe('deployment record', () => {
  it('is refused when a field is missing or malformed', () => {
    const record = {
      network: 'local', rpc_url: 'http://localhost:8000/rpc', passphrase: 'x', epoch: 'demo-1', start_ledger: 5,
      agent_registry: contract(1), verification_registry: contract(2), asset, wallet_wasm_hash: 'ab'.repeat(32),
      wallet_salt: 'cd'.repeat(32), agent: config.agent, provider: config.provider, service: config.service,
      roles: { ...config.roles, funder: account(13), facilitator: account(14) }, key_directory: '/tmp/keys', created_at: 'now',
    };
    expect(() => assertDeployment(record)).not.toThrow();
    expect(() => assertDeployment({ ...record, agent_registry: 'C-not-an-address' })).toThrow('malformed');
    expect(() => assertDeployment({ ...record, wallet_salt: 'short' })).toThrow('malformed');
    expect(() => assertDeployment({ ...record, roles: { ...record.roles, funder: undefined } })).toThrow('malformed');
    expect(() => assertDeployment(null)).toThrow('malformed');
  });
});
