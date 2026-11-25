import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * Durable history in one SQLite file, for a single indexer process. It keeps raw contract events, the wallet audit
 * entries decoded from them, events it could not decode, and attempts that never became audit entries.
 *
 * Two rules make it safe to stop and restart at any point:
 * - a page of events and the cursor that follows it are written in one transaction, so the cursor never claims
 *   more than what is stored;
 * - events are keyed by stream and event ID, so reading a page twice changes nothing.
 */

/** Applied in order, each in its own transaction. Never edit one that has shipped; add another. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE stream (
    id TEXT PRIMARY KEY,
    network_id TEXT NOT NULL,
    start_ledger INTEGER NOT NULL,
    cursor TEXT,
    ingested_ledger INTEGER NOT NULL,
    gap_from_ledger INTEGER,
    gap_to_ledger INTEGER,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE event (
    stream TEXT NOT NULL,
    id TEXT NOT NULL,
    ledger INTEGER NOT NULL,
    closed_at TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    contract TEXT NOT NULL,
    topic TEXT NOT NULL,
    topics_xdr TEXT NOT NULL,
    value_xdr TEXT NOT NULL,
    PRIMARY KEY (stream, id)
  ) STRICT;
  CREATE INDEX event_by_contract ON event (stream, contract, id);
  CREATE TABLE audit_entry (
    stream TEXT NOT NULL,
    event_id TEXT NOT NULL,
    wallet TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    hash TEXT NOT NULL,
    ledger INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    entry_xdr TEXT NOT NULL,
    PRIMARY KEY (stream, event_id)
  ) STRICT;
  CREATE INDEX audit_by_wallet ON audit_entry (stream, wallet, sequence, event_id);
  CREATE TABLE quarantine (
    stream TEXT NOT NULL,
    event_id TEXT NOT NULL,
    ledger INTEGER NOT NULL,
    contract TEXT NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (stream, event_id)
  ) STRICT;
  CREATE TABLE attempt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream TEXT NOT NULL,
    wallet TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('simulation', 'transaction')),
    status TEXT NOT NULL,
    error TEXT,
    detail TEXT,
    tx_hash TEXT,
    recorded_at TEXT NOT NULL,
    UNIQUE (stream, tx_hash)
  ) STRICT;
  CREATE INDEX attempt_by_wallet ON attempt (stream, wallet, id);
  `,
];

export interface Stream {
  id: string;
  network_id: string;
  start_ledger: number;
  /** Opaque RPC cursor after the last stored page; absent until the first page is stored. */
  cursor: string | null;
  /** Every event up to and including this ledger is stored, apart from a recorded gap. */
  ingested_ledger: number;
  /** Ledgers `[gap_from_ledger, gap_to_ledger)` could not be read: the RPC no longer retained them. */
  gap_from_ledger: number | null;
  gap_to_ledger: number | null;
  updated_at: string;
}

export interface StoredEvent {
  id: string;
  ledger: number;
  closed_at: string;
  tx_hash: string;
  contract: string;
  /** The first topic when it is a symbol, such as `audit_v1`; empty otherwise. */
  topic: string;
  /** JSON array of base64 `ScVal` topics. */
  topics_xdr: string;
  /** Base64 `ScVal` event value. */
  value_xdr: string;
}

export interface StoredAuditEntry {
  event_id: string;
  wallet: string;
  sequence: number;
  /** Hex of the hash the event published; verification recomputes it from `entry_xdr`. */
  hash: string;
  ledger: number;
  tx_hash: string;
  /** Base64 `ScVal` of the `AuditEntry` exactly as published. */
  entry_xdr: string;
}

export interface Quarantined {
  event_id: string;
  ledger: number;
  contract: string;
  reason: string;
}

export interface Attempt {
  id: number;
  wallet: string;
  kind: 'simulation' | 'transaction';
  status: string;
  error: string | null;
  detail: string | null;
  tx_hash: string | null;
  recorded_at: string;
}

/** One page read from the RPC and everything derived from it, stored atomically with its cursor. */
export interface Page {
  events: readonly StoredEvent[];
  audit: readonly StoredAuditEntry[];
  quarantined: readonly Quarantined[];
  cursor: string;
  ingested_ledger: number;
}

