import { fileURLToPath } from 'node:url';
import { defineScenario, processActor } from '@pavangupta352/interleave';
import { invariant, python, setup } from './shared.mjs';

const checkout = processActor(python, [fileURLToPath(new URL('./checkout.py', import.meta.url))]);
export default defineScenario({ name: 'python-last-unit', setup, actors: { alice: checkout, bob: checkout }, invariant });
