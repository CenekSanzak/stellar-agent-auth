#!/usr/bin/env node
import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StrKey, rpc } from '@stellar/stellar-sdk';
import {
  Sponsor, loadConfig, networkContext, sponsorPolicy, type Environment,
} from '@stellar-agent-auth/sdk';
import { FileJournal, loadKey } from '@stellar-agent-auth/sdk/node';
import { RateLimiter } from './simulation.js';
import { createHandler } from './submission.js';

export { admit, RateLimiter, RequestRejected, MAX_BODY_BYTES } from './simulation.js';
export { createHandler, type SubmitterOptions } from './submission.js';

/**
 * The private demo fee sponsor: a thin process around the SDK `Sponsor`. It sponsors only configured contracts and
 * methods, enforces a fee ceiling, a request size and rate limit, and journals every signed envelope under
 * `SUBMITTER_STATE_DIR` so a restart settles in-flight hashes before accepting new work.
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export interface SubmitterConfig {
  network: string;
  rpcUrl: string;
  passphrase: string;
  host: string;
  port: number;
  sponsorKey: string;
  contracts: string[];
  methods: string[];
  maxFee: bigint;
  timeoutSeconds: number;
  rateLimit: number;
  stateDirectory: string;
  tokenFile: string | undefined;
}

const DEFAULT_METHODS = ['execute', 'fund'];

export function submitterConfig(env: Environment): SubmitterConfig {
  const config = loadConfig(env);
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}-${max}`);
    return value;
  };
  const sponsorKey = env['SUBMITTER_SPONSOR_KEY'];
  if (!sponsorKey) throw new Error('Set SUBMITTER_SPONSOR_KEY to a key reference (file:<path>, env:<NAME> or a name)');
  const contracts = (env['SUBMITTER_CONTRACTS'] ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!contracts.length || contracts.some((id) => !StrKey.isValidContract(id))) {
    throw new Error('Set SUBMITTER_CONTRACTS to the comma-separated contract addresses to sponsor');
  }
  const methods = (env['SUBMITTER_METHODS'] ?? DEFAULT_METHODS.join(',')).split(',').map((m) => m.trim())
    .filter(Boolean);
  if (!methods.length || methods.some((method) => !/^[a-z_][a-z0-9_]{0,31}$/.test(method))) {
    throw new Error('SUBMITTER_METHODS must list contract function names');
  }
  const maxFee = BigInt(env['SUBMITTER_MAX_FEE_STROOPS'] || '5000000');
  if (maxFee <= 0n || maxFee > 100_000_000n) throw new Error('SUBMITTER_MAX_FEE_STROOPS must be 1-100000000');
  return {
    network: config.network, rpcUrl: config.rpcUrl, passphrase: config.passphrase,
    host: env['SUBMITTER_HOST'] || '127.0.0.1', port: integer('SUBMITTER_PORT', 8787, 0, 65_535),
    sponsorKey, contracts, methods, maxFee, timeoutSeconds: integer('SUBMITTER_TIMEOUT_SECONDS', 60, 5, 600),
    rateLimit: integer('SUBMITTER_RATE_LIMIT', 30, 1, 10_000),
    stateDirectory: resolve(env['SUBMITTER_STATE_DIR'] || '.local/submitter'),
    tokenFile: env['SUBMITTER_TOKEN_FILE'] || undefined,
  };
}

async function readToken(path: string) {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error('SUBMITTER_TOKEN_FILE must be readable by its owner only');
  const token = (await readFile(path, 'utf8')).trim();
  if (token.length < 32) throw new Error('SUBMITTER_TOKEN_FILE must hold at least 32 characters');
  return token;
}

/** Start the submitter; resolves once it is listening, after settling anything a previous run left in flight. */
export async function startSubmitter(env: Environment): Promise<{ server: Server; url: string; sponsor: string }> {
  const config = submitterConfig(env);
  const token = config.tokenFile ? await readToken(config.tokenFile) : undefined;
  if (!LOOPBACK.has(config.host) && !token) {
    throw new Error('A submitter listening beyond loopback requires SUBMITTER_TOKEN_FILE; it is not a public relay');
  }
  const signer = await loadKey(config.sponsorKey, env);
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.network === 'local' });
  const context = await networkContext(server, config.passphrase);
  const policy = sponsorPolicy(config.contracts, {
    methods: config.methods, limits: { maxFee: config.maxFee, timeoutSeconds: config.timeoutSeconds },
  });
  const sponsor = new Sponsor(context, signer, policy, new FileJournal(resolve(config.stateDirectory, 'journal')));
  await sponsor.recover();
  const http = createServer(createHandler({
    sponsor, policy, network: config.network, token, rateLimit: new RateLimiter(config.rateLimit),
  }));
  http.requestTimeout = (config.timeoutSeconds + 30) * 1_000;
  await new Promise<void>((resolveListen, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => resolveListen());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return { server: http, url: `http://${host}:${port}/`, sponsor: signer.address };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startSubmitter(process.env).then(({ url, sponsor }) => {
    console.log(JSON.stringify({ status: 'listening', url, sponsor }));
  }, (error: unknown) => {
    console.error(`submitter: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
