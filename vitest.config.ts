import { defineConfig } from 'vitest/config';
import { integrationInclude, testExclude, testInclude } from './scripts/test-policy.js';

export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: testInclude,
          exclude: [...testExclude, ...integrationInclude],
        },
      },
      {
        test: {
          name: 'integration',
          include: integrationInclude,
          exclude: testExclude,
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 15000,
        },
      },
    ],
  },
});
