import { describe, expect, test } from 'vitest';
import { FrontendAssembler, FrontendCycleBuffer } from '../src/protocol/frontend.js';
import { MetadataSummary } from '../src/protocol/backend.js';
import { FrameDecoder } from '../src/protocol/framing.js';

function packet(type: string, payload = Buffer.alloc(0)) { const h = Buffer.alloc(5); h[0] = type.charCodeAt(0); h.writeUInt32BE(payload.length + 4, 1); return Buffer.concat([h, payload]); }
const str = (s: string) => Buffer.from(s + '\0');
const parse = (name: string, sql = 'SELECT $1::text') => packet('P', Buffer.concat([str(name), str(sql), Buffer.alloc(2)]));
const describeStatement = (name: string) => packet('D', Buffer.concat([Buffer.from('S'), str(name)]));
const prefix = (name = 'a') => [parse(name), describeStatement(name), packet('H')];
function continuation(name = 'a', value = 'hello') {
  const size = Buffer.alloc(4); size.writeInt32BE(Buffer.byteLength(value));
  return [packet('B', Buffer.concat([str(''), str(name), Buffer.from([0, 0, 0, 1]), size, Buffer.from(value), Buffer.alloc(2)])), packet('E', Buffer.alloc(5)), packet('S')];
}
const parameter = packet('t', Buffer.from([0, 1, 0, 0, 0, 25]));

describe('staged frontend identity and boundaries', () => {
  test('groups the original metadata prefix and continuation separately with a cumulative cycle bound', () => {
    const frames = [...prefix(), ...continuation()];
    const buffer = new FrontendCycleBuffer({ protocolProfile: 'describe-flush-v1' });
    expect(frames.flatMap(frame => { const unit = buffer.accept(frame); return unit ? [unit] : []; })).toEqual([frames.slice(0, 3), frames.slice(3)]);
    const bounded = new FrontendCycleBuffer({ protocolProfile: 'describe-flush-v1', maxBufferedBytes: Buffer.concat(frames).length - 1 });
    expect(() => frames.forEach(frame => bounded.accept(frame))).toThrow(/limit/i);
  });
  test('preserves staged boundaries and bytes across every transport split', () => {
    const expected = [prefix(), continuation()], bytes = Buffer.concat(expected.flat());
    for (let offset = 1; offset < bytes.length; offset++) {
      const decoder = new FrameDecoder('typed'), buffer = new FrontendCycleBuffer({ protocolProfile: 'describe-flush-v1' });
      const units = [bytes.subarray(0, offset), bytes.subarray(offset)].flatMap(chunk => decoder.push(chunk).flatMap(frame => {
        const unit = buffer.accept(frame); return unit ? [unit] : [];
      }));
      expect(units).toEqual(expected);
    }
  });
  test('binds actual continuation values after acknowledged metadata, independently of generated names', () => {
    function identity(name: string, value: string) {
      const acknowledged = new FrontendAssembler();
      const first = acknowledged.fork().describe(prefix(name));
      acknowledged.reconcile(first, packet('1')); acknowledged.reconcile(first, parameter); acknowledged.reconcile(first, packet('n'));
      return { first, second: acknowledged.fork().continuation(continuation(name, value), first) };
    }
    const a = identity('random-one', 'hello'), b = identity('random-two', 'hello'), c = identity('random-three', 'different');
    expect(a.first.sql).toBe('SELECT $1::text'); expect(a.first.bytes).toEqual(Buffer.concat(prefix('random-one')));
    expect(a.first.fingerprint).toBe(b.first.fingerprint); expect(a.first.fingerprint).toBe(c.first.fingerprint);
    expect(a.second.fingerprint).toBe(b.second.fingerprint); expect(a.second.fingerprint).not.toBe(c.second.fingerprint);
    expect(a.second.bytes).toEqual(Buffer.concat(continuation('random-one')));
  });
  test('requires matching statement and portal references and rejects metadata-only success', () => {
    const assembler = new FrontendAssembler(); const first = assembler.fork().describe(prefix());
    assembler.reconcile(first, packet('1')); assembler.reconcile(first, parameter); assembler.reconcile(first, packet('n'));
    expect(() => assembler.fork().continuation(continuation('other'), first)).toThrow(/statement/i);
    const wrongPortal = continuation(); wrongPortal[1] = packet('E', Buffer.concat([str('other'), Buffer.alloc(4)]));
    expect(() => assembler.fork().continuation(wrongPortal, first)).toThrow(/portal/i);
    expect(() => assembler.fork().continuation([packet('S')], first)).toThrow(/continuation/i);
    expect(() => assembler.fork().describe([parse('a'), describeStatement('other'), packet('H')])).toThrow(/statement/i);
  });
  test('only accepts Sync for recovery and retains its original bytes without execution', () => {
    const assembler = new FrontendAssembler(); const first = assembler.fork().describe(prefix());
    const failure = { code: '42601', message: 'syntax error' };
    const unit = assembler.fork().continuation([packet('S')], first, failure);
    expect(unit.stage).toBe('recover'); expect(unit.bytes).toEqual(packet('S'));
    expect(() => assembler.fork().continuation(continuation(), first, failure)).toThrow(/recovery/i);
  });
  test('keeps default rejection and rejects repeated/mixed early Flush shapes', () => {
    expect(() => new FrontendCycleBuffer().accept(packet('H'))).toThrow(/Flush/);
    for (const frames of [[packet('H')], [parse('a'), packet('H')], [parse('a'), ...continuation().slice(0, 1), packet('H')], [...prefix(), packet('H')]]) {
      const buffer = new FrontendCycleBuffer({ protocolProfile: 'describe-flush-v1' });
      expect(() => frames.forEach(frame => buffer.accept(frame))).toThrow(/Flush|prefix/i);
    }
  });
});

describe('actual metadata completion shape', () => {
  test('waits through ParameterDescription for terminal metadata and allows zero-column RowDescription', () => {
    const summary = new MetadataSummary();
    expect(summary.accept(packet('1'))).toBeUndefined(); expect(summary.accept(parameter)).toBeUndefined();
    expect(summary.accept(packet('N', Buffer.from([0])))).toBeUndefined();
    expect(summary.accept(packet('T', Buffer.alloc(2)))).toEqual({ kind: 'metadata', result: 'described', parameterCount: 1, columnCount: 0, resultShape: 'rows' });
  });
  test('records NoData and real SQL errors without invented transaction state', () => {
    const summary = new MetadataSummary(); summary.accept(packet('1')); summary.accept(parameter);
    expect(summary.accept(packet('n'))).toEqual({ kind: 'metadata', result: 'described', parameterCount: 1, columnCount: 0, resultShape: 'no-data' });
    expect(new MetadataSummary().accept(packet('E', Buffer.from('SERROR\0C42601\0Msyntax error\0\0')))).toEqual({ kind: 'metadata', result: 'error', error: { code: '42601', message: 'syntax error' } });
  });
  test('rejects malformed or out-of-order metadata and execution responses', () => {
    for (const frame of [parameter, packet('n'), packet('Z', Buffer.from('I')), packet('D', Buffer.alloc(2)), packet('C', str('SELECT 1'))]) expect(() => new MetadataSummary().accept(frame)).toThrow(/metadata/i);
    const summary = new MetadataSummary(); summary.accept(packet('1'));
    expect(() => summary.accept(packet('t', Buffer.from([0, 1])))).toThrow(/metadata/i);
    const rows = new MetadataSummary(); rows.accept(packet('1')); rows.accept(parameter);
    expect(() => rows.accept(packet('T', Buffer.from([0, 1])))).toThrow(/metadata/i);
  });
});
