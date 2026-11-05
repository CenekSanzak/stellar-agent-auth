import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run workspace packages from source, so every import shares one copy of each module.
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const workspace = {
  '@stellar-agent-auth/sdk/node': source('./packages/sdk/src/node.ts'),
  '@stellar-agent-auth/sdk': source('./packages/sdk/src/index.ts'),
  '@stellar-agent-auth/verifier': source('./services/verifier/src/index.ts'),
  '@stellar-agent-auth/submitter': source('./services/submitter/src/index.ts'),
  '@stellar-agent-auth/cli': source('./packages/cli/src/index.ts'),
};

export default defineConfig({
  resolve: { alias: workspace },
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'tests/unit/**/*.test.ts',
            'packages/*/src/**/*.test.ts',
            'services/*/src/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'local',
          include: [
            'tests/local/**/*.test.ts',
            'tests/integration/**/*.test.ts',
            'tests/adversarial/**/*.test.ts',
          ],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'spec',
          include: ['tests/spec/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'testnet',
          include: ['tests/testnet/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
