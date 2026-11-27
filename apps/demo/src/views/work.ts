import type { Content, Step } from '../backend.js';
import { clock, esc, money, tx } from '../format.js';
import { allowanceView, explainStep, stageVerdict } from '../model.js';
import { phaseOf, taskAllowance, type Activity, type State } from '../state.js';

/** What Scout can be asked to do. */
export function renderTasks(state: State): string {
  const { config } = state;
  if (phaseOf(state) !== 'ready' || !config) return '';
  const ready = taskAllowance(state) !== undefined;
  return `<div class="card tasks">
    <div class="card-head"><h2>Ask Scout</h2>${state.busy ? `<span class="working" data-testid="busy">${esc(state.busy)}…</span>` : ''}</div>
    ${ready ? '' : '<p class="muted">Approve an allowance first. Until then Scout has no way to pay for anything.</p>'}
    <ul class="task-list">${config.tasks.map((task) => `<li>
      <button class="task" data-action="task" data-task="${esc(task.id)}" ${ready ? '' : 'disabled'}>
        <span class="task-label">${esc(task.label)}</span>
        <span class="task-text">${esc(task.description)}</span>
      </button></li>`).join('')}</ul>
  </div>`;
}

const SHOWN_ROWS = 5;

function renderContent(content: Content, id: number, index: number, open: boolean): string {
  const rows = content.table ? (open ? content.table.rows : content.table.rows.slice(0, SHOWN_ROWS)) : [];
  return `<div class="bought">
    <p class="bought-title">${esc(content.title)}</p>
    <p>${esc(content.summary)}</p>
    ${content.facts.length ? `<dl class="facts">${content.facts.map((fact) => `<dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd>`).join('')}</dl>` : ''}
    ${content.table ? `<div class="table-wrap"><table><thead><tr>${content.table.columns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell.length > 20 ? `<code title="${esc(cell)}">${esc(cell.slice(0, 12))}…</code>` : esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${content.table.rows.length > SHOWN_ROWS ? `<button class="quiet small" data-action="toggle-table" data-id="${id * 100 + index}">${open ? 'Show fewer rows' : `Show all ${content.table.rows.length} rows`}</button>` : ''}` : ''}
    <p class="muted small">${esc(content.source)}</p>
  </div>`;
}

function renderStep(step: Step, index: number, item: Activity, state: State): string {
  const config = state.config!;
  const vendor = config.vendors.find(({ id }) => id === step.vendor)?.name ?? step.vendor;
  const used = state.policies.find((policy) => policy.hash === item.policy);
  const allowance = used ? allowanceView(used.policy, used.state, config.asset, state.now) : undefined;
  const verdict = explainStep(step, { vendor, code: config.asset.code, allowance });
  const price = step.amount ? `${money(step.amount)} ${config.asset.code}` : 'an unknown price';
  return `<li class="step" data-status="${esc(step.status)}" data-error="${esc(step.error ?? '')}" data-vendor="${esc(step.vendor)}">
    <div class="step-head"><span class="badge ${verdict.tone}">${esc(verdict.label)}</span>
      <span><strong>${esc(price)}</strong> to ${esc(vendor)} for “${esc(step.title)}”</span>
      ${step.tx_hash ? tx(step.tx_hash, config.explorer, 'transaction') : ''}</div>
    ${verdict.detail ? `<p class="reason">${esc(verdict.detail)}</p>` : ''}
    ${step.content ? renderContent(step.content, item.id, index, state.ui.tables.includes(item.id * 100 + index)) : ''}
  </li>`;
}

/** What was asked for and what came of it, newest first. */
export function renderActivity(state: State): string {
  const { config } = state;
  if (!config || phaseOf(state) === 'loading' || phaseOf(state) === 'welcome') return '';
  if (!state.activity.length) {
    return phaseOf(state) === 'ready'
      ? '<div class="card"><h2>Activity</h2><p class="muted">Nothing yet. What you and Scout do appears here.</p></div>' : '';
  }
  return `<div class="card"><h2>Activity</h2>
    <ol class="feed">${state.activity.map((item) => {
    const verdict = stageVerdict(item.stage);
    const steps = item.result?.steps ?? [];
    const paid = steps.filter((step) => step.status === 'paid').length;
    // A task is summed up by what it bought; an owner action by how far it has got.
    const badge = item.kind !== 'task' || !item.result ? `<span class="badge ${verdict.tone}">${esc(verdict.label)}</span>`
      : `<span class="badge ${paid === steps.length ? 'good' : paid ? 'warn' : 'muted'}">${paid} of ${steps.length} bought</span>`;
    return `<li class="feed-item" data-testid="activity" data-kind="${esc(item.kind)}" data-stage="${esc(item.stage)}">
        <div class="feed-head"><strong>${esc(item.title)}</strong>${badge}<span class="time">${esc(clock(item.at))}</span></div>
        ${item.detail ? `<p class="small">${esc(item.detail)}</p>` : ''}
        ${item.kind !== 'task' && item.hash ? `<p class="small">${tx(item.hash, config.explorer, 'View the transaction')}</p>` : ''}
        ${item.result && item.result.notes.length > 1 ? `<ul class="notes">${item.result.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
        ${steps.length ? `<ul class="steps">${steps.map((step, index) => renderStep(step, index, item, state)).join('')}</ul>` : ''}
      </li>`;
  }).join('')}</ol></div>`;
}
