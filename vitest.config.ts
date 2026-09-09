import { defineConfig } from 'vitest/config';

const integrationPattern = 'test/**/*.integration.test.ts';
const pgvectorPattern = 'test/**/*.pgvector.integration.test.ts';
const pgvectorProfile = process.env.INTERLEAVE_TEST_FIXTURE_PROFILE === 'postgresql17-pgvector0.8.6-v1';

export default defineConfig({
  test: {
    include: process.env.INTERLEAVE_TEST_SUITE === 'integration' ? [integrationPattern] : ['test/**/*.test.ts'],
    exclude: [
      ...(process.env.INTERLEAVE_TEST_SUITE === 'unit' ? [integrationPattern] : []),
      ...(!pgvectorProfile ? [pgvectorPattern] : []),
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 2,
    fileParallelism: true,
  },
});
