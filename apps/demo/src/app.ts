import { toContractUnits, type Signer } from '@stellar-agent-auth/sdk';
import { demoServer, indexerUrl, readAttempts, type Config } from './backend.js';
import { StorageJournal, createChain, type AllowanceDraft, type Chain, type OwnerOutcome } from './chain.js';
import { fromHex, toHex } from './format.js';
import type { Stage } from './model.js';
import { ConnectCancelled, connectFreighter, connectGuest, connectWithKit, type Owner } from './owner.js';
import { currentAllowance, initialState, phaseOf, taskAllowance, type Activity, type State } from './state.js';
import { renderScout, renderSellers } from './views/market.js';
import { renderDetails, renderRecord } from './views/record.js';
import { renderAllowance, renderAllowanceForm, renderWallet, renderWithdraw } from './views/wallet.js';
import { renderAccount, renderFooter, renderNetwork, renderNotice, renderSetup, renderWelcome } from './views/welcome.js';
import { renderActivity, renderTasks } from './views/work.js';

/**
 * The page: one state object, a few actions that change it, and sections that are redrawn when their HTML changes.
 *
 * Two rules keep it honest. An owner action is shown at the stage it has really reached, so "submitted" is never
 * shown as done. And everything about the wallet is read back from the network after each action, not assumed from
 * the action's result.
 */

const REFRESH_MS = 5_000;
/** The agent's identity and verification change rarely; they are read on every sixth refresh. */
const AGENT_EVERY = 6;
const KEEP_ACTIVITY = 30;
const LAST_KEY = 'scout-demo:last';

