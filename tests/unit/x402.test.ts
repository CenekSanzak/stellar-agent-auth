import {
  Account, Address, Keypair, Networks, Operation, StrKey, TransactionBuilder, nativeToScVal, xdr,
} from '@stellar/stellar-sdk';
import { x402Client } from '@x402/core/client';
import { describe, expect, it } from 'vitest';
import { encodeAccountSignature } from '../../packages/sdk/src/encoding.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import { MemoryJournal } from '../../packages/sdk/src/transactions.js';
import {
  STELLAR_LOCAL, STELLAR_PUBNET, STELLAR_TESTNET, StellarExactFacilitator, WalletExactScheme, checkPayer, fetchPaying,
  passphraseOf, payerOf, policyHashOf, transferProblem, x402Network,
} from '../../packages/x402/src/index.js';
import { bytes, contract } from '../fixtures/abi-v1.js';
import { FakeRpc, success } from './support/fake-rpc.js';

const asset = contract(51);
const wallet = contract(52);
const other = contract(53);
const payee = Keypair.random().publicKey();
const facilitatorKey = Keypair.random();
const AMOUNT = 10_000_000n;

const requirements = (overrides: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: STELLAR_LOCAL, asset, amount: AMOUNT.toString(), payTo: payee, maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true }, ...overrides,
}) as never;

/** A contract event as a simulation reports it. */
function event(from: string | undefined, topics: xdr.ScVal[], data: xdr.ScVal, type = xdr.ContractEventType.contract) {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(), type,
      contractId: from ? new xdr.ContractId(StrKey.decodeContract(from)) : null,
      body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics, data })),
    }),
  });
}
const address = (value: string) => Address.fromString(value).toScVal();
const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' });
const transfer = (overrides: { from?: string; to?: string; amount?: bigint; emitter?: string } = {}) =>
  event(overrides.emitter ?? asset, [xdr.ScVal.scvSymbol('transfer'), address(overrides.from ?? wallet), address(overrides.to ?? payee)],
    i128(overrides.amount ?? AMOUNT));
const audit = (emitter = wallet) => event(emitter, [xdr.ScVal.scvSymbol('audit_v1')], xdr.ScVal.scvU32(1));
const problem = (events: xdr.DiagnosticEvent[], payer = wallet) => transferProblem(events, asset, payer, payee, AMOUNT);

describe('x402 network names', () => {
  it('maps each network passphrase to its identifier and back', () => {
    expect(x402Network(Networks.TESTNET)).toBe(STELLAR_TESTNET);
    expect(x402Network(Networks.PUBLIC)).toBe(STELLAR_PUBNET);
    expect(x402Network(Networks.STANDALONE)).toBe(STELLAR_LOCAL);
    expect(passphraseOf(STELLAR_LOCAL)).toBe(Networks.STANDALONE);
    expect(() => x402Network('Some other network')).toThrow('No x402 network identifier');
    expect(() => passphraseOf('stellar:elsewhere')).toThrow('Unknown x402 Stellar network');
  });
});

