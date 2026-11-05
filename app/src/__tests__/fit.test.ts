// The fit arithmetic from a file's own header: kv per 1k tokens, the facts, the override and
// the context suggestion. Pure functions, no phone.
import { describe, expect, it } from '@jest/globals';
import { CATALOG } from '@/llm/catalog';
import { factsFromMeta, fitInput, fitOn, kvFromMeta, needMb, suggestCtx, type Fit } from '@/llm/fit';
import type { Passport } from '@/passport/contract';

const phone = (ramGb: number): Passport => ({
  schema: 'passport/0.3', device: 'Pixel 6a', soc: 'Tensor', android: '15', ram_total_gb: 6, ram_free_gb: 3.2, app_mem_cap_mb: 512,
  cpu_cores: 8, cpu_max_ghz: 2.8, mem_bw_gbs: 14, gflops: 40, storage_free_gb: 20, battery_pct: 80, charging: true,
  largest_model_q4: '~3B', est_tps: 6, measured_at: '2026-11-04T00:00:00Z', device_id: 'dev-1', kind: 'phone', mem_bw_read_gbs: 18,
  budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: ramGb, q4_k_m_b: 3, q3_k_s_b: 4, q8_0_b: 1 },
});
// qwen3 4b: 36 layers, 8 kv heads, head dim 128 → 36 × 8 × 256 × 2 B × 1024 = 144 MB per 1k
const qwen3_4b = { arch: 'qwen3', layers: '36', heads: '32', heads_kv: '8', key_len: '128', value_len: '128', embd: '2560', ctx: '40960', name: 'Qwen3 4B', license: 'apache-2.0' };

describe('kv from the header', () => {
  it('multiplies layers × kv heads × (k + v) × 2 bytes per token', () => {
    expect(kvFromMeta(qwen3_4b)).toBe(144);
  });
  it('falls back to embd / heads when key and value lengths are missing, and to heads when kv heads are', () => {
    expect(kvFromMeta({ layers: '36', heads: '32', heads_kv: '8', embd: '4096' })).toBe(144);
    // mha: every head keeps its own kv
    expect(kvFromMeta({ layers: '32', heads: '32', embd: '4096' })).toBe(512);
  });
  it('is null when the header lacks what it needs', () => {
    expect(kvFromMeta(null)).toBeNull();
    expect(kvFromMeta({})).toBeNull();
    expect(kvFromMeta({ layers: '36' })).toBeNull();
    expect(kvFromMeta({ layers: '36', heads: '32' })).toBeNull();
  });
  it('gathers the facts, with the model’s own ctx and license', () => {
    expect(factsFromMeta(qwen3_4b)).toEqual({ layers: 36, kv_mb_per_1k: 144, ctx_max: 40960, arch: 'qwen3', name: 'Qwen3 4B', license: 'apache-2.0' });
    expect(factsFromMeta({ layers: '1' })).toBeNull();
  });
  it('the catalog figure for the same model is within a quarter of the header’s', () => {
    const c = CATALOG.find((m) => m.id.startsWith('qwen3-4b'));
    if (c) expect(Math.abs(c.kv_mb_per_1k - 144) / 144).toBeLessThan(0.25);
  });
});

describe('the header over the stored figure', () => {
  const stored = { size: 2.5 * 1024 ** 3, kv_mb_per_1k: 32 };
  it('uses the header kv when there is one, else the stored one', () => {
    expect(fitInput(stored, 2048, qwen3_4b).kv_mb_per_1k).toBe(144);
    expect(fitInput(stored, 2048, null).kv_mb_per_1k).toBe(32);
    expect(fitInput(stored, 2048, { arch: 'x' }).kv_mb_per_1k).toBe(32);
  });
  it('changes the verdict: a guess that fits can be tight with the real cache', () => {
    const p = phone(3.3);
    const guess = fitOn(p, fitInput(stored, 4096, null));
    const real = fitOn(p, fitInput(stored, 4096, qwen3_4b));
    expect(needMb(fitInput(stored, 4096, qwen3_4b))).toBeGreaterThan(needMb(fitInput(stored, 4096, null)));
    expect(['fits', 'tight']).toContain(guess.verdict);
    expect(real.maxCtx).toBeLessThanOrEqual(guess.maxCtx);
  });
});

describe('the context suggestion', () => {
  const fit = (maxCtx: number): Fit => ({ needMb: 0, haveMb: 0, verdict: maxCtx ? 'fits' : 'no', maxCtx, tps: null });
  it('is the largest power of two that fits, within the model’s own limit and 8k', () => {
    expect(suggestCtx(fit(4096), 40960)).toBe(4096);
    expect(suggestCtx(fit(16384), 40960)).toBe(8192);
    expect(suggestCtx(fit(16384), 2048)).toBe(2048);
    expect(suggestCtx(fit(8192), 0)).toBe(8192);
  });
  it('still suggests 1k when nothing fits on paper, so the user can try', () => {
    expect(suggestCtx(fit(0), 40960)).toBe(1024);
    expect(suggestCtx(fit(0), 512)).toBe(512);
  });
});
