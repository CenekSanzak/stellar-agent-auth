import { toContractUnits, type Signer } from '@stellar-agent-auth/sdk';
import { demoServer, readAttempts, type Config } from './backend.js';
import { StorageJournal, createChain, type Chain, type OwnerOutcome, type PolicyDraft } from './chain.js';
import { fromHex, toHex } from './format.js';
import type { Stage } from './model.js';
import { connectFreighter, connectLocalKey, type Owner } from './owner.js';
import { initialState, type Activity, type State } from './state.js';
import { renderAgent } from './views/agents.js';
import { renderActivity, renderConnection, renderHistory, renderNotice } from './views/history.js';
import { renderPolicies, renderPolicyForm } from './views/policies.js';
import { renderWallet } from './views/wallet.js';

/**
 * The page: one state object, a few actions that change it, and sections that are redrawn when their HTML changes.
 *
 * Two rules keep it honest. An owner action is shown at the stage it has really reached, so "submitted" is never
 * shown as done. And everything about the wallet is read back from the network after each action, not assumed from
 * the action's result.
 */

const REFRESH_MS = 4_000;
const KEEP_ACTIVITY = 12;

export function startApp(root: Document) {
  const state: State = initialState();
  let chain: Chain | undefined;
  let signer: Signer | undefined;
  let nextId = 1;
  let refreshing = false;
  let refreshAgain = false;
  const drawn = new Map<string, string>();

  const sections: Record<string, (current: State) => string> = {
    connection: renderConnection, notice: renderNotice, agent: renderAgent, wallet: renderWallet,
    policies: renderPolicies, history: renderHistory, activity: renderActivity,
  };

  function render() {
    for (const [id, draw] of Object.entries(sections)) {
      const html = draw(state);
      if (drawn.get(id) === html) continue;
      drawn.set(id, html);
      root.getElementById(id)!.innerHTML = html;
    }
    // The policy form is drawn once per wallet, so a refresh never clears what the owner is typing.
    const formKey = state.session?.deployed ? state.session.wallet : '';
    if (drawn.get('policy-form') !== formKey) {
      drawn.set('policy-form', formKey);
      root.getElementById('policy-form')!.innerHTML = renderPolicyForm(state);
    }
    root.body.dataset['busy'] = state.busy ? 'true' : 'false';
  }

  function track(title: string): Activity {
    const item: Activity = { id: nextId++, title, stage: 'preparing', detail: '', hash: null };
    state.activity = [item, ...state.activity].slice(0, KEEP_ACTIVITY);
    return item;
  }

  /** Run one action at a time, showing what is in progress, and read everything back afterwards. */
  async function exclusive(label: string, work: () => Promise<void>) {
    if (state.busy) return;
    state.busy = label;
    render();
    try {
      await work();
    } finally {
      state.busy = null;
      render();
      await refresh();
    }
  }

  /** An owner transaction, with its stages shown as they are reached. */
  async function ownerAction(title: string, run: (onStage: (stage: Stage, hash?: string) => void) => Promise<OwnerOutcome>) {
    await exclusive(title, async () => {
      const item = track(title);
      const outcome = await run((stage, hash) => {
        item.stage = stage;
        if (hash) item.hash = hash;
        render();
      });
      item.stage = outcome.stage;
      item.detail = outcome.detail;
      item.hash = outcome.hash ?? item.hash;
    });
  }

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
      state.agent = await chain.readAgentView();
      if (state.owner) {
        const { address } = state.owner;
        state.accountFunded = await chain.accountExists(address);
        // The server derives the wallet address and starts following the wallet once it exists.
        if (!state.session?.deployed) state.session = await demoServer.session(address);
        const { session } = state;
        if (session.deployed) {
          state.wallet = await chain.readWalletView(session.wallet);
          if (session.indexer_url) {
            try {
              state.history = await chain.history(session.wallet, session.indexer_url);
              state.attempts = await readAttempts(session.indexer_url, session.wallet);
              state.historyError = null;
            } catch (error) {
              state.historyError = error instanceof Error ? error.message : String(error);
            }
          }
          // Revoked policies are no longer listed by the wallet; the history names every policy it ever had.
          const known = (state.history?.entries ?? []).flatMap(({ entry }) =>
            (entry.outcome.kind === 'PolicyCreated' ? [toHex(entry.outcome.policy_hash)] : []));
          state.policies = await chain.readPolicies(session.wallet, [...known, ...state.policies.map((policy) => policy.hash)]);
          state.exposure = chain.exposure(state.policies, state.now);
        }
      }
      state.readError = null;
    } catch (error) {
      state.readError = error instanceof Error ? error.message : String(error);
    } finally {
      refreshing = false;
      render();
    }
    if (refreshAgain) {
      refreshAgain = false;
      await refresh();
    }
  }

  /**
   * Make sure the server is following this owner's wallet before asking the agent or the faucet for anything. The
   * server keeps one session; it may have restarted, or another owner may have connected since.
   */
  async function ensureSession() {
    state.session = await demoServer.session(state.owner!.address);
  }

  async function connect(make: (config: Config) => Promise<Owner> | Owner) {
    if (!state.config || state.busy) return;
    state.connectError = null;
    try {
      const owner = await make(state.config);
      signer = owner.signer;
      state.owner = { kind: owner.kind, address: owner.address };
      state.session = null;
    } catch (error) {
      state.connectError = error instanceof Error ? error.message : String(error);
    }
    render();
    await refresh();
  }

  const number = (form: FormData, name: string) => Number(form.get(name));
  const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

  const actions: Record<string, (target: HTMLElement) => Promise<void>> = {
    'connect-freighter': () => connect((config) => connectFreighter(config.passphrase)),
    'connect-local': () => connect((config) => connectLocalKey(config.network)),
    'test-xlm': () => exclusive('Asking Friendbot for test XLM', async () => {
      const item = track('Get test XLM');
      try {
        await chain!.requestTestXlm(state.owner!.address);
        item.stage = 'confirmed';
        item.detail = 'The account is funded.';
      } catch (error) {
        item.stage = 'error';
        item.detail = error instanceof Error ? error.message : String(error);
      }
    }),
    'create-wallet': () => ownerAction('Create wallet', (onStage) => chain!.createWallet(signer!, onStage)),
    fund: () => exclusive('The faucet is funding the wallet', async () => {
      const item = track(`Add ${state.config!.faucet_amount} ${state.config!.asset.code} from the faucet`);
      try {
        await ensureSession();
        const funded = await demoServer.fund();
        item.stage = funded.status === 'success' ? 'confirmed' : 'unsettled';
        item.hash = funded.tx_hash;
        item.detail = funded.status === 'success' ? 'Signed by the funder, not by you.' : `The transaction is ${funded.status}.`;
      } catch (error) {
        item.stage = 'error';
        item.detail = error instanceof Error ? error.message : String(error);
      }
    }),
    pause: () => ownerAction('Pause the wallet', (onStage) =>
      chain!.ownerCall(signer!, state.session!.wallet, 'pause', {}, onStage)),
    resume: () => ownerAction('Resume the wallet', (onStage) =>
      chain!.ownerCall(signer!, state.session!.wallet, 'resume', {}, onStage)),
    revoke: (target) => ownerAction('Revoke the policy', (onStage) =>
      chain!.ownerCall(signer!, state.session!.wallet, 'revoke_policy', { policy_hash: fromHex(target.dataset['policy']!) }, onStage)),
    scenario: (target) => {
      const scenario = state.config!.scenarios.find(({ id }) => id === target.dataset['scenario']);
      if (!scenario) return Promise.resolve();
      return exclusive(`The agent is trying: ${scenario.label}`, async () => {
        const item = track(`Agent: ${scenario.label}`);
        try {
          await ensureSession();
          const result = await demoServer.pay(scenario.id, target.dataset['policy']!);
          item.steps = result.steps;
          item.expected = result.expected;
          const last = result.steps.at(-1);
          item.stage = !last ? 'error' : last.status === 'paid' ? 'confirmed' : last.status === 'unsettled' ? 'unsettled'
            : last.status === 'failed' ? 'failed' : 'refused';
        } catch (error) {
          item.stage = 'error';
          item.detail = error instanceof Error ? error.message : String(error);
        }
      });
    },
  };

  const forms: Record<string, (form: FormData) => Promise<void>> = {
    policy: (form) => ownerAction('Approve the policy', async (onStage) => {
      const draft: PolicyDraft = {
        perPayment: text(form, 'perPayment'), perDay: text(form, 'perDay'), total: text(form, 'total'),
        days: number(form, 'days'), maxRisk: number(form, 'maxRisk'), maxAgeDays: number(form, 'maxAgeDays'),
        allowService: form.get('allowService') === 'on',
      };
      try {
        const policy = await chain!.draftPolicy(draft);
        return await chain!.ownerCall(signer!, state.session!.wallet, 'approve_policy', { policy }, onStage);
      } catch (error) {
        // A value the form let through and the SDK did not: nothing was signed.
        return { stage: 'error', hash: null, detail: error instanceof Error ? error.message : String(error) };
      }
    }),
    withdraw: (form) => ownerAction('Withdraw', async (onStage) => {
      try {
        const amount = toContractUnits(text(form, 'amount'), state.config!.asset.decimals);
        return await chain!.ownerCall(signer!, state.session!.wallet, 'withdraw',
          { asset: state.config!.asset.contract, recipient: text(form, 'recipient'), amount }, onStage);
      } catch (error) {
        return { stage: 'error', hash: null, detail: error instanceof Error ? error.message : String(error) };
      }
    }),
  };

  root.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    const action = target && actions[target.dataset['action'] ?? ''];
    if (target && action && !state.busy) void action(target);
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
      chain = createChain(state.config, new StorageJournal(localStorage, `stellar-agent-auth-demo:${state.config.passphrase}`));
    } catch (error) {
      state.fatal = `The demo server could not be reached: ${error instanceof Error ? error.message : String(error)}. `
        + 'Run the demo setup and start the demo server, then reload.';
    }
    render();
    await refresh();
    setInterval(() => { if (!state.busy) void refresh(); }, REFRESH_MS);
  }

  return { boot, state };
}
