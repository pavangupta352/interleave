# Postgres.js metadata-stage qualification — 9 September 2026

Status: local development qualification of the protocol core, programmatic runner, packaged CLI, offline export and report viewer. The measured database combination is **Postgres.js 3.4.9, Node.js 24.7.0, PostgreSQL 16.13**, plaintext transport, and one physical connection per actor. The repository pins the driver and its integrity in the development lockfile. This record does not extend the existing node-postgres server matrix to every Postgres.js feature or platform.

## Select the profile

```js
const options = {
  databaseUrl: process.env.TEST_DATABASE_URL,
  protocolProfile: 'describe-flush-v1',
};
```

The default `sync-cycle-v1` continues to require complete extended cycles through Sync. Postgres.js can send Parse, statement Describe, and Flush, wait for PostgreSQL's parameter metadata, then send Bind, Execute, and Sync. Waiting for the entire cycle before forwarding Parse would prevent that exchange from progressing. PostgreSQL documents the separate [extended-query messages and Sync recovery](https://www.postgresql.org/docs/16/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY).

The selected profile uses two explicit scheduler gates:

| Stage | Original messages released | Actual completion |
| --- | --- | --- |
| `describe` | Parse, statement Describe, Flush | ParseComplete, ParameterDescription, then RowDescription or NoData; or a real ErrorResponse |
| `execute` | Matching Bind, unlimited Execute, Sync | ReadyForQuery with command summaries and transaction state |
| `recover` | Sync only after metadata error | ReadyForQuery, retaining the original error |
| `complete` | Simple Query or ordinary whole extended cycle | ReadyForQuery |

Postgres.js may send its continuation after ParameterDescription while RowDescription is still in transit. The proxy buffers those actual bytes until terminal metadata arrives and the scheduler releases execution. It neither guesses parameter identity at the prefix gate nor synthesizes metadata. Prefixes can acquire real table locks; metadata completion does not imply that those locks have been released.

Every released stage consumes one `maxSteps` choice. Version 2 artifacts link the continuation to its actor, connection generation, logical cycle and prefix ordinal. Successful completion requires every logical cycle to close. Metadata evidence contains parameter and column counts, result shape, or an error. It has no invented transaction status or affected-row count.

Exact replay checks the prefix before releasing it, then checks the real continuation before forwarding Bind. Changed SQL is rejected before Parse. Changed parameter values are rejected at the second gate, after actual metadata may already have been obtained. Backend metadata OIDs are not equality inputs: a test creates fresh tables with different relation OIDs and confirms matching replay identity. Frontend-supplied type OIDs remain inputs; portability of application custom types is a separate qualification.

## Close the driver on interruption

Use both the actor's AbortSignal and `finally` to close the public client:

```js
import postgres from 'postgres';

async function actor({ connectionString, signal }) {
  const sql = postgres(connectionString, { max: 1, ssl: false });
  const abort = () => { void sql.end({ timeout: 0 }); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    await sql.begin(async tx => {
      await tx`UPDATE counter SET value = value + ${1} WHERE id = ${1}`;
    });
  } finally {
    signal.removeEventListener('abort', abort);
    await sql.end({ timeout: 1 });
  }
}
```

The zero-timeout close uses Postgres.js's [public client shutdown API](https://github.com/porsager/postgres/tree/v3.4.9#sqlend-timeout). Prompt abort handling matters for interrupted transactions. Postgres.js 3.4.9 waits for ReadyForQuery before rejecting a protocol ErrorResponse. If its connection closes first, `sql.begin` can attempt automatic rollback after the driver has cleared its socket and raise an uncaught exception. A `finally` block alone does not prevent this sequence.

On interruption, Interleave stops forwarding further frontend commands immediately. It sends its existing failure notification and retains a bounded socket drain of at most 100 ms so public driver shutdown can settle pending writes before physical close. It does not send cleanup SQL or fabricate Sync or ReadyForQuery. Both prompt client shutdown and this drain were needed in the reproduced tests. Interrupted transactions without abort-aware client closure remain outside this qualified lifecycle. File targets provide a separate worker containment boundary; in-process scenario objects share the caller's process.

