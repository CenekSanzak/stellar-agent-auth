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
 * The demo in a real browser, against the local network. The page is the built app, served by the demo server
 * with the headers a hosted one sends; the owners are guests, so every owner action is signed in the browser. A
 * second guest in a browser of their own uses the same server at the same time. Needs `npm run build`,
 * `npm run build:contracts`, `npm run dev` and an installed Chrome.
 */
describe('Scout demo in a browser', () => {
  let directory: string;
  let backend: Awaited<ReturnType<typeof createBackend>>;
  let http: Server;
  let base: string;
  let browser: Browser;
  let page: Page;
  const consoleErrors: string[] = [];

  /** Report anything a page logs as an error, and any request of its own that fails. */
  const watch = (target: Page) => {
    target.on('console', (message) => {
      // A failed request is recorded with its address by the response listener below.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) consoleErrors.push(message.text());
    });
    target.on('pageerror', (error) => consoleErrors.push(String(error)));
    target.on('response', (response) => {
      if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`);
    });
  };
  const text = (testId: string, on: Page = page) => on.getByTestId(testId).first().innerText();
  /** Wait until nothing is in progress and the newest activity is at `stage`. */
  const settled = async (stage: string, on: Page = page) => {
    await on.locator('body[data-busy="false"]').waitFor({ timeout: 150_000 });
    await expect.poll(() => on.getByTestId('activity').first().getAttribute('data-stage'), { timeout: 30_000 }).toBe(stage);
  };
  const click = async (action: string, extra = '', on: Page = page) => {
    await on.locator(`[data-action="${action}"]${extra}`).first().click();
  };
  const ask = async (task: string, stage: string, on: Page = page) => {
    await click('task', `[data-task="${task}"]`, on);
    await settled(stage, on);
    return on.getByTestId('activity').first();
  };
  const steps = (item: Awaited<ReturnType<typeof ask>>) => item.locator('.step').evaluateAll((rows) =>
    rows.map((row) => [row.getAttribute('data-vendor'), row.getAttribute('data-status'), row.getAttribute('data-error')]));
  /** From the welcome page to a funded wallet, as a guest. */
  const arrive = async (on: Page) => {
    await on.goto(base);
    await click('connect-guest', '', on);
    await on.locator('[data-action="setup"]:not([disabled])').waitFor({ timeout: 30_000 });
    await click('setup', '', on);
    await settled('confirmed', on);
    await expect.poll(() => text('wallet-balance', on), { timeout: 30_000 }).toBe('100');
  };

  beforeAll(async () => {
    expect(existsSync(join(WEB_ROOT, 'index.html')), 'apps/demo/dist/web is missing: run npm run build').toBe(true);
    await localNetwork();
    directory = mkdtempSync(join(tmpdir(), 'demo-browser-'));
    const deployment = await setupDeployment({
      env: process.env, directory: join(directory, 'run'), record: join(directory, 'deployment.json'), log: () => {},
    });
    backend = await createBackend({
      deployment, directory: join(directory, 'state'), env: process.env, webRoot: WEB_ROOT,
      // Both browsers in this suite are one client address.
      limits: { tasksPerClientPerMinute: 1_000 },
    });
    http = createServer((request, response) => { void backend.handler(request, response); });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
    backend.listening(base);
    browser = await chromium.launch({ channel: process.env['DEMO_BROWSER_CHANNEL'] ?? 'chrome', headless: true });
    page = await browser.newPage();
    watch(page);
  }, TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    await backend?.stop();
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

  it('welcomes a visitor, says the money is not real, and offers a guest, Freighter and other wallets', async () => {
    const response = await page.goto(base);
    // The page is served with a policy that lets it run only its own scripts.
    expect(response!.headers()['content-security-policy']).toContain('script-src \'self\'');
    await page.locator('[data-action="connect-guest"]').waitFor({ timeout: 30_000 });
    expect(await page.locator('body').getAttribute('data-phase')).toBe('welcome');
    expect(await page.locator('#network').innerText()).toContain('test money only');
    // No wallet extension in this browser: the page says so and offers nothing it cannot do.
    await click('connect-freighter');
    await page.getByTestId('connect-error').waitFor();
    expect(await text('connect-error')).toContain('Freighter was not found');
  }, TIMEOUT);

  it('sets a guest up with one button: test XLM, a wallet created with the guest\'s signature, and test dollars', async () => {
    await click('connect-guest');
    await page.getByTestId('setup').waitFor({ timeout: 30_000 });
    expect(await text('owner')).toContain('Guest');
    await page.locator('[data-action="setup"]:not([disabled])').waitFor({ timeout: 30_000 });
    await click('setup');
    await settled('confirmed');
    expect(await page.locator('body').getAttribute('data-phase')).toBe('ready');
    await expect.poll(() => text('wallet-balance'), { timeout: 30_000 }).toBe('100');
    const done = await page.getByTestId('activity').evaluateAll((items) => items.map((item) => item.querySelector('strong')!.textContent));
    expect(done).toEqual(['Add 100 tUSD', 'Create your wallet', 'Get test XLM for fees']);
    // Scout is verified, by a result this local network labels as simulated; and it can spend nothing yet.
    await expect.poll(() => text('verification'), { timeout: 30_000 }).toBe('Verified');
    expect(await text('fixture')).toContain('SIMULATED');
    expect(await page.getByTestId('allowance').getAttribute('data-status')).toBe('none');
    expect(await page.locator('[data-task="brief"]').isDisabled()).toBe(true);
  }, TIMEOUT);

  it('approves the suggested allowance and shows it as limits, a meter and approved sellers', async () => {
    await page.locator('form[data-form="allowance"] button[type="submit"]').click();
    await settled('confirmed');
    await expect.poll(() => text('allowance-status'), { timeout: 30_000 }).toBe('Active');
    expect(await text('allowance-spent')).toContain('0 of 6 tUSD spent today');
    const approved = await page.getByTestId('vendor').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-approved')));
    expect(approved).toEqual(['true', 'true', 'true', 'false']);
    expect(await page.getByTestId('allowance-form').count()).toBe(0);
  }, TIMEOUT);

  it('shows what Scout bought, and each refusal with who refused and why', async () => {
    const brief = await ask('brief', 'confirmed');
    expect(await steps(brief)).toEqual([['ledger-wire', 'paid', '']]);
    expect(await brief.locator('.bought-title').innerText()).toContain('Network brief');
    await expect.poll(() => text('wallet-balance'), { timeout: 30_000 }).toBe('99');
    await expect.poll(() => text('allowance-spent'), { timeout: 30_000 }).toContain('1 of 6 tUSD spent today');

    const dataset = await ask('dataset', 'refused');
    expect(await steps(dataset)).toEqual([['deep-archive', 'blocked', 'PaymentLimitExceeded']]);
    expect(await dataset.innerText()).toContain('That is more than your limit of 5 tUSD for one purchase');

    const audited = await ask('audited', 'refused');
    expect(await steps(audited)).toEqual([['audited-sources', 'declined', 'payee_gate_CheckNotPassed']]);
    expect(await audited.innerText()).toContain('Refused by the seller');

    // The cheapest seller is not approved, so the wallet blocks it and Scout buys from the next.
    const cheapest = await ask('cheapest', 'confirmed');
    expect(await steps(cheapest)).toEqual([['bargain-data', 'blocked', 'RecipientNotAllowed'], ['ledger-wire', 'paid', '']]);
    expect(await cheapest.innerText()).toContain('Asked 2 sellers for a price');
    expect(await cheapest.innerText()).toContain('1 of 2 bought');

    // 2 of today's 6 are spent: one digest at 3 fits, the next would pass the day's limit.
    const routine = await ask('routine', 'confirmed');
    expect(await steps(routine)).toEqual([['ledger-wire', 'paid', ''], ['ledger-wire', 'blocked', 'DailyLimitExceeded']]);
    await expect.poll(() => text('wallet-balance'), { timeout: 30_000 }).toBe('95');
    await expect.poll(() => text('allowance-spent'), { timeout: 30_000 }).toContain('5 of 6 tUSD spent today');
  }, TIMEOUT);

  it('serves a second guest in another browser at the same time, with a wallet and an allowance of their own', async () => {
    const context = await browser.newContext();
    const other = await context.newPage();
    watch(other);
    await arrive(other);
    expect(await text('owner', other)).not.toBe(await text('owner'));
    // This guest lets Scout spend more at a time, and approves every seller.
    await other.locator('input[name="perPurchase"]').fill('10');
    await other.locator('input[name="perDay"]').fill('20');
    await other.locator('input[name="vendor"][value="bargain-data"]').check();
    await other.locator('form[data-form="allowance"] button[type="submit"]').click();
    await settled('confirmed', other);
    await expect.poll(() => text('allowance-status', other), { timeout: 30_000 }).toBe('Active');

    // Both ask Scout at once. Under this guest's rules the dataset is bought; the first guest's wallet still says no.
    const [bought, refused] = await Promise.all([ask('dataset', 'confirmed', other), ask('dataset', 'refused')]);
    expect(await steps(bought)).toEqual([['deep-archive', 'paid', '']]);
    expect(await steps(refused)).toEqual([['deep-archive', 'blocked', 'PaymentLimitExceeded']]);
    // The dataset is a table, cut short until asked for.
    expect(await bought.locator('.bought tbody tr').count()).toBe(5);
    await bought.locator('[data-action="toggle-table"]').click();
    await expect.poll(() => other.getByTestId('activity').first().locator('.bought tbody tr').count()).toBeGreaterThan(5);
    expect(await steps(await ask('cheapest', 'confirmed', other))).toEqual([['bargain-data', 'paid', '']]);
    await expect.poll(() => text('wallet-balance', other), { timeout: 30_000 }).toBe('91.5');
    expect(await text('wallet-balance')).toBe('95');
    await context.close();
  }, TIMEOUT);

  it('lets the owner freeze Scout, unfreeze it and end the allowance, and Scout is refused accordingly', async () => {
    await click('freeze');
    await settled('confirmed');
    await expect.poll(() => text('allowance-status'), { timeout: 30_000 }).toBe('Frozen');
    const frozen = await ask('brief', 'refused');
    expect(await steps(frozen)).toEqual([['ledger-wire', 'blocked', 'Paused']]);
    expect(await frozen.innerText()).toContain('You froze Scout');

    await click('unfreeze');
    await settled('confirmed');
    await expect.poll(() => text('allowance-status'), { timeout: 30_000 }).toBe('Active');

    await click('end');
    await settled('confirmed');
    await expect.poll(() => page.getByTestId('allowance').getAttribute('data-status'), { timeout: 30_000 }).toBe('none');
    expect(await page.getByTestId('allowance').innerText()).toContain('The last allowance has ended');
    // Scout can still be asked, and the wallet says no: this is what ending an allowance means.
    const ended = await ask('brief', 'refused');
    expect(await steps(ended)).toEqual([['ledger-wire', 'blocked', 'Revoked']]);
    expect(await ended.innerText()).toContain('You ended this allowance');
    expect(await text('wallet-balance')).toBe('95');
    // A new allowance can be approved at once.
    await page.getByTestId('allowance-form').waitFor({ timeout: 30_000 });
  }, TIMEOUT);

  it('shows the wallet\'s own record, verified, with refusals kept apart', async () => {
    await expect.poll(() => text('history-status'), { timeout: 30_000 }).toBe('Verified against the wallet');
    await page.getByTestId('record-toggle').click();
    const kinds = () => page.locator('[data-testid="entries"] tbody tr').evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-kind')));
    // Newest first: ended, unfrozen, frozen, three purchases, the allowance.
    await expect.poll(kinds, { timeout: 30_000 }).toEqual([
      'PolicyRevoked', 'PauseChanged', 'PauseChanged', 'AccountPayment', 'AccountPayment', 'AccountPayment', 'PolicyCreated',
    ]);
    expect(await page.locator('[data-testid="entries"]').innerText()).toContain('3 tUSD to Ledger Wire');
    const errors = () => page.locator('[data-testid="attempts"] tbody tr').evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-error')));
    await expect.poll(errors, { timeout: 30_000 }).toEqual(['Revoked', 'Paused', 'PaymentLimitExceeded', 'DailyLimitExceeded',
      'RecipientNotAllowed', 'payee_gate_CheckNotPassed', 'PaymentLimitExceeded']);
  }, TIMEOUT);

  it('comes back as the same guest after a reload, with the wallet read from the network and what was bought kept', async () => {
    await page.reload();
    await expect.poll(() => text('wallet-balance'), { timeout: 60_000 }).toBe('95');
    await expect.poll(() => text('history-status'), { timeout: 30_000 }).toBe('Verified against the wallet');
    expect(await page.getByTestId('allowance').getAttribute('data-status')).toBe('none');
    expect(await page.locator('.bought-title').first().innerText()).toContain('Close-time digest');
    // After disconnecting, the welcome page is back and nothing of the wallet is shown.
    await click('disconnect');
    await page.locator('[data-action="connect-guest"]').waitFor();
    expect(await page.getByTestId('wallet-balance').count()).toBe(0);
  }, TIMEOUT);

  it('fits a phone screen without sideways scrolling, with the tasks above the reading', async () => {
    const phone = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const small = await phone.newPage();
    watch(small);
    await arrive(small);
    const layout = await small.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      order: Array.from(document.querySelectorAll('.board section')).filter((section) => section.innerHTML)
        .map((section) => [section.id, section.getBoundingClientRect().top] as const).sort((a, b) => a[1] - b[1]).map(([id]) => id),
    }));
    expect(layout.overflow).toBe(0);
    expect(layout.order.indexOf('tasks')).toBeLessThan(layout.order.indexOf('sellers'));
    expect(layout.order[0]).toBe('wallet');
    await phone.close();
    // Through the whole run no page logged an error and no request of its own failed.
    expect(consoleErrors).toEqual([]);
  }, TIMEOUT);
});
