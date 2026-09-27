# Java actors with JDBC

Two customers try to buy the last unit of a product. Each actor is an ordinary
Java program (`Checkout.java`) using the [PostgreSQL JDBC driver](https://jdbc.postgresql.org/)
(pgjdbc) with its default settings; Interleave starts it with `processActor` and
gives it its own loopback PostgreSQL endpoint in the standard `PG*` variables.
The program needs no Interleave import and no test hooks.

`Checkout.java` reads the stock and then decrements it in a separate statement,
so two purchases can both see `stock = 1`. `CheckoutSafe.java` makes one
conditional `UPDATE ... WHERE stock > 0 RETURNING stock` decide the purchase and
inserts the order in the same transaction.

## Run it

You need Node.js 22.18+, Java 21 or later, and a PostgreSQL route (`--docker`,
or a dedicated test server in `TEST_DATABASE_URL`). Copy this folder into an
application where Interleave is [installed](../../docs/getting-started.md#install-a-release),
as `java/` next to its `package.json`. Run everything from the application root,
because `--include` paths are relative to that project root:

```sh
# Download pgjdbc 42.7.13 from Maven Central into java/lib. The script keeps the
# jar only if its SHA-256 matches the value recorded in java/shared.mjs.
node java/fetch-driver.mjs

# Find the oversell and keep it (exit 1 means the invariant failed).
npx --no-install interleave run java/scenario.mjs --include java/Checkout.java --docker --out oversell.json

# Replay the same order against the same source (exit 1 again).
npx --no-install interleave replay java/scenario.mjs oversell.json --docker

# The repaired program passes every explored order (exit 0). Its frontier has
# 183 schedules, more than the default 100 runs, and each schedule starts two
# Java processes, so raise the run limit and give the search half an hour.
npx --no-install interleave run java/safe-scenario.mjs --include java/CheckoutSafe.java --docker --max-runs 1000 --total-timeout-ms 1800000
```

Each actor runs `java -cp java/lib/postgresql-42.7.13.jar Checkout.java` with
Java's single-file source launcher, so there is no build step. Set
`INTERLEAVE_JAVA` to run another `java` executable. JDBC does not read the libpq
variables, so the programs build a `jdbc:postgresql:` URL from `PGHOST`, `PGPORT`
and `PGDATABASE` and pass `PGUSER` and `PGPASSWORD` to `DriverManager`.

`--include java/Checkout.java` binds the Java source into the recording: after
you edit it, exact replay reports `incompatible` instead of silently replaying
different code. The JDK and the driver jar are not part of Interleave's
identity; keep them pinned (the fetch script checks the jar's SHA-256) and replay
in the same environment.

## What pgjdbc sends

- With its default `sslmode=prefer`, pgjdbc first asks for TLS. The actor
  endpoint declines, and the driver continues in plaintext on the same
  connection, so the URL does not need `sslmode`.
- Its startup packet includes the JVM's time zone. Startup parameters are part of
  exact replay identity, so replaying with a different time zone (for example
  another `TZ`) reports `incompatible` ("actor startup identity changed").
- After connecting it sets `application_name` with a simple query. With
  autocommit off it sends `BEGIN` as a simple query before the first statement.
  Each statement, and `COMMIT`, is one extended cycle.

## What was verified

On macOS (arm64) with PostgreSQL 16 and Node.js 24.7.0, using OpenJDK 21.0.11
(Homebrew) and pgjdbc 42.7.13, an installed-package run of these commands found
the oversell (exit 1), replayed it exactly (exit 1), replayed the same failure
from a copy of the application in another directory (exit 1), reported
`incompatible` with `TZ=Pacific/Chatham` and after `Checkout.java` changed
(exit 3), and explored all 183 schedules of the repaired program with no
violation (exit 0). The jar's SHA-256 was recorded after its SHA-1 matched
Maven Central's published checksum and its signature verified against the
pgjdbc release key. The `java` CI job repeats the workflow on Ubuntu with
Temurin; see the
[compatibility matrix](../../docs/compatibility.md#external-programs-as-actors).
