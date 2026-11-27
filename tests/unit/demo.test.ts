import { describe, expect, it } from 'vitest';
import { StorageJournal } from '../../apps/demo/src/chain.js';
import { addr, clock, duration, esc, money, short, tx, utc } from '../../apps/demo/src/format.js';
import {
  allowanceView, coverage, describeOutcome, explainRefusal, explainStep, networkProblem, policyStatus, stageVerdict,
  verificationVerdict,
} from '../../apps/demo/src/model.js';
import { connectGuest, forgetGuest } from '../../apps/demo/src/owner.js';
import {
  agentName, currentAllowance, formAgent, initialState, phaseOf, taskAllowance, type Activity, type OwnAgent, type State,
} from '../../apps/demo/src/state.js';
import { renderConnect, renderOwnAgents, setupPrompt } from '../../apps/demo/src/views/agents.js';
import { renderScout, renderSellers } from '../../apps/demo/src/views/market.js';
import { renderDetails, renderRecord } from '../../apps/demo/src/views/record.js';
import { renderAllowance, renderAllowanceForm, renderWallet } from '../../apps/demo/src/views/wallet.js';
import { renderAccount, renderNetwork, renderNotice, renderSetup, renderWelcome } from '../../apps/demo/src/views/welcome.js';
import { renderActivity, renderTasks } from '../../apps/demo/src/views/work.js';
import type { Config, Step } from '../../apps/demo/src/backend.js';
import { TASKS } from '../../apps/demo/server/agent.js';
import { agentReady } from '../../apps/demo/server/agent-ready.js';
import { rateLimiter } from '../../apps/demo/server/backend.js';
import {
  LedgerWatch, PRODUCTS, VENDORS, VENDOR_IDS, backfill, observe, produce, type ContentSource, type LedgerSource,
} from '../../apps/demo/server/catalogue.js';
import { assertDeployment } from '../../apps/demo/server/deployment.js';
import type {
  AgentIdentity, Policy, PolicyState, TransactionRecord, VerificationResult,
} from '../../packages/sdk/src/index.js';
import { account, bytes, contract } from '../fixtures/abi-v1.js';

const NOW = 1_800_000_000n;
const UNIT = 10_000_000n;
const asset = { contract: contract(3), code: 'tUSD', issuer: account(4), decimals: 7 };
const wallet = contract(11);
const payee = Object.fromEntries(VENDOR_IDS.map((id, index) => [id, account(30 + index)]));

const config: Config = {
  network: 'local', rpc_url: 'http://localhost:8000/rpc', passphrase: 'Standalone Network ; February 2017',
  agent_registry: contract(1), verification_registry: contract(2), asset, wallet_wasm_hash: 'ab'.repeat(32),
  wallet_salt: 'cd'.repeat(32),
  agent: { agent_id: '1', revision: '1', signer: account(5), controller: account(6), metadata_uri: 'https://agent.example.test/a.json' },
  provider: { address: account(7), mode: 'Fixture' },
  vendors: VENDORS.map((vendor) => ({ ...vendor, requires: [...vendor.requires], address: payee[vendor.id]! })),
  products: PRODUCTS.map(({ id, vendor, kind, title, price, path }) => ({ id, vendor, kind, title, price, path })),
  tasks: [...TASKS], faucet_amount: '100', indexer_path: '/indexer/', read_source: account(12), explorer: null,
  own_agents: { setup: true, verify: true }, public_url: null,
};
const testnet: Config = { ...config, network: 'testnet', explorer: 'https://explorer.example/testnet', provider: { ...config.provider, mode: 'Live' } };

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

const approved = ['ledger-wire', 'deep-archive', 'audited-sources'].map((id) => payee[id]!);
const allowance: Policy = { ...policy, assets: [{ asset: asset.contract, per_transaction: 5n * UNIT, per_day: 6n * UNIT, total: 20n * UNIT }], allowed_recipients: approved };
const view = (overrides: Partial<Policy> = {}, state: Partial<PolicyState> = {}, hash = 'aa'.repeat(32)) =>
  ({ hash, policy: { ...allowance, ...overrides }, state: policyState(state) });

const ready = (overrides: Partial<State> = {}): State => ({
  ...initialState(), config, now: NOW, owner: { kind: 'guest', label: 'Guest', address: account(20) }, accountFunded: true,
  session: { wallet, deployed: true },
  agent: { identity, result, provider },
  wallet: { balance: 97n * UNIT, paused: false, head: { sequence: 2n, hash: bytes(9) } },
  policies: [view()],
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

  it('labels a fixture result as simulated, and a live one not', () => {
    const html = renderScout(ready());
    expect(html).toContain('data-testid="fixture"');
    expect(html).toContain('SIMULATED');
    expect(html).toMatch(/data-testid="verification">Verified</);
    expect(html).toContain('<dt>Not checked</dt><dd>Code</dd>');
    expect(renderScout(ready({ now: result.expires_at + 10n }))).toMatch(/data-testid="verification">Expired</);
    expect(renderScout(ready({ config: testnet }))).not.toContain('data-testid="fixture"');
    expect(renderScout(ready({ agent: null }))).toContain('Reading the agent registry');
  });
});

