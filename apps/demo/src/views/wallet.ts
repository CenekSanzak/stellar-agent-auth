import { fromContractUnits } from '@stellar-agent-auth/sdk';
import { addr, duration, esc, money } from '../format.js';
import { allowanceView } from '../model.js';
import { agentName, currentAllowance, formAgent, phaseOf, type State } from '../state.js';

/** The owner's wallet: what it holds, the owner's own way in and out of it, and the one switch that stops every agent. */
export function renderWallet(state: State): string {
  const { config, owner, session, wallet } = state;
  if (phaseOf(state) !== 'ready' || !config || !owner || !session) return '';
  if (!wallet) return '<div class="card"><h2>Your wallet</h2><p class="muted">Reading the wallet…</p></div>';
  const { asset } = config;
  const balance = money(fromContractUnits(wallet.balance, asset.decimals));
  const empty = wallet.balance === 0n;
  return `<div class="card wallet" data-testid="wallet" data-frozen="${wallet.paused}">
    <div class="card-head"><h2>Your wallet</h2>${addr(session.wallet, config.explorer)}</div>
    <div class="balance"><span data-testid="wallet-balance">${esc(balance)}</span><span class="unit">${esc(asset.code)}</span></div>
    <p class="muted small">Test dollars. Only you can take money out; an agent can only spend inside its allowance.</p>
    ${empty ? '<p class="banner warn">The wallet is empty, so an agent has nothing to spend. Add test dollars first.</p>' : ''}
    ${wallet.paused ? '<p class="banner warn" data-testid="frozen">You froze the wallet. No agent can pay until you unfreeze it. Your own withdrawals still work.</p>' : ''}
    <div class="actions">
      <button class="${empty ? 'primary' : ''}" data-action="fund">Add ${esc(config.faucet_amount)} ${esc(asset.code)}</button>
      ${wallet.paused ? '<button class="primary" data-action="unfreeze">Unfreeze</button>' : '<button data-action="freeze">Freeze all agents</button>'}
      <button class="quiet" data-action="toggle" data-what="withdraw">${state.ui.withdraw ? 'Close' : 'Withdraw'}</button>
    </div>
  </div>`;
}

/** Drawn apart from the wallet card so that a refresh does not clear what is being typed. */
export function renderWithdraw(state: State): string {
  const { config } = state;
  if (!config) return '';
  return `<form class="card form" data-form="withdraw">
    <h3>Withdraw as the owner</h3>
    <label>Amount, ${esc(config.asset.code)}<input name="amount" inputmode="decimal" value="1" required /></label>
    <label>To<input name="recipient" placeholder="G… or C… address" required spellcheck="false" /></label>
    <p class="muted small">The recipient must already be able to hold ${esc(config.asset.code)}. A withdrawal is yours alone:
      it needs your signature and no allowance.</p>
    <button type="submit">Withdraw</button>
  </form>`;
}

/**
 * What one agent may spend: its current allowance as a meter and plain limits, the sellers it may pay, and the way
 * to end it.
 */
