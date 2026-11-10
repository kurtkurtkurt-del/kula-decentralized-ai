// Mixtures of experts (10.11.2026, DURUM yapılacaklar 3): the speed follows the active weights,
// the memory the whole file. A 30B model with 3B active estimates like a 3B for tok/s and like
// a 30B for "fits"; split mode keeps its per-token network cost.
import { describe, expect, it } from '@jest/globals';
import { CATALOG, catalogById } from '@/llm/catalog';
import { activeShare, fitOn, fitTogether, needMb } from '@/llm/fit';
import { activeParamsOf, paramsOf } from '@/llm/hf';
import { asLocal, asWorker, DEVICES, estimateAlone, estimateSplit, modelProfile, NETWORKS, needMb as simNeed, planShares, withMeasured, type SimModel } from '@/llm/sim';
import type { Passport } from '@/passport/contract';

const GB = 1024 ** 3;
const phone = (over: Partial<Passport> = {}): Passport => ({
  schema: 'passport/0.3', device: 'Galaxy S25+', soc: 'x', android: '15', ram_total_gb: 12, ram_free_gb: 6, app_mem_cap_mb: 512,
  cpu_cores: 8, cpu_max_ghz: 3, mem_bw_gbs: 60, gflops: 100, storage_free_gb: 50, battery_pct: 80, charging: true,
  largest_model_q4: '~3B', est_tps: 20, measured_at: '2026-11-10T00:00:00Z', device_id: 'dev-1', kind: 'phone', mem_bw_read_gbs: 65.9,
  budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: 6, q4_k_m_b: 8, q3_k_s_b: 10, q8_0_b: 4 }, ...over,
});

// the same q4 file size per parameter for all three: 30B total, 3B active / 3B dense / 30B dense
const moe = { params_b: 30, active_b: 3, size: 18 * GB, kv_mb_per_1k: 96 };
const dense3 = { params_b: 3, size: 1.8 * GB, kv_mb_per_1k: 96 };
const dense30 = { params_b: 30, size: 18 * GB, kv_mb_per_1k: 96 };

describe('the catalog’s mixtures of experts', () => {
  it('Qwen3 30B-A3B and Gemma 4 26B-A4B are in, with fewer active than total parameters', () => {
    const q = catalogById('qwen3-30b-a3b')!;
    const g = catalogById('gemma4-26b-a4b')!;
    expect(q.active_b).toBe(3.3);
    expect(q.params_b).toBe(30.5);
    expect(g.active_b).toBe(3.8);
    expect(g.params_b).toBe(25.2);
    for (const m of CATALOG) if (m.active_b !== undefined) expect(m.active_b).toBeLessThan(m.params_b);
    // the dense ones stay dense
    expect(activeShare(catalogById('qwen3-4b-q4')!)).toBe(1);
  });
  it('their simulator shape carries the measured share; a dense one has none', () => {
    expect(modelProfile(catalogById('qwen3-30b-a3b')!).activeShare).toBe(0.113);
    expect(modelProfile(catalogById('gemma4-26b-a4b')!).activeShare).toBe(0.205);
    expect(modelProfile(catalogById('gemma4-26b-a4b')!).layers).toBe(30);
    expect(modelProfile(catalogById('qwen2.5-7b-q4')!).activeShare).toBeUndefined();
  });
});

