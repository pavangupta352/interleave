import { describe, expect, test } from 'vitest';
import { processActor } from '../src/process-actor.js';
import type { ActorContext } from '../src/types.js';

const node = process.execPath;
const endpoint = 'postgresql://app%20user:s3cr%40t@127.0.0.1:54321/interleave_0123456789abcdef0123456789abcdef?application_name=shop';
function context(signal = new AbortController().signal): ActorContext {
  return { actor: 'alice', connectionString: endpoint, signal };
}
const script = (source: string) => ['-e', source];

describe('processActor', () => {
  test('gives the program only its actor endpoint through DATABASE_URL and libpq variables', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, { PGSSLMODE: 'require', PGHOSTADDR: '10.0.0.1', PGSERVICE: 'production', DATABASE_URL: 'postgresql://elsewhere/db' });
    try {
      const value = await processActor(node, script(`console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PG') || ['DATABASE_URL', 'INTERLEAVE_ACTOR', 'SHOP_URL'].includes(key)))))`),
        { env: ({ connectionString }) => ({ SHOP_URL: connectionString }) })(context());
      expect(value).toEqual({
        DATABASE_URL: endpoint, SHOP_URL: endpoint, INTERLEAVE_ACTOR: 'alice',
        PGHOST: '127.0.0.1', PGPORT: '54321', PGDATABASE: 'interleave_0123456789abcdef0123456789abcdef',
        PGUSER: 'app user', PGPASSWORD: 's3cr@t', PGSSLMODE: 'disable', PGGSSENCMODE: 'disable',
      });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  test('returns one JSON document from stdout, nothing for empty output, and ignores output on request', async () => {
    expect(await processActor(node, script('process.stdout.write(\' {"sold": 1}\\n\')'))(context())).toEqual({ sold: 1 });
    expect(await processActor(node, script('console.error("log")'))(context())).toBeUndefined();
    expect(await processActor(node, script('console.log("not json")'), { output: 'ignore' })(context())).toBeUndefined();
    await expect(processActor(node, script('console.log("a"); console.log("b")'))(context())).rejects.toThrow(/not one JSON document; write logs to stderr/);
  });

  test('rejects a failing program with its exit status and a redacted stderr tail', async () => {
    const run = processActor(node, script('console.error("could not connect with s3cr@t"); process.exit(3)'));
    const error = await run(context()).then(() => undefined, (reason: Error) => reason);
    expect(error?.message).toMatch(/exited with code 3/);
    expect(error?.message).toContain('could not connect with [redacted]');
    expect(error?.message).not.toContain('s3cr@t');
    await expect(processActor('interleave-command-that-does-not-exist')(context())).rejects.toThrow(/Could not start process actor interleave-command-that-does-not-exist: ENOENT/);
  });

  test('cancels with SIGTERM and escalates to SIGKILL after the grace period', async () => {
    const controller = new AbortController();
    const started = performance.now();
    const running = processActor(node, script('process.on("SIGTERM", () => {}); console.error("ready"); setInterval(() => {}, 1000)'), { killGraceMs: 200 })(context(controller.signal));
    setTimeout(() => controller.abort(), 300);
    await expect(running).rejects.toThrow(/was cancelled/);
    expect(performance.now() - started).toBeLessThan(5_000);
    const aborted = new AbortController(); aborted.abort();
    await expect(processActor(node, script('0'))(context(aborted.signal))).rejects.toThrow();
  });

  test('bounds captured stdout and validates options before running', async () => {
    await expect(processActor(node, script('process.stdout.write("x".repeat(4096))'), { maxOutputBytes: 1024 })(context())).rejects.toThrow(/exceeded 1024 stdout bytes/);
    expect(() => processActor('')).toThrow(/requires a command/);
    expect(() => processActor(node, [1 as unknown as string])).toThrow(/must be strings/);
    expect(() => processActor(node, [], { output: 'text' as 'json' })).toThrow(/output/);
    expect(() => processActor(node, [], { maxOutputBytes: 0 })).toThrow(/maxOutputBytes/);
    expect(() => processActor(node, [], { killGraceMs: 1.5 })).toThrow(/killGraceMs/);
  });
});