## Measured checks

Both default preparation and explicit `prepare: false` were exercised through the actual public API. Type discovery was enabled in its dedicated checks; other phase tests explicitly disabled it to isolate the command under test.

| Area | Evidence |
| --- | --- |
| Parameters and metadata | Distinct real INSERT gates; every transport split; delayed actual RowDescription; null, text, integer and binary bytea parameters |
| Prepared state | Generated-name normalization, actual acknowledgements, cached queries with different values, and ordinary cached/new-query Promise.all traffic |
| Transactions | Commit, duplicate-key SQLSTATE 23505, Parse SQLSTATE 42601 inside and outside transactions, original Sync recovery, rollback and subsequent queries |
| Locks | Real relation lock while Parse is blocked; prefix lock retained until original Sync; runner-observed waits separately at metadata and execution stages with fresh exact replays |
| Replay | Fresh relation OIDs with stable fixture and command identity; changed SQL before prefix release; changed parameter before Bind release; explicit guided reruns |
| Reduction | A constructed lost-update invariant remains reproduced while explicit schedule choices are removed |
| Bounds and cleanup | Step exhaustion after metadata, cumulative prefix/continuation byte cap, oversized actual Bind rejected before INSERT, blocked-Parse close, pending continuation close and exact owned database cleanup |
| Interrupted transactions | Contained child processes, both preparation settings, three repeated Bind-drift and step-limit cases each, plus protocol-buffer failure; original immediate-close behavior reproduced the driver crash |

The final local verification passed **127 tests in nine files**, TypeScript checks, and the production build. The focused tests are [protocol stages](../../test/protocol-staged.test.ts), [real driver/proxy](../../test/proxy-staged.integration.test.ts), [programmatic runner/replay/reduction](../../test/postgresjs-runner.integration.test.ts), and [contained shutdown](../../test/postgresjs-shutdown.integration.test.ts), alongside the existing protocol, proxy, auxiliary, profile and schema tests. This is constructed compatibility evidence, not a reproduced historical application bug or a claim of race freedom.

## Packaged workflow and report

The [installed-package test](../../test/postgresjs-export.integration.test.ts)
installs an actual Interleave tarball and Postgres.js 3.4.9 in a fresh app. Its
public `defineScenario` entry loads the unchanged [counter example](../../examples/postgresjs/scenario.mjs).
The built CLI records eight releases: four real descriptions and four
executions, leaving the deliberately unsafe counter at one. Its source manifest
includes the actual driver and shared app/runtime dependency topology.

The test exports that failure with its original lock and archives, removes the
original archive directory, then runs the bundled installer with an unavailable
registry and a fresh private offline cache. Strict replay from the restored app
retains matching source, fixture, stage, query and failure identities with
complete cleanup. The four original app files and deliberately noncanonical
JSON whitespace remain byte-for-byte unchanged. This local qualification passed
in 16.85 seconds; it is not a performance comparison.

The report checks use separate actual source-bound neveroversell and Postgres.js
records. Chromium, Firefox and WebKit each passed 12 legacy and eight staged
checks at 1440×1000 and 390×844. The staged checks distinguish description
metadata from execution results, verify the prefix link, reject contradictory
stage imports without losing the current record, switch between both schema
versions, and download the exact staged object. They found no runtime errors,
external requests or horizontal overflow. Desktop and mobile screenshots were
also visually inspected.

## Retained boundaries

The qualified early-Flush grammar is exactly one Parse/statement Describe/Flush followed by matching Bind/unlimited Execute/Sync, or Sync-only error recovery. Successful metadata-only Sync, arbitrary interleaved early-Flush prefixes, cursor suspension, COPY and cancellation routing remain unsupported. `max: 1` avoids competing command-producing connections; the independent queryless auxiliary profile does not permit simultaneous command sessions. TLS termination and application extensions require their own profiles.

The driver and proxy execute original SQL and forward original query/result frames. No driver internals, application business logic, clocks or parameter values were patched. The constructed counter and packaged workflow establish compatibility for this measured use; they do not qualify every Postgres.js feature or constitute a historical driver defect.