describe('where the visitor is', () => {
  it('goes from loading to welcome to setup to ready', () => {
    expect(phaseOf(initialState())).toBe('loading');
    expect(phaseOf({ ...initialState(), config })).toBe('welcome');
    expect(phaseOf(ready({ session: null }))).toBe('setup');
    expect(phaseOf(ready({ session: { wallet, deployed: false } }))).toBe('setup');
    expect(phaseOf(ready())).toBe('ready');
  });

  it('offers a guest, Freighter and other wallets, and says the money is not real', () => {
    const html = renderWelcome({ ...initialState(), config });
    for (const action of ['connect-guest', 'connect-freighter', 'connect-kit']) expect(html).toContain(`data-action="${action}"`);
    expect(html).toContain('nothing real at stake');
    expect(html).not.toMatch(/secret|seed phrase/i);
    expect(renderWelcome({ ...initialState(), config, connectError: 'Freighter was not found' })).toContain('data-testid="connect-error"');
    expect(renderWelcome(ready())).toBe('');
    expect(renderNetwork({ ...initialState(), config })).toContain('Local network · test money only');
    expect(renderNetwork({ ...initialState(), config: testnet })).toContain('Testnet demo · test money only');
  });

  it('walks a connected owner through setting up, one button for all of it', () => {
    const html = renderSetup(ready({ session: { wallet, deployed: false }, accountFunded: false }));
    expect(html).toContain('data-action="setup"');
    expect(html).toContain('Friendbot');
    expect(html).not.toContain('class="done"');
    expect(renderSetup(ready({ session: { wallet, deployed: false } }))).toContain('class="done"');
    // Nothing can be started before the page knows the account and the wallet address.
    expect(renderSetup(ready({ session: null, accountFunded: null }))).toMatch(/data-action="setup" disabled/);
    expect(renderSetup(ready({ session: { wallet, deployed: false }, owner: { kind: 'freighter', label: 'Freighter', address: account(20) } })))
      .toContain('Your wallet asks you to approve it');
    expect(renderSetup(ready())).toBe('');
    expect(renderAccount(ready())).toMatch(/data-kind="guest"[\s\S]*Guest[\s\S]*data-action="disconnect"/);
  });

  it('shows loading, a missing server and a failed read', () => {
    expect(renderNotice(initialState())).toContain('data-testid="loading"');
    expect(renderNotice({ ...initialState(), fatal: 'The demo server could not be reached' })).toContain('data-testid="fatal"');
    expect(renderNotice(ready({ readError: 'RPC timed out' }))).toContain('may be out of date: RPC timed out');
    expect(renderNotice(ready())).toBe('');
  });
});

describe('the allowance', () => {
  it('is the newest active policy, and tasks fall back to the last one there was', () => {
    const ended = view({}, { revoked: true }, 'bb'.repeat(32));
    const expired = view({ valid_until: NOW - 1n }, {}, 'cc'.repeat(32));
    expect(currentAllowance(ready())?.hash).toBe('aa'.repeat(32));
    expect(currentAllowance(ready({ policies: [ended, view()] }))?.hash).toBe('aa'.repeat(32));
    expect(currentAllowance(ready({ policies: [ended, expired] }))).toBeUndefined();
    // Trying under an ended allowance is how the wallet's refusal is seen.
    expect(taskAllowance(ready({ policies: [ended, expired] }))?.hash).toBe('bb'.repeat(32));
    expect(taskAllowance(ready({ policies: [] }))).toBeUndefined();
    expect(policyStatus(allowance, policyState({ revoked: true }), NOW)).toBe('revoked');
    expect(policyStatus(allowance, policyState(), allowance.valid_until)).toBe('expired');
    expect(policyStatus(allowance, policyState(), allowance.valid_after - 1n)).toBe('not-yet-valid');
  });

  it('is told in the owner\'s numbers: spent, left, and how long it lasts', () => {
    expect(allowanceView(allowance, policyState(), asset, NOW)).toMatchObject({
      status: 'active', perPurchase: '5', perDay: '6', total: '20', spentToday: '3', spentEver: '3', leftToday: '3', share: 50,
      endsIn: 7n * 86_400n,
    });
    // What is left today cannot be more than what is left of the whole allowance.
    const nearlySpent = policyState({ daily_spend: [{ asset: asset.contract, amount: 1n * UNIT }], total_spend: [{ asset: asset.contract, amount: 19n * UNIT }] });
    expect(allowanceView(allowance, nearlySpent, asset, NOW).leftToday).toBe('1');
    expect(allowanceView({ ...allowance, assets: [] }, policyState(), asset, NOW)).toMatchObject({ perDay: '0', share: 0, leftToday: '0' });
    expect(allowanceView({ ...allowance, assets: [{ ...allowance.assets[0]!, total: null }] }, policyState(), asset, NOW).total).toBeNull();
    expect(allowanceView(allowance, policyState(), asset, allowance.valid_until + 5n).endsIn).toBe(0n);
    // The wallet stores yesterday's spend until the next payment; a new day starts at nothing spent.
    expect(allowanceView(allowance, policyState(), asset, NOW + 86_400n)).toMatchObject({ spentToday: '0', leftToday: '6', spentEver: '3', share: 0 });
  });

  it('shows the meter, the limits and the owner\'s two stops', () => {
    const html = renderAllowance(ready());
    expect(html).toMatch(/data-testid="allowance-status">Active</);
    expect(html).toMatch(/<strong>3<\/strong> of 6 tUSD spent today/);
    expect(html).toContain('width:50%');
    expect(html).toContain('3 / 20');
    expect(html).toContain('May pay: Ledger Wire, Deep Archive, Audited Sources.');
    expect(html).toMatch(/data-action="end" data-policy="a{64}"/);
    // Freezing is the wallet's: it stops every agent at once, so it sits with the wallet.
    expect(html).not.toContain('data-action="freeze"');
    expect(renderWallet(ready())).toContain('data-action="freeze"');
    const paused = ready({ wallet: { balance: 1n, paused: true, head: { sequence: 2n, hash: bytes(9) } } });
    expect(renderAllowance(paused)).toMatch(/data-testid="allowance-status">Frozen</);
    expect(renderWallet(paused)).toContain('data-action="unfreeze"');
    expect(renderWallet(paused)).toContain('data-testid="frozen"');
    expect(renderWallet(paused)).not.toContain('data-action="freeze"');
  });

  it('says there is none, before the first and after the last, and offers the form', () => {
    expect(renderAllowance(ready({ policies: [] }))).toContain('Scout cannot spend anything yet');
    expect(renderAllowance(ready({ policies: [view({}, { revoked: true })] }))).toContain('The last allowance has ended');
    const form = renderAllowanceForm(ready({ policies: [] }));
    expect(form).toContain('data-form="allowance"');
    // Three sellers are ticked to begin with; the cheapest is left for the owner to decide.
    expect(form.match(/name="vendor" value="[a-z-]+" checked/g)).toHaveLength(3);
    expect(form).toMatch(/value="bargain-data"\s+\/>/);
    expect(form).toContain('Recent ledgers dataset 8');
  });

  it('marks each seller approved or not under the current allowance', () => {
    const html = renderSellers(ready());
    const approvedOf = (id: string) => new RegExp(`data-vendor="${id}" data-approved="(true|false)"`).exec(html)?.[1];
    expect(VENDOR_IDS.map(approvedOf)).toEqual(['true', 'true', 'true', 'false']);
    expect(html).toContain('only agents whose code was audited');
    expect(renderSellers(ready({ policies: [] }))).not.toContain('data-approved="true"');
  });

  it('shows the balance and warns when there is nothing to spend', () => {
    const html = renderWallet(ready());
    expect(html).toMatch(/data-testid="wallet-balance">97</);
    expect(html).toContain('Add 100 tUSD');
    expect(html).not.toContain('The wallet is empty');
    expect(renderWallet(ready({ wallet: { balance: 0n, paused: false, head: { sequence: 0n, hash: bytes(0) } } }))).toContain('The wallet is empty');
    expect(renderWallet(ready({ wallet: null }))).toContain('Reading the wallet');
  });
});

