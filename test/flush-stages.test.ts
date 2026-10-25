import { describe, expect, test } from 'vitest';
import { parseRunArtifact } from '../src/artifact.js';
import { FlushSummary } from '../src/protocol/backend.js';
import { FrontendAssembler, FrontendCycleBuffer } from '../src/protocol/frontend.js';

function packet(type: string, payload = Buffer.alloc(0)) { const h = Buffer.alloc(5); h[0] = type.charCodeAt(0); h.writeUInt32BE(payload.length + 4, 1); return Buffer.concat([h, payload]); }
const str = (s: string) => Buffer.from(s + '\0');
const parse = (name: string, sql: string) => packet('P', Buffer.concat([str(name), str(sql), Buffer.alloc(2)]));
const bind = (portal: string, statement: string) => packet('B', Buffer.concat([str(portal), str(statement), Buffer.alloc(2), Buffer.alloc(2), Buffer.alloc(2)]));
const describePortal = (portal: string) => packet('D', Buffer.concat([Buffer.from('P'), str(portal)]));
const execute = (portal: string, rows: number) => { const count = Buffer.alloc(4); count.writeInt32BE(rows); return packet('E', Buffer.concat([str(portal), count])); };
const closePortal = (portal: string) => packet('C', Buffer.concat([Buffer.from('P'), str(portal)]));
const flush = packet('H'), sync = packet('S');
const commandComplete = (tag: string) => packet('C', str(tag));
const flushProfile = { protocolProfile: 'flush-stages-v1' as const };
// pg-cursor: open the portal, fetch in batches, then Close and Sync.
const open = [parse('', 'SELECT id FROM items'), bind('C_1', ''), describePortal('C_1'), flush];
const fetch = [execute('C_1', 2), flush];
const close = [closePortal('C_1'), sync];

describe('flush-stages-v1 frontend boundaries and identity', () => {
  test('every Flush and Sync ends a release, and a Simple Query or bare Flush inside an open cycle is refused', () => {
    const buffer = new FrontendCycleBuffer(flushProfile);
    const frames = [...open, ...fetch, ...fetch, ...close];
    expect(frames.flatMap(frame => { const unit = buffer.accept(frame); return unit ? [unit] : []; })).toEqual([open, fetch, fetch, close]);
    const midCycle = new FrontendCycleBuffer(flushProfile);
    open.forEach(frame => midCycle.accept(frame));
    expect(() => midCycle.accept(packet('Q', str('SELECT 1')))).toThrow(/Simple Query inside an unfinished extended cycle/);
    expect(() => new FrontendCycleBuffer(flushProfile).accept(flush)).toThrow(/Flush without pending extended messages/);
    expect(() => new FrontendCycleBuffer().accept(flush)).toThrow(/select flush-stages-v1/);
  });

  test('a Flush cycle bounds each stage rather than the whole cycle', () => {
    const buffer = new FrontendCycleBuffer({ ...flushProfile, maxBufferedBytes: 64 });
    open.forEach(frame => buffer.accept(frame));
    // Thirty fetch stages exceed 64 bytes in total, never in one stage.
    for (let index = 0; index < 30; index++) fetch.forEach(frame => buffer.accept(frame));
    expect(() => buffer.accept(packet('B', Buffer.alloc(80)))).toThrow(/limit/);
  });

  test('stages chain their fingerprints and recovery after an error accepts only Sync', () => {
    function stages(rows: number) {
      const acknowledged = new FrontendAssembler(flushProfile);
      const first = acknowledged.fork().flushStage(open);
      for (const frame of [packet('1'), packet('2'), packet('T', Buffer.alloc(2))]) acknowledged.reconcile(first, frame);
      const second = acknowledged.fork().flushContinuation([execute('C_1', rows), flush], first);
      return { acknowledged, first, second };
    }
    const { acknowledged, first, second } = stages(2);
    expect([first.stage, second.stage, second.sql]).toEqual(['flush', 'flush', 'SELECT id FROM items']);
    expect(second.fingerprint).not.toBe(stages(3).second.fingerprint);
    expect(stages(2).second.fingerprint).toBe(second.fingerprint);
    const closing = acknowledged.fork().flushContinuation(close, second);
    expect([closing.stage, closing.sql]).toEqual(['sync', 'SELECT id FROM items']);
    const recover = acknowledged.fork().flushContinuation([sync], second, { code: '22012', message: 'division by zero' });
    expect([recover.stage, recover.sql]).toEqual(['recover', 'SELECT id FROM items']);
    expect(() => acknowledged.fork().flushContinuation(close, second, { code: '22012', message: 'division by zero' })).toThrow(/only Sync may follow/);
    expect(() => new FrontendAssembler().accept(flush)).toThrow(/select flush-stages-v1/);
  });

  test('the describe-flush-v1 prefix is recognized exactly', () => {
    const statement = [parse('s1', 'SELECT 1'), packet('D', Buffer.concat([Buffer.from('S'), str('s1')])), flush];
    expect(FrontendAssembler.isDescribePrefix(statement)).toBe(true);
    expect(FrontendAssembler.isDescribePrefix(open)).toBe(false);
    expect(FrontendAssembler.isDescribePrefix([parse('s1', 'SELECT 1'), packet('D', Buffer.concat([Buffer.from('S'), str('s2')])), flush])).toBe(false);
  });
});

