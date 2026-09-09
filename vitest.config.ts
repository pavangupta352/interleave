import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: process.env.INTERLEAVE_TEST_SUITE === 'integration' ? ['test/**/*.integration.test.ts'] : ['test/**/*.test.ts'],
    ...(process.env.INTERLEAVE_TEST_SUITE === 'unit' ? { exclude: ['test/**/*.integration.test.ts'] } : {}),
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 2,
    fileParallelism: true,
  },
});
