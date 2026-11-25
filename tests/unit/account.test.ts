import { Address, Keypair, Networks, authorizeEntry, hash, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  accountPaymentOperation, assertAccountPaymentTree, signAccountPayment, type AccountPayment,
} from '../../packages/sdk/src/account.js';
import { accountPaymentInvocation } from '../../packages/sdk/src/client.js';
import { encodeAccountSignature, encodePolicyState } from '../../packages/sdk/src/encoding.js';
import { WalletError } from '../../packages/sdk/src/policies.js';
import { keypairSigner, type Signer } from '../../packages/sdk/src/signers.js';
import { authorizeEntries } from '../../packages/sdk/src/transactions.js';
import { readPaymentCheck } from '../../packages/sdk/src/wallet.js';
import { bytes, contract } from '../fixtures/abi-v1.js';

const passphrase = Networks.STANDALONE;
const agentKey = Keypair.random();
const agent = keypairSigner(agentKey);
const wallet = contract(61);
const asset = contract(62);
const recipient = contract(63);
const payment: AccountPayment = { wallet, policyHash: bytes(9), asset, recipient, amount: 30_000_000n };
const window = { latestLedger: 100, expirationLedger: 120 };

type Credentials = 'address' | 'v2' | 'source';

/** What recording mode returns for the wallet authorizing `contractId.method(args)`. */
function recorded(
  overrides: Partial<{ address: string; contractId: string; method: string; args: xdr.ScVal[];
    children: xdr.SorobanAuthorizedInvocation[]; credentials: Credentials }> = {},
) {
  const { address = wallet, contractId = asset, method = 'transfer', children = [], credentials = 'address' } = overrides;
  const args = overrides.args ?? [Address.fromString(wallet).toScVal(), Address.fromString(recipient).toScVal(),
    nativeToScVal(payment.amount, { type: 'i128' })];
  const body = new xdr.SorobanAddressCredentials({
    address: Address.fromString(address).toScAddress(), nonce: 11n, signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: credentials === 'source' ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : credentials === 'v2' ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(body)
        : xdr.SorobanCredentials.sorobanCredentialsAddress(body),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(), functionName: method, args,
      })),
      subInvocations: children,
    }),
  });
}

const sign = (entry: xdr.SorobanAuthorizationEntry, overrides: Partial<Parameters<typeof signAccountPayment>[0]> = {}) =>
  signAccountPayment({ entry, payment, agent, networkPassphrase: passphrase, ...window, ...overrides });

/** A signer that records what it was asked to sign. */
function spying(inner: Signer = agent) {
  const messages: Uint8Array[] = [];
  const signer: Signer = {
    ...inner,
    async signMessage(message) {
      messages.push(message);
      return inner.signMessage!(message);
    },
  };
  return { signer, messages };
}

function credentialsOf(entry: xdr.SorobanAuthorizationEntry) {
  const { credentials } = entry;
  if (credentials.type === 'sorobanCredentialsAddress') return credentials.address;
  if (credentials.type === 'sorobanCredentialsAddressV2') return credentials.addressV2;
  throw new Error('Expected address credentials');
}

