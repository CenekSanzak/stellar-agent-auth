import {
  Account, Address, BASE_FEE, StrKey, TransactionBuilder, authorizeEntry, rpc, type xdr,
} from '@stellar/stellar-sdk';
import { assertAuthWindow } from './actions.js';
import { signingAddress } from './credentials.js';
import { CONTRACT_ERRORS, type ContractErrorName } from './types.js';

/** Shared plumbing for the registry clients: read simulation and pre-signing authorization checks. */

/**
 * Map a simulation or transaction error string led by `Error(Contract, #N)` to its v1 name. Only the first
 * host error counts: the diagnostic log after an auth failure can quote unrelated contract error codes.
 */
export function contractErrorName(message: string): ContractErrorName | undefined {
  const [, type, value] = /Error\((\w+), (#?\w+)\)/.exec(message) ?? [];
  const code = type === 'Contract' ? /^#(\d{1,10})$/.exec(value ?? '')?.[1] : undefined;
  return code === undefined ? undefined : CONTRACT_ERRORS[Number(code) - 1];
}

export interface ContractRead {
  server: Pick<rpc.Server, 'simulateTransaction'>;
  contractId: string;
  /** Any standard account public key; simulation does not consume its sequence. */
  source: string;
  networkPassphrase: string;
}

/**
 * Simulate a read-only `operation` and return its value. A contract error becomes `toError(code)`; any other
 * simulation failure is a plain `Error`. Nothing is submitted, so nothing is extended or written.
 */
export async function simulateRead(
  read: ContractRead, operation: xdr.Operation, label: string, toError: (code: ContractErrorName) => Error,
): Promise<xdr.ScVal> {
  if (!StrKey.isValidEd25519PublicKey(read.source)) throw new Error('Expected a standard source account');
  const tx = new TransactionBuilder(new Account(read.source, '0'), {
    fee: BASE_FEE, networkPassphrase: read.networkPassphrase,
  }).addOperation(operation).setTimeout(30).build();
  const simulation = await read.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    const code = contractErrorName(simulation.error);
    if (code) throw toError(code);
    throw new Error(`${label} simulation failed: ${simulation.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`${label} simulation returned no result`);
  }
  return simulation.result.retval;
}

export interface InvocationAuthorization {
  entry: xdr.SorobanAuthorizationEntry;
  contractId: string;
  method: string;
  /** The methods this contract may be asked to authorize. */
  methods: readonly string[];
  /** Encodes the expected arguments; called only after the credential and method checks pass. */
  expectedArgs: () => xdr.ScVal[];
  address: string;
  networkPassphrase: string;
  latestLedger: number;
  expirationLedger: number;
  signer: Parameters<typeof authorizeEntry>[1];
  /** Contract name used in messages, such as `agent registry`. */
  label: string;
}

/**
 * Sign a recording-mode entry only if it is native authorization for `address` of exactly
 * `contractId.method(expectedArgs)` with no child invocations, expiring within the SDK's window. The signer
 * sees no bytes otherwise.
 */
export async function signInvocation(input: InvocationAuthorization): Promise<xdr.SorobanAuthorizationEntry> {
  const {
    entry, contractId, method, methods, expectedArgs, address, networkPassphrase, latestLedger, expirationLedger,
    signer, label,
  } = input;
  assertAuthWindow(latestLedger, expirationLedger);

  if (!StrKey.isValidEd25519PublicKey(address) || signingAddress(entry) !== address) {
    throw new Error('Expected native authorization for the signing account');
  }
  const root = entry.rootInvocation;
  const fn = root.function;
  if (!methods.includes(method) || !StrKey.isValidContract(contractId)
    || root.subInvocations.length !== 0 || fn.type !== 'sorobanAuthorizedFunctionTypeContractFn') {
    throw new Error(`Expected a single authorized ${label} invocation`);
  }
  const call = fn.contractFn;
  const expected = expectedArgs();
  if (Address.fromScAddress(call.contractAddress).toString() !== contractId
    || call.functionName.toString() !== method || call.args.length !== expected.length
    || call.args.some((arg, i) => arg.toXdr('hex') !== expected[i]!.toXdr('hex'))) {
    throw new Error(`Authorization invocation does not match the expected ${label} call`);
  }

  return authorizeEntry(entry, signer, expirationLedger, networkPassphrase, address);
}
