// Mixtures of experts on the computer side (10.11.2026): the planner's speed reads the active
// weights, its memory the whole file; the share comes from the catalog (active_b ÷ params_b) or
// from a gguf's own tensor table; the chat page's lists carry active_b.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSplit, simModel, type Peer } from '../src/planner.ts';
import { estimateAlone, estimateSplit, needMb } from '../src/sim.ts';
import { activeShareOf, ggufShape, simModelOf } from '../src/gguf.ts';
import { UI_CATALOG } from '../src/ui/catalog.ts';
import { FULL_CATALOG, LINEUP_EXTRA, lineupView } from '../src/ui/lineup.ts';

const GB = 1024 ** 3;
const shape = { layers: 48, hidden: 2048, vocab: 151936, quant: 'Q4_K_M', kv_mb_per_1k: 96 };
const moe = simModel({ id: 'moe', size: 18 * GB, ...shape, params_b: 30, active_b: 3 });
const dense30 = simModel({ id: 'd30', size: 18 * GB, ...shape });
const dense3 = simModel({ id: 'd3', size: 1.8 * GB, ...shape });
const mac = { id: 'me', capMb: 30000, bw: 68, eff: 0.3 };
let n = 1;
const peer = (id: string, ram: number, bw: number): Peer => ({ id, name: id, host: '10.0.0.' + n++, port: 50551, secret: 'aa'.repeat(8), kind: 'pc', ram, bw, added_at: 't' });

test('simModel: the catalog’s active ÷ total parameters, none for a dense model', () => {
  assert.equal(moe.activeShare, 0.1);
  assert.equal(dense30.activeShare, undefined);
  assert.equal(simModel({ id: 'x', size: GB, ...shape, params_b: 3, active_b: 3 }).activeShare, undefined);
  // the measured bytes share first, as on the phone
  assert.equal(simModel({ id: 'g', size: GB, ...shape, params_b: 25.2, active_b: 3.8, read_share: 0.205 }).activeShare, 0.205);
});

test('a 30B with 3B active: tok/s like a 3B, memory like a 30B', () => {
  const a = estimateAlone(moe, mac).tps;
  const b = estimateAlone(dense3, mac).tps;
  assert.ok(Math.abs(a - b) / b < 0.02, `${a} vs ${b}`);
  assert.ok(a / estimateAlone(dense30, mac).tps > 9);
  assert.equal(needMb(moe, 4096), needMb(dense30, 4096));
});

test('split: the same placement and memory, the compute shrinks, the network per token does not', () => {
  const input = (model: typeof moe) => ({ model, ctx: 2048, localFreeMb: 12000, localBw: 68, localEff: 0.3, peers: [peer('a', 10000, 60), peer('b', 10000, 60)], share: false });
  const pm = planSplit(input(moe));
  const pd = planSplit(input(dense30));
  assert.equal(pm.needMb, pd.needMb);
  assert.deepEqual(pm.used.map((u) => u.assignedMb), pd.used.map((u) => u.assignedMb));
  assert.ok(pm.used.length > 0);
  assert.ok(pm.est.tps > pd.est.tps);
  assert.equal(pm.est.netMsPerToken, pd.est.netMsPerToken);
  assert.equal(pm.est.loadS, pd.est.loadS, 'the upload carries every expert');
  // with the compute small, the hops are a bigger part of the token
  assert.ok(pm.est.netMsPerToken / pm.est.perTokenMs > pd.est.netMsPerToken / pd.est.perTokenMs);
  const rows = [{ dev: mac, mb: 9000 }, { dev: { ...mac, id: 'w' }, mb: 9000 }];
  assert.equal(estimateSplit(moe, rows, { mbps: 30, rttMs: 3 }).netMsPerToken, estimateSplit(dense30, rows, { mbps: 30, rttMs: 3 }).netMsPerToken);
});

