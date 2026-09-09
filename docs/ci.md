# Regression checks and CI

A recorded failure serves two purposes: it preserves the original reproduction,
and it gives you an ordering to try when checking a repair. Keep those purposes
separate in your tests. Exact file replay binds the original source; a changed
application needs new evidence.

This guide continues the [application example](application-guide.md), from its
installed `interleave-race` directory. It assumes the original failure and
reduced artifact exist. Commands using `expect_exit` use the helper defined in
that guide and must stay in the same shell.

## Retain the original failing case

Before changing `application/counter.mjs`, keep the source, package/lock files,
original Interleave archive and artifacts. A supported export bundles them:

```sh
npx --no-install interleave export application/scenario.mjs application-reduced.json \
  --project-root . --runtime-archive "$interleave_archive" --out counter-regression
```

`interleave_archive` is the absolute original archive path set during
[installation](getting-started.md#install-this-development-build-into-an-application).
If you opened a new shell, set it to that same retained file. Export verifies its
bytes against the recorded lock and runtime; a newly packed archive is not an
interchangeable replacement. Export requires a completed invariant violation
and does not need PostgreSQL or execute the application.

Follow the emitted installation and replay commands from the export directory
when you need the original reproduction. Verify the folder before running trusted
source from it. For a shared installation, `node install.mjs` restores the locked
packages from bundled archives offline. Its replay still needs a dedicated
PostgreSQL URL, or the managed Docker option on a runtime that supports it.
A successful exact replay of this original bug is expected to report a violation,
not a passing invariant. The [export guide](regressions.md) explains verification,
installation and platform limits.

## Try an atomic repair as new evidence

Replace the installed application's `application/counter.mjs` with this complete
file. The scenario, business invariant and client injection stay the same:

```js
export async function incrementCounter(client, id) {
  const { rows } = await client.query(
    'UPDATE counters SET value = value + 1 WHERE id = $1 RETURNING value',
    [id],
  );
  return rows[0].value;
}
```

The operation now increments in PostgreSQL without a separate read in JavaScript.
First verify that the old exact replay reports the source change, then explicitly
request a guided run:

```sh
expect_exit 3 npx --no-install interleave replay application/scenario.mjs application-failure.json \
  --docker --out changed-source.json
expect_exit 3 npx --no-install interleave replay application/scenario.mjs application-failure.json \
  --docker --guided --out repaired-guided.json
```

The first result is `incompatible` because the source changed. Guided execution
allows the changed source, but it must still consume the requested actor order.
This repair issues two atomic updates instead of four commands, so the guided
attempt also reports `incompatible`: "Application finished before consuming
every requested schedule choice." It records two releases and complete cleanup;
it does not establish a passing invariant. Use the fresh exploration below to
check the repair. A guided run that does complete with a passing invariant still
describes only that observed execution.

## Check the repaired operation with the Node test runner

The public API uses an explicit dedicated administrator URL. `--docker` belongs
to the CLI and is not an API option. Set `TEST_DATABASE_URL` using your dedicated
server, or use the CI service shown below.

Save this complete file as `check-race.mjs` in the installed application root:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { explore, writeReport, writeRunArtifact } from '@pavangupta352/interleave';

test('both counter increments are retained in the observed search', { timeout: 90_000 }, async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set a dedicated TEST_DATABASE_URL');
  const search = await explore('./application/scenario.mjs', {
    databaseUrl: process.env.TEST_DATABASE_URL,
    maxRuns: 50,
    timeoutMs: 10_000,
    totalTimeoutMs: 60_000,
  });

  // Keep the latest CI diagnostics even when an assertion below fails.
  await mkdir('.interleave', { recursive: true });
  await writeFile('.interleave/search.json', JSON.stringify(search, null, 2));
  const retained = search.firstFailure ?? search.runs.at(-1);
  if (retained) {
    await writeRunArtifact('.interleave/latest-run.json', retained, { overwrite: true });
    await writeReport('.interleave/latest-report.html', retained, { overwrite: true });
  }

  assert.equal(search.hardFailureCount, 0, 'An actor, harness, or cleanup failed');
  assert.equal(search.stopReason, 'frontier-exhausted', search.stopReason);
  assert.equal(search.pending, 0);
  assert.equal(search.violationCount, 0, 'The invariant failed');
  assert.equal(search.omittedRuns, 0, 'Some run evidence was not retained');
  assert.equal(search.metrics.traceCountsComplete, true);
  assert.ok(search.metrics.completedRuns > 0, 'No compatible execution completed');
  assert.ok(search.runs.length > 0);
  for (const run of search.runs) {
    assert.equal(run.cleanup.complete, true, run.cleanup.error);
    assert.equal(run.outcome, 'passed', run.reason ?? run.failure?.message);
  }
});
```

From that root, with your dedicated URL set:

```sh
node --test check-race.mjs
```

The test should fail for the unsafe operation and pass for the atomic repair
within the stated search policy. It also fails if a budget stops exploration,
cleanup is incomplete, or no compatible execution completed. Its success means
the modeled frontier observed by this search completed with the invariant intact.
It does not establish race freedom across external inputs, opaque server code,
or unobserved schedules.

The `.interleave/latest-*` files are deliberately replaced on each invocation;
retain the original reproduction elsewhere. `search.json` is a search summary,
not a replay artifact. A source/preflight error may throw before a search result
exists; the test runner still fails and retains its error output.

## Run it in GitHub Actions

For the current unpublished development package, first make its original archive
available at a path the CI checkout can resolve. From the installed application,
with `interleave_archive` still pointing to the original file:

```sh
mkdir -p vendor
cp "$interleave_archive" vendor/interleave.tgz
npm install --save-exact ./vendor/interleave.tgz pg@8.23.0
```

Retain `vendor/interleave.tgz`, the updated `package.json` and `package-lock.json`,
`application/`, and `check-race.mjs` in your CI input. A local archive path outside
the checkout will not exist on the runner. Changing dependency metadata creates
a new source identity; record new application evidence after this setup. Once a
published version is actually available, a pinned registry dependency can replace
this development-archive route through an intentional lockfile update.

Save this complete workflow as `.github/workflows/race.yml` in that application:

```yaml
name: Database race check
on: [push, pull_request]
jobs:
  counter:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: interleave-test
          POSTGRES_DB: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres -d postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      TEST_DATABASE_URL: postgresql://postgres:interleave-test@127.0.0.1:5432/postgres
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22.18.0'
          cache: npm
      - run: npm ci
      - run: node --test check-race.mjs
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: counter-evidence
          path: .interleave/
          include-hidden-files: true
          if-no-files-found: ignore
```

The service is a disposable CI server; Interleave creates and drops its own
execution databases inside it. Its password is only for this isolated example
service. The artifact step runs after a failed test and does not change the test's
status. Reports and JSON may contain application data; apply your repository's
artifact-access policy before using this with private fixtures.

The workflow is a template for your application. Local execution of the test
file does not establish that a hosted workflow has run. Keep actual hosted
results separate from the local recipe checks. See [CLI exit codes](cli.md#limits-and-machine-output)
for shell-based alternatives, including the distinction between a violation
(exit 1) and a safety-budget stop (exit 4).
