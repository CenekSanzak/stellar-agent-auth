import { addr, esc, icon } from '../format.js';
import { phaseOf, type State, type Tab } from '../state.js';

/** Which network this is, said plainly, so nobody mistakes test money for money. */
export function renderNetwork(state: State): string {
  if (!state.config) return '';
  return state.config.network === 'testnet'
    ? '<span class="pill" title="Stellar Testnet. Nothing here has any value.">Testnet · test money only</span>'
    : '<span class="pill">Local network · test money only</span>';
}

/** Who is connected, and how. */
export function renderAccount(state: State): string {
  const { config, owner } = state;
  if (!config || !owner) return '';
  return `<span class="account" data-testid="owner" data-kind="${esc(owner.kind)}">
      <span class="account-kind">${esc(owner.label)}</span>${addr(owner.address, config.explorer)}</span>
    <button class="ghost" data-action="disconnect">Disconnect</button>`;
}

/** Problems that stop the page, and reads that failed. */
export function renderNotice(state: State): string {
  if (state.fatal) return `<p class="banner bad" data-testid="fatal">${esc(state.fatal)}</p>`;
  if (!state.config) return '<p class="muted center" data-testid="loading">Loading…</p>';
  if (state.readError) {
    return `<p class="banner warn" data-testid="read-error">Some of what is shown may be out of date: ${esc(state.readError)}</p>`;
  }
  return '';
}

/** What this is, for someone who has just arrived, and the ways in. */
export function renderWelcome(state: State): string {
  if (phaseOf(state) !== 'welcome') return '';
  return `<div class="hero">
    <h1>Give your AI agent an allowance, not your keys.</h1>
    <p class="lede">A smart wallet your AI agents can pay from. You set how much, where and until when; the wallet enforces it,
      and you can stop it at any time.</p>
    <div class="actions">
      <button class="primary big" data-action="connect-guest">Try it as a guest</button>
      <button class="big" data-action="connect-freighter">Connect Freighter</button>
      <button class="big" data-action="connect-kit">Other wallets</button>
    </div>
    <p class="small muted">Guest mode makes a throwaway test-network key in this browser. There is nothing to install
      and nothing real at stake.</p>
    ${state.connectError ? `<p class="banner bad" data-testid="connect-error">${esc(state.connectError)}</p>` : ''}
  </div>
  <ol class="how">
    <li><span class="how-n">1</span><div><h3>You set the rules</h3>
      <p>How much per purchase, per day and in total. Which sellers. Until when.</p></div></li>
    <li><span class="how-n">2</span><div><h3>Your agent does the shopping</h3>
      <p>Your own AI agent, in Claude Code, Codex or any MCP host, with a key of its own. It holds no money.</p></div></li>
    <li><span class="how-n">3</span><div><h3>Your wallet decides</h3>
      <p>A smart contract checks every payment against your rules, pays or refuses, and keeps a record.</p></div></li>
  </ol>`;
}

/**
 * The moment between being connected and knowing what the owner has. Nothing is offered in it: someone who set
 * their wallet up yesterday must not be shown the steps of setting it up.
 */
export function renderChecking(state: State): string {
  if (phaseOf(state) !== 'checking') return '';
  return `<p class="muted center" data-testid="checking">${state.reconnecting ? 'Reconnecting…' : 'Looking for your wallet…'}</p>`;
}

/** The way from a connected account to a funded wallet. One button does it; each step says where it stands. */
export function renderSetup(state: State): string {
  const { config, owner, session } = state;
  if (phaseOf(state) !== 'setup' || !config || !owner) return '';
  const step = (done: boolean, title: string, text: string) =>
    `<li class="${done ? 'done' : ''}"><span class="check" aria-hidden="true">${done ? icon('check') : ''}</span><div><strong>${esc(title)}</strong><p>${text}</p></div></li>`;
  const guest = owner.kind === 'guest';
  return `<div class="card setup" data-testid="setup">
    <h2>Set up your wallet</h2>
    <p class="muted">Your wallet is a smart contract that only you control. An agent can spend from it only inside
      an allowance you give it afterwards.</p>
    <ol class="checklist">
      ${step(state.accountFunded === true, 'Test XLM for network fees',
    `Your account ${addr(owner.address)} needs a little test XLM to pay for its own transactions. Friendbot gives it for free.`)}
      ${step(false, 'Create the wallet',
    guest ? 'A contract is deployed with you as its owner.' : 'A contract is deployed with you as its owner. Your wallet asks you to approve it.')}
      ${step(false, `Add ${esc(config.faucet_amount)} ${esc(config.asset.code)}`,
    `The faucet sends test dollars to the wallet${session ? `, at ${addr(session.wallet)}` : ''}.`)}
    </ol>
    <button class="primary big" data-action="setup">Set up my wallet</button>
    ${state.busy ? `<p class="working" data-testid="busy">${esc(state.busy)}…</p>` : ''}
  </div>`;
}

const TABS: [Tab, string][] = [['agents', 'Agents'], ['activity', 'Activity'], ['record', 'Record'], ['sellers', 'Sellers']];

/** The four things there are to look at. One at a time: the page is the wallet and one of these. */
export function renderTabs(state: State): string {
  if (phaseOf(state) !== 'ready') return '';
  const count = (tab: Tab) => (tab === 'activity' && state.activity.length ? `<span class="count">${state.activity.length}</span>` : '');
  return `<div class="tabs" role="tablist" aria-label="Sections">${TABS.map(([tab, label]) =>
    `<button role="tab" class="tab" aria-selected="${state.ui.tab === tab}" data-action="tab" data-tab="${tab}">${label}${count(tab)}</button>`).join('')}</div>`;
}

/** What is going on right now, or what the last action came to. One line, out of the way of the page. */
export function renderToast(state: State): string {
  // During set-up the progress is said in the set-up card itself.
  if (state.busy) return phaseOf(state) === 'ready' ? `<div class="toast" role="status"><span class="working" data-testid="busy">${esc(state.busy)}…</span></div>` : '';
  const { flash } = state.ui;
  return flash ? `<div class="toast ${flash.tone}" role="status" data-testid="flash">${esc(flash.text)}</div>` : '';
}

/** Where to look further. */
export function renderFooter(state: State): string {
  const { config } = state;
  if (!config) return '';
  return `<p>A working example of <a href="https://github.com/CenekSanzak/stellar-agent-auth" target="_blank" rel="noreferrer">stellar-agent-auth</a>:
    agent identity, time-limited verification and policy-limited wallets as Soroban contracts, with payments over x402.
    Everything here runs on ${config.network === 'testnet' ? 'Stellar Testnet' : 'a local network'}; the assets have no value.</p>`;
}