describe('what a payment may do, read from its simulated events', () => {
  it('accepts exactly the one transfer asked for', () => {
    expect(problem([transfer()])).toBeUndefined();
    // Diagnostic events are the host's own notes and say nothing about what the payment does.
    expect(problem([event(other, [xdr.ScVal.scvSymbol('fn_call')], xdr.ScVal.scvVoid(), xdr.ContractEventType.diagnostic), transfer()]))
      .toBeUndefined();
    // A transfer to a muxed address reports its amount inside a map.
    const muxed = event(asset, [xdr.ScVal.scvSymbol('transfer'), address(wallet), address(payee)],
      xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount'), val: i128(AMOUNT) })]));
    expect(problem([muxed])).toBeUndefined();
  });

  it('lets a wallet that pays publish its own events, and nobody else', () => {
    expect(problem([audit(), transfer()])).toBeUndefined();
    expect(problem([transfer(), audit(other)])).toBe('invalid_exact_stellar_payload_event_wrong_asset');
    // A plain account cannot publish events; a contract event under its name is someone else's.
    const account = Keypair.random().publicKey();
    expect(transferProblem([transfer({ from: account })], asset, account, payee, AMOUNT)).toBeUndefined();
    // The asset is never excused, even if it is named as the payer.
    expect(transferProblem([audit(asset), transfer({ from: asset })], asset, asset, payee, AMOUNT))
      .toBe('invalid_exact_stellar_payload_event_not_transfer');
  });

  it('refuses a payment that moves anything else, or not what was asked', () => {
    expect(problem([])).toBe('invalid_exact_stellar_payload_no_transfer_events');
    expect(problem([audit()])).toBe('invalid_exact_stellar_payload_no_transfer_events');
    expect(problem([transfer(), transfer()])).toBe('invalid_exact_stellar_payload_multiple_transfers');
    expect(problem([transfer({ amount: AMOUNT + 1n })])).toBe('invalid_exact_stellar_payload_event_wrong_amount');
    expect(problem([transfer({ to: Keypair.random().publicKey() })])).toBe('invalid_exact_stellar_payload_event_wrong_to');
    expect(problem([transfer({ from: other })])).toBe('invalid_exact_stellar_payload_event_wrong_from');
    expect(problem([transfer({ emitter: other })])).toBe('invalid_exact_stellar_payload_event_wrong_asset');
    expect(problem([event(asset, [xdr.ScVal.scvSymbol('approve'), address(wallet), address(payee)], i128(AMOUNT))]))
      .toBe('invalid_exact_stellar_payload_event_not_transfer');
    expect(problem([event(undefined, [xdr.ScVal.scvSymbol('transfer')], xdr.ScVal.scvVoid())]))
      .toBe('invalid_exact_stellar_payload_event_missing_contract_id');
  });
});

/** The wallet's entry for the transfer, signed in the wallet's own form unless told otherwise. */
function entry(options: { payer?: string; expiration?: number; signature?: xdr.ScVal; sub?: boolean; amount?: bigint } = {}) {
  const { payer = wallet, expiration = 110, sub = false, amount = AMOUNT } = options;
  const call = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(asset).toScAddress(), functionName: 'transfer',
    args: [address(wallet), address(payee), i128(amount)],
  });
  const invocation = (subInvocations: xdr.SorobanAuthorizedInvocation[]) => new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations,
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      address: Address.fromString(payer).toScAddress(), nonce: 7n, signatureExpirationLedger: expiration,
      signature: options.signature ?? encodeAccountSignature(bytes(9), new Uint8Array(64).fill(1)),
    })),
    rootInvocation: invocation(sub ? [invocation([])] : []),
  });
}

function payment(options: {
  auth?: xdr.SorobanAuthorizationEntry[]; contractId?: string; method?: string; to?: string; amount?: bigint; source?: string;
} = {}) {
  const { auth = [entry()], contractId = asset, method = 'transfer', to = payee, amount = AMOUNT } = options;
  const tx = new TransactionBuilder(new Account(options.source ?? Keypair.random().publicKey(), '0'),
    { fee: '100', networkPassphrase: Networks.STANDALONE })
    .addOperation(Operation.invokeContractFunction({
      contract: contractId, function: method, args: [address(wallet), address(to), i128(amount)], auth,
    })).setTimeout(60).build();
  return { x402Version: 2, accepted: requirements(), payload: { transaction: tx.toXdr() } } as never;
}

