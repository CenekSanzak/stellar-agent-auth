import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { xdr } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { readIndexedHistory } from '../../packages/sdk/src/history.js';
import type { AuditHead } from '../../packages/sdk/src/types.js';
import { createHandler, type IndexerState } from '../../services/indexer/src/api.js';
import { verifyStored, verifyWallet } from '../../services/indexer/src/audit.js';
import { ingest, networkIdOf, type StreamConfig } from '../../services/indexer/src/events.js';
import { indexerConfig } from '../../services/indexer/src/index.js';
import { HistoryStore, type StoredAuditEntry, type Stream } from '../../services/indexer/src/storage.js';
import { contract, passphrase, wallet } from '../fixtures/abi-v1.js';
import { FakeEvents, auditChain, auditValue, event, headOf, type Link } from './support/fake-events.js';
import { success } from './support/fake-rpc.js';

const registry = contract(21);
const STREAM = 'local:test';
const config = (overrides: Partial<StreamConfig> = {}): StreamConfig => ({
  id: STREAM, networkPassphrase: passphrase, wallets: [wallet], contracts: [registry], startLedger: 1, ...overrides,
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function memory() {
  const store = new HistoryStore(':memory:');
  cleanups.push(() => store.close());
  return store;
}

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'indexer-test-'));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** Stored rows for `links`, as ingestion would write them. */
const rows = (links: readonly Link[]): StoredAuditEntry[] => links.map(({ entry, hash, event: source }) => ({
  event_id: source.id, wallet: entry.wallet, sequence: Number(entry.sequence), hash: Buffer.from(hash).toString('hex'),
  ledger: source.ledger, tx_hash: source.txHash,
  entry_xdr: auditValue(entry, hash).map![0]!.val.toXdr('base64'),
}));

const stream = (overrides: Partial<Stream> = {}): Stream => ({
  id: STREAM, network_id: networkIdOf(passphrase), start_ledger: 1, cursor: null, ingested_ledger: 100,
  gap_from_ledger: null, gap_to_ledger: null, updated_at: '', ...overrides,
});

