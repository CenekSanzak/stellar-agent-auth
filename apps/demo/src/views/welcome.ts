import { addr, esc } from '../format.js';
import { phaseOf, type State } from '../state.js';

/** Which network this is, said plainly, so nobody mistakes test money for money. */
export function renderNetwork(state: State): string {
  if (!state.config) return '';
  return state.config.network === 'testnet'
    ? '<span class="pill" title="Stellar Testnet. Nothing here has any value.">Testnet demo · test money only</span>'
    : '<span class="pill">Local network · test money only</span>';
}

/** Who is connected, and how. */
export function renderAccount(state: State): string {
  const { config, owner } = state;
  if (!config || !owner) return '';
  return `<span class="account" data-testid="owner" data-kind="${esc(owner.kind)}">
      <span class="account-kind">${esc(owner.label)}</span>${addr(owner.address, config.explorer)}</span>
    <button class="quiet" data-action="disconnect">Disconnect</button>`;
}

/** Problems that stop the page, and reads that failed. */
export function renderNotice(state: State): string {
  if (state.fatal) return `<p class="banner bad" data-testid="fatal">${esc(state.fatal)}</p>`;
  if (!state.config) return '<p class="muted center" data-testid="loading">Loading the demo…</p>';
  if (state.readError) {
    return `<p class="banner warn" data-testid="read-error">Some of what is shown may be out of date: ${esc(state.readError)}</p>`;
  }
  return '';
}

/** What this is, for someone who has just arrived, and the ways in. */
export function renderWelcome(state: State): string {
  if (phaseOf(state) !== 'welcome') return '';
  return `<div class="hero">
    <p class="eyebrow">Agent payments on Stellar</p>
    <h1>Give an AI agent an allowance, not your keys.</h1>
    <p class="lede">Scout is a research agent. It buys briefs and datasets from online sellers and pays from
      <em>your</em> wallet, but only within the limits you set, only to sellers you approve, and only for as long as
      you let it. Freeze it or end its allowance whenever you like.</p>
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
    <li><span class="how-n">1</span><h3>You set the rules</h3>
      <p>How much per purchase, per day and in total. Which sellers. Until when.</p></li>
    <li><span class="how-n">2</span><h3>Scout does the shopping</h3>
      <p>It asks sellers for prices and signs purchases with its own key. It holds no money and cannot change your rules.</p></li>
    <li><span class="how-n">3</span><h3>Your wallet decides</h3>
      <p>A smart contract checks each payment against your rules and Scout's verification, pays or refuses, and keeps a record.</p></li>
  </ol>`;
}

/** The way from a connected account to a funded wallet. One button does it; each step says where it stands. */
export function renderSetup(state: State): string {
  const { config, owner, session } = state;
  if (phaseOf(state) !== 'setup' || !config || !owner) return '';
  const step = (done: boolean, title: string, text: string) =>
    `<li class="${done ? 'done' : ''}"><span class="check" aria-hidden="true">${done ? '✓' : ''}</span><div><strong>${esc(title)}</strong><p>${text}</p></div></li>`;
  const guest = owner.kind === 'guest';
  return `<div class="card setup" data-testid="setup">
    <h2>Set up your wallet</h2>
    <p class="muted">Your wallet is a smart contract that only you control. Scout will be allowed to spend from it,
      inside rules you choose next.</p>
    <ol class="checklist">
      ${step(state.accountFunded === true, 'Test XLM for network fees',
    `Your account ${addr(owner.address)} needs a little test XLM to pay for its own transactions. Friendbot gives it for free.`)}
      ${step(false, 'Create the wallet',
    guest ? 'A contract is deployed with you as its owner.' : 'A contract is deployed with you as its owner. Your wallet asks you to approve it.')}
      ${step(false, `Add ${esc(config.faucet_amount)} ${esc(config.asset.code)}`,
    `The demo's faucet sends test dollars to the wallet${session ? `, at ${addr(session.wallet)}` : ''}.`)}
    </ol>
    <button class="primary big" data-action="setup" ${state.accountFunded === null || !session ? 'disabled' : ''}>Set up my wallet</button>
    ${state.busy ? `<p class="working" data-testid="busy">${esc(state.busy)}…</p>` : ''}
  </div>`;
}

/** Where to look further. */
export function renderFooter(state: State): string {
  const { config } = state;
  if (!config) return '';
  return `<p>Scout is a demonstration of <a href="https://github.com/CenekSanzak/stellar-agent-auth" target="_blank" rel="noreferrer">stellar-agent-auth</a>:
    agent identity, time-limited verification and policy-limited wallets as Soroban contracts, with payments over x402.
    Everything here runs on ${config.network === 'testnet' ? 'Stellar Testnet' : 'a local network'}; the assets have no value.</p>`;
}
