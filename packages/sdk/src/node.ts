import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { keypairSigner, type Signer } from './signers.js';
import { isSettled, type TransactionJournal, type TransactionRecord } from './transactions.js';

/**
 * Node-only helpers, exported as `@stellar-agent-auth/sdk/node` so the main entry stays browser-safe: a durable
 * transaction journal and key references for headless processes.
 */

const HASH = /^[0-9a-f]{64}$/;

/**
 * One owner-only JSON file per signed envelope. Writes are atomic, so a crash leaves either the old or the new
 * record and the hash is never lost. Records hold public envelopes and status only, never keys.
 */
export class FileJournal implements TransactionJournal {
  constructor(readonly directory: string) {}

  private path(hash: string) {
    if (!HASH.test(hash)) throw new Error('Expected a transaction hash');
    return join(this.directory, `${hash}.json`);
  }

  async get(hash: string): Promise<TransactionRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.path(hash), 'utf8')) as TransactionRecord;
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async unsettled(scope: string): Promise<TransactionRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return [];
      throw error;
    }
    const records: TransactionRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !HASH.test(name.slice(0, -5))) continue;
      const record = await this.get(name.slice(0, -5));
      if (record && record.scope === scope && !isSettled(record.status)) records.push(record);
    }
    return records.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async put(record: TransactionRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(record.hash);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }
}

/** Where named keys live: `$STELLAR_AGENT_AUTH_KEY_DIR`, or `.local/keys` under the working directory. */
export function keyDirectory(env: Record<string, string | undefined>): string {
  return resolve(env['STELLAR_AGENT_AUTH_KEY_DIR'] ?? '.local/keys');
}

export class KeyReferenceError extends Error {
  override readonly name = 'KeyReferenceError';
}

/**
 * Resolve a key reference to a key pair. Secrets are never accepted inline:
 * - `file:<path>`: a file holding the secret, readable by its owner only;
 * - `env:<NAME>`: an environment variable holding the secret;
 * - `<name>`: `<key directory>/<name>.key`, also owner-only.
 */
export async function loadKeypair(reference: string, env: Record<string, string | undefined>): Promise<Keypair> {
  if (StrKey.isValidEd25519SecretSeed(reference)) {
    throw new KeyReferenceError('Pass a key reference (file:, env: or a key name), never a secret key');
  }
  let secret: string;
  if (reference.startsWith('env:')) {
    const name = reference.slice(4);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new KeyReferenceError('Invalid environment variable name');
    secret = env[name] ?? '';
    if (!secret) throw new KeyReferenceError(`Environment variable ${name} is not set`);
  } else {
    let path: string;
    if (reference.startsWith('file:')) {
      path = resolve(reference.slice(5));
    } else {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(reference)) throw new KeyReferenceError(`Invalid key name: ${reference}`);
      path = join(keyDirectory(env), `${reference}.key`);
    }
    const info = await stat(path).catch(() => {
      throw new KeyReferenceError(`Key file not found: ${path}`);
    });
    if ((info.mode & 0o077) !== 0) throw new KeyReferenceError(`Key file ${path} must be readable by its owner only`);
    secret = (await readFile(path, 'utf8')).trim();
  }
  if (!StrKey.isValidEd25519SecretSeed(secret)) throw new KeyReferenceError(`Key reference ${reference} is not a secret key`);
  return Keypair.fromSecret(secret);
}

/** Resolve a key reference to a signer; see `loadKeypair`. */
export async function loadKey(reference: string, env: Record<string, string | undefined>): Promise<Signer> {
  return keypairSigner(await loadKeypair(reference, env));
}

/** Generate a named key into the key directory, refusing to overwrite. Returns its public address. */
export async function createNamedKey(name: string, env: Record<string, string | undefined>): Promise<string> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) throw new KeyReferenceError(`Invalid key name: ${name}`);
  const directory = keyDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keypair = Keypair.random();
  const path = join(directory, `${name}.key`);
  await writeFile(path, `${keypair.secret()}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  return keypair.publicKey();
}

/** Resolve a path against `base` unless it is already absolute. */
export const resolvePath = (base: string, path: string) => (isAbsolute(path) ? path : resolve(base, path));
