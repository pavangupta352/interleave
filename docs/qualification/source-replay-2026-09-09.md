# Source-bound replay qualification

Executed on 9 September 2026 with Node.js 24.7.0, PostgreSQL 16.13 and
node-postgres 8.23.0. This is a development milestone, not a stable release.

| Check | Result |
| --- | --- |
| Type checking and production build | Passed |
| Complete unit and real PostgreSQL suite | 417 tests in 34 files passed; 73.30 seconds |
| Offline report | 12 checks in each of Chromium, Firefox and WebKit, at desktop and mobile sizes |
| Publishable package | 184 files; CLI, library, static demo entries and third-party notices present |
| Package exclusions | Private working files, tests and installed dependencies excluded |

File-run tests capture the selected local module graph, declared data paths,
actual installed dependencies and runtime before import. They reject changed
source, lock metadata and data inputs; detect changes during execution; inherit
portable source selections; and distinguish guided runs from exact replay.
Independent native Node probes verify module resolution against what Node
actually loads, including CommonJS directory and ancestor dependency behavior.

The supervisor owns source, Node and PostgreSQL identity. Tests cover worker
message collisions, known version/profile mismatches before application import,
process termination, cancellation, hard-failure preservation and exact owned
database cleanup. These are lifecycle and evidence guarantees for trusted local
code, not a sandbox.

The auxiliary connection profile was tested through the real proxy, runner,
replay and reduction. Queryless sessions have their own startup identities and
connection generations. A second live command producer is rejected. A real lock
wait test confirms that closing a monitor does not remove the actor's still-live
query backend from blocker tracking.

Production export tests record a real failure through the built CLI, export
unchanged application files and declared SQL inputs, install the bundle in a
separate directory, and exactly replay the same failure. Separate tests preserve
application pg 8.11.5 and runtime pg 8.23.0, retain their original locks and
re-export through the installed production parser.

Export verification compares the historical source manifest with copied bytes
and checks the built implementation inside the actual npm archive. Tests cover
changed source/runtime, omitted implementation files, altered archive payloads,
links, oversized/truncated archives, real Unicode/PAX paths, bundled dependency
rejection and special-file rejection without blocking.

The supported export layout installs application and runtime dependencies
separately. Recorded shared dependency instances are rejected until that layout
can preserve them. Bundle integrity verification does not establish that a
future registry installation reproduces locally modified dependencies or a
different platform's optional packages. The production tests above record the
installations that were actually replayed; every later replay still checks its
own inputs.

The [native PostgreSQL matrix](postgresql-native-matrix-2026-09-09.md) records
separate PostgreSQL 16/17/18 results. Additional drivers, extensions, historical
bug/fix pairs, comparative measurements and release distribution remain open
qualification gates.
