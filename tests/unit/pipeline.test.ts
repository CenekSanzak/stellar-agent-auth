import { Address, Contract, Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import {
  FeeCeilingExceeded, MemoryJournal, SimulationRejected, SubmissionUnsettled, authorizeEntries, invoke, invokeSigned,
  pipelineLimits, prepare, settle, settleScope, submit, withAuth, type TransactionRecord,
} from '../../packages/sdk/src/transactions.js';
import { bytes, contract } from '../fixtures/abi-v1.js';
import { FakeRpc, failure, hex, success } from './support/fake-rpc.js';

const source = keypairSigner(Keypair.random());
const target = contract(21);
const limits = pipelineLimits({ pollIntervalMs: 0, timeoutSeconds: 5 });
const call = () => new Contract(target).call('ping');

/** A recorded address-credential entry for `address` calling `target.ping()`. */
function entry(address: string, credentials: 'address' | 'source' = 'address') {
  return new xdr.SorobanAuthorizationEntry({
    credentials: credentials === 'source' ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(), nonce: 7n, signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(target).toScAddress(), functionName: 'ping', args: [],
      })),
      subInvocations: [],
    }),
  });
}

let rpc: FakeRpc;
let journal: MemoryJournal;
beforeEach(() => {
  rpc = new FakeRpc();
  journal = new MemoryJournal();
});

async function signedTx() {
  const prepared = await prepare(rpc.context(), source.address, { operation: call() }, limits);
  return source.signTransaction(prepared.transaction, rpc.context().networkPassphrase);
}

