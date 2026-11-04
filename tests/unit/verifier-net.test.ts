import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  FetchRejected, METADATA_LIMITS, isPublicAddress, readCapped, safeFetch, validateTarget,
  type FetchRejection, type Resolver, type Transport, type TransportRequest, type TransportResponse,
} from '../../services/verifier/src/net.js';

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:4700::1111';

describe('isPublicAddress', () => {
  it.each<[string, boolean]>([
    ['8.8.8.8', true],
    [PUBLIC_V4, true],
    ['0.0.0.0', false],
    ['0.255.255.255', false],
    ['1.0.0.0', true],
    ['9.255.255.255', true],
    ['10.0.0.0', false],
    ['10.255.255.255', false],
    ['11.0.0.0', true],
    ['100.63.255.255', true],
    ['100.64.0.0', false],
    ['100.127.255.255', false],
    ['100.128.0.0', true],
    ['126.255.255.255', true],
    ['127.0.0.1', false],
    ['128.0.0.0', true],
    ['169.253.255.255', true],
    ['169.254.169.254', false],
    ['169.255.0.0', true],
    ['172.15.255.255', true],
    ['172.16.0.0', false],
    ['172.31.255.255', false],
    ['172.32.0.0', true],
    ['192.0.0.1', false],
    ['192.0.1.0', true],
    ['192.0.2.1', false],
    ['192.88.99.1', false],
    ['192.167.255.255', true],
    ['192.168.1.1', false],
    ['192.169.0.0', true],
    ['198.17.255.255', true],
    ['198.18.0.0', false],
    ['198.19.255.255', false],
    ['198.20.0.0', true],
    ['198.51.100.7', false],
    ['203.0.113.9', false],
    ['223.255.255.255', true],
    ['224.0.0.1', false],
    ['239.255.255.255', false],
    ['240.0.0.1', false],
    ['255.255.255.255', false],
    [PUBLIC_V6, true],
    ['2a00:1450:4001:80b::200e', true],
    ['::1', false],
    ['::', false],
    ['fe80::1', false],
    ['fc00::1', false],
    ['fd12::1', false],
    ['ff02::1', false],
    ['2001:db8::1', false],
    ['2002::1', false],
    ['2001::1', false],
    ['2001:1ff:ffff::1', false],
    ['2001:200::1', true],
    ['3fff::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:8.8.8.8', true],
    ['::ffff:7f00:1', false],
    ['::ffff:808:808', true],
    ['::ffff:10.0.0.1', false],
    ['64:ff9b::808:808', false],
    ['::127.0.0.1', false],
    ['fe80::1%lo0', false],
    ['2606:4700::1111%eth0', false],
    ['', false],
    ['localhost', false],
    ['example.com', false],
    ['1.2.3', false],
    ['01.2.3.4', false],
    ['1.2.3.256', false],
    ['[2606:4700::1111]', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

function rejection(run: () => unknown): FetchRejection | 'ok' {
  try {
    run();
    return 'ok';
  } catch (error) {
    if (error instanceof FetchRejected) return error.reason;
    throw error;
  }
}

async function rejected(promise: Promise<unknown>): Promise<FetchRejection | 'ok'> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    if (error instanceof FetchRejected) return error.reason;
    throw error;
  }
}

describe('validateTarget', () => {
  it.each<[string, FetchRejection | 'ok']>([
    ['https://agent.example/metadata.json', 'ok'],
    ['https://agent.example:443/metadata.json', 'ok'],
    ['https://agent.example/a.json?v=1#frag', 'ok'],
    [`https://${PUBLIC_V4}/a.json`, 'ok'],
    [`https://[${PUBLIC_V6}]/a.json`, 'ok'],
    ['http://agent.example/a.json', 'url'],
    ['ftp://agent.example/a.json', 'url'],
    ['file:///etc/passwd', 'url'],
    ['https://user:pass@agent.example/a.json', 'url'],
    ['https://user@agent.example/a.json', 'url'],
    ['https://agent.example:8443/a.json', 'url'],
    ['https://agent.example:80/a.json', 'url'],
    ['not a url', 'url'],
    ['https://127.0.0.1/a.json', 'private-address'],
    ['https://0x7f.1/a.json', 'private-address'],
    ['https://2130706433/a.json', 'private-address'],
    ['https://[::1]/a.json', 'private-address'],
    ['https://[::ffff:169.254.169.254]/a.json', 'private-address'],
    ['https://169.254.169.254/latest/meta-data', 'private-address'],
  ])('%s → %s', (url, expected) => {
    expect(rejection(() => validateTarget(url))).toBe(expected);
  });

  it('normalises an explicit default port away', () => {
    expect(validateTarget('https://agent.example:443/a').port).toBe('');
  });
});

const ok = (body = '{}', status = 200): TransportResponse => ({
  status, location: undefined, contentType: 'application/json', body: new TextEncoder().encode(body),
  tls: { protocol: 'TLSv1.3', authorized: true },
});
const redirect = (location: string | undefined, status = 302): TransportResponse => ({
  ...ok('', status), location,
});

/** Replays `responses` in order and records each request. */
function scripted(responses: TransportResponse[]) {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    calls.push(request);
    const next = responses.shift();
    if (!next) throw new Error('Unexpected request');
    return next;
  };
  return { transport, calls };
}

function resolverOf(table: Record<string, string[]>) {
  const lookups: string[] = [];
  const resolver: Resolver = async (host) => {
    lookups.push(host);
    return (table[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { resolver, lookups };
}

describe('safeFetch', () => {
  const dns = { 'agent.example': [PUBLIC_V4], 'cdn.example': [PUBLIC_V6], 'internal.example': ['10.0.0.5'] };

  it('connects to the vetted address and returns the response', async () => {
    const { resolver } = resolverOf(dns);
    const { transport, calls } = scripted([ok('{"a":1}')]);
    const response = await safeFetch('https://agent.example/a.json', { resolver, transport });
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe('{"a":1}');
    expect(response.redirects).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ address: PUBLIC_V4, family: 4, method: 'GET', maxBytes: METADATA_LIMITS.maxBytes });
    expect(calls[0]!.url.href).toBe('https://agent.example/a.json');
  });

  it('skips DNS for a public IP literal', async () => {
    const { resolver, lookups } = resolverOf({});
    const { transport, calls } = scripted([ok()]);
    await safeFetch(`https://[${PUBLIC_V6}]/a.json`, { resolver, transport, method: 'HEAD' });
    expect(lookups).toEqual([]);
    expect(calls[0]).toMatchObject({ address: PUBLIC_V6, family: 6, method: 'HEAD' });
  });

  it('rejects a DNS answer containing any non-public address', async () => {
    const { resolver } = resolverOf({ 'mixed.example': [PUBLIC_V4, '127.0.0.1'] });
    const { transport, calls } = scripted([ok()]);
    expect(await rejected(safeFetch('https://mixed.example/', { resolver, transport }))).toBe('private-address');
    expect(calls).toEqual([]);
  });

  it('rejects an empty or failed DNS answer', async () => {
    const { resolver } = resolverOf({});
    const { transport } = scripted([]);
    expect(await rejected(safeFetch('https://missing.example/', { resolver, transport }))).toBe('dns');
    const failing: Resolver = async () => { throw new Error('ENOTFOUND'); };
    expect(await rejected(safeFetch('https://missing.example/', { resolver: failing, transport }))).toBe('dns');
  });

  it('returns non-redirect error statuses to the caller', async () => {
    const { resolver } = resolverOf(dns);
    const { transport } = scripted([ok('gone', 404)]);
    expect((await safeFetch('https://agent.example/', { resolver, transport })).status).toBe(404);
  });

  it('follows and re-validates a redirect chain, resolving relative locations', async () => {
    const { resolver, lookups } = resolverOf(dns);
    const { transport, calls } = scripted([
      redirect('https://cdn.example/v1/a.json', 301),
      redirect('../v2/b.json?x=1', 307),
      ok('{}'),
    ]);
    const response = await safeFetch('https://agent.example/start', { resolver, transport });
    expect(response.url.href).toBe('https://cdn.example/v2/b.json?x=1');
    expect(response.redirects).toEqual(['https://cdn.example/v1/a.json', 'https://cdn.example/v2/b.json?x=1']);
    expect(lookups).toEqual(['agent.example', 'cdn.example', 'cdn.example']);
    expect(calls.map(({ address }) => address)).toEqual([PUBLIC_V4, PUBLIC_V6, PUBLIC_V6]);
  });

  it.each<[string, string, FetchRejection]>([
    ['http downgrade', 'http://agent.example/a.json', 'url'],
    ['non-default port', 'https://agent.example:8443/a.json', 'url'],
    ['credentials', 'https://u:p@agent.example/a.json', 'url'],
    ['private IP literal', 'https://169.254.169.254/latest', 'private-address'],
    ['loopback IPv6 literal', 'https://[::1]/a.json', 'private-address'],
    ['host resolving privately', 'https://internal.example/a.json', 'private-address'],
  ])('rejects a redirect to a %s', async (_, location, reason) => {
    const { resolver } = resolverOf(dns);
    const { transport, calls } = scripted([redirect(location), ok()]);
    expect(await rejected(safeFetch('https://agent.example/', { resolver, transport }))).toBe(reason);
    expect(calls).toHaveLength(1);
  });

  it('limits the number of redirects', async () => {
    const { resolver } = resolverOf(dns);
    const hops = ['/1', '/2', '/3', '/4'].map((path) => redirect(path));
    const { transport, calls } = scripted([...hops, ok()]);
    expect(await rejected(safeFetch('https://agent.example/', { resolver, transport }))).toBe('redirect');
    expect(calls).toHaveLength(4);

    const exact = scripted([...['/1', '/2', '/3'].map((path) => redirect(path)), ok()]);
    const response = await safeFetch('https://agent.example/', { resolver, transport: exact.transport });
    expect(response.redirects).toHaveLength(3);
  });

  it('rejects a redirect without Location', async () => {
    const { resolver } = resolverOf(dns);
    const { transport } = scripted([redirect(undefined, 308)]);
    expect(await rejected(safeFetch('https://agent.example/', { resolver, transport }))).toBe('redirect');
  });

  it('rejects a host that rebinds to a private address on a later lookup', async () => {
    const answers = [[PUBLIC_V4], ['127.0.0.1']];
    const resolver: Resolver = async () => (answers.shift() ?? []).map((address) => ({ address, family: 4 }));
    const { transport, calls } = scripted([redirect('/again'), ok()]);
    expect(await rejected(safeFetch('https://rebind.example/', { resolver, transport }))).toBe('private-address');
    expect(calls.map(({ address }) => address)).toEqual([PUBLIC_V4]);
  });

  it('applies one deadline across all hops', async () => {
    const { resolver } = resolverOf(dns);
    let hops = 0;
    const transport: Transport = (request) => {
      hops += 1;
      if (hops < 3) {
        return new Promise((resolve) => setTimeout(() => resolve(redirect(`/hop${hops}`)), 30));
      }
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)));
    };
    const limits = { ...METADATA_LIMITS, timeoutMs: 100 };
    const started = Date.now();
    expect(await rejected(safeFetch('https://agent.example/', { resolver, transport, limits }))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hops).toBe(3);
  });

  it('times out a transport that ignores the signal', async () => {
    const { resolver } = resolverOf(dns);
    const transport: Transport = () => new Promise(() => undefined);
    const limits = { ...METADATA_LIMITS, timeoutMs: 50 };
    expect(await rejected(safeFetch('https://agent.example/', { resolver, transport, limits }))).toBe('timeout');
  });

  it('times out a hanging DNS lookup', async () => {
    const resolver: Resolver = () => new Promise(() => undefined);
    const { transport } = scripted([]);
    const limits = { ...METADATA_LIMITS, timeoutMs: 50 };
    expect(await rejected(safeFetch('https://agent.example/', { resolver, transport, limits }))).toBe('timeout');
  });

  it('honours a caller abort', async () => {
    const { resolver } = resolverOf(dns);
    const { transport, calls } = scripted([ok()]);
    const controller = new AbortController();
    controller.abort();
    expect(await rejected(safeFetch('https://agent.example/', { resolver, transport, signal: controller.signal })))
      .toBe('timeout');
    expect(calls).toEqual([]);
  });

  it('maps unexpected transport failures to network and keeps transport rejections', async () => {
    const { resolver } = resolverOf(dns);
    const failing: Transport = async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); };
    expect(await rejected(safeFetch('https://agent.example/', { resolver, transport: failing }))).toBe('network');
    const tls: Transport = async () => { throw new FetchRejected('tls', 'bad certificate'); };
    expect(await rejected(safeFetch('https://agent.example/', { resolver, transport: tls }))).toBe('tls');
  });
});

describe('readCapped', () => {
  const chunks = (...parts: (string | Uint8Array)[]) => Readable.from(parts, { objectMode: true });

  it('accepts a body of exactly the limit', async () => {
    const body = await readCapped(chunks(new Uint8Array(6).fill(1), new Uint8Array(4).fill(2)), 10);
    expect(Array.from(body)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it('rejects one byte over the limit', async () => {
    expect(await rejected(readCapped(chunks(new Uint8Array(6), new Uint8Array(5)), 10))).toBe('too-large');
  });

  it('counts string chunks as UTF-8 bytes', async () => {
    expect(new TextDecoder().decode(await readCapped(chunks('ab', 'é'), 4))).toBe('abé');
    expect(await rejected(readCapped(chunks('abc', 'é'), 4))).toBe('too-large');
  });

  it('accepts an empty body', async () => {
    expect((await readCapped(chunks(), 0)).length).toBe(0);
  });
});
