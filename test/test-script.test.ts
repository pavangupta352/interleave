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
  expect(result.stderr).toMatch(/must be exactly postgres:16, postgres:17, postgres:18, or pgvector\/pgvector:0\.8\.6-pg17-bookworm/);
  expect(result.stderr).not.toMatch(/Starting disposable/);
});

test('managed PostgreSQL image selection accepts the exact qualified pgvector tag', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, INTERLEAVE_TEST_POSTGRES_IMAGE: 'pgvector/pgvector:0.8.6-pg17-bookworm' };
  delete env.TEST_DATABASE_URL;
  delete env.INTERLEAVE_TEST_DATABASE_URL;
  const result = spawnSync(process.execPath, [resolve('scripts/test.mjs'), 'unit', '--passWithNoTests', '-t', 'no tests use this filter'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 5_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).not.toMatch(/INTERLEAVE_TEST_POSTGRES_IMAGE must be exactly/);
});
