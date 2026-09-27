# Sequelize 6.8.0 findCreateFind in two READ COMMITTED transactions,
# transcribed from the SQL that Sequelize sent through Interleave. The bound
# INSERT value is written as a literal. The tester cannot run Sequelize's
# JavaScript, so each permutation lists the statements of one known path.

setup
{
  CREATE TABLE claims (id serial PRIMARY KEY, claim_key varchar(255) NOT NULL UNIQUE);
}

teardown
{
  DROP TABLE claims;
}

session alice
step alice_begin  { START TRANSACTION; }
step alice_find   { SELECT "id", "claim_key" AS "claimKey" FROM "claims" AS "Claim" WHERE "Claim"."claim_key" = 'winner'; }
step alice_insert { INSERT INTO "claims" ("id","claim_key") VALUES (DEFAULT,'winner') ON CONFLICT DO NOTHING RETURNING "id","claim_key"; }
step alice_commit { COMMIT; }

session bob
step bob_begin      { START TRANSACTION; }
step bob_find       { SELECT "id", "claim_key" AS "claimKey" FROM "claims" AS "Claim" WHERE "Claim"."claim_key" = 'winner'; }
step bob_insert     { INSERT INTO "claims" ("id","claim_key") VALUES (DEFAULT,'winner') ON CONFLICT DO NOTHING RETURNING "id","claim_key"; }
step bob_find_again { SELECT "id", "claim_key" AS "claimKey" FROM "claims" AS "Claim" WHERE "Claim"."claim_key" = 'winner'; }
step bob_commit     { COMMIT; }

session observer
step check { SELECT count(*) AS claim_rows FROM claims WHERE claim_key = 'winner'; }

# Race: both lookups miss before either insert. Bob's insert waits for
# alice's transaction and then inserts nothing; the library's retry lookup
# finds alice's committed row and bob's transaction commits.
permutation alice_begin bob_begin alice_find bob_find alice_insert bob_insert alice_commit bob_find_again bob_commit check
# Serial: bob's lookup finds alice's committed row, so bob inserts nothing.
permutation alice_begin alice_find alice_insert alice_commit bob_begin bob_find bob_commit check
