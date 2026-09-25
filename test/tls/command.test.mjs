import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tlsTestCommand } from '../../scripts/tls-test-command.mjs';

test('bounded command keeps successful stdout and stderr separate', async () => {
  const result = await tlsTestCommand(process.execPath, ['-e', "process.stdout.write('result');process.stderr.write('diagnostic')"]);
  assert.deepEqual(result, { stdout: 'result', stderr: 'diagnostic' });
});
test('failed command preserves an inspectable status without logging its arguments or stderr', async () => {
  await assert.rejects(tlsTestCommand(process.execPath, ['-e', "process.stderr.write('private-sentinel');process.exit(7)"]), error => {
    assert.equal(error.code, 7); assert.equal(error.stderr, 'private-sentinel');
    assert.equal(String(error).includes('private-sentinel'), false);
    assert.equal(JSON.stringify(error).includes('private-sentinel'), false);
    return true;
  });
});
test('missing executable rejects with its actual launch code', async () => {
  await assert.rejects(tlsTestCommand('/interleave-unavailable-test-command', []), { code: 'ENOENT' });
});
test('deadline terminates the exact stalled child before rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'interleave-tls-command-'));
  const pidFile = join(directory, 'pid');
  try {
    await assert.rejects(tlsTestCommand(process.execPath, ['-e',
      "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", pidFile], { timeout: 500 }), { code: 'ETIMEDOUT' });
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('combined output overflow rejects rather than returning truncated success', async () => {
  await assert.rejects(tlsTestCommand(process.execPath, ['-e',
    "process.stdout.write('x'.repeat(2048));setInterval(()=>{},1000)"], { maxBuffer: 1024 }), { code: 'ERR_OUTPUT_LIMIT' });
});
