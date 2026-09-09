# Managed local PostgreSQL qualification

This record covers the explicit `--docker` CLI path implemented in
`246d37c6eac7d33bda1f49cddc4f8be5cf362bc9`, the output/parent interruption fixes in
`5a0aa4f641d0ca12d51db5f80ec8e461bb5ec0ad`, and the qualification runner's POSIX
process-group isolation in `569f7887caffa528c6721f945136af7cebde64d4`.
The last commit changes the test harness; the packaged runtime remains the one
from `5a0aa4f`.

## Executed scope

Local execution used Node.js 24.7.0 on macOS arm64 with Docker Engine 28.3.3.
The commands used the actual Docker engine, original PostgreSQL entrypoints,
the installed drivers and real generated databases. Boundary tests additionally
controlled Docker command replies to exercise failures without needing a daemon.

| Managed image | Actual server | Doctor fixture identity |
| --- | --- | --- |
| `postgres:16` | 16.15 | `postgresql16-native-v1` |
| `postgres:17` | 17.11 | `postgresql17-native-v1` |
| `postgres:18` | 18.6 | `postgresql18-native-v1` |
| `pgvector/pgvector:0.8.6-pg17-bookworm` | 17.11, vector 0.8.6 | `postgresql17-pgvector0.8.6-v1` |

Doctor checks two real parameterized queries and their returned values. Its
human output was checked against the environment in its saved artifact. The
explicit vector fixture profile installs vector only inside doctor's generated
database; native defaults remain unchanged. Both an explicit vector image and
the image selected automatically by the explicit vector profile passed.

The built workflow passed nine tests covering 14 CLI commands. A fresh installed
archive of `246d37c` then passed eleven tests covering 16 commands, including:

- All four doctor images and the implicit vector image selection.
- Packaged unsafe and safe neveroversell demonstrations, with actual invariant
  violation/success and exits 1/0. These remain constructed owned examples.
- Source-bound record, exact replay and failure-preserving reduction of an
  ordinary counter scenario across separate freshly provisioned servers.
  Four application commands and the original invariant failure were retained;
  reduction removed ordering instructions, not SQL.
- Offline report generation without starting a server, and an existing-output
  refusal that left the original artifact unchanged while cleaning up its server.
- SIGINT and SIGTERM during actual setup, returning 130 and 143 after cleanup.
- A closed progress pipe during real startup, returning a handled command error
  while removing its owned server.

## Review findings and verification

Independent review identified a stream-error precedence defect in minimization:
aborting verification after a broken progress pipe returned the verification
status 4 instead of command-output failure 2. A real failing test observed that
exact behavior, then passed after the catch priority changed. A fresh installed
archive of `5a0aa4f` passed the same real record/minimize regression. The original
archive and its results were retained.

Review also identified that terminating the qualification wrapper could leave
its runner behind, and that terminal Ctrl-C could bypass cooperative cleanup by
signaling the runner's entire foreground process group. Direct SIGINT/SIGTERM and
group-delivered SIGINT regressions first failed, then passed with a stop request,
owned-child settlement and POSIX process-group isolation. An actual parent
SIGTERM during a managed record returned parent/CLI exits 143/143. An actual
group-delivered SIGINT returned 130/130. The exact servers and both recorded PIDs
were absent afterwards.

The control-plane suite passed 19 cases covering unavailable Docker, malformed
or lost create replies, inconsistent returned IDs, name collisions, cancellation
during creation, initialization-only readiness, non-loopback ports, changed
ownership, failed or uncertain cleanup, and generated-credential redaction.
The CLI cases also cover option conflicts and commands that never use Docker.
The ordinary Docker-free unit suite passed 540 tests in 28 files before the later
stream/supervisor regressions; the affected CLI/control-plane/supervisor suites
then passed 52 tests in three files, followed by all three final supervisor
signal cases. Typecheck and build passed. These are separately executed scopes,
not a claim that every final combined release job has run.

## Archive and cleanup identity

Both newly prepared archives were installed with npm scripts disabled. Every one
of their 271 declared package files was compared byte-for-byte with its original
archive, including `dist/cli/managed-postgres.js`; archive integrity also matched
the generated consumer lock. They are development qualification artifacts, not
published releases.

| Runtime source | Archive bytes | SHA-256 |
| --- | ---: | --- |
| `246d37c` | 1,798,175 | `0e8928bf4ed7e93b22b4fc91de87427d1587c55a48da497b75e4a353ce28b1dd` |
| `5a0aa4f` | 1,798,184 | `dccb5075bccb836208a0c093f9f40dbf43e3f8e92020c8e58c6ccf9f1cb35241` |

The retained command journals contain 41 CLI process records and 39 distinct
owned server names, including deliberate failing cases. Fresh verification found
all 41 recorded CLI PIDs absent and checked every recorded server name plus every
available full container ID for actual Docker absence. Five closed-pipe cases
have name-based absence evidence because their readiness output was deliberately
closed before the independent observer could capture an ID. An initial standalone
doctor's separate server name was also checked; no PID/full-ID inventory is
claimed for that preliminary command. Raw command outputs, selected image IDs,
archive inventories and verification results are retained in the owner's local
qualification evidence.

## Repeating qualification and remaining limits

From a source checkout with dependencies installed and Docker running:

```sh
npm run test:managed
```

This dedicated suite owns its servers and accepts no inherited administrator URL.
The ordinary `npm run test:unit` path does not require Docker. Two managed CLI CI
jobs, for Node 22.18.0 and 24.7.0, are now required before release asset preparation;
the final combined branch CI had not run when this record was written.

This is local Docker setup qualification, not managed cloud PostgreSQL, upstream
TLS, native Windows, cross-version exact replay, or a broader driver/pool claim.
Each application artifact still records application database cleanup separately;
container cleanup is established by the enclosing command's lifecycle and its
qualification journal. An unavailable daemon or ownership mismatch remains a
command failure, never successful cleanup evidence.