test('the tensor table: shared tensors whole, used of count routed experts', () => {
  const t = (name: string, bytes: number) => ({ name, offset: 0, bytes });
  const table = [t('token_embd.weight', 100), t('blk.0.attn_q.weight', 100), t('blk.0.ffn_gate_exps.weight', 400), t('blk.0.ffn_down_exps.weight', 400)];
  assert.equal(activeShareOf(table, 8, 2), 0.4); // (1000 − 800 × 6/8) / 1000
  assert.equal(activeShareOf(table, 0, 0), null);
  assert.equal(activeShareOf(table, 8, 8), null);
  assert.equal(activeShareOf([t('blk.0.ffn_up.weight', 10)], 8, 2), null);
});

// a gguf v3 with an moe header and a tensor table, the data padded to its offsets
function moeGguf(file: string) {
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  const kvs = [
    Buffer.concat([str('general.architecture'), u32(8), str('qwen3moe')]),
    Buffer.concat([str('qwen3moe.block_count'), u32(4), u32(1)]),
    Buffer.concat([str('qwen3moe.embedding_length'), u32(4), u32(64)]),
    Buffer.concat([str('qwen3moe.attention.head_count'), u32(4), u32(4)]),
    Buffer.concat([str('qwen3moe.attention.head_count_kv'), u32(4), u32(2)]),
    Buffer.concat([str('qwen3moe.expert_count'), u32(4), u32(8)]),
    Buffer.concat([str('qwen3moe.expert_used_count'), u32(4), u32(2)]),
    Buffer.concat([str('general.file_type'), u32(4), u32(15)]),
  ];
  // name, bytes: offsets in order
  const tensors: [string, number][] = [['token_embd.weight', 96], ['blk.0.attn_q.weight', 96], ['blk.0.ffn_gate_exps.weight', 416], ['blk.0.ffn_down_exps.weight', 416]];
  let off = 0;
  const infos = tensors.map(([name, bytes]) => { const b = Buffer.concat([str(name), u32(2), u64(8), u64(8), u32(12), u64(off)]); off += bytes; return b; });
  const head = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(kvs.length), ...kvs, ...infos]);
  const start = Math.ceil(head.length / 32) * 32;
  fs.writeFileSync(file, Buffer.concat([head, Buffer.alloc(start - head.length), Buffer.alloc(off, 1)]));
}

test('a gguf file says by itself that it is a mixture of experts, and how much a token reads', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-moe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tiny-moe-Q4_K_M.gguf');
  moeGguf(file);
  const s = ggufShape(file);
  assert.equal(s.guessed, false);
  assert.equal(s.arch, 'qwen3moe');
  // (1024 − 832 × 6/8) / 1024
  assert.equal(s.activeShare, Math.round(((1024 - 832 * 0.75) / 1024) * 1000) / 1000);
  assert.equal(simModelOf(file).activeShare, s.activeShare);
});

test('the chat page’s lists carry active_b: the phone catalog’s MoE models and the lineup’s', () => {
  const q = UI_CATALOG.find((m) => m.id === 'qwen3-30b-a3b')!;
  const g = UI_CATALOG.find((m) => m.id === 'gemma4-26b-a4b')!;
  assert.equal(q.active_b, 3.3);
  assert.equal(g.active_b, 3.8);
  assert.equal(q.read_share, 0.113);
  assert.equal(g.read_share, 0.205);
  assert.equal(q.repo, 'Qwen/Qwen3-30B-A3B-GGUF');
  assert.equal(g.repo, 'unsloth/gemma-4-26B-A4B-it-GGUF');
  for (const m of UI_CATALOG) if (m.active_b !== undefined) assert.ok(m.active_b < m.params_b, m.id);
  const extra = LINEUP_EXTRA.find((m) => m.id === 'qwen3.6-35b-a3b');
  assert.equal(extra?.active_b, 3);
  assert.ok(FULL_CATALOG.some((m) => m.id === 'qwen3-30b-a3b' && m.active_b === 3.3));
  const view = lineupView(4000, 16000).makers.flatMap((k) => k.series.flatMap((s) => s.models));
  const row = view.find((m) => m.id === 'gemma4-26b-a4b')!;
  assert.equal(row.active_b, 3.8);
  assert.equal(row.why, null);
  assert.equal(view.find((m) => m.id === 'qwen3-4b-q4')!.active_b, null);
});
