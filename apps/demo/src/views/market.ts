import { esc, money } from '../format.js';
import { phaseOf, type State } from '../state.js';

/** Where agents can buy here: sample sellers, what each asks, and whom each sells to. */
export function renderSellers(state: State): string {
  const { config } = state;
  if (phaseOf(state) !== 'ready' || !config) return '';
  const { code } = config.asset;
  return `<div class="card sellers">
    <div class="card-head"><h2>Where agents can buy</h2><span class="muted small">sample sellers, paid over x402</span></div>
    <ul class="vendor-list">${config.vendors.map((vendor) => `<li data-testid="vendor" data-vendor="${esc(vendor.id)}">
        <strong>${esc(vendor.name)}</strong>
        <p class="muted small">${esc(vendor.tagline)}</p>
        <ul class="prices">${config.products.filter((product) => product.vendor === vendor.id).map((product) =>
    `<li><span>${esc(product.title)}</span><span class="price">${esc(money(product.price))} ${esc(code)}</span></li>`).join('')}</ul>
        <p class="small ${vendor.requires.includes('Code') ? 'warn-text' : 'muted'}">Sells to: ${esc(vendor.sells_to.toLowerCase())}</p>
      </li>`).join('')}</ul>
    <p class="muted small">These run on this site and stand for other people's shops. An agent's allowance says which of them it may pay.</p>
  </div>`;
}
