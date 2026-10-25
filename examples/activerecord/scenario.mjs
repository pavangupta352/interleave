import { fileURLToPath } from 'node:url';
import { defineScenario, processActor } from '@pavangupta352/interleave';
import { bundler, invariant, ruby, setup } from './shared.mjs';

const checkout = processActor(ruby, ['-rbundler/setup', fileURLToPath(new URL('./checkout.rb', import.meta.url))], bundler);
export default defineScenario({ name: 'activerecord-last-unit', setup, actors: { alice: checkout, bob: checkout }, invariant });
