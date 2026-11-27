import type { Exposure, IndexedHistory } from '@stellar-agent-auth/sdk';
import type { Attempt, Config, Session, TaskResult } from './backend.js';
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
  /** Whether the owner's account exists on the network; `null` until known. */
  accountFunded: boolean | null;
  session: Session | null;
  /** Ledger time, in Unix seconds. */
  now: bigint;
  agent: AgentView | null;
  wallet: WalletView | null;
  policies: PolicyView[];
  exposure: Exposure[];
  history: IndexedHistory | null;
  historyError: string | null;
  attempts: Attempt[];
  activity: Activity[];
  /** The action in progress, if any. One at a time. */
  busy: string | null;
  /** A read that failed; shown, and retried on the next refresh. */
  readError: string | null;
  /** What is unfolded on the page. Kept here because sections are redrawn. */
  ui: { record: boolean; details: boolean; withdraw: boolean; form: boolean; tables: number[] };
}

export const initialState = (): State => ({
  fatal: null, config: null, owner: null, connectError: null, accountFunded: null, session: null, now: 0n,
  agent: null, wallet: null, policies: [], exposure: [], history: null, historyError: null, attempts: [],
  activity: [], busy: null, readError: null,
  ui: { record: false, details: false, withdraw: false, form: false, tables: [] },
});

export type Phase = 'loading' | 'welcome' | 'setup' | 'ready';

/** Where the visitor is: nothing loaded, not connected, connected without a wallet, or with one. */
export function phaseOf(state: State): Phase {
  if (!state.config) return 'loading';
  if (!state.owner) return 'welcome';
  return state.session?.deployed ? 'ready' : 'setup';
}

/** The allowance Scout spends under now: the newest one that is active. Policies are listed newest first. */
export const currentAllowance = (state: State): PolicyView | undefined =>
  state.policies.find(({ policy, state: stored }) => policyStatus(policy, stored, state.now) === 'active');

/**
 * The allowance a task is tried under: the current one, or failing that the newest there ever was. Trying under an
 * ended allowance is allowed on purpose, so that the wallet's refusal can be seen.
 */
export const taskAllowance = (state: State): PolicyView | undefined => currentAllowance(state) ?? state.policies[0];
