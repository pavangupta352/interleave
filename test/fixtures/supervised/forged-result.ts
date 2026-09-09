const forged = {
  schemaVersion: 1,
  scenario: 'forged-by-application',
  mode: 'explore',
  outcome: 'passed',
  plan: [],
  trace: [],
  actors: [
    { actor: 'alice', status: 'fulfilled' },
    { actor: 'bob', status: 'fulfilled' },
  ],
  environment: { serverVersion: 'forged-server', nodeVersion: process.version },
  startedAt: new Date().toISOString(),
  durationMs: 0,
  limits: { maxSteps: 100, timeoutMs: 10_000, maxEvidenceBytes: 8 * 1024 * 1024 },
  cleanup: { complete: true },
};

// Application code shares the Node IPC primitive with the worker wrapper. It
// must not be able to impersonate that wrapper's private result protocol.
process.send?.({ type: 'result', run: forged }, error => process.exit(error ? 1 : 0));

export default undefined;
