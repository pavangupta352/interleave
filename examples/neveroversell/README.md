# neveroversell integration

This example runs real application code from
[neveroversell](https://github.com/pavangupta352/neveroversell) through
Interleave and a real PostgreSQL server. It demonstrates a deliberately unsafe
benchmark beside neveroversell's production reservation API.

This is an owned, constructed demonstration. It is not evidence of a historical
production defect in neveroversell or another application.

## What the example proves

The unsafe scenario starts with one unit and sends two one-unit purchases through
the original `naiveBuy` function with `gapMs: 0`. Its explicit schedule releases
both transactions' availability reads before either insert or counter update:

| Step | Actor | Application command |
| ---: | --- | --- |
| 1 | Alice | `BEGIN` |
| 2 | Bob | `BEGIN` |
| 3 | Alice | Read availability |
| 4 | Bob | Read availability |
| 5–7 | Alice | Insert order, increment sold, commit |
| 8–10 | Bob | Insert order, increment sold, commit |

Both calls return `sold`. The invariant then observes `total=1`, `sold=2`, and
accepted order quantity `2`. The integration test passes that recorded run back
to `runOnce` in strict replay mode three times and checks the full query identity
and failure fingerprint each time.

The safe scenario creates the same one-unit resource with the original
`createInventory` API and calls `hold` for both buyers. One call returns `held`
and the other returns `insufficient`; capacity remains intact. Interleave records
one `select * from nos_hold(...)` statement per actor. The lock and decision logic
inside that PostgreSQL function remains opaque, as it does for every server-side
function.

Every actor constructs a real `pg.Pool` with `max: 1`, uses the source API, and
closes the pool in `finally`. The scenario contains no replacement SQL for either
business operation.

## Run it

From the Interleave repository root:

```sh
npm test -- test/neveroversell.integration.test.ts
```

With Docker running, this provisions official PostgreSQL 16 on a dynamically
assigned loopback port and removes its owned container after the test, including
failure or interruption. The first run may download the image.

To use an existing server instead, set `TEST_DATABASE_URL` to a dedicated
PostgreSQL administrator database where tests may create and drop databases,
then run the same command. The supplied server remains running afterward.
There is no implicit connection to an existing local server.

The reusable scenario definitions are in [`scenario.ts`](scenario.ts). The
recorded local run is in [`MEASUREMENTS.json`](MEASUREMENTS.json); it reports one
measurement on Node 24.7.0 and PostgreSQL 16.13, not a performance benchmark or a
claim about other environments.

## Pinned source and license

The `vendor` directory contains only the upstream TypeScript and SQL needed for
these two paths. Every file is copied byte-for-byte from neveroversell commit
[`d8309cb55176db7e1079d31a061d76f4f21c604a`](https://github.com/pavangupta352/neveroversell/tree/d8309cb55176db7e1079d31a061d76f4f21c604a).
[`vendor/SOURCE.json`](vendor/SOURCE.json) records a SHA-256 digest for each file,
and [`vendor/LICENSE`](vendor/LICENSE) preserves the upstream MIT license and
attribution.
