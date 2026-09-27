import { defineScenario } from '@pavangupta352/interleave';
import { claim } from './claims.mjs';
import { invariant, worker } from './shared.mjs';

export default defineScenario({
  name: 'job-claim',
  async setup({ db }) { await db.query('CREATE TABLE claims (job_id int NOT NULL, worker text NOT NULL)'); },
  actors: { alice: worker(claim), bob: worker(claim) },
  invariant,
});
