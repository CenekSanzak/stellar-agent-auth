// Lays the one-file tool out as a package for npm, in dist/npm: `cd dist/npm && npm publish`.
// It has no dependencies; everything it needs is inside the file.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const version = process.argv[2] ?? JSON.parse(await readFile('package.json', 'utf8')).version;
await mkdir('dist/npm', { recursive: true });
await cp('dist/stellar-agent-wallet.mjs', 'dist/npm/stellar-agent-wallet.mjs');
await cp('README.md', 'dist/npm/README.md');
await cp('../../LICENSE', 'dist/npm/LICENSE');
await writeFile('dist/npm/package.json', `${JSON.stringify({
  name: 'stellar-agent-wallet', version, license: 'Apache-2.0', type: 'module',
  description: 'Lets an AI agent pay x402 resources from a policy-limited smart wallet on Stellar, as an MCP server.',
  bin: { 'stellar-agent-wallet': './stellar-agent-wallet.mjs' },
  files: ['stellar-agent-wallet.mjs', 'README.md', 'LICENSE'], engines: { node: '>=20' },
  repository: { type: 'git', url: 'git+https://github.com/CenekSanzak/stellar-agent-auth.git', directory: 'packages/mcp' },
  keywords: ['stellar', 'soroban', 'mcp', 'x402', 'ai-agent', 'wallet'],
}, null, 2)}\n`);
console.log(`dist/npm is ready to publish as stellar-agent-wallet@${version}`);
