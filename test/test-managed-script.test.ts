import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test.skipIf(process.platform === 'win32').each([
  ['SIGINT', 'direct'], ['SIGTERM', 'direct'], ['SIGINT', 'group'],
] as const)('managed qualification parent awaits cleanup after %s delivered to %s', async (signal, target) => {
  const root = await mkdtemp(join(tmpdir(), 'interleave managed supervisor '));
  let childPid: number | undefined;
  const ready = join(root, 'ready'), cleaned = join(root, 'cleaned');
  await mkdir(join(root, 'scripts')); await mkdir(join(root, 'node_modules/vitest'), { recursive: true });
  await cp(new URL('../scripts/test-managed.mjs', import.meta.url), join(root, 'scripts/test-managed.mjs'));
  await writeFile(join(root, 'node_modules/vitest/vitest.mjs'), `import fs from 'node:fs';\nfs.writeFileSync(process.env.TEST_READY,String(process.pid));\nconst timer=setInterval(()=>{const file=process.env.INTERLEAVE_MANAGED_STOP_FILE;if(file&&fs.existsSync(file)){clearInterval(timer);setTimeout(()=>{fs.writeFileSync(process.env.TEST_CLEANED,fs.readFileSync(file));process.exitCode=0},100)}},10);\n`);
  const child = spawn(process.execPath, [join(root, 'scripts/test-managed.mjs')], {
    env: { ...process.env, TEST_READY: ready, TEST_CLEANED: cleaned }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!childPid && Date.now() < deadline) { childPid = Number(await readFile(ready, 'utf8').catch(() => '')) || undefined; if (!childPid) await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(childPid).toBeDefined();
    if (target === 'group') process.kill(-child.pid!, signal); else child.kill(signal);
    expect(await result, stderr).toEqual({ code: signal === 'SIGINT' ? 130 : 143, signal: null });
    expect(await readFile(cleaned, 'utf8')).toBe(signal);
    expect(() => process.kill(childPid!, 0)).toThrow();
  } finally {
    child.kill('SIGKILL'); await result;
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});