export function allowanceCard(state: State, agentId: string, testId: string): string {
  const { config, wallet } = state;
  if (!config || !wallet) return '';
  const name = agentName(state, agentId);
  const current = currentAllowance(state, agentId);
  const { code } = config.asset;
  const frozen = wallet.paused;
  const head = `<div class="card-head"><h3>${esc(name)}'s allowance</h3>`;
  if (!current) {
    const had = state.policies.some(({ policy }) => policy.agent_id.toString() === agentId);
    const asking = formAgent(state) === agentId;
    return `<div class="allowance" data-testid="${testId}" data-status="none">
      ${head}<span class="badge muted">None</span></div>
      <p>${had ? `The last allowance has ended. ${esc(name)} can spend nothing until you approve a new one.`
    : `${esc(name)} cannot spend anything yet. Decide what it may spend, and where.`}</p>
      ${asking ? '' : `<div class="actions"><button class="primary" data-action="set-allowance" data-agent="${esc(agentId)}">Set an allowance</button></div>`}
    </div>`;
  }
  const view = allowanceView(current.policy, current.state, config.asset, state.now);
  const sellers = config.vendors.filter((vendor) => view.recipients.includes(vendor.address)).map((vendor) => vendor.name);
  return `<div class="allowance" data-testid="${testId}" data-status="${frozen ? 'frozen' : 'active'}">
    ${head}<span class="badge ${frozen ? 'warn' : 'good'}" data-testid="${testId}-status">${frozen ? 'Frozen' : 'Active'}</span></div>
    <div class="meter" role="img" aria-label="${esc(view.spentToday)} of ${esc(view.perDay)} ${esc(code)} spent today">
      <div class="meter-fill" style="width:${view.share}%"></div></div>
    <p class="meter-text" data-testid="${testId}-spent"><strong>${esc(money(view.spentToday))}</strong> of ${esc(money(view.perDay))} ${esc(code)} spent today
      <span class="muted">· ${esc(money(view.leftToday))} left</span></p>
    <dl class="limits">
      <div><dt>Per purchase</dt><dd>${esc(money(view.perPurchase))}</dd></div>
      <div><dt>Per day</dt><dd>${esc(money(view.perDay))}</dd></div>
      <div><dt>In total</dt><dd>${view.total === null ? 'no cap' : `${esc(money(view.spentEver))} / ${esc(money(view.total))}`}</dd></div>
      <div><dt>Ends in</dt><dd>${esc(duration(view.endsIn))}</dd></div>
    </dl>
    <p class="small muted">May pay: ${esc(sellers.join(', ') || 'no seller on this page')}.</p>
    <div class="actions">
      <button class="danger" data-action="end" data-policy="${esc(current.hash)}">End allowance</button></div>
  </div>`;
}

/** The built-in agent's allowance. */
export function renderAllowance(state: State): string {
  const { config, wallet } = state;
  if (phaseOf(state) !== 'ready' || !config || !wallet) return '';
  return `<div class="card">${allowanceCard(state, config.agent.agent_id, 'allowance')}
    <p class="muted small">Ending an allowance is permanent; you can always approve a new one. To stop everything at once, freeze the wallet.</p></div>`;
}

/**
 * The form for a new allowance, for one agent. It is drawn once, so a refresh never clears what the owner is
 * typing.
 */
export function renderAllowanceForm(state: State): string {
  const { config } = state;
  const agentId = formAgent(state);
  if (!config || !agentId) return '';
  const name = agentName(state, agentId);
  const own = agentId !== config.agent.agent_id;
  const { code } = config.asset;
  const price = (vendor: string) => config.products.filter((product) => product.vendor === vendor)
    .map((product) => `${product.title} ${money(product.price)}`).join(', ');
  return `<form class="card form" data-form="allowance" data-testid="allowance-form" data-agent="${esc(agentId)}">
    <h3>Set ${esc(name)}'s allowance</h3>
    <input type="hidden" name="agent" value="${esc(agentId)}" />
    <div class="grid">
      <label>Per purchase, ${esc(code)}<input name="perPurchase" inputmode="decimal" value="5" required /></label>
      <label>Per day, ${esc(code)}<input name="perDay" inputmode="decimal" value="6" required /></label>
      <label>In total, ${esc(code)}<input name="total" inputmode="decimal" value="20" placeholder="no cap" /></label>
      <label>For how many days<input name="days" type="number" min="1" max="365" value="7" required /></label>
    </div>
    <fieldset><legend>Sellers ${esc(name)} may pay</legend>
      ${config.vendors.map((vendor) => `<label class="choice"><input type="checkbox" name="vendor" value="${esc(vendor.id)}" ${vendor.suggested ? 'checked' : ''} />
        <span><strong>${esc(vendor.name)}</strong><span class="muted small"> ${esc(price(vendor.id))}</span></span></label>`).join('')}
    </fieldset>
    <details><summary>Verification ${esc(name)} must hold</summary>
      <div class="grid">
        <label>Highest risk score<input name="maxRisk" type="number" min="0" max="100" value="10" required /></label>
        <label>Oldest verification, days<input name="maxAgeDays" type="number" min="1" max="365" value="30" required /></label>
      </div>
      <p class="muted small">Your wallet pays only while ${esc(name)} holds a current verification from the provider, covering
        every check it has passed today.</p>
    </details>
    <div class="actions"><button class="primary" type="submit">Approve allowance</button>
      ${own ? '<button type="button" class="quiet" data-action="set-allowance" data-agent="">Not now</button>' : ''}</div>
    <p class="muted small">The suggested numbers leave room to see the wallet say no: one seller asks more than 5, and one
      is not ticked.</p>
  </form>`;
}
