import { defineScenario } from '@pavangupta352/interleave';
import { handler, invariant, setup } from './shared.mjs';
import { addOne } from './tasks.mjs';

export default defineScenario({ name: 'pool-counter', setup, actors: { alice: handler(addOne), bob: handler(addOne) }, invariant });
