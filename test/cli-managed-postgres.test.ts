import { expect, test } from 'vitest';
import { withManagedPostgres, type ManagedPostgresDependencies } from '../src/cli/managed-postgres.js';

const id = 'a'.repeat(64), foreignId = 'b'.repeat(64), imageId = 'sha256:' + 'c'.repeat(64);
const marker = 'PostgreSQL init process complete; ready for start up.';
const absent = (target: string) => Object.assign(new Error('inspect failed'), { stderr: 'Error: No such object: ' + target });
type State = { id: string; name: string; image: string; requestedImage: string; owner: string; status: string; ports: Record<string, unknown> };

function engine() {
  let record: State | undefined, time = 0;
  const args: string[][] = [], progress: string[] = [], removed: string[] = [];
  const created: State[] = [];
  let secret = '', probes = 0;
  const control = {
    createError: false, collision: false, unavailable: false, missing: false, badReply: false, wrongIdReply: false,
    badPort: false, initOnly: false, removalError: false, disappearanceError: false,
    mutateOnCleanup: false, mutation: 'owner' as 'owner' | 'id' | 'image' | 'name',
    afterCreate: undefined as (() => void) | undefined,
  };
  const dependencies: ManagedPostgresDependencies = {
    now: () => time,
    pause: async () => { time += 30_000; },
    probe: async url => { probes++; expect(new URL(url).hostname).toBe('127.0.0.1'); return '16.15'; },
    docker: async (command, options) => {
      args.push([...command]);
      if (command[0] === 'info') {
        if (control.missing) throw Object.assign(new Error('DO NOT EXPOSE raw private daemon output'), { code: 'ENOENT' });
        if (control.unavailable) throw new Error('DO NOT EXPOSE raw private daemon output');
        return '28.3.3';
      }
      if (command[0] === 'create') {
        secret = options.env?.POSTGRES_PASSWORD ?? '';
        const name = command[command.indexOf('--name') + 1]!;
        const label = command[command.indexOf('--label') + 1]!;
        record = { id, name: '/' + name, image: imageId, requestedImage: command.at(-1)!, owner: label.slice(label.indexOf('=') + 1), status: 'created', ports: {} };
        if (control.collision) { record.owner = 'foreign'; record.id = foreignId; }
        created.push({ ...record }); control.afterCreate?.();
        if (control.createError || control.collision) throw new Error('DO NOT EXPOSE ' + secret);
        return control.badReply ? 'invalid reply ' + secret : control.wrongIdReply ? foreignId : id;
      }
      if (command[0] === 'inspect') {
        if (!record) {
          if (control.disappearanceError) throw Object.assign(new Error('Daemon unavailable'), { stderr: 'Cannot connect to the Docker daemon' });
          throw absent(command.at(-1)!);
        }
        const value = { ...record };
        if (control.mutateOnCleanup && probes) value[control.mutation] = control.mutation === 'id' ? foreignId : 'foreign';
        return JSON.stringify(value);
      }
      if (command[0] === 'start') {
        if (!record || command[1] !== record.id) throw new Error('Starting unowned container');
        record.status = 'running';
        record.ports = { '5432/tcp': [{ HostIp: control.badPort ? '0.0.0.0' : '127.0.0.1', HostPort: '54321' }] };
        return record.id;
      }
      if (command[0] === 'logs') return control.initOnly ? 'database system is ready to accept connections' : marker;
      if (command[0] === 'rm') {
        if (control.removalError) throw new Error('Removal failed ' + secret);
        const target = command.at(-1)!;
        if (!record || target !== record.id) throw new Error('Removing unowned container');
        removed.push(target); record = undefined; return target;
      }
      throw new Error('Unexpected Docker command');
    },
  };
  return { dependencies, control, args, progress, removed, created, get secret() { return secret; }, get probes() { return probes; }, get record() { return record; },
    run: <T>(use: (url: string) => Promise<T>, signal?: AbortSignal) => withManagedPostgres({ image: 'postgres:16', onProgress: message => progress.push(message), ...(signal ? { signal } : {}) }, use, dependencies) };
}

