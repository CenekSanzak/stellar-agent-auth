import { Address, StrKey, authorizeEntry, type xdr } from '@stellar/stellar-sdk';
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

/** Inspect a recording-mode entry before giving the headless agent signer any bytes. */
export async function signActionAuthorization(input: ActionAuthorization): Promise<xdr.SorobanAuthorizationEntry> {
  const { entry, request, agentAddress, networkPassphrase, latestLedger, expirationLedger, signer } = input;
  if (!Number.isSafeInteger(latestLedger) || latestLedger < 0
    || !Number.isSafeInteger(expirationLedger) || expirationLedger > 0xffff_ffff
    || expirationLedger <= latestLedger || expirationLedger - latestLedger > MAX_AUTH_WINDOW_LEDGERS) {
    throw new Error('Authorization expiry must be within the next 20 ledgers');
  }

  const credentials = entry.credentials;
  if (!StrKey.isValidEd25519PublicKey(agentAddress) || credentials.type !== 'sorobanCredentialsAddress'
    || Address.fromScAddress(credentials.address.address).toString() !== agentAddress) {
    throw new Error('Expected native authorization for the agent account');
  }
  const root = entry.rootInvocation;
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

  return authorizeEntry(entry, signer, expirationLedger, networkPassphrase, agentAddress);
}
