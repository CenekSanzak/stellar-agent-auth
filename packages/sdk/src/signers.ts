import {
  FeeBumpTransaction, Keypair, StrKey, TransactionBuilder, hash, type SigningCallback, type Transaction, type xdr,
} from '@stellar/stellar-sdk';

/**
 * One account's signing capability. Every signer is checked after it signs: a transaction must come back with the
 * same hash and a valid signature from `address`, and an authorization signature must verify against `address`.
 * A wallet that alters what it was asked to sign therefore fails locally instead of authorizing something else.
 *
 * Headless agent and provider keys belong in a server-side process; the SDK never reads keys by default. The
 * browser owner path uses `walletAdapterSigner`.
 */
export interface Signer {
  readonly address: string;
  /** Adds this account's signature to `tx` and returns it; the transaction must not otherwise change. */
  signTransaction(tx: Transaction, networkPassphrase: string): Promise<Transaction>;
  /** The Ed25519 signature of `payload`, the SHA-256 of the authorization preimage. */
  signAuthEntry(preimage: xdr.HashIdPreimage, payload: Uint8Array): Promise<Uint8Array>;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

/** A signer over an in-memory key; for headless processes and tests. */
export function keypairSigner(keypair: Keypair): Signer {
  if (!keypair.canSign()) throw new Error('Keypair has no secret key');
  return {
    address: keypair.publicKey(),
    async signTransaction(tx) {
      tx.sign(keypair);
      return tx;
    },
    async signAuthEntry(_preimage, payload) {
      return keypair.sign(payload);
    },
  };
}

/**
 * A SEP-43 wallet interface, as implemented by browser wallets such as Freighter and by Stellar Wallets Kit. Only
 * the two signing methods are used, and their results are verified before use.
 */
export interface WalletAdapter {
  signTransaction(
    xdr: string, options: { networkPassphrase: string; address: string },
  ): Promise<{ signedTxXdr: string; signerAddress?: string }>;
  signAuthEntry(
    authEntry: string, options: { networkPassphrase: string; address: string },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string }>;
}

/**
 * Wrap a browser wallet for one standard account on one network. The wallet sees base64 XDR; its answers are
 * accepted only if the transaction hash is unchanged and every signature verifies against `address`.
 */
export function walletAdapterSigner(adapter: WalletAdapter, address: string, networkPassphrase: string): Signer {
  if (!StrKey.isValidEd25519PublicKey(address)) throw new Error('Expected a standard account address');
  const verifier = Keypair.fromPublicKey(address);
  const options = { networkPassphrase, address };
  return {
    address,
    async signTransaction(tx, passphrase) {
      if (passphrase !== networkPassphrase) throw new Error('Wallet is configured for a different network');
      const { signedTxXdr } = await adapter.signTransaction(tx.toXDR(), options);
      const signed = TransactionBuilder.fromXDR(signedTxXdr, passphrase);
      if (signed instanceof FeeBumpTransaction || toHex(signed.hash()) !== toHex(tx.hash())) {
        throw new Error('Wallet returned a different transaction');
      }
      const signature = signed.signatures.find((candidate) =>
        verifier.verify(tx.hash(), candidate.signature.value));
      if (!signature) throw new Error('Wallet returned no valid signature for the expected account');
      tx.addDecoratedSignature(signature);
      return tx;
    },
    async signAuthEntry(preimage, payload) {
      const { signedAuthEntry } = await adapter.signAuthEntry(preimage.toXdr('base64'), options);
      const signature = base64ToBytes(signedAuthEntry);
      if (signature.length !== 64 || !verifier.verify(payload, signature)) {
        throw new Error('Wallet returned an invalid authorization signature');
      }
      return signature;
    },
  };
}

/** The callback form `authorizeEntry` and the SDK's validating signers accept. */
export function authSigner(signer: Signer): SigningCallback {
  return async (preimage, payload) => {
    if (toHex(hash(preimage.toXdr())) !== toHex(payload)) throw new Error('Authorization payload mismatch');
    return { signature: await signer.signAuthEntry(preimage, payload), publicKey: signer.address };
  };
}

export { bytesToBase64 as toBase64, base64ToBytes as fromBase64 };
