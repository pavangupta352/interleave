# Ruby actors with Active Record

Two customers try to buy the last unit of a product. Each actor is a standalone
Ruby program using [Active Record](https://guides.rubyonrails.org/active_record_basics.html)
8.1 over the pg gem, without the rest of Rails. Interleave starts it with
`processActor` and gives it its own loopback PostgreSQL endpoint in
`DATABASE_URL` and the standard `PG*` variables; `shop.rb` connects to it and
defines the two models. The programs need no Interleave import and no test hooks.

`checkout.rb` finds the product, then updates it with the stock it computed from
that read and creates an order, each in Active Record's own short transaction.
Two purchases that both read `stock = 1` both sell it. `checkout_safe.rb` reads
the product with `Product.lock` inside `Product.transaction`, so the second
purchase waits at its `SELECT ... FOR UPDATE` for the first to commit and then
reads the stock it left.

## Run it

You need Node.js 22.18+, Ruby 3.2+ with Bundler and a C compiler (some locked gems
build native extensions), and a PostgreSQL route (`--docker`, or a dedicated test
server in `TEST_DATABASE_URL`). Copy this folder into an application where
Interleave is [installed](../../docs/getting-started.md#install-a-release), as
`activerecord/` next to its `package.json`, and run everything from the
application root:

```sh
# Install the gems locked in activerecord/Gemfile.lock into activerecord/vendor/bundle.
BUNDLE_GEMFILE=activerecord/Gemfile bundle install

# Find the oversell and keep it (exit 1 means the invariant failed).
npx --no-install interleave run activerecord/scenario.mjs --include activerecord/checkout.rb \
  --include activerecord/shop.rb --docker --out activerecord-oversell.json

# Replay the same order against the same source (exit 1 again).
npx --no-install interleave replay activerecord/scenario.mjs activerecord-oversell.json --docker

# Search 200 orders of the repaired program (exit 4: the run budget, not a
# violation, ended the search; the summary reports violations: 0).
npx --no-install interleave run activerecord/safe-scenario.mjs --include activerecord/checkout_safe.rb \
  --include activerecord/shop.rb --docker --seed 1 --max-runs 200 --total-timeout-ms 600000
```

Active Record sends twelve setup commands on each new connection before the
first model query: session settings (`client_min_messages`,
`standard_conforming_strings`, `intervalstyle` and the time zone), type lookups,
`SHOW search_path` and the `product` table's schema. It sends three more the
first time it touches `orders`, and prepares each model query before executing
it. Interleave schedules every one of them, so two actors have far too many
orders to explore them all, and the repair is checked with a bounded,
repeatable seeded search instead. Its first order alternates the two customers,
as the order that oversold the unsafe program did; there, the second
`SELECT ... FOR UPDATE` waits for the first transaction's row lock, and that
customer buys nothing.

Each actor runs `ruby -rbundler/setup` with `BUNDLE_GEMFILE` set to this folder's
`Gemfile`, so it loads exactly the locked gems from the `vendor/bundle` path that
`.bundle/config` selects, and the frozen bundle refuses to re-resolve. Set
`INTERLEAVE_RUBY` to run another Ruby executable.

The `--include` paths bind the Ruby source into the recording: after you edit
either file, exact replay reports `incompatible` instead of silently replaying
different code. Ruby, Bundler and the installed gems are not part of
Interleave's identity; keep them pinned (the lockfile pins every gem with a
SHA-256 checksum for each platform) and replay in the same environment.

## Replaying from another directory

Active Record connects through the pg gem, which sends the program's path as
`application_name` unless the connection sets one. Interleave records each
actor's startup parameters, so replaying this recording from a copy of the
application in another directory reports `incompatible` ("actor startup identity
changed"), as in the [Ruby example](../ruby/README.md#replaying-from-another-directory).
Naming the connection sends that name instead of the path: with
`application_name=checkout` added to the URL passed to `establish_connection`, a
recording replayed the same failure from a copy in another directory.

## What was verified

An installed-package workflow ran with Active Record 8.1.4 and the pg gem 1.6.3
on Ruby 4.0.5 against PostgreSQL 16. The unsafe program oversold on the search's
first order (the second `UPDATE` waited for the first transaction's row lock),
exact replay repeated the failure, a copy of the application in another
directory reported `incompatible` as described above, and editing `checkout.rb`
made exact replay incompatible. The repaired program's seeded search ran 200
orders with no violation and stopped at its run budget with 1,254 prefixes
unexplored. CI repeats the workflow; see the
[compatibility matrix](../../docs/compatibility.md#external-programs-as-actors).
