import { defineScenario, processActor } from '@pavangupta352/interleave';
import { invariant, program, setup } from './shared.mjs';

const checkout = processActor(program('checkout'));
export default defineScenario({ name: 'go-last-unit', setup, actors: { alice: checkout, bob: checkout }, invariant });
