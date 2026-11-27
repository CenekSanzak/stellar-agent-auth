import { fromContractUnits } from '@stellar-agent-auth/sdk';
import { addr, duration, esc, money } from '../format.js';
import { allowanceView } from '../model.js';
import { currentAllowance, phaseOf, type State } from '../state.js';

/** The owner's wallet: what it holds, and the owner's own way to put money in and take it out. */
export function renderWallet(state: State): string {
  const { config, owner, session, wallet } = state;
  if (phaseOf(state) !== 'ready' || !config || !owner || !session) return '';
  if (!wallet) return '<div class="card"><h2>Your wallet</h2><p class="muted">Reading the wallet…</p></div>';
  const { asset } = config;
  const balance = money(fromContractUnits(wallet.balance, asset.decimals));
  const empty = wallet.balance === 0n;
  return `<div class="card wallet">
    <div class="card-head"><h2>Your wallet</h2>${addr(session.wallet, config.explorer)}</div>
    <div class="balance"><span data-testid="wallet-balance">${esc(balance)}</span><span class="unit">${esc(asset.code)}</span></div>
    <p class="muted small">Test dollars. Only you can take money out; Scout can only spend inside its allowance.</p>
    ${empty ? '<p class="banner warn">The wallet is empty, so Scout has nothing to spend. Add test dollars first.</p>' : ''}
    <div class="actions">
      <button class="${empty ? 'primary' : ''}" data-action="fund">Add ${esc(config.faucet_amount)} ${esc(asset.code)}</button>
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

/** What Scout may spend: the current allowance as a meter and plain limits, with the owner's two stops. */
export function renderAllowance(state: State): string {
  const { config, wallet } = state;
  if (phaseOf(state) !== 'ready' || !config || !wallet) return '';
  const current = currentAllowance(state);
  const { code } = config.asset;
  const frozen = wallet.paused;
  const freeze = frozen
    ? '<button class="primary" data-action="unfreeze">Unfreeze Scout</button>'
    : '<button data-action="freeze">Freeze Scout</button>';
  if (!current) {
    const last = state.policies[0];
    return `<div class="card allowance" data-testid="allowance" data-status="none">
      <div class="card-head"><h2>Scout's allowance</h2><span class="badge muted">None</span></div>
      <p>${last ? 'The last allowance has ended. Scout can spend nothing until you approve a new one.'
    : 'Scout cannot spend anything yet. Decide what it may spend, and where.'}</p>
      ${frozen ? `<p class="banner warn">Scout is frozen.</p><div class="actions">${freeze}</div>` : ''}
    </div>`;
  }
  const view = allowanceView(current.policy, current.state, config.asset, state.now);
  const others = state.policies.filter((item) => item !== current
    && allowanceView(item.policy, item.state, config.asset, state.now).status === 'active').length;
  return `<div class="card allowance" data-testid="allowance" data-status="${frozen ? 'frozen' : 'active'}">
    <div class="card-head"><h2>Scout's allowance</h2>
      <span class="badge ${frozen ? 'warn' : 'good'}" data-testid="allowance-status">${frozen ? 'Frozen' : 'Active'}</span></div>
    ${frozen ? '<p class="banner warn">You froze Scout. Nothing can be paid until you unfreeze it. Your own withdrawals still work.</p>' : ''}
    <div class="meter" role="img" aria-label="${esc(view.spentToday)} of ${esc(view.perDay)} ${esc(code)} spent today">
      <div class="meter-fill" style="width:${view.share}%"></div></div>
    <p class="meter-text" data-testid="allowance-spent"><strong>${esc(money(view.spentToday))}</strong> of ${esc(money(view.perDay))} ${esc(code)} spent today
      <span class="muted">· ${esc(money(view.leftToday))} left</span></p>
    <dl class="limits">
      <div><dt>Per purchase</dt><dd>${esc(money(view.perPurchase))}</dd></div>
      <div><dt>Per day</dt><dd>${esc(money(view.perDay))}</dd></div>
      <div><dt>In total</dt><dd>${view.total === null ? 'no cap' : `${esc(money(view.spentEver))} / ${esc(money(view.total))}`}</dd></div>
      <div><dt>Ends in</dt><dd>${esc(duration(view.endsIn))}</dd></div>
    </dl>
    ${others ? `<p class="small muted">${others} older allowance${others === 1 ? ' is' : 's are'} also still active; see the wallet's record.</p>` : ''}
    <div class="actions">${freeze}
      <button class="danger" data-action="end" data-policy="${esc(current.hash)}">End allowance</button></div>
    <p class="muted small">Freezing stops every payment until you undo it. Ending an allowance is permanent; you can always approve a new one.</p>
  </div>`;
}

/**
 * The form for a new allowance, shown when there is none. It is drawn once, so a refresh never clears what the
 * owner is typing.
 */
export function renderAllowanceForm(state: State): string {
  const { config } = state;
  if (!config) return '';
  const { code } = config.asset;
  const price = (vendor: string) => config.products.filter((product) => product.vendor === vendor)
    .map((product) => `${product.title} ${money(product.price)}`).join(', ');
  return `<form class="card form" data-form="allowance" data-testid="allowance-form">
    <h3>Set Scout's allowance</h3>
    <div class="grid">
      <label>Per purchase, ${esc(code)}<input name="perPurchase" inputmode="decimal" value="5" required /></label>
      <label>Per day, ${esc(code)}<input name="perDay" inputmode="decimal" value="6" required /></label>
      <label>In total, ${esc(code)}<input name="total" inputmode="decimal" value="20" placeholder="no cap" /></label>
      <label>For how many days<input name="days" type="number" min="1" max="365" value="7" required /></label>
    </div>
    <fieldset><legend>Sellers Scout may pay</legend>
      ${config.vendors.map((vendor) => `<label class="choice"><input type="checkbox" name="vendor" value="${esc(vendor.id)}" ${vendor.suggested ? 'checked' : ''} />
        <span><strong>${esc(vendor.name)}</strong><span class="muted small"> ${esc(price(vendor.id))}</span></span></label>`).join('')}
    </fieldset>
    <details><summary>Verification Scout must hold</summary>
      <div class="grid">
        <label>Highest risk score<input name="maxRisk" type="number" min="0" max="100" value="10" required /></label>
        <label>Oldest verification, days<input name="maxAgeDays" type="number" min="1" max="365" value="30" required /></label>
      </div>
      <p class="muted small">Your wallet pays only while Scout holds a current verification from the provider, covering its
        endpoint, its metadata and its signing account.</p>
    </details>
    <button class="primary" type="submit">Approve allowance</button>
    <p class="muted small">The suggested numbers leave room to see the wallet say no: one seller asks more than 5, and one
      is not ticked.</p>
  </form>`;
}
