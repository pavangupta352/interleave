import { captureExportSourceIdentity } from '../../src/source-identity.js';
import type { RunResult } from '../../src/types.js';

/** Inert file-format fixture only: this does not claim an executed database run. */
export async function bindExportFixture(run: RunResult, options: { scenarioFile: string; projectRoot: string; runtimeRoot: string; include?: string[] }): Promise<RunResult> {
  const source = await captureExportSourceIdentity(options.scenarioFile, {
    projectRoot: options.projectRoot,
    ...(options.include === undefined ? {} : { include: options.include }),
  }, options.runtimeRoot);
  // Synthetic format metadata only, never proof of database or startup execution.
  const connections = run.connections ?? [...new Map(run.trace.map(step => [
    `${step.actor}\0${step.connection}`,
    { actor: step.actor, connection: step.connection, fingerprint: 'f'.repeat(64) },
  ])).values()];
  const fixture = run.environment.fixture ?? {
    version: 1 as const, profile: 'postgresql16-native-v1' as const, algorithm: 'sha256' as const,
    fingerprint: 'a'.repeat(64),
    components: { schema: 'b'.repeat(64), data: 'c'.repeat(64), sequences: 'd'.repeat(64), settings: 'e'.repeat(64) },
    counts: { objects: 0, rows: 0, bytes: 0 },
  };
  return { ...run, connections, environment: { ...run.environment, fixture, source } };
}
