import { Contract, type rpc, xdr } from '@stellar/stellar-sdk';
import { auditHash, encodeAudit } from '../../../packages/sdk/src/encoding.js';
import { cursorLedger } from '../../../packages/sdk/src/history.js';
import type { AuditEntry, AuditHead } from '../../../packages/sdk/src/types.js';
import { account, passphrase } from '../../fixtures/abi-v1.js';

/**
 * An in-memory event source that pages the way a Stellar RPC does: results in event ID order, a cursor after the
 * last event of a full page, a cursor at the end of the scanned window after a short page, a bounded number of
 * ledgers scanned per request, and a refusal to start before the oldest retained ledger.
 */

const pad = (value: bigint | number, width: number) => value.toString().padStart(width, '0');

/** An event ID, which is also a cursor: the position of an operation, a dash, and the event's index. */
export const eventId = (ledger: number, tx = 1, index = 0) =>
  `${pad((BigInt(ledger) << 32n) | (BigInt(tx) << 12n), 19)}-${pad(index, 10)}`;

/** The cursor after everything in `ledger`. */
const endOf = (ledger: number) => `${pad((BigInt(ledger) << 32n) | 0xffff_ffffn, 19)}-${pad(0xffff_ffff, 10)}`;

export function event(
  ledger: number, contractId: string, topic: string, value: xdr.ScVal, position: { tx?: number; index?: number } = {},
): rpc.Api.EventResponse {
  return {
    id: eventId(ledger, position.tx, position.index), type: 'contract', ledger,
    ledgerClosedAt: new Date(1_700_000_000_000 + ledger * 5_000).toISOString(), transactionIndex: position.tx ?? 1,
    operationIndex: 0, txHash: pad(ledger * 1_000 + (position.tx ?? 1), 64), contractId: new Contract(contractId),
    topic: [xdr.ScVal.scvSymbol(topic)], value,
  };
}

/** The value of an `audit_v1` event: the entry and the hash the wallet published for it. */
export const auditValue = (entry: AuditEntry, hash: Uint8Array) => xdr.ScVal.scvMap([
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('entry'), val: encodeAudit(entry) }),
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('hash'), val: xdr.ScVal.scvBytes(Buffer.from(hash)) }),
]);

export interface Link {
  entry: AuditEntry;
  hash: Uint8Array;
  event: rpc.Api.EventResponse;
}

/** A valid audit chain of `count` entries for `wallet`, one per ledger from `firstLedger`. */
export function auditChain(wallet: string, count: number, firstLedger = 10): Link[] {
  const links: Link[] = [];
  let previous: Uint8Array = new Uint8Array(32);
  for (let i = 1; i <= count; i++) {
    const ledger = firstLedger + i - 1;
    const entry: AuditEntry = {
      schema_version: 1, wallet, sequence: BigInt(i), previous_hash: previous, ledger,
      timestamp: BigInt(1_700_000_000 + ledger * 5), actor: account(5), outcome: { kind: 'PauseChanged', paused: i % 2 === 1 },
    };
    const hash = auditHash(passphrase, entry);
    links.push({ entry, hash, event: event(ledger, wallet, 'audit_v1', auditValue(entry, hash)) });
    previous = hash;
  }
  return links;
}

export const headOf = (links: readonly Link[]): AuditHead => {
  const last = links.at(-1);
  return last ? { sequence: last.entry.sequence, hash: last.hash } : { sequence: 0n, hash: new Uint8Array(32) };
};

export class FakeEvents {
  events: rpc.Api.EventResponse[] = [];
  latestLedger = 100;
  oldestLedger = 1;
  /** Ledgers one request scans, as an RPC limits them. */
  scanLimit = 10_000;
  requests: rpc.Api.GetEventsRequest[] = [];
  /** Throw on the request with this zero-based number, once. */
  failOnRequest: number | undefined;

  add(...events: rpc.Api.EventResponse[]) {
    this.events = [...this.events, ...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return this;
  }

  getHealth = async (): Promise<rpc.Api.GetHealthResponse> => ({
    status: 'healthy', latestLedger: this.latestLedger, oldestLedger: this.oldestLedger,
    ledgerRetentionWindow: this.latestLedger - this.oldestLedger + 1,
  });

  getEvents = async (request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> => {
    const number = this.requests.push(request) - 1;
    if (this.failOnRequest === number) {
      this.failOnRequest = undefined;
      throw new Error('RPC unreachable');
    }
    const cursor = 'cursor' in request ? request.cursor : undefined;
    const start = cursor !== undefined ? cursorLedger(cursor)! : (request as { startLedger: number }).startLedger;
    if (start < this.oldestLedger || start > this.latestLedger) {
      throw new Error(`startLedger must be within the ledger range: ${this.oldestLedger} - ${this.latestLedger}`);
    }
    const end = Math.min(start + this.scanLimit, this.latestLedger + 1);
    const contracts = new Set(request.filters.flatMap((filter) => filter.contractIds ?? []));
    const limit = request.limit ?? 100;
    const matched = this.events.filter((item) => item.ledger >= start && item.ledger < end
      && (cursor === undefined || item.id > cursor) && contracts.has(item.contractId!.toString()));
    const page = matched.slice(0, limit);
    return {
      events: page, cursor: page.length === limit ? page.at(-1)!.id : endOf(end - 1),
      latestLedger: this.latestLedger, oldestLedger: this.oldestLedger, latestLedgerCloseTime: '0', oldestLedgerCloseTime: '0',
    } as rpc.Api.GetEventsResponse;
  };
}