describe('an agent of the owner\'s own', () => {
  const mine: OwnAgent = { agent_id: '7', name: 'Claude on my laptop', signer: account(40), view: {
    identity: { ...identity, agent_id: 7n, signer: account(40) }, provider,
    result: { ...result, agent_id: 7n, checks: [
      { kind: 'Endpoint', outcome: 'NotApplicable', score: null }, { kind: 'Metadata', outcome: 'Passed', score: 0 },
      { kind: 'SignerAccount', outcome: 'Passed', score: 0 }, { kind: 'Code', outcome: 'Unsupported', score: null },
    ] },
  } };
  const forMine = view({ agent_id: 7n, signer: account(40), assets: [{ asset: asset.contract, per_transaction: 2n * UNIT, per_day: 4n * UNIT, total: null }] },
    { daily_spend: [], total_spend: [] }, 'dd'.repeat(32));

  it('has an allowance of its own, apart from Scout\'s', () => {
    const both = ready({ own: [mine], policies: [forMine, view()] });
    expect(currentAllowance(both)?.hash).toBe('aa'.repeat(32));
    expect(currentAllowance(both, '7')?.hash).toBe('dd'.repeat(32));
    expect(currentAllowance(ready({ own: [mine] }), '7')).toBeUndefined();
    // Scout's tasks never run under another agent's allowance.
    expect(taskAllowance(ready({ own: [mine], policies: [forMine] }))).toBeUndefined();
    expect(agentName(both, '7')).toBe('Claude on my laptop');
    expect(agentName(both, '1')).toBe('Scout');
    expect(agentName(both, '99')).toBe('Agent 99');
  });

  it('is shown with its verification and its own limits, and asks for an allowance when it has none', () => {
    const html = renderOwnAgents(ready({ own: [mine], policies: [forMine, view()] }));
    expect(html).toMatch(/data-testid="own-agent" data-agent="7"/);
    expect(html).toContain('Claude on my laptop');
    expect(html).toMatch(/data-testid="own-agent-verification">Verified</);
    expect(html).toContain('Checked and passed: Metadata, SignerAccount');
    expect(html).toMatch(/<strong>0<\/strong> of 4 tUSD spent today/);
    expect(html).toMatch(/data-action="end" data-policy="d{64}"/);
    const waiting = renderOwnAgents(ready({ own: [mine] }));
    expect(waiting).toMatch(/data-testid="own-allowance" data-status="none"/);
    expect(waiting).toMatch(/data-action="set-allowance" data-agent="7"/);
    expect(renderOwnAgents(ready({ own: [{ ...mine, view: null }] }))).toContain('Reading…');
    const lapsed = renderOwnAgents(ready({ own: [mine], now: result.expires_at + 5n }));
    expect(lapsed).toMatch(/own-agent-verification">Expired</);
    expect(lapsed).toContain('will not pay for it until it is verified again');
    expect(renderOwnAgents(ready())).toBe('');
  });

  it('gets the one allowance form when the owner asks, and Scout gets it otherwise', () => {
    expect(formAgent(ready({ policies: [] }))).toBe('1');
    expect(formAgent(ready())).toBeUndefined();
    const asked = ready({ own: [mine], ui: { ...initialState().ui, formAgent: '7' } });
    expect(formAgent(asked)).toBe('7');
    const form = renderAllowanceForm(asked);
    expect(form).toMatch(/data-agent="7"/);
    expect(form).toContain('Set Claude on my laptop\'s allowance');
    expect(form).toContain('name="agent" value="7"');
    expect(form).toContain('Not now');
    // Asking for an agent that is not the owner's, or that already has an allowance, shows nothing for it.
    expect(formAgent(ready({ ui: { ...initialState().ui, formAgent: '7' } }))).toBeUndefined();
    expect(formAgent(ready({ own: [mine], policies: [forMine, view()], ui: { ...initialState().ui, formAgent: '7' } }))).toBeUndefined();
    expect(renderAllowanceForm(ready())).toBe('');
  });

  it('is brought in with one sentence that names this server and the owner', () => {
    expect(setupPrompt(config, account(20), 'http://127.0.0.1:8790')).toBe(
      `Set yourself up as an agent of my Stellar smart wallet, so you can pay for things inside an allowance I control. Follow http://127.0.0.1:8790/agent-ready.md?owner=${account(20)}`);
    expect(setupPrompt({ ...config, public_url: 'https://scout.example' }, account(20), 'http://ignored')).toContain('https://scout.example/agent-ready.md');
    const html = renderConnect(ready(), 'http://127.0.0.1:8790');
    expect(html).toContain('data-testid="setup-prompt"');
    expect(html).toContain(`agent-ready.md?owner=${account(20)}`);
    expect(html).toContain('data-action="copy-prompt"');
    expect(renderConnect(ready({ ui: { ...initialState().ui, copied: true } }), 'x')).toContain('>Copied<');
    expect(renderConnect(ready({ config: { ...config, own_agents: { setup: true, verify: false } } }), 'x')).toContain('cannot verify agents at the moment');
    expect(renderConnect(ready({ config: { ...config, own_agents: { setup: false, verify: false } } }), 'x')).toBe('');
  });

  it('is told how to set itself up, with commands that already name the server and the owner', () => {
    const text = agentReady({ origin: 'https://scout.example', owner: account(20), network: 'Stellar Testnet', verifies: true });
    expect(text).toContain('curl -fsSL https://scout.example/agent/stellar-agent-wallet.mjs');
    expect(text).toContain(`init --market https://scout.example --owner ${account(20)}`);
    expect(text).toContain('claude mcp add agent-wallet -- node ~/.stellar-agent-wallet/stellar-agent-wallet.mjs mcp');
    expect(text).toContain('codex mcp add agent-wallet');
    expect(text).toContain('Do not ask them for any key');
    expect(text).not.toContain('opened without an owner');
    expect(text).not.toContain('cannot verify agents');
    const published = agentReady({ origin: 'https://scout.example', owner: account(20), network: 'Stellar Testnet', verifies: true, npmPackage: 'stellar-agent-wallet' });
    expect(published).toContain(`npx -y stellar-agent-wallet init --market https://scout.example --owner ${account(20)}`);
    expect(published).toContain('claude mcp add agent-wallet -- npx -y stellar-agent-wallet mcp');
    expect(published).not.toContain('curl');
    const bare = agentReady({ origin: 'https://scout.example', network: 'Stellar Testnet', verifies: false });
    expect(bare).toContain('opened without an owner');
    expect(bare).toContain('cannot verify agents at the moment');
  });

  it('is named in the wallet\'s record, as the owner is', () => {
    const paid = { kind: 'AccountPayment' as const, policy_hash: bytes(1), authorization: bytes(2),
      action: { kind: 'Transfer' as const, transfer: { asset: asset.contract, recipient: payee['ledger-wire']!, amount: UNIT } } };
    const entry = (sequence: bigint, actor: string, outcome: Parameters<typeof describeOutcome>[0]) => ({
      entry: { schema_version: 1, wallet, sequence, previous_hash: bytes(0), ledger: 10, timestamp: NOW, actor, outcome },
      hash: bytes(1), ledger: 10, transaction: 'ab'.repeat(32), event_id: `${sequence}`,
    });
    const history = {
      status: 'verified' as const, detail: 'ok', head: { sequence: 3n, hash: bytes(1) }, indexer: { status: 'verified', detail: 'ok' },
      entries: [entry(1n, account(20), { kind: 'PolicyCreated', policy_hash: bytes(1) }), entry(2n, account(40), paid), entry(3n, account(5), paid)],
    };
    const html = renderRecord(ready({ own: [mine], history, ui: { ...initialState().ui, record: true } }));
    expect(html).toContain('<td>Claude on my laptop</td>');
    expect(html).toContain('<td>Scout</td>');
    expect(html).toContain('<td>You</td>');
  });
});

describe('what became of a purchase', () => {
  const context = { vendor: 'Deep Archive', code: 'tUSD', allowance: { perPurchase: '5', perDay: '6', total: '20' } };
  const blocked = (error: string | null) => explainStep({ status: 'blocked', error }, context);

  it('names the owner\'s own limit when the wallet says no', () => {
    expect(blocked('PaymentLimitExceeded')).toEqual({
      tone: 'warn', label: 'Blocked by your wallet',
      detail: 'That is more than your limit of 5 tUSD for one purchase. Nothing was sent to the seller.',
    });
    expect(blocked('DailyLimitExceeded').detail).toContain('today\'s limit of 6 tUSD');
    expect(blocked('TotalLimitExceeded').detail).toContain('overall limit of 20 tUSD');
    expect(blocked('RecipientNotAllowed').detail).toContain('Deep Archive is not one of the sellers you approved');
    expect(blocked('Paused').detail).toContain('You froze the wallet');
    expect(blocked('Revoked').detail).toContain('You ended this allowance');
    // Without the allowance at hand the sentence still stands, without the number.
    expect(explainStep({ status: 'blocked', error: 'PaymentLimitExceeded' }, { vendor: 'x', code: 'tUSD' }).detail)
      .toContain('more than your limit for one purchase');
    // Anything without a sentence of its own falls back to the contract's description, never to nothing.
    expect(blocked('RiskTooHigh').detail).toContain('risk score');
    expect(blocked('SomethingNew').detail).toContain('SomethingNew');
    expect(blocked(null).detail).toContain('The network gave no reason');
  });

  it('keeps a seller\'s refusal apart from the wallet\'s, and never calls an open payment refused', () => {
    expect(explainStep({ status: 'declined', error: 'payee_gate_CheckNotPassed' }, context)).toMatchObject({
      tone: 'bad', label: 'Refused by the seller', detail: expect.stringContaining('requires a check that Scout\'s verification does not include'),
    });
    expect(explainStep({ status: 'declined', error: 'payee_gate_unknown_payer' }, context).detail).toContain('does not recognise this wallet');
    expect(explainStep({ status: 'declined', error: 'payee_gate_ResultExpired' }, context).detail).toContain('expired');
    expect(explainStep({ status: 'declined', error: null }, context).detail).toBe('Deep Archive did not accept the payment. Nothing was paid.');
    expect(explainStep({ status: 'paid', error: null }, context)).toMatchObject({ tone: 'good', label: 'Paid' });
    expect(explainStep({ status: 'unsettled', error: null }, context)).toMatchObject({ tone: 'warn', label: 'Not confirmed yet' });
  });

  it('shows a task with what Scout did, what was bought and why the rest was not', () => {
    const step = (overrides: Partial<Step>): Step => ({
      vendor: 'ledger-wire', product: 'wire-brief', title: 'Network brief', amount: '1', payee: payee['ledger-wire']!,
      status: 'paid', error: null, detail: null, tx_hash: 'ab'.repeat(32), content: null, ...overrides,
    });
    const rows = Array.from({ length: 8 }, (_, i) => [String(100 - i), '10:00:00 UTC', 'f'.repeat(64)]);
    const item: Activity = {
      id: 3, at: '2026-11-27T14:02:11.000Z', kind: 'task', title: 'Find the cheapest headlines', stage: 'confirmed', detail: '', hash: null,
      policy: 'aa'.repeat(32),
      result: {
        task: 'cheapest', notes: ['Asked 2 sellers for a price: Bargain Data 0.5 tUSD, Ledger Wire 1 tUSD.', 'Trying the next cheapest.'],
        steps: [
          step({ vendor: 'bargain-data', title: 'Headlines', amount: '0.5', status: 'blocked', error: 'RecipientNotAllowed', tx_hash: null }),
          step({ content: { title: 'Network brief · ledger 100', summary: 'Ledger 100 closed.', facts: [{ label: 'Protocol', value: '29' }],
            table: { columns: ['Ledger', 'Closed at', 'Hash'], rows }, as_of_ledger: 100, source: 'Ledger Wire, from the local Stellar network' } }),
        ],
      },
    };
    const html = renderActivity(ready({ activity: [item] }));
    expect(html).toContain('1 of 2 bought');
    expect(html).toContain('14:02');
    expect(html).toContain('Asked 2 sellers for a price');
    expect(html).toMatch(/data-status="blocked" data-error="RecipientNotAllowed" data-vendor="bargain-data"/);
    expect(html).toContain('Bargain Data is not one of the sellers you approved');
    expect(html).toContain('Network brief · ledger 100');
    expect(html).toContain('<dt>Protocol</dt><dd>29</dd>');
    // A long table is cut until asked for, and a hash is shortened with the whole of it on hover.
    expect(html.match(/<tr><td>/g)).toHaveLength(5);
    expect(html).toContain('Show all 8 rows');
    expect(renderActivity(ready({ activity: [item], ui: { ...initialState().ui, tables: [301] } })).match(/<tr><td>/g)).toHaveLength(8);
    expect(html).not.toContain(`>${'f'.repeat(64)}<`);
    expect(renderActivity(ready())).toContain('Nothing yet');
  });

  it('never shows a submitted or unsettled owner action as done', () => {
    expect(stageVerdict('submitted')).toMatchObject({ tone: 'warn', label: 'Submitted, not confirmed' });
    expect(stageVerdict('unsettled').detail).toContain('Do not repeat it');
    expect(stageVerdict('confirmed').tone).toBe('good');
    const pending: Activity = { id: 1, at: '2026-11-27T10:00:00.000Z', kind: 'owner', title: 'Freeze Scout', stage: 'submitted', detail: '', hash: 'ab'.repeat(32) };
    const html = renderActivity(ready({ activity: [pending] }));
    expect(html).toMatch(/data-stage="submitted"/);
    expect(html).toContain('Submitted, not confirmed');
    expect(html).not.toContain('>Confirmed<');
  });

  it('lists the tasks, and holds them back until there is an allowance to try them under', () => {
    const html = renderTasks(ready());
    for (const task of TASKS) expect(html).toContain(`data-task="${task.id}"`);
    expect(html).not.toContain('disabled');
    expect(renderTasks(ready({ policies: [] }))).toMatch(/data-task="brief" disabled/);
    // After the allowance is ended the tasks stay, so that the wallet's refusal can be seen.
    expect(renderTasks(ready({ policies: [view({}, { revoked: true })] }))).not.toContain('disabled');
    expect(renderTasks(ready({ busy: 'Scout is working: Get today\'s network brief' }))).toContain('data-testid="busy"');
  });
});

describe('the wallet\'s record', () => {
  const entry = (sequence: bigint, outcome: Parameters<typeof describeOutcome>[0]) => ({
    entry: { schema_version: 1, wallet, sequence, previous_hash: bytes(0), ledger: 10, timestamp: NOW, actor: account(5), outcome },
    hash: bytes(1), ledger: 10, transaction: 'ab'.repeat(32), event_id: `${sequence}`,
  });
  const transfer = { asset: asset.contract, recipient: payee['ledger-wire']!, amount: 3n * UNIT };
  const names = { [payee['ledger-wire']!]: 'Ledger Wire' };
  const history = {
    status: 'verified' as const, detail: '2 entries from genesis match the stored head', head: { sequence: 2n, hash: bytes(1) },
    indexer: { status: 'verified', detail: 'ok' },
    entries: [entry(1n, { kind: 'PolicyCreated', policy_hash: bytes(1) }),
      entry(2n, { kind: 'AccountPayment', policy_hash: bytes(1), authorization: bytes(2), action: { kind: 'Transfer', transfer } })],
  };
  const attempts = [
    { id: 1, kind: 'simulation' as const, status: 'blocked', error: 'PaymentLimitExceeded', detail: 'Deep Archive, Recent ledgers dataset, 8 tUSD. Too much.', tx_hash: null, recorded_at: '2026-11-25T15:00:00.000Z' },
    { id: 2, kind: 'simulation' as const, status: 'declined', error: 'payee_gate_CheckNotPassed', detail: 'Audited Sources, Audited fee report, 2 tUSD. Refused.', tx_hash: null, recorded_at: '2026-11-25T15:01:00.000Z' },
  ];
  const open = { ...initialState().ui, record: true };

  it('describes each kind of entry, calling sellers by name', () => {
    expect(describeOutcome({ kind: 'AccountPayment', policy_hash: bytes(1), authorization: bytes(2), action: { kind: 'Transfer', transfer } }, asset, names))
      .toMatchObject({ title: 'Purchase', detail: '3 tUSD to Ledger Wire' });
    expect(describeOutcome({ kind: 'Executed', policy_hash: bytes(1), action_hash: bytes(2), action: { kind: 'Transfer', transfer } }, asset))
      .toMatchObject({ title: 'Agent payment', detail: expect.stringMatching(/^3 tUSD to G/) });
    expect(describeOutcome({ kind: 'PauseChanged', paused: true }, asset).title).toBe('Wallet frozen');
    expect(describeOutcome({ kind: 'PauseChanged', paused: false }, asset).title).toBe('Wallet unfrozen');
    expect(describeOutcome({ kind: 'PolicyCreated', policy_hash: bytes(1) }, asset).title).toBe('Allowance approved');
    expect(describeOutcome({ kind: 'PolicyRevoked', policy_hash: bytes(1) }, asset).title).toBe('Allowance ended');
    expect(describeOutcome({ kind: 'OwnerWithdrawal', transfer: { ...transfer, asset: contract(50) } }, asset).detail).toContain('units of');
  });

  it('says whether the list is the whole record, and keeps refusals apart', () => {
    const closed = renderRecord(ready({ history, attempts }));
    expect(closed).toMatch(/data-testid="history-status">Verified against the wallet</);
    expect(closed).toContain('Show the record (2 on the ledger, 2 refused)');
    expect(closed).not.toContain('data-testid="entries"');
    const html = renderRecord(ready({ history, attempts, ui: open }));
    expect(html.indexOf('Purchase')).toBeLessThan(html.indexOf('Allowance approved'));
    expect(html).toContain('3 tUSD to Ledger Wire');
    expect(html).toContain('These are not on the ledger');
    expect(html).toMatch(/data-error="payee_gate_CheckNotPassed" data-status="declined"[\s\S]*Refused by the seller[\s\S]*Audited Sources, Audited fee report, 2 tUSD/);
    expect(html).toContain('PaymentLimitExceeded:');
    expect(html).not.toContain('Do not treat this list');

    const partial = renderRecord(ready({ history: { ...history, status: 'incomplete', detail: 'Entries after 2 are not yet visible' } }));
    expect(partial).toMatch(/data-testid="history-status">Incomplete</);
    expect(partial).toContain('Do not treat this list as the whole record');
    // For a few seconds after an action the record trails the wallet. That is said plainly, without the warning.
    const trailing = renderRecord(ready({ catchingUp: true, history: { ...history, status: 'incomplete', detail: 'Entries after 2 are not yet visible' } }));
    expect(trailing).toMatch(/data-testid="history-status">Catching up</);
    expect(trailing).not.toContain('Do not treat this list');
    expect(renderRecord(ready({ history: { ...history, status: 'mismatch', detail: 'Entry 2 does not hash' } })))
      .toMatch(/history-status">Does not match the wallet</);
    expect(renderRecord(ready({ historyError: 'offline' }))).toContain('The record could not be read: offline');
  });

  it('explains a recorded refusal in the contract\'s terms', () => {
    expect(explainRefusal('PaymentLimitExceeded')).toMatch(/^PaymentLimitExceeded: The amount is above/);
    expect(explainRefusal('payee_gate_CheckNotPassed')).toContain('The seller\'s own check refused the agent. CheckNotPassed:');
    expect(explainRefusal('payee_gate_unknown_payer')).toContain('unknown payer');
    expect(explainRefusal(null)).toBe('No reason was given.');
    expect(explainRefusal('SomethingNew')).toBe('SomethingNew');
  });

  it('links to an explorer only where there is one', () => {
    const hash = 'ab'.repeat(32);
    expect(tx(hash, null, 'View the transaction')).not.toContain('<a ');
    expect(tx(hash, null, 'View the transaction')).not.toContain('View the transaction');
    expect(tx(hash, testnet.explorer, 'View the transaction')).toContain(`href="https://explorer.example/testnet/tx/${hash}"`);
    expect(addr(wallet, testnet.explorer)).toContain(`/contract/${wallet}`);
    expect(addr(account(9), testnet.explorer)).toContain(`/account/${account(9)}`);
    expect(renderRecord(ready({ config: testnet, history, ui: open }))).toContain('target="_blank" rel="noreferrer"');
  });

  it('shows the addresses and the exact rules to anyone who asks', () => {
    expect(renderDetails(ready())).not.toContain('Agent registry');
    const html = renderDetails(ready({ ui: { ...initialState().ui, details: true } }));
    expect(html).toContain('Agent registry');
    expect(html).toContain('Ledger Wire is paid at');
    expect(html).toMatch(/data-testid="policy" data-status="active"/);
    expect(html).toContain('may pay up to 5 tUSD at a time and 6 tUSD per UTC day, and 20 tUSD in total');
  });
});

describe('the guest', () => {
  const store = () => {
    const values = new Map<string, string>();
    return {
      values, getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); },
    };
  };

  it('is the same guest on return, a different one per network, and gone when forgotten', () => {
    const storage = store();
    const first = connectGuest('Test SDF Network ; September 2015', storage);
    expect(first).toMatchObject({ kind: 'guest', label: 'Guest', address: expect.stringMatching(/^G[A-Z2-7]{55}$/) });
    expect(connectGuest('Test SDF Network ; September 2015', storage).address).toBe(first.address);
    expect(connectGuest('Standalone Network ; February 2017', storage).address).not.toBe(first.address);
    forgetGuest('Test SDF Network ; September 2015', storage);
    expect(connectGuest('Test SDF Network ; September 2015', storage).address).not.toBe(first.address);
  });

  it('survives a store that holds rubbish or cannot be written', () => {
    const storage = store();
    storage.values.set('scout-demo:guest:x', 'not a key');
    expect(connectGuest('x', storage).address).toMatch(/^G/);
    const sealed = { getItem: () => null, setItem: () => { throw new Error('denied'); } };
    expect(connectGuest('x', sealed).address).toMatch(/^G/);
  });

  it('refuses a wallet on another network', () => {
    expect(networkProblem('Test SDF Network ; September 2015', 'Test SDF Network ; September 2015')).toBeNull();
    expect(networkProblem('Test SDF Network ; September 2015', 'Public Global Stellar Network ; September 2015')).toContain('Switch it to');
    expect(networkProblem('x', undefined)).toContain('did not say');
  });
});

