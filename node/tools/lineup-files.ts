// Writes node/src/ui/lineup-files.ts: for every model named in src/ui/lineup.ts, what Hugging
// Face says about its file (size and sha256 of the LFS object; for a model in several files
// their number and total size) and what its gguf header says (architecture, context, the kv
// cache per 1 024 tokens), read with a Range request of the first megabytes. Also the
// architectures llama.cpp at kula's tag knows, read off the vendored llama-arch.cpp. Nothing
// is guessed: a model whose facts cannot be read is left out and the page shows it dimmed.
//
//   cd node && npx tsx tools/lineup-files.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSpecs } from '../src/ui/lineup.ts';
import { TAG } from '../src/llama.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ARCH_CPP = path.join(here, '..', '..', 'app', 'modules', 'kula-llama', 'android', 'src', 'main', 'cpp', 'llama.cpp', 'src', 'llama-arch.cpp');

export function archNames(cpp: string): string[] {
  const table = /LLM_ARCH_NAMES\s*=\s*\{([\s\S]*?)\n\};/.exec(cpp)?.[1] ?? '';
  return [...table.matchAll(/\{\s*LLM_ARCH_\w+\s*,\s*"([^"]+)"\s*\}/g)].map((m) => m[1]).filter((n) => n !== '(unknown)');
}

// A small gguf metadata reader over a buffer; arrays of numbers come back whole.
type Val = number | string | boolean | number[] | null;
export function ggufMeta(buf: Buffer, partial = false): Record<string, Val> {
  let at = 0;
  const need = (n: number) => { if (at + n > buf.length) throw new RangeError('short'); };
  const u32 = () => { need(4); const v = buf.readUInt32LE(at); at += 4; return v; };
  const u64 = () => { need(8); const v = Number(buf.readBigUInt64LE(at)); at += 8; return v; };
  const str = () => { const n = u64(); need(n); const s = buf.toString('utf8', at, at + n); at += n; return s; };
  const SIZES = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8];
  const scalar = (t: number): number | string | boolean => {
    switch (t) {
      case 0: need(1); return buf.readUInt8(at++);
      case 1: need(1); return buf.readInt8(at++);
      case 2: need(2); { const v = buf.readUInt16LE(at); at += 2; return v; }
      case 3: need(2); { const v = buf.readInt16LE(at); at += 2; return v; }
      case 4: return u32();
      case 5: need(4); { const v = buf.readInt32LE(at); at += 4; return v; }
      case 6: need(4); { const v = buf.readFloatLE(at); at += 4; return v; }
      case 7: need(1); return buf.readUInt8(at++) !== 0;
      case 8: return str();
      case 10: return u64();
      case 11: need(8); { const v = Number(buf.readBigInt64LE(at)); at += 8; return v; }
      case 12: need(8); { const v = buf.readDoubleLE(at); at += 8; return v; }
      default: throw new Error(`gguf type ${t}`);
    }
  };
  if (u32() !== 0x46554747) throw new Error('not a gguf file');
  if (u32() < 2) throw new Error('old gguf');
  u64();
  const kv = u64();
  const out: Record<string, Val> = {};
  for (let i = 0; i < kv; i++) {
    let key: string;
    let t: number;
    try { key = str(); t = u32(); } catch (e) { if (partial && e instanceof RangeError) return out; throw e; }
    // the tokenizer comes after the model's own keys and is megabytes long: what is needed is read
    if (partial && key.startsWith('tokenizer.')) { out.__done = true; return out; }
    const mark = at;
    try {
    if (t !== 9) { out[key] = scalar(t); continue; }
    const et = u32();
    const n = u64();
    if (et === 8) { for (let j = 0; j < n; j++) str(); out[key] = null; }
    else if (n <= 4096) { const a: number[] = []; for (let j = 0; j < n; j++) a.push(Number(scalar(et))); out[key] = a; }
    else { need(SIZES[et] * n); at += SIZES[et] * n; out[key] = null; }
    } catch (e) { if (partial && e instanceof RangeError) { at = mark; return out; } throw e; }
  }
  out.__done = true;
  return out;
}

// MB of kv cache per 1 024 tokens at f16: Σ over layers of kv heads × (key + value width) × 2 bytes
export function kvMbPer1k(meta: Record<string, Val>): number {
  const arch = String(meta['general.architecture']);
  const g = (k: string) => meta[`${arch}.${k}`];
  const layers = Number(g('block_count'));
  const heads = g('attention.head_count');
  const headsN = Array.isArray(heads) ? Math.max(...heads) : Number(heads);
  const kvh = g('attention.head_count_kv') ?? heads;
  const embd = Number(g('embedding_length'));
  const k = Number(g('attention.key_length') ?? embd / headsN);
  const v = Number(g('attention.value_length') ?? k);
  const perLayer = Array.isArray(kvh) ? kvh.slice(0, layers) : Array(layers).fill(Number(kvh));
  const bytes = perLayer.reduce((s, h) => s + h * (k + v) * 2, 0);
  return Math.max(1, Math.round((bytes * 1024) / (1024 * 1024)));
}

