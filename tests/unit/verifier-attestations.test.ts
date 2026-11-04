import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Keypair, Networks, SorobanDataBuilder, rpc, xdr } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeVerification } from '../../packages/sdk/src/encoding.js';
import type { AgentIdentity } from '../../packages/sdk/src/types.js';
import { validatePublication } from '../../packages/sdk/src/verification.js';
import {
  PublicationPending, ReportStore, canonicalJson, prepareAssessment, publishResult, readAccountSnapshot,
  settlePending, type PublishTarget,
} from '../../services/verifier/src/attestations.js';
import {
  MIN_SIGNER_AGE_LEDGERS, endpointFinding, metadataFinding, runChecks, signerAccountFinding, signerHistoryFinding,
  type AccountSnapshot,
} from '../../services/verifier/src/checks.js';
import { loadProviderKey } from '../../services/verifier/src/index.js';
import { AGENT_METADATA_SCHEMA, type AgentMetadataV1 } from '../../services/verifier/src/metadata.js';
import { FetchRejected, readCapped, type Resolver, type Transport } from '../../services/verifier/src/net.js';
import { account, contract } from '../fixtures/abi-v1.js';

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array) => Uint8Array.from(createHash('sha256').update(bytes).digest());
const resolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const tls = { protocol: 'TLSv1.3', authorized: true };

const metadata: AgentMetadataV1 = {
  schema: AGENT_METADATA_SCHEMA, name: 'Example agent',
  endpoints: [{ name: 'api', url: 'https://api.agent.example/v1' }],
};
const document = encoder.encode(JSON.stringify(metadata));
const signer = Keypair.random().publicKey();
const identity: AgentIdentity = {
  agent_id: 3n, controller: account(1), signer, metadata_uri: 'https://agent.example/agent.json',
  metadata_hash: sha256(document), revision: 2n, disabled: false,
};
const established: AccountSnapshot = {
  thresholds: { master: 1, low: 0, medium: 0, high: 0 }, extraSigners: 0, sequence: 100n << 32n,
};

/** Serves the metadata document at its URI and answers every other host with `endpointStatus`. */
function site(endpointStatus = 204, endpointTls = tls): Transport {
  return async ({ url, maxBytes }) => {
    const body = url.hostname === 'agent.example' ? document : new Uint8Array();
    return {
      status: url.hostname === 'agent.example' ? 200 : endpointStatus, location: undefined,
      contentType: 'application/json', body: await readCapped(Readable.from([body]), maxBytes),
      tls: url.hostname === 'agent.example' ? tls : endpointTls,
    };
  };
}

