import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runPaymentFlow, type FlowConfig } from '../../examples/payment-flow.js';

/**
 * The P5 and P9 gates: the CLI example runs the whole flow against the local network with real signatures and a
 * separate key per role, a real verification published by an approved Live provider, a sponsored agent payment
 * through `execute`, a service that pulls its price and a plain transfer on the wallet's account path, owner
 * revocation, and refusal on both paths afterwards. The CLI and submitter run as separate
 * processes from their built entry points, as a user would run them.
 */
describe('CLI payment flow example', () => {
  it('completes registration, verification, funding, policy, payment, revocation and rejection', async () => {
    for (const entry of ['packages/cli/dist/index.js', 'services/submitter/dist/index.js']) {
      expect(existsSync(new URL(`../../${entry}`, import.meta.url)), `${entry}: run npm run build`).toBe(true);
    }
    const config = JSON.parse(await readFile(new URL('../../examples/payment-flow.local.json', import.meta.url), 'utf8'),
    ) as FlowConfig;
    const lines: string[] = [];
    const summary = await runPaymentFlow(config, (line) => lines.push(line));

    // Every role is a different account.
    expect(new Set(Object.values(summary.roles)).size).toBe(Object.keys(summary.roles).length);
    // The verifier's real checks: metadata and signer pass, unsupported coverage stays visible and unscored.
    const checks = new Map((summary.verification.checks as { kind: string; outcome: string }[])
      .map(({ kind, outcome }) => [kind, outcome]));
    expect(checks.get('Metadata')).toBe('Passed');
    expect(checks.get('SignerAccount')).toBe('Passed');
    expect(checks.get('Code')).toBe('Unsupported');
    expect(summary.verification.risk_score).toBe(0);
    // One 3-unit payment through `execute`, sponsored.
    expect(summary.payment['request']).toMatchObject({ sequence: '1', units: '30000000' });
    // The service pulled its 1-unit price in its own call and issued its first receipt to the wallet.
    expect(summary.service_payment['receipt']).toMatchObject({
      number: '1', wallet: summary.contracts.wallet, amount: '10000000',
    });
    // A 1-unit plain transfer on the account path.
    expect(summary.account_payment['transaction']).toMatch(/^[0-9a-f]{64}$/);
    // After the revocation both paths refuse: the presigned 2-unit payment, and a new account payment.
    expect(summary.presigned_rejection).toEqual({ exit_code: 3, error: 'Revoked' });
    expect(summary.account_rejection).toEqual({ exit_code: 3, error: 'Revoked' });
    expect(summary.balances).toEqual({ recipient: '5', wallet: '45' });
    // Policy approval, three payments and the revocation, verified from genesis to the stored head.
    expect(summary.history).toMatchObject({ status: 'verified', entries: 5 });
    // The transcript names keys by reference only.
    expect(lines.join('\n')).not.toMatch(/\bS[A-Z2-7]{55}\b/);
  }, 300_000);
});
