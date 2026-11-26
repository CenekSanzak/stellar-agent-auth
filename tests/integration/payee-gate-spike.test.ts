import { Address, Contract, hash, nativeToScVal, xdr, type rpc } from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { signAccountPayment, type AccountPayment } from '../../packages/sdk/src/account.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import type { CheckKind, Hash32, VerificationRequirement } from '../../packages/sdk/src/types.js';
import { VerificationRegistryError, checkVerification } from '../../packages/sdk/src/verification.js';
import { readPolicy, readWalletRegistries } from '../../packages/sdk/src/wallet.js';
import { readWasm, successfulSimulation } from './support/local-network.js';
import { UNIT, walletWorld, type WalletWorld } from './support/wallet-world.js';

/**
 * SPIKE, not an acceptance suite: can a payee decide, from the payment it was handed, whether the paying agent
 * meets the payee's own standard?
 *
 * The wallet already checks its agent's verification under the owner's policy. A payee may want more or something
 * else: a provider it trusts, checks it requires, a risk it accepts. Everything it needs is in the payment and on
 * the ledger:
 *
 * 1. the payer is a contract running wallet code the payee knows (its code hash);
 * 2. that wallet is bound to the registries the payee trusts;
 * 3. the wallet's signed entry names the policy, the wallet says which agent that policy is for, and the
 *    verification registry says whether that agent has a result meeting the payee's requirement now.
 *
 * Step 1 is what makes steps 2 and 3 worth anything: only known wallet code can be believed about its policy.
 */

const TIMEOUT = 240_000;

interface PayeeTerms {
  /** Code hashes of wallet contracts the payee accepts. */
  walletCode: readonly string[];
  agentRegistry: string;
  verificationRegistry: string;
  provider: string;
  requirement: VerificationRequirement;
}

type GateAnswer = { ok: true; agent: bigint } | { ok: false; reason: string };

/** The policy hash a wallet's signed entry carries in its signature. */
function policyOf(entry: xdr.SorobanAuthorizationEntry): Hash32 | undefined {
  const { credentials } = entry;
  const signature = credentials.type === 'sorobanCredentialsAddress' ? credentials.address.signature
    : credentials.type === 'sorobanCredentialsAddressV2' ? credentials.addressV2.signature : undefined;
  if (signature?.type !== 'scvMap') return undefined;
  const field = (signature.map ?? []).find(({ key }) => key.type === 'scvSymbol' && key.sym.toString() === 'policy_hash')?.val;
  return field?.type === 'scvBytes' && field.bytes.value.length === 32 ? Uint8Array.from(field.bytes.value) : undefined;
}

/** The hash of the code a contract runs, or `undefined` for a contract that is not WASM or does not exist. */
async function codeHashOf(server: rpc.Server, contractId: string): Promise<string | undefined> {
  const { entries } = await server.getLedgerEntries(new Contract(contractId).getFootprint());
  const data = entries[0]?.val;
  if (data?.type !== 'contractData' || data.contractData.val.type !== 'scvContractInstance') return undefined;
  const { executable } = data.contractData.val.instance;
  return executable.type === 'contractExecutableWasm' ? executable.wasmHash.toXdr('hex') : undefined;
}

async function payeeGate(
  server: rpc.Server, networkPassphrase: string, payer: string, entry: xdr.SorobanAuthorizationEntry, terms: PayeeTerms,
): Promise<GateAnswer> {
  const code = await codeHashOf(server, payer);
  if (!code || !terms.walletCode.includes(code)) return { ok: false, reason: 'payer is not a wallet this payee knows' };
  const read = { server, contractId: payer, source: terms.provider, networkPassphrase };
  const registries = await readWalletRegistries(read);
  if (registries.agent_registry !== terms.agentRegistry || registries.verification_registry !== terms.verificationRegistry) {
    return { ok: false, reason: 'wallet is bound to other registries' };
  }
  const policyHash = policyOf(entry);
  if (!policyHash) return { ok: false, reason: 'payment names no policy' };
  const policy = await readPolicy(read, policyHash);
  try {
    await checkVerification({ ...read, contractId: terms.verificationRegistry },
      { agent_id: policy.agent_id, revision: policy.revision, provider: terms.provider }, terms.requirement);
  } catch (error) {
    if (error instanceof VerificationRegistryError) return { ok: false, reason: error.code };
    throw error;
  }
  return { ok: true, agent: policy.agent_id };
}

