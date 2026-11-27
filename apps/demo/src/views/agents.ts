import type { Config } from '../backend.js';
import { addr, esc, icon } from '../format.js';
import { coverage, verificationVerdict, type Verdict } from '../model.js';
import { listedAgents, openAgent, phaseOf, sampleListed, type State } from '../state.js';
import type { AgentView } from '../chain.js';
import { allowanceDetail, allowanceDialog, allowanceLine, dialogHead, withdrawDialog } from './wallet.js';
import { lastResult, taskList } from './work.js';

/** What an agent's set-up does on the owner's machine, in the order it does it. Shown to the owner, and said in the prompt. */
export function setupSteps(config: Config): string[] {
  const network = config.network === 'testnet' ? 'Stellar Testnet' : 'the local Stellar network';
  return [
    config.agent_npm_package ? `run the npm package ${config.agent_npm_package} with npx` : 'download one file, the agent tool, from this site and run it with Node.js',
    `let it create a key for the agent under ~/.stellar-agent-wallet and register the agent on ${network}`,
    'add it to the agent\'s MCP servers',
  ];
}

/**
 * What the owner pastes into their own AI agent. It names the instructions, with the owner's account in the
 * address, and it carries the owner's go-ahead for the three things the set-up does. An agent should not run a
 * program because a web page says so; it can because its user does, having seen what the program will do.
 */
export function setupPrompt(config: Config, owner: string, origin: string): string {
  const base = config.public_url ?? origin;
  const [first, second, third] = setupSteps(config);
  return `Set yourself up as the agent of my Stellar smart wallet${config.network === 'testnet' ? ' on Testnet' : ''} (test money only), `
    + `following ${base}/agent-ready.md?owner=${owner} - I know what it involves, and you have my go-ahead for its three steps: `
    + `${first}; ${second}; and ${third}.`;
}

const STATUS = { none: ['muted', 'No allowance'], active: ['good', 'Active'], frozen: ['warn', 'Frozen'] } as const;

/** One agent as a row: who it is and where its allowance stands. Unfolded, everything about it and what to do with it. */
function agentRow(state: State, agent: { id: string; name: string; sample: boolean }, view: AgentView | null, open: boolean): string {
  const config = state.config!;
  const verdict: Verdict | undefined = view ? verificationVerdict({ ...view, now: state.now }) : undefined;
  const covered = view?.result ? coverage(view.result) : undefined;
  const line = allowanceLine(state, agent.id);
  const [tone, label] = STATUS[line.status];
  const ids = agent.sample ? { row: 'scout', verification: 'verification', status: 'allowance-status', spent: 'allowance-spent' }
    : { row: 'own-agent', verification: 'own-agent-verification', status: 'own-allowance-status', spent: 'own-allowance-spent' };
  return `<article class="agent" data-testid="${ids.row}" data-agent="${esc(agent.id)}" data-allowance="${line.status}" data-open="${open}">
    <button class="agent-summary" data-action="toggle-agent" data-agent="${esc(agent.id)}" aria-expanded="${open}">
      <span class="avatar ${agent.sample ? 'sample' : ''}" aria-hidden="true">${esc(agent.name.trim().charAt(0).toUpperCase())}</span>
      <span class="agent-main">
        <span class="agent-name">${esc(agent.name)}<span class="tag">${agent.sample ? 'Sample agent' : 'Your agent'}</span></span>
        <span class="agent-sub" data-testid="${ids.spent}">${esc(line.text)}</span>
      </span>
      <span class="agent-state">
        ${verdict ? `<span class="badge ${verdict.tone}" data-testid="${ids.verification}">${esc(verdict.label)}</span>` : '<span class="badge muted">Reading…</span>'}
        <span class="badge ${tone}" data-testid="${ids.status}">${label}</span>
      </span>
      <span class="chevron">${icon('chevron')}</span>
    </button>
    ${line.status === 'none' ? '' : `<div class="meter" role="img" aria-label="${esc(line.text)}"><div class="meter-fill" style="width:${line.share}%"></div></div>`}
    ${open ? `<div class="agent-detail">
      ${agent.sample && config.provider.mode === 'Fixture' ? '<p class="banner warn small" data-testid="fixture">On this local network the verification is SIMULATED test data, not a real assessment.</p>' : ''}
      ${verdict && verdict.tone !== 'good' ? `<p class="banner warn small">${esc(verdict.detail)}${agent.sample ? '' : ' Your wallet will not pay for it until it is verified again; starting the agent\'s tools asks for that.'}</p>` : ''}
      ${allowanceDetail(state, agent.id)}
      ${agent.sample ? `${taskList(state)}${lastResult(state)}` : ''}
      <p class="small muted">${agent.sample ? 'Runs on this site.' : 'Runs on your machine.'} Agent ${esc(agent.id)} in the registry${view?.identity ? `; signs with ${addr(view.identity.signer, config.explorer)}` : ''}.
        ${covered ? `Verified for ${esc(covered.passed.join(', ') || 'nothing')}; not checked: ${esc([...covered.notChecked, ...covered.inconclusive].join(', ') || 'nothing')}.` : ''}</p>
    </div>` : ''}
  </article>`;
}

