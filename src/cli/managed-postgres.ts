import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { POSTGRES_IMAGES } from './options.js';

export interface ManagedPostgresOptions { image: string; signal?: AbortSignal; onProgress?: (message: string) => void }
export interface ManagedPostgresDependencies {
  docker(args: string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<string>;
  probe(databaseUrl: string): Promise<string>;
  pause(): Promise<void>;
  now(): number;
}
const execute = promisify(execFile);
const OWNER_LABEL = 'io.interleave.cli-owner';
const INSPECT = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"requestedImage":{{json .Config.Image}},"owner":{{json (index .Config.Labels "' + OWNER_LABEL + '")}},"status":{{json .State.Status}},"ports":{{json .NetworkSettings.Ports}}}';
const defaults: ManagedPostgresDependencies = {
  async docker(args, options) {
    const result = await execute('docker', args, { encoding: 'utf8', timeout: options.timeoutMs,
      killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: options.env ?? process.env });
    return result.stdout.trim();
  },
  async probe(databaseUrl) {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1000, query_timeout: 1000 });
    client.on('error', () => {});
    try {
      await client.connect();
      return String((await client.query("SELECT current_setting('server_version') AS version")).rows[0]?.version ?? '');
    } finally { await client.end(); }
  },
  pause: () => new Promise(resolve => setTimeout(resolve, 250)),
  now: () => performance.now(),
};
interface Identity { id: string; name: string; image: string; requestedImage: string; owner: string; status: string; ports: unknown }
function message(error: unknown): string { return error instanceof Error ? error.message : 'Command failed'; }
function missing(error: unknown, target: string): boolean {
  if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string') return false;
  const match = /^Error(?: response from daemon)?: No such (?:object|container): (.+)$/i.exec(error.stderr.trim());
  return match?.[1] === target;
}