describe('check adapters', () => {
  it('maps metadata resolutions to scored or unscored outcomes', () => {
    const base = { sha256: identity.metadata_hash, bytes: 10, finalUrl: identity.metadata_uri };
    expect(metadataFinding({ status: 'verified', document: metadata, ...base }, identity.metadata_hash))
      .toMatchObject({ outcome: 'Passed', score: 0 });
    expect(metadataFinding({ status: 'hash-mismatch', ...base }, identity.metadata_hash))
      .toMatchObject({ outcome: 'Failed', score: 100 });
    expect(metadataFinding({ status: 'invalid', error: 'x', path: '/name', ...base }, identity.metadata_hash))
      .toMatchObject({ outcome: 'Failed', score: 100 });
    for (const reason of ['url', 'private-address', 'tls', 'redirect', 'too-large'] as const) {
      expect(metadataFinding({ status: 'unavailable', reason, detail: '' }, identity.metadata_hash), reason)
        .toMatchObject({ outcome: 'Failed', score: 100 });
    }
    for (const reason of ['timeout', 'network', 'dns', 'status'] as const) {
      expect(metadataFinding({ status: 'unavailable', reason, detail: '' }, identity.metadata_hash), reason)
        .toMatchObject({ outcome: 'Inconclusive', score: null });
    }
  });

  it('requires every endpoint to answer over verified modern TLS', async () => {
    const options = (transport: Transport) => ({ resolver, transport });
    expect(await endpointFinding(undefined)).toMatchObject({ outcome: 'Inconclusive', score: null });
    expect(await endpointFinding({ ...metadata, endpoints: [] })).toMatchObject({ outcome: 'NotApplicable' });
    expect(await endpointFinding(metadata, options(site(405)))).toMatchObject({ outcome: 'Passed', score: 0 });
    expect(await endpointFinding(metadata, options(site(503)))).toMatchObject({ outcome: 'Failed', score: 100 });
    expect(await endpointFinding(metadata, options(site(200, { protocol: 'TLSv1.1', authorized: true }))))
      .toMatchObject({ outcome: 'Failed' });
    const refusing: Transport = async () => { throw new FetchRejected('tls', 'certificate'); };
    const finding = await endpointFinding(metadata, options(refusing));
    expect(finding).toMatchObject({ outcome: 'Failed', score: 100 });
    expect(finding.evidence).toEqual({ endpoints: [{ url: metadata.endpoints[0]!.url, ok: false, reason: 'tls', detail: 'certificate' }] });
    const privateDns: Resolver = async () => [{ address: '10.0.0.1', family: 4 }];
    expect(await endpointFinding(metadata, { resolver: privateDns, transport: site() })).toMatchObject({ outcome: 'Failed' });
  });

  it('checks the signer account can authorize alone', () => {
    expect(signerAccountFinding(signer, null)).toMatchObject({ outcome: 'Failed', score: 100 });
    expect(signerAccountFinding(signer, established)).toMatchObject({ outcome: 'Passed', score: 0 });
    const locked = { ...established, thresholds: { master: 0, low: 0, medium: 0, high: 0 } };
    expect(signerAccountFinding(signer, locked)).toMatchObject({ outcome: 'Failed' });
    const multisig = { ...established, thresholds: { master: 1, low: 1, medium: 2, high: 2 }, extraSigners: 1 };
    expect(signerAccountFinding(signer, multisig)).toMatchObject({ outcome: 'Failed' });
    const atThreshold = { ...established, thresholds: { master: 2, low: 1, medium: 2, high: 3 } };
    expect(signerAccountFinding(signer, atThreshold)).toMatchObject({ outcome: 'Passed' });
  });

  it('estimates history from the sequence number and never scores a young account', () => {
    const created = 100;
    expect(signerHistoryFinding(null, 1_000)).toMatchObject({ outcome: 'Inconclusive', score: null });
    expect(signerHistoryFinding(established, created + MIN_SIGNER_AGE_LEDGERS - 1))
      .toMatchObject({ outcome: 'Inconclusive', score: null });
    expect(signerHistoryFinding(established, created + MIN_SIGNER_AGE_LEDGERS)).toMatchObject({ outcome: 'Passed', score: 0 });
    // A bumped sequence makes the account look younger, never older.
    const bumped = { ...established, sequence: (5_000_000n << 32n) + 7n };
    expect(signerHistoryFinding(bumped, created + MIN_SIGNER_AGE_LEDGERS)).toMatchObject({ outcome: 'Inconclusive' });
  });

  it('reports all eight kinds with unsupported families unscored', async () => {
    const findings = await runChecks({ identity, account: established, latestLedger: 200, resolver, transport: site() });
    expect(findings.map(({ kind, outcome }) => [kind, outcome])).toEqual([
      ['Metadata', 'Passed'], ['Endpoint', 'Passed'], ['SignerAccount', 'Passed'], ['SignerHistory', 'Inconclusive'],
      ['Code', 'Unsupported'], ['Media', 'Unsupported'], ['ThreatFeed', 'Unsupported'], ['Token', 'Unsupported'],
    ]);
    const tampered = await runChecks({
      identity: { ...identity, metadata_hash: new Uint8Array(32).fill(1) }, account: null, latestLedger: 200,
      resolver, transport: site(),
    });
    expect(tampered.slice(0, 4).map(({ outcome }) => outcome)).toEqual(['Failed', 'Inconclusive', 'Failed', 'Inconclusive']);
  });
});

