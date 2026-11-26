import { fromContractUnits } from '@stellar-agent-auth/sdk';
import { addr, esc } from '../format.js';
import { policyBudget, policySentences, policyStatus, type Tone } from '../model.js';
import type { State } from '../state.js';

/**
 * The form for a new policy. It is rendered once and read when submitted, so refreshing the page's data never
 * disturbs what the owner is typing. The agent, provider, asset and recipient come from the deployment.
 */
export function renderPolicyForm(state: State): string {
  const { config, session } = state;
  if (!config || !session?.deployed) return '';
  const { asset } = config;
  return `<div class="card">
    <div class="card-head"><h2>Let the agent pay</h2></div>
    <p>A policy is a standing permission you approve once. The wallet checks every payment against it, and against the
    agent's identity and verification result at that moment.</p>
    <form data-form="policy" class="grid">
      <label>Per payment, ${esc(asset.code)} <input name="perPayment" inputmode="decimal" value="5" required /></label>
      <label>Per UTC day, ${esc(asset.code)} <input name="perDay" inputmode="decimal" value="20" required /></label>
      <label>In total, ${esc(asset.code)} <input name="total" inputmode="decimal" placeholder="no overall cap" /></label>
      <label>Valid for, days <input name="days" type="number" min="1" max="365" value="7" required /></label>
      <label>Highest risk score <input name="maxRisk" type="number" min="0" max="100" value="10" required /></label>
      <label>Oldest result, days <input name="maxAgeDays" type="number" min="1" max="365" value="30" required /></label>
      <label class="check wide"><input name="allowService" type="checkbox" checked />
        Also let it pay the demo service ${addr(config.service.contract)} (${esc(config.service.price)} ${esc(asset.code)} per call)</label>
      <dl class="facts wide">
        <dt>Agent</dt><dd>${esc(config.agent.agent_id)}, signing as ${addr(config.agent.signer)}</dd>
        <dt>May pay</dt><dd>${addr(config.roles.recipient)} only</dd>
        <dt>May not pay</dt><dd>anyone else, for example ${addr(config.roles.stranger)}</dd>
      </dl>
      <button type="submit" class="primary wide">Approve this policy</button>
    </form>
  </div>`;
}

const STATUS: Record<ReturnType<typeof policyStatus>, { tone: Tone; label: string }> = {
  active: { tone: 'good', label: 'Active' }, revoked: { tone: 'bad', label: 'Revoked' },
  expired: { tone: 'muted', label: 'Expired' }, 'not-yet-valid': { tone: 'muted', label: 'Not yet valid' },
};

/** Every policy this wallet has had, with what is left of today's budget, and what the agent can be asked to try. */
export function renderPolicies(state: State): string {
  const { config, session } = state;
  if (!config || !session?.deployed) return '';
  if (!state.policies.length) {
    return '<div class="card"><div class="card-head"><h2>Policies</h2></div><p class="muted">None yet. Without one, the agent can do nothing.</p></div>';
  }
  const { asset } = config;
  const units = (value: bigint) => `${esc(fromContractUnits(value, asset.decimals))} ${esc(asset.code)}`;
  return `<div class="card"><div class="card-head"><h2>Policies</h2></div>${state.policies.map(({ hash, policy, state: stored }) => {
    const status = policyStatus(policy, stored, state.now);
    const { tone, label } = STATUS[status];
    const budget = policyBudget(policy, stored, asset);
    return `<article class="policy" data-testid="policy" data-policy="${esc(hash)}" data-status="${esc(status)}">
      <div class="card-head"><h3>Policy <code title="${esc(hash)}">${esc(hash.slice(0, 12))}…</code></h3>
        <span class="badge ${tone}" data-testid="policy-status">${esc(label)}</span></div>
      <ul class="sentences">${policySentences(policy, asset, state.now).map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
      ${budget ? `<div class="meter" role="img" aria-label="${esc(budget.share)} percent of today's limit spent"><span style="width:${budget.share}%"></span></div>
      <p class="small" data-testid="policy-budget">Spent today: ${units(budget.spentToday)} of ${units(budget.perDay)}. Left today: <strong>${units(budget.leftToday)}</strong>.${budget.total === null ? ''
      : ` Spent in total: ${units(budget.spentEver)} of ${units(budget.total)}.`}</p>` : ''}
      ${status === 'active' ? `<div class="actions"><button class="danger" data-action="revoke" data-policy="${esc(hash)}">Revoke this policy</button></div>` : ''}
      <div class="agent-panel">
        <h4>Ask the agent to…</h4>
        <p class="muted small">These run in the agent's own process with the agent's key. This page cannot sign for the agent.${status === 'active' ? ''
      : ' This policy is no longer active, so the wallet should refuse each of them.'}</p>
        <ul class="scenarios">${config.scenarios.map((scenario) => `<li><button data-action="scenario" data-scenario="${esc(scenario.id)}"
          data-policy="${esc(hash)}">${esc(scenario.label)}</button><span class="muted small">${esc(scenario.description)}</span></li>`).join('')}</ul>
      </div>
    </article>`;
  }).join('')}</div>`;
}
