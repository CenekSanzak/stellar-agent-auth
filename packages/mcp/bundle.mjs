// Builds the tool as one file with nothing to install beside it: `node stellar-agent-wallet.mjs` is the whole
// installation. It is what the demo server hands to an agent that is setting itself up.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'], outfile: 'dist/stellar-agent-wallet.mjs', bundle: true, platform: 'node', format: 'esm',
  target: 'node20', legalComments: 'none', logLevel: 'warning',
  // A native speed-up that the Stellar SDK uses when it is installed, and does without when it is not.
  external: ['sodium-native'],
  // Bundled CommonJS dependencies call `require` for Node's own modules. The entry's own `#!` line is kept above this.
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
});