describe('assessments and reports', () => {
  const input = async () => ({
    networkPassphrase: Networks.STANDALONE, agentRegistry: contract(1), verificationRegistry: contract(2),
    provider: Keypair.random().publicKey(), mode: 'Live' as const, identity, account: established,
    findings: await runChecks({ identity, account: established, latestLedger: 200, resolver, transport: site() }),
    sequence: 1n, issuedAt: 1_800_000_000n,
  });

  it('commits the result to the hash of a deterministic report', async () => {
    const values = await input();
    const first = prepareAssessment(values);
    const second = prepareAssessment({ ...values, findings: [...values.findings].reverse() });
    expect(Buffer.from(first.report).equals(Buffer.from(second.report))).toBe(true);
    expect(first.evidenceHash).toEqual(sha256(first.report));
    expect(first.result.evidence_hash).toEqual(first.evidenceHash);
    expect(first.result).toMatchObject({ risk_score: 0, sequence: 1n, expires_at: values.issuedAt + 86_400n, mode: 'Live' });
    expect(() => validatePublication(first.result, values.issuedAt)).not.toThrow();
    const report = JSON.parse(new TextDecoder().decode(first.report)) as Record<string, unknown>;
    expect(report).toMatchObject({ schema: 'stellar-agent-auth/verification-report/v1' });
    expect(Object.keys(report)).toEqual([...Object.keys(report)].sort());
    expect((report['checks'] as { kind: string }[]).map(({ kind }) => kind))
      .toEqual(first.result.checks.map(({ kind }) => kind));
    expect(() => prepareAssessment({ ...values, validitySeconds: 0n })).toThrow('positive');
  });

  it('serializes canonically', () => {
    expect(canonicalJson({ b: 1n, a: [new Uint8Array([1, 255])], c: undefined })).toBe('{"a":["01ff"],"b":"1"}');
  });
});

describe('local state', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'verifier-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('stores reports by content hash, atomically and idempotently', async () => {
    const store = new ReportStore(join(directory, 'reports'));
    const report = encoder.encode('{"a":1}');
    const saved = await store.save(report);
    expect(saved.hash).toEqual(sha256(report));
    await store.save(report);
    expect(await readdir(join(directory, 'reports'))).toEqual([`${Buffer.from(saved.hash).toString('hex')}.json`]);
    expect(await store.load(saved.hash)).toEqual(report);
    await writeFile(saved.path, 'tampered');
    await expect(store.load(saved.hash)).rejects.toThrow('corrupt');
  });

  it('loads the provider key only from an owner-only file', async () => {
    const key = Keypair.random();
    const path = join(directory, 'provider.key');
    await writeFile(path, `${key.secret()}\n`, { mode: 0o600 });
    expect((await loadProviderKey(path)).publicKey()).toBe(key.publicKey());
    await chmod(path, 0o640);
    await expect(loadProviderKey(path)).rejects.toThrow('group or others');
  });

  it('reads account snapshots and treats a missing account as absent', async () => {
    const entry = { thresholds: { value: Uint8Array.from([1, 0, 2, 3]) }, signers: [{}], seqNum: 42n };
    const snapshot = await readAccountSnapshot({ getAccountEntry: async () => entry as never }, signer);
    expect(snapshot).toEqual({ thresholds: { master: 1, low: 0, medium: 2, high: 3 }, extraSigners: 1, sequence: 42n });
    const missing = { getAccountEntry: async () => { throw new Error(`Account not found: ${signer}`); } };
    await expect(readAccountSnapshot(missing, signer)).resolves.toBeNull();
    const broken = { getAccountEntry: async () => { throw new Error('socket hang up'); } };
    await expect(readAccountSnapshot(broken, signer)).rejects.toThrow('socket');
  });
});