export interface PageCounts {
  events: number;
  audit: number;
  quarantined: number;
}

const now = () => new Date().toISOString();

export class HistoryStore {
  private readonly db: DatabaseSync;

  /** Opens or creates the database at `path` (`:memory:` for tests) and brings its schema up to date. */
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close() {
    this.db.close();
  }

  /** Runs `work` in one transaction; anything it throws rolls every write back. */
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT');
    const applied = Number(this.one('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration')?.['version']);
    if (applied > MIGRATIONS.length) {
      throw new Error(`Database schema ${applied} is newer than this indexer understands (${MIGRATIONS.length})`);
    }
    MIGRATIONS.slice(applied).forEach((sql, offset) => this.transaction(() => {
      this.db.exec(sql);
      this.run('INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)', applied + offset + 1, now());
    }));
  }

  schemaVersion(): number {
    return Number(this.one('SELECT MAX(version) AS version FROM schema_migration')?.['version']);
  }

  private run(sql: string, ...values: SQLInputValue[]) {
    return this.db.prepare(sql).run(...values);
  }

  private one(sql: string, ...values: SQLInputValue[]) {
    return this.db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
  }

  private all<T>(sql: string, ...values: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...values).map((row) => ({ ...row })) as T[];
  }

  /**
   * The stream `id`, created at `startLedger` on first use. A stream belongs to one network and one start ledger;
   * opening it with another of either is refused, because its cursor and rows would mean something else.
   */
  ensureStream(id: string, networkId: string, startLedger: number): Stream {
    if (!Number.isSafeInteger(startLedger) || startLedger < 1) throw new Error('Start ledger must be a positive integer');
    return this.transaction(() => {
      const existing = this.stream(id);
      if (!existing) {
        this.run(`INSERT INTO stream (id, network_id, start_ledger, ingested_ledger, updated_at) VALUES (?, ?, ?, ?, ?)`,
          id, networkId, startLedger, startLedger - 1, now());
        return this.stream(id)!;
      }
      if (existing.network_id !== networkId) throw new Error(`Stream ${id} belongs to another network`);
      if (existing.start_ledger !== startLedger) {
        throw new Error(`Stream ${id} starts at ledger ${existing.start_ledger}, not ${startLedger}; use a new stream ID`);
      }
      return existing;
    });
  }

  stream(id: string): Stream | undefined {
    return this.all<Stream>('SELECT * FROM stream WHERE id = ?', id)[0];
  }

  /**
   * Stores a page and advances the cursor in one transaction. Rows already present are left as they are, so storing
   * the same page again adds nothing. Returns how many rows were new.
   */
  applyPage(streamId: string, page: Page): PageCounts {
    return this.transaction(() => {
      const counts: PageCounts = { events: 0, audit: 0, quarantined: 0 };
      const added = (result: { changes: number | bigint }) => Number(result.changes);
      for (const event of page.events) {
        counts.events += added(this.run(
          `INSERT OR IGNORE INTO event (stream, id, ledger, closed_at, tx_hash, contract, topic, topics_xdr, value_xdr)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          streamId, event.id, event.ledger, event.closed_at, event.tx_hash, event.contract, event.topic,
          event.topics_xdr, event.value_xdr));
      }
      for (const entry of page.audit) {
        counts.audit += added(this.run(
          `INSERT OR IGNORE INTO audit_entry (stream, event_id, wallet, sequence, hash, ledger, tx_hash, entry_xdr)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          streamId, entry.event_id, entry.wallet, entry.sequence, entry.hash, entry.ledger, entry.tx_hash,
          entry.entry_xdr));
      }
      for (const item of page.quarantined) {
        counts.quarantined += added(this.run(
          'INSERT OR IGNORE INTO quarantine (stream, event_id, ledger, contract, reason) VALUES (?, ?, ?, ?, ?)',
          streamId, item.event_id, item.ledger, item.contract, item.reason));
      }
      const updated = this.run(
        `UPDATE stream SET cursor = ?, ingested_ledger = MAX(ingested_ledger, ?), updated_at = ? WHERE id = ?`,
        page.cursor, page.ingested_ledger, now(), streamId);
      if (Number(updated.changes) !== 1) throw new Error(`Unknown stream ${streamId}`);
      return counts;
    });
  }

  /**
   * Records that ledgers `[from, to)` could not be read and resumes at `to` without a cursor. A gap only ever
   * widens: history lost to retention is never claimed back.
   */
  recordGap(streamId: string, from: number, to: number) {
    this.transaction(() => {
      const stream = this.stream(streamId);
      if (!stream) throw new Error(`Unknown stream ${streamId}`);
      this.run(
        `UPDATE stream SET gap_from_ledger = ?, gap_to_ledger = ?, cursor = NULL, ingested_ledger = ?, updated_at = ?
         WHERE id = ?`,
        Math.min(from, stream.gap_from_ledger ?? from), Math.max(to, stream.gap_to_ledger ?? to), to - 1, now(),
        streamId);
    });
  }

  /** A wallet's audit entries in sequence order, `limit` at a time, starting after sequence `after`. */
  auditEntries(streamId: string, wallet: string, options: { after?: number; limit?: number } = {}): StoredAuditEntry[] {
    return this.all<StoredAuditEntry>(
      `SELECT event_id, wallet, sequence, hash, ledger, tx_hash, entry_xdr FROM audit_entry
       WHERE stream = ? AND wallet = ? AND sequence > ? ORDER BY sequence, event_id LIMIT ?`,
      streamId, wallet, options.after ?? 0, options.limit ?? -1);
  }

  /** Raw events in event ID order, starting after `after`, optionally for one contract or first topic. */
  events(
    streamId: string, options: { contract?: string; topic?: string; after?: string; limit?: number } = {},
  ): StoredEvent[] {
    return this.all<StoredEvent>(
      `SELECT id, ledger, closed_at, tx_hash, contract, topic, topics_xdr, value_xdr FROM event
       WHERE stream = ? AND id > ? AND (? IS NULL OR contract = ?) AND (? IS NULL OR topic = ?) ORDER BY id LIMIT ?`,
      streamId, options.after ?? '', options.contract ?? null, options.contract ?? null, options.topic ?? null,
      options.topic ?? null, options.limit ?? -1);
  }

  quarantined(streamId: string): Quarantined[] {
    return this.all<Quarantined>(
      'SELECT event_id, ledger, contract, reason FROM quarantine WHERE stream = ? ORDER BY event_id', streamId);
  }

  /**
   * Records something that did not become an audit entry: a refused simulation or a transaction that failed. A
   * transaction hash is recorded once; reporting it again updates nothing and returns the first record.
   */
  recordAttempt(streamId: string, attempt: Omit<Attempt, 'id' | 'recorded_at'>): Attempt {
    return this.transaction(() => {
      if (attempt.tx_hash !== null) {
        const existing = this.all<Attempt>(
          `SELECT id, wallet, kind, status, error, detail, tx_hash, recorded_at FROM attempt
           WHERE stream = ? AND tx_hash = ?`, streamId, attempt.tx_hash)[0];
        if (existing) return existing;
      }
      const result = this.run(
        `INSERT INTO attempt (stream, wallet, kind, status, error, detail, tx_hash, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        streamId, attempt.wallet, attempt.kind, attempt.status, attempt.error, attempt.detail, attempt.tx_hash, now());
      return this.all<Attempt>(
        'SELECT id, wallet, kind, status, error, detail, tx_hash, recorded_at FROM attempt WHERE id = ?',
        Number(result.lastInsertRowid))[0]!;
    });
  }

  /** A wallet's attempts, oldest first, starting after attempt `after`. */
  attempts(streamId: string, wallet: string, options: { after?: number; limit?: number } = {}): Attempt[] {
    return this.all<Attempt>(
      `SELECT id, wallet, kind, status, error, detail, tx_hash, recorded_at FROM attempt
       WHERE stream = ? AND wallet = ? AND id > ? ORDER BY id LIMIT ?`,
      streamId, wallet, options.after ?? 0, options.limit ?? -1);
  }

  counts(streamId: string): PageCounts & { attempts: number } {
    const count = (table: string) =>
      Number(this.one(`SELECT COUNT(*) AS n FROM ${table} WHERE stream = ?`, streamId)?.['n']);
    return {
      events: count('event'), audit: count('audit_entry'), quarantined: count('quarantine'), attempts: count('attempt'),
    };
  }
}
