# Knex 0.95.12 migration lock initialization, transcribed from the SQL that
# Knex sent through Interleave. The bound INSERT value is written as a literal.
# Setup creates the two tables with the DDL Knex issues; the lock table starts
# empty, as in the Interleave scenario. The tester cannot run Knex's
# JavaScript, so each permutation lists the statements of one known path.

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

session observer
step check { select count(*) as lock_rows from "public"."knex_migrations_lock"; }

# Race: both reads see an empty lock table before either insert. The tester
# starts bob's conditional insert only after alice's has completed, so it sees
# alice's row; it cannot start the two inserts at the same time.
permutation alice_read bob_read alice_insert bob_insert check
# Serial: the second read sees the first row, so Knex skips its insert.
permutation alice_read alice_insert bob_read check
permutation bob_read bob_insert alice_read check
