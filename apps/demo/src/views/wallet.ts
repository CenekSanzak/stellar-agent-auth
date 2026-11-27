import { fromContractUnits } from '@stellar-agent-auth/sdk';
import { addr, duration, esc, icon, money } from '../format.js';
import { allowanceView } from '../model.js';
import { agentName, currentAllowance, formAgent, phaseOf, type State } from '../state.js';

/** The owner's wallet: what it holds, the owner's own way in and out of it, and the one switch that stops every agent. */
export function renderWallet(state: State): string {
  const { config, owner, session, wallet } = state;
  if (phaseOf(state) !== 'ready' || !config || !owner || !session) return '';
  if (!wallet) return '<div class="wallet"><div class="wallet-main"><span class="label">Wallet balance</span><p class="muted">Reading the wallet…</p></div></div>';
  const { asset } = config;
  const balance = money(fromContractUnits(wallet.balance, asset.decimals));
  const empty = wallet.balance === 0n;
  return `<div class="wallet" data-testid="wallet" data-frozen="${wallet.paused}">
    <div class="wallet-main">
      <span class="label">Wallet balance</span>
      <div class="balance"><span data-testid="wallet-balance">${esc(balance)}</span><span class="unit">${esc(asset.code)}</span></div>
      <span class="small muted">${addr(session.wallet, config.explorer)} · only you can take money out</span>
    </div>
    <div class="actions">
      <button class="${empty ? 'primary' : ''}" data-action="fund">Add ${esc(config.faucet_amount)} ${esc(asset.code)}</button>
      <button data-action="dialog" data-dialog="withdraw">Withdraw</button>
      ${wallet.paused ? `<button class="primary" data-action="unfreeze">${icon('play')}Unfreeze</button>`
    : `<button data-action="freeze">${icon('pause')}Freeze all agents</button>`}
    </div>
    ${empty ? '<p class="banner warn">The wallet is empty, so an agent has nothing to spend. Add test dollars first.</p>' : ''}
    ${wallet.paused ? '<p class="banner warn" data-testid="frozen">You froze the wallet. No agent can pay until you unfreeze it. Your own withdrawals still work.</p>' : ''}
  </div>`;
}

/** An agent's allowance in one line, for its row: what is spent today, or that there is none. */
export function allowanceLine(state: State, agentId: string): { status: 'none' | 'active' | 'frozen'; text: string; share: number } {
  const { config, wallet } = state;
  const current = config && wallet ? currentAllowance(state, agentId) : undefined;
  if (!config || !wallet || !current) {
    const had = state.policies.some(({ policy }) => policy.agent_id.toString() === agentId);
    return { status: 'none', text: had ? 'Its allowance has ended' : 'No allowance yet', share: 0 };
  }
  const view = allowanceView(current.policy, current.state, config.asset, state.now);
  return {
    status: wallet.paused ? 'frozen' : 'active', share: view.share,
    text: `${money(view.spentToday)} of ${money(view.perDay)} ${config.asset.code} spent today · ${money(view.leftToday)} left`,
  };
}

/** The whole of an agent's allowance, for its unfolded row: the limits, where it may pay, and the way to end it. */
export function allowanceDetail(state: State, agentId: string): string {
  const { config, wallet } = state;
  if (!config || !wallet) return '';
  const name = agentName(state, agentId);
  const current = currentAllowance(state, agentId);
  if (!current) {
    const had = state.policies.some(({ policy }) => policy.agent_id.toString() === agentId);
    return `<p>${had ? `The last allowance has ended. ${esc(name)} can spend nothing until you approve a new one.`
      : `${esc(name)} cannot spend anything yet. Decide what it may spend, and where.`}</p>
      <div class="actions"><button class="primary" data-action="set-allowance" data-agent="${esc(agentId)}">Set an allowance</button></div>`;
  }
  const view = allowanceView(current.policy, current.state, config.asset, state.now);
  const sellers = config.vendors.filter((vendor) => view.recipients.includes(vendor.address)).map((vendor) => vendor.name);
  return `<dl class="stats">
      <div><dt>Per purchase</dt><dd>${esc(money(view.perPurchase))}</dd></div>
      <div><dt>Per day</dt><dd>${esc(money(view.perDay))}</dd></div>
      <div><dt>In total</dt><dd>${view.total === null ? 'no cap' : `${esc(money(view.spentEver))} / ${esc(money(view.total))}`}</dd></div>
      <div><dt>Ends in</dt><dd>${esc(duration(view.endsIn))}</dd></div>
    </dl>
    <p class="small muted">May pay: ${esc(sellers.join(', ') || 'no seller on this page')}.</p>
    <div class="actions"><button class="danger" data-action="end" data-policy="${esc(current.hash)}">End allowance</button></div>`;
}

const dialogHead = (title: string) => `<div class="dialog-head"><h2>${esc(title)}</h2>
  <button class="ghost icon-only" data-action="close-dialog" aria-label="Close">${icon('close')}</button></div>`;
export { dialogHead };

/** Taking money out, which is the owner's alone. */
export function withdrawDialog(state: State): string {
  const { config } = state;
  if (!config) return '';
  return `<form class="form" data-form="withdraw" method="dialog">
    ${dialogHead('Withdraw')}
    <label>Amount, ${esc(config.asset.code)}<input name="amount" inputmode="decimal" value="1" required /></label>
    <label>To<input name="recipient" placeholder="G… or C… address" required spellcheck="false" /></label>
    <p class="muted small">The recipient must already be able to hold ${esc(config.asset.code)}. A withdrawal needs your signature and no allowance.</p>
    <div class="dialog-foot"><button type="button" data-action="close-dialog">Cancel</button><button class="primary" type="submit">Withdraw</button></div>
  </form>`;
}

/** The form for a new allowance, for one agent. */
export function allowanceDialog(state: State): string {
  const { config } = state;
  const agentId = formAgent(state);
  if (!config || !agentId) return '';
  const name = agentName(state, agentId);
  const { code } = config.asset;
  const price = (vendor: string) => config.products.filter((product) => product.vendor === vendor)
    .map((product) => `${product.title} ${money(product.price)}`).join(', ');
  return `<form class="form" data-form="allowance" data-testid="allowance-form" data-agent="${esc(agentId)}" method="dialog">
    ${dialogHead(`Set ${name}'s allowance`)}
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
      <p class="muted small">Your wallet pays only while ${esc(name)} holds a current verification covering every check it has passed today.</p>
    </details>
    <div class="dialog-foot"><button type="button" data-action="close-dialog">Cancel</button><button class="primary" type="submit">Approve allowance</button></div>
  </form>`;
}
