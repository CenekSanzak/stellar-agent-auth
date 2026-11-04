import { Address, Keypair, hash, scValToNative, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { signActionAuthorization } from '../../packages/sdk/src/actions.js';
import { signRegistryAuthorization } from '../../packages/sdk/src/agents.js';
import { signingAddress } from '../../packages/sdk/src/credentials.js';
import {
  encodeAction, encodeRegistryArgs, encodeVerificationArgs, encodeWalletArgs,
} from '../../packages/sdk/src/encoding.js';
import { signVerificationAuthorization } from '../../packages/sdk/src/verification.js';
import { signFundingAuthorization, signWalletAuthorization } from '../../packages/sdk/src/wallet.js';
import { action, contract, passphrase } from '../fixtures/abi-v1.js';

/**
 * RPC versions record native account authorization as legacy `Address` credentials or CAP-71 `AddressV2`
 * credentials (Testnet RPC records V2 where the pinned Quickstart records legacy). Every SDK signer must sign both,
 * over the matching preimage, and must still refuse delegated credentials.
 */

const key = Keypair.random();
const latestLedger = 500;
const expirationLedger = latestLedger + 20;
const registry = contract(70);

function invocation(
  contractId: string, method: string, args: xdr.ScVal[], subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(contractId).toScAddress(), functionName: method, args,
    })),
    subInvocations,
  });
}

const credentials = () => new xdr.SorobanAddressCredentials({
  address: Address.fromString(key.publicKey()).toScAddress(), nonce: 9n, signatureExpirationLedger: 0,
  signature: xdr.ScVal.scvVoid(),
});

const entries = (root: xdr.SorobanAuthorizedInvocation) => ({
  legacy: new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(credentials()), rootInvocation: root,
  }),
  v2: new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials()), rootInvocation: root,
  }),
  delegated: new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
      new xdr.SorobanAddressCredentialsWithDelegates({ addressCredentials: credentials(), delegates: [] }),
    ),
    rootInvocation: root,
  }),
});

/** The signature verifies over the V2 preimage, which binds the signing address (CAP-71). */
function expectAddressBoundSignature(signed: xdr.SorobanAuthorizationEntry, root: xdr.SorobanAuthorizedInvocation) {
  if (signed.credentials.type !== 'sorobanCredentialsAddressV2') throw new Error('Expected V2 credentials');
  const creds = signed.credentials.addressV2;
  expect(creds.signatureExpirationLedger).toBe(expirationLedger);
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
    new xdr.HashIdPreimageSorobanAuthorizationWithAddress({
      networkId: hash(new TextEncoder().encode(passphrase)), nonce: 9n, signatureExpirationLedger: expirationLedger,
      address: Address.fromString(key.publicKey()).toScAddress(), invocation: root,
    }),
  );
  const [signature] = scValToNative(creds.signature) as { public_key: Uint8Array; signature: Uint8Array }[];
  expect(key.verify(Buffer.from(hash(preimage.toXdr())), Buffer.from(signature!.signature))).toBe(true);
}

describe('native credential kinds', () => {
  it('identifies the signing account of legacy and V2 entries only', () => {
    const { legacy, v2, delegated } = entries(invocation(registry, 'disable', []));
    expect(signingAddress(legacy)).toBe(key.publicKey());
    expect(signingAddress(v2)).toBe(key.publicKey());
    expect(signingAddress(delegated)).toBeUndefined();
    const source = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: legacy.rootInvocation,
    });
    expect(signingAddress(source)).toBeUndefined();
  });

  it('signs agent registry entries of either kind and refuses delegation', async () => {
    const args = { agent_id: 1n, expected_revision: 1n };
    const root = invocation(registry, 'disable', encodeRegistryArgs('disable', args));
    const { legacy, v2, delegated } = entries(root);
    const input = {
      contractId: registry, method: 'disable' as const, args, address: key.publicKey(), networkPassphrase: passphrase,
      latestLedger, expirationLedger, signer: key,
    };
    await expect(signRegistryAuthorization({ ...input, entry: legacy })).resolves.toBeDefined();
    expectAddressBoundSignature(await signRegistryAuthorization({ ...input, entry: v2 }), root);
    await expect(signRegistryAuthorization({ ...input, entry: delegated })).rejects.toThrow('signing account');
  });

  it('signs verification registry entries of either kind and refuses delegation', async () => {
    const args = { agent_id: 1n, revision: 1n, provider: key.publicKey(), sequence: 1n };
    const root = invocation(registry, 'revoke', encodeVerificationArgs('revoke', args));
    const { v2, delegated } = entries(root);
    const input = {
      contractId: registry, method: 'revoke' as const, args, address: key.publicKey(), networkPassphrase: passphrase,
      latestLedger, expirationLedger, signer: key,
    };
    expectAddressBoundSignature(await signVerificationAuthorization({ ...input, entry: v2 }), root);
    await expect(signVerificationAuthorization({ ...input, entry: delegated })).rejects.toThrow('signing account');
  });

  it('signs wallet action entries of either kind and refuses delegation', async () => {
    const root = invocation(action.wallet, 'execute', [encodeAction(action)]);
    const { legacy, v2, delegated } = entries(root);
    const input = {
      request: action, agentAddress: key.publicKey(), networkPassphrase: passphrase, latestLedger, expirationLedger,
      signer: key,
    };
    await expect(signActionAuthorization({ ...input, entry: legacy })).resolves.toBeDefined();
    expectAddressBoundSignature(await signActionAuthorization({ ...input, entry: v2 }), root);
    await expect(signActionAuthorization({ ...input, entry: delegated })).rejects.toThrow('agent account');
  });

  it('signs wallet owner and funding entries of either kind and refuses delegation', async () => {
    const wallet = contract(71);
    const asset = contract(72);
    const window = { networkPassphrase: passphrase, latestLedger, expirationLedger, signer: key };

    const ownerArgs = { policy_hash: new Uint8Array(32).fill(3) };
    const ownerRoot = invocation(wallet, 'revoke_policy', encodeWalletArgs('revoke_policy', ownerArgs));
    const owner = entries(ownerRoot);
    const ownerInput = {
      contractId: wallet, method: 'revoke_policy' as const, args: ownerArgs, address: key.publicKey(), ...window,
    };
    expectAddressBoundSignature(await signWalletAuthorization({ ...ownerInput, entry: owner.v2 }), ownerRoot);
    await expect(signWalletAuthorization({ ...ownerInput, entry: owner.delegated })).rejects.toThrow('signing account');

    const fundArgs = { from: key.publicKey(), asset, amount: 5n };
    const encoded = encodeWalletArgs('fund', fundArgs);
    const fundRoot = invocation(wallet, 'fund', encoded, [invocation(asset, 'transfer', [
      Address.fromString(key.publicKey()).toScVal(), Address.fromString(wallet).toScVal(), encoded[2]!,
    ])]);
    const funding = entries(fundRoot);
    const fundInput = { contractId: wallet, args: fundArgs, ...window };
    await expect(signFundingAuthorization({ ...fundInput, entry: funding.legacy })).resolves.toBeDefined();
    expectAddressBoundSignature(await signFundingAuthorization({ ...fundInput, entry: funding.v2 }), fundRoot);
    await expect(signFundingAuthorization({ ...fundInput, entry: funding.delegated })).rejects.toThrow('funding account');
  });
});
