import { Address, Contract, StrKey, authorizeEntry, scValToNative, type xdr } from '@stellar/stellar-sdk';
import { assertAuthWindow } from './actions.js';
import { signInvocation, simulateRead, type ContractRead } from './contract-call.js';
import { signingAddress } from './credentials.js';
import {
  decodeAuditHead, decodeHashList, decodePolicy, decodePolicyState, encodeWalletArgs,
} from './encoding.js';
import { WalletError, canonicalPolicy } from './policies.js';
import {
  WALLET_OWNER_METHODS,
  type AuditHead, type Hash32, type Policy, type PolicyState, type WalletArgs, type WalletMethod,
  type WalletOwnerMethod,
} from './types.js';

/**
 * Smart wallet client: operation builders with the wallet's stateless prechecks, pre-signing validation for owner
 * and funder authorization entries, and read simulations. Agent requests are signed with `signActionAuthorization`.
 */

function positive(amount: bigint, label: string) {
  if (typeof amount !== 'bigint' || amount <= 0n) throw new WalletError('InvalidInput', `${label} must be positive`);
}

function assetContract(asset: string) {
  if (!StrKey.isValidContract(asset)) throw new WalletError('InvalidInput', 'Asset must be an asset contract address');
}

type WalletCall = { [M in WalletMethod]: { method: M; args: WalletArgs[M] } }[WalletMethod];

/** Build `wallet.method(args)` after the stateless checks the contract also enforces. */
export function walletOperation<M extends WalletMethod>(contractId: string, method: M, args: WalletArgs[M]): xdr.Operation {
  if (!StrKey.isValidContract(contractId)) throw new Error('Expected a smart wallet contract address');
  const call = { method, args } as WalletCall;
  switch (call.method) {
    case 'fund':
      assetContract(call.args.asset);
      positive(call.args.amount, 'Funding amount');
      if (call.args.from === contractId) throw new WalletError('InvalidInput', 'The wallet cannot fund itself');
      break;
    case 'withdraw':
      assetContract(call.args.asset);
      positive(call.args.amount, 'Withdrawal amount');
      if (call.args.recipient === contractId) throw new WalletError('InvalidInput', 'The wallet cannot pay itself');
      break;
    case 'balance':
      assetContract(call.args.asset);
      break;
    case 'approve_policy':
    case 'replace_policy':
      canonicalPolicy(call.args.policy);
      break;
  }
  return new Contract(contractId).call(method, ...encodeWalletArgs(method, args));
}

interface WalletAuthorization<M extends WalletOwnerMethod> {
  entry: xdr.SorobanAuthorizationEntry;
  contractId: string;
  method: M;
  args: WalletArgs[M];
  /** The owner account. */
  address: string;
  networkPassphrase: string;
  latestLedger: number;
  expirationLedger: number;
  signer: Parameters<typeof authorizeEntry>[1];
}

/**
 * Inspect a recording-mode owner entry before giving the owner key any bytes: native credentials for the owner and
 * exactly `wallet.method(args)` with no child invocations. Withdrawals need no child authorization because the asset
 * sees the wallet as its invoker.
 */
export async function signWalletAuthorization<M extends WalletOwnerMethod>(
  input: WalletAuthorization<M>,
): Promise<xdr.SorobanAuthorizationEntry> {
  return signInvocation({
    ...input, methods: WALLET_OWNER_METHODS, expectedArgs: () => encodeWalletArgs(input.method, input.args),
    label: 'smart wallet',
  });
}

interface FundingAuthorization {
  entry: xdr.SorobanAuthorizationEntry;
  contractId: string;
  args: WalletArgs['fund'];
  networkPassphrase: string;
  latestLedger: number;
  expirationLedger: number;
  signer: Parameters<typeof authorizeEntry>[1];
}

function contractCall(invocation: xdr.SorobanAuthorizedInvocation) {
  const fn = invocation.function;
  if (fn.type !== 'sorobanAuthorizedFunctionTypeContractFn') return undefined;
  const call = fn.contractFn;
  return {
    contract: Address.fromScAddress(call.contractAddress).toString(),
    method: call.functionName.toString(),
    args: call.args.map((arg) => arg.toXdr('hex')),
  };
}

/**
 * Inspect a recording-mode funding entry before giving the funder key any bytes. The only acceptable tree is
 * `wallet.fund(from, asset, amount)` with exactly one child, `asset.transfer(from, wallet, amount)`, and nothing
 * below it: the signature then moves exactly that amount into the wallet and nothing else.
 */
