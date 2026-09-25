import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile), here = dirname(fileURLToPath(import.meta.url));
const actualDocker = (await execute('sh', ['-c', 'command -v docker'])).stdout.trim();
async function waitFile(path) {
  const deadline = Date.now() + 30_000;
  while (true) {
    try { return await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() > deadline) throw new Error('Timed out waiting for create-reply boundary');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
for (const delivery of ['pid', 'group']) test(`owner ${delivery} cancellation retains an in-flight real create reply and removes the exact server`, { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interleave-tls-signal-'));
  const paths = { ready: join(directory, 'ready'), release: join(directory, 'release'), signal: join(directory, 'signaled'), events: join(directory, 'events.jsonl') };
  const launcher = join(directory, 'docker');
  await copyFile(join(here, 'fixtures/docker-reply.mjs'), join(directory, 'reply.mjs'));
  await writeFile(launcher, '#!' + process.execPath + '\nimport "./reply.mjs";\n'); await chmod(launcher, 0o700);
  const child = spawn(process.execPath, [join(here, 'fixtures/signal-owner.mjs')], { detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_OPTIONS: '', PATH: directory + ':' + process.env.PATH,
      TLS_REAL_DOCKER: actualDocker, TLS_EVENTS: paths.events, TLS_REPLY_READY: paths.ready,
      TLS_REPLY_RELEASE: paths.release, TLS_REPLY_SIGNAL: paths.signal } });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const received = new Promise(resolve => child.on('message', event => { if (event.type === 'signal-received') resolve(); }));
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  try {
    const id = (await waitFile(paths.ready)).trim(); assert.match(id, /^[a-f0-9]{64}$/);
    process.kill(delivery === 'group' ? -child.pid : child.pid, 'SIGTERM');
    await Promise.race([received, closed.then(() => { throw new Error('Owner exited before acknowledging cancellation'); })]);
    await writeFile(paths.release, 'release original create identity');
    assert.deepEqual(await closed, { code: 143, signal: null }, output);
    await assert.rejects(access(paths.signal), { code: 'ENOENT' });
    const events = (await readFile(paths.events, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.find(event => event.type === 'created')?.id, id);
    const removed = events.find(event => event.type === 'removed');
    assert.equal(removed?.id, id); assert.equal(removed.absent, true);
    assert.equal(events.some(event => event.type === 'ready'), false);
    for (const target of [removed.name, id]) await assert.rejects(execute(actualDocker, ['inspect', '--type', 'container', '--format', '{{.Id}}', target]), error => {
      assert.equal(error.code, 1); assert.match(error.stderr, new RegExp(`No such (?:object|container): ${target}\\s*$`)); return true;
    });
    console.log(JSON.stringify({ delivery, id, name: removed.name, replyPreserved: true, independentlyAbsent: true }));
  } finally {
    await writeFile(paths.release, 'ensure owned create reply can settle');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
