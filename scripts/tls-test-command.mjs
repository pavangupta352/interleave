import { spawn } from 'node:child_process';

// Test-only bounded command runner. execFile does not forward `detached` to spawn.
// Parent cancellation must not kill an in-flight Docker create response.
export function tlsTestCommand(executable, args, { cwd, env = process.env, timeout = 15_000, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    let size = 0, failure;
    const stop = code => {
      failure ??= code;
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) { if (error.code !== 'ESRCH') failure = 'ERR_TERMINATION'; }
    };
    const timer = setTimeout(() => stop('ETIMEDOUT'), timeout);
    for (const channel of ['stdout', 'stderr']) child[channel].on('data', chunk => {
      size += chunk.length;
      if (size > maxBuffer) stop('ERR_OUTPUT_LIMIT');
      else chunks[channel].push(chunk);
    });
    child.once('error', error => { failure ??= error.code ?? 'ERR_SPAWN'; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const output = { stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') };
      if (!failure && code === 0 && signal === null) { resolve(output); return; }
      const error = new Error('TLS fixture subprocess failed');
      error.code = failure ?? code; error.signal = signal;
      // Docker's exact absence diagnostic is needed for ownership verification.
      // Do not print arbitrary command arguments or stderr as an error message.
      Object.defineProperty(error, 'stderr', { value: output.stderr });
      reject(error);
    });
  });
}
