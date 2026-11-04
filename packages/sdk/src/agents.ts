import { Contract, StrKey, type authorizeEntry, type xdr } from '@stellar/stellar-sdk';
import { signInvocation, simulateRead as simulate, type ContractRead } from './contract-call.js';
import { decodeIdentity, encodeRegistryArgs } from './encoding.js';
import {
  MAX_METADATA_URI_BYTES, REGISTRY_AUTH_METHODS,
  type AgentIdentity, type ContractErrorName, type RegistryArgs, type RegistryAuthMethod, type RegistryMethod,
} from './types.js';

export { contractErrorName } from './contract-call.js';

const encoder = new TextEncoder();
const HTTPS = 'https://';

/**
 * A registry contract error, or an SDK precheck for input the contract rejects with that error. The contract checks
 * most authorization first, so a raw call missing a required entry (such as a contract new signer's) fails with a host
 * `Error(Auth, …)` instead, which has no contract error name.
 */
export class AgentRegistryError extends Error {
  override readonly name = 'AgentRegistryError';
  readonly code: ContractErrorName;
  constructor(code: ContractErrorName, message: string) {
    super(message);
    this.code = code;
  }
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
  return signInvocation({
    ...input, methods: REGISTRY_AUTH_METHODS, expectedArgs: () => encodeRegistryArgs(input.method, input.args),
    label: 'agent registry',
  });
}

export type RegistryRead = ContractRead;

function simulateRead<M extends 'get' | 'current' | 'agent_count'>(
  read: RegistryRead, method: M, args: RegistryArgs[M],
) {
  return simulate(read, registryOperation(read.contractId, method, args), `Agent registry ${method}`,
    (code) => new AgentRegistryError(code, `Agent registry ${method} failed: ${code}`));
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
