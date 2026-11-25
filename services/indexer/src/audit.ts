import { xdr } from '@stellar/stellar-sdk';
import { auditHash, decodeAudit, type AuditEntry, type AuditHead } from '@stellar-agent-auth/sdk';
import type { HistoryStore, StoredAuditEntry, Stream } from './storage.js';

/**
 * Checks a wallet's stored audit entries against themselves and against the head the wallet stores on chain.
 *
 * Each entry names the hash of the one before it, and the wallet keeps only the latest hash. Recomputing every hash
 * from the entry as published, and following the links from the first entry to the stored head, shows that the
 * history is exactly what the wallet recorded. The check proves nothing is altered or missing; it cannot bring back
 * an entry that was never stored.
 */

export type AuditStatus =
  /** Every entry from the first to the stored head is present, hashes to its published hash and links to the last. */
  | 'verified'
  /** The stored entries check, and the wallet and the indexer are at different ledgers. Look again shortly. */
  | 'syncing'
  /** Entries are missing and will not arrive by waiting: the RPC no longer retained them, or they were never read. */
  | 'incomplete'
  /** An entry contradicts its hash, its neighbour or the stored head. The history cannot be trusted as it stands. */
  | 'mismatch';

export interface AuditReport {
  wallet: string;
  status: AuditStatus;
  detail: string;
  /** Entries stored for the wallet. */
  entries: number;
  /** The head the wallet stores, as a decimal sequence and a hex hash. */
  head: { sequence: string; hash: string };
  /** Sequences that are absent between stored entries, or before the first one. */
  missing: { from: number; to: number }[];
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const ZERO = '00'.repeat(32);

function decode(row: StoredAuditEntry): AuditEntry {
  return decodeAudit(xdr.ScVal.fromXdr(row.entry_xdr, 'base64'));
}

/**
 * Verify `rows`, a wallet's stored entries in sequence order, against `head`. `stream` says how far ingestion has
 * come and whether any ledgers could not be read, which decides between `syncing` and `incomplete`.
 */
export function verifyStored(
  networkPassphrase: string, wallet: string, rows: readonly StoredAuditEntry[], head: AuditHead, stream: Stream,
): AuditReport {
  const report = (status: AuditStatus, detail: string, missing: AuditReport['missing'] = []): AuditReport => ({
    wallet, status, detail, entries: rows.length, head: { sequence: head.sequence.toString(), hash: hex(head.hash) },
    missing,
  });
  const missing: AuditReport['missing'] = [];
  let previous: { sequence: number; hash: string } | undefined;
  for (const row of rows) {
    let entry: AuditEntry;
    try {
      entry = decode(row);
    } catch {
      return report('mismatch', `Entry ${row.sequence} is not a valid audit entry`);
    }
    if (entry.wallet !== wallet || Number(entry.sequence) !== row.sequence || row.sequence < 1) {
      return report('mismatch', `Entry ${row.sequence} names another wallet or sequence`);
    }
    if (hex(auditHash(networkPassphrase, entry)) !== row.hash) {
      return report('mismatch', `Entry ${row.sequence} does not hash to its published hash`);
    }
    if (previous && row.sequence === previous.sequence) {
      return report('mismatch', `Two different entries claim sequence ${row.sequence}`);
    }
    const expected = previous ? previous.sequence + 1 : 1;
    if (row.sequence === expected) {
      if (hex(entry.previous_hash) !== (previous?.hash ?? ZERO)) {
        return report('mismatch', `Entry ${row.sequence} does not follow entry ${row.sequence - 1}`);
      }
    } else {
      // Entries are absent before this one. What is present is still checked; it cannot be linked across the hole.
      missing.push({ from: expected, to: row.sequence - 1 });
    }
    previous = { sequence: row.sequence, hash: row.hash };
  }

  const headSequence = Number(head.sequence);
  const last = previous?.sequence ?? 0;
  if (last > headSequence) {
    return report('syncing', `Stored entries reach ${last}; the head read from the network is at ${headSequence}`, missing);
  }
  if (last === headSequence && last > 0 && previous!.hash !== hex(head.hash)) {
    return report('mismatch', `Entry ${last} does not match the head the wallet stores`, missing);
  }
  if (missing.length) {
    const [first] = missing;
    return report('incomplete', `Entries ${first!.from} to ${first!.to} are not stored`
      + (stream.gap_from_ledger !== null ? `; ledgers ${stream.gap_from_ledger} to ${stream.gap_to_ledger! - 1} could not be read`
        : ''), missing);
  }
  if (last < headSequence) {
    // Waiting helps only if nothing was lost on the way. After a gap, the missing tail may never be read.
    return stream.gap_from_ledger !== null
      ? report('incomplete', `Entries after ${last} are not stored, and ledgers ${stream.gap_from_ledger} to `
        + `${stream.gap_to_ledger! - 1} could not be read`, [{ from: last + 1, to: headSequence }])
      : report('syncing', `Entries after ${last} are not ingested yet; ingestion is at ledger ${stream.ingested_ledger}`);
  }
  return report('verified', headSequence === 0 ? 'No audit entries yet'
    : `${rows.length} entries from the first match the head the wallet stores`);
}

/** Verify a wallet from the store, given the head just read from the network. */
export function verifyWallet(
  store: HistoryStore, streamId: string, networkPassphrase: string, wallet: string, head: AuditHead,
): AuditReport {
  const stream = store.stream(streamId);
  if (!stream) throw new Error(`Unknown stream ${streamId}`);
  return verifyStored(networkPassphrase, wallet, store.auditEntries(streamId, wallet), head, stream);
}
