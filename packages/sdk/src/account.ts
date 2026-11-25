import { Address, Contract, Keypair, StrKey, authorizeEntry, hash, nativeToScVal, type xdr } from '@stellar/stellar-sdk';
import { assertAuthWindow } from './actions.js';
import { signingAddress } from './credentials.js';
import { encodeAccountSignature } from './encoding.js';
import type { Signer } from './signers.js';
import type { Hash32 } from './types.js';

/**
 * The wallet's account path. `execute` covers payments the agent pushes. A service that pulls its payment instead
 * transfers from the payer inside its own call, and the payer must authorize that transfer; an x402 `exact` payment
 * on Stellar has this shape. The wallet authorizes such a transfer as a custom account, under the same policies and
 * the same budgets as `execute`.
 *
 * What the agent signs differs from `execute` in two ways the caller should know:
 * - it signs as a key. The signer account's own signers and thresholds are not consulted;
 * - there is no policy sequence or request deadline. The host nonce prevents replay, and the entry's expiry ledger
 *   bounds its life.
 *
 * A refusal on this path reaches the caller only as a host authorization failure, and a public RPC may not say why.
 * Call `readPaymentCheck` first: it returns the wallet's own error for the same payment.
 */

export interface AccountPayment {
  wallet: string;
  /** The policy the agent acts under; it is part of what the agent signs. */
  policyHash: Hash32;
  asset: string;
  recipient: string;
  /** Contract units; positive. */
  amount: bigint;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

function validated(payment: AccountPayment) {
  if (!StrKey.isValidContract(payment.wallet) || !StrKey.isValidContract(payment.asset)) {
    throw new Error('Expected wallet and asset contract addresses');
  }
  if (payment.recipient === payment.wallet) throw new Error('The wallet cannot pay itself');
  if (typeof payment.amount !== 'bigint' || payment.amount <= 0n || payment.amount > (1n << 127n) - 1n) {
    throw new Error('Expected a positive i128 amount in contract units');
  }
  if (!(payment.policyHash instanceof Uint8Array) || payment.policyHash.length !== 32) {
    throw new Error('Expected a 32-byte policy hash');
  }
  return [
    Address.fromString(payment.wallet).toScVal(), Address.fromString(payment.recipient).toScVal(),
    nativeToScVal(payment.amount, { type: 'i128' }),
  ];
}

/**
 * The plain `asset.transfer(wallet, recipient, amount)` the wallet authorizes. Any contract or relayer may make
 * this call; a service that pulls its payment makes the same transfer inside its own call.
 */
export function accountPaymentOperation(payment: AccountPayment): xdr.Operation {
  return new Contract(payment.asset).call('transfer', ...validated(payment));
}

/** Throws unless `root` is exactly `asset.transfer(wallet, recipient, amount)` with no child invocations. */
export function assertAccountPaymentTree(root: xdr.SorobanAuthorizedInvocation, payment: AccountPayment): void {
  const expected = validated(payment);
  const fn = root.function;
  if (root.subInvocations.length !== 0 || fn.type !== 'sorobanAuthorizedFunctionTypeContractFn') {
    throw new Error('Expected a single asset transfer invocation');
  }
  const call = fn.contractFn;
  if (Address.fromScAddress(call.contractAddress).toString() !== payment.asset
    || call.functionName.toString() !== 'transfer' || call.args.length !== expected.length
    || call.args.some((arg, i) => arg.toXdr('hex') !== expected[i]!.toXdr('hex'))) {
    throw new Error('Authorization invocation does not match the expected payment');
  }
}

interface AccountPaymentAuthorization {
  /** The recorded entry: the wallet's own credential for the transfer. */
  entry: xdr.SorobanAuthorizationEntry;
  payment: AccountPayment;
  /** The policy's agent signer; needs `signMessage`, so a headless key. */
  agent: Signer;
  networkPassphrase: string;
  latestLedger: number;
  expirationLedger: number;
}

/**
 * Inspect a recorded entry before giving the agent key any bytes, then sign it for the wallet's account path. The
 * entry must be the wallet's own credential for exactly `asset.transfer(wallet, recipient, amount)`. The agent key
 * signs the host payload followed by the policy hash, and the signature is checked against the agent's address
 * before it is used. The Stellar SDK builds the payload for whichever credential type was recorded.
 */
export async function signAccountPayment(input: AccountPaymentAuthorization): Promise<xdr.SorobanAuthorizationEntry> {
  const { entry, payment, agent, networkPassphrase, latestLedger, expirationLedger } = input;
  assertAuthWindow(latestLedger, expirationLedger);
  if (signingAddress(entry) !== payment.wallet) throw new Error('Expected the wallet\'s own authorization entry');
  assertAccountPaymentTree(entry.rootInvocation, payment);
  const sign = agent.signMessage?.bind(agent);
  if (!sign || !StrKey.isValidEd25519PublicKey(agent.address)) {
    throw new Error('The account path needs a headless agent key that can sign a message');
  }
  const verifier = Keypair.fromPublicKey(agent.address);
  return authorizeEntry(entry, async (preimage, payload) => {
    if (!sameBytes(hash(preimage.toXdr()), payload)) throw new Error('Authorization payload mismatch');
    const message = new Uint8Array(64);
    message.set(payload, 0);
    message.set(payment.policyHash, 32);
    const signature = await sign(message);
    if (signature.length !== 64 || !verifier.verify(message, signature)) {
      throw new Error('Agent key returned an invalid signature');
    }
    return { signatureScVal: encodeAccountSignature(payment.policyHash, signature) };
  }, expirationLedger, networkPassphrase, payment.wallet);
}