describe('account payment signing', () => {
  it('builds the plain transfer the wallet authorizes', () => {
    const operation = accountPaymentOperation(payment);
    const { body } = operation;
    if (body.type !== 'invokeHostFunction') throw new Error('Expected an invocation');
    const fn = body.invokeHostFunctionOp.hostFunction;
    if (fn.type !== 'hostFunctionTypeInvokeContract') throw new Error('Expected a contract call');
    expect(Address.fromScAddress(fn.invokeContract.contractAddress).toString()).toBe(asset);
    expect(fn.invokeContract.functionName.toString()).toBe('transfer');
    expect(fn.invokeContract.args.map((arg) => arg.toXdr('hex'))).toEqual(recorded().rootInvocation.function.type
      === 'sorobanAuthorizedFunctionTypeContractFn'
      ? (recorded().rootInvocation.function as { contractFn: xdr.InvokeContractArgs }).contractFn.args
        .map((arg) => arg.toXdr('hex')) : []);
    expect(body.invokeHostFunctionOp.auth).toHaveLength(0);

    for (const bad of [{ amount: 0n }, { amount: -1n }, { amount: 1n << 127n }, { recipient: wallet },
      { wallet: agent.address }, { asset: agent.address }, { policyHash: new Uint8Array(31) }]) {
      expect(() => accountPaymentOperation({ ...payment, ...bad }), JSON.stringify(Object.keys(bad))).toThrow();
    }
  });

  it('signs the payload followed by the policy hash, as the agent key, for either credential type', async () => {
    for (const credentials of ['address', 'v2'] as const) {
      const { signer, messages } = spying();
      const entry = recorded({ credentials });
      const signed = await sign(entry, { agent: signer });

      // The message is the SDK's payload hash for this entry and expiry, then the 32-byte policy hash.
      let payload: Uint8Array | undefined;
      await authorizeEntry(entry, async (_preimage, value) => {
        payload = value;
        return { signatureScVal: xdr.ScVal.scvVoid() };
      }, window.expirationLedger, passphrase, wallet);
      expect(messages).toHaveLength(1);
      expect(Buffer.from(messages[0]!).toString('hex'))
        .toBe(Buffer.concat([Buffer.from(payload!), Buffer.from(payment.policyHash)]).toString('hex'));

      const body = credentialsOf(signed);
      expect(signed.credentials.type).toBe(entry.credentials.type);
      expect(body.signatureExpirationLedger).toBe(window.expirationLedger);
      expect(Address.fromScAddress(body.address).toString()).toBe(wallet);
      // The signature value is the wallet's `AccountSignature`, carrying a signature the agent key verifies.
      const value = body.signature;
      if (value.type !== 'scvMap') throw new Error('Expected a map');
      const signature = value.map!.find((item) => item.key.type === 'scvSymbol'
        && item.key.sym.toString() === 'signature')!.val;
      if (signature.type !== 'scvBytes') throw new Error('Expected bytes');
      expect(agentKey.verify(Buffer.from(messages[0]!), Buffer.from(signature.bytes.value))).toBe(true);
      expect(value.toXdr('hex'))
        .toBe(encodeAccountSignature(payment.policyHash, Uint8Array.from(signature.bytes.value)).toXdr('hex'));
      expect(signed.rootInvocation.toXdr('hex')).toBe(entry.rootInvocation.toXdr('hex'));
    }
  });

  it('gives the key nothing for an entry that is not exactly this payment by this wallet', async () => {
    const amount = (value: bigint) => [Address.fromString(wallet).toScVal(), Address.fromString(recipient).toScVal(),
      nativeToScVal(value, { type: 'i128' })];
    const child = recorded().rootInvocation;
    const cases: [string, xdr.SorobanAuthorizationEntry, string][] = [
      ['another amount', recorded({ args: amount(payment.amount + 1n) }), 'does not match'],
      ['another recipient', recorded({ args: [Address.fromString(wallet).toScVal(),
        Address.fromString(contract(64)).toScVal(), nativeToScVal(payment.amount, { type: 'i128' })] }), 'does not match'],
      ['another holder\'s funds', recorded({ args: [Address.fromString(contract(64)).toScVal(),
        Address.fromString(recipient).toScVal(), nativeToScVal(payment.amount, { type: 'i128' })] }), 'does not match'],
      ['another asset', recorded({ contractId: contract(65) }), 'does not match'],
      ['an allowance', recorded({ method: 'approve' }), 'does not match'],
      ['a fourth argument', recorded({ args: [...amount(payment.amount), xdr.ScVal.scvU32(1)] }), 'does not match'],
      ['a child invocation', recorded({ children: [child] }), 'single asset transfer'],
      ['an entry for another address', recorded({ address: contract(66) }), 'wallet\'s own'],
      ['an entry for the agent account', recorded({ address: agent.address }), 'wallet\'s own'],
      ['source-account credentials', recorded({ credentials: 'source' }), 'wallet\'s own'],
    ];
    for (const [label, entry, message] of cases) {
      const { signer, messages } = spying();
      await expect(sign(entry, { agent: signer }), label).rejects.toThrow(message);
      expect(messages, label).toHaveLength(0);
    }
    // An expiry beyond the SDK's window is refused before signing as well.
    const { signer, messages } = spying();
    await expect(sign(recorded(), { agent: signer, expirationLedger: 121 })).rejects.toThrow('within the next');
    expect(messages).toHaveLength(0);
  });

  it('needs a key that signs messages, and checks what the key returns', async () => {
    const { signMessage: _unused, ...walletOnly } = agent;
    await expect(sign(recorded(), { agent: walletOnly as Signer })).rejects.toThrow('headless agent key');
    const other = Keypair.random();
    const lying: Signer = { ...agent, signMessage: async (message) => other.sign(Buffer.from(message)) };
    await expect(sign(recorded(), { agent: lying })).rejects.toThrow('invalid signature');
    const short: Signer = { ...agent, signMessage: async () => new Uint8Array(63) };
    await expect(sign(recorded(), { agent: short })).rejects.toThrow('invalid signature');
  });

  it('plugs into the pipeline as the wallet\'s authorizer and never as a source check', async () => {
    const invocation = accountPaymentInvocation({ networkPassphrase: passphrase } as never, payment, agent);
    expect(Object.keys(invocation.authorizers ?? {})).toEqual([wallet]);
    expect(invocation.checks).toBeUndefined();
    const [signed] = await authorizeEntries([recorded()], invocation.authorizers!, window);
    expect(credentialsOf(signed!).signature.type).toBe('scvMap');
    // A sponsor recording an entry for itself, or for the agent account, is never signed by this invocation.
    await expect(authorizeEntries([recorded({ address: agent.address })], invocation.authorizers!, window))
      .rejects.toThrow('no signer covers');
    expect(() => assertAccountPaymentTree(recorded({ method: 'burn' }).rootInvocation, payment)).toThrow('does not match');
  });
});

