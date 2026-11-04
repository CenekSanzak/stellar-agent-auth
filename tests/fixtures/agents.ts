import { hash } from '@stellar/stellar-sdk';

const encoder = new TextEncoder();
const base = 'https://example.test/agents/';

/** Public example agent metadata. It states its test purpose and contains no secrets or keys. */
export function exampleMetadata(version: number) {
  const document = encoder.encode(JSON.stringify({
    name: 'stellar-agent-auth example agent',
    purpose: 'Public test fixture for agent registry tests; not a live agent and holds no secrets.',
    version,
  }));
  return { uri: `${base}example-v${version}.json`, document, hash: Uint8Array.from(hash(document)) };
}

/** A valid metadata URI of exactly `length` bytes. */
export const metadataUriOfLength = (length: number) => base + 'a'.repeat(length - base.length);
