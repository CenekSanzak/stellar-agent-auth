import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account, Contract, Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../packages/cli/src/index.js';
import { EXIT, OutcomeError, Runtime, classify, settled } from '../../packages/cli/src/runtime.js';
import { FileJournal, KeyReferenceError, createNamedKey, loadKey } from '../../packages/sdk/src/node.js';
import { WalletError } from '../../packages/sdk/src/policies.js';
import { SponsorOutcomeUnknown, SponsorRefused } from '../../packages/sdk/src/sponsor.js';
import {
  FeeCeilingExceeded, SimulationRejected, SubmissionUnsettled, buildTransaction, pipelineLimits,
  type TransactionOutcome, type TransactionRecord,
} from '../../packages/sdk/src/transactions.js';
import { contract } from '../fixtures/abi-v1.js';
import { FakeRpc, hex } from './support/fake-rpc.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'saa-cli-'));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

const record = (overrides: Partial<TransactionRecord> = {}): TransactionRecord => ({
  scope: 's', hash: 'a'.repeat(64), envelope: 'AAAA', source: Keypair.random().publicKey(), max_time: '1',
  submitted_after_ledger: 1, status: 'pending', created_at: '2026-11-04T00:00:00.000Z',
  updated_at: '2026-11-04T00:00:00.000Z', ...overrides,
});

