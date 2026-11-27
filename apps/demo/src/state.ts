import type { Exposure, IndexedHistory } from '@stellar-agent-auth/sdk';
import type { Attempt, Config, LinkedAgent, Session, TaskResult } from './backend.js';
import type { AgentView, PolicyView, WalletView } from './chain.js';
import { policyStatus, type Stage } from './model.js';
import type { OwnerKind } from './owner.js';

/**
 * One thing that was asked for, and how far it has got. Owner actions move through stages; a task carries what
 * Scout did and what it bought. These are kept in the browser so a reload does not lose what was bought; the
 * wallet's own record of payments is on the ledger and is shown separately.
 */
export interface Activity {
  id: number;
  /** When it was started, as an ISO time. */
  at: string;
  kind: 'owner' | 'faucet' | 'task';
  title: string;
  stage: Stage;
  detail: string;
  hash: string | null;
  result?: TaskResult;
  /** The allowance a task ran under, so its refusals can be explained with that allowance's numbers. */
  policy?: string;
}

export interface State {
  /** Set when the page cannot work at all: no demo server, no deployment. */
  fatal: string | null;
  config: Config | null;
  owner: { kind: OwnerKind; label: string; address: string } | null;
  connectError: string | null;
  /** Set while the page is finding out, after a reload, whether the owner is still connected. */
  reconnecting: boolean;
  /** Whether the owner's account exists on the network; `null` until known. */
  accountFunded: boolean | null;
  session: Session | null;
  /** Ledger time, in Unix seconds. */
  now: bigint;
  agent: AgentView | null;
  /** Agents the owner brought themselves, with what the registries say about each. */
  own: OwnAgent[];
  wallet: WalletView | null;
  policies: PolicyView[];
  /**
   * Whether the allowances and the owner's agents have been read at least once. Until then the page says it is
   * reading them: an owner with allowances must not be told, even for a moment, that their agents have none.
   */
  agentsRead: boolean;
  exposure: Exposure[];
  history: IndexedHistory | null;
  historyError: string | null;
  /**
   * Whether the record is merely a few seconds behind the wallet. The indexer reads the network every few seconds,
   * so right after an action its copy lacks the newest entries; that is not a fault unless it lasts.
   */
  catchingUp: boolean;
  attempts: Attempt[];
  activity: Activity[];
  /** The action in progress, if any. One at a time. */
  busy: string | null;
  /** A read that failed; shown, and retried on the next refresh. */
  readError: string | null;
  /** What the owner is looking at. Kept here because sections are redrawn. */
  ui: Ui;
}

export type Tab = 'agents' | 'activity' | 'record' | 'sellers';

/** The one window that can be open over the page. */
export type Dialog =
  | { kind: 'add' }
  | { kind: 'connect' }
  | { kind: 'allowance'; agent: string }
  | { kind: 'withdraw' };