export function startApp(root: Document, storage: Storage = localStorage) {
  const state: State = initialState();
  let chain: Chain | undefined;
  let signer: Signer | undefined;
  let disconnectWallet: (() => Promise<void>) | undefined;
  let nextId = 1;
  let refreshing = false;
  let refreshAgain = false;
  let refreshes = 0;
  const drawn = new Map<string, string>();

  const sections: Record<string, (current: State) => string> = {
    network: renderNetwork, account: renderAccount, notice: renderNotice, welcome: renderWelcome, setup: renderSetup,
    wallet: renderWallet, allowance: renderAllowance, sellers: renderSellers, scout: renderScout, tasks: renderTasks,
    activity: renderActivity, record: renderRecord, details: renderDetails, footer: renderFooter,
  };

  function render() {
    for (const [id, draw] of Object.entries(sections)) {
      const html = draw(state);
      if (drawn.get(id) === html) continue;
      drawn.set(id, html);
      root.getElementById(id)!.innerHTML = html;
    }
    // Forms are drawn once per situation, so a refresh never clears what the owner is typing.
    const ready = phaseOf(state) === 'ready' && state.wallet !== null;
    const forms: Record<string, [string, () => string]> = {
      'allowance-form': [ready && !currentAllowance(state) ? `${state.session!.wallet}:${state.policies.length}` : '', () => renderAllowanceForm(state)],
      withdraw: [ready && state.ui.withdraw ? state.session!.wallet : '', () => renderWithdraw(state)],
    };
    for (const [id, [key, draw]] of Object.entries(forms)) {
      if (drawn.get(id) === key) continue;
      drawn.set(id, key);
      root.getElementById(id)!.innerHTML = key ? draw() : '';
    }
    root.body.dataset['busy'] = state.busy ? 'true' : 'false';
    root.body.dataset['phase'] = phaseOf(state);
  }

  // ---- What was done, kept in this browser per wallet ----

  const activityKey = () => (state.session ? `scout-demo:activity:${state.session.wallet}` : undefined);

  function saveActivity() {
    const key = activityKey();
    if (!key) return;
    try {
      storage.setItem(key, JSON.stringify(state.activity));
    } catch {
      // A full or unavailable store loses the list on reload and nothing else.
    }
  }

  function loadActivity() {
    const key = activityKey();
    if (!key) return;
    try {
      const stored: unknown = JSON.parse(storage.getItem(key) ?? '[]');
      if (!Array.isArray(stored)) return;
      const earlier = (stored as Activity[]).filter((item) => typeof item?.id === 'number' && typeof item.title === 'string')
        // Whatever was in flight when the page closed is no longer being watched from here.
        .map((item) => (item.stage === 'preparing' || item.stage === 'signing' ? { ...item, stage: 'error' as Stage, detail: 'The page was closed before this was sent.' } : item));
      const known = new Set(state.activity.map((item) => item.id));
      state.activity = [...state.activity, ...earlier.filter((item) => !known.has(item.id))].slice(0, KEEP_ACTIVITY);
      nextId = Math.max(nextId, ...state.activity.map((item) => item.id + 1));
    } catch {
      // Unreadable history is no history.
    }
  }

  function track(kind: Activity['kind'], title: string): Activity {
    const item: Activity = { id: nextId++, at: new Date().toISOString(), kind, title, stage: 'preparing', detail: '', hash: null };
    state.activity = [item, ...state.activity].slice(0, KEEP_ACTIVITY);
    return item;
  }

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  /** Run one action at a time, showing what is in progress, and read everything back afterwards. */
  async function exclusive(label: string, work: () => Promise<void>) {
    if (state.busy) return;
    state.busy = label;
    render();
    try {
      await work();
    } finally {
      state.busy = null;
      saveActivity();
      render();
      await refresh();
    }
  }

  /** One owner transaction inside an action that is already running, with its stages shown as they are reached. */
  async function ownerStep(title: string, run: (onStage: (stage: Stage, hash?: string) => void) => Promise<OwnerOutcome>) {
    const item = track('owner', title);
    const outcome = await run((stage, hash) => {
      item.stage = stage;
      if (hash) item.hash = hash;
      render();
    });
    item.stage = outcome.stage;
    item.detail = outcome.stage === 'confirmed' ? '' : outcome.detail;
    item.hash = outcome.hash ?? item.hash;
    return outcome;
  }

  const ownerAction = (title: string, run: Parameters<typeof ownerStep>[1]) =>
    exclusive(title, async () => { await ownerStep(title, run); });

  async function refresh() {
    if (!chain || !state.config) return;
    if (refreshing) {
      // Something changed while a read was under way; read once more when it finishes.
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      state.now = await chain.ledgerTime();
      if (state.owner) {
        const { address } = state.owner;
        if (!state.agent || refreshes % AGENT_EVERY === 0) state.agent = await chain.readAgentView();
        refreshes += 1;
        if (!state.accountFunded) state.accountFunded = await chain.accountExists(address);
        // The server derives the wallet address and says whether the wallet exists yet.
        if (!state.session?.deployed) {
          state.session = await demoServer.session(address);
          if (state.session.deployed) loadActivity();
        }
        const { session } = state;
        if (session.deployed) {
          state.wallet = await chain.readWalletView(session.wallet);
          try {
            const indexer = indexerUrl(state.config);
            state.history = await chain.history(session.wallet, indexer);
            state.attempts = await readAttempts(indexer, session.wallet);
            state.historyError = null;
          } catch (error) {
            state.historyError = message(error);
          }
          // Ended allowances are no longer listed by the wallet; the record names every one it ever had.
          const known = (state.history?.entries ?? []).flatMap(({ entry }) =>
            (entry.outcome.kind === 'PolicyCreated' ? [toHex(entry.outcome.policy_hash)] : []));
          state.policies = await chain.readPolicies(session.wallet, [...known, ...state.policies.map((policy) => policy.hash)]);
          state.exposure = chain.exposure(state.policies, state.now);
        }
      }
      state.readError = null;
    } catch (error) {
      state.readError = message(error);
    } finally {
      refreshing = false;
      render();
    }
    if (refreshAgain) {
      refreshAgain = false;
      await refresh();
    }
  }

  function reset() {
    signer = undefined;
    disconnectWallet = undefined;
    Object.assign(state, {
      owner: null, session: null, accountFunded: null, wallet: null, policies: [], exposure: [], history: null,
      historyError: null, attempts: [], activity: [], agent: null, connectError: null,
    });
    state.ui = { record: false, details: false, withdraw: false, form: false, tables: [] };
  }

  async function connect(make: (config: Config) => Promise<Owner> | Owner) {
    if (!state.config || state.busy) return;
    state.connectError = null;
    try {
      const owner = await make(state.config);
      reset();
      signer = owner.signer;
      disconnectWallet = owner.disconnect;
      state.owner = { kind: owner.kind, label: owner.label, address: owner.address };
      // A guest comes back as the same guest after a reload; a wallet is asked again, since that takes its consent.
      try {
        if (owner.kind === 'guest') storage.setItem(LAST_KEY, 'guest');
        else storage.removeItem(LAST_KEY);
      } catch {
        // Not remembered, then.
      }
    } catch (error) {
      if (!(error instanceof ConnectCancelled)) state.connectError = message(error);
    }
    render();
    await refresh();
  }

  /** Friendbot, the wallet, and the first test dollars, one after the other. It stops at the first step that fails. */
  const setup = () => exclusive('Setting up your wallet', async () => {
    const { address } = state.owner!;
    if (!(await chain!.accountExists(address))) {
      state.busy = 'Asking Friendbot for test XLM';
      render();
      const item = track('owner', 'Get test XLM for fees');
      try {
        await chain!.requestTestXlm(address);
        item.stage = 'confirmed';
      } catch (error) {
        item.stage = 'error';
        item.detail = `Friendbot did not answer: ${message(error)}. Try again in a moment.`;
        return;
      }
    }
    state.accountFunded = true;
    state.busy = 'Creating your wallet';
    render();
    state.session = await demoServer.session(address);
    if (!state.session.deployed) {
      const created = await ownerStep('Create your wallet', (onStage) => chain!.createWallet(signer!, onStage));
      if (created.stage !== 'confirmed') return;
      state.session = await demoServer.session(address);
      if (!state.session.deployed) return;
    }
    state.busy = 'Adding test dollars';
    render();
    await faucet();
  });

  async function faucet() {
    const { asset, faucet_amount: amount } = state.config!;
    const item = track('faucet', `Add ${amount} ${asset.code}`);
    try {
      const funded = await demoServer.fund(state.owner!.address);
      item.stage = funded.status === 'success' ? 'confirmed' : 'unsettled';
      item.hash = funded.tx_hash;
      item.detail = funded.status === 'success' ? 'Sent by the demo\'s faucet, not by you.' : `The transaction is ${funded.status}.`;
    } catch (error) {
      item.stage = 'error';
      item.detail = message(error);
    }
  }

  const number = (form: FormData, name: string) => Number(form.get(name));
  const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
  const walletId = () => state.session!.wallet;

  const actions: Record<string, (target: HTMLElement) => Promise<void>> = {
    'connect-guest': () => connect((config) => connectGuest(config.passphrase, storage)),
    'connect-freighter': () => connect((config) => connectFreighter(config.passphrase)),
    'connect-kit': () => connect((config) => connectWithKit(config.passphrase)),
    disconnect: async () => {
      await disconnectWallet?.();
      try {
        storage.removeItem(LAST_KEY);
      } catch {
        // Nothing to forget.
      }
      reset();
      render();
    },
    setup,
    fund: () => exclusive('The faucet is adding test dollars', faucet),
    freeze: () => ownerAction('Freeze Scout', (onStage) => chain!.ownerCall(signer!, walletId(), 'pause', {}, onStage)),
    unfreeze: () => ownerAction('Unfreeze Scout', (onStage) => chain!.ownerCall(signer!, walletId(), 'resume', {}, onStage)),
    end: (target) => ownerAction('End Scout\'s allowance', (onStage) =>
      chain!.ownerCall(signer!, walletId(), 'revoke_policy', { policy_hash: fromHex(target.dataset['policy']!) }, onStage)),
    task: (target) => {
      const task = state.config!.tasks.find(({ id }) => id === target.dataset['task']);
      const allowance = taskAllowance(state);
      if (!task || !allowance) return Promise.resolve();
      return exclusive(`Scout is working: ${task.label}`, async () => {
        const item = track('task', task.label);
        item.policy = allowance.hash;
        try {
          const result = await demoServer.task(state.owner!.address, task.id, allowance.hash);
          item.result = result;
          const paid = result.steps.some((step) => step.status === 'paid');
          const open = result.steps.some((step) => step.status === 'unsettled');
          item.stage = open ? 'unsettled' : paid ? 'confirmed' : 'refused';
        } catch (error) {
          item.stage = 'error';
          item.detail = message(error);
        }
      });
    },
    toggle: async (target) => {
      const what = target.dataset['what'] as 'record' | 'details' | 'withdraw' | 'form';
      state.ui[what] = !state.ui[what];
      render();
    },
    'toggle-table': async (target) => {
      const id = Number(target.dataset['id']);
      state.ui.tables = state.ui.tables.includes(id) ? state.ui.tables.filter((open) => open !== id) : [...state.ui.tables, id];
      render();
    },
  };
  /** Things that only change what is shown; they are allowed while something else is running. */
  const passive = new Set(['toggle', 'toggle-table']);

  const forms: Record<string, (form: FormData) => Promise<void>> = {
    allowance: (form) => ownerAction('Approve Scout\'s allowance', async (onStage) => {
      const draft: AllowanceDraft = {
        perPurchase: text(form, 'perPurchase'), perDay: text(form, 'perDay'), total: text(form, 'total'),
        days: number(form, 'days'), vendors: form.getAll('vendor').map(String),
        maxRisk: number(form, 'maxRisk'), maxAgeDays: number(form, 'maxAgeDays'),
      };
      try {
        const policy = await chain!.draftAllowance(draft);
        return await chain!.ownerCall(signer!, walletId(), 'approve_policy', { policy }, onStage);
      } catch (error) {
        // A value the form let through and the SDK did not: nothing was signed.
        return { stage: 'error', hash: null, detail: message(error) };
      }
    }),
    withdraw: (form) => ownerAction('Withdraw', async (onStage) => {
      try {
        const amount = toContractUnits(text(form, 'amount'), state.config!.asset.decimals);
        return await chain!.ownerCall(signer!, walletId(), 'withdraw',
          { asset: state.config!.asset.contract, recipient: text(form, 'recipient'), amount }, onStage);
      } catch (error) {
        return { stage: 'error', hash: null, detail: message(error) };
      }
    }),
  };

  root.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    const name = target?.dataset['action'] ?? '';
    const action = actions[name];
    if (target && action && (!state.busy || passive.has(name))) void action(target);
  });
  root.addEventListener('submit', (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('form[data-form]');
    const handler = form && forms[form.dataset['form'] ?? ''];
    if (!form || !handler) return;
    event.preventDefault();
    if (!state.busy) void handler(new FormData(form));
  });

  async function boot() {
    render();
    try {
      state.config = await demoServer.config();
      chain = createChain(state.config, new StorageJournal(storage, `scout-demo:journal:${state.config.passphrase}`));
    } catch (error) {
      state.fatal = `The demo server could not be reached: ${message(error)}. Reload in a moment.`;
    }
    render();
    let last: string | null = null;
    try {
      last = storage.getItem(LAST_KEY);
    } catch {
      // Storage is unavailable: start at the welcome page.
    }
    if (state.config && last === 'guest') await connect((config) => connectGuest(config.passphrase, storage));
    else await refresh();
    // Nothing is read for a page nobody is looking at.
    setInterval(() => { if (!state.busy && !root.hidden) void refresh(); }, REFRESH_MS);
    root.addEventListener('visibilitychange', () => { if (!root.hidden && !state.busy) void refresh(); });
  }

  return { boot, state };
}
