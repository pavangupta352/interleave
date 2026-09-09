import { createHash } from 'node:crypto';
import type { ProtocolKind } from '../types.js';
import { DEFAULT_BUFFER_LIMIT, positiveLimit, type FrameLimits } from './framing.js';
export interface FrontendUnit {
  protocol: ProtocolKind;
  sql: string;
  fingerprint: string;
  bytes: Buffer;
  reconciliation: { operations: BackendOperation[]; index: number; failed: boolean };
}
type BackendOperation =
  | { type: 'P'; name: string; statement: Statement }
  | { type: 'B'; name: string; portal: Portal }
  | { type: 'C'; name: string; target: 'S' | 'P' }
  | { type: 'D' | 'E' };
interface Statement { sql: string; identity: string }
interface Portal { statement: Statement; identity: string }
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
class Reader {
  offset = 5;
  constructor(readonly bytes: Buffer) {}
  take(size: number): Buffer {
    if (!Number.isSafeInteger(size) || size < 0 || this.offset + size > this.bytes.length) throw new Error('Malformed frontend protocol fields');
    const result = this.bytes.subarray(this.offset, this.offset + size); this.offset += size; return result;
  }
  cstring(): Buffer {
    const end = this.bytes.indexOf(0, this.offset);
    if (end < 0) throw new Error('Malformed frontend protocol string');
    const value = this.take(end - this.offset); this.take(1); return value;
  }
  u16(): number { return this.take(2).readUInt16BE(); }
  i32(): number { return this.take(4).readInt32BE(); }
  done(): void { if (this.offset !== this.bytes.length) throw new Error('Malformed frontend protocol trailing bytes'); }
}
/** Buffers before Parse: parsing/planning can already acquire PostgreSQL locks. */
export class FrontendAssembler {
  private readonly statements = new Map<string, Statement>();
  private readonly portals = new Map<string, Portal>();
  private frames: Buffer[] = [];
  private backendOperations: BackendOperation[] = [];
  private executions: { sql: string; identity: string }[] = [];
  private executionDependencies = new Set<string>();
  private operations: { sql: string; identity: string }[] = [];
  private bytes = 0;
  private metadataBytes = 0;
  private readonly maxBuffered: number;
  constructor(limits: FrameLimits = {}) { this.maxBuffered = positiveLimit(limits.maxBufferedBytes, DEFAULT_BUFFER_LIMIT); }
  get bufferedBytes(): number { return this.bytes; }
  /** Build a proposed head cycle without changing the acknowledged session state. */
  fork(): FrontendAssembler {
    const copy = new FrontendAssembler({ maxBufferedBytes: this.maxBuffered });
    for (const [name, statement] of this.statements) copy.statements.set(name, statement);
    for (const [name, portal] of this.portals) copy.portals.set(name, portal);
    copy.metadataBytes = this.metadataBytes;
    return copy;
  }
  private forget(target: 'S' | 'P', name: string): void {
    const map = target === 'S' ? this.statements : this.portals;
    const previous = map.get(name);
    if (previous) this.metadataBytes -= Buffer.byteLength(JSON.stringify(previous)) + Buffer.byteLength(name);
    map.delete(name);
  }
  /** Only successful backend acknowledgements install frontend metadata. */
  reconcile(unit: FrontendUnit, frame: Buffer): void {
    const type = String.fromCharCode(frame[0]!);
    const journal = unit.reconciliation;
    const operation = journal.operations[journal.index];
    if (type === 'E') {
      // PostgreSQL destroys an old unnamed object before attempting its replacement.
      // Named duplicates leave the previous object installed. Later operations are skipped.
      if (operation?.type === 'P' && operation.name === '') this.forget('S', '');
      if (operation?.type === 'B' && operation.name === '') this.forget('P', '');
      journal.failed = true;
    } else if (type === 'Z') {
      if (!journal.failed && journal.index !== journal.operations.length) throw new Error('Unsupported profile: incomplete backend metadata acknowledgements');
      if (unit.protocol === 'simple') this.forget('S', '');
      if (frame[5] === 73) for (const name of this.portals.keys()) this.forget('P', name);
    } else if (!journal.failed && operation) {
      const terminal = operation.type === 'P' ? type === '1'
        : operation.type === 'B' ? type === '2'
          : operation.type === 'C' ? type === '3'
            : operation.type === 'D' ? type === 'T' || type === 'n'
              : type === 'C' || type === 'I' || type === 's';
      if (terminal) {
        if (operation.type === 'P') this.remember(this.statements, operation.name, operation.statement);
        else if (operation.type === 'B') this.remember(this.portals, operation.name, operation.portal);
        else if (operation.type === 'C') this.forget(operation.target, operation.name);
        journal.index++;
      } else if ('123'.includes(type)) throw new Error('Unsupported profile: inconsistent backend metadata acknowledgement');
    } else if ('123'.includes(type)) throw new Error('Unsupported profile: unexpected backend metadata acknowledgement');
  }

