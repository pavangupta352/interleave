import type { MetadataCompletion, ReadyCompletion, TransactionStatus } from '../types.js';
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
  constructor(error?: { code: string; message: string }) { this.error = error; }
  accept(frame: Buffer): ReadyCompletion | undefined {
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

/** Completes on the terminal statement metadata, never on Flush or ParameterDescription. */
export class MetadataSummary {
  private state: 'parse' | 'parameters' | 'columns' | 'done' = 'parse';
  private parameterCount = 0;
  accept(frame: Buffer): MetadataCompletion | undefined {
    const type = String.fromCharCode(frame[0]!);
    if (this.state === 'done') throw new Error('Unexpected response after metadata completion');
    if (['N', 'S', 'A'].includes(type)) return undefined;
    if (type === 'E') { this.state = 'done'; return { kind: 'metadata', result: 'error', error: backendError(frame) }; }
    if (this.state === 'parse' && type === '1' && frame.length === 5) { this.state = 'parameters'; return undefined; }
    if (this.state === 'parameters' && type === 't' && frame.length >= 7) {
      this.parameterCount = frame.readUInt16BE(5);
      if (frame.length !== 7 + 4 * this.parameterCount) throw new Error('Malformed parameter metadata');
      this.state = 'columns'; return undefined;
    }
    if (this.state === 'columns' && (type === 'T' || type === 'n')) {
      let columns = 0;
      if (type === 'n') { if (frame.length !== 5) throw new Error('Malformed NoData metadata'); }
      else {
        if (frame.length < 7) throw new Error('Malformed row metadata');
        columns = frame.readUInt16BE(5); let offset = 7;
        for (let index = 0; index < columns; index++) {
          const end = frame.indexOf(0, offset);
          if (end < 0 || end + 19 > frame.length) throw new Error('Malformed row metadata');
          offset = end + 1;
          if (frame.readUInt16BE(offset + 16) !== 0) throw new Error('Unexpected statement metadata format');
          offset += 18;
        }
        if (offset !== frame.length) throw new Error('Malformed row metadata trailing fields');
      }
      this.state = 'done';
      return { kind: 'metadata', result: 'described', parameterCount: this.parameterCount, columnCount: columns, resultShape: type === 'T' ? 'rows' : 'no-data' };
    }
    throw new Error('Unsupported profile: unexpected backend metadata response');
  }
}
