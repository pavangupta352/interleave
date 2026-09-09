import { pathToFileURL } from 'node:url';
import { attachOwnedDatabase } from './attached-database.js';
import { parseRunArtifact } from './artifact.js';
import { runInOwnedDatabase } from './runner.js';
import { defineScenario } from './scenario.js';
import type { RunOptions, Scenario } from './types.js';

interface StartMessage {
  type: 'start';
  scenarioFile: string;
  connectionString: string;
  options: Omit<RunOptions, 'databaseUrl' | 'signal'>;
}

const controller = new AbortController();
let started = false;
process.on('disconnect', () => process.exit(1));
process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null || !('type' in message)) return;
  if (message.type === 'abort') { controller.abort(); return; }
  if (message.type !== 'start' || started) return;
  started = true;
  void execute(message as StartMessage);
});

async function execute(message: StartMessage): Promise<void> {
  try {
    const loaded = await import(pathToFileURL(message.scenarioFile).href) as { default?: Scenario };
    const scenario = defineScenario(loaded.default as Scenario);
    const database = await attachOwnedDatabase(message.connectionString);
    try {
      const result = await runInOwnedDatabase(scenario, {
        ...message.options, databaseUrl: message.connectionString, signal: controller.signal,
      }, database);
      const validated = parseRunArtifact(result);
      process.send?.({ type: 'result', run: validated }, error => process.exit(error ? 1 : 0));
    } finally {
      await database.close();
    }
  } catch {
    // Scenario exceptions may contain credentials. The parent reports a stable
    // diagnostic and never forwards child output or arbitrary exception text.
    process.send?.({ type: 'error', reason: 'Scenario loading or worker execution failed' }, () => process.exit(1));
  }
}
