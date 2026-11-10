// Reads a gguf file's header (the metadata, not the tensors) for what the
// planner and the bench need: blocks, width, vocabulary, kv cache size, quant.
// A file that is not gguf, or one this reader does not follow, gives a shape
// guessed from the size (Qwen-like proportions), flagged `guessed`.
import fs from 'node:fs';
import path from 'node:path';
import { MB, type SimModel } from './sim.js';

export interface GgufShape {
  arch: string | null;
  layers: number;
  hidden: number;
  vocab: number;
  kvMbPer1k: number;
  quant: string;       // 'Q8_0', 'Q4_K_M', … or '?'
  bytesPerParam: number;
  guessed: boolean;
  // a mixture of experts: the share of the file's weight bytes one token reads (the shared
  // tensors plus expert_used_count of expert_count routed experts), from the tensor table.
  // Absent for a dense model, or when the table cannot be read (then speed counts every byte).
  activeShare?: number;
}

// llama.cpp's LLAMA_FTYPE numbers for the common ones
const FTYPES: Record<number, string> = { 0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1', 10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 32: 'BF16' };

export function bytesPerParamOf(quant: string): number {
  if (/q8/i.test(quant)) return 1;
  if (/q6/i.test(quant)) return 0.82;
  if (/q5/i.test(quant)) return 0.69;
  if (/q3|q2/i.test(quant)) return 0.45;
  if (/f16|bf16/i.test(quant)) return 2;
  if (/f32/i.test(quant)) return 4;
  return 0.55;
}

class Cursor {
  private buf = Buffer.alloc(0);
  private at = 0;      // position in buf
  private filePos = 0; // file offset of buf[0] + buf.length
  constructor(private fd: number) {}
  private need(n: number): void {
    if (this.buf.length - this.at >= n) return;
    const rest = this.buf.subarray(this.at);
    const chunk = Buffer.alloc(Math.max(n, 1 << 20));
    const got = fs.readSync(this.fd, chunk, 0, chunk.length, this.filePos);
    this.filePos += got;
    this.buf = Buffer.concat([rest, chunk.subarray(0, got)]);
    this.at = 0;
    if (this.buf.length < n) throw new Error('gguf: truncated');
  }
  u8() { this.need(1); return this.buf.readUInt8(this.at++); }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.at); this.at += 4; return v; }
  u64() { this.need(8); const v = Number(this.buf.readBigUInt64LE(this.at)); this.at += 8; return v; }
  skip(n: number) { this.need(n); this.at += n; }
  /** The file offset of the next byte to read. */
  pos() { return this.filePos - (this.buf.length - this.at); }
  str() { const n = this.u64(); if (n > 1 << 24) throw new Error('gguf: string too long'); this.need(n); const s = this.buf.toString('utf8', this.at, this.at + n); this.at += n; return s; }
  scalar(type: number): number | string | boolean {
    switch (type) {
      case 0: return this.u8();
      case 1: this.need(1); return this.buf.readInt8(this.at++);
      case 2: this.need(2); { const v = this.buf.readUInt16LE(this.at); this.at += 2; return v; }
      case 3: this.need(2); { const v = this.buf.readInt16LE(this.at); this.at += 2; return v; }
      case 4: return this.u32();
      case 5: this.need(4); { const v = this.buf.readInt32LE(this.at); this.at += 4; return v; }
      case 6: this.need(4); { const v = this.buf.readFloatLE(this.at); this.at += 4; return v; }
      case 7: return this.u8() !== 0;
      case 8: return this.str();
      case 10: return this.u64();
      case 11: this.need(8); { const v = Number(this.buf.readBigInt64LE(this.at)); this.at += 8; return v; }
      case 12: this.need(8); { const v = this.buf.readDoubleLE(this.at); this.at += 8; return v; }
      default: throw new Error(`gguf: type ${type}`);
    }
  }
}

/** The metadata keys of a gguf file; arrays come back as their length only. */
export function readGgufMeta(file: string): Record<string, number | string | boolean> {
  return readGguf(file, false).meta;
}

export type GgufTensor = { name: string; offset: number; bytes: number };

/**
 * The metadata and, with `tensors`, the tensor table: each tensor's name and its bytes in the
 * file (the distance to the next tensor's data, the last one to the end of the file).
 */
export function readGguf(file: string, tensors = true): { meta: Record<string, number | string | boolean>; tensors: GgufTensor[] } {
  const fd = fs.openSync(file, 'r');
  try {
    const c = new Cursor(fd);
    if (c.u32() !== 0x46554747) throw new Error('not a gguf file');
    const version = c.u32();
    if (version < 2) throw new Error(`gguf v${version}`);
    const tensorCount = c.u64();
    const kvCount = c.u64();
    const out: Record<string, number | string | boolean> = {};
    for (let i = 0; i < kvCount; i++) {
      const key = c.str();
      const type = c.u32();
      if (type === 9) {
        const et = c.u32();
        const n = c.u64();
        if (et === 8) for (let j = 0; j < n; j++) c.str();
        else { const size = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8][et]; if (!size) throw new Error(`gguf: array of ${et}`); c.skip(size * n); }
        out[key] = n;
      } else out[key] = c.scalar(type);
    }
    if (!tensors) return { meta: out, tensors: [] };
    const list: { name: string; offset: number }[] = [];
    for (let i = 0; i < tensorCount; i++) {
      const name = c.str();
      const dims = c.u32();
      if (dims > 8) throw new Error('gguf: tensor dims');
      c.skip(8 * dims); // the shape
      c.u32();          // the ggml type
      list.push({ name, offset: c.u64() });
    }
    const align = typeof out['general.alignment'] === 'number' && out['general.alignment'] > 0 ? (out['general.alignment'] as number) : 32;
    const dataStart = Math.ceil(c.pos() / align) * align;
    const end = fs.fstatSync(fd).size - dataStart;
    const sorted = [...list].sort((a, b) => a.offset - b.offset);
    return { meta: out, tensors: sorted.map((t, i) => ({ ...t, bytes: Math.max(0, (sorted[i + 1]?.offset ?? end) - t.offset) })) };
  } finally {
    fs.closeSync(fd);
  }
}

