import { constants } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunResult } from './types.js';
import { ARTIFACT_LIMITS, parseRunArtifact, validateArtifactWriteOptions } from './artifact-schema.js';
import type { WriteRunArtifactOptions } from './artifact-schema.js';
export { ARTIFACT_LIMITS, parseRunArtifact, validateJsonValue } from './artifact-schema.js';
export type { WriteRunArtifactOptions, JsonValueValidationOptions } from './artifact-schema.js';
const MAX_ARTIFACT_BYTES = ARTIFACT_LIMITS.maxBytes;

export async function readRunArtifact(path: string): Promise<RunResult> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('Run artifact path must be a non-empty string');
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isErrorCode(error, 'ELOOP') || isErrorCode(error, 'EMULTIHOP')) {
      throw new Error(`Refusing to read symbolic link run artifact: ${path}`);
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Run artifact must be an ordinary file: ${path}`);
    }
    if (stats.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`Run artifact exceeds the 16 MiB size limit: ${path}`);
    }
    const bytes = await readBounded(handle, path, stats.size);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new TypeError(`Run artifact is not valid UTF-8: ${errorMessage(error)}`);
    }
    return parseRunArtifact(text);
  } finally {
    await handle.close();
  }
}

export async function writeRunArtifact(
  path: string,
  run: RunResult,
  options: WriteRunArtifactOptions = {},
): Promise<void> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('Run artifact path must be a non-empty string');
  }
  const validatedOptions = validateArtifactWriteOptions(options);

  const validated = parseRunArtifact(run);
  const serialized = JSON.stringify(validated);

  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (validatedOptions.overwrite === true) {
      await rename(temporary, path);
      temporaryExists = false;
    } else {
      try {
        await link(temporary, path);
      } catch (error) {
        if (isErrorCode(error, 'EEXIST')) {
          throw new Error(`Run artifact already exists; pass { overwrite: true } to replace it: ${path}`);
        }
        throw error;
      }
      await unlink(temporary);
      temporaryExists = false;
    }

    await syncDirectory(directory);
  } finally {
    if (temporaryExists) {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  initialSize: number,
): Promise<Buffer> {
  const maximumReadBytes = MAX_ARTIFACT_BYTES + 1;
  let bytes = Buffer.allocUnsafe(Math.min(maximumReadBytes, Math.max(4096, initialSize + 1)));
  let total = 0;
  while (true) {
    if (total === bytes.length) {
      if (bytes.length === maximumReadBytes) break;
      const larger = Buffer.allocUnsafe(Math.min(maximumReadBytes, bytes.length * 2));
      bytes.copy(larger, 0, 0, total);
      bytes = larger;
    }
    const read = await handle.read(bytes, total, bytes.length - total, null);
    if (read.bytesRead === 0) break;
    total += read.bytesRead;
  }
  if (total > MAX_ARTIFACT_BYTES) {
    throw new Error(`Run artifact exceeds the 16 MiB size limit: ${path}`);
  }
  return bytes.subarray(0, total);
}
