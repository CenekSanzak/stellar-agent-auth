import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  AGENT_METADATA_SCHEMA, MetadataSchemaError, parseAgentMetadata, resolveMetadata,
} from '../../services/verifier/src/metadata.js';
import { FetchRejected, readCapped, type Resolver, type Transport } from '../../services/verifier/src/net.js';

const encoder = new TextEncoder();
const URI = 'https://agent.example/metadata.json';
const resolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const sha256 = (bytes: Uint8Array) => Uint8Array.from(createHash('sha256').update(bytes).digest());

const valid = {
  schema: AGENT_METADATA_SCHEMA,
  name: 'Example agent',
  description: 'Public test fixture.\nNot a live agent.',
  endpoints: [{ name: 'api', url: 'https://api.agent.example/v1' }],
};
const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value));

/** Serves `body` with `status`, reading it through `readCapped` like the real transport. */
function serving(body: Uint8Array, status = 200): Transport {
  return async ({ maxBytes }) => ({
    status, location: undefined, contentType: 'text/plain',
    body: await readCapped(Readable.from([body]), maxBytes),
    tls: { protocol: 'TLSv1.3', authorized: true },
  });
}

function schemaPath(bytes: Uint8Array): string | 'ok' {
  try {
    parseAgentMetadata(bytes);
    return 'ok';
  } catch (error) {
    if (error instanceof MetadataSchemaError) return error.path;
    throw error;
  }
}

const withRoot = (override: Record<string, unknown>) => bytesOf({ ...valid, ...override });
const withEndpoints = (...endpoints: unknown[]) => withRoot({ endpoints });

describe('parseAgentMetadata', () => {
  it('accepts the v1 document and omits an absent description', () => {
    expect(parseAgentMetadata(bytesOf(valid))).toEqual(valid);
    const minimal = { schema: AGENT_METADATA_SCHEMA, name: 'a', endpoints: [] };
    expect(parseAgentMetadata(bytesOf(minimal))).toEqual(minimal);
    expect(parseAgentMetadata(withRoot({ name: 'é'.repeat(128) })).name).toHaveLength(128);
  });

  it.each<[string, Uint8Array, string]>([
    ['unknown top-level key', withRoot({ extra: true }), '/extra'],
    ['__proto__ key', encoder.encode(`{"__proto__":{},${JSON.stringify(valid).slice(1)}`), '/__proto__'],
    ['wrong schema', withRoot({ schema: 'stellar-agent-auth/agent-metadata/v2' }), '/schema'],
    ['missing schema', bytesOf({ name: 'a', endpoints: [] }), '/schema'],
    ['empty name', withRoot({ name: '' }), '/name'],
    ['129-character name', withRoot({ name: 'a'.repeat(129) }), '/name'],
    ['non-string name', withRoot({ name: 7 }), '/name'],
    ['control character in name', withRoot({ name: 'a\u0007b' }), '/name'],
    ['C1 control in name', withRoot({ name: 'a\u0085b' }), '/name'],
    ['newline in name', withRoot({ name: 'a\nb' }), '/name'],
    ['tab in description', withRoot({ description: 'a\tb' }), '/description'],
    ['1,025-character description', withRoot({ description: 'a'.repeat(1_025) }), '/description'],
    ['missing endpoints', bytesOf({ schema: AGENT_METADATA_SCHEMA, name: 'a' }), '/endpoints'],
    ['five endpoints', withEndpoints(...[1, 2, 3, 4, 5].map((i) => ({ name: `e${i}`, url: `https://e${i}.example/` }))),
      '/endpoints'],
    ['duplicate endpoint URL', withEndpoints(
      { name: 'a', url: 'https://api.example/x' }, { name: 'b', url: 'https://API.example:443/x' },
    ), '/endpoints/1/url'],
    ['http endpoint', withEndpoints({ name: 'a', url: 'http://api.example/' }), '/endpoints/0/url'],
    ['private IP endpoint', withEndpoints({ name: 'a', url: 'https://10.1.2.3/' }), '/endpoints/0/url'],
    ['loopback IPv6 endpoint', withEndpoints({ name: 'a', url: 'https://[::1]/' }), '/endpoints/0/url'],
    ['endpoint with port', withEndpoints({ name: 'a', url: 'https://api.example:8443/' }), '/endpoints/0/url'],
    ['endpoint with credentials', withEndpoints({ name: 'a', url: 'https://u:p@api.example/' }), '/endpoints/0/url'],
    ['oversized endpoint URL', withEndpoints({ name: 'a', url: `https://api.example/${'a'.repeat(2_030)}` }),
      '/endpoints/0/url'],
    ['endpoint unknown key', withEndpoints({ name: 'a', url: 'https://api.example/', auth: 'x' }), '/endpoints/0/auth'],
    ['endpoint without name', withEndpoints({ url: 'https://api.example/' }), '/endpoints/0/name'],
    ['65-character endpoint name', withEndpoints({ name: 'a'.repeat(65), url: 'https://api.example/' }),
      '/endpoints/0/name'],
    ['endpoint not an object', withEndpoints('https://api.example/'), '/endpoints/0'],
    ['byte order mark', Uint8Array.from([0xef, 0xbb, 0xbf, ...bytesOf(valid)]), ''],
    ['invalid UTF-8', Uint8Array.from([0x7b, 0xff, 0x7d]), ''],
    ['invalid JSON', encoder.encode('{"schema":'), ''],
    ['array root', bytesOf([valid]), ''],
    ['string root', bytesOf('metadata'), ''],
    ['null root', encoder.encode('null'), ''],
  ])('rejects %s', (_, bytes, path) => {
    expect(schemaPath(bytes)).toBe(path);
  });

  it('accepts a 2,048-byte endpoint URL', () => {
    const url = `https://api.example/${'a'.repeat(2_048 - 'https://api.example/'.length)}`;
    expect(schemaPath(withEndpoints({ name: 'a', url }))).toBe('ok');
  });
});