/** Own one local server for a CLI command. Application databases retain their existing independent lifecycle. */
export async function withManagedPostgres<T>(options: ManagedPostgresOptions, use: (databaseUrl: string) => Promise<T>, dependencies: ManagedPostgresDependencies = defaults): Promise<T> {
  if (!POSTGRES_IMAGES.includes(options.image as typeof POSTGRES_IMAGES[number])) throw new TypeError('Unsupported managed PostgreSQL image');
  const docker = (args: string[], timeoutMs = 15_000, env?: NodeJS.ProcessEnv) => dependencies.docker(args, { timeoutMs, ...(env ? { env } : {}) });
  const check = () => { if (options.signal?.aborted) throw new Error('Managed PostgreSQL command was cancelled'); };
  check();
  try { await docker(['info', '--format', '{{.ServerVersion}}']); }
  catch (error) {
    const reason = error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'Docker CLI was not found' : 'Docker is unavailable';
    throw new Error(`${reason}. Install/start Docker and check engine access, or omit --docker and set TEST_DATABASE_URL to a dedicated PostgreSQL administrator database.`);
  }
  check();
  const owner = randomUUID(), name = `interleave-cli-${owner}`, password = randomBytes(24).toString('hex');
  const redact = (text: string) => text.replaceAll(/postgres(?:ql)?:\/\/[^\s]+/g, '[managed PostgreSQL URL]').replaceAll(password, '[managed password]');
  let id: string | undefined, image: string | undefined;
  const progress = (text: string) => options.onProgress?.(`[interleave] ${text}`);
  async function inspect(target: string): Promise<Identity | undefined> {
    let raw: string;
    try { raw = await docker(['inspect', '--type', 'container', '--format', INSPECT, target]); }
    catch (error) { if (missing(error, target)) return; throw new Error(`Could not verify container ownership/absence for ${name}. Check Docker engine access.`); }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error(`Docker returned invalid ownership information for ${name}`); }
    if (typeof value !== 'object' || value === null) throw new Error(`Docker returned invalid ownership information for ${name}`);
    const record = value as Identity;
    if (!/^[a-f0-9]{64}$/.test(record.id ?? '') || record.name !== '/' + name || record.owner !== owner
      || !/^sha256:[a-f0-9]{64}$/.test(record.image ?? '') || record.requestedImage !== options.image
      || (id !== undefined && record.id !== id) || (image !== undefined && record.image !== image)) {
      throw new Error(`Refusing container operation because ownership did not match ${name}`);
    }
    return record;
  }
  async function cleanup(): Promise<void> {
    // Recovery after a lost create reply is limited to the unpredictable exact
    // proposed name and its owner label, never a substring or label-only sweep.
    const record = await inspect(id ?? name);
    if (!record) { progress(`Verified owned server absent (${name}).`); return; }
    id ??= record.id; image ??= record.image;
    try { await docker(['rm', '--force', '--volumes', record.id], 30_000); }
    catch { throw new Error(`Could not remove owned container ${name}. Restore Docker access and inspect this exact container.`); }
    if (await inspect(record.id)) throw new Error(`Could not verify owned container absence after removal: ${name}`);
    progress(`Removed owned server and verified absence (${name}).`);
  }
  let result: T | undefined, failure: unknown, failed = false;
  try {
    progress(`Starting disposable ${options.image} (${name}); the first use may download the image.`);
    let reply: string;
    try {
      // Only the environment carries the password. Docker output is bounded and
      // never included in progress or exceptions.
      reply = await docker(['create', '--pull=missing', '--name', name, '--label', `${OWNER_LABEL}=${owner}`,
        '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=postgres', '--env', 'POSTGRES_DB=postgres', options.image],
      180_000, { ...process.env, POSTGRES_PASSWORD: password });
    } catch { throw new Error(`Could not create managed PostgreSQL ${name} or download ${options.image}. Check Docker access, resources and image availability.`); }
    if (!/^[a-f0-9]{64}$/.test(reply)) throw new Error(`Docker returned an invalid create identity for ${name}`);
    const created = await inspect(reply);
    if (!created) throw new Error(`Created managed PostgreSQL container is absent: ${name}`);
    if (created.id !== reply) throw new Error(`Docker returned an inconsistent create identity for ${name}`);
    id = created.id;
    image = created.image;
    check();
    try { await docker(['start', id]); }
    catch { throw new Error(`Could not start managed PostgreSQL ${name}. Check Docker resources.`); }
    const deadline = dependencies.now() + 90_000;
    let url: string | undefined;
    while (dependencies.now() < deadline) {
      check();
      const state = await inspect(id);
      if (!state || !['running', 'created', 'restarting'].includes(state.status)) throw new Error(`Managed PostgreSQL stopped before readiness: ${name}`);
      if (state.status === 'running') {
        const ports = state.ports as Record<string, unknown> | null;
        const bindings = ports?.['5432/tcp'];
        if (!Array.isArray(bindings) || bindings.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1'
          || typeof bindings[0]?.HostPort !== 'string' || !/^\d+$/.test(bindings[0].HostPort)
          || Number(bindings[0].HostPort) < 1 || Number(bindings[0].HostPort) > 65535) {
          throw new Error(`Managed PostgreSQL requires exactly one loopback-only port: ${name}`);
        }
        let logs: string;
        try { logs = await docker(['logs', '--tail', '200', id]); }
        catch { throw new Error(`Could not inspect PostgreSQL startup readiness: ${name}`); }
        if (logs.split(/\r?\n/).some(line => line.trim() === 'PostgreSQL init process complete; ready for start up.')) {
          const endpoint = new URL(`postgresql://${bindings[0].HostIp}:${bindings[0].HostPort}/postgres`);
          endpoint.username = 'postgres';
          endpoint.password = password;
          const candidate = endpoint.toString();
          try {
            const version = await dependencies.probe(candidate);
            const major = options.image === POSTGRES_IMAGES[3] ? '17' : options.image.split(':')[1];
            if (!version.startsWith(major + '.')) throw new Error('Unexpected PostgreSQL version');
            url = candidate;
          } catch { /* The final post-init TCP server may still be starting. */ }
          if (url) break;
        }
      }
      await dependencies.pause();
    }
    if (!url) throw new Error(`PostgreSQL did not reach final startup readiness within 90 seconds: ${name}`);
    check(); progress(`Disposable PostgreSQL is ready (${name}); running the command.`);
    result = await use(url);
  } catch (error) { failure = error; failed = true; }
  try { await cleanup(); }
  catch (error) {
    const cleanupMessage = `Managed PostgreSQL cleanup failed: ${message(error)}`;
    throw new Error(redact(!failed ? cleanupMessage : `${message(failure)}\n${cleanupMessage}`));
  }
  if (failed) {
    const safe = redact(message(failure));
    if (failure instanceof Error && safe === failure.message) throw failure;
    throw new Error(safe);
  }
  return result as T;
}
