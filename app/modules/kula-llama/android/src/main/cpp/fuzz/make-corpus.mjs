#!/usr/bin/env node
// Writes the seed corpus for gguf_meta_fuzz: a few valid headers and the broken shapes
// the TypeScript reader (app/src/llm/gguf.ts) is tested against. Deterministic, so the
// files are committed; run it again after changing the list.
//   node make-corpus.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'corpus');
mkdirSync(dir, { recursive: true });
const T = { UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12 };

function header(kvs, version = 3, tensors = 0n) {
  const parts = [];
  const enc = new TextEncoder();
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v))); parts.push(b); };
  const str = (s) => { const b = Buffer.from(enc.encode(s)); u64(b.length); parts.push(b); };
  const scalar = (t, v) => {
    const b = Buffer.alloc(8);
    switch (t) {
      case T.UINT8: b.writeUInt8(v); parts.push(b.subarray(0, 1)); break;
      case T.INT8: b.writeInt8(v); parts.push(b.subarray(0, 1)); break;
      case T.UINT16: b.writeUInt16LE(v); parts.push(b.subarray(0, 2)); break;
      case T.INT16: b.writeInt16LE(v); parts.push(b.subarray(0, 2)); break;
      case T.UINT32: b.writeUInt32LE(v >>> 0); parts.push(b.subarray(0, 4)); break;
      case T.INT32: b.writeInt32LE(v); parts.push(b.subarray(0, 4)); break;
      case T.FLOAT32: b.writeFloatLE(v); parts.push(b.subarray(0, 4)); break;
      case T.BOOL: b.writeUInt8(v ? 1 : 0); parts.push(b.subarray(0, 1)); break;
      case T.STRING: str(v); break;
      case T.UINT64: b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v))); parts.push(b); break;
      case T.INT64: b.writeBigInt64LE(BigInt.asIntN(64, BigInt(v))); parts.push(b); break;
      case T.FLOAT64: b.writeDoubleLE(v); parts.push(b); break;
      default: throw new Error(`type ${t}`);
    }
  };
  parts.push(Buffer.from('GGUF'));
  u32(version); u64(tensors); u64(kvs.length);
  for (const [k, t, v] of kvs) {
    str(k); u32(t);
    if (t === T.ARRAY) { const [inner, arr] = v; u32(inner); u64(arr.length); for (const e of arr) scalar(inner, e); } else scalar(t, v);
  }
  return Buffer.concat(parts);
}

const llama = [
  ['general.architecture', T.STRING, 'llama'], ['general.name', T.STRING, 'tiny'], ['general.license', T.STRING, 'mit'],
  ['general.file_type', T.UINT32, 15], ['general.size_label', T.STRING, '1B'],
  ['llama.block_count', T.UINT32, 16], ['llama.context_length', T.UINT32, 8192], ['llama.embedding_length', T.UINT32, 2048],
  ['llama.attention.head_count', T.UINT32, 32], ['llama.attention.head_count_kv', T.UINT32, 8],
  ['tokenizer.ggml.tokens', T.ARRAY, [T.STRING, ['<s>', '</s>', 'a', 'b']]], ['tokenizer.chat_template', T.STRING, '{{ messages }}'],
];
const files = {
  'valid_llama.gguf': header(llama),
  'valid_v2.gguf': header(llama.slice(0, 6), 2),
  'valid_empty.gguf': header([]),
  'valid_u64_layers.gguf': header([['general.architecture', T.STRING, 'qwen2'], ['qwen2.block_count', T.UINT64, 28n], ['qwen2.context_length', T.INT32, 32768]]),
  'arch_not_string.gguf': header([['general.architecture', T.UINT32, 7], ['general.name', T.INT32, 3], ['general.file_type', T.STRING, 'x']]),
  'arch_empty.gguf': header([['general.architecture', T.STRING, ''], ['.block_count', T.UINT32, 1]]),
  'bad_magic.gguf': Buffer.concat([Buffer.from('GGML'), header([]).subarray(4)]),
  'version_1.gguf': header([], 1),
  'version_99.gguf': header([], 99),
  'truncated_in_key.gguf': header(llama).subarray(0, 40),
  'truncated_in_value.gguf': header(llama).subarray(0, 60),
  'only_magic.gguf': Buffer.from('GGUF'),
  'empty.gguf': Buffer.alloc(0),
  'nkv_huge.gguf': (() => { const b = header([]); b.writeBigUInt64LE(1n << 40n, 16); return b; })(),
  'ntensors_huge.gguf': (() => { const b = header([]); b.writeBigUInt64LE(1n << 62n, 8); return b; })(),
  'string_len_huge.gguf': (() => { const b = header([['k', T.STRING, 'x']]); b.writeBigUInt64LE(1n << 50n, 37); return b; })(),
  'array_len_huge.gguf': (() => { const b = header([['a', T.ARRAY, [T.INT32, [1, 2, 3]]]]); b.writeBigUInt64LE(1n << 30n, 41); return b; })(),
  'array_of_arrays.gguf': (() => { const b = header([['a', T.ARRAY, [T.INT32, [1]]]]); b.writeUInt32LE(T.ARRAY, 37); return b; })(),
  'unknown_type.gguf': (() => { const b = header([['k', T.UINT32, 1]]); b.writeUInt32LE(77, 33); return b; })(),
  'duplicate_key.gguf': header([['general.architecture', T.STRING, 'llama'], ['general.architecture', T.STRING, 'phi3']]),
  'alignment_odd.gguf': header([['general.alignment', T.UINT32, 3]]),
  'alignment_zero.gguf': header([['general.alignment', T.UINT32, 0]]),
  'key_not_utf8.gguf': (() => { const b = header([['kk', T.UINT32, 1]]); b[28] = 0xff; b[29] = 0xfe; return b; })(),
  'long_key.gguf': header([['k'.repeat(70000), T.UINT32, 1]]),
  'one_tensor_no_info.gguf': header([['general.architecture', T.STRING, 'llama']], 3, 1n),
};
for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
console.log(`${Object.keys(files).length} files in ${dir}`);
