// The GGUF header in plain TypeScript: magic, version, the counts and the key/value table,
// read with hard limits so a truncated download or a hostile file costs a bounded amount of
// memory and time and ends in a GgufError, never a hang or a crash. `metaOf` turns the
// table into the same record the native side returns (kula_llama.cpp ggufMeta, parsed by
// Native.meta: arch, layers, ctx, embd, heads, heads_kv, key_len, value_len, name, license,
// size_label, file_type, template), so the two can be compared on the same bytes.
// Tensor info and data are not read here: the header is all a size estimate needs.
export class GgufError extends Error {
  constructor(readonly why: 'magic' | 'version' | 'truncated' | 'too many' | 'too long' | 'type' | 'utf8') {
    super(`gguf: ${why}`);
  }
}

export type GgufValue = number | bigint | boolean | string | GgufValue[];
export type GgufHeader = { version: number; tensors: number; kv: Map<string, { type: number; value: GgufValue }> };
export type GgufLimits = { maxKv: number; maxString: number; maxArray: number };
export const GGUF_LIMITS: GgufLimits = { maxKv: 4096, maxString: 1 << 20, maxArray: 1 << 22 };

export const GGUF_TYPE = { UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12 } as const;
const SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function readGgufHeader(bytes: Uint8Array, limits: GgufLimits = GGUF_LIMITS): GgufHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const need = (n: number) => { if (n < 0 || pos + n > bytes.length) throw new GgufError('truncated'); };
  const u32 = () => { need(4); const v = view.getUint32(pos, true); pos += 4; return v; };
  const u64 = (): number => {
    need(8);
    const lo = view.getUint32(pos, true);
    const hi = view.getUint32(pos + 4, true);
    pos += 8;
    // a count or length above 2^53 cannot be right for anything a phone holds
    if (hi > 0x1fffff) throw new GgufError('too long');
    return hi * 0x100000000 + lo;
  };
  const big = (signed: boolean): bigint => { need(8); const v = signed ? view.getBigInt64(pos, true) : view.getBigUint64(pos, true); pos += 8; return v; };
  const str = (): string => {
    const n = u64();
    if (n > limits.maxString) throw new GgufError('too long');
    need(n);
    const slice = bytes.subarray(pos, pos + n);
    pos += n;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(slice); } catch { throw new GgufError('utf8'); }
  };
  const scalar = (type: number): GgufValue => {
    switch (type) {
      case GGUF_TYPE.UINT8: need(1); return bytes[pos++];
      case GGUF_TYPE.INT8: need(1); return view.getInt8(pos++);
      case GGUF_TYPE.UINT16: need(2); { const v = view.getUint16(pos, true); pos += 2; return v; }
      case GGUF_TYPE.INT16: need(2); { const v = view.getInt16(pos, true); pos += 2; return v; }
      case GGUF_TYPE.UINT32: return u32();
      case GGUF_TYPE.INT32: need(4); { const v = view.getInt32(pos, true); pos += 4; return v; }
      case GGUF_TYPE.FLOAT32: need(4); { const v = view.getFloat32(pos, true); pos += 4; return v; }
      case GGUF_TYPE.BOOL: need(1); return bytes[pos++] !== 0;
      case GGUF_TYPE.STRING: return str();
      case GGUF_TYPE.UINT64: return big(false);
      case GGUF_TYPE.INT64: return big(true);
      case GGUF_TYPE.FLOAT64: need(8); { const v = view.getFloat64(pos, true); pos += 8; return v; }
      default: throw new GgufError('type');
    }
  };
  const value = (type: number, depth = 0): GgufValue => {
    if (type !== GGUF_TYPE.ARRAY) return scalar(type);
    if (depth > 0) throw new GgufError('type'); // gguf has no nested arrays
    const inner = u32();
    const n = u64();
    if (n > limits.maxArray) throw new GgufError('too many');
    // every element takes at least one byte (a string its length), so the file must be that big
    const each = inner === GGUF_TYPE.STRING ? 8 : SIZES[inner];
    if (each === undefined || inner === GGUF_TYPE.ARRAY) throw new GgufError('type');
    need(n * each);
    const out: GgufValue[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = scalar(inner);
    return out;
  };

  need(4);
  if (!(bytes[0] === 0x47 && bytes[1] === 0x47 && bytes[2] === 0x55 && bytes[3] === 0x46)) throw new GgufError('magic');
  pos = 4;
  const version = u32();
  if (version < 2 || version > 3) throw new GgufError('version');
  const tensors = u64();
  const nKv = u64();
  if (nKv > limits.maxKv) throw new GgufError('too many');
  if (tensors > MAX_SAFE) throw new GgufError('too long');
  const kv = new Map<string, { type: number; value: GgufValue }>();
  for (let i = 0; i < nKv; i++) {
    const key = str();
    const type = u32();
    kv.set(key, { type, value: value(type) });
  }
  return { version, tensors, kv };
}

