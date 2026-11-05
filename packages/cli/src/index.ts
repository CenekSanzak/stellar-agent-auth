#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { Environment } from '@stellar-agent-auth/sdk';
import { agentCommands } from './commands/agent.js';
import { executeCommands } from './commands/execute.js';
import { historyCommand } from './commands/history.js';
import { keysCommands } from './commands/keys.js';
import { policyCommands } from './commands/policy.js';
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
  keys: keysCommands,
};

const GLOBAL_OPTIONS = {
  json: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  network: { type: 'string' }, 'rpc-url': { type: 'string' }, source: { type: 'string' },
  'sponsor-url': { type: 'string' }, 'state-dir': { type: 'string' }, 'max-fee': { type: 'string' },
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
    '  --sponsor-url <url>   Submitter that pays fees (default SUBMITTER_URL; bearer token in SUBMITTER_TOKEN)',
    '  --source <key>        Fee-paying transaction source when no sponsor is used',
    '  --state-dir <dir>     Transaction journal location (default .local/cli)',
    '  --max-fee <stroops>   Highest total fee accepted (default 50000000; 100000000 for wallet create)',
    '', 'Contracts come from AGENT_REGISTRY_ID, VERIFICATION_REGISTRY_ID and WALLET_ID, or the matching flags.',
    'Key references: file:<path> (owner-only), env:<NAME>, or a name under STELLAR_AGENT_AUTH_KEY_DIR (.local/keys).',
    '', `Exit codes: ${EXIT.ok} success, ${EXIT.usage} usage, ${EXIT.rejected} refused before submission, `
      + `${EXIT.failed} submitted but not applied, ${EXIT.pending} outcome pending (do not retry), ${EXIT.error} other.`);
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
      stateDir: values['state-dir'] as string | undefined, maxFee: values['max-fee'] as string | undefined,
    };
    const strings: Record<string, string | undefined> = {};
    const flags: Record<string, boolean | undefined> = {};
    for (const [name, type] of Object.entries(command.options)) {
      if (type === 'string') strings[name] = values[name] as string | undefined;
      else flags[name] = values[name] as boolean | undefined;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`stellar-agent-auth: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.error;
  });
}
