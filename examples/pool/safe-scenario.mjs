import { defineScenario } from '@pavangupta352/interleave';
import { handler, invariant, setup } from './shared.mjs';
import { addOneAtomically } from './tasks.mjs';

export default defineScenario({ name: 'pool-counter-safe', setup, actors: { alice: handler(addOneAtomically), bob: handler(addOneAtomically) }, invariant });
