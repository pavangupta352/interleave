// Download the PostgreSQL JDBC driver pinned in shared.mjs from Maven Central into
// lib/. The jar is kept only when its SHA-256 matches the recorded value.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { driver, driverJar } from './shared.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const existing = await readFile(driverJar).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
if (existing && digest(existing) === driver.sha256) {
  console.error(`PostgreSQL JDBC ${driver.version} is already present and verified.`);
} else {
  if (existing) throw new Error(`${driverJar} does not match the recorded SHA-256; remove it and run this script again`);
  const url = `https://repo1.maven.org/maven2/org/postgresql/postgresql/${driver.version}/postgresql-${driver.version}.jar`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Maven Central returned HTTP ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = digest(bytes);
  if (actual !== driver.sha256) throw new Error(`Downloaded driver SHA-256 ${actual} differs from the recorded ${driver.sha256}`);
  await mkdir(dirname(driverJar), { recursive: true });
  const partial = `${driverJar}.partial`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, driverJar);
  } finally { await rm(partial, { force: true }); }
  console.error(`Downloaded and verified PostgreSQL JDBC ${driver.version}.`);
}
