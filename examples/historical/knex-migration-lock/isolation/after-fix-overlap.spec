# Knex 0.95.12 conditional insert with an added blocker session. This is test
# scaffolding, not Knex SQL: the blocker holds a lock on the lock table's
# sequence, so each conditional insert waits at nextval() after its NOT EXISTS
# check has already seen an empty table. Both inserts then complete. It shows
# the overlap that ordinary concurrency produced, in a repeatable order.

setup
{
  create table "public"."knex_migrations" ("id" serial primary key, "name" varchar(255), "batch" integer, "migration_time" timestamptz);
  create table "public"."knex_migrations_lock" ("index" serial primary key, "is_locked" integer);
}

teardown
{
  drop table "public"."knex_migrations";
  drop table "public"."knex_migrations_lock";
}

session alice
step alice_read   { select * from "public"."knex_migrations_lock"; }
step alice_insert { insert into "public"."knex_migrations_lock" ("is_locked") select 0 where not exists (select * from "public"."knex_migrations_lock"); }

session bob
step bob_read   { select * from "public"."knex_migrations_lock"; }
step bob_insert { insert into "public"."knex_migrations_lock" ("is_locked") select 0 where not exists (select * from "public"."knex_migrations_lock"); }

session blocker
step blocker_begin  { BEGIN; }
step blocker_lock   { ALTER SEQUENCE "public"."knex_migrations_lock_index_seq" INCREMENT BY 1; }
step blocker_commit { COMMIT; }

session observer
step check { select count(*) as lock_rows from "public"."knex_migrations_lock"; }

permutation alice_read bob_read blocker_begin blocker_lock alice_insert bob_insert blocker_commit check