describe('ingestion (A26)', () => {
  it('reads every page, stores events with their audit entries and stops at the latest ledger', async () => {
    const store = memory();
    const source = new FakeEvents();
    const chain = auditChain(wallet, 5);
    source.add(...chain.map((link) => link.event), event(12, registry, 'identity_v1', xdr.ScVal.scvU32(1), { tx: 2 }));

    const report = await ingest(store, source, config({ pageSize: 2 }));
    expect(report).toMatchObject({ events: 6, audit: 5, quarantined: 0, pages: 4, ingested_ledger: 100, latest_ledger: 100 });
    expect(report.gap).toBeUndefined();
    expect(store.auditEntries(STREAM, wallet).map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(store.events(STREAM, { contract: registry }).map((row) => row.topic)).toEqual(['identity_v1']);
    expect(store.stream(STREAM)).toMatchObject({ ingested_ledger: 100, gap_from_ledger: null });
    expect(verifyWallet(store, STREAM, passphrase, wallet, headOf(chain)).status).toBe('verified');
  });

  it('keeps its place across a restart and reads nothing twice', async () => {
    const path = join(directory(), 'history.sqlite');
    const source = new FakeEvents();
    const chain = auditChain(wallet, 6);
    source.add(...chain.slice(0, 4).map((link) => link.event));
    source.latestLedger = 13;

    const first = new HistoryStore(path);
    await ingest(first, source, config());
    expect(first.counts(STREAM)).toMatchObject({ events: 4, audit: 4 });
    first.close();

    source.add(...chain.slice(4).map((link) => link.event));
    source.latestLedger = 100;
    const second = new HistoryStore(path);
    cleanups.push(() => second.close());
    expect(second.schemaVersion()).toBe(1);
    expect(second.counts(STREAM)).toMatchObject({ events: 4, audit: 4 });
    const before = source.requests.length;
    const report = await ingest(second, source, config());
    expect(report).toMatchObject({ events: 2, audit: 2 });
    expect(source.requests.slice(before).every((request) => 'cursor' in request)).toBe(true);
    expect(second.counts(STREAM)).toMatchObject({ events: 6, audit: 6 });
    expect(verifyWallet(second, STREAM, passphrase, wallet, headOf(chain)).status).toBe('verified');

    // Nothing new: another pass changes nothing.
    expect(await ingest(second, source, config())).toMatchObject({ events: 0, audit: 0, quarantined: 0 });
    expect(second.counts(STREAM)).toMatchObject({ events: 6, audit: 6 });
  });

  it('adds nothing when the same events are delivered again', async () => {
    const store = memory();
    const source = new FakeEvents();
    const chain = auditChain(wallet, 3);
    source.add(...chain.map((link) => link.event), event(11, registry, 'made_up_v9', xdr.ScVal.scvVoid(), { tx: 2 }));
    await ingest(store, source, config());
    const counts = store.counts(STREAM);
    expect(counts).toMatchObject({ events: 4, audit: 3, quarantined: 1 });

    const events = store.events(STREAM);
    const again = store.applyPage(STREAM, {
      events, audit: store.auditEntries(STREAM, wallet), quarantined: store.quarantined(STREAM),
      cursor: store.stream(STREAM)!.cursor!, ingested_ledger: 5,
    });
    expect(again).toEqual({ events: 0, audit: 0, quarantined: 0 });
    expect(store.counts(STREAM)).toEqual(counts);
    // An older position never moves the stream backwards.
    expect(store.stream(STREAM)!.ingested_ledger).toBe(100);
  });

  it('stores a page and its cursor together or not at all', async () => {
    const store = memory();
    const source = new FakeEvents();
    const chain = auditChain(wallet, 2);
    source.add(chain[0]!.event);
    await ingest(store, source, config());
    const before = store.stream(STREAM)!;

    // The second row cannot be stored, so the first row and the cursor must not be stored either.
    const [good] = rows([chain[1]!]);
    const broken = { ...good!, event_id: 'broken', sequence: 2.5 };
    expect(() => store.applyPage(STREAM, {
      events: [{
        id: chain[1]!.event.id, ledger: 11, closed_at: '', tx_hash: '', contract: wallet, topic: 'audit_v1',
        topics_xdr: '[]', value_xdr: '',
      }],
      audit: [good!, broken], quarantined: [], cursor: 'later', ingested_ledger: 99,
    })).toThrow();
    expect(store.counts(STREAM)).toMatchObject({ events: 1, audit: 1 });
    expect(store.stream(STREAM)).toMatchObject({ cursor: before.cursor, ingested_ledger: before.ingested_ledger });
  });

  it('loses nothing when reading fails between pages', async () => {
    const store = memory();
    const source = new FakeEvents();
    const chain = auditChain(wallet, 6);
    source.add(...chain.map((link) => link.event));
    source.failOnRequest = 1;

    await expect(ingest(store, source, config({ pageSize: 2 }))).rejects.toThrow('RPC unreachable');
    const interrupted = store.stream(STREAM)!;
    expect(store.counts(STREAM)).toMatchObject({ events: 2, audit: 2 });
    // The cursor covers exactly what is stored: the first page ended at ledger 11, so ledger 10 is complete.
    expect(interrupted).toMatchObject({ cursor: chain[1]!.event.id, ingested_ledger: 10 });
    expect(verifyWallet(store, STREAM, passphrase, wallet, headOf(chain)).status).toBe('syncing');

    await ingest(store, source, config({ pageSize: 2 }));
    expect(store.counts(STREAM)).toMatchObject({ events: 6, audit: 6 });
    expect(verifyWallet(store, STREAM, passphrase, wallet, headOf(chain)).status).toBe('verified');
  });

  it('does not call a ledger complete while a full page ends inside it', async () => {
    const store = memory();
    const source = new FakeEvents();
    source.add(
      event(20, registry, 'identity_v1', xdr.ScVal.scvU32(1), { index: 0 }),
      event(20, registry, 'identity_v1', xdr.ScVal.scvU32(2), { index: 1 }),
      event(20, registry, 'identity_v1', xdr.ScVal.scvU32(3), { index: 2 }),
    );
    await ingest(store, source, config({ pageSize: 2 }), { maxPages: 1 });
    expect(store.stream(STREAM)!.ingested_ledger).toBe(19);
    expect(store.counts(STREAM).events).toBe(2);
    await ingest(store, source, config({ pageSize: 2 }));
    expect(store.counts(STREAM).events).toBe(3);
    expect(store.stream(STREAM)!.ingested_ledger).toBe(100);
  });

  it('keeps reading past empty windows, because an RPC scans a bounded range per request', async () => {
    const store = memory();
    const source = new FakeEvents();
    source.latestLedger = 2_600;
    source.scanLimit = 1_000;
    const early = auditChain(wallet, 2, 10);
    source.add(...early.map((link) => link.event), event(2_500, registry, 'provider_v1', xdr.ScVal.scvU32(1)));

    const report = await ingest(store, source, config());
    expect(report).toMatchObject({ events: 3, pages: 3, ingested_ledger: 2_600 });
    expect(store.events(STREAM, { topic: 'provider_v1' })).toHaveLength(1);
  });

  it('follows more than five contracts with several filters and refuses more than the RPC accepts', async () => {
    const store = memory();
    const source = new FakeEvents();
    const contracts = Array.from({ length: 7 }, (_, i) => contract(40 + i));
    source.add(...contracts.map((id, i) => event(30 + i, id, 'identity_v1', xdr.ScVal.scvU32(i))));
    await ingest(store, source, config({ contracts }));
    expect(store.counts(STREAM).events).toBe(7);
    expect(source.requests[0]!.filters.map((filter) => filter.contractIds!.length)).toEqual([5, 3]);
    await expect(ingest(memory(), source, config({ contracts: Array.from({ length: 30 }, (_, i) => contract(60 + i)) })))
      .rejects.toThrow('At most 25');
  });

  it('quarantines what it does not understand and still keeps the raw event', async () => {
    const store = memory();
    const source = new FakeEvents();
    const chain = auditChain(wallet, 2);
    source.add(
      chain[0]!.event,
      event(20, wallet, 'audit_v2', xdr.ScVal.scvVoid()),
      event(21, wallet, 'audit_v1', xdr.ScVal.scvU32(7)),
      // An `audit_v1` event from a contract that is not a followed wallet is kept raw and claims nothing.
      event(22, registry, 'audit_v1', auditValue(chain[1]!.entry, chain[1]!.hash)),
      { ...event(23, registry, 'ignored', xdr.ScVal.scvVoid()), topic: [xdr.ScVal.scvU32(1)] },
    );
    const report = await ingest(store, source, config());
    expect(report).toMatchObject({ events: 5, audit: 1, quarantined: 3 });
    expect(store.quarantined(STREAM).map((item) => item.reason)).toEqual([
      'Unknown event schema audit_v2', expect.stringMatching(/^Undecodable audit_v1 event: /), 'Event has no schema topic',
    ]);
    expect(store.auditEntries(STREAM, wallet)).toHaveLength(1);
  });

  it('ties a stream to one network and one start ledger, and refuses a newer database', () => {
    const path = join(directory(), 'history.sqlite');
    const store = new HistoryStore(path);
    store.ensureStream(STREAM, networkIdOf(passphrase), 5);
    expect(store.ensureStream(STREAM, networkIdOf(passphrase), 5).ingested_ledger).toBe(4);
    expect(() => store.ensureStream(STREAM, networkIdOf('Another network'), 5)).toThrow('another network');
    expect(() => store.ensureStream(STREAM, networkIdOf(passphrase), 6)).toThrow('use a new stream ID');
    expect(() => store.ensureStream('other', networkIdOf(passphrase), 0)).toThrow('positive integer');
    store.close();

    const raw = new DatabaseSync(path);
    raw.exec("INSERT INTO schema_migration (version, applied_at) VALUES (99, 'later')");
    raw.close();
    expect(() => new HistoryStore(path)).toThrow('newer than this indexer');
  });
});

describe('retention gaps (A27)', () => {
  it('records the ledgers it could not read when it starts after the RPC stopped retaining them', async () => {
    const store = memory();
    const source = new FakeEvents();
    source.oldestLedger = 13;
    const chain = auditChain(wallet, 5);
    source.add(...chain.map((link) => link.event));

    const report = await ingest(store, source, config());
    expect(report.gap).toEqual({ from: 1, to: 13 });
    expect(store.stream(STREAM)).toMatchObject({ gap_from_ledger: 1, gap_to_ledger: 13, ingested_ledger: 100 });
    // Entries 4 and 5 are stored and match the head, and the history is still not complete.
    const audit = verifyWallet(store, STREAM, passphrase, wallet, headOf(chain));
    expect(audit).toMatchObject({ status: 'incomplete', entries: 2, missing: [{ from: 1, to: 3 }] });
    expect(audit.detail).toContain('ledgers 1 to 12 could not be read');
  });

  it('records a gap after being down for longer than the RPC retains, and never shrinks it', async () => {
    const store = memory();
    const source = new FakeEvents();
    const chain = auditChain(wallet, 6, 95);
    source.add(...chain.slice(0, 2).map((link) => link.event));
    source.latestLedger = 96;
    await ingest(store, source, config());
    expect(verifyWallet(store, STREAM, passphrase, wallet, headOf(chain.slice(0, 2))).status).toBe('verified');

    // Entries 3 and 4 were published at ledgers 97 and 98 and fell out of retention before the next pass.
    source.add(...chain.slice(2).map((link) => link.event));
    source.latestLedger = 200;
    source.oldestLedger = 99;
    const report = await ingest(store, source, config());
    expect(report.gap).toEqual({ from: 97, to: 99 });
    expect(store.auditEntries(STREAM, wallet).map((row) => row.sequence)).toEqual([1, 2, 5, 6]);
    expect(verifyWallet(store, STREAM, passphrase, wallet, headOf(chain)))
      .toMatchObject({ status: 'incomplete', missing: [{ from: 3, to: 4 }] });

    store.recordGap(STREAM, 150, 160);
    expect(store.stream(STREAM)).toMatchObject({ gap_from_ledger: 97, gap_to_ledger: 160 });
  });

  it('still verifies a history whose every entry arrived, whatever ledgers were skipped', async () => {
    const store = memory();
    const source = new FakeEvents();
    source.oldestLedger = 5;
    const chain = auditChain(wallet, 3);
    source.add(...chain.map((link) => link.event));
    expect((await ingest(store, source, config())).gap).toEqual({ from: 1, to: 5 });
    expect(verifyWallet(store, STREAM, passphrase, wallet, headOf(chain)).status).toBe('verified');
  });
});

describe('audit verification (A27)', () => {
  const chain = auditChain(wallet, 5);
  const verify = (stored: StoredAuditEntry[], head: AuditHead = headOf(chain), state = stream()) =>
    verifyStored(passphrase, wallet, stored, head, state);

  it('verifies a complete chain and an empty wallet', () => {
    expect(verify(rows(chain))).toMatchObject({
      status: 'verified', entries: 5, missing: [], head: { sequence: '5', hash: Buffer.from(chain[4]!.hash).toString('hex') },
    });
    expect(verify([], headOf([]))).toMatchObject({ status: 'verified', detail: 'No audit entries yet' });
  });

  it('reports an altered entry, hash or head as a mismatch', () => {
    const stored = rows(chain);
    const other = rows(auditChain(wallet, 5, 50));
    expect(verify(stored.map((row, i) => (i === 2 ? { ...row, entry_xdr: other[2]!.entry_xdr } : row))))
      .toMatchObject({ status: 'mismatch', detail: 'Entry 3 does not hash to its published hash' });
    expect(verify(stored.map((row, i) => (i === 2 ? { ...row, hash: 'ab'.repeat(32) } : row))).status).toBe('mismatch');
    expect(verify(stored.map((row, i) => (i === 2 ? { ...row, entry_xdr: 'AAAA' } : row))))
      .toMatchObject({ status: 'mismatch', detail: 'Entry 3 is not a valid audit entry' });
    expect(verify(stored, { sequence: 5n, hash: new Uint8Array(32).fill(9) }))
      .toMatchObject({ status: 'mismatch', detail: 'Entry 5 does not match the head the wallet stores' });
    expect(verifyStored(passphrase, contract(77), stored, headOf(chain), stream()).status).toBe('mismatch');
  });

  it('reports a substituted, duplicated or relabelled entry as a mismatch', () => {
    const stored = rows(chain);
    // A different, internally valid chain: each entry hashes correctly but does not follow the real one.
    const other = rows(auditChain(wallet, 5, 50));
    expect(verify([stored[0]!, stored[1]!, other[2]!, stored[3]!, stored[4]!]))
      .toMatchObject({ status: 'mismatch', detail: 'Entry 3 does not follow entry 2' });
    expect(verify([stored[0]!, stored[1]!, { ...other[1]!, event_id: 'z' }, stored[2]!, stored[3]!, stored[4]!]))
      .toMatchObject({ status: 'mismatch', detail: 'Two different entries claim sequence 2' });
    // Entry 3 filed under sequence 2: the row no longer says what the entry says.
    expect(verify([stored[0]!, { ...stored[2]!, sequence: 2 }]).status).toBe('mismatch');
  });

  it('reports missing entries as incomplete, never as verified', () => {
    const stored = rows(chain);
    expect(verify([stored[0]!, stored[1]!, stored[3]!, stored[4]!]))
      .toMatchObject({ status: 'incomplete', missing: [{ from: 3, to: 3 }] });
    expect(verify(stored.slice(2))).toMatchObject({ status: 'incomplete', missing: [{ from: 1, to: 2 }] });
    expect(verify([stored[1]!, stored[4]!]).missing).toEqual([{ from: 1, to: 1 }, { from: 3, to: 4 }]);
    // Even with entries missing, what is present is still checked.
    expect(verify([stored[0]!, stored[3]!, stored[4]!], { sequence: 5n, hash: new Uint8Array(32) }).status).toBe('mismatch');
  });

  it('tells waiting apart from loss when the stored entries and the head are at different points', () => {
    const stored = rows(chain);
    expect(verify(stored.slice(0, 3))).toMatchObject({ status: 'syncing', detail: expect.stringContaining('after 3') });
    expect(verify([], headOf(chain)).status).toBe('syncing');
    expect(verify(stored, headOf(chain.slice(0, 3)))).toMatchObject({ status: 'syncing' });
    // After a gap the missing tail may never arrive.
    expect(verify(stored.slice(0, 3), headOf(chain), stream({ gap_from_ledger: 13, gap_to_ledger: 20 })))
      .toMatchObject({ status: 'incomplete', missing: [{ from: 4, to: 5 }] });
  });
});

describe('read API', () => {
  const chain = auditChain(wallet, 5);

  async function serve(options: { token?: string; mutate?: (store: HistoryStore) => void; links?: Link[] } = {}) {
    const links = options.links ?? chain;
    const store = memory();
    const source = new FakeEvents().add(...links.map((link) => link.event),
      event(40, registry, 'identity_v1', xdr.ScVal.scvU32(1)), event(41, registry, 'provider_v1', xdr.ScVal.scvU32(2)));
    const state: IndexerState = { audit: new Map() };
    state.ingestion = await ingest(store, source, config());
    options.mutate?.(store);
    state.audit.set(wallet, verifyWallet(store, STREAM, passphrase, wallet, headOf(chain)));
    const server: Server = createServer(createHandler({
      store, streamId: STREAM, network: 'local', wallets: [wallet], state, token: options.token,
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const call = async (path: string, init?: RequestInit) => {
      const response = await fetch(new URL(path, base), init);
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    return { base, call, store, state };
  }

  it('reports position, lag, counts and audit status', async () => {
    const { call, state, store } = await serve();
    const health = await call('v1/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      status: 'ok', network: 'local', stream: STREAM, wallets: [wallet], ingested_ledger: 100, latest_ledger: 100,
      lag_ledgers: 0, retention_gap: null, ingestion_error: null, counts: { events: 7, audit: 5, quarantined: 0, attempts: 0 },
      audit: [{ wallet, status: 'verified', entries: 5 }],
    });

    state.ingestion = { ...state.ingestion!, latest_ledger: 130 };
    expect((await call('v1/health')).body).toMatchObject({ lag_ledgers: 30 });
    store.recordGap(STREAM, 101, 120);
    expect((await call('v1/health')).body).toMatchObject({ status: 'incomplete', retention_gap: { from_ledger: 101, to_ledger: 119 } });
    state.audit.set(wallet, { ...state.audit.get(wallet)!, status: 'mismatch' });
    expect((await call('v1/health')).body['status']).toBe('audit-mismatch');
    state.ingestionError = 'RPC unreachable';
    expect((await call('v1/health')).body).toMatchObject({ status: 'error', ingestion_error: 'RPC unreachable' });
  });

  it('pages history by sequence and events by ID without gaps or repeats', async () => {
    const { call } = await serve();
    const sequences: number[] = [];
    let after: number | null = 0;
    let pages = 0;
    while (after !== null) {
      const page = await call(`v1/wallets/${wallet}/history?after=${after}&limit=2`);
      expect(page.status).toBe(200);
      sequences.push(...page.body['entries'].map((entry: StoredAuditEntry) => entry.sequence));
      after = page.body['next_after'];
      pages += 1;
    }
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toBe(3);
    expect((await call(`v1/wallets/${wallet}/history`)).body).toMatchObject({ next_after: null, audit: { status: 'verified' } });

    const ids: string[] = [];
    let cursor: string | null = '';
    while (cursor !== null) {
      const page = await call(`v1/events?limit=3${cursor ? `&after=${cursor}` : ''}`);
      ids.push(...page.body['events'].map((item: { id: string }) => item.id));
      cursor = page.body['next_after'];
    }
    expect(ids).toHaveLength(7);
    expect([...ids].sort()).toEqual(ids);
    const filtered = await call(`v1/events?contract=${registry}&topic=provider_v1`);
    expect(filtered.body['events']).toMatchObject([{ contract: registry, topic: 'provider_v1', ledger: 41 }]);
    expect(Array.isArray(filtered.body['events'][0].topics_xdr)).toBe(true);
  });

  it('refuses malformed requests and wallets it does not follow', async () => {
    const { call } = await serve();
    for (const query of ['limit=0', 'limit=201', 'limit=abc', 'after=-1', 'after=1.5']) {
      expect((await call(`v1/wallets/${wallet}/history?${query}`)).status, query).toBe(400);
    }
    for (const query of ['contract=nope', 'topic=DROP%20TABLE', 'after=x%27', 'limit=1000']) {
      expect((await call(`v1/events?${query}`)).status, query).toBe(400);
    }
    expect((await call(`v1/wallets/${contract(99)}/history`)).status).toBe(404);
    expect((await call('v1/wallets/short/history')).status).toBe(404);
    expect((await call('v1/nothing')).status).toBe(404);
    expect((await call('v1/health', { method: 'POST' })).status).toBe(404);
  });

  it('records attempts apart from audit entries, once per transaction', async () => {
    const { call, store } = await serve();
    const post = (body: unknown, headers: Record<string, string> = {}) => call(`v1/wallets/${wallet}/attempts`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const refused = await post({ kind: 'simulation', status: 'refused', error: 'PaymentLimitExceeded' });
    expect(refused).toMatchObject({ status: 201, body: { id: 1, kind: 'simulation', error: 'PaymentLimitExceeded', tx_hash: null } });
    // The public RPC gives no diagnostics, so a failure may have no known reason.
    const failed = await post({ kind: 'transaction', status: 'failed', tx_hash: 'ab'.repeat(32) });
    expect(failed.body).toMatchObject({ id: 2, error: null });
    expect((await post({ kind: 'transaction', status: 'failed', error: 'Revoked', tx_hash: 'ab'.repeat(32) })).body)
      .toMatchObject({ id: 2, error: null });

    for (const body of [
      { kind: 'other', status: 'x' }, { kind: 'simulation' }, { kind: 'transaction', status: 'failed' },
      { kind: 'transaction', status: 'failed', tx_hash: 'nope' }, { kind: 'simulation', status: 'x', extra: 1 },
      { kind: 'simulation', status: 'x', detail: 'd'.repeat(2_001) }, [], 'not json',
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post({ kind: 'simulation', status: 'x', detail: 'd'.repeat(9_000) })).status).toBe(413);

    const listed = await call(`v1/wallets/${wallet}/attempts?limit=1`);
    expect(listed.body).toMatchObject({ attempts: [{ id: 1 }], next_after: 1 });
    expect((await call(`v1/wallets/${wallet}/attempts?after=1`)).body).toMatchObject({ attempts: [{ id: 2 }], next_after: null });
    // Attempts are observations: they never become audit entries.
    expect(store.counts(STREAM)).toMatchObject({ audit: 5, attempts: 2 });
  });

  it('requires the token for recording when one is configured', async () => {
    const token = 't'.repeat(40);
    const { call } = await serve({ token });
    const post = (headers: Record<string, string>) => call(`v1/wallets/${wallet}/attempts`, {
      method: 'POST', headers, body: JSON.stringify({ kind: 'simulation', status: 'refused' }),
    });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: `Bearer ${'x'.repeat(40)}` })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(201);
    expect((await call(`v1/wallets/${wallet}/attempts`)).status).toBe(200);
  });

  describe('read through the SDK, which trusts the network and not the indexer', () => {
    const read = (head: AuditHead = headOf(chain)) => ({
      contractId: wallet, source: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', networkPassphrase: passphrase,
      server: {
        simulateTransaction: async () => success([], xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('hash'), val: xdr.ScVal.scvBytes(Buffer.from(head.hash)) }),
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('sequence'), val: xdr.ScVal.scvU64(head.sequence) }),
        ])),
      },
    });

    it('verifies a complete history page by page', async () => {
      const { base } = await serve();
      const history = await readIndexedHistory(read(), base, { pageSize: 2 });
      expect(history).toMatchObject({ status: 'verified', indexer: { status: 'verified' } });
      expect(history.entries.map((record) => record.entry.sequence)).toEqual([1n, 2n, 3n, 4n, 5n]);
      expect(history.entries[4]!.hash).toEqual(chain[4]!.hash);
    });

    it('does not accept an indexer that withholds or alters entries, whatever status it claims', async () => {
      const raw = (store: HistoryStore) => (store as unknown as { db: DatabaseSync }).db;
      const withheld = await serve({
        mutate: (store) => raw(store).exec('DELETE FROM audit_entry WHERE sequence >= 4'),
      });
      withheld.state.audit.set(wallet, { ...withheld.state.audit.get(wallet)!, status: 'verified' });
      expect(await readIndexedHistory(read(), withheld.base))
        .toMatchObject({ status: 'incomplete', indexer: { status: 'verified' } });

      const first = await serve({ mutate: (store) => raw(store).exec('DELETE FROM audit_entry WHERE sequence = 1') });
      expect((await readIndexedHistory(read(), first.base)).status).toBe('incomplete');
      const middle = await serve({ mutate: (store) => raw(store).exec('DELETE FROM audit_entry WHERE sequence = 3') });
      expect((await readIndexedHistory(read(), middle.base)).status).toBe('mismatch');

      const other = rows(auditChain(wallet, 5, 50));
      const altered = await serve({
        mutate: (store) => raw(store).prepare('UPDATE audit_entry SET entry_xdr = ? WHERE sequence = 2').run(other[1]!.entry_xdr),
      });
      expect((await readIndexedHistory(read(), altered.base)).status).toBe('mismatch');
      const garbled = await serve({
        mutate: (store) => raw(store).exec("UPDATE audit_entry SET entry_xdr = 'AAAA' WHERE sequence = 2"),
      });
      expect(await readIndexedHistory(read(), garbled.base))
        .toMatchObject({ status: 'mismatch', detail: 'Entry 2 from the indexer is not a valid audit entry' });

      // A whole substituted history is internally consistent and still fails against the head on the network.
      const substituted = await serve({ links: auditChain(wallet, 5, 50) });
      expect((await readIndexedHistory(read(), substituted.base)).status).toBe('mismatch');
    });

    it('fails loudly on a response that is not a history page', async () => {
      const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
      await expect(readIndexedHistory(read(), 'http://indexer.test/', { fetch: answer({}, 503) })).rejects.toThrow('503');
      await expect(readIndexedHistory(read(), 'http://indexer.test/', { fetch: answer({ rows: [] }) })).rejects.toThrow('malformed');
      await expect(readIndexedHistory(read(), 'http://indexer.test/', { fetch: answer({ entries: [{ sequence: 1 }] }) }))
        .rejects.toThrow('lacks a field');
      await expect(readIndexedHistory(read(), 'http://indexer.test/', { fetch: answer({ entries: [], next_after: 0 }) }))
        .rejects.toThrow('does not advance');
    });
  });
});

