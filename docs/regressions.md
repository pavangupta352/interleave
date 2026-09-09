# Portable regression exports

An Interleave regression export keeps one observed invariant violation together
with the trusted local scenario source needed to replay it. The export is a new
directory containing the exact run artifact, selected application files, npm
package metadata and lockfile, a tarball matching the recorded built Interleave runtime, a
separate runtime dependency lock, and a versioned integrity manifest.

Exports preserve application SQL and recorded observations verbatim. Those files
can contain credentials, personal data, or other private values. Review the
folder before sharing it; Interleave does not silently redact evidence and does
not label an export as free of secrets.

## Create an export

Start with a retained violation from `interleave run` or `interleave minimize`:

```sh
interleave export ./scenario.mjs ./failed-run.json \
  --project-root . \
  --out ./counter-regression
```

The recording must contain a file source identity captured through the built
CLI. Legacy recordings without that identity are rejected. A recording made
through the source TypeScript runtime must be recorded again after building,
using `node dist/cli.js run ...`; compiled and source runtimes have different
identities. Export compares the selected source, actual installed dependency
bytes, and built runtime against the recording before writing, then captures
them again after packaging to detect intervening changes.

This profile rejects recordings that share installed dependency instances
between the application and Interleave. Its separate installation directories
cannot preserve that module sharing. It does not rewrite the recording or
silently treat separate module instances as equivalent.

The scenario and project root are explicit trusted local inputs. The destination
must not exist. Interleave claims that directory exclusively and verifies its
contents before reporting success; it never replaces an existing folder, even
if another process creates it concurrently. If writing fails after that claim,
the error names the incomplete folder for inspection and recovery. Interleave
does not recursively delete a pathname that another process might have replaced.

Literal relative imports, re-exports, `import()` calls, and `require()` calls
from the scenario are parsed and collected recursively. Comments and strings
that resemble imports are ignored; type-only imports are omitted. ES modules
use exact file URLs with percent decoding. CommonJS `require()` and
`require.resolve()` preserve literal filenames and use Node's exact-file,
`.js`, then `.json` lookup order. Nested `package.json` files are retained so
relative modules keep their package scope. There is no extension guessing for
ES modules or `.js` to `.ts` substitution: exported source must work with the
standalone Node loader. The root `package.json` and `package-lock.json` are
always included. Declare files or directories read as data with repeated
`--include` options when recording:

```sh
interleave run ./test/race.mjs \
  --project-root . \
  --include migrations \
  --include fixtures/initial-state.json \
  --out ./failed-run.json

interleave export ./test/race.mjs ./failed-run.json \
  --project-root . \
  --out ./race-regression
```

Export inherits the recording's include declarations. An explicit export
`--include` list must produce the same recorded identity; it cannot add previously
uncaptured inputs to historical evidence.

Every include path is relative to the selected project root. Absolute paths,
`..` traversal, symbolic links, files outside the root, missing relative imports,
and oversized selections are rejected. Computed module imports are rejected;
use literal module specifiers. Package import aliases beginning with `#` and
bare self-references to the nearest package's own name when it declares
`exports` are unsupported, including nested package scopes; use relative file
imports for those local targets. Absolute/file URL imports, directory module lookup, native modules, and custom
module loaders are rejected by the inferred source profile. Use explicit file
paths for directory entry points. Dynamically generated code and external code
execution APIs also require a separately qualified profile. Includes declare
additional files; they do not prove that
arbitrary runtime file discovery is complete.

Application dependency locks must use npm lockfile version 2 or 3. Their direct
dependency declarations must match `package.json`; npm validates the virtual
dependency tree without installation or lifecycle scripts. Registry and HTTP(S)
tarball dependencies need integrity digests. Workspace, linked/local, and Git
dependency locks are not supported by this export profile. The current
qualification uses npm 11.5.1.

`--json` returns the destination, manifest fingerprint, selected files, and
replay commands as argument arrays. Human output prints the same paths and
commands. Export does not need a database connection and does not execute the
scenario.

## Programmatic API

```js
import {
  exportRegression,
  readRunArtifact,
  verifyRegressionExport,
} from '@pavangupta352/interleave';

const run = await readRunArtifact('./failed-run.json');
const result = await exportRegression(run, {
  scenarioFile: './scenario.mjs',
  projectRoot: '.',
  destination: './counter-regression',
  include: ['migrations'],
});

console.log(result.fingerprint);
await verifyRegressionExport(result.destination);
```

