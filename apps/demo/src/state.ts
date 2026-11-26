import type { Exposure, IndexedHistory } from '@stellar-agent-auth/sdk';
import type { Attempt, Config, Session, Step } from './backend.js';
import type { AgentView, PolicyView, WalletView } from './chain.js';
import type { Stage } from './model.js';

/** One thing that was asked for, and how far it has got. Owner actions move through stages; agent runs list steps. */
export interface Activity {
  id: number;
  title: string;
  stage: Stage;
  detail: string;
  hash: string | null;
  /** For an agent scenario: what the wallet answered to each payment, and what was expected. */
  steps?: Step[];
  expected?: string;
}

export interface State {
  /** Set when the page cannot work at all: no demo server, no deployment. */
  fatal: string | null;
  config: Config | null;
  owner: { kind: 'freighter' | 'local'; address: string } | null;
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
}

export const initialState = (): State => ({
  fatal: null, config: null, owner: null, connectError: null, accountFunded: null, session: null, now: 0n,
  agent: null, wallet: null, policies: [], exposure: [], history: null, historyError: null, attempts: [],
  activity: [], busy: null, readError: null,
});
