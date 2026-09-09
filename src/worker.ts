import { pathToFileURL } from 'node:url';
import { attachOwnedDatabase } from './attached-database.js';
import { parseRunArtifact } from './artifact.js';
import { runInOwnedDatabase } from './runner.js';
import { defineScenario } from './scenario.js';
import type { RunOptions, Scenario } from './types.js';
import type { SourceIdentity } from './source-identity.js';

interface StartMessage {
  type: 'start';
  token: string;
  scenarioFile: string;
  connectionString: string;
  sourceIdentity: SourceIdentity;
  options: Omit<RunOptions, 'databaseUrl' | 'signal'>;
}

const controller = new AbortController();
let started = false;
let protocolToken: string | undefined;
process.on('disconnect', () => process.exit(1));
process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null || !('type' in message)) return;
  if (message.type === 'abort') {
    if ('token' in message && message.token === protocolToken) controller.abort();
    return;
  }
  if (message.type !== 'start' || started) return;
  if (!('token' in message) || typeof message.token !== 'string' || message.token.length < 32) return;
  started = true;
  protocolToken = message.token;
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
      }, database, message.sourceIdentity);
      const validated = parseRunArtifact(result);
      process.send?.({ type: 'result', token: message.token, run: validated }, error => process.exit(error ? 1 : 0));
    } finally {
      await database.close();
    }
  } catch {
    // Scenario exceptions may contain credentials. The parent reports a stable
    // diagnostic and never forwards child output or arbitrary exception text.
    process.send?.({ type: 'error', token: message.token, reason: 'Scenario loading or worker execution failed' }, () => process.exit(1));
  }
}
