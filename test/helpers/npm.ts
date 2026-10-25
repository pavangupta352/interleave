import { basename, dirname, join } from 'node:path';

/**
 * The argument vector that runs npm. Windows ships npm as a .cmd script, which Node only
 * starts through a shell, so there the same npm runs as `node npm-cli.js`.
 */
export function npm(...args: string[]): string[] {
  if (process.platform !== 'win32') return ['npm', ...args];
  const running = process.env.npm_execpath;
  const cli = running && basename(running) === 'npm-cli.js' ? running : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return [process.execPath, cli, ...args];
}
