import { addr, esc, toHex, utc } from '../format.js';
import { coverage, verificationVerdict } from '../model.js';
import type { State } from '../state.js';

/** The agent the owner is asked to trust: who controls it, which key signs for it, and what was verified. */
export function renderAgent(state: State): string {
  const { config, agent } = state;
  if (!config) return '';
  if (!agent) return '<div class="card"><h2>Agent</h2><p class="muted">Reading the agent registry…</p></div>';
  const verdict = verificationVerdict({ ...agent, now: state.now });
  const { identity, result } = agent;
  const fixture = config.provider.mode === 'Fixture' || result?.mode === 'Fixture';
  const cover = result ? coverage(result) : undefined;
  const list = (items: readonly string[]) => (items.length ? esc(items.join(', ')) : '<span class="muted">none</span>');
  return `<div class="card">
    <div class="card-head">
      <h2>Agent ${esc(config.agent.agent_id)}</h2>
      <span class="badge ${verdict.tone}" data-testid="verification-status">${esc(verdict.label)}</span>
    </div>
    <p>${esc(verdict.detail)}</p>
    ${fixture ? `<p class="banner warn" data-testid="fixture-label"><strong>Simulated result.</strong> This deployment uses a
      fixture provider. Its result is test data, not an assessment of any real agent.</p>` : ''}
    ${identity ? `<dl class="facts">
      <dt>Signing key</dt><dd>${addr(identity.signer)}</dd>
      <dt>Controller</dt><dd>${addr(identity.controller)}</dd>
      <dt>Revision</dt><dd>${esc(identity.revision)}</dd>
      <dt>Metadata</dt><dd><span class="wrap">${esc(identity.metadata_uri)}</span>
        <code class="hash" title="${esc(toHex(identity.metadata_hash))}">sha256 ${esc(toHex(identity.metadata_hash).slice(0, 12))}…</code></dd>
      <dt>Provider</dt><dd>${addr(config.provider.address)} <span class="tag">${esc(config.provider.mode)}</span></dd>
    </dl>` : ''}
    ${result && cover ? `<h3>What the result covers</h3>
    <dl class="facts">
      <dt>Passed</dt><dd>${list(cover.passed)}</dd>
      ${cover.failed.length ? `<dt>Failed</dt><dd>${list(cover.failed)}</dd>` : ''}
      <dt>Inconclusive</dt><dd>${list(cover.inconclusive)}</dd>
      <dt>Not checked</dt><dd>${list(cover.notChecked)}</dd>
      <dt>Risk score</dt><dd>${result.risk_score === null ? '<span class="muted">none</span>' : esc(result.risk_score)} of 100</dd>
      <dt>Issued</dt><dd>${esc(utc(result.issued_at))}</dd>
      <dt>Expires</dt><dd>${esc(utc(result.expires_at))}</dd>
    </dl>
    <p class="muted small">The verifier is limited. A check listed as not checked says nothing either way about the agent.</p>` : ''}
  </div>`;
}
