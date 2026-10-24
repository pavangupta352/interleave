# Ruby actors with the pg gem

Two customers try to buy the last unit of a product. Each actor is an ordinary
Ruby program (`checkout.rb`) using the [pg gem](https://github.com/ged/ruby-pg);
Interleave starts it with `processActor` and gives it its own loopback PostgreSQL
endpoint in `DATABASE_URL` and the standard `PG*` variables. The program needs no
Interleave import and no test hooks.

`checkout.rb` reads the stock and then decrements it in a separate statement, so
two purchases can both see `stock = 1`. `checkout_safe.rb` makes one conditional
`UPDATE ... WHERE stock > 0 RETURNING stock` decide the purchase and inserts the
order in the same transaction.

## Run it

You need Node.js 22.18+, Ruby with Bundler, and a PostgreSQL route
(`--docker`, or a dedicated test server in `TEST_DATABASE_URL`). Copy this folder
into an application where Interleave is [installed](../../docs/getting-started.md#install-a-release),
as `ruby/` next to its `package.json`. Run everything from the application root,
because `--include` paths are relative to that project root:

```sh
# Install the pg gem locked in ruby/Gemfile.lock into ruby/vendor/bundle.
BUNDLE_GEMFILE=ruby/Gemfile bundle install

# Find the oversell and keep it (exit 1 means the invariant failed).
npx --no-install interleave run ruby/scenario.mjs --include ruby/checkout.rb --docker --out oversell.json

# Replay the same order against the same source (exit 1 again).
npx --no-install interleave replay ruby/scenario.mjs oversell.json --docker

# The repaired program passes every explored order (exit 0). The search starts
# two Ruby processes for each of its 47 schedules, which can take longer than
# the default 60-second search budget, so give it ten minutes.
npx --no-install interleave run ruby/safe-scenario.mjs --include ruby/checkout_safe.rb --docker --total-timeout-ms 600000
```

Each actor runs `ruby -rbundler/setup` with `BUNDLE_GEMFILE` set to this folder's
`Gemfile`, so it loads exactly the locked gem from the `vendor/bundle` path that
`.bundle/config` selects. That file also freezes the bundle: `bundle install`
fails instead of re-resolving when the Gemfile and lockfile disagree. Set
`INTERLEAVE_RUBY` to run another Ruby executable.

`--include ruby/checkout.rb` binds the Ruby source into the recording: after you
edit it, exact replay reports `incompatible` instead of silently replaying
different code. Ruby, Bundler and the installed gem are not part of Interleave's
identity; keep them pinned (the lockfile pins pg 1.6.3 with a SHA-256 checksum
for each platform) and replay in the same environment.

## Replaying from another directory

Unless the connection sets `application_name`, the pg gem sends the program's
path, shortened to its first and last 30 characters, as the application name.
Interleave records each actor's startup parameters, so replaying this recording
from a copy of the application in another directory reports `incompatible`
("actor startup identity changed"). A connection that names itself, such as
`PG.connect(ENV.fetch("DATABASE_URL"), application_name: "checkout")`, sends
that name instead of the path.

## What was verified

On macOS (arm64) with PostgreSQL 16, on both Node.js 22.18.0 and 24.7.0, using Ruby 4.0.5,
Bundler 4.0.11 and pg 1.6.3 (the arm64-darwin native gem, which bundles libpq
18.1), an installed-package run of these commands found the oversell (exit 1),
replayed it exactly (exit 1), reported `incompatible` after `checkout.rb`
changed and from a copy of the application in another directory (exit 3), and
explored all 47 schedules of the repaired program with no violation (exit 0).
The `ruby` CI job repeats the workflow on Ubuntu; see the
[compatibility matrix](../../docs/compatibility.md#external-programs-as-actors).
