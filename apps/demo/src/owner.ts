import { Keypair } from '@stellar/stellar-sdk';
import { keypairSigner, walletAdapterSigner, type Signer, type WalletAdapter } from '@stellar-agent-auth/sdk';
import { networkProblem } from './model.js';

/**
 * The owner's signing capability. The page never asks for a secret key.
 *
 * - **Freighter**: the owner's own browser wallet. The page sees an address and signatures, and checks that the
 *   wallet is on the deployment's network before using it.
 * - **A local demo key**, on the local network only: a key generated in this tab, so the demo can be tried without a
 *   wallet configured for a private network. It is kept in the tab's session storage and is worth nothing anywhere
 *   else. It is never offered on Testnet.
 */

export interface Owner {
  kind: 'freighter' | 'local';
  address: string;
  signer: Signer;
}

const STORAGE_KEY = 'stellar-agent-auth-demo-owner';

function unwrap<T extends { error?: unknown }>(answer: T, what: string): T {
  if (answer.error) {
    const error = answer.error as { message?: string };
    throw new Error(`${what}: ${error.message ?? String(answer.error)}`);
  }
  return answer;
}

export async function connectFreighter(passphrase: string): Promise<Owner> {
  const freighter = await import('@stellar/freighter-api');
  const connected = await freighter.isConnected();
  if (connected.error || !connected.isConnected) {
    throw new Error('Freighter was not found. Install the Freighter extension, or use a local demo key on the local network.');
  }
  const { address } = unwrap(await freighter.requestAccess(), 'Freighter did not grant access');
  const details = unwrap(await freighter.getNetworkDetails(), 'Freighter did not report its network');
  const problem = networkProblem(passphrase, details.networkPassphrase);
  if (problem) throw new Error(problem);
  const adapter: WalletAdapter = {
    async signTransaction(xdr, options) {
      return unwrap(await freighter.signTransaction(xdr, options), 'Freighter did not sign');
    },
    async signAuthEntry(entry, options) {
      const answer = unwrap(await freighter.signAuthEntry(entry, options), 'Freighter did not sign');
      if (answer.signedAuthEntry === null) throw new Error('Freighter returned no signature');
      return { signedAuthEntry: answer.signedAuthEntry, signerAddress: answer.signerAddress };
    },
  };
  return { kind: 'freighter', address, signer: walletAdapterSigner(adapter, address, passphrase) };
}

/** The tab's demo key, created on first use. Refused anywhere but the local network. */
export function connectLocalKey(network: string, storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage): Owner {
  if (network !== 'local') throw new Error('A demo key is offered on the local network only');
  let keypair: Keypair;
  const stored = storage.getItem(STORAGE_KEY);
  try {
    keypair = stored ? Keypair.fromSecret(stored) : Keypair.random();
  } catch {
    keypair = Keypair.random();
  }
  storage.setItem(STORAGE_KEY, keypair.secret());
  return { kind: 'local', address: keypair.publicKey(), signer: keypairSigner(keypair) };
}
