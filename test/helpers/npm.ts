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

/**
 * The one package that `npm pack --json` reports. npm 11 and earlier print an array of
 * packed packages; npm 12 prints an object keyed by package name.
 */
export function packedPackage(json: string): { name: string; version: string; filename: string; integrity: string; files: Array<{ path: string }> } {
  const records = Object.values(JSON.parse(json) as object);
  if (records.length !== 1) throw new Error(`npm pack reported ${records.length} packages`);
  return records[0];
}