describe('what the sellers sell', () => {
  const sample = (i: number) => ({ sequence: 801 + i, closeTime: 1_800_000_000 + i * 5 + (i >= 150 ? 4 : 0), hash: `${i}`.padStart(64, '0') });
  const watched = (from = 0, to = 200) => {
    const watch = new LedgerWatch();
    for (let i = from; i < to; i++) watch.record(sample(i));
    return watch;
  };
  const source = (overrides: Partial<ContentSource> = {}): ContentSource => ({
    _getLatestLedger: async () => ({ id: 'f'.repeat(64), sequence: 1_000, closeTime: '1800001000', protocolVersion: '30' }) as never,
    getFeeStats: async () => ({
      sorobanInclusionFee: { p50: '100', p99: '2500', transactionCount: '1234', ledgerCount: 50 },
      inclusionFee: { p50: '100', p99: '200', transactionCount: '10', ledgerCount: 50 }, latestLedger: 1_000,
    }) as never,
    ...overrides,
  });
  const product = (id: string) => PRODUCTS.find((item) => item.id === id)!;

  it('is read from the network when it is bought', async () => {
    const brief = await produce(product('wire-brief'), source(), 'Stellar Testnet', watched());
    expect(brief).toMatchObject({ title: 'Network brief · ledger 1,000', as_of_ledger: 1_000, source: 'Ledger Wire, from the Stellar Testnet network' });
    expect(brief.summary).toContain('1,234 contract transactions paid a median inclusion fee of 100 stroops');
    expect(brief.facts).toContainEqual({ label: 'Contract fee, 99th percentile', value: '2,500 stroops' });
    const watch = watched();
    watch.window = { oldest: 1, oldestCloseTime: 1_799_994_995, latest: 1_000, latestCloseTime: 1_800_001_000 };
    const digest = await produce(product('wire-digest'), source(), 'Stellar Testnet', watch);
    // Two hundred ledgers in a row give 199 intervals; one of them was slow.
    expect(digest.title).toBe('Close-time digest · 199 ledgers');
    expect(digest.facts).toContainEqual({ label: 'Slowest', value: '9 s' });
    expect(digest.facts).toContainEqual({ label: 'Average over the last 999 ledgers', value: '6.01 s' });
    const dataset = await produce(product('archive-ledgers'), source(), 'Stellar Testnet', watched());
    expect(dataset.table).toMatchObject({ columns: ['Ledger', 'Closed at', 'Hash'] });
    expect(dataset.table!.rows).toHaveLength(40);
    expect(dataset.table!.rows[0]).toEqual(['1000', '08:16:40 UTC', 'f'.repeat(64)]);
    expect((await produce(product('bargain-headlines'), source(), 'x', watched())).facts).toHaveLength(2);
  });

  it('still has something to sell when the network can tell it less', async () => {
    const quiet = await produce(product('wire-brief'), source({ getFeeStats: async () => { throw new Error('unsupported'); } }), 'x', watched());
    expect(quiet.summary).toContain('too light to report');
    expect(quiet.facts).toHaveLength(3);
    const young = await produce(product('wire-digest'), source(), 'x', new LedgerWatch());
    expect(young.summary).toContain('too few ledgers have been watched');
    expect((await produce(product('archive-ledgers'), source(), 'x', new LedgerWatch())).table!.rows).toHaveLength(1);
  });

  it('watches ledgers a few numbers at a time, and never asks an RPC for many at once', async () => {
    const asked: { startLedger: number; limit: number | undefined }[] = [];
    const ledgers: LedgerSource = {
      _getLatestLedger: source()._getLatestLedger,
      _getLedgers: async ({ startLedger, pagination }: { startLedger: number; pagination?: { limit?: number } }) => {
        asked.push({ startLedger, limit: pagination?.limit });
        if (startLedger < 990) throw new Error('startLedger must be within the ledger range');
        return {
          ledgers: [{ sequence: startLedger, ledgerCloseTime: String(1_800_000_000 + startLedger), hash: 'a'.repeat(64) }],
          oldestLedger: 990, oldestLedgerCloseTime: 1_800_000_990, latestLedger: 1_000, latestLedgerCloseTime: 1_800_001_000,
        } as never;
      },
    };
    const watch = new LedgerWatch();
    await backfill(ledgers, watch, 40);
    // One ledger per request, newest first, and it stops at the first one the RPC no longer keeps.
    expect(asked.every(({ limit }) => limit === 1)).toBe(true);
    expect(asked.map(({ startLedger }) => startLedger)).toEqual([999, 998, 997, 996, 995, 994, 993, 992, 991, 990, 989]);
    expect(watch.recent(100).map((ledger) => ledger.sequence)).toEqual([990, 991, 992, 993, 994, 995, 996, 997, 998, 999, 1_000]);
    expect(watch.window).toMatchObject({ oldest: 990, latest: 1_000 });
    // Memory is bounded: the oldest ledgers are forgotten.
    const small = new LedgerWatch(3);
    for (let i = 0; i < 10; i++) small.record(sample(i));
    expect(small.recent(10).map((ledger) => ledger.sequence)).toEqual([808, 809, 810]);
    expect((await observe(ledgers, small)).protocol).toBe('30');
  });

  it('prices every product and gives every seller an account of its own', () => {
    expect(PRODUCTS.every((item) => Number(item.price) > 0 && item.path.startsWith(`/x402/${item.vendor}/`))).toBe(true);
    expect(new Set(PRODUCTS.map((item) => item.path)).size).toBe(PRODUCTS.length);
    expect(VENDORS.map((vendor) => vendor.id)).toEqual([...VENDOR_IDS]);
    expect(VENDORS.filter((vendor) => vendor.suggested).map((vendor) => vendor.id)).toEqual(['ledger-wire', 'deep-archive', 'audited-sources']);
  });
});

