// Manual-barrier baseline: withhold the result of each transaction's first
// claim lookup in findCreateFind until both transactions have looked it up.
export const gate = {
  description: 'Sequelize findCreateFind initial lookup inside each transaction',
  match: sql => sql === 'SELECT "id", "claim_key" AS "claimKey" FROM "claims" AS "Claim" WHERE "Claim"."claim_key" = \'winner\';',
};