// Streams the file from its start and stops once the model's own keys are read: the first
// tokenizer key ends them (the tokenizer itself is megabytes and not needed).
async function headOf(url: string): Promise<Record<string, Val>> {
  const ac = new AbortController();
  const r = await fetch(url, { headers: { range: `bytes=0-${8 * 1024 * 1024 - 1}` }, signal: ac.signal });
  if (r.status !== 206) { ac.abort(); throw new Error(`HTTP ${r.status} (no range)`); }
  const chunks: Buffer[] = [];
  let got = 0, tried = 0;
  try {
    for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(c));
      got += c.length;
      if (got - tried < 32 * 1024) continue;
      tried = got;
      const m = probeMeta(Buffer.concat(chunks));
      if (m) return m;
    }
    const m = probeMeta(Buffer.concat(chunks));
    if (m) return m;
    throw new Error('the model keys did not end in the first 8 MB');
  } finally { ac.abort(); }
}
// the keys read so far once they are complete (a tokenizer key came next, or the end), else null
function probeMeta(buf: Buffer): Record<string, Val> | null {
  const m = ggufMeta(buf, true);
  return m.__done ? m : null;
}
// at most `n` at once
async function each<T>(list: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) await fn(list[i++]); }));
}

type Tree = { path: string; size: number; lfs?: { oid: string; size: number } }[];
const trees = new Map<string, Promise<Tree>>();
const tree = (repo: string) => {
  if (!trees.has(repo)) trees.set(repo, fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=1`).then((r) => { if (!r.ok) throw new Error(`tree HTTP ${r.status}`); return r.json() as Promise<Tree>; }));
  return trees.get(repo)!;
};
async function licenseOf(repo: string): Promise<string> {
  const r = await fetch(`https://huggingface.co/api/models/${repo}`);
  if (!r.ok) return 'unknown';
  const j = await r.json() as { cardData?: { license?: string }; tags?: string[] };
  return j.cardData?.license ?? j.tags?.find((t) => t.startsWith('license:'))?.slice(8) ?? 'unknown';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archs = archNames(fs.readFileSync(ARCH_CPP, 'utf8'));
  if (archs.length < 50) throw new Error(`only ${archs.length} architectures read from ${ARCH_CPP}`);
  const facts: Record<string, unknown> = {};
  const specs = fileSpecs();
  await each(specs, 6, async (s) => {
    try {
      const t = await tree(s.repo);
      const files = s.file ? t.filter((f) => f.path === s.file) : t.filter((f) => f.path.endsWith('.gguf') && new RegExp(s.parts!).test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
      if (!files.length) throw new Error(`no file ${s.file ?? s.parts}`);
      const first = files[0];
      const sha = first.lfs?.oid ?? '';
      if (files.length === 1 && !/^[0-9a-f]{64}$/.test(sha)) throw new Error('no sha256');
      const meta = await headOf(`https://huggingface.co/${s.repo}/resolve/main/${first.path}`);
      const arch = String(meta['general.architecture']);
      facts[s.id] = {
        size: files.reduce((n, f) => n + (f.lfs?.size ?? f.size), 0), sha256: files.length === 1 ? sha : '', parts: files.length, arch,
        ctx_max: Number(meta[`${arch}.context_length`] ?? 0), kv_mb_per_1k: files.length === 1 || meta[`${arch}.block_count`] ? kvMbPer1k(meta) : 0,
        license: await licenseOf(s.repo),
      };
      console.log(`${s.id.padEnd(28)} ${arch.padEnd(14)} ${(Number((facts[s.id] as { size: number }).size) / 1e9).toFixed(2)} GB${files.length > 1 ? ` in ${files.length} files` : ''} kv ${(facts[s.id] as { kv_mb_per_1k: number }).kv_mb_per_1k} ${archs.includes(arch) ? '' : '  (llama.cpp does not know it)'}`);
    } catch (e) { console.error(`${s.id}: ${(e as Error).message} (left out)`); }
  });
  const ordered = Object.fromEntries(specs.filter((s) => facts[s.id]).map((s) => [s.id, facts[s.id]]));
  const out = path.join(here, '..', 'src', 'ui', 'lineup-files.ts');
  fs.writeFileSync(out, `// Generated by node/tools/lineup-files.ts on ${new Date().toISOString().slice(0, 10)}: do not edit by hand.
// Sizes and sha256s are the Hugging Face LFS objects'; architecture, context and kv cache come
// from each file's gguf header; the architectures are llama.cpp ${TAG}'s (llama-arch.cpp).
export interface FileFacts { size: number; sha256: string; parts: number; arch: string; ctx_max: number; kv_mb_per_1k: number; license: string }
export const LLAMA_TAG = ${JSON.stringify(TAG)};
export const LLAMA_ARCHS: string[] = ${JSON.stringify(archs)};
export const LINEUP_FILES: Record<string, FileFacts> = ${JSON.stringify(ordered, null, 2)};
`);
  console.log(`wrote ${out}: ${Object.keys(ordered).length} of ${specs.length} models, ${archs.length} architectures`);
}
