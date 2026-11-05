import { Address, Contract, Operation, StrKey, hash, scValToNative, xdr } from '@stellar/stellar-sdk';
import { signActionAuthorization } from './actions.js';
import { signRegistryAuthorization } from './agents.js';
import { simulateRead, type ContractRead } from './contract-call.js';
import { encodeWalletConstructorArgs } from './encoding.js';
import { authSigner, type Signer } from './signers.js';
import type { EntryAuthorizer, Invocation, NetworkContext } from './transactions.js';
import type {
  ActionRequest, RegistryArgs, RegistryAuthMethod, VerificationArgs, VerificationAuthMethod, WalletArgs,
  WalletOwnerMethod,
} from './types.js';
import { signVerificationAuthorization } from './verification.js';
import { signFundingAuthorization, signWalletAuthorization, walletOperation } from './wallet.js';

/**
 * Domain invocations: each pairs an operation with authorizers that sign only the exact expected call for each
 * account involved. Pass them to `invoke` (the source pays and signs the envelope) or `signForSponsor`.
 */

type Window = Parameters<EntryAuthorizer>[1];

const context = (network: NetworkContext, window: Window) => ({
  networkPassphrase: network.networkPassphrase, latestLedger: window.latestLedger,
  expirationLedger: window.expirationLedger,
});

/** An owner-only wallet call. When the owner is also the transaction source no entry is recorded for it. */
export function ownerInvocation<M extends WalletOwnerMethod>(
  network: NetworkContext, wallet: string, method: M, args: WalletArgs[M], owner: Signer,
): Invocation {
  return {
    operation: walletOperation(wallet, method, args),
    authorizers: {
      [owner.address]: (entry, window) => signWalletAuthorization({
        entry, contractId: wallet, method, args, address: owner.address, ...context(network, window),
        signer: authSigner(owner),
      }),
    },
  };
}

/** `fund`: the funder signs exactly the asset transfer into the wallet. */
export function fundInvocation(
  network: NetworkContext, wallet: string, args: WalletArgs['fund'], funder: Signer,
): Invocation {
  if (args.from !== funder.address) throw new Error('The funder must sign its own funding');
  return {
    operation: walletOperation(wallet, 'fund', args),
    authorizers: {
      [funder.address]: (entry, window) => signFundingAuthorization({
        entry, contractId: wallet, args, ...context(network, window), signer: authSigner(funder),
      }),
    },
  };
}

/** `execute(request)`: the policy's agent signer authorizes exactly this request. */
export function executeInvocation(network: NetworkContext, request: ActionRequest, agent: Signer): Invocation {
  return {
    operation: walletOperation(request.wallet, 'execute', { request }),
    authorizers: {
      [agent.address]: (entry, window) => signActionAuthorization({
        entry, request, agentAddress: agent.address, ...context(network, window), signer: authSigner(agent),
      }),
    },
  };
}

/** A registry mutation; every listed signer authorizes the same exact call (controller, signer or new signer). */
export function registryInvocation<M extends RegistryAuthMethod>(
  network: NetworkContext, registry: string, method: M, args: RegistryArgs[M], signers: readonly Signer[],
  operation: xdr.Operation,
): Invocation {
  return {
    operation,
    authorizers: Object.fromEntries(signers.map((signer) => [signer.address, (entry, window) =>
      signRegistryAuthorization({
        entry, contractId: registry, method, args, address: signer.address, ...context(network, window),
        signer: authSigner(signer),
      })] as const)),
  };
}

/** A verification registry mutation by the admin or a provider. */
export function verificationInvocation<M extends VerificationAuthMethod>(
  network: NetworkContext, registry: string, method: M, args: VerificationArgs[M], signer: Signer,
  operation: xdr.Operation,
): Invocation {
  return {
    operation,
    authorizers: {
      [signer.address]: (entry, window) => signVerificationAuthorization({
        entry, contractId: registry, method, args, address: signer.address, ...context(network, window),
        signer: authSigner(signer),
      }),
    },
  };
}

/** Install contract code; authorized by the source alone. */
export const uploadInvocation = (wasm: Uint8Array): Invocation => ({
  operation: Operation.uploadContractWasm({ wasm }),
});

/** Deploy a smart wallet for `owner`, who must be the transaction source: the constructor requires its authorization. */
export function walletDeployment(
  owner: string, wasmHash: Uint8Array, agentRegistry: string, verificationRegistry: string, salt: Uint8Array,
): Invocation {
  if (wasmHash.length !== 32 || salt.length !== 32) throw new Error('Expected a 32-byte WASM hash and salt');
  return {
    operation: Operation.createCustomContract({
      address: Address.fromString(owner), wasmHash: Buffer.from(wasmHash), salt: Buffer.from(salt),
      constructorArgs: encodeWalletConstructorArgs(owner, agentRegistry, verificationRegistry),
    }),
  };
}

/** The contract address `createCustomContract` assigns for `deployer` and `salt` on this network. */
export function deployedAddress(networkPassphrase: string, deployer: string, salt: Uint8Array): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
    networkId: hash(Buffer.from(networkPassphrase)),
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(deployer).toScAddress(), salt: Buffer.from(salt) }),
    ),
  }));
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

/** The number of decimals an asset contract reports; Stellar Asset Contracts report 7. */
export async function readAssetDecimals(read: Omit<ContractRead, 'contractId'>, asset: string): Promise<number> {
  const value = await simulateRead({ ...read, contractId: asset }, new Contract(asset).call('decimals'),
    'Asset decimals', (code) => new Error(`Asset decimals failed: ${code}`));
  if (value.type !== 'scvU32' || value.u32 > 38) throw new Error('Expected asset decimals as a u32');
  return value.u32;
}

/** Read a holder's balance from an asset contract. */
export async function readAssetBalance(
  read: Omit<ContractRead, 'contractId'>, asset: string, holder: string,
): Promise<bigint> {
  const value = await simulateRead({ ...read, contractId: asset },
    new Contract(asset).call('balance', Address.fromString(holder).toScVal()), 'Asset balance',
    (code) => new Error(`Asset balance failed: ${code}`));
  if (value.type !== 'scvI128') throw new Error('Expected an i128 balance');
  return scValToNative(value) as bigint;
}
