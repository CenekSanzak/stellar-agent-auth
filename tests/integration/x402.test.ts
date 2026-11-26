import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Address, Keypair, StrKey, hash, xdr } from '@stellar/stellar-sdk';
import { x402HTTPClient } from '@x402/core/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WalletError } from '../../packages/sdk/src/policies.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import { MemoryJournal, networkContext, type NetworkContext } from '../../packages/sdk/src/transactions.js';
import type { CheckKind, Hash32 } from '../../packages/sdk/src/types.js';
import { readAuditHead, readWalletBalance } from '../../packages/sdk/src/wallet.js';
import {
  STELLAR_LOCAL, StellarExactFacilitator, checkPayer, createPaidService, fetchPaying, inProcessFacilitator, payeeGate,
  payerOf, walletClient,
  type PayeeTerms,
} from '../../packages/x402/src/index.js';
import { readWasm } from './support/local-network.js';
import { UNIT, walletWorld, type WalletWorld } from './support/wallet-world.js';

const TIMEOUT = 240_000;

/**
 * x402 end to end on the local network: a service that costs something, x402's own resource server and client, a
 * facilitator that pays the fee, and the smart wallet as the payer. The agent holds no funds and signs with its key
 * for one policy; the wallet's limits and the payee's own requirement both apply.
 */
