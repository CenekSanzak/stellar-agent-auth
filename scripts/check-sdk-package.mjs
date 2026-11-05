#!/usr/bin/env node
/**
 * External consumer check for the built SDK: pack it exactly as npm would publish it, install the tarball into an
 * empty project outside the workspace, then import and type-check it there through its public entry points only.
 * Run after `npm run build`.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sdk = join(root, 'packages/sdk');
const work = await mkdtemp(join(tmpdir(), 'saa-sdk-consumer-'));

try {
  execFileSync('npm', ['pack', '--silent', '--pack-destination', work], { cwd: sdk, stdio: ['ignore', 'pipe', 'inherit'] });
  const [tarball] = (await readdir(work)).filter((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  const installed = join(work, 'consumer/node_modules/@stellar-agent-auth/sdk');
  await mkdir(installed, { recursive: true });
  execFileSync('tar', ['-xzf', join(work, tarball), '-C', installed, '--strip-components=1']);

  // Only what the package declares may ship.
  const shipped = (await readdir(installed)).sort();
  const unexpected = shipped.filter((name) => !['README.md', 'dist', 'package.json'].includes(name));
  if (unexpected.length) throw new Error(`Unexpected files in the package: ${unexpected.join(', ')}`);

  // The one runtime dependency, resolved from the workspace install without network access.
  await mkdir(join(work, 'consumer/node_modules/@stellar'), { recursive: true });
  await symlink(join(root, 'node_modules/@stellar/stellar-sdk'), join(work, 'consumer/node_modules/@stellar/stellar-sdk'),
    'dir');
  await writeFile(join(work, 'consumer/package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));

  await writeFile(join(work, 'consumer/consumer.mjs'), `
import * as sdk from '@stellar-agent-auth/sdk';
import * as node from '@stellar-agent-auth/sdk/node';
const required = ['loadConfig', 'policyHash', 'walletOperation', 'transferRequest', 'signActionAuthorization',
  'networkContext', 'prepare', 'invoke', 'submit', 'settle', 'Sponsor', 'signForSponsor', 'sponsoredInvoke',
  'httpSponsor', 'keypairSigner', 'walletAdapterSigner', 'executeInvocation', 'ownerInvocation', 'readAuditHistory',
  'toContractUnits', 'explainContractError', 'MemoryJournal'];
const missing = required.filter((name) => typeof sdk[name] === 'undefined');
if (missing.length) throw new Error('Missing exports: ' + missing.join(', '));
if (typeof node.FileJournal !== 'function' || typeof node.loadKey !== 'function') throw new Error('Missing node exports');
if ('FileJournal' in sdk) throw new Error('The browser-safe entry must not export Node-only helpers');
try {
  await import('@stellar-agent-auth/sdk/dist/wallet.js');
  throw new Error('Deep imports must be blocked by the exports map');
} catch (error) {
  if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
}
const config = sdk.loadConfig({ STELLAR_NETWORK: 'local' });
if (sdk.toContractUnits('3', 7) !== 30000000n || config.network !== 'local') throw new Error('Unexpected behaviour');
console.log(JSON.stringify({ exports: Object.keys(sdk).length, node_exports: Object.keys(node).length }));
`);
  const output = execFileSync(process.execPath, ['consumer.mjs'], { cwd: join(work, 'consumer'), encoding: 'utf8' });

  // Type declarations resolve for a TypeScript consumer using Node's module resolution.
  await writeFile(join(work, 'consumer/consumer.ts'), `
import { transferRequest, type ActionRequest, type Signer } from '@stellar-agent-auth/sdk';
import { FileJournal } from '@stellar-agent-auth/sdk/node';
const request: ActionRequest = transferRequest({
  wallet: 'C', policyHash: new Uint8Array(32), sequence: 1n, deadline: 2n, asset: 'C', recipient: 'G', amount: 3n,
});
export const journal = new FileJournal('.journal');
export const signer: Signer | undefined = undefined;
export { request };
`);
  await writeFile(join(work, 'consumer/tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true,
      lib: ['ES2022', 'DOM'], types: [], skipLibCheck: true, typeRoots: [join(root, 'node_modules/@types')],
    },
    files: ['consumer.ts'],
  }));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    { cwd: join(work, 'consumer'), stdio: 'inherit' });
  console.log(`SDK package check passed: ${tarball} ${output.trim()}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