describe('payee-side verification gate (spike)', () => {
  let w: WalletWorld;
  let entry: xdr.SorobanAuthorizationEntry;
  /** The entry as recorded, before the agent signed it. */
  let unsigned: xdr.SorobanAuthorizationEntry;
  let terms: PayeeTerms;
  const checks = (...kinds: CheckKind[]): VerificationRequirement =>
    ({ required_checks: kinds, max_age: 30n * 86_400n, max_risk_score: 10 });

  beforeAll(async () => {
    w = await walletWorld();
    await w.fund(20n * UNIT);
    const policyHash = await w.approve(await w.policy(71));
    const { net, wallet, asset, roles: { recipient, sponsor, signer, provider } } = w;
    const payment: AccountPayment = { wallet, policyHash, asset, recipient: recipient.publicKey(), amount: UNIT };
    const operation = new Contract(asset).call('transfer', Address.fromString(wallet).toScVal(),
      Address.fromString(recipient.publicKey()).toScVal(), nativeToScVal(UNIT, { type: 'i128' }));
    const recording = successfulSimulation(await net.simulate(await net.build(sponsor, operation), 'record'));
    unsigned = recording.result.auth[0]!;
    entry = await signAccountPayment({
      entry: recording.result.auth[0]!, payment, agent: keypairSigner(signer), networkPassphrase: net.passphrase,
      latestLedger: recording.latestLedger, expirationLedger: recording.latestLedger + 10,
    });
    terms = {
      walletCode: [Buffer.from(hash(readWasm('smart_wallet'))).toString('hex')], agentRegistry: w.agentRegistry,
      verificationRegistry: w.verificationRegistry, provider: provider.publicKey(),
      requirement: checks('Endpoint', 'Metadata', 'SignerAccount'),
    };
  }, TIMEOUT);

  const gate = (overrides: Partial<PayeeTerms> = {}, payer = w.wallet, signed = entry) =>
    payeeGate(w.net.server, w.net.passphrase, payer, signed, { ...terms, ...overrides });

  it('accepts a payment from a known wallet whose agent meets the payee\'s requirement', async () => {
    expect(await gate()).toEqual({ ok: true, agent: w.agent.agent_id });
  }, TIMEOUT);

  it('refuses when the payee asks for more than the agent\'s result shows, though the wallet itself would pay', async () => {
    // The fixture result does not cover a code check; the owner's policy did not ask for one, this payee does.
    expect(await gate({ requirement: checks('Code', 'Metadata') })).toEqual({ ok: false, reason: 'CheckNotPassed' });
    expect(await gate({ provider: w.roles.stranger.publicKey() })).toMatchObject({ ok: false });
  }, TIMEOUT);

  it('refuses a payer it cannot believe: unknown code, other registries, or no policy named', async () => {
    expect(await gate({ walletCode: ['00'.repeat(32)] })).toEqual({ ok: false, reason: 'payer is not a wallet this payee knows' });
    // The asset contract is a contract too, and it is not a wallet.
    expect(await gate({}, w.asset)).toEqual({ ok: false, reason: 'payer is not a wallet this payee knows' });
    expect(await gate({ agentRegistry: w.verificationRegistry })).toEqual({ ok: false, reason: 'wallet is bound to other registries' });
    expect(await gate({}, w.wallet, unsigned)).toEqual({ ok: false, reason: 'payment names no policy' });
  }, TIMEOUT);

  it('refuses once the provider revokes the agent\'s result', async () => {
    await w.publishFixture('failed-endpoint', 2n);
    expect(await gate()).toMatchObject({ ok: false });
  }, TIMEOUT);
});
