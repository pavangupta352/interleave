import { defineScenario } from '@pavangupta352/interleave';
import { claimOnce } from './claims.mjs';
import { invariant, worker } from './shared.mjs';

export default defineScenario({
  name: 'job-claim-safe',
  async setup({ db }) { await db.query('CREATE TABLE claims (job_id int PRIMARY KEY, worker text NOT NULL)'); },
  actors: { alice: worker(claimOnce), bob: worker(claimOnce) },
  invariant,
});
