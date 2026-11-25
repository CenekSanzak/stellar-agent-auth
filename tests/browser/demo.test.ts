import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend } from '../../apps/demo/server/backend.js';
import { setupDeployment } from '../../apps/demo/server/setup.js';
import { localNetwork } from '../integration/support/local-network.js';

const TIMEOUT = 300_000;
const WEB_ROOT = fileURLToPath(new URL('../../apps/demo/dist/web', import.meta.url));

/**
 * The demo in a real browser, against the local network (A28's browser smoke test). The page is the built app,
 * served by the demo server; the owner is the page's local demo key, so every owner action is signed in the
 * browser. Needs `npm run build`, `npm run build:contracts`, `npm run dev` and an installed Chrome.
 */
describe('owner demo in a browser', () => {
  let directory: string;
  let backend: Awaited<ReturnType<typeof createBackend>>;
  let http: Server;
  let base: string;
  let browser: Browser;
  let page: Page;
  const consoleErrors: string[] = [];

  const text = (testId: string) => page.getByTestId(testId).first().innerText();
  /** Wait until nothing is in progress and the newest activity is at `stage`. */
  const settled = async (stage: string) => {
    await page.locator('body[data-busy="false"]').waitFor({ timeout: 120_000 });
    await expect.poll(() => page.getByTestId('activity').first().getAttribute('data-stage'), { timeout: 30_000 }).toBe(stage);
  };
  const click = async (action: string, extra = '') => {
    await page.locator(`[data-action="${action}"]${extra}`).first().click();
  };
  const scenario = async (id: string, stage: string) => {
    await click('scenario', `[data-scenario="${id}"]`);
    await settled(stage);
    return page.getByTestId('activity').first();
  };

  beforeAll(async () => {
    expect(existsSync(join(WEB_ROOT, 'index.html')), 'apps/demo/dist/web is missing: run npm run build').toBe(true);
    await localNetwork();
    directory = mkdtempSync(join(tmpdir(), 'demo-browser-'));
    const deployment = await setupDeployment({
      env: process.env, directory: join(directory, 'run'), record: join(directory, 'deployment.json'), log: () => {},
    });
    backend = await createBackend({ deployment, directory: join(directory, 'state'), env: process.env, webRoot: WEB_ROOT });
    http = createServer((request, response) => { void backend.handler(request, response); });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ channel: process.env['DEMO_BROWSER_CHANNEL'] ?? 'chrome', headless: true });
    page = await browser.newPage();
    page.on('console', (message) => {
      // A failed request is recorded with its address by the response listener below.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('response', (response) => {
      if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`);
    });
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await backend?.stop();
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('says so when the demo server cannot be reached', async () => {
    const lost = await browser.newPage();
    await lost.route('**/v1/config', (route) => route.abort());
    await lost.goto(base);
    await lost.getByTestId('fatal').waitFor();
    expect(await lost.getByTestId('fatal').innerText()).toContain('The demo server could not be reached');
    await lost.close();
  }, TIMEOUT);

  it('reads the agent from the network and labels its fixture result as simulated', async () => {
    await page.goto(base);
    await expect.poll(() => text('verification-status'), { timeout: 30_000 }).toBe('Verified');
    expect(await text('fixture-label')).toContain('Simulated result');
    expect(await page.locator('#wallet').innerText()).toContain('Connect as the owner');
    // No wallet extension in this browser: the page says so and offers nothing it cannot do.
    await click('connect-freighter');
    await page.getByTestId('connect-error').waitFor();
    expect(await text('connect-error')).toContain('Freighter was not found');
  }, TIMEOUT);

  it('connects an owner, creates the wallet with the owner\'s signature and funds it', async () => {
    await click('connect-local');
    await page.locator('[data-action="test-xlm"]').waitFor({ timeout: 30_000 });
    expect(await page.locator('#wallet').innerText()).toContain('does not exist on this network yet');
    await click('test-xlm');
    await settled('confirmed');
    await page.locator('[data-action="create-wallet"]').waitFor({ timeout: 30_000 });
    await click('create-wallet');
    await settled('confirmed');
    await expect.poll(() => text('wallet-status'), { timeout: 30_000 }).toBe('Active');
    expect(await text('wallet-balance')).toBe('0');
    expect(await text('exposure')).toContain('No active policy');

    await click('fund');
    await settled('confirmed');
    await expect.poll(() => text('wallet-balance'), { timeout: 30_000 }).toBe('100');
  }, TIMEOUT);

  it('approves a policy and shows it in plain language', async () => {
    await page.locator('form[data-form="policy"] button[type="submit"]').click();
    await settled('confirmed');
    await page.getByTestId('policy').waitFor({ timeout: 30_000 });
    expect(await text('policy-status')).toBe('Active');
    const policy = await page.getByTestId('policy').innerText();
    expect(policy).toContain('may pay up to 5 DEMO at a time and 20 DEMO per UTC day');
    expect(policy).toContain('7 days from now');
    await expect.poll(() => text('exposure'), { timeout: 30_000 }).toContain('20 DEMO');
  }, TIMEOUT);

  it('shows a payment inside the policy as paid and each one outside it as refused, with the reason', async () => {
    const paid = await scenario('allowed', 'confirmed');
    expect(await paid.locator('.steps li').getAttribute('data-status')).toBe('paid');
    await expect.poll(() => text('wallet-balance'), { timeout: 30_000 }).toBe('97');
    await expect.poll(() => text('policy-budget'), { timeout: 30_000 }).toContain('Left today: 17 DEMO');

    const over = await scenario('over-limit', 'refused');
    expect(await over.locator('.steps li').getAttribute('data-error')).toBe('PaymentLimitExceeded');
    expect(await over.innerText()).toContain('Expected: refused with PaymentLimitExceeded');
    const stranger = await scenario('unknown-recipient', 'refused');
    expect(await stranger.locator('.steps li').getAttribute('data-error')).toBe('RecipientNotAllowed');
    // Refusals moved nothing.
    expect(await text('wallet-balance')).toBe('97');

    const service = await scenario('service', 'confirmed');
    expect(await service.locator('.steps li').getAttribute('data-status')).toBe('paid');
    await expect.poll(() => text('wallet-balance'), { timeout: 30_000 }).toBe('96');
  }, TIMEOUT);

  it('lets the owner pause, resume and revoke, and the agent is refused accordingly', async () => {
    await click('pause');
    await settled('confirmed');
    await expect.poll(() => text('wallet-status'), { timeout: 30_000 }).toBe('Paused');
    const paused = await scenario('allowed', 'refused');
    expect(await paused.locator('.steps li').getAttribute('data-error')).toBe('Paused');

    await click('resume');
    await settled('confirmed');
    await expect.poll(() => text('wallet-status'), { timeout: 30_000 }).toBe('Active');

    await click('revoke');
    await settled('confirmed');
    await expect.poll(() => text('policy-status'), { timeout: 30_000 }).toBe('Revoked');
    expect(await page.locator('[data-action="revoke"]').count()).toBe(0);
    const revoked = await scenario('allowed', 'refused');
    expect(await revoked.locator('.steps li').getAttribute('data-error')).toBe('Revoked');
    expect(await text('wallet-balance')).toBe('96');
    await expect.poll(() => text('exposure'), { timeout: 30_000 }).toContain('No active policy');
  }, TIMEOUT);

  it('shows a verified history with refusals kept apart', async () => {
    await expect.poll(() => text('history-status'), { timeout: 30_000 }).toBe('Complete and verified');
    const kinds = () => page.locator('[data-testid="entries"] tbody tr').evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-kind')));
    // Newest first: revoked, resumed, paused, service payment, payment, policy.
    await expect.poll(kinds, { timeout: 30_000 }).toEqual([
      'PolicyRevoked', 'PauseChanged', 'PauseChanged', 'AccountPayment', 'Executed', 'PolicyCreated',
    ]);
    const errors = () => page.locator('[data-testid="attempts"] tbody tr').evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-error')));
    await expect.poll(errors, { timeout: 30_000 }).toEqual(['Revoked', 'Paused', 'RecipientNotAllowed', 'PaymentLimitExceeded']);
  }, TIMEOUT);

  it('comes back to the same wallet after a reload, read from the network', async () => {
    await page.reload();
    await click('connect-local');
    await expect.poll(() => text('wallet-balance'), { timeout: 60_000 }).toBe('96');
    await expect.poll(() => text('policy-status'), { timeout: 30_000 }).toBe('Revoked');
    await expect.poll(() => text('history-status'), { timeout: 30_000 }).toBe('Complete and verified');
    // Through the whole run the page logged no error and no request of its own failed.
    expect(consoleErrors).toEqual([]);
  }, TIMEOUT);
});
