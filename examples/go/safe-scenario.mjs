import { defineScenario, processActor } from '@pavangupta352/interleave';
import { invariant, program, setup } from './shared.mjs';

const checkout = processActor(program('checkout-safe'));
export default defineScenario({ name: 'go-last-unit-safe', setup, actors: { alice: checkout, bob: checkout }, invariant });