describe('payment check', () => {
  const state = { policy_hash: payment.policyHash, revoked: false, next_sequence: 4n, utc_day: 20_833n,
    daily_spend: [{ asset, amount: 30_000_000n }] };
  const read = (response: unknown) => ({
    server: { simulateTransaction: async () => response as rpc.Api.SimulateTransactionResponse },
    contractId: wallet, source: Keypair.random().publicKey(), networkPassphrase: passphrase,
  });
  const ok = (retval: xdr.ScVal) => ({ id: '1', latestLedger: 1, events: [], _parsed: true, minResourceFee: '0',
    transactionData: {}, result: { auth: [], retval } });
  const args = { policy_hash: payment.policyHash, asset, recipient, amount: payment.amount };

  it('returns the prospective state and maps a refusal to the wallet\'s own error', async () => {
    expect(await readPaymentCheck(read(ok(encodePolicyState(state))), args)).toEqual(state);
    for (const [code, name] of [[3, 'LimitExceeded'], [11, 'PolicyDenied'], [12, 'Paused'], [8, 'Revoked']] as const) {
      const refusal = await readPaymentCheck(read({ id: '1', latestLedger: 1, events: [], _parsed: true,
        error: `HostError: Error(Contract, #${code})` }), args).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(WalletError);
      expect(refusal).toHaveProperty('code', name);
    }
    // The answer must be about the policy that was asked about.
    await expect(readPaymentCheck(read(ok(encodePolicyState({ ...state, policy_hash: hash(Buffer.from('other')) }))), args))
      .rejects.toThrow('different policy');
    await expect(readPaymentCheck(read(ok(xdr.ScVal.scvVoid())), args)).rejects.toThrow();
  });
});
