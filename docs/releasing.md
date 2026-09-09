# Preparing a release

Interleave has no stable release yet. The [acceptance checklist](plans/implementation.md)
tracks the remaining application qualification and publication gates. Preparing
archives is one step in that work.

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

To check a supplied archive against a fresh pair of builds, use its path with
`--archive` and choose another new output directory. To prepare an existing version
tag, replace `--ref` with `--tag vX.Y.Z`; the tag must match both package and lockfile
versions. The tool does not create tags or publish packages.

Version-tag CI runs the existing PostgreSQL, pgvector and browser matrix from the
tagged checkout. Only after all three job families succeed can the separate assets
job prepare and upload its candidate. Those matrix jobs use their own builds;
the candidate archive has the installed acceptance recorded in its manifest.

Before distribution, complete the release checklist, verify the tagged source and
canonical archive's user workflow, and publish that exact archive. Verify fresh
registry and GitHub downloads against the retained hashes, then run the public
installation instructions. Checksum verification establishes byte agreement; it
does not replace execution or source review.
