#!/usr/bin/env node
// Baselines for the historical cases, without Interleave.
//
//   node harness/baseline.mjs --scenario <variant>/scenario.mjs --mode ordinary --trials 100
//   node harness/baseline.mjs --scenario <variant>/scenario.mjs --mode barrier \
//     --barrier <case>/barrier.mjs --trials 20
//
// Each trial creates a new generated database on the dedicated server named by
// TEST_DATABASE_URL, runs the scenario's own setup, starts every actor in the
// same event-loop turn with the direct database URL, evaluates the scenario's
// own invariant, and drops the database. `ordinary` adds no coordination.
// `barrier` adds the case's hand-written result barrier (see result-barrier.mjs).
// Trials print one JSON line each; the last line is a summary.
import { AssertionError } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { installResultBarrier } from './result-barrier.mjs';

const { values: options } = parseArgs({
  options: {
    scenario: { type: 'string' },
    mode: { type: 'string', default: 'ordinary' },
    barrier: { type: 'string' },
    trials: { type: 'string', default: '100' },
    'timeout-ms': { type: 'string', default: '30000' },
    out: { type: 'string' },
  },
});
const trials = Number(options.trials);
const timeoutMs = Number(options['timeout-ms']);
if (!options.scenario || !['ordinary', 'barrier'].includes(options.mode) || !Number.isInteger(trials) || trials < 1
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || (options.mode === 'barrier') !== Boolean(options.barrier)) {
  console.error('Usage: baseline.mjs --scenario FILE [--mode ordinary | --mode barrier --barrier FILE] [--trials N] [--timeout-ms MS] [--out FILE.jsonl]');
  process.exit(2);
}
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) {
  console.error('Set TEST_DATABASE_URL to the administrator database of a dedicated disposable PostgreSQL server.');
  process.exit(2);
}

const scenarioFile = resolve(options.scenario);
// Use the scenario's own installed driver, so the barrier wraps the same module
// instance that the application libraries load.
const pg = createRequire(scenarioFile)('pg');
const scenario = (await import(pathToFileURL(scenarioFile).href)).default;
const gate = options.barrier ? (await import(pathToFileURL(resolve(options.barrier)).href)).gate : null;
const actorNames = Object.keys(scenario.actors).sort();
const round = value => Math.round(value * 1000) / 1000;

async function withAdmin(work) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try { return await work(admin); } finally { await admin.end(); }
}

async function trial(number) {
  const database = `interleave_${randomBytes(16).toString('hex')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const connectionString = url.href;
  const record = { trial: number, mode: options.mode, database, outcome: null };
  const began = performance.now();
  await withAdmin(admin => admin.query(`CREATE DATABASE "${database}"`));
  let db;
  try {
    db = new pg.Client({ connectionString });
    await db.connect();
    const setupStart = performance.now();
    await scenario.setup({ db, connectionString });
    record.setupMs = round(performance.now() - setupStart);

    const barrier = gate ? installResultBarrier(pg, { match: gate.match, parties: actorNames.length }) : null;
    const controller = new AbortController();
    let timer;
    const deadline = new Promise(resolveDeadline => { timer = setTimeout(() => resolveDeadline('deadline'), timeoutMs); });
    const workloadStart = performance.now();
    const settled = Promise.allSettled(actorNames.map(actor => Promise.resolve()
      .then(() => scenario.actors[actor]({ actor, connectionString, signal: controller.signal }))
      .finally(() => barrier?.actorSettled())));
    const finished = await Promise.race([settled, deadline]);
    clearTimeout(timer);
    record.workloadMs = round(performance.now() - workloadStart);
    if (finished === 'deadline') {
      controller.abort();
      barrier?.uninstall();
      await Promise.race([settled, new Promise(resolveGrace => setTimeout(resolveGrace, 5000))]);
      record.outcome = 'harness-timeout';
      if (barrier) record.barrier = barrier.summary();
      return record;
    }
    barrier?.uninstall();
    if (barrier) record.barrier = barrier.summary();
    const results = finished.map((entry, index) => entry.status === 'fulfilled'
      ? { actor: actorNames[index], status: 'fulfilled', ...(entry.value === undefined ? {} : { value: JSON.parse(JSON.stringify(entry.value)) }) }
      : { actor: actorNames[index], status: 'rejected', error: String(entry.reason?.message ?? entry.reason) });
    record.actors = results;
    if (results.some(result => result.status === 'rejected')) {
      record.outcome = 'actor-error';
    } else {
      try {
        await scenario.invariant({ db, connectionString, results });
        record.outcome = 'passed';
      } catch (error) {
        if (!(error instanceof AssertionError)) throw error;
        record.outcome = 'violation';
        record.failure = error.message.split('\n')[0];
      }
    }
    return record;
  } catch (error) {
    record.outcome = 'harness-error';
    record.error = String(error?.message ?? error);
    return record;
  } finally {
    await db?.end().catch(() => undefined);
    const cleanupStart = performance.now();
    record.cleanup = await withAdmin(async admin => {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      const remaining = await admin.query('SELECT count(*)::integer AS count FROM pg_database WHERE datname = $1', [database]);
      return { dropped: true, absent: remaining.rows[0].count === 0 };
    }).catch(error => ({ dropped: false, absent: false, error: String(error?.message ?? error) }));
    record.cleanupMs = round(performance.now() - cleanupStart);
    record.totalMs = round(performance.now() - began);
  }
}

const serverVersion = await withAdmin(async admin => (await admin.query('SHOW server_version')).rows[0].server_version);
const counts = {};
const started = performance.now();
for (let number = 1; number <= trials; number += 1) {
  const record = await trial(number);
  counts[record.outcome] = (counts[record.outcome] ?? 0) + 1;
  const line = JSON.stringify(record);
  console.log(line);
  if (options.out) await appendFile(options.out, `${line}\n`);
}
const summary = {
  summary: true, scenario: scenario.name, mode: options.mode, trials, counts,
  serverVersion, node: process.version, pg: createRequire(scenarioFile)('pg/package.json').version,
  totalMs: round(performance.now() - started),
};
console.log(JSON.stringify(summary));
if (options.out) await appendFile(options.out, `${JSON.stringify(summary)}\n`);