describe('Flush stage completion', () => {
  const journal = (operations: number) => ({ operations: Array.from({ length: operations }), index: 0 });
  test('completes once every message is acknowledged, counting rows and the suspended portal', () => {
    const state = journal(1); const summary = new FlushSummary(state);
    expect(summary.accept(packet('D', Buffer.alloc(2)))).toBeUndefined();
    expect(summary.accept(packet('D', Buffer.alloc(2)))).toBeUndefined();
    state.index = 1;
    expect(summary.accept(packet('s'))).toEqual({ kind: 'flush', commandTags: [], rows: 2, suspended: true });
    const done = journal(1); const last = new FlushSummary(done);
    last.accept(packet('D', Buffer.alloc(2))); done.index = 1;
    expect(last.accept(commandComplete('SELECT 1'))).toEqual({ kind: 'flush', commandTags: ['SELECT 1'], rows: 1 });
  });
  test('an error completes the stage at once, and ReadyForQuery cannot occur inside one', () => {
    const error = packet('E', Buffer.concat([Buffer.from('SERROR\0'), Buffer.from('C22012\0'), Buffer.from('Mdivision by zero\0'), Buffer.from([0])]));
    expect(new FlushSummary(journal(2)).accept(error)).toEqual({ kind: 'flush', commandTags: [], rows: 0, error: { code: '22012', message: 'division by zero' } });
    expect(() => new FlushSummary(journal(1)).accept(packet('Z', Buffer.from('I')))).toThrow(/ReadyForQuery inside a Flush stage/);
  });
});

const print = (character: string): string => character.repeat(64);
const transport = { version: 1, frontend: 'loopback-plaintext-v1', authentication: 'passthrough-no-channel-binding-v1', upstream: { profile: 'plaintext-v1' } };
/** alice opens a cursor, fetches twice and closes it; bob commits an update between the fetches. */
function run(): Record<string, any> {
  const step = (index: number, actor: string, ordinal: number, stage: string, completion: object, extra: object = {}) => ({
    index, actor, connection: 0, ordinal, protocol: stage === 'complete' && actor === 'bob' ? 'simple' : 'extended',
    sql: actor === 'bob' ? 'UPDATE items SET value = 15 WHERE id = 5' : 'SELECT id FROM items', fingerprint: print('b'),
    backendPid: actor === 'bob' ? 102 : 101, available: actor === 'bob' ? ['alice', 'bob'] : ['alice', 'bob'],
    releasedAt: index + 1, completedAt: index + 1.5, completion, waits: [], stage, cycle: 0, ...extra,
  });
  return {
    schemaVersion: 5, scenario: 'cursor batches', outcome: 'passed', mode: 'explore', plan: [],
    connections: [{ actor: 'alice', connection: 0, fingerprint: print('a') }, { actor: 'bob', connection: 0, fingerprint: print('c') }],
    trace: [
      step(0, 'alice', 0, 'flush', { kind: 'flush', commandTags: [], rows: 0 }),
      step(1, 'alice', 1, 'flush', { kind: 'flush', commandTags: [], rows: 2, suspended: true }, { prefixOrdinal: 0 }),
      step(2, 'bob', 0, 'complete', { kind: 'ready', transactionStatus: 'I', commandTags: ['UPDATE 1'], rowCount: 1 }),
      step(3, 'alice', 2, 'flush', { kind: 'flush', commandTags: ['SELECT 1'], rows: 1 }, { prefixOrdinal: 1 }),
      step(4, 'alice', 3, 'sync', { kind: 'ready', transactionStatus: 'I', commandTags: [], rowCount: 0 }, { prefixOrdinal: 2 }),
    ],
    actors: [{ actor: 'alice', status: 'fulfilled' }, { actor: 'bob', status: 'fulfilled' }],
    environment: { serverVersion: '16.15', nodeVersion: 'v24.7.0', transport,
      fixture: { version: 1, profile: 'postgresql16-native-v1', algorithm: 'sha256', fingerprint: print('d'),
        components: { schema: print('d'), data: print('d'), sequences: print('d'), settings: print('d') }, counts: { objects: 1, rows: 5, bytes: 1 } } },
    startedAt: '2026-10-25T00:00:00.000Z', durationMs: 10,
    limits: { maxSteps: 100, timeoutMs: 10_000, maxEvidenceBytes: 8 * 1024 * 1024, maxConnectionsPerActor: 1,
      protocolProfile: 'flush-stages-v1', connectionProfile: 'single-producer-v1' },
    cleanup: { complete: true },
  };
}
const failed = (r: any) => {
  r.trace[3].completion = { kind: 'flush', commandTags: [], rows: 0, error: { code: '22012', message: 'division by zero' } };
  r.trace[4].stage = 'recover'; r.trace[4].completion = { kind: 'ready', transactionStatus: 'I', commandTags: [], rowCount: 0, error: { code: '22012', message: 'division by zero' } };
};

