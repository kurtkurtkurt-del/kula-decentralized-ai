// The GGUF header reader against its own writer: write → read is the identity, the native
// meta text comes out the same, and any corruption of the bytes ends in a GgufError with
// bounded work, never a hang or another kind of throw.
import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import { GGUF_TYPE, GgufError, metaFromText, metaOf, metaText, readGgufHeader, writeGgufHeader, type GgufKv, type GgufValue } from '@/llm/gguf';

const key = fc.stringMatching(/^[a-z][a-z0-9_.]{0,30}$/);
const scalar: fc.Arbitrary<[number, GgufValue]> = fc.oneof(
  fc.tuple(fc.constant(GGUF_TYPE.UINT8), fc.integer({ min: 0, max: 255 })),
  fc.tuple(fc.constant(GGUF_TYPE.INT8), fc.integer({ min: -128, max: 127 })),
  fc.tuple(fc.constant(GGUF_TYPE.UINT16), fc.integer({ min: 0, max: 65535 })),
  fc.tuple(fc.constant(GGUF_TYPE.INT16), fc.integer({ min: -32768, max: 32767 })),
  fc.tuple(fc.constant(GGUF_TYPE.UINT32), fc.integer({ min: 0, max: 0xffffffff })),
  fc.tuple(fc.constant(GGUF_TYPE.INT32), fc.integer({ min: -0x80000000, max: 0x7fffffff })),
  fc.tuple(fc.constant(GGUF_TYPE.FLOAT32), fc.float({ noNaN: true })),
  fc.tuple(fc.constant(GGUF_TYPE.BOOL), fc.boolean()),
  fc.tuple(fc.constant(GGUF_TYPE.STRING), fc.string({ maxLength: 40, unit: 'grapheme' })),
  fc.tuple(fc.constant(GGUF_TYPE.UINT64), fc.bigInt({ min: 0n, max: (1n << 64n) - 1n })),
  fc.tuple(fc.constant(GGUF_TYPE.INT64), fc.bigInt({ min: -(1n << 63n), max: (1n << 63n) - 1n })),
  fc.tuple(fc.constant(GGUF_TYPE.FLOAT64), fc.double({ noNaN: true })),
  fc.tuple(fc.constant(GGUF_TYPE.ARRAY), fc.array(fc.string({ maxLength: 6 }), { maxLength: 8 })),
  fc.tuple(fc.constant(GGUF_TYPE.ARRAY), fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 8 })),
);
const kvs = fc.uniqueArray(fc.tuple(key, scalar).map(([k, [t, v]]) => [k, t, v] as GgufKv), { maxLength: 12, selector: (e) => e[0] });
// a header shaped like a real model's
const arch = fc.constantFrom('llama', 'qwen2', 'gemma2', 'phi3');
const modelKvs = fc.tuple(arch, fc.integer({ min: 1, max: 200 }), fc.integer({ min: 128, max: 1 << 20 }), fc.integer({ min: 64, max: 16384 }), fc.integer({ min: 1, max: 128 }), fc.option(fc.integer({ min: 1, max: 128 }), { nil: null }), fc.string({ maxLength: 30 }), fc.option(fc.constantFrom('apache-2.0', 'mit', 'llama3'), { nil: null }), fc.integer({ min: 0, max: 40 }), fc.boolean())
  .map(([a, layers, ctx, embd, heads, headsKv, name, license, fileType, tpl]) => {
    const out: GgufKv[] = [['general.architecture', GGUF_TYPE.STRING, a], [`${a}.block_count`, GGUF_TYPE.UINT32, layers], [`${a}.context_length`, GGUF_TYPE.UINT32, ctx], [`${a}.embedding_length`, GGUF_TYPE.UINT32, embd], [`${a}.attention.head_count`, GGUF_TYPE.UINT32, heads], ['general.name', GGUF_TYPE.STRING, name], ['general.file_type', GGUF_TYPE.UINT32, fileType]];
    if (headsKv !== null) out.push([`${a}.attention.head_count_kv`, GGUF_TYPE.UINT32, headsKv]);
    if (license !== null) out.push(['general.license', GGUF_TYPE.STRING, license]);
    if (tpl) out.push(['tokenizer.chat_template', GGUF_TYPE.STRING, '{{ messages }}']);
    return { kvs: out, expect: { arch: a, layers: String(layers), ctx: String(ctx), embd: String(embd), heads: String(heads), ...(headsKv !== null ? { heads_kv: String(headsKv) } : {}), name, ...(license !== null ? { license } : {}), file_type: String(fileType), template: tpl ? '1' : '0' } };
  });

