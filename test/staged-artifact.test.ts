import { describe, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';

function stagedRun() {
  const common = { actor: 'reader', connection: 0, protocol: 'extended', sql: 'SELECT $1::integer',
    backendPid: 101, available: ['reader'], waits: [] };
  return {
    schemaVersion: 2, scenario: 'metadata before parameters', outcome: 'passed', mode: 'explore', plan: [],
    connections: [{ actor: 'reader', connection: 0, fingerprint: 'a'.repeat(64) }],
    trace: [
      { ...common, index: 0, ordinal: 0, cycle: 0, stage: 'describe', fingerprint: 'b'.repeat(64),
        releasedAt: 1, completedAt: 2,
        completion: { kind: 'metadata', result: 'described', parameterCount: 1, columnCount: 1, resultShape: 'rows' } },
      { ...common, index: 1, ordinal: 1, cycle: 0, stage: 'execute', prefixOrdinal: 0, fingerprint: 'c'.repeat(64),
        releasedAt: 3, completedAt: 4,
        completion: { kind: 'ready', transactionStatus: 'I', commandTags: ['SELECT 1'], rowCount: 1 } },
    ],
    actors: [{ actor: 'reader', status: 'fulfilled', value: 3 }, { actor: 'idle', status: 'fulfilled' }],
    environment: { serverVersion: '16.13', nodeVersion: 'v24.7.0' },
    startedAt: '2026-09-09T00:00:00.000Z', durationMs: 5,
    limits: { maxSteps: 100, timeoutMs: 10_000, protocolProfile: 'describe-flush-v1' }, cleanup: { complete: true },
  } as Record<string, any>;
}

describe('staged run artifacts', () => {
  test('preserves both explicit release stages and original JSON without inventing a transaction boundary', () => {
    const run = stagedRun();
    expect(parseRunArtifact(run)).toBe(run);
    expect(JSON.stringify(parseRunArtifact(JSON.stringify(run)))).toBe(JSON.stringify(run));
    expect(run.trace[0].completion).not.toHaveProperty('transactionStatus');
  });

  test('accepts a genuine prefix error followed by a distinct Sync recovery', () => {
    const run = stagedRun();
    run.trace[0].completion = { kind: 'metadata', result: 'error', error: { code: '42601', message: 'syntax error' } };
    run.trace[1].stage = 'recover';
    run.trace[1].completion = { kind: 'ready', transactionStatus: 'E', commandTags: [], rowCount: 0 };
    expect(parseRunArtifact(run)).toBe(run);
  });

  test('accepts a complete ordinary query as the next logical cycle', () => {
    const run = stagedRun();
    run.trace.push({ ...run.trace[1], index: 2, ordinal: 2, cycle: 1, stage: 'complete', protocol: 'simple',
      releasedAt: 4, completedAt: 5 });
    delete run.trace[2].prefixOrdinal;
    expect(parseRunArtifact(run)).toBe(run);
  });

  test('accepts NoData metadata and bounded partial evidence with an unfinished cycle', () => {
    const run = stagedRun();
    run.trace[0].completion.columnCount = 0;
    run.trace[0].completion.resultShape = 'no-data';
    expect(parseRunArtifact(run)).toBe(run);
    run.outcome = 'inconclusive';
    run.trace.pop();
    expect(parseRunArtifact(run)).toBe(run);
    delete run.trace[0].completion;
    delete run.trace[0].completedAt;
    expect(parseRunArtifact(run)).toBe(run);
  });

  test.each([
    ['missing profile', (r: any) => { delete r.limits.protocolProfile; }],
    ['wrong profile', (r: any) => { r.limits.protocolProfile = 'sync-cycle-v1'; }],
    ['missing startup identities', (r: any) => { delete r.connections; }],
    ['missing stage', (r: any) => { delete r.trace[0].stage; }],
    ['missing cycle', (r: any) => { delete r.trace[0].cycle; }],
    ['unknown stage', (r: any) => { r.trace[0].stage = 'metadata-only'; }],
    ['simple describe', (r: any) => { r.trace[0].protocol = 'simple'; }],
    ['cycle gap', (r: any) => { r.trace[0].cycle = 1; }],
    ['changed continuation cycle', (r: any) => { r.trace[1].cycle = 1; }],
    ['missing prefix link', (r: any) => { delete r.trace[1].prefixOrdinal; }],
    ['wrong prefix link', (r: any) => { r.trace[1].prefixOrdinal = 1; }],
    ['prefix points to itself', (r: any) => { r.trace[0].prefixOrdinal = 0; }],
    ['changed backend', (r: any) => { r.trace[1].backendPid = 102; }],
    ['changed continuation SQL', (r: any) => { r.trace[1].sql = 'SELECT 4'; }],
    ['overlapping stages', (r: any) => { r.trace[1].releasedAt = 1; }],
    ['uncompleted prefix', (r: any) => { delete r.trace[0].completion; delete r.trace[0].completedAt; }],
    ['wrong recovery', (r: any) => { r.trace[1].stage = 'recover'; }],
    ['ordinary cycle before staged recovery', (r: any) => { r.trace[1].stage = 'complete'; delete r.trace[1].prefixOrdinal; }],
    ['wrong completion stage', (r: any) => { r.trace[0].completion = r.trace[1].completion; }],
    ['missing completion discriminator', (r: any) => { delete r.trace[1].completion.kind; }],
    ['invented transaction state', (r: any) => { r.trace[0].completion.transactionStatus = 'I'; }],
    ['invented executed rows', (r: any) => { r.trace[0].completion.rowCount = 1; }],
    ['unexpected metadata OID identity', (r: any) => { r.trace[0].completion.oidFingerprint = 'd'.repeat(64); }],
    ['oversized parameter count', (r: any) => { r.trace[0].completion.parameterCount = 65_536; }],
    ['negative column count', (r: any) => { r.trace[0].completion.columnCount = -1; }],
    ['NoData with columns', (r: any) => { r.trace[0].completion.resultShape = 'no-data'; }],
    ['successful metadata containing an error', (r: any) => { r.trace[0].completion.error = { code: '42601', message: 'error' }; }],
    ['unclosed successful cycle', (r: any) => { r.trace.pop(); }],
    ['uncompleted successful execution', (r: any) => { delete r.trace[1].completion; delete r.trace[1].completedAt; }],
    ['cross-connection continuation', (r: any) => {
      r.connections.push({ actor: 'reader', connection: 1, fingerprint: 'd'.repeat(64) });
      r.trace[1].connection = 1; r.trace[1].ordinal = 0;
    }],
  ])('rejects %s', (_name, mutate) => {
    const run = stagedRun(); mutate(run);
    expect(() => parseRunArtifact(run)).toThrow();
  });

  test('rejects error metadata followed by execution or an invented successful description', () => {
    const run = stagedRun();
    run.trace[0].completion = { kind: 'metadata', result: 'error', error: { code: '42601', message: 'syntax error' } };
    expect(() => parseRunArtifact(run)).toThrow(/recover/);
    run.trace[1].stage = 'recover';
    run.trace[0].completion.parameterCount = 0;
    expect(() => parseRunArtifact(run)).toThrow(/unknown/);
  });

  test('rejects executed command evidence on Sync-only recovery', () => {
    const run = stagedRun();
    run.trace[0].completion = { kind: 'metadata', result: 'error', error: { code: '42601', message: 'syntax error' } };
    run.trace[1].stage = 'recover';
    expect(() => parseRunArtifact(run)).toThrow(/Sync-only/);
    run.trace[1].completion.commandTags = [];
    expect(() => parseRunArtifact(run)).toThrow(/Sync-only/);
    run.trace[1].completion.rowCount = 0;
    expect(parseRunArtifact(run)).toBe(run);
  });

  test('continues to reject new stage fields in version one', () => {
    const run = stagedRun(); run.schemaVersion = 1;
    expect(() => parseRunArtifact(run)).toThrow();
  });
});
