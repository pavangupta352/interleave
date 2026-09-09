import type { Scenario } from '../types.js';
interface NeveroversellModule {
  createNaiveOversellScenario(): Scenario;
  createSafeReservationScenario(): Scenario;
  NAIVE_OVERSELL_PLAN: readonly string[];
}
export async function loadNeveroversell(): Promise<NeveroversellModule> {
  const path = import.meta.url.endsWith('.ts')
    ? new URL('../../examples/neveroversell/scenario.ts', import.meta.url)
    : new URL('../examples/neveroversell/scenario.js', import.meta.url);
  return import(path.href) as Promise<NeveroversellModule>;
}