describe('pipeline stages', () => {
  it('records, authorizes, enforces, assembles, signs and submits exactly once', async () => {
    const agent = Keypair.random();
    rpc.simulateWith = (_tx, mode) => success(mode === 'record' ? [entry(agent.publicKey())] : []);
    rpc.sendResults.push(() => {
      rpc.commit(rpc.sent.at(-1)!, xdr.ScVal.scvU32(9));
      return { status: 'PENDING', hash: hex(rpc.sent.at(-1)!.hash()) } as never;
    });
    const seen: number[] = [];
    const outcome = await invoke(rpc.context(), source, {
      operation: call(),
      authorizers: { [agent.publicKey()]: async (recorded, window) => {
        seen.push(window.expirationLedger - window.latestLedger);
        return recorded;
      } },
    }, journal, { limits });
    expect(rpc.simulations.map(({ mode }) => mode)).toEqual(['record', 'enforce']);
    expect(seen).toEqual([20]);
    expect(rpc.sent).toHaveLength(1);
    const sent = rpc.sent[0]!;
    expect(sent.signatures).toHaveLength(1);
    expect(Keypair.fromPublicKey(source.address).verify(sent.hash(), sent.signatures[0]!.signature.value)).toBe(true);
    expect(BigInt(sent.fee)).toBe(5_100n);
    expect(outcome).toMatchObject({ status: 'success', record: { status: 'success', scope: `source:${source.address}` } });
    expect(outcome.returnValue?.toXdr('base64')).toBe(xdr.ScVal.scvU32(9).toXdr('base64'));
  });

  it('refuses a fee above the ceiling before the source signs or anything is sent', async () => {
    rpc.simulateWith = () => success([], xdr.ScVal.scvVoid(), '2000000');
    await expect(invoke(rpc.context(), source, { operation: call() }, journal,
      { limits: pipelineLimits({ maxFee: 1_000_000n }) })).rejects.toBeInstanceOf(FeeCeilingExceeded);
    expect(rpc.sent).toHaveLength(0);
    expect(journal.records.size).toBe(0);
  });

  it('classifies simulation failures without submitting', async () => {
    const cases: [string, Partial<SimulationRejected>][] = [
      ['HostError: Error(Contract, #8)\n...Error(Contract, #10)', { code: 'Revoked', auth: undefined }],
      ['HostError: Error(Auth, InvalidAction)\n"Unauthorized function call for address"', { auth: 'missing' }],
      ['HostError: Error(Auth, InvalidAction)\n"failed account authentication with error"', { auth: 'forged' }],
      ['HostError: Error(Auth, ExistingValue)\n"nonce already exists for address"', { auth: 'replayed' }],
      ['HostError: Error(Budget, ExceededLimit)', { code: undefined, auth: undefined }],
    ];
    for (const [error, expected] of cases) {
      rpc.simulateWith = () => failure(error);
      const rejection = await invoke(rpc.context(), source, { operation: call() }, journal, { limits })
        .catch((thrown: unknown) => thrown);
      expect(rejection).toBeInstanceOf(SimulationRejected);
      expect(rejection).toMatchObject(expected);
    }
    expect(rpc.sent).toHaveLength(0);
  });

  it('signs only entries with a matching authorizer and source credentials only when the source signs', async () => {
    const agent = Keypair.random().publicKey();
    const stranger = Keypair.random().publicKey();
    const window = { latestLedger: 10, expirationLedger: 30 };
    const pass = async (recorded: xdr.SorobanAuthorizationEntry) => recorded;
    await expect(authorizeEntries([entry(stranger)], { [agent]: pass }, window, true))
      .rejects.toThrow(`authorization from ${stranger}`);
    await expect(authorizeEntries([entry(agent, 'source')], {}, window, false)).rejects.toThrow('transaction source');
    expect(await authorizeEntries([entry(agent, 'source')], {}, window, true)).toHaveLength(1);
    // Inherited properties never count as authorizers.
    await expect(authorizeEntries([entry(stranger)], Object.create({ [stranger]: pass }) as never, window, true))
      .rejects.toThrow('no signer covers');
  });

  it('replaces authorization only on plain contract invocations', () => {
    const signed = withAuth(call(), [entry(source.address)]);
    expect(signed.body.type === 'invokeHostFunction' && signed.body.invokeHostFunctionOp.auth).toHaveLength(1);
    const withSource = xdr.Operation.fromXdr(call().toXdr('base64'), 'base64');
    const sourced = new xdr.Operation({ sourceAccount: xdr.MuxedAccount.keyTypeEd25519(StrKey.decodeEd25519PublicKey(
      source.address)) as never, body: withSource.body });
    expect(() => withAuth(sourced, [])).toThrow('Operation-level source');
  });

  it('refuses a pre-signed operation whose enforced simulation needs entries it does not carry', async () => {
    rpc.simulateWith = () => success([entry(Keypair.random().publicKey())]);
    await expect(invokeSigned(rpc.context(), source, call(), journal, 'execute:x', limits))
      .rejects.toThrow('does not carry');
    expect(rpc.sent).toHaveLength(0);
  });

  it('validates limits', () => {
    expect(() => pipelineLimits({ maxFee: 0n })).toThrow('Invalid');
    expect(() => pipelineLimits({ authLedgers: 21 })).toThrow('Invalid');
    expect(() => pipelineLimits({ timeoutSeconds: 1 })).toThrow('Invalid');
    expect(pipelineLimits().maxFee).toBe(50_000_000n);
  });
});

