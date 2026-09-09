import type { TransactionStatus, UnitCompletion } from '../types.js';
export function backendError(frame: Buffer): { code: string; message: string } {
  let offset = 5; let code = ''; let message = '';
  while (offset < frame.length && frame[offset] !== 0) {
    const field = String.fromCharCode(frame[offset++]!); const end = frame.indexOf(0, offset);
    if (end < 0) throw new Error('Malformed backend ErrorResponse');
    if (field === 'C') code = frame.toString('utf8', offset, end);
    if (field === 'M') message = frame.toString('utf8', offset, end);
    offset = end + 1;
  }
  if (!/^[0-9A-Z]{5}$/.test(code)) throw new Error('Malformed backend SQLSTATE');
  return { code, message };
}
export class BackendSummary {
  private readonly tags: string[] = [];
  private rows = 0;
  private error: { code: string; message: string } | undefined;
  accept(frame: Buffer): UnitCompletion | undefined {
    const type = String.fromCharCode(frame[0]!);
    if (type === 'C') {
      if (frame.at(-1) !== 0) throw new Error('Malformed backend command tag');
      const tag = frame.toString('utf8', 5, -1 + frame.length); this.tags.push(tag);
      const match = /^(?:SELECT|INSERT \d+|UPDATE|DELETE|MOVE|FETCH|COPY|MERGE) (\d+)$/.exec(tag);
      if (match) this.rows += Number(match[1]);
    } else if (type === 'E') this.error = backendError(frame);
    else if (type === 'Z') {
      const status = frame.toString('ascii', 5);
      if (!['I', 'T', 'E'].includes(status)) throw new Error('Malformed ReadyForQuery status');
      return { transactionStatus: status as TransactionStatus, commandTags: [...this.tags], rowCount: this.rows, ...(this.error ? { error: this.error } : {}) };
    }
    return undefined;
  }
}
