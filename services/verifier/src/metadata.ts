import { createHash, timingSafeEqual } from 'node:crypto';
import {
  FetchRejected, METADATA_LIMITS, safeFetch, validateTarget,
  type FetchLimits, type FetchRejection, type Resolver, type Transport,
} from './net.js';

/** Registered agent metadata, fetched only from the registered URI and accepted only if its bytes match the hash. */

export const AGENT_METADATA_SCHEMA = 'stellar-agent-auth/agent-metadata/v1';
export const MAX_ENDPOINTS = 4;

export interface AgentEndpoint {
  name: string;
  url: string;
}

export interface AgentMetadataV1 {
  schema: typeof AGENT_METADATA_SCHEMA;
  name: string;
  description?: string;
  endpoints: readonly AgentEndpoint[];
}

export class MetadataSchemaError extends Error {
  override readonly name = 'MetadataSchemaError';
  /** JSON-pointer-like location of the offending value, such as `/endpoints/0/url`. */
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

const encoder = new TextEncoder();
// C0 controls, DEL and C1 controls.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

function plainObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new MetadataSchemaError(path, 'Expected an object');
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new MetadataSchemaError(`${path}/${key}`, `Unknown field ${key}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string, min: number, max: number, control = CONTROL): string {
  if (typeof value !== 'string') throw new MetadataSchemaError(path, 'Expected a string');
  const length = [...value].length;
  if (length < min || length > max) {
    throw new MetadataSchemaError(path, `Expected ${min}-${max} characters`);
  }
  if (control.test(value)) throw new MetadataSchemaError(path, 'Control characters are not allowed');
  return value;
}

function endpointUrl(value: unknown, path: string): { url: string; normalized: string } {
  if (typeof value !== 'string') throw new MetadataSchemaError(path, 'Expected a string');
  if (encoder.encode(value).length > 2_048) throw new MetadataSchemaError(path, 'URL exceeds 2,048 bytes');
  try {
    // Syntax and IP-literal checks only; DNS is resolved when the endpoint check runs.
    return { url: value, normalized: validateTarget(value).href };
  } catch (error) {
    if (error instanceof FetchRejected) throw new MetadataSchemaError(path, error.message);
    throw error;
  }
}

/** Strict v1 schema: UTF-8 without BOM, known fields only, bounded strings and HTTPS endpoints. */
export function parseAgentMetadata(bytes: Uint8Array): AgentMetadataV1 {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new MetadataSchemaError('', 'Metadata is not valid UTF-8');
  }
  if (source.startsWith('\uFEFF')) throw new MetadataSchemaError('', 'Metadata must not start with a byte order mark');
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw new MetadataSchemaError('', 'Metadata is not valid JSON');
  }
  const root = plainObject(json, '', ['schema', 'name', 'description', 'endpoints']);
  if (root['schema'] !== AGENT_METADATA_SCHEMA) {
    throw new MetadataSchemaError('/schema', `Expected schema ${AGENT_METADATA_SCHEMA}`);
  }
  const name = text(root['name'], '/name', 1, 128);
  const description = root['description'] === undefined
    ? undefined
    : text(root['description'], '/description', 0, 1_024, CONTROL_EXCEPT_NEWLINE);
  const list = root['endpoints'];
  if (!Array.isArray(list)) throw new MetadataSchemaError('/endpoints', 'Expected an array');
  if (list.length > MAX_ENDPOINTS) {
    throw new MetadataSchemaError('/endpoints', `At most ${MAX_ENDPOINTS} endpoints are allowed`);
  }
  const seen = new Set<string>();
  const endpoints = list.map((item: unknown, i) => {
    const path = `/endpoints/${i}`;
    const endpoint = plainObject(item, path, ['name', 'url']);
    const endpointName = text(endpoint['name'], `${path}/name`, 1, 64);
    const { url, normalized } = endpointUrl(endpoint['url'], `${path}/url`);
    if (seen.has(normalized)) throw new MetadataSchemaError(`${path}/url`, 'Duplicate endpoint URL');
    seen.add(normalized);
    return { name: endpointName, url };
  });
  return {
    schema: AGENT_METADATA_SCHEMA, name, ...(description === undefined ? {} : { description }), endpoints,
  };
}

interface Retrieved {
  sha256: Uint8Array;
  bytes: number;
  finalUrl: string;
}

export type MetadataResolution =
  | ({ status: 'verified'; document: AgentMetadataV1 } & Retrieved)
  | ({ status: 'hash-mismatch' } & Retrieved)
  | ({ status: 'invalid'; error: string; path: string } & Retrieved)
  | { status: 'unavailable'; reason: FetchRejection; detail: string };

export interface ResolveOptions {
  resolver?: Resolver | undefined;
  transport?: Transport | undefined;
  limits?: FetchLimits | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Fetch the registered URI and compare SHA-256 of the original bytes with the registered hash before any decoding.
 * Only matching bytes are parsed. Content-Type plays no part in the decision.
 */
export async function resolveMetadata(
  registered: { metadata_uri: string; metadata_hash: Uint8Array },
  options: ResolveOptions = {},
): Promise<MetadataResolution> {
  if (!(registered.metadata_hash instanceof Uint8Array) || registered.metadata_hash.length !== 32) {
    throw new Error('Expected a 32-byte registered metadata hash');
  }
  let response;
  try {
    response = await safeFetch(registered.metadata_uri, {
      method: 'GET', limits: options.limits ?? METADATA_LIMITS, resolver: options.resolver,
      transport: options.transport, signal: options.signal,
    });
  } catch (error) {
    if (error instanceof FetchRejected) return { status: 'unavailable', reason: error.reason, detail: error.message };
    throw error;
  }
  if (response.status < 200 || response.status > 299) {
    return { status: 'unavailable', reason: 'status', detail: `HTTP ${response.status}` };
  }
  const sha256 = Uint8Array.from(createHash('sha256').update(response.body).digest());
  const retrieved = { sha256, bytes: response.body.length, finalUrl: response.url.href };
  if (!timingSafeEqual(sha256, registered.metadata_hash)) return { status: 'hash-mismatch', ...retrieved };
  try {
    return { status: 'verified', ...retrieved, document: parseAgentMetadata(response.body) };
  } catch (error) {
    if (error instanceof MetadataSchemaError) {
      return { status: 'invalid', ...retrieved, error: error.message, path: error.path };
    }
    throw error;
  }
}
