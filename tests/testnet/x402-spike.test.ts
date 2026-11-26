import { appendFileSync } from 'node:fs';
import {
  Address, Contract, Keypair, Operation, TransactionBuilder, nativeToScVal, xdr, type Transaction,
} from '@stellar/stellar-sdk';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme as StockClient } from '@x402/stellar/exact/client';
import { ExactStellarScheme as StockFacilitator } from '@x402/stellar/exact/facilitator';
import { beforeAll, describe, expect, it } from 'vitest';
import { signAccountPayment, type AccountPayment } from '../../packages/sdk/src/account.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import type { Hash32 } from '../../packages/sdk/src/types.js';
import { readAuditHead, readWalletBalance } from '../../packages/sdk/src/wallet.js';
import { successfulSimulation, testnetNetwork } from '../integration/support/local-network.js';
import { UNIT, walletWorld, type WalletWorld } from '../integration/support/wallet-world.js';

/**
 * SPIKE, not an acceptance suite: can the smart wallet pay through the real x402 packages?
 *
 * The x402 "exact" scheme on Stellar is a plain `asset.transfer(payer, payee, amount)` whose payer signs only its
 * authorization entry; a facilitator rebuilds the transaction, pays the fee and submits it. That is the shape the
 * wallet's account path authorizes. This runs the published `@x402/stellar` client and facilitator code against a
 * throwaway Testnet deployment and records what each step answers. Testnet only: the packages know no other test
 * network. Enabled with `RUN_TESTNET_X402=1` in addition to `RUN_TESTNET_TESTS=1`.
 */

const enabled = process.env['RUN_TESTNET_X402'] === '1';
const NETWORK = 'stellar:testnet';
const TIMEOUT = 600_000;
const note = (what: string, fields: Record<string, unknown>) => {
  const line = JSON.stringify({ what, ...fields });
  console.info('X402-SPIKE', line);
  // The reporter hides the output of passing tests; the spike's answers are its result, so they are kept in a file.
  if (process.env['X402_SPIKE_LOG']) appendFileSync(process.env['X402_SPIKE_LOG'], `${line}\n`);
};