describe('version 5 flush-stages-v1 artifacts', () => {
  test('preserve open cycles, Flush completions and exact JSON bytes', () => {
    const original = run();
    expect(parseRunArtifact(original)).toBe(original);
    const serialized = JSON.stringify(original);
    expect(JSON.stringify(parseRunArtifact(serialized))).toBe(serialized);
  });
  test('accept Sync-only recovery after an error in a Flush stage', () => {
    const original = run(); failed(original);
    expect(parseRunArtifact(original)).toBe(original);
  });
  test('accept a completed run that leaves a cycle open, as an abandoned cursor does', () => {
    const original = run(); original.trace.pop();
    expect(parseRunArtifact(original)).toBe(original);
  });
  test('incomplete evidence keeps version 5, the only version with this profile', async () => {
    const { finalizeRunEvidence } = await import('../src/evidence.js');
    const original = run();
    const fallback = finalizeRunEvidence(original as never, JSON.stringify(original).length - 1);
    expect(fallback.outcome).toBe('inconclusive');
    expect(fallback.schemaVersion).toBe(5);
    expect(fallback.limits.protocolProfile).toBe('flush-stages-v1');
    expect(fallback.trace).toEqual([]);
  });
  test('reject COPY data on a Sync-only recovery', () => {
    const original = run(); failed(original);
    original.trace[4].completion.copy = [{ direction: 'in', bytes: 1, sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' }];
    expect(() => parseRunArtifact(original)).toThrow(/Sync-only recovery cannot complete executed commands or rows/);
  });
  test.each([
    ['the profile before version 5', (r: any) => { r.schemaVersion = 4; r.limits.overlap = 'pairs'; }, /protocolProfile/],
    ['an execute stage', (r: any) => { r.trace[4].stage = 'execute'; }, /trace\[4\]\.stage/],
    ['a continuation without its prefix', (r: any) => { delete r.trace[4].prefixOrdinal; }, /trace\[4\]\.prefixOrdinal: required field is missing/],
    ['a prefix that is not the stage before', (r: any) => { r.trace[3].prefixOrdinal = 0; }, /trace\[3\]\.prefixOrdinal: a continuation must name the stage before it/],
    ['a stage in another cycle while one is open', (r: any) => { r.trace[3].cycle = 1; }, /trace\[3\]\.cycle: expected open cycle 0/],
    ['a first stage with a prefix', (r: any) => { r.trace[0].prefixOrdinal = 0; }, /trace\[0\]\.prefixOrdinal: the first stage of a cycle has no prefix/],
    ['a cycle that begins with Sync', (r: any) => { r.trace[0].stage = 'sync'; r.trace[0].completion = { kind: 'ready', transactionStatus: 'I', commandTags: [], rowCount: 0 }; delete r.trace[1].prefixOrdinal; }, /trace\[0\]\.prefixOrdinal: required field is missing|a cycle begins with/],
    ['a Flush stage after an error', (r: any) => { failed(r); r.trace[4].stage = 'flush'; r.trace[4].completion = { kind: 'flush', commandTags: [], rows: 0 }; }, /an error in an open cycle requires Sync-only recovery/],
    ['a recovery that keeps a transaction healthy', (r: any) => { failed(r); r.trace[4].completion.transactionStatus = 'T'; }, /Sync-only error recovery cannot leave a healthy transaction open/],
    ['a recovery with a different error', (r: any) => { failed(r); r.trace[4].completion.error.code = '40001'; }, /retained recovery error must match the failed stage/],
    ['a ready completion for a Flush stage', (r: any) => { r.trace[1].completion = { kind: 'ready', transactionStatus: 'I', commandTags: [], rowCount: 0 }; }, /transactionStatus: unknown field/],
    ['a suspended portal with an error', (r: any) => { r.trace[1].completion.error = { code: '22012', message: 'division by zero' }; }, /an error cannot leave the portal suspended/],
    ['suspended set to false', (r: any) => { r.trace[1].completion.suspended = false; }, /suspended: expected true when present/],
    ['a stage released before the previous one completed', (r: any) => { r.trace[1].completedAt = 4.5; r.trace[3].releasedAt = 4; r.trace[2].releasedAt = 3; }, /cannot release another stage before its preceding stage completes/],
  ])('reject %s', (_name, mutate, message) => {
    const original = run(); mutate(original);
    expect(() => parseRunArtifact(original)).toThrow(message);
  });
});
