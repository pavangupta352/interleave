# Preparing a release

A release is published only after its exact CI-built archive has passed consumer
acceptance on each qualified Node.js version. The
[implementation plan](plans/implementation.md) tracks remaining qualification work.
Preparing archives is one step in a release.

Use a clean source checkout on POSIX with Git, tar, Node.js 22.18+ and npm. The
canonical CI packaging environment uses Node.js 24.7.0 and npm 11.5.1. Select a
full, committed source identity and a new output directory:

```sh
release_commit=$(git rev-parse HEAD)
node scripts/prepare-release.mjs --ref "$release_commit" --out .local/release-candidate
node scripts/prepare-release.mjs --verify .local/release-candidate
```

Preparation extracts the selected Git tree twice, installs its locked development
dependencies, builds each copy, and compares the original npm archive bytes and
file modes. It checks package contents, compiled modules, documentation, examples
and license notices. Then it installs that same archive in a fresh directory and
checks the public import, CLI version, help and scaffold. Local uncommitted changes
are outside the selected source.

The output contains the npm archive, committed source archive, installed consumer
lockfile, release manifest and `SHA256SUMS`. Keep their original bytes together.
The manifest records source and tool versions, file hashes and the checks that
actually ran. Read the manifest's acceptance scope: these installed checks do not
execute PostgreSQL scenarios. The complete user workflow still requires acceptance
against the same archive.

The [September 9 candidate qualification](qualification/canonical-package-workflow-2026-09-09.md)
records that later installed database workflow for one exact archive on Node.js
22.18.0 and 24.7.0, including offline export installation and exact replay. It
does not establish acceptance for a future candidate.

To check a supplied archive against a fresh pair of builds, use its path with
`--archive` and choose another new output directory. The comparison is of compressed
bytes, which depend on the machine: Node.js's bundled zlib picks CPU-specific code,
so the v0.3.0 archive built on GitHub's Linux x64 runner and a rebuild on Apple
silicon hold byte-identical tar streams but differ once compressed. Run `--archive`
on the platform that built the archive, or compare the output of `gzip -dc` for
both archives. To prepare an existing version
tag, replace `--ref` with `--tag vX.Y.Z`; the tag must match both package and lockfile
versions. The tool does not create tags or publish packages.

Version-tag CI runs the PostgreSQL, pgvector, managed CLI, verified TLS, Python, Ruby,
PHP, Go and Java actor, TypeORM, Prisma, Sequelize/Knex/MikroORM, browser, Windows
and macOS matrix from the tagged checkout. Each job with a Node.js matrix runs
22.18.0, 24.7.0 and 26.12.1, the last with npm 12.2.1. Only after every required job
family succeeds can the separate assets job prepare and upload its candidate. Those matrix jobs use their own builds;
the candidate archive has the installed acceptance recorded in its manifest.

Before distribution, complete the release checklist, verify the tagged source and
canonical archive's user workflow, and publish that exact archive. Verify fresh
registry and GitHub downloads against the retained hashes, then run the public
installation instructions. Checksum verification establishes byte agreement; it
does not replace execution or source review.

## Publishing to npm

Publishing the GitHub release starts the [publish workflow](../.github/workflows/publish.yml)
on the release's tag. It requires a successful CI run of the tagged commit, downloads
the release's npm archive and `SHA256SUMS`, checks the hash, the package name and
that the version matches the tag, and then runs the release script with `--tag`: the
archive must hold exactly the package that two fresh builds of the tagged source
produce, because a checksum file from the same release cannot vouch for it. The
comparison uses the uncompressed tar streams, since compressed bytes depend on the
machine, as described above for `--archive`. A separate job, the only one with npm's
OIDC permission, downloads the archive again, checks it against the verified hash
and publishes it with npm trusted publishing, so no npm token is stored. It then
checks that the registry's integrity hash matches the archive. A prerelease version
goes to the `next` dist-tag; a version older than npm's `latest` is refused, to be
published by hand with an explicit tag. To publish an existing release, start the
workflow on its tag, so that the provenance names the tagged commit:
`gh workflow run publish.yml --ref vX.Y.Z`.

npm accepts a trusted publisher only for a package that already exists. A
maintainer therefore publishes the first version by hand (`npm login`, then
`npm publish <archive> --access public` with the accepted archive) and then adds the
trusted publisher in the package settings on npmjs.com: GitHub Actions, user
`pavangupta352`, repository `interleave`, workflow `publish.yml`, environment `npm`,
with direct publishing (`npm publish`) allowed. npm 12 can make the same setting
from the command line, with a security-key approval:
`npm trust github @pavangupta352/interleave --file publish.yml --repo pavangupta352/interleave --env npm --allow-publish`.
Until the package exists, the workflow checks the archive and skips the publish.
Version 0.3.1 was the first one published by hand.
