import { Networks } from '@stellar/stellar-sdk';

/**
 * x402 names a network by its CAIP-2 identifier. The x402 Stellar packages know `stellar:testnet` and
 * `stellar:pubnet`. A local standalone network has no registered identifier; `stellar:standalone` is this
 * project's own name for it, understood by the facilitator in this package and by nothing published.
 */
export type StellarNetwork = `stellar:${string}`;

export const STELLAR_TESTNET: StellarNetwork = 'stellar:testnet';
export const STELLAR_PUBNET: StellarNetwork = 'stellar:pubnet';
export const STELLAR_LOCAL: StellarNetwork = 'stellar:standalone';

const BY_PASSPHRASE: ReadonlyMap<string, StellarNetwork> = new Map([
  [Networks.TESTNET, STELLAR_TESTNET], [Networks.PUBLIC, STELLAR_PUBNET], [Networks.STANDALONE, STELLAR_LOCAL],
]);

/** The x402 network identifier for a network passphrase. */
export function x402Network(networkPassphrase: string): StellarNetwork {
  const network = BY_PASSPHRASE.get(networkPassphrase);
  if (!network) throw new Error('No x402 network identifier for this network passphrase');
  return network;
}
