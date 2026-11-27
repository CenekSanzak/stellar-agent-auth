import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Asset, Operation } from '@stellar/stellar-sdk';
import { x402Client } from '@x402/core/client';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme as PublishedClient } from '@x402/stellar/exact/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_AUTH_WINDOW_LEDGERS } from '../../packages/sdk/src/actions.js';
import { encodeWalletArgs } from '../../packages/sdk/src/encoding.js';
import { WalletError, transferRequest } from '../../packages/sdk/src/policies.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import { networkContext } from '../../packages/sdk/src/transactions.js';
import { readWalletBalance, signFundingAuthorization, walletOperation } from '../../packages/sdk/src/wallet.js';
import { STELLAR_TESTNET, fetchPaying, quote, walletClient } from '../../packages/x402/src/index.js';
import { successfulSimulation, testnetNetwork } from '../integration/support/local-network.js';
import { UNIT, walletWorld, type WalletWorld } from '../integration/support/wallet-world.js';

/**
 * The smart wallet as a customer of sellers this project does not run: services registered in the stellar-8004
 * identity registry on Testnet, which sell over x402 for Testnet USDC and settle through a facilitator of their
 * own choosing.
 *
 * It is an observation, not a claim. The sellers are other people's and can change or disappear, so the only
 * assertions are about this side: a refusal moves no money, and a settled payment moves exactly the price. What
 * each seller answered is written out as evidence. A seller that refuses the wallet is then asked to sell to a
 * plain account with the published client, to tell a seller that refuses contract payers from one that is down.
 *
 * It deploys a throwaway world, buys Testnet USDC for Testnet XLM on the network's own exchange, and pays third
 * parties, so it runs only with `RUN_TESTNET_X402_EXTERNAL=1` in addition to `RUN_TESTNET_TESTS=1`, and needs
 * `npm run build:contracts` first.
 */

const enabled = process.env['RUN_TESTNET_X402_EXTERNAL'] === '1';
const TIMEOUT = 900_000;

/** Circle's USDC on Testnet, which is what these sellers ask for. */
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
/** The stellar-8004 identity registry on Testnet, where the sellers below are registered. */
const IDENTITY_REGISTRY = 'CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH';

const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/** One seller per operator, each registered in the stellar-8004 registry under `agent`. */
const SELLERS: { name: string; agent: number; url: string; request: () => RequestInit }[] = [
  { name: 'RenderGate', agent: 0, url: 'https://tantk-rendergate.hf.space/render?url=https://example.com', request: () => ({}) },
  {
    name: 'Stellar Agent Services example', agent: 163,
    url: 'https://sas-testnet.79-76-99-174.sslip.io/services/text-stats/jobs',
    request: () => {
      const init = json({ text: 'Hello world.' });
      return {
        ...init,
        headers: { ...init.headers, 'idempotency-key': randomUUID(), 'job-token': randomBytes(32).toString('base64url') },
      };
    },
  },
  {
    name: 'AgentEnact EVM balance', agent: 190,
    url: 'https://agentenact.io/a/13f19f04-d983-4071-85d7-85ade90fc12c/evm-balance',
    request: () => json({ address: '0x0000000000000000000000000000000000000000', chain: 'base' }),
  },
];

const evidence = (what: string, fields: Record<string, unknown>) => {
  const line = JSON.stringify({ what, ...fields }, (_, value) => (typeof value === 'bigint' ? value.toString() : value));
  console.info('X402-EXTERNAL', line);
  // The reporter hides what passing tests print. Set X402_EVIDENCE to a file path to keep these lines.
  if (process.env['X402_EVIDENCE']) appendFileSync(process.env['X402_EVIDENCE'], `${line}\n`);
};