describe.skipIf(!enabled)('x402 exact scheme with the smart wallet (spike)', () => {
  let w: WalletWorld;
  let policyHash: Hash32;
  let facilitatorKey: Keypair;
  let requirements: Record<string, unknown>;

  const facilitator = (maxTransactionFeeStroops?: number) => new StockFacilitator(
    [createEd25519Signer(facilitatorKey.secret(), NETWORK)],
    maxTransactionFeeStroops === undefined ? {} : { maxTransactionFeeStroops });
  /** What the network would charge for `payload` now: the simulated resource fee, in stroops. */
  const feeOf = async (payload: { payload: { transaction: string } }) => {
    const tx = TransactionBuilder.fromXdr(payload.payload.transaction, w.net.passphrase) as Transaction;
    return successfulSimulation(await w.net.server.simulateTransaction(tx)).minResourceFee;
  };
  const envelope = (payload: { x402Version: number; payload: unknown }) =>
    ({ ...payload, accepted: requirements }) as never;

  /** The payload an x402 client sends, built for the wallet: its one entry signed by the agent key for the policy. */
  async function walletPayload(amount: bigint) {
    const { net, wallet, asset, roles: { recipient, sponsor, signer } } = w;
    const payment: AccountPayment = { wallet, policyHash, asset, recipient: recipient.publicKey(), amount };
    const operation = () =>
      new Contract(asset).call('transfer', Address.fromString(wallet).toScVal(),
        Address.fromString(recipient.publicKey()).toScVal(), nativeToScVal(amount, { type: 'i128' }));
    const recording = successfulSimulation(await net.simulate(await net.build(sponsor, operation()), 'record'));
    const [entry] = recording.result.auth;
    // The facilitator allows about 12 ledgers; the wallet's own limit is 20.
    const signed = await signAccountPayment({
      entry: entry!, payment, agent: keypairSigner(signer), networkPassphrase: net.passphrase,
      latestLedger: recording.latestLedger, expirationLedger: recording.latestLedger + 10,
    });
    const source = await net.server.getAccount(sponsor.publicKey());
    const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: net.passphrase })
      .addOperation(Operation.invokeContractFunction({
        contract: asset, function: 'transfer', auth: [signed],
        args: [Address.fromString(wallet).toScVal(), Address.fromString(recipient.publicKey()).toScVal(),
          nativeToScVal(amount, { type: 'i128' })],
      })).setTimeout(120).build() as Transaction;
    return { x402Version: 2, payload: { transaction: tx.toXdr() } };
  }

  beforeAll(async () => {
    w = await walletWorld(await testnetNetwork());
    await w.fund(50n * UNIT);
    policyHash = await w.approve(await w.policy(1));
    // One ordinary payment first, so that the one-off rent a new deployment pays is not counted against x402.
    await w.execute(await w.payment(policyHash, 1n, UNIT));
    facilitatorKey = Keypair.random();
    await w.net.fund(facilitatorKey);
    requirements = {
      scheme: 'exact', network: NETWORK, payTo: w.roles.recipient.publicKey(), asset: w.asset,
      amount: UNIT.toString(), maxTimeoutSeconds: 60, extra: { areFeesSponsored: true },
    };
    note('deployment', { wallet: w.wallet, asset: w.asset, facilitator: facilitatorKey.publicKey() });
  }, TIMEOUT);

  it('baseline: a plain account pays through the stock client and the stock facilitator', async () => {
    const { funder } = w.roles;
    const client = new StockClient(createEd25519Signer(funder.secret(), NETWORK));
    const payload = await client.createPaymentPayload(2, requirements as never);
    note('plain account payment resource fee', { stroops: await feeOf(payload as never) });
    const verified = await facilitator().verify(envelope(payload as never), requirements as never);
    note('baseline verify', verified as never);
    expect(verified.isValid).toBe(true);
    const settled = await facilitator().settle(envelope(payload as never), requirements as never);
    note('baseline settle', settled as never);
    expect(settled.success).toBe(true);
  }, TIMEOUT);

  it('records what the stock client does when the payer is the wallet', async () => {
    const { signer } = w.roles;
    // The only signer the stock client knows: an address, and SEP-43 `signAuthEntry`. Here the agent's key.
    const agent = createEd25519Signer(signer.secret(), NETWORK);
    const client = new StockClient({ address: w.wallet, signAuthEntry: agent.signAuthEntry });
    const outcome = await client.createPaymentPayload(2, requirements as never)
      .then((payload) => ({ ok: true as const, payload }), (error: unknown) => ({ ok: false as const, error: String(error) }));
    note('stock client with the wallet as payer', outcome.ok ? { ok: true } : outcome);
    expect(outcome.ok).toBe(false);
  }, TIMEOUT);

  it('records what the stock facilitator answers to a payment the wallet authorized', async () => {
    const payload = await walletPayload(UNIT);
    note('wallet payment resource fee', { stroops: await feeOf(payload), stock_ceiling: 50_000 });
    const verified = await facilitator().verify(envelope(payload), requirements as never);
    note('stock facilitator, wallet payment', verified as never);
    // The same payment under a ceiling high enough for it, to see what the next check says.
    const roomy = await facilitator(1_000_000).verify(envelope(payload), requirements as never);
    note('stock facilitator with a higher fee ceiling, wallet payment', roomy as never);
    // Recorded, not asserted either way: this is the question the spike asks.
    expect(typeof verified.isValid).toBe('boolean');
    if (verified.isValid) {
      const before = await readWalletBalance(w.read, w.asset);
      const settled = await facilitator().settle(envelope(payload), requirements as never);
      note('stock facilitator settle, wallet payment', settled as never);
      expect(settled.success).toBe(true);
      expect(await readWalletBalance(w.read, w.asset)).toBe(before - UNIT);
    }
  }, TIMEOUT);

  it('settles the wallet payment through a facilitator that lets the payer publish its own events', async () => {
    const wallet = w.wallet;
    /** The stock facilitator, except that contract events from the payer itself are not counted as transfers. */
    const tolerant = () => {
      const scheme = facilitator(1_000_000);
      const stock = (scheme as unknown as { validateSimulationEvents: (...args: unknown[]) => unknown }).validateSimulationEvents;
      (scheme as unknown as { validateSimulationEvents: unknown }).validateSimulationEvents = function (
        this: unknown, events: { event: { type: { name: string }; contractId?: Uint8Array } }[], ...rest: unknown[]
      ) {
        const others = events.filter(({ event }) => !(event.type.name === 'contract' && event.contractId
          && Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(event.contractId as never)).toString() === wallet));
        note('events', { total: events.length, from_payer: events.length - others.length });
        return stock.call(this, others, ...rest);
      };
      return scheme;
    };
    const head = await readAuditHead(w.read);
    const before = await readWalletBalance(w.read, w.asset);
    const payload = await walletPayload(UNIT);
    const verified = await tolerant().verify(envelope(payload), requirements as never);
    note('tolerant facilitator verify', verified as never);
    expect(verified.isValid).toBe(true);
    const settled = await tolerant().settle(envelope(payload), requirements as never);
    note('tolerant facilitator settle', settled as never);
    expect(settled.success).toBe(true);
    expect(await readWalletBalance(w.read, w.asset)).toBe(before - UNIT);
    expect((await readAuditHead(w.read)).sequence).toBe(head.sequence + 1n);
  }, TIMEOUT);
});