export function guessShape(sizeBytes: number, quant = '?'): GgufShape {
  const bpp = bytesPerParamOf(quant);
  const params = sizeBytes / bpp;
  // Qwen-like: params ≈ 12 × layers × hidden² + vocab × hidden; layers ≈ 28 for most small models
  const layers = params > 20e9 ? 64 : params > 9e9 ? 48 : params > 5e9 ? 32 : 28;
  const hidden = Math.max(512, Math.round(Math.sqrt(params / (12 * layers)) / 128) * 128);
  return { arch: null, layers, hidden, vocab: 151936, kvMbPer1k: Math.round((2 * layers * (hidden / 4) * 2 * 1024) / MB), quant, bytesPerParam: bpp, guessed: true };
}

/**
 * A mixture of experts' active share from its tensor table: the routed experts are the
 * `*_exps` tensors (llama.cpp's name for routed expert weights: ffn_gate_exps, ffn_up_exps,
 * ffn_down_exps, ffn_gate_up_exps); shared experts and attention are not; a token reads the rest
 * whole and `used` of `count` experts. Null for a dense model or a table without experts.
 */
export function activeShareOf(tensors: GgufTensor[], count: number, used: number): number | null {
  if (!(count > 1) || !(used > 0) || used >= count) return null;
  const total = tensors.reduce((a, t) => a + t.bytes, 0);
  const experts = tensors.filter((t) => /_exps\./.test(t.name)).reduce((a, t) => a + t.bytes, 0);
  if (!(total > 0) || !(experts > 0)) return null;
  return Math.round(((total - experts * (1 - used / count)) / total) * 1000) / 1000;
}

export function ggufShape(file: string): GgufShape {
  const size = fs.statSync(file).size;
  let meta: Record<string, number | string | boolean>;
  let tensors: GgufTensor[] = [];
  try { ({ meta, tensors } = readGguf(file)); } catch {
    try { meta = readGgufMeta(file); } catch { return guessShape(size, quantFromName(file)); }
  }
  const arch = typeof meta['general.architecture'] === 'string' ? (meta['general.architecture'] as string) : null;
  const n = (k: string): number | null => { const v = arch ? meta[`${arch}.${k}`] : undefined; return typeof v === 'number' ? v : null; };
  const ft = meta['general.file_type'];
  const quant = (typeof ft === 'number' && FTYPES[ft]) || quantFromName(file);
  const layers = n('block_count');
  const hidden = n('embedding_length');
  if (!layers || !hidden) return guessShape(size, quant);
  const heads = n('attention.head_count') ?? 1;
  const kvHeads = n('attention.head_count_kv') ?? heads;
  const keyLen = n('attention.key_length') ?? Math.round(hidden / heads);
  const valLen = n('attention.value_length') ?? keyLen;
  const vocabMeta = n('vocab_size') ?? (typeof meta['tokenizer.ggml.tokens'] === 'number' ? (meta['tokenizer.ggml.tokens'] as number) : null);
  // kv cache in f16: layers × kv heads × (key + value) × 2 bytes per token
  const kvMbPer1k = Math.round((layers * kvHeads * (keyLen + valLen) * 2 * 1024) / MB);
  const active = activeShareOf(tensors, n('expert_count') ?? 0, n('expert_used_count') ?? 0);
  return { arch, layers, hidden, vocab: vocabMeta ?? 151936, kvMbPer1k, quant, bytesPerParam: bytesPerParamOf(quant), guessed: false, ...(active != null && active < 1 ? { activeShare: active } : {}) };
}

function quantFromName(file: string): string {
  const m = /(q\d_[0-9a-z_]+|q\d_\d|bf16|f16|f32)/i.exec(path.basename(file));
  return m ? m[1].toUpperCase() : '?';
}

/** The planner's view of a gguf: id from the file name. */
export function simModelOf(file: string): SimModel & { guessed: boolean } {
  const s = ggufShape(file);
  const size = fs.statSync(file).size;
  return { id: path.basename(file).replace(/\.gguf$/i, '').toLowerCase(), fileMb: size / MB, layers: s.layers, hidden: s.hidden, vocab: s.vocab, bytesPerParam: s.bytesPerParam, kvMbPer1k: s.kvMbPer1k, guessed: s.guessed, ...(s.activeShare ? { activeShare: s.activeShare } : {}) };
}
