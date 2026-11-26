#!/usr/bin/env node
import { stat, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { Keypair, StrKey, rpc } from '@stellar/stellar-sdk';
import { loadConfig, readAuditHead, type Environment } from '@stellar-agent-auth/sdk';
import { isMainModule } from '@stellar-agent-auth/sdk/node';
import { createHandler, type IndexerState } from './api.js';
import { verifyWallet, type AuditReport } from './audit.js';
import { codeAdmission, ingest, networkIdOf, type Admission, type IngestReport, type StreamConfig } from './events.js';
import { HistoryStore } from './storage.js';

/**
 * The history service: follows a deployment's contract events into a SQLite file and checks each wallet's audit
 * chain against the head the wallet stores. It has no keys and no authority; it reads the network and answers
 * questions about what it has read.
 *
 * It is one process over one database file. Keep the file on a persistent disk and back it up: RPC servers retain
 * only a window of recent events, so history this process missed cannot be read again from an RPC.
 */

export { HistoryStore } from './storage.js';
export {
  codeAdmission, ingest, networkIdOf, KNOWN_TOPICS, type Admission, type EventSource, type IngestReport, type StreamConfig,
} from './events.js';
export { verifyStored, verifyWallet, type AuditReport, type AuditStatus } from './audit.js';
export { createHandler, type ApiOptions, type IndexerState } from './api.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_AUDIT_REPORTS = 2_000;

export interface IndexerConfig {
  network: string;
  rpcUrl: string;
  passphrase: string;
  databasePath: string;
  stream: StreamConfig;
  host: string;
  port: number;
  pollSeconds: number;
  tokenFile: string | undefined;
}

export function indexerConfig(env: Environment): IndexerConfig {
  const config = loadConfig(env);
  const list = (name: string) => (env[name] ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const integer = (name: string, fallback: number | undefined, min: number, max: number) => {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (value === undefined || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
  };
  const wallets = list('INDEXER_WALLETS');
  if (!wallets.length && config.contracts.WALLET_ID) wallets.push(config.contracts.WALLET_ID);
  const contracts = [
    ...list('INDEXER_CONTRACTS'),
    ...[config.contracts.AGENT_REGISTRY_ID, config.contracts.VERIFICATION_REGISTRY_ID].filter((id): id is string => !!id),
  ];
  // Wallets are followed by name, or by the code they run when each owner creates their own.
  const walletCode = list('INDEXER_WALLET_CODE').map((hash) => hash.toLowerCase());
  if (walletCode.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
    throw new Error('INDEXER_WALLET_CODE must be 64-character hex code hashes, separated by commas');
  }
  if (!wallets.length && !walletCode.length) {
    throw new Error('Set INDEXER_WALLETS (or WALLET_ID) to the wallet contract addresses to follow, or '
      + 'INDEXER_WALLET_CODE to follow every wallet that runs that code');
  }
  for (const id of [...wallets, ...contracts]) {
    if (!StrKey.isValidContract(id)) throw new Error(`${id} is not a contract address`);
  }
  return {
    network: config.network, rpcUrl: config.rpcUrl, passphrase: config.passphrase,
    databasePath: resolve(config.databasePath ?? '.local/history.sqlite'),
    stream: {
      id: `${config.network}:${config.deploymentEpoch ?? 'default'}`, networkPassphrase: config.passphrase, wallets,
      contracts: [...new Set(contracts)].filter((id) => !wallets.includes(id)),
      ...(walletCode.length ? { walletCode } : {}),
      // There is no safe default: starting late silently drops the beginning of the history.
      startLedger: integer('INDEXER_START_LEDGER', undefined, 1, 0xffff_ffff),
    },
    host: env['INDEXER_HOST'] || '127.0.0.1', port: integer('INDEXER_PORT', 8788, 0, 65_535),
    pollSeconds: integer('INDEXER_POLL_SECONDS', 5, 1, 3_600),
    tokenFile: env['INDEXER_TOKEN_FILE'] || undefined,
  };
}

async function readToken(path: string) {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error('INDEXER_TOKEN_FILE must be readable by its owner only');
  const token = (await readFile(path, 'utf8')).trim();
  if (token.length < 32) throw new Error('INDEXER_TOKEN_FILE must hold at least 32 characters');
  return token;
}

export interface Cycle {
  ingestion: IngestReport;
  audit: AuditReport[];
}

/**
 * One pass: read everything new, then check each wallet against its head. The head is read after ingestion, so a
 * head that is ahead of the stored entries is reported as syncing, not as a mismatch.
 */
export async function runCycle(
  store: HistoryStore, server: rpc.Server, stream: StreamConfig, state: IndexerState, admit?: Admission,
): Promise<Cycle> {
  try {
    const ingestion = await ingest(store, server, stream, admit ? { admit } : {});
    state.ingestion = ingestion;
    delete state.ingestionError;
    const source = Keypair.random().publicKey();
    const audit: AuditReport[] = [];
    // Named wallets are checked every pass. Wallets followed by code are checked when they change: there can be
    // many, and a reader verifies the chain against the wallet's head itself in any case.
    for (const wallet of new Set([...stream.wallets, ...ingestion.touched])) {
      const head = await readAuditHead({ server, contractId: wallet, source, networkPassphrase: stream.networkPassphrase });
      const report = verifyWallet(store, stream.id, stream.networkPassphrase, wallet, head);
      state.audit.delete(wallet);
      state.audit.set(wallet, report);
      audit.push(report);
    }
    // Keep the most recently checked; with wallets followed by code the map would otherwise grow without bound.
    for (const wallet of state.audit.keys()) {
      if (state.audit.size <= MAX_AUDIT_REPORTS) break;
      if (!stream.wallets.includes(wallet)) state.audit.delete(wallet);
    }
    return { ingestion, audit };
  } catch (error) {
    state.ingestionError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export interface RunningIndexer {
  server: Server;
  url: string;
  store: HistoryStore;
  state: IndexerState;
  /** Run one ingestion and verification pass now. */
  cycle(): Promise<Cycle>;
  stop(): Promise<void>;
}

/**
 * Start the service: one pass first, so the API never answers from an empty state, then a pass every
 * `pollSeconds`. A failed pass is logged and reported by `/v1/health`; the next pass starts from the stored cursor.
 */
export async function startIndexer(
  env: Environment, options: { poll?: boolean; /** Used instead of `INDEXER_TOKEN_FILE` by a process that embeds the indexer. */ token?: string } = {},
): Promise<RunningIndexer> {
  const config = indexerConfig(env);
  const token = options.token ?? (config.tokenFile ? await readToken(config.tokenFile) : undefined);
  if (token !== undefined && token.length < 32) throw new Error('The indexer token must hold at least 32 characters');
  if (!LOOPBACK.has(config.host) && !token) {
    throw new Error('An indexer listening beyond loopback requires INDEXER_TOKEN_FILE for recording attempts');
  }
  const rpcServer = new rpc.Server(config.rpcUrl, { allowHttp: config.network === 'local', timeout: 30_000 });
  const network = await rpcServer.getNetwork();
  if (network.passphrase !== config.passphrase) throw new Error('RPC server is on a different network');
  const store = new HistoryStore(config.databasePath);
  const state: IndexerState = { audit: new Map() };
  const admit = config.stream.walletCode ? codeAdmission(rpcServer, config.stream.walletCode) : undefined;
  const cycle = () => runCycle(store, rpcServer, config.stream, state, admit);
  const http = createServer(createHandler({
    store, streamId: config.stream.id, network: config.network, wallets: config.stream.wallets, state, token,
    ...(config.stream.walletCode ? { walletCode: config.stream.walletCode } : {}),
  }));
  try {
    // A stream opened with another network or start ledger is a configuration error, not something to retry.
    store.ensureStream(config.stream.id, networkIdOf(config.passphrase), config.stream.startLedger);
    await cycle().catch((error: unknown) => console.error('indexer: first pass failed:', error));
    await new Promise<void>((resolveListen, reject) => {
      http.once('error', reject);
      http.listen(config.port, config.host, () => resolveListen());
    });
  } catch (error) {
    store.close();
    throw error;
  }
  let running: Promise<unknown> = Promise.resolve();
  const timer = options.poll === false ? undefined : setInterval(() => {
    running = running.then(() => cycle()).catch((error: unknown) => console.error('indexer: pass failed:', error));
  }, config.pollSeconds * 1_000);
  timer?.unref();

  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return {
    server: http, url: `http://${host}:${port}/`, store, state, cycle,
    async stop() {
      if (timer) clearInterval(timer);
      await running;
      await new Promise<void>((done) => http.close(() => done()));
      store.close();
    },
  };
}

if (isMainModule(import.meta.url)) {
  startIndexer(process.env).then(({ url, store, state }) => {
    console.log(JSON.stringify({
      status: 'listening', url, database: store.path, ingested_ledger: state.ingestion?.ingested_ledger ?? null,
    }));
  }, (error: unknown) => {
    console.error(`indexer: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
