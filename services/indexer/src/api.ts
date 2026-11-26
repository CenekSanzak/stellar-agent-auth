import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StrKey } from '@stellar/stellar-sdk';
import type { AuditReport } from './audit.js';
import type { IngestReport } from './events.js';
import type { HistoryStore } from './storage.js';

/**
 * Read-only HTTP routes over the store, for the demo and for operators, plus one write: recording an attempt.
 *
 * - `GET /v1/health`: ingestion position, lag, any retention gap, and each wallet's audit status.
 * - `GET /v1/wallets/<wallet>/history?after=<sequence>&limit=<n>`: audit entries in sequence order.
 * - `GET /v1/wallets/<wallet>/attempts?after=<id>&limit=<n>`: refused simulations and failed transactions.
 * - `POST /v1/wallets/<wallet>/attempts`: record one; needs the token when one is configured.
 * - `GET /v1/events?contract=<C...>&topic=<name>&after=<event id>&limit=<n>`: raw events.
 *
 * Every list is paged by a stable key and says where the next page starts. The indexer has no authority: a client
 * can recompute every audit hash from `entry_xdr` and compare the chain with the wallet's own head.
 */

export interface IndexerState {
  /** The last completed ingestion, or why the last one failed. */
  ingestion?: IngestReport;
  ingestionError?: string;
  /** Audit status per wallet from the last cycle. */
  audit: Map<string, AuditReport>;
}

export interface ApiOptions {
  store: HistoryStore;
  streamId: string;
  network: string;
  wallets: readonly string[];
  /**
   * Set when wallets are followed by the code they run. Any contract address is then answered for: one that was
   * never seen has an empty history, and recording an attempt always needs the token.
   */
  walletCode?: readonly string[];
  state: IndexerState;
  /** Bearer token for recording attempts; when absent, only a loopback client may record. */
  token?: string | undefined;
}

class Rejected extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MAX_LIMIT = 200;
const MAX_BODY_BYTES = 8_192;

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {
    'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(body));
};

function integer(url: URL, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,16}$/.test(raw) || Number(raw) > max) throw new Rejected(400, `${name} must be an integer up to ${max}`);
  return Number(raw);
}

