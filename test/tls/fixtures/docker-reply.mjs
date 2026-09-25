import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2), create = args[0] === 'create';
if (create) process.on('SIGTERM', async () => {
  await writeFile(process.env.TLS_REPLY_SIGNAL, 'received');
  process.exit(143);
});
const child = spawn(process.env.TLS_REAL_DOCKER, args, { stdio: ['ignore', create ? 'pipe' : 'inherit', 'inherit'] });
let reply = '';
if (create) child.stdout.on('data', bytes => { reply += bytes; });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
if (create && code === 0) {
  await writeFile(process.env.TLS_REPLY_READY, reply);
  const deadline = Date.now() + 20_000;
  while (true) {
    try { await access(process.env.TLS_REPLY_RELEASE); break; } catch {}
    if (Date.now() > deadline) throw new Error('Create-reply fixture was not released');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  process.stdout.write(reply);
}
process.exitCode = code ?? 1;