describe('configuration', () => {
  const env = {
    STELLAR_NETWORK: 'local', WALLET_ID: wallet, AGENT_REGISTRY_ID: registry, VERIFICATION_REGISTRY_ID: contract(22),
    INDEXER_START_LEDGER: '7', DEPLOYMENT_EPOCH: 'local-test',
  };

  it('follows the configured wallet and registries from an explicit start ledger', () => {
    const parsed = indexerConfig(env);
    expect(parsed).toMatchObject({
      host: '127.0.0.1', port: 8788, pollSeconds: 5, tokenFile: undefined,
      stream: { id: 'local:local-test', wallets: [wallet], contracts: [registry, contract(22)], startLedger: 7 },
    });
    expect(parsed.databasePath.endsWith('.local/history.sqlite')).toBe(true);
    expect(indexerConfig({ ...env, INDEXER_WALLETS: `${contract(30)}, ${contract(31)}`, INDEXER_CONTRACTS: contract(32) }).stream)
      .toMatchObject({ wallets: [contract(30), contract(31)], contracts: [contract(32), registry, contract(22)] });
  });

  it('refuses to guess a start ledger, a wallet or an address', () => {
    expect(() => indexerConfig({ ...env, INDEXER_START_LEDGER: undefined })).toThrow('INDEXER_START_LEDGER');
    expect(() => indexerConfig({ ...env, INDEXER_START_LEDGER: '0' })).toThrow('INDEXER_START_LEDGER');
    expect(() => indexerConfig({ ...env, WALLET_ID: undefined })).toThrow('INDEXER_WALLETS');
    expect(() => indexerConfig({ ...env, INDEXER_WALLETS: 'GABC' })).toThrow('not a contract address');
    expect(() => indexerConfig({ ...env, INDEXER_PORT: '70000' })).toThrow('INDEXER_PORT');
  });

  it('keeps the token file out of reach of other users', async () => {
    const { startIndexer } = await import('../../services/indexer/src/index.js');
    const path = join(directory(), 'token');
    writeFileSync(path, 't'.repeat(40), { mode: 0o644 });
    await expect(startIndexer({ ...env, INDEXER_TOKEN_FILE: path })).rejects.toThrow('owner only');
    await expect(startIndexer({ ...env, INDEXER_HOST: '0.0.0.0' })).rejects.toThrow('INDEXER_TOKEN_FILE');
  });
});