describe('this project\'s facilitator', () => {
  function facilitator(rpc = new FakeRpc(), maxFee?: bigint) {
    return new StellarExactFacilitator({
      context: rpc.context(), signer: keypairSigner(facilitatorKey), journal: new MemoryJournal(),
      ...(maxFee === undefined ? {} : { maxFee }), limits: { pollIntervalMs: 0 },
    });
  }
  const paying = (events: xdr.DiagnosticEvent[], fee = '5000') => {
    const rpc = new FakeRpc();
    rpc.simulateWith = () => ({ ...success([], xdr.ScVal.scvVoid(), fee), events }) as never;
    return rpc;
  };

  it('says it sponsors fees and who it signs as', () => {
    const scheme = facilitator();
    expect(scheme).toMatchObject({ scheme: 'exact', caipFamily: 'stellar:*' });
    expect(scheme.getExtra()).toEqual({ areFeesSponsored: true });
    expect(scheme.getSigners()).toEqual([facilitatorKey.publicKey()]);
  });

  it('verifies a wallet payment that shows the one transfer and the wallet\'s own audit event', async () => {
    const answer = await facilitator(paying([audit(), transfer()])).verify(payment(), requirements());
    expect(answer).toEqual({ isValid: true, payer: wallet });
  });

  it('refuses a payment that is not the transfer the service asked for', async () => {
    const scheme = facilitator(paying([transfer()]));
    const verify = (payload: never, asked = requirements()) => scheme.verify(payload, asked).then((answer) => answer.invalidReason);
    expect(await verify({ ...(payment() as object), x402Version: 1 } as never)).toBe('invalid_x402_version');
    expect(await verify(payment(), requirements({ scheme: 'upto' }))).toBe('unsupported_scheme');
    expect(await verify(payment(), requirements({ network: STELLAR_TESTNET }))).toBe('network_mismatch');
    expect(await verify({ ...(payment() as object), payload: { transaction: 'AAAA' } } as never)).toBe('invalid_exact_stellar_payload_malformed');
    expect(await verify(payment({ contractId: other }))).toBe('invalid_exact_stellar_payload_wrong_asset');
    expect(await verify(payment({ method: 'approve' }))).toBe('invalid_exact_stellar_payload_wrong_function_name');
    expect(await verify(payment({ to: Keypair.random().publicKey() }))).toBe('invalid_exact_stellar_payload_wrong_recipient');
    expect(await verify(payment({ amount: AMOUNT - 1n }))).toBe('invalid_exact_stellar_payload_wrong_amount');
    expect(await verify(payment({ source: facilitatorKey.publicKey() }))).toBe('invalid_exact_stellar_payload_unsafe_tx_or_op_source');
  });

  it('refuses authorization that is missing, unsigned, long-lived, someone else\'s or wider than the transfer', async () => {
    const rpc = paying([transfer()]);
    const scheme = facilitator(rpc);
    const verify = (auth: xdr.SorobanAuthorizationEntry[]) => scheme.verify(payment({ auth }), requirements())
      .then((answer) => answer.invalidReason);
    expect(await verify([])).toBe('invalid_exact_stellar_payload_no_auth_entries');
    expect(await verify([entry({ signature: xdr.ScVal.scvVoid() })])).toBe('invalid_exact_stellar_payload_missing_payer_signature');
    // The latest ledger is 100 and 60 seconds is 12 ledgers, with two of tolerance.
    expect(await verify([entry({ expiration: 115 })])).toBe('invalid_exact_stellar_signature_expiration_too_far');
    expect(await verify([entry({ expiration: 114 })])).toBeUndefined();
    expect(await verify([entry(), entry({ payer: other })])).toBe('invalid_exact_stellar_payload_unexpected_signer');
    expect(await verify([entry({ payer: facilitatorKey.publicKey() })])).toBe('invalid_exact_stellar_payload_facilitator_in_auth');
    expect(await verify([entry({ sub: true })])).toBe('invalid_exact_stellar_payload_has_subinvocations');
    // An entry for a different amount does not authorize this transfer.
    expect(await verify([entry({ amount: AMOUNT + 1n })])).toBe('invalid_exact_stellar_payload_has_subinvocations');
    expect(rpc.sent).toHaveLength(0);
  });

  it('refuses what simulation shows: a failure, a fee above its ceiling, or events beyond the transfer', async () => {
    const failing = new FakeRpc();
    failing.simulateWith = () => ({ id: '1', latestLedger: 100, events: [], _parsed: true, error: 'HostError: Error(Auth, InvalidAction)' }) as never;
    expect((await facilitator(failing).verify(payment(), requirements())).invalidReason)
      .toBe('invalid_exact_stellar_payload_simulation_failed');
    expect(await facilitator(paying([transfer()], '60000'), 50_000n).verify(payment(), requirements()))
      .toMatchObject({ isValid: false, invalidReason: 'invalid_exact_stellar_payload_fee_exceeds_maximum' });
    expect((await facilitator(paying([transfer(), audit(other)])).verify(payment(), requirements())).invalidReason)
      .toBe('invalid_exact_stellar_payload_event_wrong_asset');
  });

  it('settles with itself as source and reports the transaction, and settles nothing it would not verify', async () => {
    const rpc = paying([audit(), transfer()]);
    rpc.sendResults.push(() => {
      rpc.commit(rpc.sent.at(-1)!);
      return { status: 'PENDING' } as never;
    });
    const settled = await facilitator(rpc).settle(payment(), requirements());
    expect(settled).toMatchObject({ success: true, network: STELLAR_LOCAL, payer: wallet });
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.sent[0]!.source).toBe(facilitatorKey.publicKey());
    expect(settled.transaction).toBe(Buffer.from(rpc.sent[0]!.hash()).toString('hex'));

    const refused = await facilitator(rpc).settle(payment({ amount: AMOUNT - 1n }), requirements());
    expect(refused).toMatchObject({ success: false, transaction: '', errorReason: 'invalid_exact_stellar_payload_wrong_amount' });
    expect(rpc.sent).toHaveLength(1);
  });
});

