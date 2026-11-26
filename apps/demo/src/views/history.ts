import { addr, esc, utc } from '../format.js';
import { describeOutcome, explainRefusal, stageVerdict, type Tone } from '../model.js';
import type { State } from '../state.js';

const txLink = (explorer: string | null, hash: string) => (explorer
  ? `<a href="${esc(explorer)}/tx/${esc(hash)}" target="_blank" rel="noreferrer"><code title="${esc(hash)}">${esc(hash.slice(0, 10))}…</code></a>`
  : `<code title="${esc(hash)}">${esc(hash.slice(0, 10))}…</code>`);

const COMPLETENESS: Record<string, { tone: Tone; label: string }> = {
  verified: { tone: 'good', label: 'Complete and verified' },
  incomplete: { tone: 'warn', label: 'Incomplete' },
  mismatch: { tone: 'bad', label: 'Does not match the wallet' },
};

/**
 * What the wallet recorded, and what it refused. The two are kept apart on purpose: an audit entry is on the
 * ledger and is checked here against the wallet's stored head; a refusal left nothing on the ledger and is only
 * what the agent's process reported.
 */
export function renderHistory(state: State): string {
  const { config, session, history } = state;
  if (!config || !session?.deployed) return '';
  const head = '<div class="card-head"><h2>History</h2>';
  if (!history) {
    return `<div class="card">${head}</div><p class="muted">${state.historyError ? esc(`The history could not be read: ${state.historyError}`) : 'Reading the history…'}</p></div>`;
  }
  const completeness = COMPLETENESS[history.status]!;
  const entries = [...history.entries].reverse();
  return `<div class="card">
    ${head}<span class="badge ${completeness.tone}" data-testid="history-status">${esc(completeness.label)}</span></div>
    <p>${esc(history.detail)}. <span class="muted">Each entry was hashed and linked again in this page and compared with the
    head read from the wallet, sequence ${esc(history.head.sequence)}.</span></p>
    ${history.status !== 'verified' ? `<p class="banner ${completeness.tone}">Do not treat this list as the whole history.
      ${history.indexer ? `The indexer itself reports: ${esc(history.indexer.status)}, ${esc(history.indexer.detail)}.` : ''}</p>` : ''}
    <h3>On the ledger</h3>
    ${entries.length ? `<table data-testid="entries"><thead><tr><th>#</th><th>When</th><th>What</th><th>By</th><th>Transaction</th></tr></thead><tbody>
      ${entries.map((record) => {
    const text = describeOutcome(record.entry.outcome, config.asset);
    return `<tr data-kind="${esc(record.entry.outcome.kind)}"><td>${esc(record.entry.sequence)}</td><td>${esc(utc(record.entry.timestamp))}</td>
          <td><strong class="${text.tone}">${esc(text.title)}</strong><br /><span class="small">${esc(text.detail)}</span></td>
          <td>${addr(record.entry.actor)}</td><td>${txLink(config.explorer, record.transaction)}</td></tr>`;
  }).join('')}</tbody></table>` : '<p class="muted">Nothing yet.</p>'}
    <h3>Refused or failed</h3>
    <p class="muted small">These are not on the ledger. A refusal is found before anything is submitted, so there is no
    transaction to link to. They are listed as the agent's process reported them.</p>
    ${state.attempts.length ? `<table data-testid="attempts"><thead><tr><th>When</th><th>Kind</th><th>Why</th><th>Transaction</th></tr></thead><tbody>
      ${[...state.attempts].reverse().map((attempt) => `<tr data-error="${esc(attempt.error ?? '')}"><td>${esc(attempt.recorded_at.slice(0, 19).replace('T', ' '))} UTC</td>
        <td>${attempt.kind === 'simulation' ? 'Refused before submission' : 'Failed on the ledger'}</td>
        <td>${esc(explainRefusal(attempt.error))}</td>
        <td>${attempt.tx_hash ? txLink(config.explorer, attempt.tx_hash) : '<span class="muted">none</span>'}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">None.</p>'}
  </div>`;
}

/** Who is connected, and how. */
export function renderConnection(state: State): string {
  const { config, owner } = state;
  if (!config) return '';
  if (owner) {
    return `<span class="tag">${esc(config.network)}</span>
      <span data-testid="owner">${addr(owner.address)}</span>
      <span class="muted small">${owner.kind === 'freighter' ? 'Freighter' : 'local demo key'}</span>`;
  }
  return `<div class="actions">
      <button class="primary" data-action="connect-freighter">Connect Freighter</button>
      ${config.network === 'local' ? '<button data-action="connect-local">Use a local demo key</button>' : ''}
    </div>
    ${state.connectError ? `<p class="banner bad" data-testid="connect-error">${esc(state.connectError)}</p>` : ''}`;
}

/** Problems that stop the page, and reads that failed. */
export function renderNotice(state: State): string {
  if (state.fatal) return `<p class="banner bad" data-testid="fatal">${esc(state.fatal)}</p>`;
  if (!state.config) return '<p class="muted" data-testid="loading">Loading the deployment…</p>';
  if (state.readError) return `<p class="banner warn" data-testid="read-error">Some data could not be read and may be out of date: ${esc(state.readError)}</p>`;
  return '';
}

/** What was asked for and how far each thing has got, newest first. */
export function renderActivity(state: State): string {
  if (!state.config) return '';
  const explorer = state.config.explorer;
  return `<h2>Activity</h2>${state.busy ? `<p class="working" data-testid="busy">${esc(state.busy)}…</p>` : ''}
    ${state.activity.length ? '' : '<p class="muted small">Nothing yet. What you and the agent do appears here.</p>'}
    <ol class="activity">${state.activity.map((item) => {
    const verdict = stageVerdict(item.stage);
    return `<li data-testid="activity" data-stage="${esc(item.stage)}">
        <div class="card-head"><strong>${esc(item.title)}</strong><span class="badge ${verdict.tone}">${esc(verdict.label)}</span></div>
        ${item.steps ? `<ul class="steps">${item.steps.map((step) => `<li data-status="${esc(step.status)}" data-error="${esc(step.error ?? '')}">
          <span class="badge ${step.status === 'paid' ? 'good' : step.status === 'unsettled' ? 'warn' : 'bad'}">${esc(step.status)}</span>
          ${esc(step.amount)} ${esc(state.config!.asset.code)} to ${addr(step.recipient)}
          ${step.status === 'paid' ? '' : `<br /><span class="small">${esc(step.status === 'unsettled' ? step.detail ?? '' : explainRefusal(step.error))}</span>`}
          ${step.tx_hash ? `<br />${txLink(explorer, step.tx_hash)}` : ''}</li>`).join('')}</ul>
          <p class="muted small">Expected: ${esc(item.expected === 'paid' ? 'paid' : `refused with ${item.expected}`)}.</p>`
    : `<p class="small">${esc(item.detail || verdict.detail)}</p>`}
        ${item.hash ? `<p class="small">${txLink(explorer, item.hash)}</p>` : ''}
      </li>`;
  }).join('')}</ol>`;
}
