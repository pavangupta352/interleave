import { describe, expect, test } from 'vitest';
import { FrameDecoder } from '../src/protocol/framing.js';
import { FrontendAssembler } from '../src/protocol/frontend.js';
import { BackendSummary } from '../src/protocol/backend.js';

function packet(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5); header[0] = type.charCodeAt(0); header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}
function cstring(value: string) { return Buffer.from(value + '\0'); }
function parse(name: string, sql: string) { return packet('P', Buffer.concat([cstring(name), cstring(sql), Buffer.from([0, 0])])); }
function bind(portal: string, name: string, value: string) {
  const valueBytes = Buffer.from(value); const size = Buffer.alloc(4); size.writeInt32BE(valueBytes.length);
  return packet('B', Buffer.concat([cstring(portal), cstring(name), Buffer.from([0, 0, 0, 1]), size, valueBytes, Buffer.from([0, 0])]));
}
function execute(portal: string) { return packet('E', Buffer.concat([cstring(portal), Buffer.alloc(4)])); }
const sync = packet('S');
function assemble(frames: Buffer[]) {
  const assembler = new FrontendAssembler();
  return frames.flatMap(frame => { const result = assembler.accept(frame); return result ? [result] : []; });
}

describe('wire framing', () => {
  test('emits each complete original packet once across arbitrary fragmentation and coalescing', () => {
    const a = packet('Q', cstring('SELECT 1')); const b = packet('Q', cstring('SELECT 2'));
    const decoder = new FrameDecoder('typed'); const output: Buffer[] = [];
    for (const byte of Buffer.concat([a, b])) output.push(...decoder.push(Buffer.from([byte])));
    expect(output).toEqual([a, b]); expect(decoder.push(Buffer.alloc(0))).toEqual([]);
    expect(new FrameDecoder('typed').push(Buffer.concat([a, b]))).toEqual([a, b]);
  });
  test('bounds malformed lengths, messages and incomplete buffered bytes', () => {
    expect(() => new FrameDecoder('typed').push(Buffer.from([81, 0, 0, 0, 3]))).toThrow(/length/i);
    expect(() => new FrameDecoder('typed', { maxMessageBytes: 10 }).push(packet('Q', cstring('SELECT 1')))).toThrow(/limit/i);
    expect(() => new FrameDecoder('typed', { maxBufferedBytes: 8 }).push(Buffer.from([81, 0, 0, 0, 20, 1, 2, 3, 4]))).toThrow(/limit/i);
  });
  test('handles fragmented SSL request then startup coalesced with a typed query', () => {
    const ssl = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
    const startup = Buffer.from([0, 0, 0, 8, 0, 3, 0, 0]); const query = packet('Q', cstring('SELECT 1'));
    const decoder = new FrameDecoder('startup');
    expect(decoder.push(ssl.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([ssl.subarray(3), startup, query]))).toEqual([ssl, startup, query]);
  });
});

describe('frontend scheduling units', () => {
  test('holds entire extended cycle until Sync and preserves every original byte', () => {
    const frames = [parse('named', 'SELECT $1::text'), bind('p', 'named', 'hello'), packet('D', Buffer.concat([Buffer.from('P'), cstring('p')])), execute('p'), sync];
    const assembler = new FrontendAssembler();
    for (const frame of frames.slice(0, -1)) expect(assembler.accept(frame)).toBeUndefined();
    const unit = assembler.accept(sync)!;
    expect(unit.protocol).toBe('extended'); expect(unit.sql).toBe('SELECT $1::text');
    expect(unit.bytes).toEqual(Buffer.concat(frames));
  });
  test('simple query batches remain indivisible and SQL changes change identity', () => {
    const frames = [packet('Q', cstring('SELECT 1; SELECT 2')), packet('Q', cstring('SELECT 1; SELECT 3'))];
    const units = assemble(frames); expect(units).toHaveLength(2); expect(units[0]!.bytes).toEqual(frames[0]);
    expect(units[0]!.fingerprint).not.toBe(units[1]!.fingerprint);
  });
  test('prepared reuse has stable semantic fingerprints independent of statement and portal names', () => {
    const assembler = new FrontendAssembler();
    const first = [parse('a', 'SELECT $1::text'), bind('p', 'a', 'hello'), execute('p'), sync].map(f => assembler.accept(f)).at(-1)!;
    const second = [bind('q', 'a', 'hello'), execute('q'), sync].map(f => assembler.accept(f)).at(-1)!;
    const renamed = assemble([parse('b', 'SELECT $1::text'), bind('r', 'b', 'hello'), execute('r'), sync])[0]!;
    const changed = assemble([parse('b', 'SELECT $1::text'), bind('r', 'b', 'other'), execute('r'), sync])[0]!;
    expect(first.fingerprint).toBe(second.fingerprint); expect(first.fingerprint).toBe(renamed.fingerprint);
    expect(first.fingerprint).not.toBe(changed.fingerprint);
  });
  test('identity retains additional unexecuted Parse and Close operations in a cycle', () => {
    const base = [parse('a', 'SELECT $1::text'), bind('p', 'a', 'hello'), execute('p')];
    const ordinary = assemble([...base, sync])[0]!;
    const additional = assemble([...base, parse('extra', 'SELECT 999'), sync])[0]!;
    const closed = assemble([...base, packet('C', Buffer.concat([Buffer.from('S'), cstring('a')])), sync])[0]!;
    expect(additional.fingerprint).not.toBe(ordinary.fingerprint);
    expect(closed.fingerprint).not.toBe(ordinary.fingerprint);
  });
  test('rejects early Flush, COPY data, unknown statements, malformed fields, and bounded cycles', () => {
    expect(() => assemble([packet('H')])).toThrow(/unsupported.*Flush/i);
    expect(() => assemble([packet('d')])).toThrow(/unsupported.*COPY/i);
    expect(() => assemble([bind('', 'missing', 'x'), sync])).toThrow(/statement/i);
    expect(() => assemble([packet('P', Buffer.from('no terminator'))])).toThrow(/malformed/i);
    const assembler = new FrontendAssembler({ maxBufferedBytes: 16 });
    expect(() => assembler.accept(parse('a', 'SELECT $1::text'))).toThrow(/limit/i);
  });
});

describe('backend evidence', () => {
  test('collects genuine command tags, rows, SQLSTATE and transaction status without row values', () => {
    const summary = new BackendSummary();
    expect(summary.accept(packet('D', Buffer.from([0, 0])))).toBeUndefined();
    summary.accept(packet('C', cstring('SELECT 1')));
    summary.accept(packet('E', Buffer.concat([Buffer.from('S'), cstring('ERROR'), Buffer.from('C'), cstring('23505'), Buffer.from('M'), cstring('duplicate key'), Buffer.from([0])])));
    expect(summary.accept(packet('Z', Buffer.from('E')))).toEqual({ transactionStatus: 'E', commandTags: ['SELECT 1'], rowCount: 1, error: { code: '23505', message: 'duplicate key' } });
  });
});
