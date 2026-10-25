import { createHash } from 'node:crypto';
import type { ProtocolKind, ProtocolProfile, StepStage } from '../types.js';
import { DEFAULT_BUFFER_LIMIT, positiveLimit, type FrameLimits } from './framing.js';
export interface FrontendUnit {
  protocol: ProtocolKind;
  sql: string;
  fingerprint: string;
  bytes: Buffer;
  stage?: StepStage;
  /** Only a describe prefix carries its real protocol statement name. */
  statementName?: string;
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
  private executions: { sql: string; identity: string; statement: string }[] = [];
  private executionDependencies = new Set<string>();
  private operations: { sql: string; identity: string; statement: string }[] = [];
  private bytes = 0;
  private metadataBytes = 0;
  private readonly maxBuffered: number;
  /** flush-stages-v1: Flush ends a release as Sync does, and the cycle stays open. */
  private readonly flushStages: boolean;
  constructor(limits: FrameLimits & { protocolProfile?: ProtocolProfile } = {}) {
    this.maxBuffered = positiveLimit(limits.maxBufferedBytes, DEFAULT_BUFFER_LIMIT);
    this.flushStages = limits.protocolProfile === 'flush-stages-v1';
  }
  get bufferedBytes(): number { return this.bytes; }
  /** Build a proposed head cycle without changing the acknowledged session state. */
  fork(): FrontendAssembler {
    const copy = new FrontendAssembler({ maxBufferedBytes: this.maxBuffered, ...(this.flushStages ? { protocolProfile: 'flush-stages-v1' as const } : {}) });
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
  /** Interpret only the qualified metadata prefix, on a fork of acknowledged state. */
  describe(frames: Buffer[]): FrontendUnit {
    if (this.bytes || frames.length !== 3 || frames.map(frame => String.fromCharCode(frame[0]!)).join('') !== 'PDH' || frames[2]!.length !== 5) {
      throw new Error('Unsupported profile: expected Parse/statement Describe/Flush prefix');
    }
    if (frames.reduce((sum, frame) => sum + frame.length, 0) > this.maxBuffered) throw new Error('Protocol cycle buffered-byte limit exceeded');
    this.accept(frames[0]!);
    const parsed = this.backendOperations[0];
    if (parsed?.type !== 'P') throw new Error('Malformed metadata prefix');
    const reader = new Reader(frames[1]!);
    if (reader.take(1).toString() !== 'S' || reader.cstring().toString('hex') !== parsed.name) throw new Error('Unsupported profile: metadata Describe must reference the prefix statement');
    reader.done(); this.accept(frames[1]!);
    const unit: FrontendUnit = { protocol: 'extended', stage: 'describe', statementName: parsed.name,
      sql: parsed.statement.sql, fingerprint: hash(JSON.stringify(['describe-flush-v1', 'describe', parsed.statement.identity])),
      bytes: Buffer.concat(frames), reconciliation: { operations: this.backendOperations, index: 0, failed: false } };
    this.reset(); return unit;
  }
  /** Bind identity is available only after the real server acknowledges the prefix. */
  continuation(frames: Buffer[], prefix: FrontendUnit, error?: { code: string; message: string }): FrontendUnit {
    if (this.bytes || prefix.stage !== 'describe' || prefix.statementName === undefined) throw new Error('Invalid metadata continuation state');
    if (error) {
      if (frames.length !== 1 || frames[0]![0] !== 83 || frames[0]!.length !== 5) throw new Error('Unsupported profile: metadata error recovery requires Sync only');
      return { protocol: 'extended', stage: 'recover', sql: prefix.sql,
        fingerprint: hash(JSON.stringify(['describe-flush-v1', 'recover', prefix.fingerprint])), bytes: frames[0]!,
        reconciliation: { operations: [], index: 0, failed: false } };
    }
    if (frames.length !== 3 || frames.map(frame => String.fromCharCode(frame[0]!)).join('') !== 'BES') throw new Error('Unsupported profile: metadata continuation requires Bind/Execute/Sync');
    const bind = new Reader(frames[0]!); const portal = bind.cstring().toString('hex');
    if (bind.cstring().toString('hex') !== prefix.statementName) throw new Error('Unsupported profile: continuation Bind must reference the prefix statement');
    const execute = new Reader(frames[1]!);
    if (execute.cstring().toString('hex') !== portal) throw new Error('Unsupported profile: continuation Execute must reference the bound portal');
    if (execute.i32() !== 0) throw new Error('Unsupported profile: describe-flush-v1 requires an unlimited row count on the staged Execute; select protocol profile flush-stages-v1 (protocolProfile, or --protocol-profile on the CLI) for limited Executes');
    execute.done();
    let unit: FrontendUnit | undefined;
    for (const frame of frames) unit = this.accept(frame);
    if (!unit) throw new Error('Incomplete metadata continuation');
    unit.stage = 'execute';
    unit.fingerprint = hash(JSON.stringify(['describe-flush-v1', 'execute', prefix.fingerprint, unit.fingerprint]));
    return unit;
  }
  /** Exactly Parse/statement Describe/Flush of one statement: the describe-flush-v1 prefix. */
  static isDescribePrefix(frames: Buffer[]): boolean {
    if (frames.length !== 3 || frames.map(frame => String.fromCharCode(frame[0]!)).join('') !== 'PDH' || frames[2]!.length !== 5) return false;
    try {
      const name = new Reader(frames[0]!).cstring(); const describe = new Reader(frames[1]!);
      return describe.take(1).toString() === 'S' && describe.cstring().equals(name);
    } catch { return false; }
  }
  /** flush-stages-v1: the first release of a cycle that ends in Flush. */
  flushStage(frames: Buffer[]): FrontendUnit {
    if (this.bytes || frames.at(-1)?.[0] !== 72) throw new Error('Invalid Flush stage state');
    let unit: FrontendUnit | undefined;
    for (const frame of frames) unit = this.accept(frame);
    if (!unit) throw new Error('Incomplete Flush stage');
    unit.stage = 'flush';
    unit.fingerprint = hash(JSON.stringify(['flush-stages-v1', 'flush', unit.fingerprint]));
    return unit;
  }
  /**
   * flush-stages-v1: a later release of an open cycle, chained to the stage before
   * it. After an error PostgreSQL discards everything until Sync, so only Sync may follow.
   */
  flushContinuation(frames: Buffer[], previous: FrontendUnit, error?: { code: string; message: string }): FrontendUnit {
    if (this.bytes || (previous.stage !== 'flush' && previous.stage !== 'describe')) throw new Error('Invalid Flush continuation state');
    if (error) {
      if (frames.length !== 1 || frames[0]![0] !== 83 || frames[0]!.length !== 5) throw new Error('Unsupported profile: after an error in an open cycle only Sync may follow');
      return { protocol: 'extended', stage: 'recover', sql: previous.sql,
        fingerprint: hash(JSON.stringify(['flush-stages-v1', 'recover', previous.fingerprint])), bytes: frames[0]!,
        reconciliation: { operations: [], index: 0, failed: false } };
    }
    let unit: FrontendUnit | undefined;
    for (const frame of frames) unit = this.accept(frame);
    if (!unit) throw new Error('Incomplete Flush continuation');
    unit.stage = frames.at(-1)![0] === 72 ? 'flush' : 'sync';
    // A bare Sync or Close names the statement of the stage it ends.
    if (!unit.sql) unit.sql = previous.sql;
    unit.fingerprint = hash(JSON.stringify(['flush-stages-v1', unit.stage, previous.fingerprint, unit.fingerprint]));
    return unit;
  }
  private reset(): void {
    this.frames = []; this.backendOperations = []; this.bytes = 0; this.executions = []; this.operations = []; this.executionDependencies.clear();
  }
  accept(frame: Buffer): FrontendUnit | undefined {
    const type = String.fromCharCode(frame[0]!); const reader = new Reader(frame);
    if (type === 'H' && !this.flushStages) throw new Error('Unsupported profile: early Flush-dependent extended query; use complete cycles ending in Sync, or select protocol profile flush-stages-v1 (protocolProfile, or --protocol-profile on the CLI)');
    if ('dcf'.includes(type)) throw new Error('Unsupported profile: COPY data outside COPY FROM STDIN');
    if (type === 'Q') {
      if (this.bytes) throw new Error('Unsupported profile: Simple Query inside an unfinished extended cycle');
      const sql = reader.cstring(); reader.done();
      return { protocol: 'simple', sql: sql.toString('utf8'), fingerprint: hash(Buffer.concat([Buffer.from('simple\0'), sql])), bytes: frame, reconciliation: { operations: [], index: 0, failed: false } };
    }
    if (!'PBDECSH'.includes(type)) throw new Error('Unsupported profile: frontend protocol message');
    if (type === 'H' && !this.frames.length) throw new Error('Unsupported profile: Flush without pending extended messages');
    this.bytes += frame.length;
    if (this.bytes > this.maxBuffered) throw new Error('Protocol cycle buffered-byte limit exceeded');
    this.frames.push(frame);
    if (type === 'P') {
      const name = reader.cstring().toString('hex'); const sql = reader.cstring();
      const types = reader.take(reader.u16() * 4); reader.done();
      const statement = { sql: sql.toString('utf8'), identity: hash(Buffer.concat([sql, Buffer.from([0]), types])) };
      this.remember(this.statements, name, statement);
      this.backendOperations.push({ type: 'P', name, statement });
      this.operations.push({ sql: statement.sql, identity: 'parse:' + statement.identity, statement: statement.identity });
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
      this.operations.push({ sql: statement.sql, identity: 'bind:' + portal.identity, statement: statement.identity });
    } else if (type === 'E') {
      const portal = this.portal(reader.cstring().toString('hex')); const count = reader.i32(); reader.done();
      if (count < 0) throw new Error('Malformed Execute row limit');
      this.backendOperations.push({ type: 'E' });
      this.executions.push({ sql: portal.statement.sql, identity: portal.identity + ':' + count, statement: portal.statement.identity });
      this.executionDependencies.add('parse:' + portal.statement.identity);
      this.executionDependencies.add('bind:' + portal.identity);
      this.executionDependencies.add('D:S:' + portal.statement.identity);
      this.executionDependencies.add('D:P:' + portal.identity);
    } else if (type === 'D' || type === 'C') {
      const target = reader.take(1).toString(); const name = reader.cstring().toString('hex'); reader.done();
      if (target !== 'S' && target !== 'P') throw new Error('Malformed Describe/Close target');
      const item = target === 'S' ? this.statement(name) : this.portal(name);
      const statement = 'sql' in item ? item : item.statement;
      this.operations.push({ sql: statement.sql, identity: type + ':' + target + ':' + item.identity, statement: statement.identity });
      if (type === 'C') {
        this.backendOperations.push({ type: 'C', name, target });
        this.forget(target, name);
      } else this.backendOperations.push({ type: 'D' });
    } else {
      reader.done();
      const others = this.executions.length ? this.operations.filter(op => !this.executionDependencies.has(op.identity)) : this.operations;
      const identity = [...this.executions, ...others];
      // Every Execute names its statement. Other operations name each remaining statement
      // once: a Parse and Describe of one statement prepare one command, not two.
      const named = new Set(this.executions.map(execution => execution.statement));
      const additional = others.filter(op => { const first = !named.has(op.statement); named.add(op.statement); return first; });
      const text = [...this.executions, ...additional].map(x => x.sql).join('; ');
      const unit: FrontendUnit = { protocol: 'extended', sql: text, fingerprint: hash(JSON.stringify(['extended', identity.map(x => x.identity)])), bytes: Buffer.concat(this.frames, this.bytes), reconciliation: { operations: this.backendOperations, index: 0, failed: false } };
      this.reset();
      return unit;
    }
    return undefined;
  }
}


/** Groups original bytes without interpreting future cycles against speculative metadata. */
export class FrontendCycleBuffer {
  private frames: Buffer[] = [];
  private bytes = 0;
  private cycleBytes = 0;
  private hasPrefix = false;
  private readonly maxBuffered: number;
  private readonly staged: boolean;
  private readonly flushStages: boolean;
  constructor(limits: FrameLimits & { protocolProfile?: ProtocolProfile } = {}) {
    this.maxBuffered = positiveLimit(limits.maxBufferedBytes, DEFAULT_BUFFER_LIMIT);
    this.staged = limits.protocolProfile === 'describe-flush-v1';
    this.flushStages = limits.protocolProfile === 'flush-stages-v1';
  }
  get bufferedBytes(): number { return this.bytes; }
  accept(frame: Buffer): Buffer[] | undefined {
    const type = String.fromCharCode(frame[0]!);
    if (type === 'H' && this.flushStages) {
      if (!this.frames.length || frame.length !== 5) throw new Error('Unsupported profile: Flush without pending extended messages');
    } else if (type === 'H') {
      if (!this.staged) throw new Error('Unsupported profile: early Flush-dependent extended query; use complete cycles ending in Sync, or select protocol profile flush-stages-v1 (protocolProfile, or --protocol-profile on the CLI)');
      if (this.hasPrefix || this.frames.length !== 2 || this.frames[0]![0] !== 80 || this.frames[1]![0] !== 68 || frame.length !== 5) throw new Error('Unsupported profile: describe-flush-v1 accepts only one Parse/Describe prefix before Flush; select protocol profile flush-stages-v1 (protocolProfile, or --protocol-profile on the CLI) for other Flush stages');
    }
    if ('dcf'.includes(type)) throw new Error('Unsupported profile: COPY data outside COPY FROM STDIN');
    if (type === 'Q') {
      if (this.bytes || this.hasPrefix) throw new Error('Unsupported profile: Simple Query inside an unfinished extended cycle');
      return [frame];
    }
    if (!'PBDECSH'.includes(type)) throw new Error('Unsupported profile: frontend protocol message');
    this.bytes += frame.length;
    this.cycleBytes += frame.length;
    if (this.cycleBytes > this.maxBuffered) throw new Error('Protocol cycle buffered-byte limit exceeded');
    this.frames.push(frame);
    if (type !== 'S' && type !== 'H') return undefined;
    const cycle = this.frames; this.frames = []; this.bytes = 0;
    if (type === 'H') { this.hasPrefix = true; if (this.flushStages) this.cycleBytes = 0; }
    else { this.cycleBytes = 0; this.hasPrefix = false; }
    return cycle;
  }
}