describe('active share', () => {
  it('prefers the measured read_share over active ÷ total (Gemma 4: 0.205, not 3.8 / 25.2)', () => {
    const g = catalogById('gemma4-26b-a4b')!;
    expect(g.read_share).toBe(0.205);
    expect(activeShare(g)).toBe(0.205);
    expect(activeShare({ params_b: 25.2, active_b: 3.8 })).toBeCloseTo(0.151, 3);
    expect(activeShare({ params_b: 30, active_b: 3, read_share: 1 })).toBeCloseTo(0.1); // not a share: ignored
    // the phone's estimate for Gemma 4 reads 0.205 of the file per token, the memory all of it
    const p = phone();
    const est = fitOn(p, { size: g.size, kv_mb_per_1k: g.kv_mb_per_1k, ctx: 2048, active: activeShare(g) });
    const byBytes = fitOn(p, { size: g.size * 0.205, kv_mb_per_1k: g.kv_mb_per_1k, ctx: 2048 });
    const byParams = fitOn(p, { size: g.size * (3.8 / 25.2), kv_mb_per_1k: g.kv_mb_per_1k, ctx: 2048 });
    expect(est.tps).toEqual(byBytes.tps);
    expect(est.tps!.high).toBeLessThan(byParams.tps!.high);
    expect(est.needMb).toBe(fitOn(p, { size: g.size, kv_mb_per_1k: g.kv_mb_per_1k, ctx: 2048 }).needMb);
  });
  it('is active ÷ total, 1 when either is missing or not smaller', () => {
    expect(activeShare(moe)).toBeCloseTo(0.1);
    expect(activeShare({ params_b: 7 })).toBe(1);
    expect(activeShare({ params_b: 0, active_b: 3 })).toBe(1);
    expect(activeShare({ params_b: 3, active_b: 3 })).toBe(1);
    expect(activeShare({ params_b: null, active_b: null })).toBe(1);
  });
  it('reads a hugging face file name when the record has no active_b', () => {
    expect(activeShare({ params_b: 30, file: 'Qwen3-30B-A3B-Q4_K_M.gguf' })).toBeCloseTo(0.1);
    expect(activeShare({ params_b: 7, file: 'qwen2.5-7b-instruct-q4_k_m.gguf' })).toBe(1);
  });
  it('the name parser: "A3B" is the active count, the total stays the total', () => {
    expect(activeParamsOf('Qwen3-30B-A3B-Q4_K_M.gguf')).toBe(3);
    expect(paramsOf('Qwen3-30B-A3B-Q4_K_M.gguf')).toBe(30);
    expect(activeParamsOf('gemma-4-26B-A4B-it-UD-Q4_K_M.gguf')).toBe(4);
    expect(activeParamsOf('unsloth/LFM2.5-24B-A2B-GGUF')).toBe(2);
    expect(activeParamsOf('Qwen3-4B-Q4_K_M.gguf')).toBe(0);
    expect(activeParamsOf('Llama-3.2-3B-Instruct-Q4_K_M.gguf')).toBe(0);
    expect(activeParamsOf('gpt-oss-20b-MXFP4.gguf')).toBe(0);
  });
});

describe('fit.ts: speed like the active part, memory like the whole', () => {
  const p = phone();
  const f = (m: typeof moe | typeof dense3) => fitOn(p, { size: m.size, kv_mb_per_1k: m.kv_mb_per_1k, ctx: 2048, active: activeShare(m) });
  it('a 30B with 3B active is about as fast as a 3B dense', () => {
    const a = f(moe).tps!;
    const b = f(dense3).tps!;
    expect(Math.abs(a.high - b.high) / b.high).toBeLessThan(0.02);
    // and about ten times faster than the dense 30B of the same size
    expect(a.high / f(dense30).tps!.high).toBeGreaterThan(9);
  });
  it('and needs as much memory as the 30B: it does not fit a phone', () => {
    expect(f(moe).needMb).toBe(f(dense30).needMb);
    expect(f(moe).needMb).toBeGreaterThan(18 * 1024);
    expect(f(moe).verdict).toBe('no');
    expect(f(dense3).verdict).toBe('fits');
  });
  it('without `active` the estimate is the old one (the whole file)', () => {
    const old = fitOn(p, { size: moe.size, kv_mb_per_1k: 96, ctx: 2048 });
    expect(old.tps).toEqual(f(dense30).tps);
    expect(needMb({ size: moe.size, kv_mb_per_1k: 96, ctx: 2048 })).toBe(old.needMb);
  });
  it('a measured tok/s still wins over the estimate', () => {
    const m = fitOn(p, { size: moe.size, kv_mb_per_1k: 96, ctx: 2048, active: 0.1 }, 12.3);
    expect(m.tps!.high).toBe(12.3);
    expect(m.measured).toBe(true);
  });
  it('together (split): the shares are the whole model, the speed reads the active part, the hops stay', () => {
    const pool = [phone(), phone({ device: 'b', device_id: 'dev-2' }), phone({ device: 'c', device_id: 'dev-3' }), phone({ device: 'd', device_id: 'dev-4' })];
    const tm = fitTogether(pool, { size: moe.size, kv_mb_per_1k: 96, ctx: 2048, active: 0.1 });
    const td = fitTogether(pool, { size: moe.size, kv_mb_per_1k: 96, ctx: 2048 });
    expect(tm.shares).toEqual(td.shares);
    expect(tm.needMb).toBe(td.needMb);
    expect(tm.tps!.high).toBeGreaterThan(td.tps!.high);
    // the hops do not shrink: across 4 devices an MoE is slower than the same MoE on one device
    const alone = fitOn(phone({ budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: 40, q4_k_m_b: 8, q3_k_s_b: 10, q8_0_b: 4 } }), { size: moe.size, kv_mb_per_1k: 96, ctx: 2048, active: 0.1 });
    expect(tm.tps!.high).toBeLessThan(alone.tps!.high);
  });
});

