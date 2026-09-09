# Contributing

Interleave is under active development. Start with a small, reproducible case:
what application behavior you expected, which PostgreSQL and driver versions you
used, and what the recorded outcome shows. Review artifacts before attaching them;
SQL and selected observations can contain private application data.

For first use, follow [getting started](docs/getting-started.md) and the
[application guide](docs/application-guide.md). [Troubleshooting](docs/troubleshooting.md)
explains which environment, outcome and cleanup details make a useful report.

Discuss substantial protocol or replay-profile changes in an issue before writing
a large patch. A new supported feature needs a clear boundary, a real PostgreSQL
regression that fails without the fix, and an honest explanation of what remains
outside the profile. Reduced scheduler choices must not change application SQL.

## Local checks

Use Node.js 22.18+ and Docker, then run:

```sh
npm ci
npm run check
```

The test harness starts and removes its own PostgreSQL container. To use an
existing server, set `TEST_DATABASE_URL` to a dedicated administrator database;
tests create and remove uniquely named databases there. Never use a production
server. `npm run test:unit` needs neither Docker nor PostgreSQL.

Useful references:

- [Library API](docs/api.md) and [CLI](docs/cli.md)
- [Architecture and execution boundaries](docs/architecture/specification.md)
- [Implementation and release gates](docs/plans/implementation.md)
- [Preparing and verifying release archives](docs/releasing.md)
- [Offline evidence reports](docs/reports.md) and [regression bundles](docs/regressions.md)
- [Code of conduct](CODE_OF_CONDUCT.md) and [private security reporting](SECURITY.md)

Keep fixes focused, preserve third-party notices, and describe the behavior before
and after the change. Include the checks you actually ran. A passing bounded
exploration is not proof that an application is free of races. Do not add benchmark,
compatibility or historical-bug claims without reproducible evidence.

Contributions are distributed under the repository's MIT license. Treat other
contributors with respect; critique the work with concrete examples.