`exportRegression` accepts only a validated, file-bound `violation` whose cleanup
and recorded commands completed. Its selected runtime must match the recorded
built runtime. Packaging checks the actual tarball contents, including every
recorded runtime implementation file; an npm `files` rule that omits executing
code causes export to fail.

`verifyRegressionExport(directory)` reads inert JSON and ordinary files. It does
not import scenario code. It validates the manifest schema and fingerprint,
checks safe relative paths and expected file roles, rejects symbolic or
undeclared files, hashes every byte, re-validates the recorded run, and checks
the package/lock pairing and both virtual dependency trees with npm. It recomputes
the recorded source identity hashes, compares the copied application manifest
exactly, and checks the bounded gzip/tar payload against recorded runtime bytes.
Archive links, special entries, unsafe or duplicate paths, and oversized or
malformed payloads are rejected. Verification
does not install dependencies or execute application lifecycle scripts. A
successful verification establishes consistency between the bundled bytes,
manifest, and recorded source/runtime evidence. The manifest is not a signature and does not
establish who created or trusted the source.

Bundled runtime dependencies are outside this installation profile: nonempty or
enabled `bundleDependencies`/`bundledDependencies` declarations and every archive
path containing a `node_modules` component are rejected. Ordinary dependency
directories are created later by the separate lockfile installations. File reads
also reject special files, including FIFOs, without waiting for another process
to open them.

## Folder layout

```text
counter-regression/
├── manifest.json
├── run.json
├── package.json          # isolated runtime installation
├── package-lock.json     # runtime dependency installation lock
├── app/
│   ├── package.json
│   ├── package-lock.json
│   └── … selected scenario and application files
└── runtime/
    └── pavangupta352-interleave-<version>.tgz
```

`manifest.json` contains:

- schema and kind identifiers;
- the scenario entry point, scenario name, and source fingerprint;
- the original violation fingerprint and run artifact path;
- the selected package and lock paths;
- the bundled Interleave package name, version, path, and recorded runtime fingerprint;
- a sorted inventory of every copied file with its role, byte length, and
  SHA-256 digest;
- exact npm install and Interleave replay arguments; and
- a fingerprint over the complete manifest content except the fingerprint field
  itself.

The source fingerprint is the recording's selected-source component fingerprint.
It covers every copied application file, including package and lock metadata,
using paths relative to `app/`. The runtime fingerprint also comes from the
recording. The unchanged run artifact retains the complete source, installed
dependency, and runtime identity.

## Replay from a clean directory

Change into the exported folder and run the three argument arrays shown by the
export command or stored under `manifest.replay`. They perform these operations:

1. `npm ci --prefix app` installs the selected application's locked dependencies.
2. `npm ci` installs the hashed bundled runtime and its separately locked
   dependencies in the regression root. Application dependencies remain in
   `app/node_modules` according to the application lock.
3. `node node_modules/@pavangupta352/interleave/dist/cli.js replay
   <scenario-entry> run.json --project-root app` performs strict replay through
   that bundled runtime and inherits the recording's include declarations.

Scenario imports resolve their own locked application dependencies first. An
application that already depends on Interleave retains that locked dependency.
Every imported package must have been installed and captured when recording;
adding a previously missing import through the exported parent runtime does not
make an unsupported recording valid.
The replay executable always comes from the bundled runtime. Both original
lockfiles remain unchanged by the generated installation commands.

The runtime lock captures the graph resolved when export is created. Byte
verification does not establish that a future installation reproduces the
recorded installed dependency bytes. For example, files modified inside
`node_modules` before recording can match at export time but differ from a fresh
lockfile installation. Transitive versions and platform-specific optional
packages can also differ. Exact replay compares the resulting complete identity
and rejects such differences before scenario execution. A successful export is
not a claim that the folder has already been installed or replayed; clean-install
replay is a separate qualification step.

The installed export parser bundles TypeScript; its Apache 2.0 license and third
party notices are shipped under `dist/vendor/typescript` inside the runtime.

Set `TEST_DATABASE_URL` to a dedicated PostgreSQL administrator database before
the replay, or add `--database-url` to the replay command. Exact replay rejects a
changed query stream or incompatible PostgreSQL environment; it never falls back
to guided execution.

Run `verifyRegressionExport` before installing or replaying a folder received
from elsewhere. Verification does not make untrusted application code safe to
execute. Inspect the selected source and dependency lifecycle scripts before
running npm or Interleave.
