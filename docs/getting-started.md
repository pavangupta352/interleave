# Getting started

This guide gets you from an installed release, or from a source checkout, to a
real failure and an offline report. Use the scoped package name
`@pavangupta352/interleave`; the unscoped npm name belongs to an unrelated package.

The commands below use a POSIX shell, Git, Node.js 22.18+ and npm. Docker is needed
for `--docker`; you can instead supply a dedicated PostgreSQL test server.
The [compatibility guide](compatibility.md) records the exact qualified versions
and platform limits.

## Install a release

Scaffold a scenario in a new directory, then install Interleave and the
node-postgres driver the scaffold uses:

```sh
npx --yes @pavangupta352/interleave init interleave-race
cd interleave-race
npm install --save-dev --save-exact @pavangupta352/interleave pg@8.23.0
unset TEST_DATABASE_URL
npx --no-install interleave doctor --docker
npm run race -- --docker        # exits 1: the scaffold deliberately loses an increment
npx --no-install interleave report failure.interleave.json --out report.html
```

Every [GitHub release](https://github.com/pavangupta352/interleave/releases) also
carries the npm archive and `SHA256SUMS`. To install from the archive instead,
download both, check the hash, then scaffold and install from the file:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
interleave_archive="$PWD/pavangupta352-interleave-0.2.0.tgz"
npx --yes --package "$interleave_archive" interleave init interleave-race
cd interleave-race
npm install --save-dev --save-exact "$interleave_archive" pg@8.23.0
```

Use an absolute path: npm resolves a relative file path against the nearest
enclosing project, not the current directory. `npx` also needs `--package` for a
file; `npx ./archive.tgz` tries to execute the archive. Keep `interleave_archive`
set: the [CI guide](ci.md) passes the same file to `export`. Continue with the
[application guide](application-guide.md) to test your own operation. The rest of
this page builds from source.

## Build the checkout

From the directory where you keep projects:

```sh
git clone https://github.com/pavangupta352/interleave.git
cd interleave
npm ci
npm run build
node dist/cli.js --version
node dist/cli.js --help
```

Stay in this checkout for the source commands below. The executable is
`node dist/cli.js`. The build is required before running it; the checkout does
not install a global `interleave` command.

## Choose your PostgreSQL server

### Let Interleave manage a local server

With the Docker engine running:

```sh
unset TEST_DATABASE_URL
node dist/cli.js doctor --docker
```

`--docker` starts one owned server for the command and removes it and its volumes
afterward. It binds a random port on `127.0.0.1`. Each application execution
creates and removes a generated database inside that server. Docker progress
goes to stderr, so `--json` stdout stays machine-readable.

The native default image is `postgres:16`. To select another supported major:

```sh
node dist/cli.js doctor --docker --postgres-image postgres:17
```

The allowed image names are `postgres:16`, `postgres:17`, `postgres:18`, and
`pgvector/pgvector:0.8.6-pg17-bookworm`. The explicit
`postgresql17-pgvector0.8.6-v1` fixture profile selects the vector image by
default. A native image cannot supply that extension profile. Exact replay still
requires compatible captured PostgreSQL versions and fixture inputs; selecting
another major does not migrate an old artifact.

The first invocation may download the selected image. `--docker` rejects
`--database-url` and any nonempty `TEST_DATABASE_URL`, so server selection is
explicit. `--postgres-image` requires `--docker`. Report, export and init do not
start servers.

### Use an existing dedicated test server

The server must permit Interleave to create and drop databases. Use the
administrator database URL of a dedicated test instance, not an application or
production database. Replace the values in this illustrative URL:

```sh
export TEST_DATABASE_URL='postgresql://<user>:<password>@<host>:<port>/<admin-database>'
node dist/cli.js doctor
```

You may pass `--database-url` instead of the environment variable. Omit
`--docker` for every command using this route. Interleave cleans up its generated
databases and leaves your server running. `doctor` performs two real parameterized
queries through proxies and checks cleanup; it does not qualify all features of
your application's driver or schema.

## Record a deliberate failure

The remaining examples use Docker. For the dedicated-server route, remove
`--docker` and retain the environment variable. From the built checkout:

```sh
if node dist/cli.js demo neveroversell --docker --out failure.interleave.json; then
  interleave_status=0
else
  interleave_status=$?
fi
test "$interleave_status" -eq 1
node dist/cli.js report failure.interleave.json --out failure.html
node dist/cli.js demo neveroversell --docker --safe
```

Run these in order and stop if a check fails. The unsafe demo exits 1 because
two purchases exceed the one-unit capacity. The status check deliberately rejects
errors, incompatibility and incomplete runs. Report creation and the safe demo
exit 0. Open `failure.html` in your browser to inspect the actual SQL, releases,
completions, invariant and observed waits. The HTML needs no server or database.

Files are private by default where the operating system supports it. They can
contain SQL, errors and returned application observations. Review their contents
before sharing. Keep the JSON artifact if you need replay.

Output destinations must be new. Use a new name on later runs, or add `--force`
when you intend to replace an artifact or report. `init` and `export` always
require unoccupied destinations; they do not support replacement.

## Install a source build into an application

This route builds an ordinary local npm archive. It is useful for development;
it is not a signed release or the full [release qualification](releasing.md).
From the built Interleave checkout, in the same shell:

```sh
mkdir -p .local/dev-package
interleave_archive_name=$(npm pack --silent --pack-destination .local/dev-package)
interleave_archive="$PWD/.local/dev-package/$interleave_archive_name"
node dist/cli.js init ../interleave-race
cd ../interleave-race
npm install --save-exact "$interleave_archive" pg@8.23.0
npx --no-install interleave --version
```

Choose a new sibling directory if `interleave-race` already contains any scaffold
files. `init` creates `package.json`, `scenario.mjs` and a README; it never installs
dependencies. The installation above replaces the scaffold's version-range
dependency with the actual archive path and records it in your lockfile. Keep
that original archive if you want a portable export later. Repacking after source
or package changes does not produce a substitute for its locked bytes.

Installed examples use `npx --no-install interleave` so they run your application's
local executable without fetching a missing package. `npm run race` also finds
the local executable automatically. Run the scaffold:

```sh
unset TEST_DATABASE_URL
npx --no-install interleave doctor --docker
if npm run race -- --docker; then
  interleave_status=0
else
  interleave_status=$?
fi
test "$interleave_status" -eq 1
npx --no-install interleave report failure.interleave.json --out scaffold.html
```

The scaffold deliberately loses an increment. Its script already supplies
`--out failure.interleave.json`; do not append another `--out`. For intentional
replacement, use `npm run race -- --docker --force`. For a different output name,
call the executable directly:

```sh
npx --no-install interleave run scenario.mjs --docker --out another-failure.json
```

This command also exits 1 when it finds the violation. Continue with the
[application guide](application-guide.md) to call a separate business module,
then [check a repair in CI](ci.md). If a step stops, use
[troubleshooting](troubleshooting.md) before increasing limits or changing profiles.