describe('key references', () => {
  it('never accepts a secret inline and requires owner-only key files', async () => {
    const key = Keypair.random();
    await expect(loadKey(key.secret(), {})).rejects.toThrow('never a secret key');
    const path = join(directory, 'k.key');
    await writeFile(path, `${key.secret()}\n`, { mode: 0o644 });
    await chmod(path, 0o644);
    await expect(loadKey(`file:${path}`, {})).rejects.toThrow('owner only');
    await chmod(path, 0o600);
    expect((await loadKey(`file:${path}`, {})).address).toBe(key.publicKey());
    expect((await loadKey('env:AGENT_SECRET', { AGENT_SECRET: key.secret() })).address).toBe(key.publicKey());
    await expect(loadKey('env:MISSING', {})).rejects.toThrow('not set');
    await expect(loadKey('env:bad-name', {})).rejects.toBeInstanceOf(KeyReferenceError);
    await expect(loadKey('../escape', { STELLAR_AGENT_AUTH_KEY_DIR: directory })).rejects.toThrow('Invalid key name');
    await writeFile(join(directory, 'public.key'), key.publicKey(), { mode: 0o600 });
    await expect(loadKey('public', { STELLAR_AGENT_AUTH_KEY_DIR: directory })).rejects.toThrow('does not hold a secret key');
  });

  it('creates named keys owner-only and never overwrites one', async () => {
    const env = { STELLAR_AGENT_AUTH_KEY_DIR: directory };
    const address = await createNamedKey('owner', env);
    expect((await stat(join(directory, 'owner.key'))).mode & 0o777).toBe(0o600);
    expect((await loadKey('owner', env)).address).toBe(address);
    await expect(createNamedKey('owner', env)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});

describe('file journal', () => {
  it('persists records owner-only and lists unsettled ones per scope, oldest first', async () => {
    const journal = new FileJournal(join(directory, 'journal'));
    await journal.put(record({ hash: 'b'.repeat(64), created_at: '2026-11-04T00:00:02.000Z' }));
    await journal.put(record({ hash: 'c'.repeat(64), created_at: '2026-11-04T00:00:01.000Z', status: 'unknown' }));
    await journal.put(record({ hash: 'd'.repeat(64), status: 'success' }));
    await journal.put(record({ hash: 'e'.repeat(64), scope: 'other' }));
    await writeFile(join(directory, 'journal', 'notes.txt'), 'ignored');
    expect((await journal.unsettled('s')).map(({ hash }) => hash[0])).toEqual(['c', 'b']);
    expect(await journal.get('f'.repeat(64))).toBeUndefined();
    await expect(journal.get('../x')).rejects.toThrow('transaction hash');
    const files = await readdir(join(directory, 'journal'));
    expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect((await stat(join(directory, 'journal', `${'b'.repeat(64)}.json`))).mode & 0o777).toBe(0o600);
    expect(await new FileJournal(join(directory, 'absent')).unsettled('s')).toEqual([]);
  });
});

describe('command outcomes and exit codes', () => {
  const outcome = (status: TransactionOutcome['status'], extra: Partial<TransactionOutcome> = {}): TransactionOutcome => ({
    status, hash: 'a'.repeat(64), record: record({ status }), ...extra,
  });

  it('reports only a confirmed success as success', () => {
    expect(settled({ outcome: outcome('success') })).toMatchObject({ status: 'success' });
    for (const status of ['pending', 'unknown'] as const) {
      const error = (() => {
        try {
          settled({ outcome: outcome(status) });
        } catch (thrown) {
          return thrown;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(OutcomeError);
      // The instruction is to query the hash; repeating the command would sign a new request.
      expect(error).toMatchObject({ exitCode: EXIT.pending, message: /Do not repeat the command; query it with "tx status/ });
    }
    for (const status of ['failed', 'expired', 'rejected'] as const) {
      expect(() => settled({ outcome: outcome(status, status === 'failed' ? { code: 'TransferFailed' } : {}) }))
        .toThrow(status === 'failed' ? /TransferFailed \(#14\)/ : status);
    }
  });

  it('maps every error class to a stable exit code', () => {
    expect(classify(new SimulationRejected('HostError: Error(Contract, #12)'))).toMatchObject({
      code: EXIT.rejected, result: { stage: 'simulation', error: 'Paused' },
    });
    expect(classify(new WalletError('LimitExceeded', 'too much'))).toMatchObject({
      code: EXIT.rejected, result: { stage: 'precheck', error: 'LimitExceeded' },
    });
    expect(classify(new FeeCeilingExceeded(5n, 1n)).code).toBe(EXIT.rejected);
    expect(classify(new SponsorRefused('no')).code).toBe(EXIT.rejected);
    expect(classify(new SubmissionUnsettled(record()))).toMatchObject({
      code: EXIT.pending, message: expect.stringContaining('tx status --hash'),
    });
    expect(classify(new SponsorOutcomeUnknown(120, new Error('fetch failed')))).toMatchObject({
      code: EXIT.pending, result: { status: 'unknown', stage: 'sponsor', auth_expiration_ledger: 120 },
    });
    expect(classify(new Error('boom')).code).toBe(EXIT.error);
  });

  it('reports an earlier submission that settled instead of building a new request', async () => {
    const rpc = new FakeRpc();
    const runtime = new Runtime({ STELLAR_NETWORK: 'local', STELLAR_AGENT_AUTH_STATE_DIR: join(directory, 'state') },
      { json: true, dryRun: false });
    (runtime as unknown as { network: Promise<unknown> }).network = Promise.resolve(rpc.context());
    const tx = buildTransaction(rpc.context(), new Account(Keypair.random().publicKey(), '5'),
      new Contract(contract(41)).call('execute'), pipelineLimits());
    const scope = 'execute:wallet:policy';
    await runtime.journal.put(record({ scope, hash: hex(tx.hash()), max_time: tx.timeBounds!.maxTime,
      submitted_after_ledger: 100 }));

    // Still in flight: the command stops, as before.
    await expect(runtime.settleEarlier(scope)).rejects.toBeInstanceOf(SubmissionUnsettled);
    // It was applied after all. The repeated command reports that and signs nothing.
    rpc.commit(tx);
    const stopped = await runtime.settleEarlier(scope).catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(OutcomeError);
    expect(stopped).toMatchObject({
      exitCode: EXIT.earlier,
      result: { status: 'earlier-settled', transactions: [{ transaction: hex(tx.hash()), status: 'success' }] },
    });
    // Once reported, a deliberate rerun proceeds; other scopes were never affected.
    await expect(runtime.settleEarlier(scope)).resolves.toBeUndefined();
    await expect(runtime.settleEarlier('execute:other')).resolves.toBeUndefined();
  });
});

describe('command line', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) } };
  }
  const env = () => ({ STELLAR_NETWORK: 'local', STELLAR_AGENT_AUTH_KEY_DIR: join(directory, 'keys'),
    STELLAR_AGENT_AUTH_STATE_DIR: join(directory, 'state') });

  it('prints usage and exits 2 for unknown commands and options', async () => {
    const run = io();
    expect(await main([], env(), run.io)).toBe(EXIT.usage);
    expect(run.err.join()).toContain('Exit codes');
    expect(await main(['wallet', 'teleport'], env(), io().io)).toBe(EXIT.usage);
    const unknown = io();
    expect(await main(['wallet', 'show', '--bogus', '--json'], env(), unknown.io)).toBe(EXIT.usage);
    expect(JSON.parse(unknown.out[0]!)).toMatchObject({ ok: false, exit_code: EXIT.usage });
    expect(await main(['help'], env(), io().io)).toBe(EXIT.ok);
  });

  it('refuses a secret passed as a key and never echoes it', async () => {
    const secret = Keypair.random().secret();
    const run = io();
    expect(await main(['keys', 'address', '--key', secret, '--json'], env(), run.io)).toBe(EXIT.usage);
    expect([...run.out, ...run.err].join('\n')).not.toContain(secret);
    expect(run.err.join()).toContain('never a secret key');
    // A mangled secret (trailing space, quotes, one wrong character) is not a valid seed, and is still never echoed.
    for (const mangled of [`${secret} `, `"${secret}"`, `${secret.slice(0, 55)}${secret.endsWith('A') ? 'B' : 'A'}`,
      `file:${secret}`]) {
      const output = io();
      expect(await main(['keys', 'address', '--key', mangled, '--json'], env(), output.io)).toBe(EXIT.usage);
      expect([...output.out, ...output.err].join('\n')).not.toContain(secret.slice(0, 55));
    }
  });

  it('creates and resolves named keys and prints JSON results', async () => {
    const created = io();
    expect(await main(['keys', 'create', '--name', 'agent', '--json'], env(), created.io)).toBe(EXIT.ok);
    const result = JSON.parse(created.out[0]!) as { ok: boolean; address: string };
    expect(result.ok).toBe(true);
    const shown = io();
    expect(await main(['keys', 'address', '--key', 'agent'], env(), shown.io)).toBe(EXIT.ok);
    expect(shown.out[0]).toBe(`address: ${result.address}`);
    expect(await main(['keys', 'create', '--name', 'agent'], env(), io().io)).toBe(EXIT.usage);
  });

  it('refuses --dry-run where the effect cannot be simulated, before doing anything', async () => {
    for (const argv of [
      ['verify', 'revoke', '--agent', '1', '--revision', '1', '--sequence', '1', '--provider', 'provider'],
      ['keys', 'create', '--name', 'agent'], ['keys', 'fund', '--key', 'agent'],
      ['execute', 'sign', '--out', join(directory, 'signed.json')],
    ]) {
      const run = io();
      expect(await main([...argv, '--dry-run'], env(), run.io), argv.join(' ')).toBe(EXIT.usage);
      expect(run.err.join(), argv.join(' ')).toContain('--dry-run is not supported');
    }
    await expect(readdir(join(directory, 'keys'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('queries a journaled hash and knows nothing about others', async () => {
    const run = io();
    expect(await main(['tx', 'status', '--hash', 'ab'.repeat(32)], env(), run.io)).toBe(EXIT.usage);
    expect(run.err.join()).toContain('No journal record');
    expect(await main(['tx', 'status', '--hash', 'nothex'], env(), io().io)).toBe(EXIT.usage);
  });

  it('requires contract addresses and well-formed arguments before touching the network', async () => {
    const run = io();
    expect(await main(['wallet', 'balance', '--asset', 'CNOTREAL'], env(), run.io)).toBe(EXIT.usage);
    expect(run.err.join()).toContain('WALLET_ID');
    const missing = io();
    expect(await main(['execute', 'submit', '--file', join(directory, 'absent.json')], env(), missing.io))
      .toBe(EXIT.usage);
    expect(missing.err.join()).toContain('Cannot read signed operation');
    expect(await main(['policy', 'show', '--wallet', 'nope'], env(), io().io)).toBe(EXIT.usage);
  });
});
