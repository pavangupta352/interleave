import { fileURLToPath } from 'node:url';
import { defineScenario, processActor } from '@pavangupta352/interleave';
import { driverJar, invariant, java, setup } from './shared.mjs';

// The single-file source launcher compiles and runs Checkout.java directly.
const checkout = processActor(java, ['-cp', driverJar, fileURLToPath(new URL('./Checkout.java', import.meta.url))]);
export default defineScenario({ name: 'java-last-unit', setup, actors: { alice: checkout, bob: checkout }, invariant });
