import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/server/**/*.integration.test.ts'],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 15000,
        },
      },
    ],
  },
});
