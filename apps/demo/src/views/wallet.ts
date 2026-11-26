import { fromContractUnits } from '@stellar-agent-auth/sdk';
import { addr, esc } from '../format.js';
import type { State } from '../state.js';

/** The owner's wallet: where it is, what it holds, and the owner's own controls over it. */
export function renderWallet(state: State): string {
  const { config, owner, session, wallet } = state;
  if (!config) return '';
  const head = '<div class="card-head"><h2>Wallet</h2>';
  if (!owner) {
    return `<div class="card">${head}</div><p class="muted">Connect as the owner to see or create your wallet.</p></div>`;
  }
  if (state.accountFunded === false) {
    return `<div class="card">${head}</div>
      <p>The account ${addr(owner.address)} does not exist on this network yet. It needs test XLM to pay for its own transactions.</p>
      <button data-action="test-xlm">Get test XLM from Friendbot</button></div>`;
  }
  if (!session) return `<div class="card">${head}</div><p class="muted">Looking for your wallet…</p></div>`;
  if (!session.deployed) {
    return `<div class="card">${head}<span class="badge muted">Not created</span></div>
      <p>You have no wallet on this deployment yet. Creating one deploys a contract that you own. It will be bound to
      this deployment's agent registry and verification registry, and that cannot be changed later.</p>
      <dl class="facts"><dt>Address it will have</dt><dd>${addr(session.wallet)}</dd></dl>
      <button class="primary" data-action="create-wallet">Create my wallet</button></div>`;
  }
  if (!wallet) return `<div class="card">${head}</div><p class="muted">Reading the wallet…</p></div>`;
  const { asset } = config;
  const exposure = state.exposure.find((row) => row.asset === asset.contract);
  const units = (value: bigint) => `${esc(fromContractUnits(value, asset.decimals))} ${esc(asset.code)}`;
  return `<div class="card">
    ${head}<span class="badge ${wallet.paused ? 'warn' : 'good'}" data-testid="wallet-status">${wallet.paused ? 'Paused' : 'Active'}</span></div>
    <div class="balance"><span data-testid="wallet-balance">${esc(fromContractUnits(wallet.balance, asset.decimals))}</span> ${esc(asset.code)}</div>
    ${wallet.paused ? '<p class="banner warn">The wallet is paused. No agent can pay until you resume it. Your own withdrawals still work.</p>' : ''}
    <dl class="facts">
      <dt>Wallet</dt><dd>${addr(session.wallet)}</dd>
      <dt>Owner</dt><dd>${addr(owner.address)}</dd>
      <dt>Network</dt><dd>${esc(config.network)} <span class="tag">test network</span></dd>
      <dt>Asset</dt><dd>${esc(asset.code)}, issued by ${addr(asset.issuer)} <span class="tag">test asset, no value</span></dd>
      <dt>Asset contract</dt><dd>${addr(asset.contract)} · ${esc(asset.decimals)} decimals</dd>
    </dl>
    <p data-testid="exposure">${exposure
    ? `Across ${exposure.policies} active ${exposure.policies === 1 ? 'policy' : 'policies'}, agents can still move
      <strong>${units(exposure.remaining_today)}</strong> today, at most ${units(exposure.largest_transfer)} at a time${exposure.remaining_total === null
      ? '. No overall cap: the daily limit is the only bound.' : `, and ${units(exposure.remaining_total)} in total.`}`
    : 'No active policy: no agent can move anything.'}</p>
    <div class="actions">
      <button data-action="fund">Add ${esc(config.faucet_amount)} ${esc(asset.code)} from the faucet</button>
      ${wallet.paused ? '<button class="primary" data-action="resume">Resume</button>'
    : '<button class="danger" data-action="pause">Pause all agent payments</button>'}
    </div>
    <form class="inline" data-form="withdraw">
      <h3>Withdraw as owner</h3>
      <label>Amount <input name="amount" inputmode="decimal" value="1" required /></label>
      <label>To <input name="recipient" value="${esc(config.roles.recipient)}" required spellcheck="false" /></label>
      <button type="submit">Withdraw</button>
      <p class="muted small">The recipient must already hold ${esc(asset.code)}; the demo's payee does.</p>
    </form>
  </div>`;
}
