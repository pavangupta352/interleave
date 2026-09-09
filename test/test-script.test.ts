import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('managed PostgreSQL image selection accepts only exact qualified official tags', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, INTERLEAVE_TEST_POSTGRES_IMAGE: 'postgres:17-alpine' };
  delete env.TEST_DATABASE_URL;
  delete env.INTERLEAVE_TEST_DATABASE_URL;
  const result = spawnSync(process.execPath, [resolve('scripts/test.mjs'), 'unit'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 5_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/must be exactly postgres:16, postgres:17, or postgres:18/);
  expect(result.stderr).not.toMatch(/Starting disposable/);
});
