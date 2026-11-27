import { Keypair } from '@stellar/stellar-sdk';
import { keypairSigner, walletAdapterSigner, type Signer, type WalletAdapter } from '@stellar-agent-auth/sdk';
import { networkProblem } from './model.js';

/**
 * The owner's signing capability. The page never asks for a secret key.
 *
 * - **A guest key**: a key generated in this browser, so the demo can be tried without installing anything. It is
 *   kept in the browser's local storage, so the same guest returns to the same wallet. It is a test-network key
 *   that never leaves the browser, and it is worth nothing anywhere else.
 * - **Freighter**: the owner's own browser wallet. The page sees an address and signatures, and checks that the
 *   wallet is on the deployment's network before using it.
 * - **Other wallets**, through Stellar Wallets Kit: xBull, Albedo, Lobstr, Rabet, Hana and the others it knows.
 *
 * The owner only ever signs whole transactions that they are the source of, which every wallet can do.
 */

export type OwnerKind = 'guest' | 'freighter' | 'kit';

export interface Owner {
  kind: OwnerKind;
  /** How the connection is named to the owner: `Guest`, `Freighter`, or the wallet picked in the kit. */
  label: string;
  address: string;
  signer: Signer;
  disconnect?: () => Promise<void>;
}

const GUEST_KEY = 'scout-demo:guest';

function unwrap<T extends { error?: unknown }>(answer: T, what: string): T {
  if (answer.error) {
    const error = answer.error as { message?: string };
    throw new Error(`${what}: ${error.message ?? String(answer.error)}`);
  }
  return answer;
}

/** This browser's guest key for `passphrase`'s network, created on first use. */
export function connectGuest(passphrase: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): Owner {
  // One guest per network: a key made for a local network is not reused on a public test network.
  const slot = `${GUEST_KEY}:${passphrase}`;
  let keypair: Keypair;
  try {
    const stored = storage.getItem(slot);
    keypair = stored ? Keypair.fromSecret(stored) : Keypair.random();
  } catch {
    keypair = Keypair.random();
  }
  try {
    storage.setItem(slot, keypair.secret());
  } catch {
    // Storage is unavailable, as in some private windows: the guest lasts as long as the page does.
  }
  return { kind: 'guest', label: 'Guest', address: keypair.publicKey(), signer: keypairSigner(keypair) };
}

/** Forget this browser's guest. The wallet it created stays on the network, with nobody able to sign for it. */
export function forgetGuest(passphrase: string, storage: Pick<Storage, 'removeItem'> = localStorage) {
  try {
    storage.removeItem(`${GUEST_KEY}:${passphrase}`);
  } catch {
    // Nothing was stored.
  }
}

export async function connectFreighter(passphrase: string): Promise<Owner> {
  const freighter = await import('@stellar/freighter-api');
  const connected = await freighter.isConnected();
  if (connected.error || !connected.isConnected) {
    throw new Error('Freighter was not found in this browser. Install the extension, pick another wallet, or try as a guest.');
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
  return { kind: 'freighter', label: 'Freighter', address, signer: walletAdapterSigner(adapter, address, passphrase) };
}

/** The owner closed the wallet picker without choosing. Not an error, and not shown as one. */
export class ConnectCancelled extends Error {}

const kitMessage = (error: unknown) => (error instanceof Error ? error.message
  : typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message)
    : String(error));

/**
 * Let the owner pick any wallet Stellar Wallets Kit knows. The kit is loaded only when asked for: it is large, and
 * a guest never needs it.
 */
export async function connectWithKit(passphrase: string): Promise<Owner> {
  const [{ StellarWalletsKit }, { defaultModules }] = await Promise.all([
    import('@creit.tech/stellar-wallets-kit/sdk'), import('@creit.tech/stellar-wallets-kit/modules/utils'),
  ]);
  StellarWalletsKit.init({ modules: defaultModules(), network: passphrase as never });
  let address: string;
  try {
    ({ address } = await StellarWalletsKit.authModal());
  } catch (error) {
    const reason = kitMessage(error);
    if (/closed the modal/i.test(reason)) throw new ConnectCancelled();
    throw new Error(`No wallet was connected: ${reason}`);
  }
  // A wallet that can say which network it is on must be on this one. Some cannot say, and sign for whichever
  // network the request names; a signature made for another network is useless here.
  const reported = await StellarWalletsKit.getNetwork().then((network) => network.networkPassphrase, () => undefined);
  if (reported !== undefined) {
    const problem = networkProblem(passphrase, reported);
    if (problem) throw new Error(problem);
  }
  const label = StellarWalletsKit.selectedModule.productName;
  const adapter: WalletAdapter = {
    async signTransaction(xdr, options) {
      try {
        return await StellarWalletsKit.signTransaction(xdr, { networkPassphrase: options?.networkPassphrase ?? passphrase, address });
      } catch (error) {
        throw new Error(`${label} did not sign: ${kitMessage(error)}`);
      }
    },
    async signAuthEntry(entry, options) {
      try {
        return await StellarWalletsKit.signAuthEntry(entry, { networkPassphrase: options?.networkPassphrase ?? passphrase, address });
      } catch (error) {
        throw new Error(`${label} did not sign: ${kitMessage(error)}`);
      }
    },
  };
  return {
    kind: 'kit', label, address, signer: walletAdapterSigner(adapter, address, passphrase),
    disconnect: () => StellarWalletsKit.disconnect().catch(() => undefined),
  };
}
