import {
  Account, Address, BASE_FEE, Contract, StrKey, TransactionBuilder, authorizeEntry, rpc, type xdr,
} from '@stellar/stellar-sdk';
import { assertAuthWindow } from './actions.js';
import { decodeIdentity, encodeRegistryArgs } from './encoding.js';
import {
  CONTRACT_ERRORS, MAX_METADATA_URI_BYTES, REGISTRY_AUTH_METHODS,
  type AgentIdentity, type ContractErrorName, type RegistryArgs, type RegistryAuthMethod, type RegistryMethod,
} from './types.js';

const encoder = new TextEncoder();
const HTTPS = 'https://';

/** A contract error, or an SDK precheck mirroring the contract error it would produce. */
export class AgentRegistryError extends Error {
  override readonly name = 'AgentRegistryError';
  readonly code: ContractErrorName;
  constructor(code: ContractErrorName, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Map a simulation or transaction error string led by `Error(Contract, #N)` to its v1 name. Only the first
 * host error counts: the diagnostic log after an auth failure can quote unrelated contract error codes.
 */
export function contractErrorName(message: string): ContractErrorName | undefined {
  const [, type, value] = /Error\((\w+), (#?\w+)\)/.exec(message) ?? [];
  const code = type === 'Contract' ? /^#(\d{1,10})$/.exec(value ?? '')?.[1] : undefined;
  return code === undefined ? undefined : CONTRACT_ERRORS[Number(code) - 1];
}

/** Mirrors `shared_types::identity::validate_metadata`, in the same order and with the same error codes. */
export function validateAgentMetadata(uri: string, hash: Uint8Array): void {
  const bytes = encoder.encode(typeof uri === 'string' ? uri : '');
  if (!bytes.length) throw new AgentRegistryError('InvalidInput', 'Metadata URI is empty');
  if (bytes.length > MAX_METADATA_URI_BYTES) {
    throw new AgentRegistryError('LimitExceeded', `Metadata URI exceeds ${MAX_METADATA_URI_BYTES} bytes`);
  }
  if (bytes.length <= HTTPS.length || !uri.startsWith(HTTPS)) {
    throw new AgentRegistryError('InvalidInput', 'Metadata URI must start with https:// and name a location');
  }
  if (bytes.some((byte) => byte < 0x21 || byte > 0x7e)) {
    throw new AgentRegistryError('InvalidInput', 'Metadata URI must contain only visible ASCII');
  }
  if (!(hash instanceof Uint8Array) || hash.length !== 32 || hash.every((byte) => byte === 0)) {
    throw new AgentRegistryError('InvalidInput', 'Metadata hash must be 32 bytes and not all zero');
  }
}

function standardSigner(value: string) {
  if (!StrKey.isValidEd25519PublicKey(value)) {
    throw new AgentRegistryError('InvalidInput', 'Agent signer must be a standard account');
  }
}

type RegistryCall = { [M in RegistryMethod]: { method: M; args: RegistryArgs[M] } }[RegistryMethod];

/** Build `registry.method(args)` after the stateless checks the contract also enforces. */
export function registryOperation<M extends RegistryMethod>(
  contractId: string, method: M, args: RegistryArgs[M],
): xdr.Operation {
  if (!StrKey.isValidContract(contractId)) throw new Error('Expected an agent registry contract address');
  const call = { method, args } as RegistryCall;
  switch (call.method) {
    case 'register':
      if (call.args.controller === call.args.signer) {
        throw new AgentRegistryError('InvalidInput', 'Controller and signer must differ');
      }
      standardSigner(call.args.signer);
      validateAgentMetadata(call.args.metadata_uri, call.args.metadata_hash);
      break;
    case 'update_metadata':
      validateAgentMetadata(call.args.metadata_uri, call.args.metadata_hash);
      break;
    case 'rotate_signer':
      standardSigner(call.args.new_signer);
      break;
  }
  return new Contract(contractId).call(method, ...encodeRegistryArgs(method, args));
}

interface RegistryAuthorization<M extends RegistryAuthMethod> {
  entry: xdr.SorobanAuthorizationEntry;
  contractId: string;
  method: M;
  args: RegistryArgs[M];
  address: string;
  networkPassphrase: string;
  latestLedger: number;
  expirationLedger: number;
  signer: Parameters<typeof authorizeEntry>[1];
}

/** Inspect a recording-mode registry entry before giving a controller or signer key any bytes. */
export async function signRegistryAuthorization<M extends RegistryAuthMethod>(
  input: RegistryAuthorization<M>,
): Promise<xdr.SorobanAuthorizationEntry> {
  const { entry, contractId, method, args, address, networkPassphrase, latestLedger, expirationLedger, signer } = input;
  assertAuthWindow(latestLedger, expirationLedger);

  const credentials = entry.credentials;
  if (!StrKey.isValidEd25519PublicKey(address) || credentials.type !== 'sorobanCredentialsAddress'
    || Address.fromScAddress(credentials.address.address).toString() !== address) {
    throw new Error('Expected native authorization for the signing account');
  }
  const root = entry.rootInvocation;
  const fn = root.function;
  if (!(REGISTRY_AUTH_METHODS as readonly string[]).includes(method) || !StrKey.isValidContract(contractId)
    || root.subInvocations.length !== 0 || fn.type !== 'sorobanAuthorizedFunctionTypeContractFn') {
    throw new Error('Expected a single authorized agent registry invocation');
  }
  const call = fn.contractFn;
  const expected = encodeRegistryArgs(method, args);
  if (Address.fromScAddress(call.contractAddress).toString() !== contractId
    || call.functionName.toString() !== method || call.args.length !== expected.length
    || call.args.some((arg, i) => arg.toXdr('hex') !== expected[i]!.toXdr('hex'))) {
    throw new Error('Authorization invocation does not match the expected registry call');
  }

  return authorizeEntry(entry, signer, expirationLedger, networkPassphrase, address);
}

export interface RegistryRead {
  server: Pick<rpc.Server, 'simulateTransaction'>;
  contractId: string;
  /** Any standard account public key; simulation does not consume its sequence. */
  source: string;
  networkPassphrase: string;
}

async function simulateRead<M extends 'get' | 'current' | 'agent_count'>(
  read: RegistryRead, method: M, args: RegistryArgs[M],
) {
  if (!StrKey.isValidEd25519PublicKey(read.source)) throw new Error('Expected a standard source account');
  const tx = new TransactionBuilder(new Account(read.source, '0'), {
    fee: BASE_FEE, networkPassphrase: read.networkPassphrase,
  }).addOperation(registryOperation(read.contractId, method, args)).setTimeout(30).build();
  const simulation = await read.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    const code = contractErrorName(simulation.error);
    if (code) throw new AgentRegistryError(code, `Agent registry ${method} failed: ${code}`);
    throw new Error(`Agent registry ${method} simulation failed: ${simulation.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`Agent registry ${method} simulation returned no result`);
  }
  return simulation.result.retval;
}

/** Read an identity in any state; throws `AgentRegistryError` with `NotFound` when absent. */
export async function readAgent(read: RegistryRead, agent_id: bigint): Promise<AgentIdentity> {
  const identity = decodeIdentity(await simulateRead(read, 'get', { agent_id }));
  if (identity.agent_id !== agent_id) throw new Error('Agent registry returned a different agent');
  return identity;
}

/** Read an identity only if it is active at `revision` (`NotFound`, `IdentityChanged` or `Revoked` otherwise). */
export async function readCurrent(read: RegistryRead, agent_id: bigint, revision: bigint): Promise<AgentIdentity> {
  const identity = decodeIdentity(await simulateRead(read, 'current', { agent_id, revision }));
  if (identity.agent_id !== agent_id || identity.revision !== revision || identity.disabled) {
    throw new Error('Agent registry returned a different identity');
  }
  return identity;
}

export async function readAgentCount(read: RegistryRead): Promise<bigint> {
  const value = await simulateRead(read, 'agent_count', {});
  if (value.type !== 'scvU64') throw new Error('Expected a u64 agent count');
  return value.u64;
}