export interface Ui {
  tab: Tab;
  dialog: Dialog | null;
  /** The agent whose row is unfolded, if the owner chose one. */
  openAgent: string | null;
  /** Whether the owner asked to try the sample agent. Until then it is an option, not one of their agents. */
  sample: boolean;
  /** Set for a moment after the set-up prompt was copied. */
  copied: boolean;
  /** Tables of bought content that are shown in full. */
  tables: number[];
  /** Whether the addresses and exact rules are shown in the record. */
  details: boolean;
  /** What the last action came to, shown for a few seconds. */
  flash: { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' } | null;
}

export const initialUi = (): Ui => ({
  tab: 'agents', dialog: null, openAgent: null, sample: false, copied: false, tables: [], details: false, flash: null,
});

export interface OwnAgent extends LinkedAgent {
  view: AgentView | null;
}

export const initialState = (): State => ({
  fatal: null, config: null, owner: null, connectError: null, reconnecting: false, accountFunded: null, session: null, now: 0n,
  agent: null, own: [], wallet: null, policies: [], agentsRead: false, exposure: [], history: null, historyError: null, catchingUp: false, attempts: [],
  activity: [], busy: null, readError: null,
  ui: initialUi(),
});

export type Phase = 'loading' | 'welcome' | 'checking' | 'setup' | 'ready';

/**
 * Where the visitor is: nothing loaded, not connected, connected with a wallet, or without one. `checking` is the
 * moment in between, when someone is connected and the page does not know yet whether they have a wallet. Nothing
 * is claimed in that moment: a returning owner is never shown the steps of a set-up they have done.
 */
export function phaseOf(state: State): Phase {
  if (!state.config) return 'loading';
  if (state.reconnecting) return 'checking';
  if (!state.owner) return 'welcome';
  if (state.session?.deployed) return 'ready';
  // Whether the wallet exists, and whether the account does, are both read before anything is offered.
  return state.session === null || state.accountFunded === null ? 'checking' : 'setup';
}

/**
 * The allowance an agent spends under now: the newest active policy that names it. Policies are listed newest
 * first. Without an agent, the built-in one is meant.
 */
export function currentAllowance(state: State, agentId?: string): PolicyView | undefined {
  const id = agentId ?? state.config?.agent.agent_id;
  return state.policies.find(({ policy, state: stored }) =>
    policy.agent_id.toString() === id && policyStatus(policy, stored, state.now) === 'active');
}

/**
 * The allowance a task of the built-in agent is tried under: the current one, or failing that the newest it ever
 * had. Trying under an ended allowance is allowed on purpose, so that the wallet's refusal can be seen.
 */
export const taskAllowance = (state: State): PolicyView | undefined =>
  currentAllowance(state) ?? state.policies.find(({ policy }) => policy.agent_id.toString() === state.config?.agent.agent_id);

/** How an agent is called on the page: the built-in one by its name, the owner's own by the name they gave. */
export function agentName(state: State, agentId: string): string {
  if (agentId === state.config?.agent.agent_id) return 'Scout';
  return state.own.find((agent) => agent.agent_id === agentId)?.name ?? `Agent ${agentId}`;
}

/**
 * The agent whose allowance form is open, if any. It opens for an agent the page knows that has no allowance now;
 * anything else asked for, such as an agent that is not the owner's, opens nothing.
 */
export function formAgent(state: State): string | undefined {
  const asked = state.ui.dialog?.kind === 'allowance' ? state.ui.dialog.agent : undefined;
  if (!asked || !state.config || !state.agentsRead) return undefined;
  const known = asked === state.config.agent.agent_id || state.own.some((agent) => agent.agent_id === asked);
  return known && !currentAllowance(state, asked) ? asked : undefined;
}

/**
 * Whether the sample agent is one of the owner's agents: they asked to try it, or it has had an allowance from
 * them. Before that it is offered beside bringing an agent of one's own, and listed nowhere.
 */
export function sampleListed(state: State): boolean {
  const id = state.config?.agent.agent_id;
  return state.ui.sample || state.policies.some(({ policy }) => policy.agent_id.toString() === id);
}

/** The agents listed for the owner, their own first: `[id, name, kind]`. */
export function listedAgents(state: State): { id: string; name: string; sample: boolean }[] {
  const own = state.own.map((agent) => ({ id: agent.agent_id, name: agent.name, sample: false }));
  return state.config && sampleListed(state) ? [...own, { id: state.config.agent.agent_id, name: 'Scout', sample: true }] : own;
}

/** The agent whose row is unfolded: the one the owner opened, or the only one there is. */
export function openAgent(state: State): string | undefined {
  const listed = listedAgents(state);
  const chosen = state.ui.openAgent;
  // Once the owner has opened or folded a row, that is what holds, including having folded the only one.
  if (chosen !== null) return listed.some((agent) => agent.id === chosen) ? chosen : undefined;
  return listed.length === 1 ? listed[0]!.id : undefined;
}
