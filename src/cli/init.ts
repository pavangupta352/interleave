import { lstat, mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function initializeProject(directory: string, version: string) {
  const target = resolve(directory);
  try { await mkdir(target); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const contents: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'interleave-scenario', private: true, type: 'module',
      scripts: { race: 'interleave run scenario.mjs --out failure.interleave.json' },
      dependencies: { '@pavangupta352/interleave': version, pg: '^8.23.0' },
    }, null, 2) + '\n',
    'scenario.mjs': `import assert from 'node:assert/strict';
import { Client } from 'pg';
import { defineScenario } from '@pavangupta352/interleave';

async function increment({ connectionString }) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT value FROM counter WHERE id = 1');
    await client.query('UPDATE counter SET value = $1 WHERE id = 1', [rows[0].value + 1]);
  } finally { await client.end(); }
}

export default defineScenario({
  name: 'two-increments',
  async setup({ db }) {
    await db.query('CREATE TABLE counter (id int PRIMARY KEY, value int NOT NULL); INSERT INTO counter VALUES (1, 0)');
  },
  actors: { alice: increment, bob: increment },
  async invariant({ db }) {
    assert.equal((await db.query('SELECT value FROM counter WHERE id = 1')).rows[0].value, 2, 'Both increments must be retained');
  },
});
`,
    'README.md': `# Interleave scenario

Install dependencies with npm install. No packages have been installed automatically.
This scaffold requests Interleave ${version}; if that development version is not
published, install a locally built package tarball with npm install /path/to/interleave.tgz.

With Docker installed and running, start a disposable local server and run:

    npm run race -- --docker

The first use may download the PostgreSQL image. Each command removes its owned
server before returning. Alternatively, set TEST_DATABASE_URL to a dedicated
PostgreSQL administrator database where Interleave may create and drop its own
generated databases, then run npm run race without --docker. Do not combine them.

The example deliberately contains a lost-update race. A detected invariant
violation exits 1 and is saved in failure.interleave.json. Replay it with:

    npx interleave replay scenario.mjs failure.interleave.json --docker

Create and open an offline report:

    npx interleave report failure.interleave.json --out report.html

Omit --docker from replay when using the dedicated TEST_DATABASE_URL route.
To intentionally replace the scenario's previous saved run:

    npm run race -- --docker --force

Outputs refuse replacement by default. The race script already supplies --out;
use --force for intentional replacement instead of adding another --out option.
Scenarios are trusted executable code. Artifacts contain private SQL and selected
observations; review them before sharing. Passing sampled schedules is not proof
of race freedom.
`,
  };
  const created: string[] = [];
  try {
    // Refuse known conflicts before creating any files. A later concurrent
    // conflict can still occur; leave created files intact instead of risking
    // deletion of a path another process has since replaced or edited.
    for (const name of Object.keys(contents)) {
      try {
        await lstat(join(target, name));
        throw Object.assign(new Error('Destination already exists'), { code: 'EEXIST' });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    for (const [name, content] of Object.entries(contents)) {
      const path = join(target, name);
      const handle = await open(path, 'wx', 0o600);
      created.push(path);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    }
  } catch (error) {
    const retained = created.length ? ` Files already created were left in place: ${created.join(', ')}.` : '';
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error(`init refuses to overwrite existing package.json, scenario.mjs, or README.md; choose another directory.${retained}`);
    if (created.length) throw new Error(`init did not finish.${retained}`, { cause: error });
    throw error;
  }
  return { directory: target, files: Object.keys(contents), nextSteps: ['Install dependencies with npm install (or install a local Interleave tarball).', 'With Docker running, use npm run race -- --docker; first use may download PostgreSQL.', 'Or set TEST_DATABASE_URL to a dedicated test administrator database and use npm run race.', 'A detected violation exits 1. Create its report with npx interleave report failure.interleave.json --out report.html.'] };
}