describe.skipIf(!enabled)('the smart wallet buying from stellar-8004 sellers on Testnet', () => {
  let w: WalletWorld;
  let usdc: string;
  let client: ReturnType<typeof walletClient>;
  const terms = new Map<string, { amount: bigint; payTo: string }>();

  beforeAll(async () => {
    // What each seller asks, before anything is set up: a seller that is down is left out, not failed.
    for (const seller of SELLERS) {
      const asked = await quote(new x402Client(), seller.url, seller.request()).catch(() => undefined);
      const option = asked?.accepts.find(({ network }) => network === STELLAR_TESTNET);
      evidence('terms', { seller: seller.name, agent: `stellar:testnet:${IDENTITY_REGISTRY}#${seller.agent}`, ...option });
      if (option) terms.set(seller.name, { amount: BigInt(option.amount), payTo: option.payTo });
    }

    w = await walletWorld(await testnetNetwork());
    usdc = USDC.contractId(w.net.passphrase);
    const { owner, sponsor } = w.roles;
    const context = await networkContext(w.net.server, w.net.passphrase);

    // The owner buys 2 USDC for XLM on Testnet's exchange, and puts 1 into the wallet.
    await w.classic(owner, [
      Operation.changeTrust({ asset: USDC }),
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(), sendMax: '100', destination: owner.publicKey(), destAsset: USDC, destAmount: '2',
      }),
    ]);
    const deposit = { from: owner.publicKey(), asset: usdc, amount: UNIT };
    const recorded = successfulSimulation(await w.net.simulate(
      await w.net.build(sponsor, walletOperation(w.wallet, 'fund', deposit)), 'record'));
    const auth = await Promise.all(recorded.result.auth.map((entry) => signFundingAuthorization({
      entry, contractId: w.wallet, args: deposit, networkPassphrase: w.net.passphrase,
      latestLedger: recorded.latestLedger, expirationLedger: recorded.latestLedger + MAX_AUTH_WINDOW_LEDGERS, signer: owner,
    })));
    const funding = await w.walletTx('fund', encodeWalletArgs('fund', deposit), auth);
    await w.net.submit(funding, successfulSimulation(await w.net.simulate(funding, 'enforce')), sponsor);

    // An allowance in USDC for exactly these sellers: 0.1 a purchase, 0.5 a day.
    const policyHash = await w.approve(await w.policy(1, {
      assets: [{ asset: usdc, per_transaction: UNIT / 10n, per_day: UNIT / 2n, total: null }],
      allowed_recipients: [owner.publicKey(), ...[...terms.values()].map(({ payTo }) => payTo)],
    }));
    // One ordinary payment first, so the wallet's one-off rent is not what a seller's fee ceiling is measured against.
    await w.execute(transferRequest({
      wallet: w.wallet, policyHash, sequence: 1n, deadline: await w.ledgerTime() + 600n, asset: usdc,
      recipient: owner.publicKey(), amount: 1_000n,
    }));
    client = walletClient({ wallet: w.wallet, policyHash, agent: keypairSigner(w.roles.signer), context, server: w.net.server });
    evidence('deployment', { wallet: w.wallet, owner: owner.publicKey(), asset: usdc, policy: Buffer.from(policyHash).toString('hex') });
  }, TIMEOUT);

  it.each(SELLERS)('asks $name to sell to the wallet', async (seller) => {
    const asked = terms.get(seller.name);
    if (!asked) {
      evidence('wallet as payer', { seller: seller.name, outcome: 'not reachable, or not selling on Testnet' });
      return;
    }
    const before = await readWalletBalance(w.read, usdc);
    let outcome: Record<string, unknown>;
    let status = 0;
    let settled = false;
    try {
      const paid = await fetchPaying(client, seller.url, seller.request());
      status = paid.response.status;
      settled = paid.settlement?.success === true;
      outcome = {
        status, error: status === 402 ? paid.required?.error ?? null : null, settlement: paid.settlement ?? null,
        repeats_terms: status === 402 ? paid.required !== undefined : null,
        body: (await paid.response.text().catch(() => '')).slice(0, 400),
      };
    } catch (error) {
      if (!(error instanceof WalletError)) throw error;
      outcome = { refused_by: 'wallet', error: error.code };
    }
    const spent = before - await readWalletBalance(w.read, usdc);
    evidence('wallet as payer', { seller: seller.name, price: asked.amount, spent, ...outcome });
    if (status === 402 || 'refused_by' in outcome) expect(spent).toBe(0n);
    if (settled) expect(spent).toBe(asked.amount);

    if (settled) return;
    // The same seller, asked by a plain account with the published client.
    const plain = new x402Client().setSpendControls(false)
      .register(STELLAR_TESTNET, new PublishedClient(createEd25519Signer(w.roles.owner.secret(), STELLAR_TESTNET)));
    const control = await fetchPaying(plain, seller.url, seller.request()).then(async (paid) => ({
      status: paid.response.status, error: paid.response.status === 402 ? paid.required?.error ?? null : null,
      settlement: paid.settlement ?? null, body: (await paid.response.text().catch(() => '')).slice(0, 200),
    }), (error: unknown) => ({ failed: error instanceof Error ? error.message : String(error) }));
    evidence('plain account as payer', { seller: seller.name, ...control });
  }, TIMEOUT);
});
