import { Address, StrKey, authorizeEntry, type xdr } from '@stellar/stellar-sdk';
import { signingAddress } from './credentials.js';
import { encodeAction } from './encoding.js';
import type { ActionRequest } from './types.js';

export const MAX_AUTH_WINDOW_LEDGERS = 20;

interface ActionAuthorization {
  entry: xdr.SorobanAuthorizationEntry;
  request: ActionRequest;
  agentAddress: string;
  networkPassphrase: string;
  latestLedger: number;
  expirationLedger: number;
  signer: Parameters<typeof authorizeEntry>[1];
}

/** Inclusive expiry must fall in (latestLedger, latestLedger + MAX_AUTH_WINDOW_LEDGERS]. */
export function assertAuthWindow(latestLedger: number, expirationLedger: number) {
  if (!Number.isSafeInteger(latestLedger) || latestLedger < 0
    || !Number.isSafeInteger(expirationLedger) || expirationLedger > 0xffff_ffff
    || expirationLedger <= latestLedger || expirationLedger - latestLedger > MAX_AUTH_WINDOW_LEDGERS) {
    throw new Error(`Authorization expiry must be within the next ${MAX_AUTH_WINDOW_LEDGERS} ledgers`);
  }
}

/** Inspect a recording-mode entry before giving the headless agent signer any bytes. */
export async function signActionAuthorization(input: ActionAuthorization): Promise<xdr.SorobanAuthorizationEntry> {
  const { entry, request, agentAddress, networkPassphrase, latestLedger, expirationLedger, signer } = input;
  assertAuthWindow(latestLedger, expirationLedger);

  if (!StrKey.isValidEd25519PublicKey(agentAddress) || signingAddress(entry) !== agentAddress) {
    throw new Error('Expected native authorization for the agent account');
  }
  assertActionTree(entry.rootInvocation, request);

  return authorizeEntry(entry, signer, expirationLedger, networkPassphrase, agentAddress);
}

/** Throws unless `root` is exactly `wallet.execute(request)` for a transfer, with no child invocations. */
export function assertActionTree(root: xdr.SorobanAuthorizedInvocation, request: ActionRequest): void {
  const fn = root.function;
  if (!StrKey.isValidContract(request.wallet) || request.action.kind !== 'Transfer'
    || root.subInvocations.length !== 0 || fn.type !== 'sorobanAuthorizedFunctionTypeContractFn') {
    throw new Error('Expected a single wallet transfer invocation');
  }
  const call = fn.contractFn;
  const args = call.args;
  if (Address.fromScAddress(call.contractAddress).toString() !== request.wallet
    || call.functionName.toString() !== 'execute'
    || args.length !== 1 || args[0]!.toXdr('hex') !== encodeAction(request).toXdr('hex')) {
    throw new Error('Authorization invocation does not match the expected action');
  }
}
