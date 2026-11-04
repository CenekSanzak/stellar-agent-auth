import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';

/**
 * SSRF-safe HTTPS retrieval for agent-supplied URLs. Every hop is HTTPS on the default port, every resolved
 * address must be globally routable, and the connection is pinned to the vetted address so a second DNS answer
 * cannot redirect it (DNS rebinding). TLS verification is always on. Nothing fetched is executed.
 */

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export const METADATA_LIMITS: FetchLimits = { maxBytes: 65_536, timeoutMs: 10_000, maxRedirects: 3 };
export const ENDPOINT_LIMITS: FetchLimits = { maxBytes: 16_384, timeoutMs: 10_000, maxRedirects: 3 };

export type FetchRejection =
  | 'url' | 'private-address' | 'dns' | 'redirect' | 'too-large' | 'timeout' | 'tls' | 'network' | 'status';

export class FetchRejected extends Error {
  override readonly name = 'FetchRejected';
  readonly reason: FetchRejection;
  constructor(reason: FetchRejection, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** IPv4 special-purpose ranges (RFC 6890 and successors) that are never fetched. */
const PRIVATE_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4Number(ip: string) {
  return ip.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}

const PRIVATE_V4_RANGES = PRIVATE_V4.map(([base, bits]) => {
  const size = 2 ** (32 - bits);
  const start = v4Number(base);
  return [start, start + size - 1] as const;
});

function isPublicV4(ip: string) {
  const value = v4Number(ip);
  return !PRIVATE_V4_RANGES.some(([start, end]) => value >= start && value <= end);
}

/** Eight 16-bit groups of a valid IPv6 literal without zone ID, including an embedded dotted IPv4 tail. */
function v6Groups(ip: string): number[] {
  let text = ip.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    const value = v4Number(dotted);
    text = `${text.slice(0, -dotted.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const parse = (part: string) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** Only globally routable unicast addresses; IPv4-mapped IPv6 is judged by its embedded IPv4 address. */
export function isPublicAddress(ip: string): boolean {
  if (typeof ip !== 'string' || ip.includes('%')) return false;
  const version = isIP(ip);
  if (version === 4) return isPublicV4(ip);
  if (version !== 6) return false;
  const g = v6Groups(ip);
  if (g.length !== 8) return false;
  if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff) {
    return isPublicV4(`${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`);
  }
  const [first = 0, second = 0] = g;
  if ((first & 0xe000) !== 0x2000) return false; // Outside global unicast 2000::/3.
  if (first === 0x2001 && second < 0x0200) return false; // 2001::/23 IETF protocol assignments, incl. Teredo.
  if (first === 0x2001 && second === 0x0db8) return false; // Documentation.
  if (first === 0x2002) return false; // 6to4 can tunnel to any IPv4 address.
  if ((first & 0xfff0) === 0x3ff0) return false; // 3fff::/20 documentation (RFC 9637).
  return true;
}

const unbracket = (hostname: string) => hostname.replace(/^\[(.*)\]$/, '$1');

/**
 * Syntax and IP-literal checks only; never touches DNS. HTTPS, no credentials, the default port and a hostname are
 * required, and an IP-literal host must be public.
 */
export function validateTarget(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input.toString());
  } catch {
    throw new FetchRejected('url', 'URL does not parse');
  }
  if (url.protocol !== 'https:') throw new FetchRejected('url', 'URL must use https');
  if (url.username || url.password) throw new FetchRejected('url', 'URL must not contain credentials');
  if (url.port !== '') throw new FetchRejected('url', 'URL must use the default HTTPS port');
  const host = unbracket(url.hostname);
  if (!host) throw new FetchRejected('url', 'URL must name a host');
  if (isIP(host) && !isPublicAddress(host)) {
    throw new FetchRejected('private-address', `Refusing non-public address ${host}`);
  }
  return url;
}

export type Resolver = (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;

export const nodeResolver: Resolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.flatMap(({ address, family }) => (family === 4 || family === 6 ? [{ address, family }] : []));
};

export interface TlsInfo {
  protocol: string | null;
  authorized: boolean;
}

export interface TransportRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  method: 'GET' | 'HEAD';
  maxBytes: number;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  location: string | undefined;
  contentType: string | undefined;
  body: Uint8Array;
  tls: TlsInfo;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

const encoder = new TextEncoder();

/** Concatenate a body, failing as soon as it exceeds `maxBytes`. */
export async function readCapped(stream: AsyncIterable<Uint8Array | string>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    total += bytes.length;
    if (total > maxBytes) throw new FetchRejected('too-large', `Response body exceeds ${maxBytes} bytes`);
    chunks.push(bytes);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

const TLS_ERROR = /^(ERR_TLS|ERR_SSL|ERR_OSSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH)/;

function transportError(error: unknown, signal: AbortSignal): FetchRejected {
  if (error instanceof FetchRejected) return error;
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new FetchRejected('timeout', 'Request timed out');
  }
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string' && TLS_ERROR.test(code)) return new FetchRejected('tls', `TLS failure: ${code}`);
  return new FetchRejected('network', `Network failure: ${typeof code === 'string' ? code : message}`);
}

const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** node:https connected to exactly the vetted address, with certificate and hostname verification enabled. */
export const nodeTransport: Transport = ({ url, address, family, method, maxBytes, signal }) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const host = unbracket(url.hostname);
    const pinned = ((_hostname, options, callback) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    }) as LookupFunction;
    const req = httpsRequest({
      protocol: 'https:',
      hostname: host,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method,
      agent: false,
      lookup: pinned,
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: true,
      signal,
      headers: {
        accept: 'application/json, */*;q=0.1',
        'accept-encoding': 'identity',
        'user-agent': 'stellar-agent-auth-verifier/0.1',
      },
    }, (res) => {
      const socket = res.socket as TLSSocket;
      const tls = { protocol: socket.getProtocol?.() ?? null, authorized: socket.authorized === true };
      const length = Number(header(res.headers['content-length']));
      if (Number.isFinite(length) && length > maxBytes) {
        req.destroy();
        reject(new FetchRejected('too-large', `Declared body exceeds ${maxBytes} bytes`));
        return;
      }
      readCapped(res, maxBytes).then((body) => resolve({
        status: res.statusCode ?? 0,
        location: header(res.headers.location),
        contentType: header(res.headers['content-type']),
        body,
        tls,
      }), (error: unknown) => {
        req.destroy();
        reject(transportError(error, signal));
      });
    });
    req.on('error', (error) => reject(transportError(error, signal)));
    req.end();
  });

export interface SafeResponse {
  /** Final URL after redirects. */
  url: URL;
  status: number;
  contentType: string | undefined;
  body: Uint8Array;
  tls: TlsInfo;
  /** Each followed redirect target, in order. */
  redirects: readonly string[];
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD' | undefined;
  limits?: FetchLimits | undefined;
  resolver?: Resolver | undefined;
  transport?: Transport | undefined;
  signal?: AbortSignal | undefined;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

/** Resolve the host, require every answer to be public, and return the address to pin. */
async function vet(url: URL, resolver: Resolver, signal: AbortSignal) {
  const host = unbracket(url.hostname);
  const literal = isIP(host);
  if (literal === 4 || literal === 6) return { address: host, family: literal } as const;
  let answers: Awaited<ReturnType<Resolver>>;
  try {
    answers = await abortable(resolver(host), signal);
  } catch {
    if (signal.aborted) throw new FetchRejected('timeout', 'Request timed out');
    throw new FetchRejected('dns', `DNS lookup failed for ${host}`);
  }
  const first = answers[0];
  if (!first) throw new FetchRejected('dns', `No DNS answer for ${host}`);
  const blocked = answers.find(({ address }) => !isPublicAddress(address));
  if (blocked) throw new FetchRejected('private-address', `${host} resolves to non-public ${blocked.address}`);
  return first;
}

/**
 * GET or HEAD `input` under one deadline spanning every hop. Redirect targets are validated from scratch. Non-redirect
 * statuses are returned for the caller to judge.
 */
export async function safeFetch(input: string | URL, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const limits = options.limits ?? METADATA_LIMITS;
  const resolver = options.resolver ?? nodeResolver;
  const transport = options.transport ?? nodeTransport;
  const method = options.method ?? 'GET';
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  let url = validateTarget(input);
  const redirects: string[] = [];
  for (;;) {
    if (signal.aborted) throw new FetchRejected('timeout', 'Request timed out');
    const { address, family } = await vet(url, resolver, signal);
    let response: TransportResponse;
    try {
      response = await abortable(transport({ url, address, family, method, maxBytes: limits.maxBytes, signal }), signal);
    } catch (error) {
      throw transportError(error, signal);
    }
    if (!REDIRECTS.has(response.status)) {
      return {
        url, status: response.status, contentType: response.contentType, body: response.body, tls: response.tls,
        redirects,
      };
    }
    if (!response.location) throw new FetchRejected('redirect', `HTTP ${response.status} without Location`);
    if (redirects.length >= limits.maxRedirects) {
      throw new FetchRejected('redirect', `More than ${limits.maxRedirects} redirects`);
    }
    let next: URL;
    try {
      next = new URL(response.location, url);
    } catch {
      throw new FetchRejected('redirect', 'Redirect Location does not parse');
    }
    url = validateTarget(next);
    redirects.push(url.href);
  }
}
