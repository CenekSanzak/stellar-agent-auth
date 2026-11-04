import { defineConfig } from 'vitest/config';

export default defineConfig({
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