const same = (a: GgufValue, b: GgufValue) => {
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || a === b;
  return JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
};

describe('gguf header', () => {
  it('write → read is the identity', () => {
    fc.assert(fc.property(kvs, fc.constantFrom(2, 3), fc.integer({ min: 0, max: 5000 }), (list, version, tensors) => {
      const bytes = writeGgufHeader(list, version, tensors);
      const h = readGgufHeader(bytes);
      expect(h.version).toBe(version);
      expect(h.tensors).toBe(tensors);
      expect(h.kv.size).toBe(list.length);
      for (const [k, t, v] of list) {
        const got = h.kv.get(k)!;
        expect(got.type).toBe(t);
        if (t === GGUF_TYPE.FLOAT32) expect(got.value).toBe(Math.fround(v as number));
        else expect(same(got.value, v)).toBe(true);
      }
    }), { numRuns: 300 });
  });

  it('a model-shaped header gives the native record, via the table and via the text', () => {
    fc.assert(fc.property(modelKvs, (m) => {
      const h = readGgufHeader(writeGgufHeader(m.kvs));
      expect(metaOf(h)).toEqual(m.expect);
      expect(metaFromText(metaText(h))).toEqual(m.expect);
    }), { numRuns: 300 });
  });

  it('any corruption ends in a GgufError or a header, never another throw, within the limits', () => {
    fc.assert(fc.property(kvs, fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 6 }), fc.nat(), (list, flips, cut) => {
      const good = writeGgufHeader(list);
      const bytes = good.slice(0, good.length - (cut % Math.max(1, Math.min(good.length, 64))) + (cut % 2 ? 0 : 0));
      for (const [at, v] of flips) bytes[at % bytes.length] = v;
      const limits = { maxKv: 64, maxString: 4096, maxArray: 4096 };
      try {
        const h = readGgufHeader(bytes, limits);
        expect(h.kv.size).toBeLessThanOrEqual(64);
      } catch (e) {
        expect(e).toBeInstanceOf(GgufError);
      }
    }), { numRuns: 1000 });
  });

  it('any bytes at all never throw anything but GgufError', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (b) => {
      try { readGgufHeader(b); } catch (e) { expect(e).toBeInstanceOf(GgufError); }
    }), { numRuns: 1000 });
  });

  it('the limits are honoured before any allocation', () => {
    const huge = writeGgufHeader([]);
    // n_kv = 2^40 at offset 16
    new DataView(huge.buffer).setBigUint64(16, 1n << 40n, true);
    expect(() => readGgufHeader(huge)).toThrow('too many');
    const big = writeGgufHeader([['k', GGUF_TYPE.STRING, 'x']]);
    // the string length (after magic 4 + ver 4 + tensors 8 + nkv 8 + key len 8 + 'k' 1 + type 4) = 2^50
    new DataView(big.buffer).setBigUint64(37, 1n << 50n, true);
    expect(() => readGgufHeader(big)).toThrow('too long');
    const arr = writeGgufHeader([['a', GGUF_TYPE.ARRAY, [1, 2, 3]]]);
    // array length at 37 + inner type 4
    new DataView(arr.buffer).setBigUint64(41, 1n << 30n, true);
    expect(() => readGgufHeader(arr)).toThrow('too many');
    new DataView(arr.buffer).setBigUint64(41, 1_000_000n, true);
    expect(() => readGgufHeader(arr)).toThrow('truncated');
  });

  it('an architecture that is not a string gives an empty arch (the native side must not abort on it)', () => {
    const h = readGgufHeader(writeGgufHeader([['general.architecture', GGUF_TYPE.UINT32, 7], ['general.name', GGUF_TYPE.INT32, 3]]));
    expect(metaOf(h)).toEqual({ arch: '', template: '0' });
    expect(() => readGgufHeader(Uint8Array.from([0x47, 0x47, 0x55, 0x46]))).toThrow('truncated');
    expect(() => readGgufHeader(new TextEncoder().encode('GGML'))).toThrow('magic');
    expect(() => readGgufHeader(writeGgufHeader([], 1))).toThrow('version');
    expect(metaFromText(null)).toEqual({});
    expect(metaFromText('arch\tllama\nnot a tab line\nlayers\t32\n')).toEqual({ arch: 'llama', layers: '32' });
  });
});
