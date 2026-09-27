# Knex 3.3.0 migration lock initialization, transcribed from the SQL that
# Knex sent through Interleave. Since knex/knex#4865 (0.95.15), Knex reads the
# lock table a second time and inserts only if that read is empty. The bound
# INSERT value is written as a literal. The tester cannot run Knex's
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
step alice_read    { select * from "public"."knex_migrations_lock"; }
step alice_recheck { select * from "public"."knex_migrations_lock"; }
step alice_insert  { insert into "public"."knex_migrations_lock" ("is_locked") values (0); }

session bob
step bob_read    { select * from "public"."knex_migrations_lock"; }
step bob_recheck { select * from "public"."knex_migrations_lock"; }
step bob_insert  { insert into "public"."knex_migrations_lock" ("is_locked") values (0); }

session observer
step check { select count(*) as lock_rows from "public"."knex_migrations_lock"; }

# Race: both second reads still see an empty lock table before either insert.
permutation alice_read bob_read alice_recheck bob_recheck alice_insert bob_insert check
# The second read closes this order: bob's recheck sees alice's row.
permutation alice_read bob_read alice_recheck alice_insert bob_recheck check
