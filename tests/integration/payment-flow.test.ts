import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runPaymentFlow, type FlowConfig } from '../../examples/payment-flow.js';

/**
 * The P5 gate: the CLI example runs the whole flow against the local network with real signatures and a separate
 * key per role, a real verification published by an approved Live provider, a sponsored agent payment, owner
 * revocation, and rejection of a request signed before the revocation. The CLI and submitter run as separate
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
    // One 3-unit payment, sponsored; the presigned 2-unit payment was refused against the live revocation.
    expect(summary.payment['request']).toMatchObject({ sequence: '1', units: '30000000' });
    expect(summary.presigned_rejection).toEqual({ exit_code: 3, error: 'Revoked' });
    expect(summary.balances).toEqual({ recipient: '3', wallet: '47' });
    // Policy approval, the payment and the revocation, verified from genesis to the stored head.
    expect(summary.history).toMatchObject({ status: 'verified', entries: 3 });
    // The transcript names keys by reference only.
    expect(lines.join('\n')).not.toMatch(/\bS[A-Z2-7]{55}\b/);
  }, 300_000);
});
