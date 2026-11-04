import { Address, type xdr } from '@stellar/stellar-sdk';

/**
 * The account an entry asks to sign, for native single-account credentials only: legacy `Address` credentials and
 * CAP-71 `AddressV2` credentials, which also bind the address into the signed payload. RPC versions differ in which
 * they record, and `authorizeEntry` builds the matching preimage for each. Source-account credentials need no
 * signature, and delegated credentials are outside the v1 signing model, so both return `undefined`.
 */
export function signingAddress(entry: xdr.SorobanAuthorizationEntry): string | undefined {
  const credentials = entry.credentials;
  switch (credentials.type) {
    case 'sorobanCredentialsAddress':
      return Address.fromScAddress(credentials.address.address).toString();
    case 'sorobanCredentialsAddressV2':
      return Address.fromScAddress(credentials.addressV2.address).toString();
    default:
      return undefined;
  }
}
