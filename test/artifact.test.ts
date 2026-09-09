import { constants } from 'node:fs';
import { access, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  parseRunArtifact,
  readRunArtifact,
  validateJsonValue,
  writeRunArtifact,
} from '../src/artifact.js';
import type { RunResult } from '../src/types.js';

const fingerprintA = 'a'.repeat(64);
const fingerprintB = 'b'.repeat(64);

function validRun(): RunResult {
  return {
    schemaVersion: 1,
    scenario: 'lost update',
    outcome: 'violation',
    mode: 'explore',
    plan: ['reader', 'writer'],
    trace: [
      {
        index: 0,
        actor: 'reader',
        connection: 0,
        ordinal: 0,
        protocol: 'simple',
        sql: 'SELECT balance FROM accounts WHERE id = 1',
        fingerprint: fingerprintA,
        backendPid: 123,
        available: ['reader', 'writer'],
        releasedAt: 0,
        completedAt: 2,
        completion: { transactionStatus: 'I', commandTags: ['SELECT 1'], rowCount: 1 },
        waits: [],
      },
      {
        index: 1,
        actor: 'writer',
        connection: 0,
        ordinal: 0,
        protocol: 'extended',
        sql: 'UPDATE accounts SET balance = $1 WHERE id = $2',
        fingerprint: fingerprintB,
        backendPid: 124,
        available: ['writer'],
        releasedAt: 3,
        completedAt: 5,
        completion: {
          transactionStatus: 'E',
          commandTags: ['UPDATE 1'],
          rowCount: 1,
          error: { code: '40001', message: 'serialization failure' },
        },
        waits: [{ pid: 124, blockerPids: [123], waitEvent: 'transactionid', waitEventType: 'Lock' }],
      },
    ],
    actors: [
      { actor: 'reader', status: 'fulfilled', value: { balance: 10, observations: [true, null] } },
      { actor: 'writer', status: 'fulfilled', value: { retried: true } },
    ],
    failure: { name: 'balance', message: 'expected 12, received 11', fingerprint: fingerprintA },
    reason: 'invariant failed',
    environment: { serverVersion: '17.4', nodeVersion: '22.18.0' },
    startedAt: '2026-09-08T00:00:00.000Z',
    durationMs: 5,
    limits: { maxSteps: 100, timeoutMs: 30_000 },
    cleanup: { complete: true },
  };
}

function clone(value: RunResult): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function nestedValue(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = { value };
  return value;
}