export async function signFundingAuthorization(input: FundingAuthorization): Promise<xdr.SorobanAuthorizationEntry> {
  const { entry, contractId, args, networkPassphrase, latestLedger, expirationLedger, signer } = input;
  assertAuthWindow(latestLedger, expirationLedger);
  if (!StrKey.isValidEd25519PublicKey(args.from) || signingAddress(entry) !== args.from) {
    throw new Error('Expected native authorization for the funding account');
  }
  const root = entry.rootInvocation;
  const call = contractCall(root);
  const expected = encodeWalletArgs('fund', args).map((arg) => arg.toXdr('hex'));
  if (call?.contract !== contractId || call.method !== 'fund' || call.args.join() !== expected.join()) {
    throw new Error('Authorization invocation does not match the expected funding call');
  }
  const [child, ...rest] = root.subInvocations;
  const transfer = child ? contractCall(child) : undefined;
  const transferArgs = [args.from, contractId].map((value) => Address.fromString(value).toScVal().toXdr('hex'));
  if (rest.length || !child || child.subInvocations.length || transfer?.contract !== args.asset
    || transfer.method !== 'transfer' || transfer.args.length !== 3
    || transfer.args[0] !== transferArgs[0] || transfer.args[1] !== transferArgs[1]
    || transfer.args[2] !== expected[2]) {
    throw new Error('Funding authorization must cover exactly the asset transfer into the wallet');
  }
  return authorizeEntry(entry, signer, expirationLedger, networkPassphrase, args.from);
}

export type WalletRead = ContractRead;

function read<M extends WalletMethod>(wallet: WalletRead, method: M, args: WalletArgs[M]) {
  return simulateRead(wallet, walletOperation(wallet.contractId, method, args), `Smart wallet ${method}`,
    (code) => new WalletError(code, `Smart wallet ${method} failed: ${code}`));
}

function addressOf(value: xdr.ScVal, label: string) {
  if (value.type !== 'scvAddress') throw new Error(`Expected the ${label} address`);
  return Address.fromScVal(value).toString();
}

export async function readWalletOwner(wallet: WalletRead): Promise<string> {
  return addressOf(await read(wallet, 'owner', {}), 'owner');
}

/** The agent and verification registries the wallet consults; both are fixed at deployment. */
export async function readWalletRegistries(wallet: WalletRead) {
  return {
    agent_registry: addressOf(await read(wallet, 'agent_registry', {}), 'agent registry'),
    verification_registry: addressOf(await read(wallet, 'verification_registry', {}), 'verification registry'),
  };
}

export async function readPaused(wallet: WalletRead): Promise<boolean> {
  const value = await read(wallet, 'paused', {});
  if (value.type !== 'scvBool') throw new Error('Expected a bool');
  return value.b;
}

/** Hashes of the active policies, oldest first. */
export async function readActivePolicies(wallet: WalletRead): Promise<Hash32[]> {
  return decodeHashList(await read(wallet, 'policies', {}));
}

/** The canonical policy, active or revoked; `WalletError` with `NotFound` when unknown. */
export async function readPolicy(wallet: WalletRead, policy_hash: Hash32): Promise<Policy> {
  return decodePolicy(await read(wallet, 'policy', { policy_hash }));
}

/** The policy's state as of the simulated ledger time, including today's spend after a day change. */
export async function readPolicyState(wallet: WalletRead, policy_hash: Hash32): Promise<PolicyState> {
  const state = decodePolicyState(await read(wallet, 'policy_state', { policy_hash }));
  if (state.policy_hash.length !== policy_hash.length || state.policy_hash.some((byte, i) => byte !== policy_hash[i])) {
    throw new Error('Smart wallet returned a different policy state');
  }
  return state;
}

export async function readAuditHead(wallet: WalletRead): Promise<AuditHead> {
  return decodeAuditHead(await read(wallet, 'audit_head', {}));
}

/** The wallet's balance of `asset`, read from the asset contract. */
export async function readWalletBalance(wallet: WalletRead, asset: string): Promise<bigint> {
  const value = await read(wallet, 'balance', { asset });
  if (value.type !== 'scvI128') throw new Error('Expected an i128 balance');
  return scValToNative(value) as bigint;
}