describe('the planner (sim/): the same rule', () => {
  const shape = { layers: 48, hidden: 2048, vocab: 151936, bytesPerParam: 0.55, kvMbPer1k: 96 };
  const sMoe: SimModel = { id: 'moe', fileMb: (18 * GB) / 1048576, ...shape, activeShare: 0.1 };
  const s30: SimModel = { id: 'd30', fileMb: (18 * GB) / 1048576, ...shape };
  const s3: SimModel = { id: 'd3', fileMb: (1.8 * GB) / 1048576, ...shape };
  const mac = { ...asLocal(DEVICES.macm1), capMb: 30000 };
  it('alone: tok/s like the 3B, memory and load time like the 30B', () => {
    expect(Math.abs(estimateAlone(sMoe, mac).tps - estimateAlone(s3, mac).tps) / estimateAlone(s3, mac).tps).toBeLessThan(0.02);
    expect(estimateAlone(sMoe, mac).tps / estimateAlone(s30, mac).tps).toBeGreaterThan(9);
    expect(simNeed(sMoe, 2048)).toBe(simNeed(s30, 2048));
    expect(estimateAlone(sMoe, mac).loadS).toBe(estimateAlone(s30, mac).loadS);
  });
  it('a measured tok/s on an MoE comes back the same through withMeasured', () => {
    expect(estimateAlone(sMoe, withMeasured(mac, sMoe, 41)).tps).toBe(41);
  });
  it('split: the network part per token is the same as dense, the compute part smaller', () => {
    const rows = (m: SimModel) => [{ dev: mac, mb: m.fileMb / 2 }, { dev: asWorker(DEVICES.s25plus), mb: m.fileMb / 2 }];
    const a = estimateSplit(sMoe, rows(sMoe), NETWORKS.wifi5);
    const b = estimateSplit(s30, rows(s30), NETWORKS.wifi5);
    expect(a.netMsPerToken).toBe(b.netMsPerToken);
    expect(a.perTokenMs - a.netMsPerToken).toBeLessThan((b.perTokenMs - b.netMsPerToken) / 5);
    // the upload still carries every expert
    expect(a.loadS).toBe(b.loadS);
    // and the hops weigh more: a bigger share of the token than for the dense model
    expect(a.netMsPerToken / a.perTokenMs).toBeGreaterThan(b.netMsPerToken / b.perTokenMs);
  });
  it('the plan places the whole model (memory), and estimates the active part (speed)', () => {
    const input = (m: SimModel) => ({ model: m, ctx: 2048, local: { ...asLocal(DEVICES.s25plus), capMb: 7000 }, workers: [{ ...asWorker(DEVICES.pixel8), capMb: 7000 }, { ...asWorker(DEVICES.macm1), capMb: 8000 }], net: NETWORKS.wifi5, share: false });
    const pm = planShares(input(sMoe));
    const pd = planShares(input(s30));
    expect(pm.needMb).toBe(pd.needMb);
    expect(pm.used.map((u) => u.assignedMb)).toEqual(pd.used.map((u) => u.assignedMb));
    expect(pm.est.tps).toBeGreaterThan(pd.est.tps);
    expect(pm.est.netMsPerToken).toBe(pd.est.netMsPerToken);
  });
});
