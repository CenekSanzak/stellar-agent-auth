#!/usr/bin/env node
/**
 * External consumer check for the CLI and the services: pack the SDK, the verifier, the CLI, the submitter, the
 * indexer and the x402 package exactly as npm would publish them, install the tarballs into an empty project outside the workspace, and
 * run each there. It shows that none of them depends on a file the package does not ship or on the workspace's own
 * layout. Run after `npm run build`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = {
  sdk: 'packages/sdk', verifier: 'services/verifier', cli: 'packages/cli', submitter: 'services/submitter',
  indexer: 'services/indexer', x402: 'packages/x402',
};
const work = await mkdtemp(join(tmpdir(), 'saa-service-consumer-'));
const consumer = join(work, 'consumer');

try {
  const scope = join(consumer, 'node_modules/@stellar-agent-auth');
  for (const [name, directory] of Object.entries(PACKAGES)) {
    const packed = join(work, name);
    await mkdir(packed, { recursive: true });
    execFileSync('npm', ['pack', '--silent', '--pack-destination', packed], {
      cwd: join(root, directory), stdio: ['ignore', 'pipe', 'inherit'],
    });
    const [tarball] = (await readdir(packed)).filter((file) => file.endsWith('.tgz'));
    if (!tarball) throw new Error(`npm pack produced no tarball for ${name}`);
    const installed = join(scope, name);
    await mkdir(installed, { recursive: true });
    execFileSync('tar', ['-xzf', join(packed, tarball), '-C', installed, '--strip-components=1']);
    // Only what the package declares may ship: no sources, no tests, no configuration.
    const unexpected = (await readdir(installed)).filter((file) => !['README.md', 'dist', 'package.json'].includes(file));
    if (unexpected.length) throw new Error(`Unexpected files in ${name}: ${unexpected.join(', ')}`);
  }
  // The third-party runtime dependencies, resolved from the workspace install without network access.
  await mkdir(join(consumer, 'node_modules/@stellar'), { recursive: true });
  await symlink(join(root, 'node_modules/@stellar/stellar-sdk'), join(consumer, 'node_modules/@stellar/stellar-sdk'), 'dir');
  await mkdir(join(consumer, 'node_modules/@x402'), { recursive: true });
  for (const name of ['core', 'stellar']) {
    await symlink(join(root, 'node_modules/@x402', name), join(consumer, 'node_modules/@x402', name), 'dir');
  }
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));

  // The CLI runs from its packed entry point, with its state kept inside the consumer.
  const env = { PATH: process.env.PATH, HOME: consumer, STELLAR_NETWORK: 'local' };
  const cli = (...args) => spawnSync(process.execPath, [join(scope, 'cli/dist/index.js'), ...args],
    { cwd: consumer, env, encoding: 'utf8' });
  const help = cli('help');
  if (help.status !== 0 || !help.stdout.includes('Usage: stellar-agent-auth')) {
    throw new Error(`The packed CLI did not print its usage: ${help.stderr}`);
  }
  const created = cli('keys', 'create', '--name', 'packed', '--json');
  if (created.status !== 0 || !/"address":\s*"G[A-Z2-7]{55}"/.test(created.stdout)) {
    throw new Error(`The packed CLI could not create a key: ${created.stderr || created.stdout}`);
  }
  const listed = cli('tx', 'list', '--json');
  if (listed.status !== 0 || !listed.stdout.includes(join(consumer, '.local/state/stellar-agent-auth/journal/local'))) {
    throw new Error(`The packed CLI did not use its own state directory: ${listed.stderr || listed.stdout}`);
  }

  // The services load through their public entry points and read their configuration.
  await writeFile(join(consumer, 'consumer.mjs'), `
import { submitterConfig, startSubmitter } from '@stellar-agent-auth/submitter';
import { indexerConfig, HistoryStore, startIndexer } from '@stellar-agent-auth/indexer';
import { assess, safeFetch } from '@stellar-agent-auth/verifier';
import { main } from '@stellar-agent-auth/cli';
import { StellarExactFacilitator, WalletExactScheme, payeeGate, transferProblem, x402Network } from '@stellar-agent-auth/x402';
import { StrKey } from '@stellar/stellar-sdk';
const contract = StrKey.encodeContract(new Uint8Array(32).fill(7));
if (x402Network('Test SDF Network ; September 2015') !== 'stellar:testnet') throw new Error('Unexpected x402 network');
for (const value of [startSubmitter, startIndexer, assess, safeFetch, main, StellarExactFacilitator, WalletExactScheme, payeeGate, transferProblem]) {
  if (typeof value !== 'function') throw new Error('A public entry point is missing');
}
const submitter = submitterConfig({ STELLAR_NETWORK: 'local', SUBMITTER_SPONSOR_KEY: 'sponsor', SUBMITTER_CONTRACTS: contract });
const indexer = indexerConfig({ STELLAR_NETWORK: 'local', WALLET_ID: contract, INDEXER_START_LEDGER: '5' });
const store = new HistoryStore(':memory:');
const schema = store.schemaVersion();
store.close();
console.log(JSON.stringify({ submitter_budget: String(submitter.dailyBudget), indexer_stream: indexer.stream.id, schema }));
`);
  const output = execFileSync(process.execPath, ['consumer.mjs'], { cwd: consumer, encoding: 'utf8' });
  console.log(`Service package check passed: ${Object.keys(PACKAGES).join(', ')} ${output.trim()}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