function limitOf(url: URL): number {
  const limit = integer(url, 'limit', 50, MAX_LIMIT);
  if (limit < 1) throw new Rejected(400, 'limit must be at least 1');
  return limit;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Rejected(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Rejected(400, 'Body must be JSON');
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function mayWrite(request: IncomingMessage, token: string | undefined) {
  if (!token) return LOOPBACK.has(request.socket.remoteAddress ?? '');
  const supplied = Buffer.from(request.headers['authorization'] ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const text = (value: unknown, name: string, max: number, required = false): string | null => {
  if (value === undefined || value === null) {
    if (required) throw new Rejected(400, `${name} is required`);
    return null;
  }
  if (typeof value !== 'string' || !value.length || value.length > max) {
    throw new Rejected(400, `${name} must be text of at most ${max} characters`);
  }
  return value;
};

export function createHandler(options: ApiOptions) {
  const { store, streamId, state } = options;
  const wallets = new Set(options.wallets);

  const byCode = (options.walletCode?.length ?? 0) > 0;

  function wallet(id: string) {
    if (!wallets.has(id) && !(byCode && StrKey.isValidContract(id))) {
      throw new Rejected(404, 'This indexer does not follow that wallet');
    }
    return id;
  }

  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? '/', 'http://indexer.invalid');
      const get = request.method === 'GET';
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-methods': 'GET, POST',
        });
        return response.end();
      }

      if (get && url.pathname === '/v1/health') {
        const stream = store.stream(streamId);
        const latest = state.ingestion?.latest_ledger ?? null;
        const audit = [...state.audit.values()];
        const status = state.ingestionError ? 'error'
          : audit.some((report) => report.status === 'mismatch') ? 'audit-mismatch'
            : stream?.gap_from_ledger !== null && stream?.gap_from_ledger !== undefined ? 'incomplete'
              : audit.some((report) => report.status === 'incomplete') ? 'incomplete'
                : 'ok';
        return json(response, 200, {
          status, network: options.network, stream: streamId, wallets: [...wallets],
          ...(byCode ? { wallet_code: options.walletCode } : {}),
          ingested_ledger: stream?.ingested_ledger ?? null, latest_ledger: latest,
          lag_ledgers: stream && latest !== null ? Math.max(0, latest - stream.ingested_ledger) : null,
          retention_gap: stream && stream.gap_from_ledger !== null
            ? { from_ledger: stream.gap_from_ledger, to_ledger: stream.gap_to_ledger! - 1 } : null,
          ingestion_error: state.ingestionError ?? null, counts: store.counts(streamId), audit,
        });
      }

      const walletRoute = /^\/v1\/wallets\/([A-Z0-9]{56})\/(history|attempts)$/.exec(url.pathname);
      if (walletRoute) {
        const id = wallet(walletRoute[1]!);
        if (walletRoute[2] === 'history' && get) {
          const limit = limitOf(url);
          const entries = store.auditEntries(streamId, id, { after: integer(url, 'after', 0), limit: limit + 1 });
          const page = entries.slice(0, limit);
          return json(response, 200, {
            wallet: id, entries: page, next_after: entries.length > limit ? page.at(-1)!.sequence : null,
            audit: state.audit.get(id) ?? null,
          });
        }
        if (walletRoute[2] === 'attempts' && get) {
          const limit = limitOf(url);
          const attempts = store.attempts(streamId, id, { after: integer(url, 'after', 0), limit: limit + 1 });
          const page = attempts.slice(0, limit);
          return json(response, 200, {
            wallet: id, attempts: page, next_after: attempts.length > limit ? page.at(-1)!.id : null,
          });
        }
        if (walletRoute[2] === 'attempts' && request.method === 'POST') {
          // With wallets followed by code anyone's wallet can be named, so being local is not enough to write.
          if (!mayWrite(request, options.token) || (byCode && !options.token)) {
            return json(response, 401, { error: 'Unauthorized' });
          }
          const body = await readBody(request);
          if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Rejected(400, 'Expected an object');
          const fields = body as Record<string, unknown>;
          const unknown = Object.keys(fields).filter((key) => !['kind', 'status', 'error', 'detail', 'tx_hash'].includes(key));
          if (unknown.length) throw new Rejected(400, `Unknown field(s): ${unknown.join(', ')}`);
          if (fields['kind'] !== 'simulation' && fields['kind'] !== 'transaction') {
            throw new Rejected(400, 'kind must be simulation or transaction');
          }
          const txHash = text(fields['tx_hash'], 'tx_hash', 64);
          if (txHash !== null && !/^[0-9a-f]{64}$/.test(txHash)) throw new Rejected(400, 'tx_hash must be 64 hex characters');
          if (fields['kind'] === 'transaction' && txHash === null) throw new Rejected(400, 'A transaction attempt needs tx_hash');
          const attempt = store.recordAttempt(streamId, {
            wallet: id, kind: fields['kind'], status: text(fields['status'], 'status', 32, true)!,
            error: text(fields['error'], 'error', 64), detail: text(fields['detail'], 'detail', 2_000), tx_hash: txHash,
          });
          return json(response, 201, attempt);
        }
      }

      if (get && url.pathname === '/v1/events') {
        const limit = limitOf(url);
        const contract = url.searchParams.get('contract') ?? undefined;
        if (contract !== undefined && !StrKey.isValidContract(contract)) throw new Rejected(400, 'contract must be a C... address');
        const topic = url.searchParams.get('topic') ?? undefined;
        if (topic !== undefined && !/^[a-z0-9_]{1,32}$/.test(topic)) throw new Rejected(400, 'topic must be an event name');
        const after = url.searchParams.get('after') ?? undefined;
        if (after !== undefined && !/^[0-9-]{1,64}$/.test(after)) throw new Rejected(400, 'after must be an event ID');
        const events = store.events(streamId, {
          limit: limit + 1, ...(contract ? { contract } : {}), ...(topic ? { topic } : {}), ...(after ? { after } : {}),
        });
        const page = events.slice(0, limit).map((event) => ({ ...event, topics_xdr: JSON.parse(event.topics_xdr) as string[] }));
        return json(response, 200, { events: page, next_after: events.length > limit ? page.at(-1)!.id : null });
      }
      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof Rejected) return json(response, error.status, { error: error.message });
      console.error('indexer:', error);
      return json(response, 500, { error: 'Internal error' });
    }
  };
}