describe('x402 payments from the smart wallet on local Stellar', () => {
  let w: WalletWorld;
  let context: NetworkContext;
  let policyHash: Hash32;
  let http: Server;
  let base: string;
  let client: ReturnType<typeof walletClient>;
  let terms: PayeeTerms;
  const facilitatorKey = Keypair.random();
  const calls: string[] = [];

  const balance = () => readWalletBalance(w.read, w.asset);
  const requirement = (...kinds: CheckKind[]) => ({ required_checks: kinds, max_age: 30n * 86_400n, max_risk_score: 10 });

  beforeAll(async () => {
    w = await walletWorld();
    context = await networkContext(w.net.server, w.net.passphrase);
    await w.fund(30n * UNIT);
    policyHash = await w.approve(await w.policy(81));
    await w.net.fund(facilitatorKey);

    const { recipient, provider, signer } = w.roles;
    const facilitator = inProcessFacilitator(STELLAR_LOCAL, new StellarExactFacilitator({
      context, signer: keypairSigner(facilitatorKey), journal: new MemoryJournal(), limits: { pollIntervalMs: 500 },
    }));
    terms = {
      server: w.net.server, networkPassphrase: w.net.passphrase,
      walletCode: [Buffer.from(hash(readWasm('smart_wallet'))).toString('hex')], agentRegistry: w.agentRegistry,
      verificationRegistry: w.verificationRegistry, provider: provider.publicKey(),
      requirement: requirement('Endpoint', 'Metadata', 'SignerAccount'),
    };
    const route = (path: string, units: bigint, gate?: ReturnType<typeof payeeGate>) => ({
      path, description: `A paid report (${path})`, price: { asset: w.asset, amount: (units * UNIT).toString() },
      payTo: recipient.publicKey(), ...(gate ? { gate } : {}),
      handler: () => {
        calls.push(path);
        return { report: 'forty-two', path };
      },
    });
    const service = await createPaidService(STELLAR_LOCAL, facilitator, [
      route('/report', 1n, payeeGate(terms)),
      // More than the policy allows in one payment.
      route('/premium', 6n),
      // A payee that wants a code check, which this agent's result does not have.
      route('/strict', 1n, payeeGate({ ...terms, requirement: requirement('Code', 'Metadata') })),
    ]);
    http = createServer((request, response) => {
      void service.handle(request, response).then((served) => {
        if (!served) response.writeHead(404).end();
      }, (error: unknown) => {
        console.error(error);
        response.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    client = walletClient({ wallet: w.wallet, policyHash, agent: keypairSigner(signer), context, server: w.net.server });
  }, TIMEOUT);

  afterAll(async () => {
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it('answers 402 with what it wants before it is paid', async () => {
    const response = await fetch(`${base}/report`);
    expect(response.status).toBe(402);
    const required = new x402HTTPClient(client).getPaymentRequiredResponse((name) => response.headers.get(name),
      await response.json().catch(() => undefined));
    expect(required.accepts).toMatchObject([{
      scheme: 'exact', network: STELLAR_LOCAL, asset: w.asset, amount: UNIT.toString(),
      payTo: w.roles.recipient.publicKey(), extra: { areFeesSponsored: true },
    }]);
    expect(calls).toEqual([]);
  }, TIMEOUT);

  it('is paid by the wallet: the agent signs, the facilitator pays the fee, the wallet records it', async () => {
    const before = { wallet: await balance(), payee: await w.balanceOf(w.roles.recipient.publicKey()), head: await readAuditHead(w.read) };
    const { response, settlement } = await fetchPaying(client, `${base}/report`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ report: 'forty-two', path: '/report' });
    expect(settlement).toMatchObject({ success: true, network: STELLAR_LOCAL, payer: w.wallet });
    expect(settlement!.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(await balance()).toBe(before.wallet - UNIT);
    expect(await w.balanceOf(w.roles.recipient.publicKey())).toBe(before.payee + UNIT);
    expect((await readAuditHead(w.read)).sequence).toBe(before.head.sequence + 1n);
    // The fee came from the facilitator: the transaction's source is its account, not the agent's or the wallet's.
    const settled = await w.net.server.getTransaction(settlement!.transaction);
    expect(settled.status).toBe('SUCCESS');
    const envelope = 'envelopeXdr' in settled ? settled.envelopeXdr : undefined;
    const source = envelope?.type === 'envelopeTypeTx' ? envelope.v1.tx.sourceAccount : undefined;
    expect(source?.type === 'keyTypeEd25519' ? StrKey.encodeEd25519PublicKey(Buffer.from(source.ed25519.toXdr())) : '')
      .toBe(facilitatorKey.publicKey());
    expect(calls).toEqual(['/report']);
  }, TIMEOUT);

  it('is refused by the wallet when the price is above the policy, before anything reaches the service', async () => {
    const before = await balance();
    const error = await fetchPaying(client, `${base}/premium`).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(WalletError);
    expect(error).toHaveProperty('code', 'PaymentLimitExceeded');
    expect(await balance()).toBe(before);
    expect(calls).not.toContain('/premium');
  }, TIMEOUT);

  it('is refused by the payee when the agent does not meet the payee\'s own requirement, and nothing is paid', async () => {
    const before = await balance();
    const { response, required, settlement } = await fetchPaying(client, `${base}/strict`);
    expect(response.status).toBe(402);
    expect(settlement).toBeUndefined();
    expect(required?.error).toContain('payee_gate_CheckNotPassed');
    expect(await balance()).toBe(before);
    expect(calls).not.toContain('/strict');
  }, TIMEOUT);

  it('does not believe a payer it cannot check: unknown code, other registries, or no policy named', async () => {
    const response = await fetch(`${base}/report`);
    const core = new x402HTTPClient(client);
    const required = core.getPaymentRequiredResponse((name) => response.headers.get(name), await response.json().catch(() => undefined));
    const found = payerOf(await core.createPaymentPayload(required), w.net.passphrase)!;
    expect(found.payer).toBe(w.wallet);
    const check = (overrides: Partial<PayeeTerms> = {}, payer = found.payer, entry = found.entry) =>
      checkPayer(payer, entry, { ...terms, ...overrides });
    expect(await check()).toEqual({ ok: true, payer: w.wallet, agentId: w.agent.agent_id });
    expect(await check({ walletCode: ['00'.repeat(32)] })).toMatchObject({ ok: false, reason: 'payee_gate_unknown_payer' });
    // The asset contract is a contract too, and it is not a wallet.
    expect(await check({}, w.asset)).toMatchObject({ ok: false, reason: 'payee_gate_unknown_payer' });
    expect(await check({ agentRegistry: w.verificationRegistry })).toMatchObject({ ok: false, reason: 'payee_gate_other_registries' });
    expect(await check({ provider: w.roles.stranger.publicKey() })).toMatchObject({ ok: false });
    // An entry signed the way a plain account signs names no policy.
    const plain = xdr.SorobanAuthorizationEntry.fromXdr(found.entry.toXdr());
    const unsigned = new xdr.SorobanAuthorizationEntry({
      rootInvocation: plain.rootInvocation,
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
        address: Address.fromString(w.wallet).toScAddress(), nonce: 1n, signatureExpirationLedger: 1,
        signature: xdr.ScVal.scvVec([]),
      })),
    });
    expect(await check({}, w.wallet, unsigned)).toMatchObject({ ok: false, reason: 'payee_gate_no_policy' });
  }, TIMEOUT);

  it('cannot be paid twice with one signed payment', async () => {
    const seen: Record<string, string>[] = [];
    const recording: typeof fetch = async (input, init) => {
      seen.push({ ...(init?.headers as Record<string, string> | undefined) });
      return fetch(input, init);
    };
    const first = await fetchPaying(client, `${base}/report`, {}, recording);
    expect(first.response.status).toBe(200);
    const before = await balance();
    const replay = await fetch(`${base}/report`, { headers: seen.at(-1)! });
    expect(replay.status).toBe(402);
    expect(await balance()).toBe(before);
  }, TIMEOUT);

  it('stops when the owner pauses the wallet', async () => {
    await w.ownerCall('pause', {});
    const error = await fetchPaying(client, `${base}/report`).catch((thrown: unknown) => thrown);
    expect(error).toHaveProperty('code', 'Paused');
    await w.ownerCall('resume', {});
    expect((await fetchPaying(client, `${base}/report`)).response.status).toBe(200);
  }, TIMEOUT);
});
