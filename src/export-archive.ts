import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 10_000;

export function readRuntimeArchive(compressed: Buffer): Map<string, Buffer> {
  let archive: Buffer;
  try { archive = gunzipSync(compressed, { maxOutputLength: MAX_TOTAL_BYTES }); }
  catch { throw new Error('Packed runtime archive is invalid or exceeds the 128 MiB expanded limit'); }
  const files = new Map<string, Buffer>();
  const paths = new Set<string>();
  const directories = new Set<string>();
  let offset = 0, entries = 0;
  let extended: Record<string, string> | undefined;
  const field = (block: Buffer, start: number, length: number) => decodeUtf8(block.subarray(start, start + length), 'Archive header').split('\0')[0]!;
  const number = (text: string) => {
    const value = text.trim();
    if (!/^[0-7]*$/.test(value)) throw new Error('Unsupported runtime archive numeric header');
    const result = value ? Number.parseInt(value, 8) : 0;
    if (!Number.isSafeInteger(result) || result < 0) throw new Error('Runtime archive numeric limit exceeded');
    return result;
  };
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512); offset += 512;
    if (block.every(byte => byte === 0)) {
      if (extended || offset + 512 > archive.length || !archive.subarray(offset).every(byte => byte === 0)) throw new Error('Invalid runtime archive terminator');
      return files;
    }
    if (++entries > MAX_FILES * 2) throw new Error('Runtime archive exceeds its entry limit');
    if (field(block, 257, 6) !== 'ustar' || field(block, 263, 2) !== '00') throw new Error('Unsupported runtime archive format');
    const checksum = [...block].reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (number(field(block, 148, 8)) !== checksum) throw new Error('Runtime archive header checksum mismatch');
    const type = field(block, 156, 1);
    let size = number(field(block, 124, 12));
    if (extended?.size !== undefined) {
      if (!/^\d+$/.test(extended.size)) throw new Error('Invalid runtime archive extended size');
      size = Number(extended.size);
    }
    if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES || offset + Math.ceil(size / 512) * 512 > archive.length) throw new Error('Runtime archive file exceeds its bounded payload');
    const payload = archive.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    if (type === 'x') {
      if (extended || size > 64 * 1024) throw new Error('Unsupported runtime archive extended headers');
      extended = {};
      let start = 0;
      while (start < payload.length) {
        const space = payload.indexOf(32, start);
        if (space < 0) throw new Error('Invalid runtime archive extended header');
        const lengthText = payload.subarray(start, space).toString('ascii');
        const length = Number(lengthText);
        if (!/^\d+$/.test(lengthText) || !Number.isSafeInteger(length) || length <= space - start + 1 || start + length > payload.length || payload[start + length - 1] !== 10) throw new Error('Invalid runtime archive extended header length');
        const text = decodeUtf8(payload.subarray(space + 1, start + length - 1), 'Archive extended header');
        const equals = text.indexOf('='); const key = text.slice(0, equals);
        if (equals < 1 || !['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'SCHILY.dev', 'SCHILY.ino', 'SCHILY.nlink'].includes(key) || Object.hasOwn(extended, key)) throw new Error('Unsupported runtime archive extended field');
        extended[key] = text.slice(equals + 1); start += length;
      }
      continue;
    }
    if (type !== '' && type !== '0' && type !== '5') throw new Error('Runtime archive contains unsupported links or special entries');
    const prefix = field(block, 345, 155);
    const raw = extended?.path ?? `${prefix ? `${prefix}/` : ''}${field(block, 0, 100)}`;
    extended = undefined;
    const path = safeBundlePath(type === '5' ? raw.replace(/\/$/, '') : raw, 'Archive path');
    if (!path.startsWith('package/') || paths.has(path)) throw new Error('Runtime archive contains an unsafe or duplicate package path');
    paths.add(path);
    const parts = path.split('/');
    if (parts.includes('node_modules')) throw new Error('Runtime archive node_modules entries are unsupported bundled dependencies');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (files.has(parent.slice(8))) throw new Error('Runtime archive file conflicts with a parent directory');
      directories.add(parent);
    }
    if (type === '5') { if (size !== 0) throw new Error('Runtime archive directory contains payload'); continue; }
    if (directories.has(path)) throw new Error('Runtime archive file conflicts with a directory');
    if (files.size >= MAX_FILES) throw new Error('Runtime archive exceeds its file limit');
    files.set(path.slice(8), payload);
  }
  throw new Error('Runtime archive is truncated or missing its terminator');
}

export async function readOrdinaryFile(path: string, maximum = MAX_FILE_BYTES, root?: string): Promise<Buffer> {
  if (root) {
    assertInside(root, path, 'file');
    await assertNoSymlinkComponents(root, path);
  }
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (hasCode(error, 'ELOOP') || hasCode(error, 'EMULTIHOP')) throw new Error(`Refusing symbolic link file: ${path}`);
    if (hasCode(error, 'ENOENT')) throw new Error(`Required file does not exist: ${path}`);
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`Expected an ordinary file: ${path}`);
    if (stats.size > maximum) throw new Error(`File exceeds the ${maximum} byte limit: ${path}`);
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await handle.stat();
    if (offset !== stats.size || extra.bytesRead !== 0 || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) {
      throw new Error(`File changed while it was being read: ${path}`);
    }
    return bytes;
  } finally { await handle.close(); }
}

export async function assertNoSymlinkComponents(root: string, path: string): Promise<void> {
  assertInside(root, path, 'path');
  let current = root;
  const remainder = relative(root, path);
  if (!remainder) return;
  for (const component of remainder.split(sep)) {
    current = join(current, component);
    const stats = await lstat(current).catch((error: unknown) => {
      if (hasCode(error, 'ENOENT')) throw new Error(`Required path does not exist: ${current}`);
      throw error;
    });
    if (stats.isSymbolicLink()) throw new Error(`Refusing symbolic link path: ${relative(root, current)}`);
  }
}

export function assertInside(root: string, path: string, label: string): void {
  const remainder = relative(root, path);
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`${label} escapes project root`);
  }
}

export function safeBundlePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (isAbsolute(path) || path.includes('\\') || path.includes(':') || /[\u0000-\u001f\u007f]/.test(path) || path.startsWith('/') || path.endsWith('/')
      || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError(`${label} must be a safe relative path`);
  }
  return path;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new TypeError(`${label} must be a non-empty bounded string`);
  return value;
}

export function decodeUtf8(bytes: Buffer, label: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new TypeError(`${label} is not valid UTF-8`); }
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