describe('the paying side', () => {
  const agent = keypairSigner(Keypair.random());
  const untouched = new Proxy({}, { get: () => () => { throw new Error('the network must not be reached'); } });
  const scheme = () => new WalletExactScheme({
    wallet, policyHash: bytes(9), agent, context: { ...new FakeRpc().context(), server: untouched as never },
    server: untouched as never,
  });

  it('signs nothing for a request it cannot honour', async () => {
    const create = (overrides: Record<string, unknown>) => scheme().createPaymentPayload(2, requirements(overrides));
    await expect(create({ scheme: 'upto' })).rejects.toThrow('Unsupported x402 scheme');
    await expect(create({ network: STELLAR_TESTNET })).rejects.toThrow('another network');
    await expect(create({ extra: { areFeesSponsored: false } })).rejects.toThrow('cannot pay fees');
    await expect(create({ amount: '0' })).rejects.toThrow('invalid amount');
    await expect(create({ amount: '1.5' })).rejects.toThrow('invalid amount');
    await expect(create({ asset: 'not-an-asset' })).rejects.toThrow('invalid asset');
  });
});

describe('paying for a request', () => {
  const terms = { x402Version: 2, resource: { url: 'https://seller.example/thing' }, accepts: [requirements()] };
  const asking = () => new Response('{}', {
    status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(terms)).toString('base64') },
  });
  const client = () => new x402Client().setSpendControls(false).register(STELLAR_LOCAL, {
    scheme: 'exact', createPaymentPayload: async (x402Version: number) => ({ x402Version, payload: { transaction: 'AAAA' } }),
  } as never);

  it('returns a seller\'s refusal as an answer when it does not repeat its terms', async () => {
    // Some sellers answer a payment they refuse with a bare 402 and a body of their own.
    const answers = [asking(), new Response('{"error":"payment_invalid"}', { status: 402 })];
    const paid = await fetchPaying(client(), 'https://seller.example/thing', {}, (async () => answers.shift()!) as typeof fetch);
    expect(paid.response.status).toBe(402);
    expect(paid.required).toBeUndefined();
    expect(await paid.response.json()).toEqual({ error: 'payment_invalid' });
  });

  it('reports the reason a seller gives with its terms', async () => {
    const refusal = new Response('{}', {
      status: 402,
      headers: { 'payment-required': Buffer.from(JSON.stringify({ ...terms, error: 'not_today' })).toString('base64') },
    });
    const answers = [asking(), refusal];
    const paid = await fetchPaying(client(), 'https://seller.example/thing', {}, (async () => answers.shift()!) as typeof fetch);
    expect(paid.required?.error).toBe('not_today');
  });
});

describe('a payee\'s check on the payer', () => {
  it('reads the payer and the policy from the payment', () => {
    const found = payerOf(payment(), Networks.STANDALONE);
    expect(found?.payer).toBe(wallet);
    expect(policyHashOf(found!.entry)).toEqual(bytes(9));
    expect(policyHashOf(entry({ signature: xdr.ScVal.scvVoid() }))).toBeUndefined();
    // A plain account's signature names no policy.
    expect(policyHashOf(entry({ signature: xdr.ScVal.scvVec([xdr.ScVal.scvU32(1)]) }))).toBeUndefined();
    expect(payerOf({ payload: { transaction: 'AAAA' } }, Networks.STANDALONE)).toBeUndefined();
    expect(payerOf(payment({ auth: [] }), Networks.STANDALONE)).toBeUndefined();
  });

  it('turns a plain account away without asking the network', async () => {
    const server = new Proxy({}, { get: () => () => { throw new Error('the network must not be reached'); } }) as never;
    const answer = await checkPayer(Keypair.random().publicKey(), entry(), {
      server, networkPassphrase: Networks.STANDALONE, walletCode: ['ab'.repeat(32)], agentRegistry: contract(1),
      verificationRegistry: contract(2), provider: Keypair.random().publicKey(),
      requirement: { required_checks: ['Metadata'], max_age: 1n, max_risk_score: 0 },
    });
    expect(answer).toMatchObject({ ok: false, reason: 'payee_gate_unknown_payer' });
  });
});