describe('rate limits', () => {
  it('counts per client in a window, and starts again when the window has passed', () => {
    let now = 0;
    const allow = rateLimiter(2, 1_000, () => now);
    expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
    now = 999;
    expect(allow('a')).toBe(false);
    now = 1_000;
    expect(allow('a')).toBe(true);
  });
});

describe('formatting and storage', () => {
  it('escapes everything it renders', () => {
    expect(esc('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
    expect(addr('G<b>')).toContain('&lt;b&gt;');
    const hostile: Activity = { id: 1, at: '2026-11-27T10:00:00.000Z', kind: 'owner', title: '<script>alert(1)</script>', stage: 'error', detail: '<img onerror=x>', hash: null };
    const html = renderActivity(ready({ activity: [hostile] }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });

  it('formats addresses, spans, times and amounts', () => {
    expect(short(account(9))).toMatch(/^G.{3}….{4}$/);
    expect(duration(30)).toBe('30 seconds');
    expect(duration(60 * 60 * 3)).toBe('3 hours');
    expect(duration(7n * 86_400n - 20n)).toBe('7 days');
    expect(duration(86_400n * 2n)).toBe('2 days');
    expect(utc(1_800_000_000n)).toBe('2027-01-15 08:00 UTC');
    expect(clock('2026-11-27T14:02:11.000Z')).toBe('14:02');
    expect([money('97.0000000'), money('0.5000000'), money('12.25'), money('8')]).toEqual(['97', '0.5', '12.25', '8']);
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
      network: 'testnet', rpc_url: 'https://rpc.example', passphrase: 'x', epoch: 'demo-1', start_ledger: 5,
      agent_registry: contract(1), verification_registry: contract(2), asset, wallet_wasm_hash: 'ab'.repeat(32),
      wallet_salt: 'cd'.repeat(32), agent: config.agent, provider: config.provider, vendors: payee,
      roles: { funder: account(13), facilitator: account(14) }, created_at: 'now',
    };
    // A record kept in a repository names no key directory; one written by the setup on this machine does.
    expect(() => assertDeployment(record)).not.toThrow();
    expect(() => assertDeployment({ ...record, key_directory: '/tmp/keys' })).not.toThrow();
    expect(() => assertDeployment({ ...record, agent_registry: 'C-not-an-address' })).toThrow('malformed');
    expect(() => assertDeployment({ ...record, wallet_salt: 'short' })).toThrow('malformed');
    expect(() => assertDeployment({ ...record, roles: { ...record.roles, funder: undefined } })).toThrow('malformed');
    expect(() => assertDeployment({ ...record, vendors: { ...payee, 'bargain-data': undefined } })).toThrow('malformed');
    // Two sellers paid at one account could not be told apart by a policy.
    expect(() => assertDeployment({ ...record, vendors: { ...payee, 'bargain-data': payee['ledger-wire'] } })).toThrow('malformed');
    expect(() => assertDeployment(null)).toThrow('malformed');
  });
});
