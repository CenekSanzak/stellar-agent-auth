import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run workspace packages from source, so every import shares one copy of each module.
const workspace = {
  '@stellar-agent-auth/sdk': fileURLToPath(new URL('./packages/sdk/src/index.ts', import.meta.url)),
  '@stellar-agent-auth/verifier': fileURLToPath(new URL('./services/verifier/src/index.ts', import.meta.url)),
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
          name: 'testnet',
          include: ['tests/testnet/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