  private statement(name: string): Statement {
    const found = this.statements.get(name); if (!found) throw new Error('Unsupported profile: unknown prepared statement identity'); return found;
  }
  private portal(name: string): Portal {
    const found = this.portals.get(name); if (!found) throw new Error('Unsupported profile: unknown portal identity'); return found;
  }
  private remember<T extends Statement | Portal>(map: Map<string, T>, name: string, value: T): void {
    // Bound session metadata as well as packets; do not retain parameter values.
    const size = (v: T) => Buffer.byteLength(JSON.stringify(v)) + Buffer.byteLength(name);
    const previous = map.get(name);
    this.metadataBytes += size(value) - (previous ? size(previous) : 0);
    if (this.metadataBytes > this.maxBuffered) throw new Error('Protocol prepared metadata-byte limit exceeded');
    map.set(name, value);
  }
  accept(frame: Buffer): FrontendUnit | undefined {
    const type = String.fromCharCode(frame[0]!); const reader = new Reader(frame);
    if (type === 'H') throw new Error('Unsupported profile: early Flush-dependent extended query; use complete cycles ending in Sync');
    if ('dcf'.includes(type)) throw new Error('Unsupported profile: streaming COPY');
    if (type === 'Q') {
      if (this.bytes) throw new Error('Unsupported profile: Simple Query inside an unfinished extended cycle');
      const sql = reader.cstring(); reader.done();
      return { protocol: 'simple', sql: sql.toString('utf8'), fingerprint: hash(Buffer.concat([Buffer.from('simple\0'), sql])), bytes: frame, reconciliation: { operations: [], index: 0, failed: false } };
    }
    if (!'PBDECS'.includes(type)) throw new Error('Unsupported profile: frontend protocol message');
    this.bytes += frame.length;
    if (this.bytes > this.maxBuffered) throw new Error('Protocol cycle buffered-byte limit exceeded');
    this.frames.push(frame);
    if (type === 'P') {
      const name = reader.cstring().toString('hex'); const sql = reader.cstring();
      const types = reader.take(reader.u16() * 4); reader.done();
      const statement = { sql: sql.toString('utf8'), identity: hash(Buffer.concat([sql, Buffer.from([0]), types])) };
      this.remember(this.statements, name, statement);
      this.backendOperations.push({ type: 'P', name, statement });
      this.operations.push({ sql: statement.sql, identity: 'parse:' + statement.identity });
    } else if (type === 'B') {
      const name = reader.cstring().toString('hex'); const statement = this.statement(reader.cstring().toString('hex'));
      const start = reader.offset;
      const formats = reader.u16(); for (let i = 0; i < formats; i++) if (reader.u16() > 1) throw new Error('Malformed Bind format');
      const params = reader.u16();
      if (formats !== 0 && formats !== 1 && formats !== params) throw new Error('Malformed Bind parameter format count');
      for (let i = 0; i < params; i++) { const size = reader.i32(); if (size !== -1) reader.take(size); }
      const results = reader.u16(); for (let i = 0; i < results; i++) if (reader.u16() > 1) throw new Error('Malformed Bind result format');
      reader.done();
      const portal = { statement, identity: hash(statement.identity + ':' + hash(frame.subarray(start))) };
      this.remember(this.portals, name, portal);
      this.backendOperations.push({ type: 'B', name, portal });
      this.operations.push({ sql: statement.sql, identity: 'bind:' + portal.identity });
    } else if (type === 'E') {
      const portal = this.portal(reader.cstring().toString('hex')); const count = reader.i32(); reader.done();
      if (count < 0) throw new Error('Malformed Execute row limit');
      this.backendOperations.push({ type: 'E' });
      this.executions.push({ sql: portal.statement.sql, identity: portal.identity + ':' + count });
      this.executionDependencies.add('parse:' + portal.statement.identity);
      this.executionDependencies.add('bind:' + portal.identity);
      this.executionDependencies.add('D:S:' + portal.statement.identity);
      this.executionDependencies.add('D:P:' + portal.identity);
    } else if (type === 'D' || type === 'C') {
      const target = reader.take(1).toString(); const name = reader.cstring().toString('hex'); reader.done();
      if (target !== 'S' && target !== 'P') throw new Error('Malformed Describe/Close target');
      const item = target === 'S' ? this.statement(name) : this.portal(name);
      const sql = 'sql' in item ? item.sql : item.statement.sql;
      this.operations.push({ sql, identity: type + ':' + target + ':' + item.identity });
      if (type === 'C') {
        this.backendOperations.push({ type: 'C', name, target });
        this.forget(target, name);
      } else this.backendOperations.push({ type: 'D' });
    } else {
      reader.done();
      const identity = this.executions.length ? [...this.executions, ...this.operations.filter(op => !this.executionDependencies.has(op.identity))] : this.operations;
      const unit: FrontendUnit = { protocol: 'extended', sql: identity.map(x => x.sql).join('; '), fingerprint: hash(JSON.stringify(['extended', identity.map(x => x.identity)])), bytes: Buffer.concat(this.frames, this.bytes), reconciliation: { operations: this.backendOperations, index: 0, failed: false } };
      this.frames = []; this.backendOperations = []; this.bytes = 0; this.executions = []; this.operations = []; this.executionDependencies.clear();
      return unit;
    }
    return undefined;
  }
}


