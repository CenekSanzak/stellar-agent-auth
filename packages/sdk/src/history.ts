import { rpc, xdr } from '@stellar/stellar-sdk';
import { auditHash, decodeAuditEvent } from './encoding.js';
import type { AuditEntry, AuditHead, Hash32 } from './types.js';
import { readAuditHead, type WalletRead } from './wallet.js';

/**
 * Wallet history read from the network's `audit_v1` events and checked against the wallet's stored audit head.
 * RPC event retention is bounded, so this is a live view, not durable history; the P6 indexer keeps the record.
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
  /** Entries are missing at the start (outside RPC retention) or the end (not yet visible); the rest check. */
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

/** Fetch every `audit_v1` event from `startLedger` (default: the oldest the RPC retains) to now. */
async function auditEvents(read: HistoryRead, startLedger: number | undefined) {
  const health = await read.server.getHealth();
  const from = Math.max(startLedger ?? health.oldestLedger, health.oldestLedger);
  const records: AuditRecord[] = [];
  const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [read.contractId], topics: [[AUDIT_TOPIC, '*']] }];
  let page = await read.server.getEvents({ startLedger: from, filters, limit: 200 });
  for (;;) {
    for (const event of page.events) {
      const { entry, hash } = decodeAuditEvent(event.value);
      records.push({ entry, hash, ledger: event.ledger, transaction: event.txHash, event_id: event.id });
    }
    if (page.events.length < 200) break;
    page = await read.server.getEvents({ cursor: page.cursor, filters, limit: 200 });
  }
  return { records, from, to: page.latestLedger };
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
    return { status: 'incomplete', detail: `Entries before ${first!.sequence} are outside the RPC retention window` };
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