describe('submission status', () => {
  it('journals the envelope before sending it', async () => {
    const tx = await signedTx();
    let journaled: TransactionRecord | undefined;
    rpc.sendResults.push(() => {
      journaled = journal.records.get(hex(tx.hash()));
      rpc.commit(tx);
      return { status: 'PENDING' } as never;
    });
    await submit(rpc.context(), tx, journal, 'scope', limits);
    expect(journaled).toMatchObject({ status: 'pending', envelope: tx.toXDR(), source: source.address });
  });

  it('tracks a send that threw by its hash instead of assuming it was lost', async () => {
    const tx = await signedTx();
    rpc.sendResults.push(() => {
      rpc.commit(tx);
      throw new Error('socket hang up');
    });
    const outcome = await submit(rpc.context(), tx, journal, 'scope', limits);
    expect(outcome.status).toBe('success');
    expect(rpc.sent).toHaveLength(1);
  });

  it('resends the identical envelope on TRY_AGAIN_LATER and rejects definitively on ERROR', async () => {
    const tx = await signedTx();
    rpc.sendResults.push(() => ({ status: 'TRY_AGAIN_LATER' }) as never, () => {
      rpc.commit(tx);
      return { status: 'PENDING' } as never;
    });
    expect((await submit(rpc.context(), tx, journal, 'a', limits)).status).toBe('success');
    expect(new Set(rpc.sent.map((sent) => hex(sent.hash()))).size).toBe(1);

    const other = await signedTx();
    rpc.sendResults.push(() => ({
      status: 'ERROR', errorResult: { result: { type: 'txBadSeq' } },
    }) as never);
    const rejected = await submit(rpc.context(), other, journal, 'b', limits);
    expect(rejected).toMatchObject({ status: 'rejected', record: { status: 'rejected', error: 'txBadSeq' } });
  });

  it('reports the invoked contract\'s own error for an on-chain failure, not a nested contract\'s', async () => {
    const tx = await signedTx();
    rpc.sendResults.push(() => {
      rpc.fail(tx, bytes(99), 10);
      rpc.fail(tx, StrKey.decodeContract(target), 14);
      const outcome = rpc.outcomes.get(hex(tx.hash())) as { diagnosticEventsXdr: unknown[] };
      // The asset contract's #10 comes first in the log, then the wallet's #14.
      const nested = new FakeRpc();
      nested.fail(tx, bytes(99), 10);
      outcome.diagnosticEventsXdr.unshift(...(nested.outcomes.get(hex(tx.hash())) as typeof outcome)
        .diagnosticEventsXdr);
      return { status: 'PENDING' } as never;
    });
    const outcome = await submit(rpc.context(), tx, journal, 'scope', limits);
    expect(outcome).toMatchObject({ status: 'failed', code: 'TransferFailed', record: { error: 'TransferFailed' } });
  });

  it('never reports success while a hash is unconfirmed, and expires it only after its time bound', async () => {
    const tx = await signedTx();
    const record: TransactionRecord = {
      scope: 's', hash: hex(tx.hash()), envelope: tx.toXDR(), source: source.address,
      max_time: tx.timeBounds!.maxTime, submitted_after_ledger: 100, status: 'pending',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    expect((await settle(rpc.context(), record)).status).toBe('pending');
    rpc.latest.closeTime = Number(tx.timeBounds!.maxTime) + 1;
    expect((await settle(rpc.context(), record)).status).toBe('expired');
    rpc.oldestLedger = 200;
    expect((await settle(rpc.context(), record)).status).toBe('unknown');
  });

  it('marks a submission unknown when its status cannot be read, and blocks the scope', async () => {
    const tx = await signedTx();
    rpc.statusFailures = 1_000;
    const outcome = await submit(rpc.context(), tx, journal, 'execute:w:p', limits);
    expect(outcome.status).toBe('unknown');
    await expect(settleScope(rpc.context(), journal, 'execute:w:p')).rejects.toBeInstanceOf(SubmissionUnsettled);
    const before = rpc.sent.length;
    await expect(submit(rpc.context(), await signedTx(), journal, 'execute:w:p', limits))
      .rejects.toBeInstanceOf(SubmissionUnsettled);
    expect(rpc.sent).toHaveLength(before);

    // Once the hash is readable and committed, the scope settles and the original outcome is reported.
    rpc.statusFailures = 0;
    rpc.commit(tx);
    const [settled] = await settleScope(rpc.context(), journal, 'execute:w:p');
    expect(settled).toMatchObject({ status: 'success', hash: hex(tx.hash()) });
  });

  it('keeps a pending submission blocking until its time bound passes, then allows a rebuild', async () => {
    const tx = await signedTx();
    rpc.sendResults.push(() => {
      // Never included: the network moves past the time bound while the client polls.
      rpc.latest.closeTime = Number(tx.timeBounds!.maxTime) + 1;
      return { status: 'PENDING' } as never;
    });
    const outcome = await submit(rpc.context(), tx, journal, 'execute:w:p', limits);
    expect(outcome.status).toBe('expired');
    expect(await settleScope(rpc.context(), journal, 'execute:w:p')).toEqual([]);
  });
});