describe('parseRunArtifact', () => {
  test('exposes strict JSON-value validation for actor observations', () => {
    expect(() => validateJsonValue({ ok: [1, true, null, 'value'] })).not.toThrow();
    expect(() => validateJsonValue({ lossy: undefined })).toThrow(/JSON|serializ/i);
  });

  test('uses the same actor-observation depth boundary standalone and inside an artifact', () => {
    const accepted = nestedValue(97);
    const acceptedRun = validRun();
    acceptedRun.actors[0]!.value = accepted;
    expect(() => validateJsonValue(accepted)).not.toThrow();
    expect(() => parseRunArtifact(acceptedRun)).not.toThrow();

    const rejected = nestedValue(98);
    const rejectedRun = validRun();
    rejectedRun.actors[0]!.value = rejected;
    expect(() => validateJsonValue(rejected)).toThrow(/depth/i);
    expect(() => parseRunArtifact(rejectedRun)).toThrow(/depth/i);
  });

  test('supports a caller-selected byte ceiling for actor observations', () => {
    expect(() => validateJsonValue('x'.repeat(1025), { maxBytes: 1024 })).toThrow(/byte|size|limit/i);
    expect(() => validateJsonValue('x'.repeat(1024), { maxBytes: 1024 })).not.toThrow();
  });

  test('validates JSON text and preserves serialized actor observations', () => {
    const run = validRun();

    const parsed = parseRunArtifact(JSON.stringify(run));

    expect(parsed).toEqual(run);
    expect(parsed.actors[0]!.value).toEqual({ balance: 10, observations: [true, null] });
  });

  test('accepts bounded startup identities for queryless connections and reconnects', () => {
    const run = clone(validRun());
    run.connections = [
      { actor: 'reader', connection: 0, fingerprint: fingerprintA },
      { actor: 'writer', connection: 0, fingerprint: fingerprintB },
      { actor: 'reader', connection: 2, fingerprint: fingerprintB },
    ];

    expect(parseRunArtifact(run).connections).toEqual(run.connections);
  });

  test('rejects malformed, duplicate, descending, or commandless startup identity substitutions', () => {
    const cases: Array<[string, unknown[]]> = [
      ['malformed fingerprint', [{ actor: 'reader', connection: 0, fingerprint: 'raw-startup-value' }]],
      ['duplicate generation', [
        { actor: 'reader', connection: 0, fingerprint: fingerprintA },
        { actor: 'reader', connection: 0, fingerprint: fingerprintB },
      ]],
      ['descending generation', [
        { actor: 'reader', connection: 2, fingerprint: fingerprintA },
        { actor: 'reader', connection: 1, fingerprint: fingerprintB },
      ]],
    ];
    for (const [name, connections] of cases) {
      const run = clone(validRun()); run.connections = connections;
      expect(() => parseRunArtifact(run), name).toThrow(/fingerprint|duplicate|increasing/i);
    }

    const unrecorded = clone(validRun());
    unrecorded.connections = [{ actor: 'reader', connection: 0, fingerprint: fingerprintA }];
    expect(() => parseRunArtifact(unrecorded)).toThrow(/unrecorded actor startup/i);

    const unknownActor = clone(validRun());
    unknownActor.connections = [
      { actor: 'reader', connection: 0, fingerprint: fingerprintA },
      { actor: 'writer', connection: 0, fingerprint: fingerprintB },
      { actor: 'third', connection: 1, fingerprint: fingerprintA },
    ];
    expect(() => parseRunArtifact(unknownActor)).toThrow(/absent.*actor results/i);
  });

  test('preserves user-selected SQL and observation fields verbatim without content scanning', () => {
    const run = validRun();
    run.trace[0]!.sql = "SELECT 'password=application-secret'";
    run.actors[0]!.value = {
      password: 'application-secret',
      connectionString: 'postgresql://application-user:application-secret@example.test/app',
    };

    expect(parseRunArtifact(run)).toBe(run);
  });

  test.each([
    ['version mismatch', (run: Record<string, unknown>) => { run.schemaVersion = 2; }, /version/i],
    ['unknown root field', (run: Record<string, unknown>) => { run.databaseUrl = 'postgres://secret'; }, /unknown/i],
    ['invalid outcome', (run: Record<string, unknown>) => { run.outcome = 'success'; }, /outcome/i],
    ['invalid mode', (run: Record<string, unknown>) => { run.mode = 'automatic'; }, /mode/i],
    ['infinite duration', (run: Record<string, unknown>) => { run.durationMs = Number.POSITIVE_INFINITY; }, /durationMs/i],
    ['bad startedAt', (run: Record<string, unknown>) => { run.startedAt = 'yesterday'; }, /startedAt/i],
  ])('rejects %s', (_name, mutate, message) => {
    const run = clone(validRun());
    mutate(run);
    expect(() => parseRunArtifact(run)).toThrow(message);
  });

  test.each([
    ['passed with a rejected actor', 'passed', true],
    ['violation with a rejected actor', 'violation', true],
    ['actor-error with every actor fulfilled', 'actor-error', false],
  ] as const)('rejects %s', (_name, outcome, rejectActor) => {
    const run = validRun();
    run.outcome = outcome;
    if (outcome !== 'violation') delete run.failure;
    if (rejectActor) run.actors[1] = { actor: 'writer', status: 'rejected', error: 'failed' };

    expect(() => parseRunArtifact(run)).toThrow(/actor|status|outcome/i);
  });

  test('rejects malformed nested fields and backend secrets', () => {
    const run = clone(validRun());
    const trace = run.trace as Array<Record<string, unknown>>;
    const completion = trace[0]!.completion as Record<string, unknown>;
    completion.backendKeyData = { processId: 123, secretKey: 456 };
    expect(() => parseRunArtifact(run)).toThrow(/unknown/i);

    delete completion.backendKeyData;
    completion.transactionStatus = 'X';
    expect(() => parseRunArtifact(run)).toThrow(/transactionStatus/i);
  });

  test('rejects inconsistent indices, ordinals, actors, fingerprints, and wait pids', () => {
    const cases: Array<(run: Record<string, unknown>) => void> = [
      run => { (run.trace as Array<Record<string, unknown>>)[1]!.index = 3; },
      run => {
        const step = { ...(run.trace as Array<Record<string, unknown>>)[0]!, index: 2, ordinal: 2 };
        (run.trace as Array<Record<string, unknown>>).push(step);
      },
      run => { (run.plan as string[])[0] = 'bad actor'; },
      run => { (run.trace as Array<Record<string, unknown>>)[0]!.fingerprint = 'not-a-fingerprint'; },
      run => {
        const step = (run.trace as Array<Record<string, unknown>>)[1]!;
        (step.waits as Array<Record<string, unknown>>)[0]!.pid = 999;
      },
    ];

    for (const mutate of cases) {
      const run = clone(validRun());
      mutate(run);
      expect(() => parseRunArtifact(run)).toThrow();
    }
  });

  test('rejects valid-looking actor ids that are inconsistent with recorded actor results', () => {
    const planRun = clone(validRun());
    (planRun.plan as string[])[0] = 'intruder';
    expect(() => parseRunArtifact(planRun)).toThrow(/actor|plan/i);

    const traceRun = clone(validRun());
    const step = (traceRun.trace as Array<Record<string, unknown>>)[0]!;
    step.actor = 'intruder';
    step.available = ['intruder'];
    expect(() => parseRunArtifact(traceRun)).toThrow(/actor|trace/i);
  });

  test.each([
    { bad: undefined },
    { bad: () => 'not JSON' },
    { bad: BigInt(1) },
    { bad: Number.NaN },
  ])('rejects actor return values that JSON would lose', value => {
    const run = validRun();
    run.actors[0]!.value = value;
    expect(() => parseRunArtifact(run)).toThrow(/JSON|serializ/i);
  });

  test('rejects cyclic and prototype-hostile actor return values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicRun = validRun();
    cyclicRun.actors[0]!.value = cyclic;
    expect(() => parseRunArtifact(cyclicRun)).toThrow(/cycl|JSON/i);

    const hostile = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const hostileRun = validRun();
    hostileRun.actors[0]!.value = hostile;
    expect(() => parseRunArtifact(hostileRun)).toThrow(/prototype|key/i);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test('rejects negative zero because JSON changes its value', () => {
    const run = validRun();
    run.actors[0]!.value = -0;
    expect(() => parseRunArtifact(run)).toThrow(/zero|JSON|serializ/i);
    expect(() => validateJsonValue(-0)).toThrow(/zero|JSON|serializ/i);
  });

  test('accepts an early harness failure with empty execution evidence', () => {
    const run = validRun();
    run.outcome = 'harness-error';
    delete run.failure;
    run.trace = [];
    run.actors = [];
    run.environment.serverVersion = 'unknown';

    expect(parseRunArtifact(run)).toBe(run);
  });

  test('accepts empty retained messages and reasons', () => {
    const violation = validRun();
    violation.failure!.message = '';
    violation.reason = '';
    violation.cleanup = { complete: false, error: '' };
    expect(parseRunArtifact(violation)).toBe(violation);
  });

  test('requires cleanup success and failure to use coherent evidence shapes', () => {
    const successful = validRun();
    successful.cleanup = { complete: true, error: 'contradiction' };
    expect(() => parseRunArtifact(successful)).toThrow(/cleanup|error|complete/i);

    const failed = validRun();
    failed.cleanup = { complete: false };
    expect(() => parseRunArtifact(failed)).toThrow(/cleanup|error|complete/i);
  });

  test('accepts partial actor results and incomplete steps for a failed execution', () => {
    const run = validRun();
    run.outcome = 'inconclusive';
    delete run.failure;
    run.reason = 'replay diverged';
    run.actors = [run.actors[0]!];
    delete run.trace[1]!.completedAt;
    delete run.trace[1]!.completion;

    expect(parseRunArtifact(run)).toBe(run);
  });

  test('caps the union of plan, trace, available, and result actor ids at eight for failed runs', () => {
    const run = validRun();
    run.outcome = 'inconclusive';
    delete run.failure;
    run.actors = [];
    run.plan = [];
    run.trace = Array.from({ length: 9 }, (_, index) => ({
      ...validRun().trace[0]!,
      index,
      actor: `actor${index}`,
      ordinal: 0,
      backendPid: 100 + index,
      available: [`actor${index}`],
      releasedAt: index / 10,
      completedAt: index / 10 + 0.01,
      waits: [],
    }));
    run.durationMs = 1;

    expect(() => parseRunArtifact(run)).toThrow(/actor|eight|8|limit/i);
  });

  test('accepts an empty PostgreSQL query and an empty thrown actor message', () => {
    const run = validRun();
    run.outcome = 'actor-error';
    delete run.failure;
    run.trace[0]!.sql = '';
    run.actors[1] = { actor: 'writer', status: 'rejected', error: '' };

    expect(parseRunArtifact(run)).toBe(run);
  });

  test.each(['scenario', 'calendar'] as const)('rejects malformed %s identity data', kind => {
    const run = validRun();
    if (kind === 'scenario') run.scenario = '   ';
    else run.startedAt = '2026-02-31T00:00:00.000Z';
    expect(() => parseRunArtifact(run)).toThrow(new RegExp(kind === 'scenario' ? 'scenario' : 'startedAt|timestamp', 'i'));
  });

  test('requires completion evidence and its timestamp to appear together', () => {
    for (const missing of ['completedAt', 'completion'] as const) {
      const run = validRun();
      delete run.trace[0]![missing];
      expect(() => parseRunArtifact(run)).toThrow(/complet/i);
    }
  });

  test('accepts only observed lock waits with nonempty blockers', () => {
    const nonLock = validRun();
    nonLock.trace[1]!.waits[0]!.waitEventType = 'Client';
    expect(() => parseRunArtifact(nonLock)).toThrow(/Lock|wait/i);

    const noBlocker = validRun();
    noBlocker.trace[1]!.waits[0]!.blockerPids = [];
    expect(() => parseRunArtifact(noBlocker)).toThrow(/blocker|wait/i);
  });

  test('requires every lock blocker to identify a different actor released in the trace', () => {
    const unknown = validRun();
    unknown.trace[1]!.waits[0]!.blockerPids = [999];
    expect(() => parseRunArtifact(unknown)).toThrow(/blocker|trace|pid/i);

    const self = validRun();
    self.trace[1]!.waits[0]!.blockerPids = [124];
    expect(() => parseRunArtifact(self)).toThrow(/blocker|self|actor|pid/i);

    const sameActor = validRun();
    sameActor.durationMs = 7;
    sameActor.trace[1]!.waits[0]!.blockerPids = [125];
    sameActor.trace.push({
      ...validRun().trace[0]!,
      index: 2,
      actor: 'writer',
      connection: 1,
      ordinal: 0,
      backendPid: 125,
      available: ['writer'],
      releasedAt: 6,
      completedAt: 7,
      waits: [],
    });
    expect(() => parseRunArtifact(sameActor)).toThrow(/blocker|actor|pid/i);

    const releasedLater = validRun();
    releasedLater.durationMs = 7;
    releasedLater.trace[1]!.waits[0]!.blockerPids = [125];
    releasedLater.trace.push({
      ...validRun().trace[0]!,
      index: 2,
      actor: 'reader',
      connection: 1,
      ordinal: 0,
      backendPid: 125,
      available: ['reader'],
      releasedAt: 6,
      completedAt: 7,
      waits: [],
    });
    expect(parseRunArtifact(releasedLater)).toBe(releasedLater);
  });

  test.each([
    ['release order', (run: RunResult) => {
      run.trace[0]!.releasedAt = 1;
      run.trace[1]!.releasedAt = 0.5;
    }],
    ['release after duration', (run: RunResult) => {
      run.trace[1]!.releasedAt = run.durationMs + 1;
      run.trace[1]!.completedAt = run.durationMs + 2;
    }],
    ['completion after duration', (run: RunResult) => { run.trace[1]!.completedAt = run.durationMs + 1; }],
  ] as const)('rejects invalid %s timestamps', (_name, mutate) => {
    const run = validRun();
    mutate(run);
    expect(() => parseRunArtifact(run)).toThrow(/duration|releasedAt|completedAt|time/i);
  });

  test('applies cumulative traversal and byte limits before serialization', () => {
    const tooManyNodes = validRun();
    const shared: unknown[] = [0];
    tooManyNodes.actors[0]!.value = Array.from({ length: 100_000 }, () => shared);
    expect(() => parseRunArtifact(tooManyNodes)).toThrow(/travers|node|limit|size/i);

    const tooManyBytes = validRun();
    const oneMiB = 'x'.repeat(1024 * 1024);
    tooManyBytes.actors[0]!.value = Array.from({ length: 17 }, () => oneMiB);
    expect(() => parseRunArtifact(tooManyBytes)).toThrow(/byte|16|size|limit/i);
  });

  test('rejects bounded arrays, SQL, and total input larger than 16 MiB', () => {
    const tooManyPlan = validRun();
    tooManyPlan.plan = Array.from({ length: 100_001 }, () => 'reader');
    expect(() => parseRunArtifact(tooManyPlan)).toThrow(/plan|limit/i);

    const hugeSql = validRun();
    hugeSql.trace[0]!.sql = 'x'.repeat(1_048_577);
    expect(() => parseRunArtifact(hugeSql)).toThrow(/sql|limit/i);

    expect(() => parseRunArtifact(' '.repeat(16 * 1024 * 1024 + 1))).toThrow(/16|size|large/i);
  });

  test('accepts the optional evidence-byte limit only within its supported range', () => {
    const accepted = clone(validRun());
    (accepted.limits as Record<string, unknown>).maxEvidenceBytes = 1024;
    expect(() => parseRunArtifact(accepted)).not.toThrow();

    for (const value of [1023, 12 * 1024 * 1024 + 1]) {
      const rejected = clone(validRun());
      (rejected.limits as Record<string, unknown>).maxEvidenceBytes = value;
      expect(() => parseRunArtifact(rejected)).toThrow(/maxEvidenceBytes|limit/i);
    }
  });
});

describe('run artifact file IO', () => {
  test('round trips a validated artifact through a path containing spaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interleave artifacts '));
    const path = join(directory, 'failure run.json');

    await writeRunArtifact(path, validRun());

    await expect(readRunArtifact(path)).resolves.toEqual(validRun());
    await expect(lstat(path)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  test('writes and reads a parser-valid artifact near the 16 MiB limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interleave-artifact-limit-'));
    const path = join(directory, 'large.json');
    const run = validRun();
    const repeated = 'x'.repeat(160);
    run.actors[0]!.value = Array.from({ length: 100_000 }, () => repeated);
    expect(Buffer.byteLength(JSON.stringify(run))).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(run, null, 2))).toBeGreaterThan(16 * 1024 * 1024);

    try {
      expect(parseRunArtifact(run)).toBe(run);
      await writeRunArtifact(path, run);
      await expect(readRunArtifact(path)).resolves.toEqual(run);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('refuses overwrite by default and atomically replaces when explicitly enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interleave-artifact-'));
    const path = join(directory, 'run.json');
    await writeRunArtifact(path, validRun());
    const original = await readFile(path, 'utf8');
    const replacement = validRun();
    replacement.reason = 'replacement';

    await expect(writeRunArtifact(path, replacement)).rejects.toThrow(/exist|overwrite/i);
    expect(await readFile(path, 'utf8')).toBe(original);

    await writeRunArtifact(path, replacement, { overwrite: true });
    await expect(readRunArtifact(path)).resolves.toMatchObject({ reason: 'replacement' });
    const entries = await import('node:fs/promises').then(fs => fs.readdir(directory));
    expect(entries).toEqual(['run.json']);
  });

  test('rejects truncated JSON and symlink inputs without executing anything', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interleave-artifact-'));
    const truncated = join(directory, 'truncated.json');
    const target = join(directory, 'target.json');
    const link = join(directory, 'link.json');
    await writeFile(truncated, '{"schemaVersion":1');
    await writeFile(target, JSON.stringify(validRun()));
    await symlink(target, link);

    await expect(readRunArtifact(truncated)).rejects.toThrow(/JSON|parse|artifact/i);
    await expect(readRunArtifact(link)).rejects.toThrow(/symbolic|symlink/i);
  });

  test('rejects an oversized file before reading and leaves no destination on validation failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interleave-artifact-'));
    const oversized = join(directory, 'oversized.json');
    const invalidDestination = join(directory, 'invalid.json');
    await writeFile(oversized, Buffer.alloc(16 * 1024 * 1024 + 1, 32));

    await expect(readRunArtifact(oversized)).rejects.toThrow(/16|size|large/i);
    await expect(writeRunArtifact(invalidDestination, { ...validRun(), schemaVersion: 2 as 1 })).rejects.toThrow(/version/i);
    await expect(access(invalidDestination, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