describe('resolveMetadata', () => {
  it('verifies matching bytes and parses them', async () => {
    const bytes = bytesOf(valid);
    const result = await resolveMetadata({ metadata_uri: URI, metadata_hash: sha256(bytes) },
      { resolver, transport: serving(bytes) });
    expect(result).toEqual({
      status: 'verified', sha256: sha256(bytes), bytes: bytes.length, finalUrl: URI, document: valid,
    });
  });

  it('reports a hash mismatch without parsing the bytes', async () => {
    const bytes = encoder.encode('{not json');
    const result = await resolveMetadata({ metadata_uri: URI, metadata_hash: sha256(bytesOf(valid)) },
      { resolver, transport: serving(bytes) });
    expect(result).toEqual({ status: 'hash-mismatch', sha256: sha256(bytes), bytes: bytes.length, finalUrl: URI });
  });

  it('reports matching bytes that fail the schema', async () => {
    const bytes = withRoot({ extra: 1 });
    const result = await resolveMetadata({ metadata_uri: URI, metadata_hash: sha256(bytes) },
      { resolver, transport: serving(bytes) });
    expect(result).toMatchObject({ status: 'invalid', path: '/extra', bytes: bytes.length });
  });

  it('treats a non-2xx response as unavailable', async () => {
    const bytes = bytesOf(valid);
    const result = await resolveMetadata({ metadata_uri: URI, metadata_hash: sha256(bytes) },
      { resolver, transport: serving(bytes, 503) });
    expect(result).toEqual({ status: 'unavailable', reason: 'status', detail: 'HTTP 503' });
  });

  it('maps fetch rejections to unavailable', async () => {
    const hash = sha256(bytesOf(valid));
    expect(await resolveMetadata({ metadata_uri: 'http://agent.example/m.json', metadata_hash: hash }, { resolver }))
      .toMatchObject({ status: 'unavailable', reason: 'url' });
    const privateDns: Resolver = async () => [{ address: '192.168.0.10', family: 4 }];
    expect(await resolveMetadata({ metadata_uri: URI, metadata_hash: hash }, { resolver: privateDns }))
      .toMatchObject({ status: 'unavailable', reason: 'private-address' });
    const tls: Transport = async () => { throw new FetchRejected('tls', 'TLS failure: CERT_HAS_EXPIRED'); };
    expect(await resolveMetadata({ metadata_uri: URI, metadata_hash: hash }, { resolver, transport: tls }))
      .toEqual({ status: 'unavailable', reason: 'tls', detail: 'TLS failure: CERT_HAS_EXPIRED' });
  });

  it('accepts exactly 65,536 bytes and rejects 65,537', async () => {
    const exact = new Uint8Array(65_536).fill(0x20);
    const result = await resolveMetadata({ metadata_uri: URI, metadata_hash: sha256(exact) },
      { resolver, transport: serving(exact) });
    expect(result).toMatchObject({ status: 'invalid', bytes: 65_536 });
    const over = new Uint8Array(65_537).fill(0x20);
    expect(await resolveMetadata({ metadata_uri: URI, metadata_hash: sha256(over) },
      { resolver, transport: serving(over) })).toMatchObject({ status: 'unavailable', reason: 'too-large' });
  });

  it('requires a 32-byte registered hash', async () => {
    await expect(resolveMetadata({ metadata_uri: URI, metadata_hash: new Uint8Array(31) }, { resolver }))
      .rejects.toThrow('32-byte');
  });

  it('rethrows unexpected errors', async () => {
    const broken: Transport = async () => ({
      status: 200, location: undefined, contentType: undefined, body: null as unknown as Uint8Array,
      tls: { protocol: null, authorized: false },
    });
    await expect(resolveMetadata({ metadata_uri: URI, metadata_hash: sha256(bytesOf(valid)) },
      { resolver, transport: broken })).rejects.toThrow();
  });
});
