import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend } from '../../apps/demo/server/backend.js';
import { setupDeployment } from '../../apps/demo/server/setup.js';
import { runEvidence } from '../../deployments/testnet/evidence.js';
import { localNetwork } from './support/local-network.js';

const TIMEOUT = 300_000;

/**
 * The acceptance scenario that is run against the kept Testnet deployment, run here against the same server on a
 * local network, so that it cannot stop working unnoticed. What matters most is the part no other test has:
 * a payment the wallet refuses is submitted anyway, fails on the ledger, and moves nothing.
 */
describe('the acceptance scenario, on local Stellar', () => {
  let directory: string;
  let backend: Awaited<ReturnType<typeof createBackend>>;
  let http: Server;
  let base: string;

  beforeAll(async () => {
    await localNetwork();
    directory = mkdtempSync(join(tmpdir(), 'evidence-'));
    const deployment = await setupDeployment({
      env: process.env, directory: join(directory, 'run'), record: join(directory, 'deployment.json'), log: () => {},
    });
    backend = await createBackend({ deployment, directory: join(directory, 'state'), env: process.env });
    http = createServer((request, response) => { void backend.handler(request, response); });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
    backend.listening(base);
  }, TIMEOUT);

  afterAll(async () => {
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    await backend?.stop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('makes one payment and has four refused on the ledger, each for its own reason', async () => {
    const out = join(directory, 'evidence.json');
    const record = await runEvidence({ market: base, out, directory: join(directory, 'keys-and-agent'), log: () => {} });

    expect(record.steps.map(({ step, outcome }) => [step, outcome])).toEqual([
      ['A payment inside the allowance', 'success'],
      ['A payment over the limit', 'failed'],
      ['A payment to an unapproved recipient', 'failed'],
      ['The owner pauses the wallet', 'success'],
      ['A payment while the wallet is paused', 'failed'],
      ['The owner resumes the wallet', 'success'],
      ['The owner revokes the allowance', 'success'],
      ['A payment after revocation', 'failed'],
    ]);
    const refusals = record.steps.filter(({ outcome }) => outcome === 'failed');
    // The network's answer when asked first, and the same answer read from the failed transaction.
    expect(refusals.map(({ simulated_error: simulated }) => simulated))
      .toEqual(['PaymentLimitExceeded', 'RecipientNotAllowed', 'Paused', 'Revoked']);
    expect(refusals.map(({ error }) => error)).toEqual(['PaymentLimitExceeded', 'RecipientNotAllowed', 'Paused', 'Revoked']);
    // Every one of them is a transaction of its own, and none moved anything.
    expect(new Set(record.steps.map(({ transaction }) => transaction)).size).toBe(record.steps.length);
    for (const { wallet_balance: balance } of refusals) expect(balance).toEqual({ before: '97', after: '97' });
    expect(record.steps[0]).toMatchObject({ amount: '3', wallet_balance: { before: '100', after: '97' } });

    expect(record.end).toMatchObject({
      wallet_balance: '97', spent_under_the_allowance: '3', allowance_revoked: true, history: { status: 'verified' },
    });
    expect(record.verification.checks).toEqual(expect.arrayContaining([
      { kind: 'Metadata', outcome: 'Passed' }, { kind: 'SignerAccount', outcome: 'Passed' },
    ]));
    // What is written is the public record: addresses and hashes, and no key.
    const written = readFileSync(out, 'utf8');
    expect(JSON.parse(written)).toMatchObject({ network: 'local', agent: { agent_id: record.agent.agent_id } });
    expect(written).not.toMatch(/S[A-Z2-7]{55}/);
  }, TIMEOUT);
});
