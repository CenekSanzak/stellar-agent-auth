#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { Environment } from '@stellar-agent-auth/sdk';
import { isMainModule } from '@stellar-agent-auth/sdk/node';
import { agentCommands } from './commands/agent.js';
import { executeCommands } from './commands/execute.js';
import { historyCommand } from './commands/history.js';
import { keysCommands } from './commands/keys.js';
import { policyCommands } from './commands/policy.js';
import { txCommands } from './commands/tx.js';
import { verifyCommands } from './commands/verify.js';
import { walletCommands } from './commands/wallet.js';
import { EXIT, Runtime, UsageError, classify, toJson, type GlobalOptions, type Io } from './runtime.js';

/**
 * `stellar-agent-auth`: one command per SDK workflow. Results go to stdout, as JSON with `--json`; diagnostics go to
 * stderr. Keys are passed as references (`file:<path>`, `env:<NAME>` or a key name), never as secrets.
 */

export interface Command {
  summary: string;
  options: Record<string, 'string' | 'boolean'>;
  /** `false` for a command with a side effect that cannot be simulated; `--dry-run` is then refused, not ignored. */
  dryRun?: false;
  /**
   * `true` for a command a sponsor is meant to pay for: an agent's payment, or funding. `SUBMITTER_URL` applies to
   * these only. Every other command pays for itself unless `--sponsor-url` is passed on its own command line.
   */
  sponsored?: true;
  run(
    runtime: Runtime, values: Record<string, string | undefined>, flags: Record<string, boolean | undefined>,
  ): Promise<Record<string, unknown>>;
}

export const COMMANDS: Record<string, Record<string, Command> | Command> = {
  agent: agentCommands,
  verify: verifyCommands,
  wallet: walletCommands,
  policy: policyCommands,
  execute: executeCommands,
  history: historyCommand,
  tx: txCommands,
  keys: keysCommands,
};

const GLOBAL_OPTIONS = {
  json: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  network: { type: 'string' }, 'rpc-url': { type: 'string' }, source: { type: 'string' },
  'sponsor-url': { type: 'string' }, direct: { type: 'boolean' }, 'state-dir': { type: 'string' },
  'max-fee': { type: 'string' },
} as const satisfies ParseArgsConfig['options'];

const isCommand = (value: Record<string, Command> | Command): value is Command => typeof value.run === 'function';

function usage(): string {
  const lines = ['Usage: stellar-agent-auth <group> <command> [options]', ''];
  for (const [group, entry] of Object.entries(COMMANDS)) {
    if (isCommand(entry)) lines.push(`  ${group.padEnd(20)} ${entry.summary}`);
    else for (const [name, command] of Object.entries(entry)) lines.push(`  ${`${group} ${name}`.padEnd(20)} ${command.summary}`);
  }
  lines.push('', 'Global options:',
    '  --json                Print results as one JSON object',
    '  --dry-run             Simulate with enforced authorization; sign nothing for submission and send nothing',
    '  --network <name>      local or testnet (default STELLAR_NETWORK)',
    '  --rpc-url <url>       RPC endpoint (default STELLAR_RPC_URL)',
    '  --sponsor-url <url>   Submitter that pays fees (bearer token in SUBMITTER_TOKEN). SUBMITTER_URL is the default',
    '                        for execute, wallet fund and tx status --operation only; other commands pay directly',
    '  --direct              Use no sponsor, whatever SUBMITTER_URL says',
    '  --source <key>        Fee-paying transaction source when no sponsor is used',
    '  --state-dir <dir>     Transaction journal location (default STELLAR_AGENT_AUTH_STATE_DIR, else',
    '                        ~/.local/state/stellar-agent-auth); one journal per network inside it',
    '  --max-fee <stroops>   Highest total fee accepted (default 50000000; 100000000 for wallet create)',
    '', 'Contracts come from AGENT_REGISTRY_ID, VERIFICATION_REGISTRY_ID and WALLET_ID, or the matching flags.',
    'Key references: file:<path> (owner-only), env:<NAME>, or a name under STELLAR_AGENT_AUTH_KEY_DIR (.local/keys).',
    '', `Exit codes: ${EXIT.ok} success, ${EXIT.usage} usage, ${EXIT.rejected} refused before submission, `
      + `${EXIT.failed} submitted but not applied, ${EXIT.pending} outcome not yet known (never repeat the command; `
      + `use "tx status"), ${EXIT.earlier} an earlier submission settled and was reported instead, ${EXIT.error} other.`);
  return lines.join('\n');
}

