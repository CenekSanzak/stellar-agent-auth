import type { Config } from '../backend.js';
import { addr, esc } from '../format.js';
import { coverage, verificationVerdict } from '../model.js';
import { phaseOf, type OwnAgent, type State } from '../state.js';
import { allowanceCard } from './wallet.js';
import { taskList } from './work.js';

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

function ownAgentCard(state: State, agent: OwnAgent): string {
  const config = state.config!;
  const verdict = agent.view ? verificationVerdict({ ...agent.view, now: state.now }) : undefined;
  const covered = agent.view?.result ? coverage(agent.view.result) : undefined;
  return `<div class="card agent-card own-agent" data-testid="own-agent" data-agent="${esc(agent.agent_id)}">
    <div class="card-head"><div class="agent-title"><h3>${esc(agent.name)}</h3><span class="tag">Your agent</span></div>
      ${verdict ? `<span class="badge ${verdict.tone}" data-testid="own-agent-verification">${esc(verdict.label)}</span>` : '<span class="badge muted">Reading…</span>'}</div>
    <p class="muted small">Runs on your machine. Agent ${esc(agent.agent_id)} in the registry; it signs with ${addr(agent.signer, config.explorer)}.</p>
    ${verdict && verdict.tone !== 'good' ? `<p class="banner warn small">${esc(verdict.detail)} Your wallet will not pay for it until it is verified again; starting the agent's tools asks for that.</p>` : ''}
    ${allowanceCard(state, agent.agent_id, 'own-allowance')}
    ${covered ? `<p class="small muted">Checked and passed: ${esc(covered.passed.join(', ') || 'nothing')}. Not checked: ${esc([...covered.notChecked, ...covered.inconclusive].join(', ') || 'nothing')}.</p>` : ''}
  </div>`;
}

/** The agents the owner brought, each with its verification and its allowance. */
export function renderOwnAgents(state: State): string {
  if (phaseOf(state) !== 'ready' || !state.config || !state.wallet) return '';
  return state.own.map((agent) => ownAgentCard(state, agent)).join('');
}

/**
 * The sample agent. It runs on this site, so an allowance can be seen at work without setting anything up. It is
 * one agent among the owner's, with an allowance like any other, and the tasks it can be given.
 */
export function renderScoutCard(state: State): string {
  const { config, agent } = state;
  if (phaseOf(state) !== 'ready' || !config || !state.wallet) return '';
  const verdict = agent ? verificationVerdict({ ...agent, now: state.now }) : undefined;
  const covered = agent?.result ? coverage(agent.result) : undefined;
  return `<div class="card agent-card" data-testid="scout" data-agent="${esc(config.agent.agent_id)}">
    <div class="card-head"><div class="agent-title"><h3>Scout</h3><span class="tag">Sample agent</span></div>
      ${verdict ? `<span class="badge ${verdict.tone}" data-testid="verification">${esc(verdict.label)}</span>` : '<span class="badge muted">Reading…</span>'}</div>
    <p class="muted small">Runs on this site, so you can see an allowance at work without setting anything up. It buys from the sample sellers.</p>
    ${config.provider.mode === 'Fixture' ? '<p class="banner warn small" data-testid="fixture">On this local network the verification is SIMULATED test data, not a real assessment.</p>' : ''}
    ${verdict && verdict.tone !== 'good' ? `<p class="banner warn small">${esc(verdict.detail)}</p>` : ''}
    ${allowanceCard(state, config.agent.agent_id, 'allowance')}
    ${taskList(state)}
    ${covered ? `<p class="small muted">Checked and passed: ${esc(covered.passed.join(', ') || 'nothing')}. Not checked: ${esc([...covered.notChecked, ...covered.inconclusive].join(', ') || 'nothing')}.</p>` : ''}
  </div>`;
}

/** How to bring an agent of one's own: one sentence to paste into it. */
export function renderConnect(state: State, origin: string = typeof location === 'undefined' ? '' : location.origin): string {
  const { config, owner } = state;
  if (phaseOf(state) !== 'ready' || !config || !owner || !state.wallet) return '';
  if (!config.own_agents.setup) return '';
  return `<div class="card agent-card connect" data-testid="connect">
    <div class="card-head"><div class="agent-title"><h3>Your own AI agent</h3><span class="tag">Claude Code, Codex, any MCP host</span></div></div>
    <p class="muted small">It gets a key of its own on your machine, and spends only inside an allowance you approve here.</p>
    <ol class="steps-list">
      <li><strong>Paste this into your agent.</strong> It tells the agent to do three things on the machine it runs on, and
        that you agree to them:
        <ul class="plain" data-testid="setup-steps">${setupSteps(config).map((step) => `<li>${esc(step)}</li>`).join('')}</ul>
        <textarea class="prompt" data-testid="setup-prompt" readonly rows="6" spellcheck="false">${esc(setupPrompt(config, owner.address, origin))}</textarea>
        <button data-action="copy-prompt" data-testid="copy-prompt">${state.ui.copied ? 'Copied' : 'Copy'}</button>
        <p class="muted small">Nothing in this can spend. A careful agent may still ask you to confirm before it runs anything; that is it doing its job.</p></li>
      <li><strong>Come back here.</strong> Your agent appears in this list within a few seconds. Give it an allowance.</li>
      <li><strong>Ask it to buy something.</strong> Its purchases show up in the wallet's record as they happen.</li>
    </ol>
    ${config.own_agents.verify ? '' : '<p class="banner warn small">This server cannot verify agents at the moment, so a new agent can register but will not be paid for yet.</p>'}
    <p class="muted small">Your agent never sees your wallet's key, and this page never sees your agent's. It needs Node.js 20 or newer.</p>
  </div>`;
}

/**
 * The agents of this wallet: the owner's own first, then the two ways to get one, side by side and alike. Bringing
 * an agent of one's own is the point; the sample is there for someone who wants to see it work first.
 */
export function renderAgents(state: State, origin?: string): string {
  if (phaseOf(state) !== 'ready' || !state.config || !state.wallet) return '';
  return `<div class="section-head"><h2>Agents</h2>
      <p class="muted">Each agent has its own allowance, and can spend nothing without one. Freezing the wallet stops them all.</p></div>
    <div class="agent-grid">${renderOwnAgents(state)}${renderConnect(state, origin)}${renderScoutCard(state)}</div>`;
}
