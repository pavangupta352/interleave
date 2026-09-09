import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
// @ts-expect-error Release tooling is a native Node ESM script.
import { inspectPackageArchive } from '../scripts/release-archive.mjs';

const execute = promisify(execFile);
const repository = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('the actual built npm archive passes the release content checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interleave package content '));
  try {
    const metadata = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
    const packed = await execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
      cwd: repository, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const [record] = JSON.parse(packed.stdout);
    const inspected = inspectPackageArchive(await readFile(join(directory, record.filename)), metadata);
    expect(inspected.inventory).toHaveLength(record.files.length);
    expect(inspected.files.get('dist/cli/managed-postgres.js')).toEqual(await readFile(join(repository, 'dist/cli/managed-postgres.js')));
    expect(inspected.integrity).toBe(record.integrity);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 40_000);