function render(result: Record<string, unknown>): string {
  return Object.entries(result).map(([key, value]) => {
    const text = typeof value === 'object' && value !== null ? toJson(value, 2) : toJson(value);
    return `${key}: ${typeof value === 'string' ? value : text}`;
  }).join('\n');
}

const defaultIo: Io = { out: (text) => process.stdout.write(`${text}\n`), err: (text) => process.stderr.write(`${text}\n`) };

export async function main(argv: string[], env: Environment, io: Io = defaultIo): Promise<number> {
  const [group, maybeName] = argv;
  const entry = group ? COMMANDS[group] : undefined;
  if (!entry || group === 'help' || group === '--help' || group === '-h') {
    (entry || group === 'help' || group === '--help' || group === '-h' ? io.out : io.err)(usage());
    return entry || group === 'help' || group === '--help' || group === '-h' ? EXIT.ok : EXIT.usage;
  }
  const command = isCommand(entry) ? entry : maybeName ? entry[maybeName] : undefined;
  if (!command) {
    io.err(usage());
    return EXIT.usage;
  }
  const rest = argv.slice(isCommand(entry) ? 1 : 2);
  let json = rest.includes('--json');
  try {
    const options = Object.fromEntries(Object.entries(command.options).map(([name, type]) => [name, { type }]));
    const { values, positionals } = parseArgs({
      args: rest, strict: true, allowPositionals: false, options: { ...GLOBAL_OPTIONS, ...options },
    }).valueOf() as { values: Record<string, string | boolean | undefined>; positionals: string[] };
    if (positionals.length) throw new UsageError(`Unexpected argument ${positionals[0]}`);
    if (values['help']) {
      io.out(`${group}${isCommand(entry) ? '' : ` ${maybeName}`}: ${command.summary}`);
      return EXIT.ok;
    }
    json = Boolean(values['json']);
    const global: GlobalOptions = {
      json, dryRun: Boolean(values['dry-run']),
      network: values['network'] as string | undefined, rpcUrl: values['rpc-url'] as string | undefined,
      source: values['source'] as string | undefined, sponsorUrl: values['sponsor-url'] as string | undefined,
      direct: Boolean(values['direct']), envSponsor: command.sponsored === true,
      stateDir: values['state-dir'] as string | undefined, maxFee: values['max-fee'] as string | undefined,
    };
    const strings: Record<string, string | undefined> = {};
    const flags: Record<string, boolean | undefined> = {};
    for (const [name, type] of Object.entries(command.options)) {
      if (type === 'string') strings[name] = values[name] as string | undefined;
      else flags[name] = values[name] as boolean | undefined;
    }
    if (global.direct && global.sponsorUrl) throw new UsageError('--direct and --sponsor-url contradict each other');
    if (global.dryRun && command.dryRun === false) {
      throw new UsageError('--dry-run is not supported by this command: its effect cannot be simulated');
    }
    const runtime = new Runtime(env, global);
    await runtime.ensureState();
    const result = await command.run(runtime, strings, flags);
    io.out(json ? toJson({ ok: true, ...result }) : render(result));
    return EXIT.ok;
  } catch (error) {
    const parseError = (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    const { code, message, result } = parseError
      ? { code: EXIT.usage, message: (error as Error).message, result: { status: 'usage' } }
      : classify(error);
    if (json) io.out(toJson({ ok: false, exit_code: code, message, ...result }));
    else if (Object.keys(result).length > 1) io.out(render(result));
    io.err(`stellar-agent-auth: ${message}`);
    if (env['STELLAR_AGENT_AUTH_DEBUG'] && error instanceof Error && error.stack) io.err(error.stack);
    return code;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`stellar-agent-auth: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.error;
  });
}