/** The native module's record for this header (kula_llama.cpp ggufMeta → Native.meta). */
export function metaOf(h: GgufHeader): Record<string, string> {
  const out: Record<string, string> = {};
  const a = h.kv.get('general.architecture');
  const arch = a && a.type === GGUF_TYPE.STRING ? String(a.value) : '';
  out.arch = arch;
  const num = (suffix: string, name: string) => {
    const e = h.kv.get(`${arch}.${suffix}`);
    if (!e) return;
    if (e.type === GGUF_TYPE.UINT32 || e.type === GGUF_TYPE.INT32 || e.type === GGUF_TYPE.UINT64) out[name] = String(e.value);
  };
  num('block_count', 'layers');
  num('context_length', 'ctx');
  num('embedding_length', 'embd');
  num('attention.head_count', 'heads');
  num('attention.head_count_kv', 'heads_kv');
  num('attention.key_length', 'key_len');
  num('attention.value_length', 'value_len');
  for (const k of ['general.name', 'general.license', 'general.size_label', 'general.file_type']) {
    const e = h.kv.get(k);
    if (!e) continue;
    if (e.type === GGUF_TYPE.STRING) out[k.slice(8)] = String(e.value);
    else if (e.type === GGUF_TYPE.UINT32) out[k.slice(8)] = String(e.value);
  }
  out.template = h.kv.has('tokenizer.chat_template') ? '1' : '0';
  return out;
}

/** Native.meta's reading of the C++ text: one `name\tvalue` per line; lines without a tab are skipped. */
export function metaFromText(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const line of text.split('\n')) {
    const i = line.indexOf('\t');
    if (i < 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** The C++ side's text for a header, to compare a native answer against this reader. */
export function metaText(h: GgufHeader): string {
  const m = metaOf(h);
  const order = ['arch', 'layers', 'ctx', 'embd', 'heads', 'heads_kv', 'key_len', 'value_len', 'name', 'license', 'size_label', 'file_type', 'template'];
  return order.filter((k) => k in m).map((k) => `${k}\t${m[k]}`).join('\n') + '\n';
}

// --- writer: real headers for the tests and the fuzz corpus ---------------------------------

export type GgufKv = [key: string, type: number, value: GgufValue];

/** Writes a header (no tensors, no data) that readGgufHeader and gguf_init_from_file both accept. */
export function writeGgufHeader(kvs: GgufKv[], version = 3, tensors = 0): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); parts.push(b); };
  const u64 = (v: number | bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(v)), true); parts.push(b); };
  const str = (s: string) => { const b = enc.encode(s); u64(b.length); parts.push(b); };
  const scalar = (type: number, v: GgufValue) => {
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    switch (type) {
      case GGUF_TYPE.UINT8: b[0] = Number(v) & 255; parts.push(b.subarray(0, 1)); break;
      case GGUF_TYPE.INT8: dv.setInt8(0, Number(v)); parts.push(b.subarray(0, 1)); break;
      case GGUF_TYPE.UINT16: dv.setUint16(0, Number(v), true); parts.push(b.subarray(0, 2)); break;
      case GGUF_TYPE.INT16: dv.setInt16(0, Number(v), true); parts.push(b.subarray(0, 2)); break;
      case GGUF_TYPE.UINT32: dv.setUint32(0, Number(v) >>> 0, true); parts.push(b.subarray(0, 4)); break;
      case GGUF_TYPE.INT32: dv.setInt32(0, Number(v), true); parts.push(b.subarray(0, 4)); break;
      case GGUF_TYPE.FLOAT32: dv.setFloat32(0, Number(v), true); parts.push(b.subarray(0, 4)); break;
      case GGUF_TYPE.BOOL: b[0] = v ? 1 : 0; parts.push(b.subarray(0, 1)); break;
      case GGUF_TYPE.STRING: str(String(v)); break;
      case GGUF_TYPE.UINT64: dv.setBigUint64(0, BigInt.asUintN(64, BigInt(v as number | bigint)), true); parts.push(b); break;
      case GGUF_TYPE.INT64: dv.setBigInt64(0, BigInt.asIntN(64, BigInt(v as number | bigint)), true); parts.push(b); break;
      case GGUF_TYPE.FLOAT64: dv.setFloat64(0, Number(v), true); parts.push(b); break;
      default: throw new Error(`unknown gguf type ${type}`);
    }
  };
  parts.push(enc.encode('GGUF'));
  u32(version);
  u64(tensors);
  u64(kvs.length);
  for (const [key, type, value] of kvs) {
    str(key);
    u32(type);
    if (type === GGUF_TYPE.ARRAY) {
      const arr = value as GgufValue[];
      const inner = arr.length && typeof arr[0] === 'string' ? GGUF_TYPE.STRING : typeof arr[0] === 'boolean' ? GGUF_TYPE.BOOL : GGUF_TYPE.INT32;
      u32(inner);
      u64(arr.length);
      for (const e of arr) scalar(inner, e);
    } else scalar(type, value);
  }
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
