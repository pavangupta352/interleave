import { defineScenario } from '@pavangupta352/interleave';
import { deposit, interestJob, invariant, setup } from './shared.mjs';
import { applyInterest } from './jobs.mjs';

export default defineScenario({ name: 'cursor-interest', setup, actors: { interest: interestJob(applyInterest), customer: deposit }, invariant });
