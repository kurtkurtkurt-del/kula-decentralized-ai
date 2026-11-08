// The chat page's model picker (src/ui/lineup.ts): makers → series → models, the file facts
// read off Hugging Face and the gguf headers (src/ui/lineup-files.ts, written by
// tools/lineup-files.ts), and what is dimmed and why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINEUP, isFile, fileSpecs, whyNot, LINEUP_EXTRA, FULL_CATALOG, lineupView } from '../src/ui/lineup.ts';
import { LINEUP_FILES, LLAMA_ARCHS, LLAMA_TAG } from '../src/ui/lineup-files.ts';
import { UI_CATALOG } from '../src/ui/catalog.ts';
import { TAG } from '../src/llama.ts';
import { archNames, ggufMeta, kvMbPer1k } from '../tools/lineup-files.ts';

test('lineup: the five makers first, ids unique, every catalog reference is in the phone catalog', () => {
  assert.deepEqual(LINEUP.slice(0, 5).map((k) => k.id), ['qwen', 'gemma', 'llama', 'phi', 'deepseek']);
  const ids = LINEUP.flatMap((k) => k.series.flatMap((s) => s.models.map((m) => (isFile(m) ? m.id : m.catalog))));
  assert.equal(new Set(ids).size, ids.length, 'a model is listed twice');
  for (const k of LINEUP) for (const s of k.series) for (const m of s.models) if (!isFile(m)) assert.ok(UI_CATALOG.some((c) => c.id === m.catalog), m.catalog);
  // every phone catalog model has a place in the picker
  for (const c of UI_CATALOG) assert.ok(ids.includes(c.id), `${c.id} is not in the picker`);
  for (const s of fileSpecs()) assert.ok(!!s.file !== !!s.parts, `${s.id}: one file or parts`);
});

test('lineup files: the tag is kula\'s, every runnable model has a real sha256, a size, a kv cache and a known architecture', () => {
  assert.equal(LLAMA_TAG, TAG);
  assert.ok(LLAMA_ARCHS.length > 50 && LLAMA_ARCHS.includes('llama') && LLAMA_ARCHS.includes('qwen3'));
  assert.ok(LINEUP_EXTRA.length >= 20, `only ${LINEUP_EXTRA.length} runnable`);
  for (const m of LINEUP_EXTRA) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/, m.id);
    assert.ok(m.size > 100e6, m.id);
    assert.ok(m.kv_mb_per_1k > 0, m.id);
    assert.ok(LLAMA_ARCHS.includes(m.family), `${m.id}: ${m.family}`);
    assert.ok(m.file.endsWith('.gguf'), m.id);
  }
  for (const [id, f] of Object.entries(LINEUP_FILES)) assert.ok(fileSpecs().some((s) => s.id === id), `${id} has facts but no spec`);
  // the engine offers the phone catalog and the extras, each once
  assert.equal(new Set(FULL_CATALOG.map((m) => m.id)).size, FULL_CATALOG.length);
  assert.equal(FULL_CATALOG.length, UI_CATALOG.length + LINEUP_EXTRA.length);
});

test('dimmed: missing facts, several files, an architecture llama.cpp does not know; the view says why', () => {
  const spec = { id: 'x', name: 'X', repo: 'a/b', file: 'x.gguf', quant: 'Q4_K_M', params_b: 1, blurb: '' };
  const facts = { size: 5e9, sha256: 'a'.repeat(64), parts: 1, arch: 'llama', ctx_max: 4096, kv_mb_per_1k: 32, license: 'mit' };
  assert.equal(whyNot(spec, facts), null);
  assert.match(whyNot(spec, undefined)!, /not checked/);
  assert.match(whyNot(spec, { ...facts, parts: 3, size: 300e9 })!, /3 files \(300 GB\)/);
  assert.match(whyNot(spec, { ...facts, arch: 'deepseek41' })!, new RegExp(`llama.cpp ${TAG} cannot run its architecture \\(deepseek41\\)`));
  const view = lineupView(4000, 8192);
  assert.equal(view.hereFreeMb, 4000);
  assert.equal(view.hereTotalMb, 8192);
  for (const k of view.makers) for (const s of k.series) for (const m of s.models) {
    if (m.why) assert.ok(!FULL_CATALOG.some((c) => c.id === m.id), `${m.id} is dimmed but offered`);
    else assert.ok(FULL_CATALOG.some((c) => c.id === m.id), `${m.id} is offered in the view but not in the catalog`);
  }
});

test('the generator: llama-arch.cpp names, a gguf header read up to the tokenizer, the kv cache per 1 024 tokens', () => {
  const cpp = 'static const std::map<llm_arch, const char *> LLM_ARCH_NAMES = {\n    { LLM_ARCH_LLAMA,  "llama"  },\n    { LLM_ARCH_QWEN3,  "qwen3" },\n    { LLM_ARCH_UNKNOWN, "(unknown)" },\n};\n';
  assert.deepEqual(archNames(cpp), ['llama', 'qwen3']);

  // a tiny gguf: llama 3.2 1b's attention shape, then a tokenizer key the reader stops at
  const parts: Buffer[] = [];
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); parts.push(b); };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); parts.push(b); };
  const str = (s: string) => { u64(Buffer.byteLength(s)); parts.push(Buffer.from(s)); };
  const kvU32 = (k: string, v: number) => { str(k); u32(4); u32(v); };
  u32(0x46554747); u32(3); u64(0); u64(7);
  str('general.architecture'); u32(8); str('llama');
  kvU32('llama.block_count', 16); kvU32('llama.context_length', 131072); kvU32('llama.embedding_length', 2048);
  kvU32('llama.attention.head_count', 32); kvU32('llama.attention.head_count_kv', 8);
  str('tokenizer.ggml.tokens'); u32(9); u32(8); u64(1_000_000);   // a huge array that is never there
  const buf = Buffer.concat(parts);
  const m = ggufMeta(buf, true);
  assert.equal(m.__done, true);
  assert.equal(m['general.architecture'], 'llama');
  assert.equal(m['llama.context_length'], 131072);
  assert.equal(kvMbPer1k(m), 32);   // the phone catalog's figure for Llama 3.2 1B
  // cut short before the tokenizer: not done yet
  assert.equal(ggufMeta(buf.subarray(0, 60), true).__done, undefined);
  // per-layer kv heads (hybrid models): layers without attention count nothing
  assert.equal(kvMbPer1k({ 'general.architecture': 'x', 'x.block_count': 4, 'x.attention.head_count': 8, 'x.attention.head_count_kv': [0, 0, 0, 2], 'x.attention.key_length': 256, 'x.attention.value_length': 256 }), 2);
});
