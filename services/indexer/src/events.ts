import type { rpc, xdr } from '@stellar/stellar-sdk';
import { cursorLedger, decodeAuditEvent, networkIdOf } from '@stellar-agent-auth/sdk';
import type { HistoryStore, PageCounts, Quarantined, StoredAuditEntry, StoredEvent, Stream } from './storage.js';

/**
 * Reads contract events from the RPC into the store, page by page, from a stream's start ledger onwards.
 *
 * RPC event history is bounded: a server keeps only a window of recent ledgers. An indexer that starts late, or is
 * down for longer than that window, cannot read what fell out of it. That is recorded as a gap on the stream and
 * never papered over; the audit chain can show that entries are missing, but only a backup or an archive can supply
 * them.
 */

export type EventSource = Pick<rpc.Server, 'getEvents' | 'getHealth'>;

export interface StreamConfig {
  /** Names this deployment's history, such as `testnet:2026-12`. A new deployment needs a new ID. */
  id: string;
  networkPassphrase: string;
  /** Smart wallets; their `audit_v1` events become audit entries. */
  wallets: readonly string[];
  /** Other contracts whose events are kept as raw events, such as the registries and a service. */
  contracts: readonly string[];
  /** The ledger the deployment was created in, or earlier. */
  startLedger: number;
  pageSize?: number;
}

/** First topics this indexer understands. Anything else from a watched contract is quarantined, not guessed at. */
export const KNOWN_TOPICS: ReadonlySet<string> = new Set([
  'audit_v1', 'identity_v1', 'provider_v1', 'assessment_v1', 'service_paid_v1',
]);

export interface IngestReport extends PageCounts {
  pages: number;
  /** Every event up to this ledger is stored, apart from a recorded gap. */
  ingested_ledger: number;
  /** The RPC's latest ledger when the last page was read. */
  latest_ledger: number;
  /** Set when this run found ledgers it could not read. */
  gap?: { from: number; to: number };
}

export { networkIdOf };

function symbolOf(topic: xdr.ScVal | undefined): string {
  return topic?.type === 'scvSymbol' ? topic.sym.toString() : '';
}

/** Split one RPC event into what the store keeps: the raw event, an audit entry if it is one, or a quarantine note. */
function classify(event: rpc.Api.EventResponse, wallets: ReadonlySet<string>) {
  const contract = event.contractId?.toString() ?? '';
  const topic = symbolOf(event.topic[0]);
  const stored: StoredEvent = {
    id: event.id, ledger: event.ledger, closed_at: event.ledgerClosedAt, tx_hash: event.txHash, contract, topic,
    topics_xdr: JSON.stringify(event.topic.map((value) => value.toXdr('base64'))), value_xdr: event.value.toXdr('base64'),
  };
  const quarantine = (reason: string): Quarantined => ({ event_id: event.id, ledger: event.ledger, contract, reason });
  if (!KNOWN_TOPICS.has(topic)) {
    return { stored, quarantined: quarantine(topic ? `Unknown event schema ${topic}` : 'Event has no schema topic') };
  }
  if (topic !== 'audit_v1' || !wallets.has(contract)) return { stored };
  try {
    const { entry, hash: published } = decodeAuditEvent(event.value);
    if (entry.sequence > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Audit sequence is out of range');
    const fields = event.value.type === 'scvMap' ? event.value.map ?? [] : [];
    const encoded = fields.find(({ key }) => key.type === 'scvSymbol' && key.sym.toString() === 'entry')!.val;
    const audit: StoredAuditEntry = {
      event_id: event.id, wallet: contract, sequence: Number(entry.sequence),
      hash: Buffer.from(published).toString('hex'), ledger: event.ledger, tx_hash: event.txHash,
      entry_xdr: encoded.toXdr('base64'),
    };
    return { stored, audit };
  } catch (error) {
    return { stored, quarantined: quarantine(`Undecodable audit_v1 event: ${error instanceof Error ? error.message : error}`) };
  }
}

/**
 * Read everything new for the stream and store it. Safe to call again at any time, including after a crash in the
 * middle of an earlier call: it continues from the stored cursor, and a page stored twice adds nothing.
 */
export async function ingest(
  store: HistoryStore, source: EventSource, config: StreamConfig, options: { maxPages?: number } = {},
): Promise<IngestReport> {
  const limit = config.pageSize ?? 200;
  const wallets = new Set(config.wallets);
  const watched = [...new Set([...config.wallets, ...config.contracts])];
  if (!watched.length) throw new Error('Nothing to index: name at least one contract');
  // The RPC takes at most five contract IDs per filter.
  const filters: rpc.Api.EventFilter[] = [];
  for (let i = 0; i < watched.length; i += 5) filters.push({ type: 'contract', contractIds: watched.slice(i, i + 5) });
  if (filters.length > 5) throw new Error('At most 25 contracts can be indexed in one stream');

  let stream: Stream = store.ensureStream(config.id, networkIdOf(config.networkPassphrase), config.startLedger);
  const report: IngestReport = {
    events: 0, audit: 0, quarantined: 0, pages: 0, ingested_ledger: stream.ingested_ledger, latest_ledger: 0,
  };

  // What the RPC still retains decides where reading can resume.
  const health = await source.getHealth();
  const next = stream.ingested_ledger + 1;
  if (next < health.oldestLedger) {
    store.recordGap(config.id, next, health.oldestLedger);
    report.gap = { from: next, to: health.oldestLedger };
    stream = store.stream(config.id)!;
  }

  let request: rpc.Api.GetEventsRequest = stream.cursor !== null ? { cursor: stream.cursor, filters, limit }
    : { startLedger: stream.ingested_ledger + 1, filters, limit };
  let previousCursor = stream.cursor;
  for (let pages = 0; pages < (options.maxPages ?? 10_000); pages++) {
    if ('startLedger' in request && request.startLedger !== undefined && request.startLedger > health.latestLedger) break;
    const page = await source.getEvents(request);
    const events: StoredEvent[] = [];
    const audit: StoredAuditEntry[] = [];
    const quarantined: Quarantined[] = [];
    for (const event of page.events) {
      const result = classify(event, wallets);
      events.push(result.stored);
      if (result.audit) audit.push(result.audit);
      if (result.quarantined) quarantined.push(result.quarantined);
    }
    // A full page may end in the middle of a ledger, so only the ledgers before its last event are complete. A
    // short page means the RPC found nothing more as far as its cursor reaches.
    const full = page.events.length >= limit;
    const reached = cursorLedger(page.cursor);
    const last = page.events.at(-1)?.ledger;
    const ingested = full && last !== undefined ? last - 1
      : Math.min(page.latestLedger, reached ?? last ?? stream.ingested_ledger);
    const counts = store.applyPage(config.id, { events, audit, quarantined, cursor: page.cursor, ingested_ledger: ingested });
    report.events += counts.events;
    report.audit += counts.audit;
    report.quarantined += counts.quarantined;
    report.pages += 1;
    report.latest_ledger = page.latestLedger;

    const caughtUp = !full && (page.cursor === previousCursor || (reached !== undefined && reached >= page.latestLedger)
      || reached === undefined);
    previousCursor = page.cursor;
    if (caughtUp) break;
    request = { cursor: page.cursor, filters, limit };
  }
  report.ingested_ledger = store.stream(config.id)!.ingested_ledger;
  if (!report.latest_ledger) report.latest_ledger = health.latestLedger;
  return report;
}
