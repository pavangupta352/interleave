#!/usr/bin/env node
// Run one isolation spec with the tester image built from ./Dockerfile.
//
//   node examples/historical/isolation/run-spec.mjs \
//     --spec examples/historical/knex-migration-lock/isolation/before-fix.spec \
//     --image interleave-isolationtester:16.15 \
//     --network container:<PostgreSQL container name> --host 127.0.0.1 --port 5432
//
// TEST_DATABASE_URL names the dedicated server's administrator database; its
// user and password are reused inside the tester container. `--network`,
// `--host` and `--port` describe how the tester container reaches that same
// server. The script creates a generated database, runs the spec there, prints
// the tester's output, and drops the database. `--driver` names a package.json
// whose installed node-postgres administers the database; it defaults to the
// case's before-fix/ application.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';

const { values: options } = parseArgs({
  options: {
    spec: { type: 'string' }, image: { type: 'string' }, network: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '5432' },
    driver: { type: 'string' },
  },
});
const adminUrl = process.env.TEST_DATABASE_URL;
if (!options.spec || !options.image || !options.network || !adminUrl) {
  console.error('Usage: run-spec.mjs --spec FILE --image IMAGE --network DOCKER_NETWORK [--host HOST] [--port PORT]; set TEST_DATABASE_URL');
  process.exit(2);
}
// Any installed node-postgres works for creating and dropping the database.
// By default, use the one installed in the case's before-fix/ directory, next
// to the spec's isolation/ directory.
const driver = options.driver ? resolve(options.driver) : join(dirname(resolve(options.spec)), '..', 'before-fix', 'package.json');
const pg = createRequire(driver)('pg');
const spec = await readFile(options.spec);
const admin = new URL(adminUrl);
const database = `interleave_${randomBytes(16).toString('hex')}`;

async function administer(sql) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try { return await client.query(sql); } finally { await client.end(); }
}

function tester() {
  const conninfo = `host=${options.host} port=${options.port} dbname=${database} user=${decodeURIComponent(admin.username)}`;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['run', '--rm', '-i', '--network', options.network, '-e', 'PGPASSWORD', options.image, conninfo], {
      env: { ...process.env, PGPASSWORD: decodeURIComponent(admin.password) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = []; const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.end(spec);
  });
}

await administer(`CREATE DATABASE "${database}"`);
let result;
try {
  result = await tester();
} finally {
  await administer(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
}
const remaining = await administer(`SELECT count(*)::integer AS count FROM pg_database WHERE datname = '${database}'`);
process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
console.error(JSON.stringify({ testerExit: result.code, database, databaseAbsent: remaining.rows[0].count === 0 }));
process.exitCode = result.code === 0 && remaining.rows[0].count === 0 ? 0 : 1;
