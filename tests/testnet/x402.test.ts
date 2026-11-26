import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair, hash } from '@stellar/stellar-sdk';
import { x402Client } from '@x402/core/client';
import type { SchemeNetworkFacilitator } from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme as PublishedClient } from '@x402/stellar/exact/client';
import { ExactStellarScheme as PublishedFacilitator } from '@x402/stellar/exact/facilitator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import { MemoryJournal, networkContext, type NetworkContext } from '../../packages/sdk/src/transactions.js';
import type { Hash32 } from '../../packages/sdk/src/types.js';
import { readAuditHead, readWalletBalance } from '../../packages/sdk/src/wallet.js';
import {
  STELLAR_TESTNET, StellarExactFacilitator, createPaidService, fetchPaying, inProcessFacilitator, payeeGate,
  tolerantUpstreamFacilitator, walletClient,
} from '../../packages/x402/src/index.js';
import { readWasm, testnetNetwork } from '../integration/support/local-network.js';
import { UNIT, walletWorld, type WalletWorld } from '../integration/support/wallet-world.js';

/**
 * x402 on public Testnet, with the published `@x402/stellar` code where it can be used. It deploys a throwaway
 * world and submits transactions, so it runs only with `RUN_TESTNET_X402=1` in addition to `RUN_TESTNET_TESTS=1`,
 * and needs `npm run build:contracts` first.
 *
 * It shows three things the local suite cannot: that the published facilitator refuses the wallet as it is, that
 * the same published code accepts it once it ignores the payer's own events, and that this project's facilitator
 * and the published client and facilitator still serve a plain account.
 */

const enabled = process.env['RUN_TESTNET_X402'] === '1';
const TIMEOUT = 900_000;
const evidence = (what: string, fields: Record<string, unknown>) => console.info('X402', JSON.stringify({ what, ...fields }));

describe.skipIf(!enabled)('x402 payments from the smart wallet on Testnet', () => {
  let w: WalletWorld;
  let context: NetworkContext;
  let policyHash: Hash32;
  let client: ReturnType<typeof walletClient>;
  const servers: Server[] = [];
  // One fee payer per facilitator: each orders its own transactions.
  const keys = { published: Keypair.random(), tolerant: Keypair.random(), own: Keypair.random() };
  const urls = {} as Record<keyof typeof keys, string>;
  // Room for the rent a freshly deployed wallet pays on its first payments; the published default is 50,000.
  const CEILING = 2_000_000;

  async function serve(scheme: SchemeNetworkFacilitator) {
    const { recipient, provider } = w.roles;
    const service = await createPaidService(STELLAR_TESTNET, inProcessFacilitator(STELLAR_TESTNET, scheme), [{
      path: '/report', description: 'A paid report', price: { asset: w.asset, amount: UNIT.toString() },
      payTo: recipient.publicKey(),
      gate: payeeGate({
        server: w.net.server, networkPassphrase: w.net.passphrase,
        walletCode: [Buffer.from(hash(readWasm('smart_wallet'))).toString('hex')], agentRegistry: w.agentRegistry,
        verificationRegistry: w.verificationRegistry, provider: provider.publicKey(),
        requirement: { required_checks: ['Endpoint', 'Metadata', 'SignerAccount'], max_age: 30n * 86_400n, max_risk_score: 10 },
      }),
      handler: () => ({ report: 'forty-two' }),
    }]);
    const http = createServer((request, response) => {
      void service.handle(request, response).then((served) => { if (!served) response.writeHead(404).end(); },
        () => response.writeHead(500).end());
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    servers.push(http);
    return `http://127.0.0.1:${(http.address() as AddressInfo).port}/report`;
  }

  beforeAll(async () => {
    w = await walletWorld(await testnetNetwork());
    context = await networkContext(w.net.server, w.net.passphrase);
    await w.fund(50n * UNIT);
    policyHash = await w.approve(await w.policy(1));
    // One ordinary payment first, so the wallet's one-off rent is not what the fee ceilings are measured against.
    await w.execute(await w.payment(policyHash, 1n, UNIT));
    await w.net.fund(...Object.values(keys));
    urls.published = await serve(new PublishedFacilitator([createEd25519Signer(keys.published.secret(), STELLAR_TESTNET)],
      { maxTransactionFeeStroops: CEILING }));
    urls.tolerant = await serve(tolerantUpstreamFacilitator(keys.tolerant.secret(), STELLAR_TESTNET,
      { maxTransactionFeeStroops: CEILING }));
    urls.own = await serve(new StellarExactFacilitator({
      context, signer: keypairSigner(keys.own), journal: new MemoryJournal(), limits: { pollIntervalMs: 1_000 },
    }));
    client = walletClient({ wallet: w.wallet, policyHash, agent: keypairSigner(w.roles.signer), context, server: w.net.server });
    evidence('deployment', { wallet: w.wallet, asset: w.asset, policy: Buffer.from(policyHash).toString('hex') });
  }, TIMEOUT);

  afterAll(async () => {
    await Promise.all(servers.map((http) => new Promise<void>((resolve) => http.close(() => resolve()))));
  });

  it('is refused by the published facilitator as it is, because the wallet publishes its audit entry', async () => {
    const before = await readWalletBalance(w.read, w.asset);
    const { response, required } = await fetchPaying(client, urls.published);
    evidence('published facilitator', { status: response.status, error: required?.error });
    expect(response.status).toBe(402);
    expect(required?.error).toContain('invalid_exact_stellar_payload_event_not_transfer');
    expect(await readWalletBalance(w.read, w.asset)).toBe(before);
  }, TIMEOUT);

  it('is settled by the published facilitator once it ignores the payer\'s own events', async () => {
    const before = { balance: await readWalletBalance(w.read, w.asset), head: await readAuditHead(w.read) };
    const { response, settlement } = await fetchPaying(client, urls.tolerant);
    evidence('published facilitator, payer events ignored', { status: response.status, ...settlement });
    expect(response.status).toBe(200);
    expect(settlement).toMatchObject({ success: true, payer: w.wallet });
    expect(await readWalletBalance(w.read, w.asset)).toBe(before.balance - UNIT);
    expect((await readAuditHead(w.read)).sequence).toBe(before.head.sequence + 1n);
  }, TIMEOUT);

  it('is settled by this project\'s facilitator', async () => {
    const before = await readWalletBalance(w.read, w.asset);
    const { response, settlement } = await fetchPaying(client, urls.own);
    evidence('own facilitator', { status: response.status, ...settlement });
    expect(response.status).toBe(200);
    expect(settlement).toMatchObject({ success: true, payer: w.wallet });
    expect(await readWalletBalance(w.read, w.asset)).toBe(before - UNIT);
  }, TIMEOUT);

  it('still serves a plain account that pays with the published client, though not through the payee\'s gate', async () => {
    const { funder } = w.roles;
    const plain = new x402Client().setSpendControls(false)
      .register(STELLAR_TESTNET, new PublishedClient(createEd25519Signer(funder.secret(), STELLAR_TESTNET)));
    // The gate on this service accepts known wallets only, so a plain account is turned away by the payee.
    const gated = await fetchPaying(plain, urls.own);
    evidence('plain account at a gated service', { status: gated.response.status, error: gated.required?.error });
    expect(gated.response.status).toBe(402);
    expect(gated.required?.error).toContain('payee_gate_unknown_payer');
  }, TIMEOUT);
});
