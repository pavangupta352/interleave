# node-pg-migrate 5.10.0 runner bootstrap on an empty database, transcribed
# from the SQL the runner sent through Interleave. The tester cannot run the
# runner's JavaScript, so each permutation lists the statements of one known
# path. The runner releases its session-level advisory lock when its client
# disconnects; tester sessions stay connected, so the serial permutations
# call pg_advisory_unlock_all() where the first runner's client would close.

teardown
{
  DROP TABLE IF EXISTS "public"."pgmigrations";
}

session first
step first_check  { SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pgmigrations'; }
step first_pkey   { SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = 'public' AND table_name = 'pgmigrations' AND constraint_type = 'PRIMARY KEY'; }
step first_create { CREATE TABLE "public"."pgmigrations" ( id SERIAL PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL); }
step first_lock   { select pg_try_advisory_lock(7241865325823964) as "lockObtained"; }
step first_list   { SELECT name FROM "public"."pgmigrations" ORDER BY run_on, id; }
step first_close  { SELECT pg_advisory_unlock_all(); }
teardown { SELECT pg_advisory_unlock_all(); }

session second
step second_check  { SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pgmigrations'; }
step second_pkey   { SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = 'public' AND table_name = 'pgmigrations' AND constraint_type = 'PRIMARY KEY'; }
step second_create { CREATE TABLE "public"."pgmigrations" ( id SERIAL PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL); }
step second_lock   { select pg_try_advisory_lock(7241865325823964) as "lockObtained"; }
step second_list   { SELECT name FROM "public"."pgmigrations" ORDER BY run_on, id; }
step second_close  { SELECT pg_advisory_unlock_all(); }
teardown { SELECT pg_advisory_unlock_all(); }

# Race: both runners find no table before either creates it. The second
# CREATE TABLE fails, and that runner stops.
permutation first_check second_check first_create second_create first_lock first_list
# Serial: the second runner finds the table and its primary key.
permutation first_check first_create first_lock first_list first_close second_check second_pkey second_lock second_list
permutation second_check second_create second_lock second_list second_close first_check first_pkey first_lock first_list
