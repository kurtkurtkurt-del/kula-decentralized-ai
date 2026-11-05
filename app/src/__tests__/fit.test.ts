// The fit arithmetic at its edges (5.11.2026): no passport, no budget, a ctx that does not
// fit at all, the ctx suggestion, and split mode without a measured bandwidth.
import { describe, expect, it } from '@jest/globals';
import { OVERHEAD_MB, defaultCtx, fitOn, fitTogether, haveMb, needMb } from '@/llm/fit';
import type { Passport } from '@/passport/contract';

const MB = 1024 * 1024;
const phone = (over: Partial<Passport> = {}): Passport => ({
  schema: 'passport/0.3', device: 'Pixel 6a', soc: 'Tensor', android: '15', ram_total_gb: 6, ram_free_gb: 3.2, app_mem_cap_mb: 512,
  cpu_cores: 8, cpu_max_ghz: 2.8, mem_bw_gbs: 14, gflops: 40, storage_free_gb: 20, battery_pct: 80, charging: true,
  largest_model_q4: '~3B', est_tps: 6, measured_at: '2026-11-04T00:00:00Z', device_id: 'dev-1', kind: 'phone', mem_bw_read_gbs: 18,
  budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: 2.1, q4_k_m_b: 3, q3_k_s_b: 4, q8_0_b: 1 }, ...over,
});
const m = (mb: number, kv = 56, ctx = 4096) => ({ size: mb * MB, kv_mb_per_1k: kv, ctx });

describe('needMb', () => {
  it('is the file, its 5 %, the overhead and the kv for the context', () => {
    expect(needMb(m(1000, 56, 1024))).toBe(Math.round(1000 + 56 + OVERHEAD_MB + 50));
    expect(needMb(m(1000, 56, 1024), 4096)).toBe(Math.round(1000 + 224 + OVERHEAD_MB + 50));
    expect(needMb(m(1000, 0, 0))).toBe(1000 + OVERHEAD_MB + 50);
  });
});

describe('haveMb', () => {
  it('reads the budget, else free ram × 0.8, never below the java heap cap, 0 without a passport', () => {
    expect(haveMb(null)).toBe(0);
    expect(haveMb(phone({ budget: undefined }))).toBe(Math.round(3.2 * 1024 * 0.8));
    expect(haveMb(phone({ budget: undefined, ram_free_gb: 0.2, app_mem_cap_mb: 512 }))).toBe(512);
    expect(haveMb(phone({ budget: { ...phone().budget!, ram_gb: 0 } }))).toBe(Math.round(3.2 * 1024 * 0.8));
    expect(haveMb(phone({ budget: undefined, ram_free_gb: undefined as unknown as number, app_mem_cap_mb: undefined as unknown as number }))).toBe(0);
  });
});

describe('fitOn', () => {
  it('without a passport nothing fits and nothing is estimated', () => {
    const f = fitOn(null, m(500));
    expect(f).toEqual({ needMb: needMb(m(500)), haveMb: 0, verdict: 'no', maxCtx: 0, tps: null });
    expect(defaultCtx(f)).toBe(512);
  });
  it('is tight between 85 % and 100 % of what the device has', () => {
    const have = haveMb(phone()); // 2150
    // a model whose need lands exactly on mb (no kv, the 5 % folded into the size)
    const exactly = (mb: number) => fitOn(phone(), { size: ((mb - OVERHEAD_MB) * MB) / 1.05, kv_mb_per_1k: 0, ctx: 512 });
    expect(exactly(have * 0.8).verdict).toBe('fits');
    expect(exactly(have * 0.9).verdict).toBe('tight');
    expect(exactly(have * 1.01).verdict).toBe('no');
  });
  it('suggests the largest power-of-two context that fits, up to 4 096, and 512 when none does', () => {
    // a 1 gb file, 100 mb per 1k: 2150 - 1000 - 50 - 300 = 800 mb for kv → 8k tokens → ctx 8192 fits
    const f = fitOn(phone(), m(1000, 100, 32768));
    expect(f.maxCtx).toBe(8192);
    expect(defaultCtx(f)).toBe(4096);
    // tighter: 700 mb per 1k → only 1024 fits
    const g = fitOn(phone(), m(1000, 700, 4096));
    expect(g.maxCtx).toBe(1024);
    expect(defaultCtx(g)).toBe(1024);
    // the model's own ctx caps the search at 4 × ctx
    expect(fitOn(phone(), m(100, 1, 512)).maxCtx).toBe(2048);
    // too big at every context: maxCtx 0, the suggestion falls back to 512
    const h = fitOn(phone(), m(3000));
    expect(h.verdict).toBe('no');
    expect(h.maxCtx).toBe(0);
    expect(defaultCtx(h)).toBe(512);
  });
  it('estimates tok/s from the read bandwidth, else the plain one, none without either', () => {
    expect(fitOn(phone(), m(1024)).tps!.high).toBeCloseTo(18 * 0.6, 0);
    expect(fitOn(phone({ mem_bw_read_gbs: undefined }), m(1024)).tps!.high).toBeLessThan(fitOn(phone(), m(1024)).tps!.high);
    expect(fitOn(phone({ mem_bw_read_gbs: undefined, mem_bw_gbs: 0 }), m(1024)).tps).toBeNull();
  });
});

describe('fitTogether', () => {
  const a = phone();
  const b = phone({ device: 'S24', device_id: 'dev-2', mem_bw_read_gbs: 30, budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: 4, q4_k_m_b: 7, q3_k_s_b: 8, q8_0_b: 3 } });
  it('adds the budgets, fills the fastest first and leaves the slow one out when not needed', () => {
    const t = fitTogether([a, b], m(2000));
    expect(t.haveMb).toBe(haveMb(a) + haveMb(b));
    expect(t.shares.map((s) => s.name)).toEqual(['S24']); // 4096 × 0.9 holds 2000
    const u = fitTogether([a, b], m(5000));
    expect(u.shares.map((s) => s.name)).toEqual(['S24', 'Pixel 6a']);
    expect(u.shares[0].mb).toBe(Math.round(4096 * 0.9));
    expect(u.shares[1].mb).toBe(5000 - Math.round(4096 * 0.9));
  });
  it('has no speed when a device has no bandwidth, and a slower one with a hop', () => {
    const c = phone({ device: 'old', device_id: 'dev-3', mem_bw_read_gbs: undefined, mem_bw_gbs: 0 });
    expect(fitTogether([a, c], m(5000)).tps).toBeNull();
    const one = fitTogether([b], m(2000)).tps!;
    const two = fitTogether([a, b], m(5000)).tps!;
    expect(two.high).toBeLessThan(one.high);
    expect(two.low).toBeLessThan(two.high);
  });
  it('with no devices nothing fits', () => {
    const t = fitTogether([], m(100));
    expect(t.haveMb).toBe(0);
    expect(t.verdict).toBe('no');
    expect(t.shares).toEqual([]);
    expect(t.tps).toBeNull();
  });
});
