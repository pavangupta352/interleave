# Library API

The API is under development. These entries describe the implemented core; release and compatibility qualification remain in progress.

## Define a scenario

`defineScenario` validates a name, setup function, two to eight named actors, and an invariant. Setup and the invariant receive a direct connection to a fresh database. Each actor receives its own proxy URL and cancellation signal.

```js
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { defineScenario } from '@pavangupta352/interleave';

export default defineScenario({
  name: 'two-increments',
  async setup({ db }) {
    await db.query('CREATE TABLE counter (n int); INSERT INTO counter VALUES (0)');
  },
  actors: { alice: increment, bob: increment },
  async invariant({ db }) {
    assert.equal((await db.query('SELECT n FROM counter')).rows[0].n, 2);
  },
});

async function increment({ connectionString }) {
  const db = new Client({ connectionString });
  await db.connect();
  try {
    const { rows } = await db.query('SELECT n FROM counter');
    await db.query('UPDATE counter SET n = $1', [rows[0].n + 1]);
  } finally {
    await db.end();
  }
}
```

Each actor may have one live physical connection at a time. Sequential reconnects receive a new connection generation. Return a JSON value only when that observation belongs in the recorded evidence. An assertion failure in the invariant produces a violation; another exception is a harness error. Rejected application operations are actor errors and do not count as invariant violations.

## Run and search

`runScenarioFile(file, options)` imports an explicitly selected, trusted local scenario in a disposable worker. Its parent owns database cleanup even if the worker exits or crashes. Prefer file targets for the complete workflow:

```js
import { explore, replay, minimize, writeRunArtifact } from '@pavangupta352/interleave';

const options = { databaseUrl: process.env.TEST_DATABASE_URL };
const search = await explore('./scenario.mjs', { ...options, maxRuns: 50 });
if (search.firstFailure) {
  const confirmed = await replay('./scenario.mjs', search.firstFailure, options);
  const reduced = await minimize('./scenario.mjs', confirmed, options);
  await writeRunArtifact('./failure.interleave.json', reduced.run);
}
```

`explore`, `replay`, and `minimize` also accept a scenario object. Object targets run in the caller's process through `runOnce`. The caller must own its application's process and client lifecycles; a JavaScript callback that blocks the event loop cannot be interrupted there. File targets keep worker supervision for every search, replay, and reduction attempt.

Supervision is a lifecycle boundary for trusted code. On POSIX it terminates the worker's process group; on Windows it terminates the worker. Application-created detached processes remain the scenario's responsibility. `cleanup.complete` reports the owned database and harness resources, and failed creation recovery retains the generated database name. It is not a sandbox or a guarantee about arbitrary external effects.

## Budgets and outcomes

Run options require `databaseUrl`, an explicit administrator URL for a dedicated PostgreSQL test instance. Optional controls:

| Option | Default | Meaning |
| --- | ---: | --- |
| `plan` | `[]` | Explicit actor choices, then fair rotation among available actors |
| `maxSteps` | 100 | Maximum released command cycles per run |
| `timeoutMs` | 10,000 | Per-run execution deadline in milliseconds |
| `maxEvidenceBytes` | 8 MiB | Recorded evidence budget per run |
| `signal` | — | Caller cancellation |

Exploration additionally supports `maxRuns` (100), `totalTimeoutMs` (60,000), `maxCandidates` (10,000), `maxSearchBytes` (64 MiB), and `stopOnFailure` (true). Retained bytes count encoded result data and candidate keys, not process heap usage. `omittedRuns`, `violationCount`, and `hardFailureCount` remain visible when a completed result cannot fit the retained-data budget. A resource stop never becomes an exhausted-frontier claim.

Reduction supports `maxAttempts` (100) and `totalTimeoutMs` (60,000). Its initial exact verification counts as an attempt. It keeps the last verified matching failure; `locallyMinimal` applies to deleting explicit choices under the runner's fair fallback policy. It does not mean globally shortest execution or minimal application code.

Every reduction candidate must start with the verified PostgreSQL and Node.js versions and fixture identity. Fixture drift stops reduction before candidate actors start and reports an inconclusive result with a reason; the retained run remains the last compatible failure. Candidate schedules may still change the queries that application code issues.

A hard failure during reduction stops work and adds `attemptFailure` with its
outcome, reason and cleanup details. This summary belongs to the failed trial;
the retained `run` remains the last verified invariant violation. Never infer
that every reduction attempt cleaned up solely from `run.cleanup`.

Deadlines interrupt execution. Owned database creation and cleanup have separate bounds and are awaited, so teardown can extend beyond an execution deadline.

Run outcomes are `passed`, `violation`, `actor-error`, `incompatible`, `inconclusive`, and `harness-error`. Only an invariant assertion produces `violation`. Inspect `reason`, `cleanup`, and the search stop reason; passing sampled schedules does not prove race freedom.

## Replay and artifacts

Exact replay requires completed evidence and cleanup. It checks the PostgreSQL and Node.js versions, starting fixture identity, actor connection startups (including connections that sent no SQL), command identity, connection generation, query fingerprints, observed lock waits and transaction state. Startup values contribute to hashes; their raw values are not copied into the connection record. File source and broader environment binding are being added before release qualification.

Replay returns the actual new command summaries, selected actor observations and
invariant outcome. It does not require row counts, SQLSTATEs, return values or
the final assertion result to equal the original record. Randomness, external
services and undeclared process state remain outside the scheduling guarantee.
Minimization separately requires the original invariant failure fingerprint.

Use `{ mode: 'guided' }` explicitly to try the old actor order against changed queries. A guided run is separately labeled and is new evidence.

`parseRunArtifact`, `readRunArtifact`, and `writeRunArtifact` validate the versioned format. Writes are atomic and private by default, and refuse replacement unless `{ overwrite: true }` is supplied. Artifacts preserve SQL, selected observations, and messages; those fields may contain sensitive application data. The proxy does not record authentication exchanges or cancellation keys. Review evidence before sharing it; automatic text replacement would change replay identity.

`renderReport` and `writeReport` produce a [standalone offline viewer](reports.md).
`exportRegression` and `verifyRegressionExport` produce and validate a
[portable regression bundle](regressions.md) with explicit source selection and
integrity hashes. Report and export operations do not execute a scenario.
