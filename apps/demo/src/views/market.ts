import { esc, money } from '../format.js';
import { phaseOf, type State } from '../state.js';

/** Where agents can buy here: sample sellers, what each asks, and whom each sells to. */
export function renderSellers(state: State): string {
  const { config } = state;
  if (phaseOf(state) !== 'ready' || state.ui.tab !== 'sellers' || !config) return '';
  const { code } = config.asset;
  return `<div class="section-head"><p class="muted">Sample sellers that run on this site and stand for other people's shops. They are paid over x402,
      and an agent's allowance says which of them it may pay.</p></div>
    <div class="table-wrap"><table class="sellers"><thead><tr><th>Seller</th><th>Sells</th><th>Price</th><th>Sells to</th></tr></thead><tbody>
    ${config.vendors.map((vendor) => {
    const products = config.products.filter((product) => product.vendor === vendor.id);
    return `<tr data-testid="vendor" data-vendor="${esc(vendor.id)}">
        <td><strong>${esc(vendor.name)}</strong><br /><span class="small muted">${esc(vendor.tagline)}</span></td>
        <td>${products.map((product) => esc(product.title)).join('<br />')}</td>
        <td class="price">${products.map((product) => `${esc(money(product.price))} ${esc(code)}`).join('<br />')}</td>
        <td class="${vendor.requires.includes('Code') ? 'warn-text' : 'muted'}">${esc(vendor.sells_to)}</td>
      </tr>`;
  }).join('')}</tbody></table></div>`;
}
