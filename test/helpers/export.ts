import { captureExportSourceIdentity } from '../../src/source-identity.js';
import type { RunResult } from '../../src/types.js';

/** Inert file-format fixture only: this does not claim an executed database run. */
export async function bindExportFixture(run: RunResult, options: { scenarioFile: string; projectRoot: string; runtimeRoot: string; include?: string[] }): Promise<RunResult> {
  const source = await captureExportSourceIdentity(options.scenarioFile, {
    projectRoot: options.projectRoot,
    ...(options.include === undefined ? {} : { include: options.include }),
  }, options.runtimeRoot);
  return { ...run, environment: { ...run.environment, source } };
}
