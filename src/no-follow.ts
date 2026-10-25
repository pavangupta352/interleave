import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

/**
 * Open a file for reading without following a symbolic link at its final path
 * component. POSIX does this atomically with O_NOFOLLOW. Windows has no such flag,
 * so the path is checked first and the opened file must be the file that was checked.
 */
export async function openNoFollow(path: string): Promise<FileHandle> {
  if (constants.O_NOFOLLOW !== undefined) return open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const loop = (reason: string) => Object.assign(new Error(`ELOOP: ${reason}, open '${path}'`), { code: 'ELOOP' });
  const checked = await lstat(path);
  if (checked.isSymbolicLink()) throw loop('symbolic link');
  const handle = await open(path, constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    if (opened.dev !== checked.dev || opened.ino !== checked.ino) throw loop('path changed while opening');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
