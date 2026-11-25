import { rpc, xdr } from '@stellar/stellar-sdk';
import { auditHash, decodeAudit, decodeAuditEvent } from './encoding.js';
import type { AuditEntry, AuditHead, Hash32 } from './types.js';
import { readAuditHead, type WalletRead } from './wallet.js';

/**
 * Wallet history, checked against the wallet's stored audit head. It is read either from the network's `audit_v1`
 * events, which an RPC retains only for a window of recent ledgers, or from an indexer that has kept them. Either
 * way the entries are verified here: the indexer supplies data, and the head read from the network decides.
 * Every outcome is explicit: a chain that cannot be shown complete is never reported as verified.
 */

export interface AuditRecord {
  entry: AuditEntry;
  hash: Hash32;
  ledger: number;
  transaction: string;
  event_id: string;
}

export type HistoryStatus =
  /** Every entry from genesis to the stored head was found and each hash and link checks. */
  | 'verified'
  /** Entries are missing at the start (outside RPC retention, or never indexed) or the end (not yet visible). */
  | 'incomplete'
  /** An event's hash, link or order contradicts the chain, or the stored head differs from the events. */
  | 'mismatch';

export interface History {
  status: HistoryStatus;
  detail: string;
  entries: AuditRecord[];
  head: AuditHead;
  /** The ledger range the events were read from. */
  from_ledger: number;
  to_ledger: number;
}

const ZERO = new Uint8Array(32);
const same = (a: Hash32, b: Hash32) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const AUDIT_TOPIC = xdr.ScVal.scvSymbol('audit_v1').toXdr('base64');

export interface HistoryRead extends WalletRead {
  server: Pick<rpc.Server, 'simulateTransaction' | 'getEvents' | 'getLatestLedger' | 'getHealth'>;
}

/**
 * The ledger an RPC paging cursor points into. Cursors and event IDs share one format: a 64-bit position whose high
 * 32 bits are the ledger, then a dash and an index. It is read only to tell whether the RPC has scanned up to its
 * latest ledger; an unreadable cursor is treated as unknown, never as caught up.
 */
export function cursorLedger(cursor: string): number | undefined {
  const [position] = cursor.split('-');
  if (!position || !/^\d{1,20}$/.test(position)) return undefined;
  const ledger = Number(BigInt(position) >> 32n);
  return Number.isSafeInteger(ledger) ? ledger : undefined;
}

const PAGE = 200;

/**
 * Fetch every `audit_v1` event from `startLedger` (default: the oldest the RPC retains) to now. An RPC scans a
 * bounded number of ledgers per request, so a short page is not the end: reading stops only when the cursor has
 * reached the latest ledger or no longer moves.
 */
async function auditEvents(read: HistoryRead, startLedger: number | undefined) {
  const health = await read.server.getHealth();
  const from = Math.max(startLedger ?? health.oldestLedger, health.oldestLedger);
  const records: AuditRecord[] = [];
  const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [read.contractId], topics: [[AUDIT_TOPIC, '*']] }];
  let request: rpc.Api.GetEventsRequest = { startLedger: from, filters, limit: PAGE };
  let previous: string | undefined;
  let to = health.latestLedger;
  for (let pages = 0; pages < 10_000; pages++) {
    const page = await read.server.getEvents(request);
    for (const event of page.events) {
      const { entry, hash } = decodeAuditEvent(event.value);
      records.push({ entry, hash, ledger: event.ledger, transaction: event.txHash, event_id: event.id });
    }
    to = page.latestLedger;
    const reached = cursorLedger(page.cursor);
    if (page.events.length < PAGE && (page.cursor === previous || reached === undefined || reached >= page.latestLedger)) {
      break;
    }
    previous = page.cursor;
    request = { cursor: page.cursor, filters, limit: PAGE };
  }
  return { records, from, to };
}

/** Recompute the chain over `records` and compare it with `head`. */
export function verifyAuditChain(
  networkPassphrase: string, wallet: string, records: readonly AuditRecord[], head: AuditHead,
): Pick<History, 'status' | 'detail'> {
  let previous: AuditHead | undefined;
  for (const record of records) {
    const { entry } = record;
    if (entry.wallet !== wallet) return { status: 'mismatch', detail: `Entry ${entry.sequence} names another wallet` };
    if (!same(auditHash(networkPassphrase, entry), record.hash)) {
      return { status: 'mismatch', detail: `Entry ${entry.sequence} does not hash to its published hash` };
    }
    if (previous && (entry.sequence !== previous.sequence + 1n || !same(entry.previous_hash, previous.hash))) {
      return { status: 'mismatch', detail: `Entry ${entry.sequence} does not follow entry ${previous.sequence}` };
    }
    previous = { sequence: entry.sequence, hash: record.hash };
  }
  const first = records[0]?.entry;
  if (head.sequence === 0n) {
    return records.length ? { status: 'mismatch', detail: 'Events exist but the wallet head is at genesis' }
      : { status: 'verified', detail: 'No audit entries yet' };
  }
  if (!previous) return { status: 'incomplete', detail: `No events found for ${head.sequence} stored entries` };
  if (previous.sequence > head.sequence) {
    return { status: 'mismatch', detail: `Events reach ${previous.sequence} but the stored head is ${head.sequence}` };
  }
  if (previous.sequence === head.sequence && !same(previous.hash, head.hash)) {
    return { status: 'mismatch', detail: `Entry ${head.sequence} does not match the stored head` };
  }
  if (first!.sequence !== 1n || !same(first!.previous_hash, ZERO)) {
    return { status: 'incomplete', detail: `Entries before ${first!.sequence} are not available: outside RPC retention, or never indexed` };
  }
  if (previous.sequence < head.sequence) {
    return { status: 'incomplete', detail: `Entries after ${previous.sequence} are not yet visible` };
  }
  return { status: 'verified', detail: `${records.length} entries from genesis match the stored head` };
}

