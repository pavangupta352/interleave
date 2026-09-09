import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { renderReport, writeReport } from '../src/report.js';
import type { RunResult } from '../src/types.js';

export function reportFixture(): RunResult {
  return {
    schemaVersion: 1, scenario: 'two-increments', outcome: 'violation', mode: 'explore', plan: [],
    trace: ['alice', 'bob', 'alice', 'bob'].map((actor, index) => ({
      index, actor, connection: 0, ordinal: Math.floor(index / 2), protocol: index < 2 ? 'simple' : 'extended',
      sql: index < 2 ? 'SELECT value FROM counter WHERE id = 1' : 'UPDATE counter SET value = $1 WHERE id = 1',
      fingerprint: 'a'.repeat(64), backendPid: actor === 'alice' ? 123 : 124, available: ['alice', 'bob'], releasedAt: index * 10, completedAt: index * 10 + 5,
      completion: { transactionStatus: 'I', commandTags: [index < 2 ? 'SELECT 1' : 'UPDATE 1'], rowCount: 1 }, waits: [],
    })),
    actors: ['alice', 'bob'].map(actor => ({ actor, status: 'fulfilled' })),
    failure: { name: 'AssertionError', message: 'Both increments must be retained', fingerprint: 'b'.repeat(64) },
    environment: { serverVersion: '16.13', nodeVersion: 'v24.7.0' }, startedAt: '2026-09-09T00:00:00.000Z', durationMs: 50,
    limits: { maxSteps: 100, timeoutMs: 10000 }, cleanup: { complete: true },
  };
}

test('report is a standalone document with inert hostile SQL and a restrictive content policy', async () => {
  const run = reportFixture();
  run.trace[0]!.sql = '</script><script>globalThis.reportAttack = true</script> & "';
  const html = await renderReport(run);
  expect(html).toContain('<!doctype html>');
  expect(html).toContain('Content-Security-Policy');
  expect(html).toContain("default-src 'none'");
  expect(html).not.toContain('<script>globalThis.reportAttack');
  const embedded = /<script id="run-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!;
  expect(JSON.parse(embedded).run.trace[0].sql).toBe(run.trace[0]!.sql);
  expect(html).not.toMatch(/<(?:script|link)\b[^>]*(?:src|href)=["']https?:/);
});

test('report writes refuse overwrite and invalid evidence creates no output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interleave report '));
  const target = join(directory, 'evidence.html');
  try {
    await writeReport(target, reportFixture());
    const original = await readFile(target, 'utf8');
    await expect(writeReport(target, reportFixture())).rejects.toThrow(/exists|overwrite/i);
    expect(await readFile(target, 'utf8')).toBe(original);
    await expect(writeReport(join(directory, 'invalid.html'), { ...reportFixture(), schemaVersion: 9 } as unknown as RunResult)).rejects.toThrow(/version/);
    await expect(readFile(join(directory, 'invalid.html'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public CLI --force replaces an existing report with the selected artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interleave report force '));
  const artifact = join(directory, 'selected.json');
  const target = join(directory, 'evidence.html');
  const selected = reportFixture();
  selected.reason = 'selected force-report fixture';
  try {
    await writeFile(artifact, JSON.stringify(selected));
    await writeFile(target, '<html>existing sentinel</html>');
    const env = { ...process.env };
    delete env.TEST_DATABASE_URL;
    delete env.INTERLEAVE_TEST_DATABASE_URL;
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
      'report', artifact, '--out', target, '--force', '--json',
    ], { encoding: 'utf8', env, timeout: 10_000, maxBuffer: 1024 * 1024 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ path: target, scenario: selected.scenario, outcome: selected.outcome });
    const html = await readFile(target, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('existing sentinel');
    const embedded = /<script id="run-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(embedded).run).toEqual(selected);
    expect((await readdir(directory)).sort()).toEqual(['evidence.html', 'selected.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
