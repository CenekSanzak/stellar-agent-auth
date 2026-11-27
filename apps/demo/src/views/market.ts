import { addr, esc, money } from '../format.js';
import { coverage, verificationVerdict } from '../model.js';
import { currentAllowance, phaseOf, type State } from '../state.js';

/** The sellers, what each asks, and whether the current allowance lets Scout pay them. */
export function renderSellers(state: State): string {
  const { config } = state;
  if (phaseOf(state) !== 'ready' || !config) return '';
  const approved = new Set(currentAllowance(state)?.policy.allowed_recipients ?? []);
  const { code } = config.asset;
  return `<div class="card sellers">
    <div class="card-head"><h2>Sellers</h2><span class="muted small">paid over x402</span></div>
    <ul class="vendor-list">${config.vendors.map((vendor) => {
    const ok = approved.has(vendor.address);
    return `<li data-testid="vendor" data-vendor="${esc(vendor.id)}" data-approved="${ok}">
        <div class="vendor-head"><strong>${esc(vendor.name)}</strong>
          <span class="badge ${ok ? 'good' : 'muted'}">${ok ? 'Scout may pay' : 'Not for Scout'}</span></div>
        <p class="muted small">${esc(vendor.tagline)}</p>
        <ul class="prices">${config.products.filter((product) => product.vendor === vendor.id).map((product) =>
    `<li><span>${esc(product.title)}</span><span class="price">${esc(money(product.price))} ${esc(code)}</span></li>`).join('')}</ul>
        <p class="small ${vendor.requires.includes('Code') ? 'warn-text' : 'muted'}">Sells to: ${esc(vendor.sells_to.toLowerCase())}</p>
      </li>`;
  }).join('')}</ul>
  </div>`;
}

/** The agent: who it is, who vouches for it, and what that covers. */
export function renderScout(state: State): string {
  const { config, agent } = state;
  if (phaseOf(state) !== 'ready' || !config) return '';
  if (!agent) return '<div class="card"><h2>Scout</h2><p class="muted">Reading the agent registry…</p></div>';
  const verdict = verificationVerdict({ ...agent, now: state.now });
  const covered = agent.result ? coverage(agent.result) : undefined;
  const fixture = config.provider.mode === 'Fixture';
  return `<div class="card scout">
    <div class="card-head"><h2>Scout</h2><span class="badge ${verdict.tone}" data-testid="verification">${esc(verdict.label)}</span></div>
    <p class="muted small">Agent ${esc(config.agent.agent_id)} in the agent registry. It signs with ${addr(config.agent.signer, config.explorer)} and holds no funds.</p>
    <p>${esc(verdict.detail)}</p>
    ${fixture ? '<p class="banner warn small" data-testid="fixture">On this local network the verification is SIMULATED test data, not a real assessment.</p>' : ''}
    ${covered ? `<dl class="facts">
      <dt>Checked and passed</dt><dd>${esc(covered.passed.join(', ') || 'nothing')}</dd>
      ${covered.failed.length ? `<dt>Failed</dt><dd class="bad-text">${esc(covered.failed.join(', '))}</dd>` : ''}
      ${covered.inconclusive.length ? `<dt>Inconclusive</dt><dd>${esc(covered.inconclusive.join(', '))}</dd>` : ''}
      <dt>Not checked</dt><dd>${esc(covered.notChecked.join(', ') || 'nothing')}</dd>
      <dt>Verified by</dt><dd>${addr(config.provider.address, config.explorer)}</dd>
    </dl>` : ''}
    <p class="muted small">Your wallet reads this verification itself before every payment. If it expires or is revoked, payments stop.</p>
  </div>`;
}