/**
 * Read and verify a wallet's audit history. The head is read after the events, so a head ahead of the events is
 * reported as incomplete rather than as a mismatch.
 */
export async function readAuditHistory(
  read: HistoryRead, options: { startLedger?: number } = {},
): Promise<History> {
  const { records, from, to } = await auditEvents(read, options.startLedger);
  const head = await readAuditHead(read);
  return {
    ...verifyAuditChain(read.networkPassphrase, read.contractId, records, head),
    entries: records, head, from_ledger: from, to_ledger: to,
  };
}

export interface IndexedHistory {
  status: HistoryStatus;
  detail: string;
  entries: AuditRecord[];
  head: AuditHead;
  /** The indexer's own report for the wallet. Informational: `status` is computed here, not taken from it. */
  indexer: { status: string; detail: string } | null;
}

const HEX_HASH = /^[0-9a-f]{64}$/;
const fromHex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

/**
 * Read a wallet's audit history from an indexer and verify it against the head read from the network.
 *
 * The indexer is not trusted: every entry is decoded and hashed again here, each link is followed, and the last
 * entry must match the head the wallet itself stores. An indexer that withholds, alters or reorders entries
 * produces `incomplete` or `mismatch`, never `verified`. The head is read after the entries, so a head ahead of
 * them is reported as incomplete rather than as a mismatch.
 */
export async function readIndexedHistory(
  read: WalletRead, indexerUrl: string, options: { fetch?: typeof fetch; pageSize?: number } = {},
): Promise<IndexedHistory> {
  const base = new URL(indexerUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const request = options.fetch ?? fetch;
  const limit = options.pageSize ?? PAGE;
  const records: AuditRecord[] = [];
  const malformed = (what: string) => new Error(`The indexer returned a malformed history page: ${what}`);
  let indexer: IndexedHistory['indexer'] = null;
  let after = 0;
  let undecodable: number | undefined;
  for (let pages = 0; ; pages++) {
    if (pages >= 100_000) throw malformed('it never ends');
    const response = await request(new URL(`v1/wallets/${read.contractId}/history?after=${after}&limit=${limit}`, base));
    if (!response.ok) throw new Error(`The indexer answered ${response.status} for the wallet's history`);
    const body = await response.json() as {
      entries?: unknown; next_after?: unknown; audit?: { status?: unknown; detail?: unknown } | null;
    };
    if (!Array.isArray(body.entries)) throw malformed('no entries');
    for (const row of body.entries as Record<string, unknown>[]) {
      const { entry_xdr: encoded, hash, ledger, tx_hash: transaction, event_id: eventId, sequence } = row ?? {};
      if (typeof encoded !== 'string' || typeof hash !== 'string' || !HEX_HASH.test(hash) || typeof transaction !== 'string'
        || typeof eventId !== 'string' || !Number.isSafeInteger(ledger) || !Number.isSafeInteger(sequence)) {
        throw malformed('an entry lacks a field');
      }
      try {
        const entry = decodeAudit(xdr.ScVal.fromXdr(encoded, 'base64'));
        records.push({ entry, hash: fromHex(hash), ledger: ledger as number, transaction, event_id: eventId });
      } catch {
        undecodable ??= sequence as number;
      }
    }
    if (body.audit && typeof body.audit.status === 'string' && typeof body.audit.detail === 'string') {
      indexer = { status: body.audit.status, detail: body.audit.detail };
    }
    if (body.next_after === null || body.next_after === undefined) break;
    if (!Number.isSafeInteger(body.next_after) || (body.next_after as number) <= after) throw malformed('paging does not advance');
    after = body.next_after as number;
  }
  const head = await readAuditHead(read);
  const verdict = undecodable !== undefined
    ? { status: 'mismatch' as const, detail: `Entry ${undecodable} from the indexer is not a valid audit entry` }
    : verifyAuditChain(read.networkPassphrase, read.contractId, records, head);
  return { ...verdict, entries: records, head, indexer };
}
