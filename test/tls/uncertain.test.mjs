import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
for (const mode of ['invalid-reply', 'command-error']) test(`missing inspection after ${mode} does not prove uncertain create absence`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interleave-tls-uncertain-'));
  try {
    const docker = join(directory, 'docker');
    await writeFile(docker, `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='info')console.log('test-daemon');
else if(args[0]==='create'){if(process.env.TLS_TEST_REPLY==='invalid-reply')console.log('lost-identity');else process.exitCode=1;}
else if(args[0]==='inspect'){console.error('Error response from daemon: No such container: '+args.at(-1));process.exitCode=1;}
else process.exitCode=99;
`); await chmod(docker, 0o700);
    const source = `import assert from 'node:assert/strict';import {withTlsTestServer} from ${JSON.stringify(new URL('../../scripts/tls-test-server.mjs', import.meta.url).href)};
const events=[];let started=false;
await assert.rejects(withTlsTestServer({onEvent:event=>events.push(event)},async()=>{started=true}),/absence remains unconfirmed/);
assert.equal(started,false);assert.equal(events.some(event=>event.type==='removed'),false);
console.log('Unconfirmed create remains unconfirmed');`;
    const result = await execute(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, NODE_OPTIONS: '', PATH: directory + ':' + process.env.PATH, TLS_TEST_REPLY: mode }, timeout: 15000 });
    assert.match(result.stdout, /Unconfirmed create remains unconfirmed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