test('returns application output only after exact owned container removal and verified absence', async () => {
  const f = engine();
  const result = await f.run(async url => {
    expect(f.record?.status).toBe('running'); expect(f.probes).toBe(1);
    expect(new URL(url).password).toBe(f.secret); return { outcome: 'violation' };
  });
  expect(result).toEqual({ outcome: 'violation' }); expect(f.record).toBeUndefined(); expect(f.removed).toEqual([id]);
  expect(f.secret).toMatch(/^[a-f0-9]{48}$/);
  expect(JSON.stringify([f.args, f.progress, f.created])).not.toContain(f.secret);
  expect(f.args.find(command => command[0] === 'create')).toContain('127.0.0.1::5432');
});
test.each(['missing', 'unavailable'] as const)('an %s Docker engine never starts application work or exposes daemon output', async mode => {
  const f = engine(); f.control[mode] = true;
  await expect(f.run(async () => { throw new Error('application callback was reached'); })).rejects.toThrow(/Docker.*(found|unavailable)/);
  expect(f.created).toEqual([]); expect(f.probes).toBe(0);
});
test.each(['createError', 'badReply', 'wrongIdReply'] as const)('recovers owned identity after %s without running the application', async mode => {
  const f = engine(); f.control[mode] = true;
  await expect(f.run(async () => 'must not run')).rejects.toThrow(/create|identity/i);
  expect(f.probes).toBe(0); expect(f.removed).toEqual([id]); expect(f.record).toBeUndefined();
  expect(JSON.stringify(f.progress)).not.toContain(f.secret);
});
test('a foreign name collision is retained without start or removal', async () => {
  const f = engine(); f.control.collision = true;
  await expect(f.run(async () => 'must not run')).rejects.toThrow(/ownership/);
  expect(f.record?.id).toBe(foreignId); expect(f.removed).toEqual([]); expect(f.probes).toBe(0);
});
test('interruption while create completes still recovers and removes its exact container', async () => {
  const f = engine(), controller = new AbortController(); f.control.afterCreate = () => controller.abort();
  await expect(f.run(async () => 'must not run', controller.signal)).rejects.toThrow(/cancel/i);
  expect(f.removed).toEqual([id]); expect(f.probes).toBe(0);
});
test.each(['badPort', 'initOnly'] as const)('%s cannot count as readiness', async mode => {
  const f = engine(); f.control[mode] = true;
  await expect(f.run(async () => 'must not run')).rejects.toThrow(/loopback|ready|readiness/i);
  expect(f.probes).toBe(0); expect(f.removed).toEqual([id]);
});
test.each(['owner', 'id', 'name', 'image'] as const)('a changed %s identity prevents cleanup of a foreign container', async mutation => {
  const f = engine(); f.control.mutateOnCleanup = true; f.control.mutation = mutation;
  await expect(f.run(async () => 'completed application')).rejects.toThrow(/ownership/);
  expect(f.removed).toEqual([]); expect(f.record).toBeDefined();
});
test.each(['removalError', 'disappearanceError'] as const)('%s never turns a finished application into a successful command', async mode => {
  const f = engine(); f.control[mode] = true;
  const failure = await f.run(async () => 'completed application').catch(error => error);
  expect(failure).toBeInstanceOf(Error); expect(failure.message).toMatch(/remove|absence|cleanup/i);
  expect(failure.message).toContain(f.created[0]!.name.slice(1)); expect(failure.message).not.toContain(f.secret);
});
test('retains the application failure and a cleanup failure together', async () => {
  const f = engine(); f.control.removalError = true;
  await expect(f.run(async () => { throw new Error('Cannot write selected output'); })).rejects.toThrow(/Cannot write selected output.*cleanup/is);
});
test('a callback rejection with no Error value cannot become success', async () => {
  const f = engine(); let rejected = false;
  await f.run(async () => { throw undefined; }).catch(() => { rejected = true; });
  expect(rejected).toBe(true); expect(f.record).toBeUndefined();
});
test('generated credentials in a callback error never leave the managed boundary', async () => {
  const f = engine();
  const failure = await f.run(async url => { throw new Error('Connection failed ' + url); }).catch(error => error);
  expect(failure).toBeInstanceOf(Error); expect(failure.message).toContain('Connection failed');
  expect(failure.message).not.toContain(f.secret); expect(failure.message).not.toContain('postgresql://');
});
