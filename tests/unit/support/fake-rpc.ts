import { Account, Networks, SorobanDataBuilder, rpc, xdr, type Transaction } from '@stellar/stellar-sdk';
import type { NetworkContext, RpcServer } from '../../../packages/sdk/src/transactions.js';

/**
 * An in-memory RPC server for pipeline tests. Simulation, submission and status are scripted per test, and every
 * call is recorded so tests can assert what was, and was not, sent.
 */
export class FakeRpc {
  latest = { sequence: 100, closeTime: Math.floor(Date.now() / 1000) };
  oldestLedger = 1;
  sequences = new Map<string, bigint>();
  sent: Transaction[] = [];
  simulations: { tx: Transaction; mode: rpc.Api.SimulationAuthMode | undefined }[] = [];
  /** Answers for `sendTransaction`, consumed in order; the default accepts as `PENDING`. */
  sendResults: (() => rpc.Api.SendTransactionResponse)[] = [];
  /** Committed outcomes by hash; anything else is `NOT_FOUND`. */
  outcomes = new Map<string, rpc.Api.GetTransactionResponse>();
  statusFailures = 0;
  simulateWith: (tx: Transaction, mode: rpc.Api.SimulationAuthMode | undefined) =>
    rpc.Api.SimulateTransactionResponse = () => success();

  readonly server: RpcServer = {
    getNetwork: async () => ({ passphrase: Networks.STANDALONE, protocolVersion: 29, friendbotUrl: '' }) as never,
    getLatestLedger: async () => ({
      id: 'x', sequence: this.latest.sequence, protocolVersion: '29', closeTime: String(this.latest.closeTime),
    }) as never,
    getAccount: async (address: string) => new Account(address, String(this.sequences.get(address) ?? 1000n)),
    simulateTransaction: async (tx, _resources, mode) => {
      this.simulations.push({ tx: tx as Transaction, mode });
      return this.simulateWith(tx as Transaction, mode);
    },
    sendTransaction: async (tx) => {
      this.sent.push(tx as Transaction);
      const next = this.sendResults.shift();
      return next ? next() : { status: 'PENDING', hash: hex((tx as Transaction).hash()), latestLedger: 0,
        latestLedgerCloseTime: 0 } as never;
    },
    getTransaction: async (hash: string) => {
      if (this.statusFailures > 0) {
        this.statusFailures -= 1;
        throw new Error('RPC unreachable');
      }
      return this.outcomes.get(hash) ?? {
        status: rpc.Api.GetTransactionStatus.NOT_FOUND, txHash: hash, latestLedger: this.latest.sequence,
        latestLedgerCloseTime: this.latest.closeTime, oldestLedger: this.oldestLedger, oldestLedgerCloseTime: 0,
      } as never;
    },
  };

  context(): NetworkContext {
    return { server: this.server, networkPassphrase: Networks.STANDALONE, upgradedAuth: false };
  }

  /** Commit `tx` successfully, returning `value`. */
  commit(tx: Transaction, value: xdr.ScVal = xdr.ScVal.scvVoid()) {
    this.outcomes.set(hex(tx.hash()), {
      status: rpc.Api.GetTransactionStatus.SUCCESS, txHash: hex(tx.hash()), ledger: this.latest.sequence + 1,
      returnValue: value, latestLedger: this.latest.sequence + 1, latestLedgerCloseTime: this.latest.closeTime,
      oldestLedger: this.oldestLedger, oldestLedgerCloseTime: 0,
    } as never);
  }

  /** Fail `tx` on the ledger with `contractCode` emitted by `contract`, as a diagnostic event would report. */
  fail(tx: Transaction, contract: Uint8Array, contractCode: number) {
    const event = new xdr.DiagnosticEvent({
      inSuccessfulContractCall: false,
      event: new xdr.ContractEvent({
        ext: xdr.ExtensionPoint.v0(), contractId: new xdr.ContractId(contract), type: xdr.ContractEventType.diagnostic,
        body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol('error'), xdr.ScVal.scvError(xdr.ScError.sceContract(contractCode))],
          data: xdr.ScVal.scvVoid(),
        })),
      }),
    });
    this.outcomes.set(hex(tx.hash()), {
      status: rpc.Api.GetTransactionStatus.FAILED, txHash: hex(tx.hash()), ledger: this.latest.sequence + 1,
      envelopeXdr: tx.toEnvelope(), diagnosticEventsXdr: [event],
      resultXdr: xdr.TransactionResult.fromXdr(failedResult(), 'base64'),
      latestLedger: this.latest.sequence + 1, latestLedgerCloseTime: this.latest.closeTime,
      oldestLedger: this.oldestLedger, oldestLedgerCloseTime: 0,
    } as never);
  }
}

/** A `txFailed` result whose single operation trapped in the host. */
function failedResult() {
  return new xdr.TransactionResult({
    feeCharged: 100n,
    result: xdr.TransactionResultResult.txFailed([
      xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(
        xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
      )),
    ]),
    ext: xdr.TransactionResultExt.v0(),
  }).toXdr('base64');
}

export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** A parsed successful simulation with `auth` entries and a 5,000-stroop resource fee. */
export function success(auth: xdr.SorobanAuthorizationEntry[] = [], retval = xdr.ScVal.scvVoid(), fee = '5000') {
  return {
    id: '1', latestLedger: 100, events: [], _parsed: true, transactionData: new SorobanDataBuilder().setResourceFee(BigInt(fee)),
    minResourceFee: fee, result: { auth, retval },
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

export function failure(error: string) {
  return { id: '1', latestLedger: 100, events: [], _parsed: true, error } as unknown as rpc.Api.SimulateTransactionResponse;
}