/** The two ways to get an agent, as equals: bring your own, or try the sample. */
export function addOptions(state: State): string {
  const { config } = state;
  if (!config) return '';
  return `<div class="options">
    ${config.own_agents.setup ? `<div class="option" data-testid="connect">
      <h3>Your own AI agent</h3>
      <p class="muted">Claude Code, Codex or any MCP host. It gets a key of its own on your machine, and spends only inside an allowance you approve here.</p>
      <button data-action="dialog" data-dialog="connect">Connect an agent${icon('arrow')}</button>
    </div>` : ''}
    ${sampleListed(state) ? '' : `<div class="option" data-testid="sample">
      <h3>Scout, a sample agent</h3>
      <p class="muted">Runs on this site and buys from sample sellers. See an allowance at work without setting anything up.</p>
      <button data-action="try-sample">Try Scout${icon('arrow')}</button>
    </div>`}
  </div>`;
}

/** The agents of this wallet. With none, the two ways to get one; otherwise a row each, and a way to add another. */
export function renderAgents(state: State): string {
  if (phaseOf(state) !== 'ready' || state.ui.tab !== 'agents' || !state.config || !state.wallet) return '';
  if (!state.agentsRead) return '<p class="muted" data-testid="agents-reading">Reading your agents and their allowances…</p>';
  const listed = listedAgents(state);
  if (!listed.length) {
    return `<div class="empty"><h2>Add your first agent</h2>
      <p class="muted">An agent can spend from this wallet only inside an allowance you give it.</p>${addOptions(state)}</div>`;
  }
  const open = openAgent(state);
  const viewOf = (id: string) => (id === state.config!.agent.agent_id ? state.agent : state.own.find((agent) => agent.agent_id === id)?.view ?? null);
  return `<div class="section-head"><p class="muted">Each agent spends only inside its own allowance.</p>
      <button data-action="dialog" data-dialog="add" data-testid="add-agent">${icon('plus')}Add agent</button></div>
    <div class="agent-list">${listed.map((agent) => agentRow(state, agent, viewOf(agent.id), open === agent.id)).join('')}</div>`;
}

/** How to bring an agent of one's own: one sentence to paste into it, and what that sentence agrees to. */
export function connectDialog(state: State, origin: string): string {
  const { config, owner } = state;
  if (!config || !owner) return '';
  return `<div class="form" data-testid="connect-dialog">
    ${dialogHead('Connect your own AI agent')}
    <ol class="steps-list">
      <li><strong>Paste this into your agent.</strong>
        <textarea class="prompt" data-testid="setup-prompt" readonly rows="8" spellcheck="false">${esc(setupPrompt(config, owner.address, origin))}</textarea>
        <button class="primary" data-action="copy-prompt" data-testid="copy-prompt">${icon(state.ui.copied ? 'check' : 'copy')}${state.ui.copied ? 'Copied' : 'Copy'}</button>
        <p class="muted small">It tells the agent to do three things on its machine, and that you agree to them:</p>
        <ul class="plain" data-testid="setup-steps">${setupSteps(config).map((step) => `<li>${esc(step)}</li>`).join('')}</ul></li>
      <li><strong>Wait a moment.</strong> <span class="muted">Your agent appears here by itself once it has registered. A careful agent may ask you to confirm first.</span></li>
      <li><strong>Give it an allowance.</strong> <span class="muted">Until then it can spend nothing.</span></li>
    </ol>
    ${config.own_agents.verify ? '' : '<p class="banner warn small">This server cannot verify agents at the moment, so a new agent can register but will not be paid for yet.</p>'}
    <p class="muted small">Your agent never sees your wallet's key, and this page never sees your agent's. It needs Node.js 20 or newer.</p>
  </div>`;
}

/**
 * The window that is open over the page, if any, as `[key, html]`. The key changes when the window has to be drawn
 * again; while it stays the same the window is left alone, so that typing in a form survives a refresh.
 */
export function renderDialog(state: State, origin: string): [string, string] {
  const { dialog } = state.ui;
  if (phaseOf(state) !== 'ready' || !dialog || !state.config) return ['', ''];
  switch (dialog.kind) {
    case 'add':
      return ['add', `<div class="form">${dialogHead('Add an agent')}${addOptions(state)}</div>`];
    case 'connect':
      return [`connect:${state.ui.copied}`, connectDialog(state, origin)];
    case 'withdraw':
      return ['withdraw', withdrawDialog(state)];
    case 'allowance': {
      const html = allowanceDialog(state);
      return html ? [`allowance:${dialog.agent}`, html] : ['', ''];
    }
  }
}