/** Groups original bytes without interpreting future cycles against speculative metadata. */
export class FrontendCycleBuffer {
  private frames: Buffer[] = [];
  private bytes = 0;
  private readonly maxBuffered: number;
  constructor(limits: FrameLimits = {}) { this.maxBuffered = positiveLimit(limits.maxBufferedBytes, DEFAULT_BUFFER_LIMIT); }
  get bufferedBytes(): number { return this.bytes; }
  accept(frame: Buffer): Buffer[] | undefined {
    const type = String.fromCharCode(frame[0]!);
    if (type === 'H') throw new Error('Unsupported profile: early Flush-dependent extended query; use complete cycles ending in Sync');
    if ('dcf'.includes(type)) throw new Error('Unsupported profile: streaming COPY');
    if (type === 'Q') {
      if (this.bytes) throw new Error('Unsupported profile: Simple Query inside an unfinished extended cycle');
      return [frame];
    }
    if (!'PBDECS'.includes(type)) throw new Error('Unsupported profile: frontend protocol message');
    this.bytes += frame.length;
    if (this.bytes > this.maxBuffered) throw new Error('Protocol cycle buffered-byte limit exceeded');
    this.frames.push(frame);
    if (type !== 'S') return undefined;
    const cycle = this.frames; this.frames = []; this.bytes = 0;
    return cycle;
  }
}
