import { spawn } from 'node:child_process';
import type { ActorContext } from './types.js';

export interface ProcessActorOptions {
  /** Working directory for the program; defaults to the current directory. */
  cwd?: string;
  /** Extra variables, or a function of the actor context, merged over the inherited environment. */
  env?: Record<string, string> | ((context: ActorContext) => Record<string, string>);
  /** `json`: stdout is empty or one JSON document, returned as the actor value. `ignore`: discard stdout. */
  output?: 'json' | 'ignore';
  /** Captured stdout bytes; default 1 MiB, at most 8 MiB. */
  maxOutputBytes?: number;
  /** Delay between SIGTERM and SIGKILL after cancellation; default 1000 ms. */
  killGraceMs?: number;
}

const STDERR_TAIL_BYTES = 2048;

function bounded(value: number | undefined, fallback: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TypeError(`${name} must be an integer from 1 to ${max}`);
  return result;
}

/**
 * Run an external program (any language) as an actor. It connects through its own
 * actor endpoint, supplied as DATABASE_URL and the libpq PG* variables. Scheduling
 * applies to its PostgreSQL commands exactly as for in-process actors.
 */
export function processActor(command: string, args: readonly string[] = [], options: ProcessActorOptions = {}): (context: ActorContext) => Promise<unknown> {
  if (typeof command !== 'string' || !command) throw new TypeError('processActor requires a command');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new TypeError('processActor arguments must be strings');
  const output = options.output ?? 'json';
  if (output !== 'json' && output !== 'ignore') throw new TypeError("processActor output must be 'json' or 'ignore'");
  const maxOutputBytes = bounded(options.maxOutputBytes, 1024 * 1024, 8 * 1024 * 1024, 'maxOutputBytes');
  const killGraceMs = bounded(options.killGraceMs, 1_000, 60_000, 'killGraceMs');
  const fixedArgs = [...args];
  return context => new Promise<unknown>((resolve, reject) => {
    context.signal.throwIfAborted();
    const url = new URL(context.connectionString);
    const password = decodeURIComponent(url.password);
    const env: NodeJS.ProcessEnv = {};
    // libpq and most drivers read PG* variables; only the actor endpoint may reach the program.
    for (const [key, value] of Object.entries(process.env)) if (!/^PG[A-Z_]*$/.test(key) && key !== 'DATABASE_URL') env[key] = value;
    Object.assign(env, {
      DATABASE_URL: context.connectionString, INTERLEAVE_ACTOR: context.actor,
      PGHOST: url.hostname, PGPORT: url.port, PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: password, PGSSLMODE: 'disable', PGGSSENCMODE: 'disable',
    }, typeof options.env === 'function' ? options.env(context) : options.env);
    const child = spawn(command, fixedArgs, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let overflow = false; let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const redact = (text: string) => password ? text.replaceAll(password, '[redacted]') : text;
    const finish = (error: Error | undefined, value?: unknown) => {
      if (settled) return; settled = true;
      context.signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs); killTimer.unref();
    };
    context.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (output === 'ignore' || overflow) return;
      if (stdout.length + chunk.length > maxOutputBytes) { overflow = true; abort(); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-STDERR_TAIL_BYTES); });
    child.once('error', error => finish(new Error(`Could not start process actor ${command}: ${(error as NodeJS.ErrnoException).code ?? error.message}`)));
    child.once('close', (code, signal) => {
      const tail = redact(stderr.toString('utf8').trim());
      const detail = tail ? `\n${tail}` : '';
      if (context.signal.aborted) return finish(new Error(`Process actor ${command} was cancelled`));
      if (overflow) return finish(new Error(`Process actor ${command} exceeded ${maxOutputBytes} stdout bytes`));
      if (code !== 0) return finish(new Error(`Process actor ${command} ${signal ? `was terminated by ${signal}` : `exited with code ${code}`}${detail}`));
      if (output === 'ignore') return finish(undefined);
      const text = stdout.toString('utf8').trim();
      if (!text) return finish(undefined);
      try { finish(undefined, JSON.parse(text)); }
      catch { finish(new Error(`Process actor ${command} printed output that is not one JSON document; write logs to stderr${detail}`)); }
    });
  });
}
