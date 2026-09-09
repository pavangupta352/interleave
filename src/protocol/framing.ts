/** PostgreSQL length framing. Returned frames own their bytes and may be retained. */
export interface FrameLimits { maxMessageBytes?: number; maxBufferedBytes?: number }
export const DEFAULT_MESSAGE_LIMIT = 16 * 1024 * 1024;
export const DEFAULT_BUFFER_LIMIT = 32 * 1024 * 1024;
export function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 8 || limit > 1024 * 1024 * 1024) throw new Error('Protocol byte limit must be an integer between 8 and 1073741824');
  return limit;
}
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private size = 0;
  private readonly maxMessage: number;
  private readonly maxBuffered: number;
  constructor(private mode: 'startup' | 'typed', limits: FrameLimits = {}) {
    this.maxMessage = positiveLimit(limits.maxMessageBytes, DEFAULT_MESSAGE_LIMIT);
    this.maxBuffered = positiveLimit(limits.maxBufferedBytes, DEFAULT_BUFFER_LIMIT);
  }
  get bufferedBytes(): number { return this.size; }
  push(chunk: Buffer): Buffer[] {
    const needed = this.size + chunk.length;
    if (needed > this.maxBuffered) throw new Error('Protocol buffered-byte limit exceeded');
    if (needed > this.buffer.length) {
      const next = Buffer.allocUnsafe(Math.min(this.maxBuffered, Math.max(needed, this.buffer.length * 2, 1024)));
      this.buffer.copy(next, 0, 0, this.size); this.buffer = next;
    }
    chunk.copy(this.buffer, this.size); this.size = needed;
    const frames: Buffer[] = []; let offset = 0;
    while (this.size - offset >= (this.mode === 'startup' ? 4 : 5)) {
      const typed = this.mode === 'typed';
      const length = this.buffer.readUInt32BE(offset + (typed ? 1 : 0));
      if (length < (typed ? 4 : 8)) throw new Error('Malformed protocol message length');
      const total = length + (typed ? 1 : 0);
      if (total > this.maxMessage) throw new Error('Protocol message-byte limit exceeded');
      if (this.size - offset < total) break;
      const frame = Buffer.from(this.buffer.subarray(offset, offset + total));
      frames.push(frame); offset += total;
      if (!typed) {
        const code = frame.readUInt32BE(4);
        if (code !== 80877103 && code !== 80877104) this.mode = 'typed';
      }
    }
    if (offset) { this.buffer.copy(this.buffer, 0, offset, this.size); this.size -= offset; }
    return frames;
  }
}
