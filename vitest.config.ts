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
      ...(process.env.INTERLEAVE_TEST_MANAGED_POSTGRES !== '1' ? ['test/**/*.managed.integration.test.ts'] : []),
      // Python process actors need an interpreter with the example's pinned requirements.
      ...(!process.env.INTERLEAVE_TEST_PYTHON ? ['test/**/*.python.integration.test.ts'] : []),
      // Other language examples need their interpreter or toolchain: ruby, php, go, java.
      ...(!process.env.INTERLEAVE_TEST_RUBY ? ['test/**/*.ruby.integration.test.ts'] : []),
      ...(!process.env.INTERLEAVE_TEST_PHP ? ['test/**/*.php.integration.test.ts'] : []),
      ...(!process.env.INTERLEAVE_TEST_GO ? ['test/**/*.go.integration.test.ts'] : []),
      ...(!process.env.INTERLEAVE_TEST_JAVA ? ['test/**/*.java.integration.test.ts'] : []),
      // Portable exports and release preparation need a POSIX npm, Git and tar toolchain;
      // both refuse Windows with an explicit error. The packaged ORM test ends in an export.
      ...(process.platform === 'win32' ? ['test/**/*export*.test.ts', 'test/**/release-*.test.ts', 'test/ordinary-orm-packaged.integration.test.ts'] : []),
    ],
    // Starting a CLI or supervised worker process takes about three seconds on Windows runners.
    testTimeout: process.platform === 'win32' ? 60_000 : 20_000,
    hookTimeout: process.platform === 'win32' ? 60_000 : 20_000,
    maxWorkers: 2,
    fileParallelism: true,
  },
});
