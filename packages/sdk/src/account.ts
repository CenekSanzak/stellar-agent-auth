import { Address, Contract, Keypair, StrKey, authorizeEntry, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { assertAuthWindow } from './actions.js';
import { signingAddress } from './credentials.js';
import { encodeAccountSignature } from './encoding.js';
import type { Signer } from './signers.js';
import { SERVICE_PAYMENT_METHOD, type Action, type Hash32, type ServiceRule } from './types.js';

/**
 * The wallet's account path. `execute` covers payments the agent pushes. A payment that is pulled works the other
 * way round: someone else transfers from the payer, and the payer must authorize that transfer. The wallet does so
 * as a custom account, under the same policies and the same budgets as `execute`. It authorizes two shapes:
 *
 * - a plain `asset.transfer(wallet, recipient, amount)`. Whoever holds the signed entry can make exactly that
 *   transfer; an x402 `exact` payment on Stellar has this shape;
 * - a service payment, when `service` is given: `service.pay_for_service(wallet, asset, recipient, amount,
 *   service_id)` with the transfer inside it. The entry is rooted at the service call, so the payment cannot be
 *   taken without the service running. The policy must permit that service.
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
  /** Pay this service in its own call, instead of a plain transfer. */
  service?: ServiceRule;
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
  const { service } = payment;
  if (service && (!StrKey.isValidContract(service.contract) || service.contract === payment.wallet
    || !(service.service_id instanceof Uint8Array) || service.service_id.length !== 32)) {
    throw new Error('Expected a service contract other than the wallet and a 32-byte service ID');
  }
  const wallet = Address.fromString(payment.wallet).toScVal();
  const recipient = Address.fromString(payment.recipient).toScVal();
  const amount = nativeToScVal(payment.amount, { type: 'i128' });
  return {
    transfer: [wallet, recipient, amount],
    service: service && [wallet, Address.fromString(payment.asset).toScVal(), recipient, amount,
      xdr.ScVal.scvBytes(service.service_id)],
  };
}

/** The payment as the wallet's `check_payment` and its audit entries describe it. */
export function accountPaymentAction(payment: AccountPayment): Action {
  validated(payment);
  const transfer = { asset: payment.asset, recipient: payment.recipient, amount: payment.amount };
  return payment.service ? { kind: 'ServicePayment', service: payment.service, payment: transfer }
    : { kind: 'Transfer', transfer };
}

/**
 * The call that makes the payment: the plain `asset.transfer(wallet, recipient, amount)`, or the service's
 * `pay_for_service` when the payment names a service. Anyone may submit it; the wallet's entry authorizes it.
 */
export function accountPaymentOperation(payment: AccountPayment): xdr.Operation {
  const args = validated(payment);
  return payment.service && args.service
    ? new Contract(payment.service.contract).call(SERVICE_PAYMENT_METHOD, ...args.service)
    : new Contract(payment.asset).call('transfer', ...args.transfer);
}

function isCall(invocation: xdr.SorobanAuthorizedInvocation, contract: string, method: string, args: xdr.ScVal[]) {
  const fn = invocation.function;
  if (fn.type !== 'sorobanAuthorizedFunctionTypeContractFn') return false;
  const call = fn.contractFn;
  return Address.fromScAddress(call.contractAddress).toString() === contract
    && call.functionName.toString() === method && call.args.length === args.length
    && call.args.every((arg, i) => arg.toXdr('hex') === args[i]!.toXdr('hex'));
}

/**
 * Throws unless `root` is exactly what the payment asks the wallet to authorize: the transfer alone, or the
 * service call with that transfer as its only child. Nothing else may hang below either.
 */
export function assertAccountPaymentTree(root: xdr.SorobanAuthorizedInvocation, payment: AccountPayment): void {
  const args = validated(payment);
  const transfer = payment.service ? root.subInvocations[0] : root;
  if (!transfer || transfer.subInvocations.length !== 0
    || root.subInvocations.length !== (payment.service ? 1 : 0)) {
    throw new Error(payment.service ? 'Expected a service call with a single asset transfer below it'
      : 'Expected a single asset transfer invocation');
  }
  if (!isCall(transfer, payment.asset, 'transfer', args.transfer)
    || (payment.service && args.service
      && !isCall(root, payment.service.contract, SERVICE_PAYMENT_METHOD, args.service))) {
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
 * entry must be the wallet's own credential for exactly the payment's transfer, or its service call with that
 * transfer inside. The agent key signs the host payload followed by the policy hash, and the signature is checked against the agent's address
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
