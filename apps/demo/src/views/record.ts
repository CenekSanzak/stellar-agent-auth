import { addr, esc, tx, utc } from '../format.js';
import { describeOutcome, explainRefusal, policySentences, policyStatus, type Tone } from '../model.js';
import { phaseOf, type State } from '../state.js';

const COMPLETENESS: Record<string, { tone: Tone; label: string }> = {
  verified: { tone: 'good', label: 'Verified against the wallet' },
  incomplete: { tone: 'warn', label: 'Incomplete' },
  mismatch: { tone: 'bad', label: 'Does not match the wallet' },
};

/**
 * What the wallet recorded, and what was refused. The two are kept apart on purpose: an audit entry is on the
 * ledger and is checked here against the wallet's stored head; a refusal left nothing on the ledger and is only
 * what Scout's process reported.
 */
export function renderRecord(state: State): string {
  const { config, session, history } = state;
  if (phaseOf(state) !== 'ready' || !config || !session) return '';
  const head = '<div class="card-head"><h2>The wallet\'s record</h2>';
  if (!history) {
    return `<div class="card">${head}</div><p class="muted">${state.historyError
      ? esc(`The record could not be read: ${state.historyError}`) : 'Reading the record…'}</p></div>`;
  }
  const completeness = COMPLETENESS[history.status]!;
  const entries = [...history.entries].reverse();
  const names = Object.fromEntries(config.vendors.map((vendor) => [vendor.address, vendor.name]));
  // Who did it, by name where the page knows the key.
  const actors: Record<string, string> = {
    [config.agent.signer]: 'Scout', ...Object.fromEntries(state.own.map((agent) => [agent.signer, agent.name])),
    ...(state.owner ? { [state.owner.address]: 'You' } : {}),
  };
  const count = `${entries.length} on the ledger, ${state.attempts.length} refused`;
  const open = state.ui.record;
  return `<div class="card record">
    ${head}<span class="badge ${completeness.tone}" data-testid="history-status">${esc(completeness.label)}</span></div>
    <p class="muted small">Every payment and every change you make is written by the wallet into a chain of hashes. This page
      rebuilt that chain from the indexer's copy and compared it with the wallet itself: ${esc(history.detail)}.</p>
    ${history.status !== 'verified' ? `<p class="banner ${completeness.tone}">Do not treat this list as the whole record.
      ${history.indexer ? `The indexer reports: ${esc(history.indexer.status)}, ${esc(history.indexer.detail)}.` : ''}</p>` : ''}
    <button class="quiet" data-action="toggle" data-what="record" data-testid="record-toggle">${open ? 'Hide the record' : `Show the record (${esc(count)})`}</button>
    ${open ? `<h3>On the ledger</h3>
    ${entries.length ? `<div class="table-wrap"><table data-testid="entries"><thead><tr><th>#</th><th>When</th><th>What</th><th>By</th><th></th></tr></thead><tbody>
      ${entries.map((record) => {
    const text = describeOutcome(record.entry.outcome, config.asset, names);
    return `<tr data-kind="${esc(record.entry.outcome.kind)}"><td>${esc(record.entry.sequence)}</td><td>${esc(utc(record.entry.timestamp))}</td>
          <td><strong>${esc(text.title)}</strong><br /><span class="small muted">${esc(text.detail)}</span></td>
          <td>${actors[record.entry.actor] ? esc(actors[record.entry.actor]) : addr(record.entry.actor)}</td><td>${tx(record.transaction, config.explorer)}</td></tr>`;
  }).join('')}</tbody></table></div>` : '<p class="muted">Nothing yet.</p>'}
    <h3>Refused</h3>
    <p class="muted small">These are not on the ledger. Scout asks the wallet before it signs, so a refused purchase is never
      sent and has no transaction. They are listed as Scout reported them.</p>
    ${state.attempts.length ? `<div class="table-wrap"><table data-testid="attempts"><thead><tr><th>When</th><th>What</th><th>Why</th></tr></thead><tbody>
      ${[...state.attempts].reverse().map((attempt) => `<tr data-error="${esc(attempt.error ?? '')}" data-status="${esc(attempt.status)}">
        <td>${esc(attempt.recorded_at.slice(0, 16).replace('T', ' '))} UTC</td>
        <td>${attempt.status === 'declined' ? 'Refused by the seller' : 'Blocked by the wallet'}<br /><span class="small muted">${esc((attempt.detail ?? '').split('. ')[0])}</span></td>
        <td class="small">${esc(explainRefusal(attempt.error))}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">None.</p>'}` : ''}
  </div>`;
}

/** The addresses and exact rules behind the page, for anyone who wants to check them elsewhere. */
export function renderDetails(state: State): string {
  const { config, session, owner } = state;
  if (phaseOf(state) !== 'ready' || !config || !session || !owner) return '';
  const open = state.ui.details;
  const link = (id: string) => addr(id, config.explorer);
  return `<div class="card details">
    <div class="card-head"><h2>Under the hood</h2>
      <button class="quiet" data-action="toggle" data-what="details">${open ? 'Hide' : 'Show addresses and rules'}</button></div>
    ${open ? `<dl class="facts">
      <dt>Network</dt><dd>${esc(config.passphrase)}</dd>
      <dt>Your account</dt><dd>${link(owner.address)}</dd>
      <dt>Your wallet contract</dt><dd>${link(session.wallet)}</dd>
      <dt>Agent registry</dt><dd>${link(config.agent_registry)}</dd>
      <dt>Verification registry</dt><dd>${link(config.verification_registry)}</dd>
      <dt>${esc(config.asset.code)} asset contract</dt><dd>${link(config.asset.contract)}, issued by ${link(config.asset.issuer)}</dd>
      <dt>Wallet code</dt><dd><code title="${esc(config.wallet_wasm_hash)}">${esc(config.wallet_wasm_hash.slice(0, 16))}…</code></dd>
      ${config.vendors.map((vendor) => `<dt>${esc(vendor.name)} is paid at</dt><dd>${link(vendor.address)}</dd>`).join('')}
    </dl>
    ${state.policies.map(({ hash, policy, state: stored }) => `<div class="policy" data-testid="policy" data-status="${policyStatus(policy, stored, state.now)}">
      <p><strong>Allowance ${esc(hash.slice(0, 12))}…</strong> <span class="badge muted">${esc(policyStatus(policy, stored, state.now))}</span></p>
      <ul class="small">${policySentences(policy, config.asset, state.now).map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
    </div>`).join('')}` : ''}
  </div>`;
}
