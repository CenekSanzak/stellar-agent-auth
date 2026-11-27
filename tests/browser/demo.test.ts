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
import { configure, createWalletAgent, initAgent } from '../../packages/mcp/src/index.js';
import { localNetwork } from '../integration/support/local-network.js';

const TIMEOUT = 300_000;
const WEB_ROOT = fileURLToPath(new URL('../../apps/demo/dist/web', import.meta.url));
const AGENT_TOOL = fileURLToPath(new URL('../../packages/mcp/dist/stellar-agent-wallet.mjs', import.meta.url));

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
  /** Wait until nothing is in progress and the newest action is at `stage`. */
  const settled = async (stage: string, on: Page = page) => {
    await on.locator('body[data-busy="false"]').waitFor({ timeout: 150_000 });
    await expect.poll(() => on.locator('body').getAttribute('data-last'), { timeout: 30_000 }).toBe(stage);
  };
  const click = async (action: string, extra = '', on: Page = page) => {
    await on.locator(`[data-action="${action}"]${extra}`).first().click();
  };
  const tab = (name: string, on: Page = page) => on.locator(`[data-tab="${name}"]`).click();
  const scout = (on: Page = page) => on.getByTestId('scout');
  /** Unfold an agent's row, if it is folded. */
  const unfold = async (row: ReturnType<typeof scout>) => {
    if (await row.getAttribute('data-open') !== 'true') await row.locator('.agent-summary').click();
  };
  /** Give the sample agent a task; what it came to is shown in its row. */
  const ask = async (task: string, stage: string, on: Page = page) => {
    await tab('agents', on);
    await unfold(scout(on));
    await click('task', `[data-task="${task}"]`, on);
    await settled(stage, on);
    return on.getByTestId('last-result');
  };
  const steps = (item: Awaited<ReturnType<typeof ask>>) => item.locator('.step').evaluateAll((rows) =>
    rows.map((row) => [row.getAttribute('data-vendor'), row.getAttribute('data-status'), row.getAttribute('data-error')]));
  /** Ask to try the sample agent: its allowance form opens over the page. Nothing is opened for a visitor unasked. */
  const openScoutForm = async (on: Page = page) => {
    if (await on.getByTestId('sample').count() === 0) await on.getByTestId('add-agent').click();
    await on.locator('[data-action="try-sample"]').first().click();
    await on.locator('dialog[open] form[data-form="allowance"]').waitFor({ timeout: 30_000 });
  };
  /** From the welcome page to a funded wallet, as a guest. */
  const arrive = async (on: Page) => {
    await on.goto(base);
    await click('connect-guest', '', on);
    await on.locator('[data-action="setup"]').waitFor({ timeout: 30_000 });
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
      deployment, directory: join(directory, 'state'), env: process.env, webRoot: WEB_ROOT, agentTool: AGENT_TOOL,
      // Both browsers in this suite are one client address.
      limits: { tasksPerClientPerMinute: 1_000, agentSetupPerClientPerHour: 1_000 },
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
    await click('setup');
    await settled('confirmed');
    expect(await page.locator('body').getAttribute('data-phase')).toBe('ready');
    await expect.poll(() => text('wallet-balance'), { timeout: 30_000 }).toBe('100');
    await tab('activity');
    const done = await page.getByTestId('activity').evaluateAll((items) => items.map((item) => item.querySelector('strong')!.textContent));
    expect(done).toEqual(['Add 100 tUSD', 'Create your wallet', 'Get test XLM for fees']);
    // A new owner has no agents. The two ways to get one are offered as equals, and nothing is open.
    await tab('agents');
    await page.getByTestId('connect').waitFor({ timeout: 30_000 });
    expect(await page.getByTestId('sample').count()).toBe(1);
    expect(await scout().count()).toBe(0);
    expect(await page.locator('dialog[open]').count()).toBe(0);
  }, TIMEOUT);

  it('tries the sample agent: its allowance opens over the page, and it becomes a row with limits and a meter', async () => {
    await openScoutForm();
    await page.locator('dialog[open] form[data-form="allowance"] button[type="submit"]').click();
    await settled('confirmed');
    await expect.poll(() => text('allowance-status'), { timeout: 30_000 }).toBe('Active');
    expect(await page.locator('dialog[open]').count()).toBe(0);
    expect(await text('allowance-spent')).toContain('0 of 6 tUSD spent today');
    // It is the only agent, so its row is unfolded: who it is, where it may pay, and what it can be asked.
    expect(await scout().getAttribute('data-open')).toBe('true');
    expect(await scout().innerText()).toContain('May pay: Ledger Wire, Deep Archive, Audited Sources.');
    await expect.poll(() => text('verification'), { timeout: 30_000 }).toBe('Verified');
    expect(await text('fixture')).toContain('SIMULATED');
    await tab('sellers');
    expect(await page.getByTestId('vendor').count()).toBe(4);
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
    // What an action came to is also said in one line, wherever the owner is looking.
    expect(await text('flash')).toContain('1 of 2 bought');

    // 2 of today's 6 are spent: one digest at 3 fits, the next would pass the day's limit.
    const routine = await ask('routine', 'confirmed');
    expect(await steps(routine)).toEqual([['ledger-wire', 'paid', ''], ['ledger-wire', 'blocked', 'DailyLimitExceeded']]);
    await expect.poll(() => text('wallet-balance'), { timeout: 30_000 }).toBe('95');
    await expect.poll(() => text('allowance-spent'), { timeout: 30_000 }).toContain('5 of 6 tUSD spent today');
    // Everything that was done is under Activity, newest first.
    await tab('activity');
    expect(await page.getByTestId('activity').first().innerText()).toContain('1 of 2 bought');
    await tab('agents');
  }, TIMEOUT);

  it('serves a second guest in another browser at the same time, with a wallet and an allowance of their own', async () => {
    const context = await browser.newContext();
    const other = await context.newPage();
    watch(other);
    await arrive(other);
    expect(await text('owner', other)).not.toBe(await text('owner'));
    // This guest lets Scout spend more at a time, and approves every seller.
    await openScoutForm(other);
    await other.locator('input[name="perPurchase"]').fill('10');
    await other.locator('input[name="perDay"]').fill('20');
    await other.locator('input[name="vendor"][value="bargain-data"]').check();
    await other.locator('dialog[open] form[data-form="allowance"] button[type="submit"]').click();
    await settled('confirmed', other);
    await expect.poll(() => text('allowance-status', other), { timeout: 30_000 }).toBe('Active');

    // Both ask Scout at once. Under this guest's rules the dataset is bought; the first guest's wallet still says no.
    const [bought, refused] = await Promise.all([ask('dataset', 'confirmed', other), ask('dataset', 'refused')]);
    expect(await steps(bought)).toEqual([['deep-archive', 'paid', '']]);
    expect(await steps(refused)).toEqual([['deep-archive', 'blocked', 'PaymentLimitExceeded']]);
    // The dataset is a table, cut short until asked for.
    expect(await bought.locator('.bought tbody tr').count()).toBe(5);
    await bought.locator('[data-action="toggle-table"]').click();
    await expect.poll(() => other.getByTestId('last-result').locator('.bought tbody tr').count()).toBeGreaterThan(5);
    expect(await steps(await ask('cheapest', 'confirmed', other))).toEqual([['bargain-data', 'paid', '']]);
    await expect.poll(() => text('wallet-balance', other), { timeout: 30_000 }).toBe('91.5');
    expect(await text('wallet-balance')).toBe('95');
    await context.close();
  }, TIMEOUT);

  it('lets the owner freeze the wallet, unfreeze it and end the allowance, and Scout is refused accordingly', async () => {
    await click('freeze');
    await settled('confirmed');
    await expect.poll(() => text('allowance-status'), { timeout: 30_000 }).toBe('Frozen');
    const frozen = await ask('brief', 'refused');
    expect(await steps(frozen)).toEqual([['ledger-wire', 'blocked', 'Paused']]);
    expect(await frozen.innerText()).toContain('You froze the wallet');

    await click('unfreeze');
    await settled('confirmed');
    await expect.poll(() => text('allowance-status'), { timeout: 30_000 }).toBe('Active');

    await unfold(scout());
    await click('end');
    await settled('confirmed');
    await expect.poll(() => scout().getAttribute('data-allowance'), { timeout: 30_000 }).toBe('none');
    expect(await scout().innerText()).toContain('The last allowance has ended');
    // Scout can still be asked, and the wallet says no: this is what ending an allowance means.
    const ended = await ask('brief', 'refused');
    expect(await steps(ended)).toEqual([['ledger-wire', 'blocked', 'Revoked']]);
    expect(await ended.innerText()).toContain('You ended this allowance');
    expect(await text('wallet-balance')).toBe('95');
    // A new allowance can be set at once.
    expect(await scout().locator('[data-action="set-allowance"]').count()).toBe(1);
  }, TIMEOUT);

  it('shows the wallet\'s own record, verified, with refusals kept apart', async () => {
    await tab('record');
    await expect.poll(() => text('history-status'), { timeout: 30_000 }).toBe('Verified against the wallet');
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
    // Someone who is connected and set up is never shown the welcome page or the set-up steps again on the way back.
    const seen = new Set<string>();
    const note = async () => { seen.add((await page.locator('body').getAttribute('data-phase').catch(() => null)) ?? 'loading'); };
    await page.reload({ waitUntil: 'commit' });
    for (let i = 0; i < 40 && !seen.has('ready'); i++) {
      await note();
      await page.waitForTimeout(100);
    }
    expect(seen.has('ready')).toBe(true);
    expect([...seen].filter((phase) => phase === 'welcome' || phase === 'setup')).toEqual([]);
    await expect.poll(() => text('wallet-balance'), { timeout: 60_000 }).toBe('95');
    // The sample agent is still one of this owner's agents, with no allowance now.
    await expect.poll(() => scout().getAttribute('data-allowance'), { timeout: 30_000 }).toBe('none');
    await tab('record');
    await expect.poll(() => text('history-status'), { timeout: 30_000 }).toBe('Verified against the wallet');
    await tab('activity');
    expect(await page.locator('.bought-title').first().innerText()).toContain('Close-time digest');
    // After disconnecting, the welcome page is back and nothing of the wallet is shown.
    await click('disconnect');
    await page.locator('[data-action="connect-guest"]').waitFor();
    expect(await page.getByTestId('wallet-balance').count()).toBe(0);
  }, TIMEOUT);

  it('lets a visitor bring their own agent: one sentence to paste, then an allowance for it', async () => {
    const context = await browser.newContext();
    const mine = await context.newPage();
    watch(mine);
    await arrive(mine);
    const owner = (await mine.locator('[data-testid="owner"] .addr').getAttribute('title'))!;

    // Bringing an agent opens a window with one sentence to paste. It names this server and this owner.
    await mine.locator('[data-testid="connect"] [data-action="dialog"]').click();
    const prompt = await mine.getByTestId('setup-prompt').inputValue();
    expect(prompt).toContain(`${base}agent-ready.md?owner=${owner}`);
    expect(prompt).toContain('you have my go-ahead for its three steps');
    expect(await mine.getByTestId('setup-steps').locator('li').count()).toBe(3);
    // What the agent reads there, and the tool it is told to fetch, are both served.
    const instructions = await (await fetch(`${base}agent-ready.md?owner=${owner}`)).text();
    expect(instructions).toContain(`init --market ${base.slice(0, -1)} --owner ${owner}`);
    const tool = await fetch(`${base}agent/stellar-agent-wallet.mjs`);
    expect(tool.status).toBe(200);
    expect((await tool.text()).startsWith('#!/usr/bin/env node')).toBe(true);

    // The agent's side, as its machine would run it: keys of its own, an identity, a verification, a note to the owner.
    const home = join(directory, 'visitor-agent');
    const agent = await initAgent({ market: base, owner, name: 'Claude on a test machine', home });
    expect(agent.approve_at).toBe(`${base}?agent=${agent.agent_id}`);

    // The owner was waiting in that window. When the agent arrives, the window turns into its allowance form.
    const form = mine.locator(`dialog[open] form[data-form="allowance"][data-agent="${agent.agent_id}"]`);
    await form.waitFor({ timeout: 60_000 });
    expect(await form.innerText()).toContain('Set Claude on a test machine\'s allowance');
    await form.locator('input[name="perPurchase"]').fill('2');
    await form.locator('input[name="perDay"]').fill('4');
    await form.locator('button[type="submit"]').click();
    await settled('confirmed', mine);
    const row = mine.locator(`[data-testid="own-agent"][data-agent="${agent.agent_id}"]`);
    await expect.poll(() => row.getByTestId('own-allowance-status').innerText(), { timeout: 30_000 }).toBe('Active');
    expect(await row.innerText()).toContain('Claude on a test machine');
    await expect.poll(() => row.getByTestId('own-agent-verification').innerText(), { timeout: 30_000 }).toBe('Verified');
    expect(await row.getByTestId('own-allowance-spent').innerText()).toContain('0 of 4 tUSD spent today');

    // The sample agent can be added beside it, with an allowance of its own.
    await openScoutForm(mine);
    await mine.locator('dialog[open] form[data-form="allowance"] button[type="submit"]').click();
    await settled('confirmed', mine);
    await expect.poll(() => text('allowance-status', mine), { timeout: 30_000 }).toBe('Active');

    // The agent buys with its own tools, under its own allowance. The owner's page shows it, by name.
    const tools = createWalletAgent(await configure({ STELLAR_AGENT_WALLET_HOME: home }));
    expect(await tools.allowance()).toMatchObject({ allowed: true, assets: [{ per_purchase: '2', per_day: '4' }] });
    expect(await tools.buy(`${base}x402/ledger-wire/brief`)).toMatchObject({ outcome: 'paid', amount: '1' });
    expect(await tools.buy(`${base}x402/ledger-wire/digest`)).toMatchObject({ outcome: 'blocked', error: 'PaymentLimitExceeded' });
    await expect.poll(() => row.getByTestId('own-allowance-spent').innerText(), { timeout: 60_000 }).toContain('1 of 4 tUSD spent today');
    // Scout's allowance is untouched by it.
    expect(await text('allowance-spent', mine)).toContain('0 of 6 tUSD spent today');
    await tab('record', mine);
    await expect.poll(() => mine.locator('[data-testid="entries"] tbody tr').first().innerText(), { timeout: 30_000 })
      .toContain('Claude on a test machine');
    await context.close();
  }, TIMEOUT);

  it('fits a phone screen without sideways scrolling, with the agents above the reading', async () => {
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
    // The wallet, then one section at a time.
    expect(layout.order).toEqual(['wallet', 'agents']);
    // A window over the page fits the screen too.
    await small.locator('[data-testid="connect"] [data-action="dialog"]').click();
    await small.locator('dialog[open]').waitFor();
    const box = await small.locator('dialog[open]').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    await phone.close();
    // Through the whole run no page logged an error and no request of its own failed.
    expect(consoleErrors).toEqual([]);
  }, TIMEOUT);
});