describe('journaled publication', () => {
  const provider = Keypair.random();
  const registry = contract(60);
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'verifier-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  const assessment = () => prepareAssessment({
    networkPassphrase: Networks.STANDALONE, agentRegistry: contract(1), verificationRegistry: registry,
    provider: provider.publicKey(), mode: 'Live', identity, account: established,
    findings: [{ kind: 'Metadata', outcome: 'Passed', score: 0, summary: '', evidence: {} }],
    sequence: 1n, issuedAt: 1_800_000_000n,
  });

  /** A fake RPC that records submissions and answers transaction status from `statuses`. */
  function server(statuses: Record<string, object>, closeTime = '0') {
    const sent: string[] = [];
    const value = assessment().result;
    return {
      sent,
      api: {
        getAccount: async () => ({
          accountId: () => provider.publicKey(), sequenceNumber: () => '1', incrementSequenceNumber() {},
        }) as never,
        simulateTransaction: async () => ({
          id: '1', latestLedger: 10, events: [], _parsed: true, transactionData: new SorobanDataBuilder(),
          minResourceFee: '100', result: { auth: [], retval: xdr.ScVal.scvVoid() },
        }) as never,
        sendTransaction: async (tx: { hash(): Uint8Array }) => {
          sent.push(Buffer.from(tx.hash()).toString('hex'));
          return { status: 'PENDING', hash: sent.at(-1) } as never;
        },
        getTransaction: async (hash: string) => (statuses[hash] ?? statuses['*'] ?? {
          status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 77, returnValue: encodeVerification(value),
        }) as never,
        getLatestLedger: async () => ({ sequence: 10, closeTime }) as never,
      },
    };
  }

  const target = (api: PublishTarget['server']): PublishTarget => ({
    server: api, contractId: registry, networkPassphrase: Networks.STANDALONE, provider,
    stateDirectory: directory, pollAttempts: 1,
  });

  it('submits once, confirms and clears the journal', async () => {
    const fake = server({});
    const published = await publishResult(target(fake.api), assessment().result);
    expect(fake.sent).toHaveLength(1);
    expect(published).toMatchObject({ hash: fake.sent[0], ledger: 77, result: assessment().result });
    expect(await readdir(directory)).toEqual([]);
  });

  it('keeps the journal when the outcome is unknown and settles it on the next run', async () => {
    const notFound = { status: rpc.Api.GetTransactionStatus.NOT_FOUND };
    const pending = server({ '*': notFound }, '0');
    await expect(publishResult(target(pending.api), assessment().result)).rejects.toBeInstanceOf(PublicationPending);
    const [journal] = await readdir(directory);
    const recorded = JSON.parse(await readFile(join(directory, journal!), 'utf8')) as { hash: string; max_time: string };
    expect(recorded.hash).toBe(pending.sent[0]);

    // Still within its time bound: no second transaction is built.
    const stillPending = server({ '*': notFound }, recorded.max_time);
    await expect(publishResult(target(stillPending.api), assessment().result)).rejects.toBeInstanceOf(PublicationPending);
    expect(stillPending.sent).toEqual([]);

    // The earlier transaction committed: it is the outcome, and nothing new is sent.
    const committed = server({});
    const settled = await settlePending(target(committed.api), assessment().result);
    expect(settled).toMatchObject({ hash: recorded.hash, ledger: 77 });
    expect(committed.sent).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it('clears an expired attempt and only then builds a new one', async () => {
    const notFound = { status: rpc.Api.GetTransactionStatus.NOT_FOUND };
    const first = server({ '*': notFound });
    await expect(publishResult(target(first.api), assessment().result)).rejects.toBeInstanceOf(PublicationPending);
    const [journal] = await readdir(directory);
    const { max_time } = JSON.parse(await readFile(join(directory, journal!), 'utf8')) as { max_time: string };
    const expired = server({ [first.sent[0]!]: notFound }, (BigInt(max_time) + 1n).toString());
    await expect(settlePending(target(expired.api), assessment().result)).resolves.toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses to publish another provider\'s result', async () => {
    const other = { ...assessment().result, provider: account(9) };
    await expect(publishResult(target(server({}).api), other)).rejects.toThrow('different provider');
  });
});
