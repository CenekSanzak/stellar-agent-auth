import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../packages/cli/src/index.js';
import { readAuditHistory, readIndexedHistory } from '../../packages/sdk/src/history.js';
import { readAuditHead } from '../../packages/sdk/src/wallet.js';
import { startIndexer, type RunningIndexer } from '../../services/indexer/src/index.js';
import { localNetwork } from './support/local-network.js';
import { UNIT, walletWorld, type WalletWorld } from './support/wallet-world.js';

const TIMEOUT = 180_000;

/**
 * A26 and A27 against a real RPC: the indexer follows a fresh deployment from its first ledger, survives a restart
 * without losing or repeating anything, and its history verifies against the head the wallet stores. Retention gaps
 * cannot be produced on a local network; `tests/unit/indexer.test.ts` covers them.
 */
describe('indexer on local Stellar (A26, A27)', () => {
  let w: WalletWorld;
  let env: Record<string, string | undefined>;
  let directory: string;
  let indexer: RunningIndexer | undefined;
  let policy: Uint8Array;

  const get = async (path: string) => {
    const response = await fetch(new URL(path, indexer!.url));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const stream = () => indexer!.store.stream(`local:${env['DEPLOYMENT_EPOCH']}`)!;

  beforeAll(async () => {
    const net = await localNetwork();
    // Read before anything is deployed, so the stream covers the deployment's whole life.
    const start = (await net.server.getLatestLedger()).sequence;
    w = await walletWorld(net);
    directory = mkdtempSync(join(tmpdir(), 'indexer-local-'));
    env = {
      ...process.env, WALLET_ID: w.wallet, AGENT_REGISTRY_ID: w.agentRegistry,
      VERIFICATION_REGISTRY_ID: w.verificationRegistry, INDEXER_START_LEDGER: String(start),
      INDEXER_DATABASE_PATH: join(directory, 'history.sqlite'), INDEXER_PORT: '0', INDEXER_WALLETS: undefined,
      INDEXER_CONTRACTS: undefined, INDEXER_TOKEN_FILE: undefined, INDEXER_HOST: undefined,
      DEPLOYMENT_EPOCH: `test-${start}`,
    };
  }, TIMEOUT);

  afterAll(async () => {
    await indexer?.stop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('follows a new deployment from its first ledger and reports an empty wallet as verified', async () => {
    indexer = await startIndexer(env, { poll: false });
    const health = await get('v1/health');
    expect(health.body).toMatchObject({
      status: 'ok', network: 'local', wallets: [w.wallet], retention_gap: null, ingestion_error: null,
      audit: [{ wallet: w.wallet, status: 'verified', entries: 0, detail: 'No audit entries yet' }],
    });
    expect(health.body['counts']).toMatchObject({ audit: 0, quarantined: 0 });
    // The registries were deployed inside the stream: registration, provider approval and the fixture result.
    const topics = (await get('v1/events?limit=200')).body['events'].map((event: { topic: string }) => event.topic);
    expect(new Set(topics)).toEqual(new Set(['identity_v1', 'provider_v1', 'assessment_v1']));
    // A short page's cursor reaches the RPC's latest ledger, so ingestion knows it has caught up.
    expect(health.body['lag_ledgers']).toBe(0);
    expect(stream().ingested_ledger).toBe(indexer.state.ingestion!.latest_ledger);
  }, TIMEOUT);

  it('reconstructs the audit chain and matches the head the wallet stores', async () => {
    await w.fund(50n * UNIT);
    policy = await w.approve(await w.policy(61));
    const paid = await w.execute(await w.payment(policy, 1n, 3n * UNIT));
    await w.ownerCall('pause', {});
    await w.ownerCall('resume', {});

    const { ingestion, audit } = await indexer!.cycle();
    expect(ingestion.audit).toBe(4);
    const head = await readAuditHead(w.read);
    expect(head.sequence).toBe(4n);
    expect(audit).toMatchObject([{
      wallet: w.wallet, status: 'verified', entries: 4, missing: [],
      head: { sequence: '4', hash: Buffer.from(head.hash).toString('hex') },
    }]);

    const page = await get(`v1/wallets/${w.wallet}/history?limit=3`);
    expect(page.body).toMatchObject({ next_after: 3, audit: { status: 'verified' } });
    expect(page.body['entries'].map((entry: { sequence: number }) => entry.sequence)).toEqual([1, 2, 3]);
    expect(page.body['entries'][1]).toMatchObject({ tx_hash: Buffer.from(paid.prepared.hash()).toString('hex'), wallet: w.wallet });

    // Read through the SDK, the entries are verified again against the network, and equal what the RPC itself says.
    const indexed = await readIndexedHistory(w.read, indexer!.url, { pageSize: 3 });
    expect(indexed).toMatchObject({ status: 'verified', indexer: { status: 'verified' } });
    const live = await readAuditHistory({ ...w.read, server: w.net.server }, { startLedger: Number(env['INDEXER_START_LEDGER']) });
    expect(live.status).toBe('verified');
    expect(indexed.entries).toEqual(live.entries);
    expect(indexed.entries.map((record) => record.entry.outcome.kind))
      .toEqual(['PolicyCreated', 'Executed', 'PauseChanged', 'PauseChanged']);
  }, TIMEOUT);

  it('adds nothing on another pass and loses nothing across a restart', async () => {
    const before = indexer!.store.counts(stream().id);
    expect((await indexer!.cycle()).ingestion).toMatchObject({ events: 0, audit: 0, quarantined: 0 });
    expect(indexer!.store.counts(stream().id)).toEqual(before);

    await indexer!.stop();
    indexer = undefined;
    // Published while the indexer is down.
    await w.execute(await w.payment(policy, 2n, 2n * UNIT));
    await w.ownerCall('revoke_policy', { policy_hash: policy });

    indexer = await startIndexer(env, { poll: false });
    const after = indexer.store.counts(stream().id);
    expect(after.audit).toBe(6);
    expect(after.events).toBeGreaterThan(before.events);
    expect(indexer.state.audit.get(w.wallet)).toMatchObject({ status: 'verified', entries: 6 });
    // Everything from before the restart is still there exactly once.
    const sequences = indexer.store.auditEntries(stream().id, w.wallet).map((row) => row.sequence);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await readIndexedHistory(w.read, indexer.url)).status).toBe('verified');
  }, TIMEOUT);

  it('refuses to reopen a stream from another start ledger', async () => {
    const other = { ...env, INDEXER_START_LEDGER: String(Number(env['INDEXER_START_LEDGER']) + 1) };
    await indexer!.stop();
    indexer = undefined;
    await expect(startIndexer(other, { poll: false })).rejects.toThrow('use a new stream ID');
    indexer = await startIndexer(env, { poll: false });
    expect(indexer.state.audit.get(w.wallet)!.status).toBe('verified');
  }, TIMEOUT);

  it('serves the CLI, which verifies what the indexer returns', async () => {
    const out: string[] = [];
    const code = await main(['history', '--wallet', w.wallet, '--indexer', indexer!.url, '--json'],
      { ...env, STELLAR_AGENT_AUTH_STATE_DIR: join(directory, 'cli') }, { out: (line) => out.push(line), err: () => {} });
    expect(code).toBe(0);
    const result = JSON.parse(out.join('\n')) as Record<string, any>;
    expect(result).toMatchObject({ ok: true, source: 'indexer', status: 'verified', indexer: { status: 'verified' } });
    expect(result['entries']).toHaveLength(6);
    expect(result['entries'][5]).toMatchObject({ sequence: '6', outcome: { kind: 'PolicyRevoked' } });
  }, TIMEOUT);

  it('keeps refused attempts apart from the audit chain', async () => {
    await w.expectRejected(await w.payment(policy, 3n, 1n * UNIT), 'Revoked', 'after revocation');
    const recorded = await fetch(new URL(`v1/wallets/${w.wallet}/attempts`, indexer!.url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'simulation', status: 'refused', error: 'Revoked' }),
    });
    expect(recorded.status).toBe(201);
    expect((await get(`v1/wallets/${w.wallet}/attempts`)).body['attempts'])
      .toMatchObject([{ kind: 'simulation', status: 'refused', error: 'Revoked', tx_hash: null }]);
    expect((await indexer!.cycle()).audit[0]).toMatchObject({ status: 'verified', entries: 6 });
  }, TIMEOUT);

  it('reports a database that lost or changed an entry, and the SDK does not accept it either', async () => {
    await indexer!.stop();
    indexer = undefined;
    const raw = new DatabaseSync(env['INDEXER_DATABASE_PATH']!);
    const kept = raw.prepare('SELECT entry_xdr FROM audit_entry WHERE sequence = 3').get() as { entry_xdr: string };
    raw.exec('DELETE FROM audit_entry WHERE sequence = 3');
    raw.close();

    indexer = await startIndexer(env, { poll: false });
    expect(indexer.state.audit.get(w.wallet)).toMatchObject({ status: 'incomplete', missing: [{ from: 3, to: 3 }] });
    expect((await get('v1/health')).body['status']).toBe('incomplete');
    expect((await readIndexedHistory(w.read, indexer.url)).status).toBe('mismatch');
    await indexer.stop();
    indexer = undefined;

    // Entry 3's content filed as entry 4: every row is present, and one no longer hashes to what was published.
    const altered = new DatabaseSync(env['INDEXER_DATABASE_PATH']!);
    altered.prepare('UPDATE audit_entry SET entry_xdr = ? WHERE sequence = 4').run(kept.entry_xdr);
    altered.close();
    indexer = await startIndexer(env, { poll: false });
    expect(indexer.state.audit.get(w.wallet)!.status).toBe('mismatch');
    expect((await get('v1/health')).body['status']).toBe('audit-mismatch');
    const out: string[] = [];
    const code = await main(['history', '--wallet', w.wallet, '--indexer', indexer.url, '--json'],
      { ...env, STELLAR_AGENT_AUTH_STATE_DIR: join(directory, 'cli') }, { out: (line) => out.push(line), err: () => {} });
    expect(code).toBe(1);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: false, status: 'mismatch' });
  }, TIMEOUT);
});
