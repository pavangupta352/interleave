# Cancellation, COPY and cursors

Status, 25 October 2026: cancellation routing and streaming COPY are
implemented (sections 1 and 2; see [cancel requests](../compatibility.md#cancel-requests)
and [streaming COPY](../compatibility.md#streaming-copy) for what was checked).
Cursors that wait on Flush are still refused with an explicit `Unsupported
profile` error, so an application that uses them stops before any evidence is
recorded. Each item has integration tests against real PostgreSQL and a real
driver.

## 1. Cancellation routing

Drivers send a CancelRequest when a query times out or the caller aborts it:
Postgres.js `query.cancel()`, psycopg `Connection.cancel()`, pgjdbc
`Statement.setQueryTimeout`, libpq `PQcancel`. The request is the first and only
packet on a new connection: 16 bytes holding the code 80877102, the backend
process ID and the secret key that the server sent in BackendKeyData. The proxy
forwards BackendKeyData to the client unchanged, so the client already holds the
real values.

Contract:

- The proxy accepts a CancelRequest on an actor endpoint and forwards the packet,
  byte for byte, to PostgreSQL over a fresh upstream connection made with the
  run's transport policy: plaintext, or SSLRequest followed by verified TLS
  through `connectPostgresUpstream`. It then closes both sockets. The secret key
  is neither retained nor recorded.
- A request is forwarded only when its process ID belongs to a live session of
  the same actor. Any other request is dropped and recorded as rejected.
- PostgreSQL cancels whatever that backend is executing when the request arrives.
  If the scheduler is still holding the actor's next command, the backend is
  idle, PostgreSQL ignores the request, and the held command runs when released.
  A slow network can produce the same outcome, so this is a real ordering, not an
  artifact of the proxy.
- Evidence records each forwarded or rejected request with its time, the target
  lane, and the step running on that backend at that moment, if any. A cancelled
  step completes with SQLSTATE 57014 like any other error.
- Cancellation timing comes from the application's own timers. Exact replay
  compares cancel events by target lane and by the step they hit; hitting a
  different step is `incompatible`. The documentation says that replays of a
  cancellation are timing dependent.
- The new `cancels` array needs a new artifact schema version.

First tests: Postgres.js `query.cancel()` against a statement that sleeps, a
psycopg actor through `processActor`, a request for another actor's backend, and
a cancel that arrives while the scheduler holds the command.

## 2. Streaming COPY

`COPY ... FROM STDIN` and `COPY ... TO STDOUT` are used by bulk loaders such as
`pg-copy-streams`, psycopg's `copy()` and pgjdbc's `CopyManager`.

Contract:

- `COPY ... FROM STDIN`: the released unit starts the copy and PostgreSQL answers
  with CopyInResponse. While that unit is in flight, the proxy forwards the
  client's CopyData, CopyDone and CopyFail frames upstream at once, with
  backpressure, as part of the same unit rather than as new units. The unit
  completes at ReadyForQuery.
- `COPY ... TO STDOUT`: CopyOutResponse, CopyData and CopyDone stream to the
  client and the unit completes at ReadyForQuery.
- Evidence records the row count from the `COPY n` command tag and the byte count
  and SHA-256 of the data copied in either direction, so exact replay can check
  that the same data moved.
- Copy frames inside an extended cycle are handled the same way. CopyBothResponse,
  which only replication uses, stays unsupported.

First tests: `pg-copy-streams` in and out, a CopyFail mid-stream, a large copy that
exercises backpressure, and two actors copying into one table under lock waits.

## 3. Fetch stages for cursors

`pg-cursor`, `pg-query-stream` and Postgres.js `cursor()` read large results in
batches: an Execute with a row limit, then Flush, then PortalSuspended from the
server, repeated until the cursor closes and a Sync ends the cycle.

Contract:

- A new opt-in protocol profile, `fetch-stages-v1`, schedules each Execute and
  Flush batch as a stage of its cycle, in the way `describe-flush-v1` schedules
  metadata and execution today. Other actors' units may run between batches.
- Evidence records the rows returned by each stage and whether the portal was
  suspended or completed. Exact replay compares the stage sequence and row
  counts.

First tests: `pg-cursor` reading in batches while another actor updates the same
rows, and a cursor closed early.

## Not planned here

Pipelined queries that end each cycle with Sync already work: queued cycles on
one connection become separate units, released in order, and a Postgres.js test
covers it. Pipelines that wait on Flush fall under fetch stages. Logical and
physical replication stay out of scope.
