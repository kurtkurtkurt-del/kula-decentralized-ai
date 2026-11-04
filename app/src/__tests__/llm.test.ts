// The models layer without a phone: the catalog's shape, the fit arithmetic, the split
// planner's shares, and the peer qr. The native module is absent here (as in Expo Go), so
// everything that needs it is mocked at the edge.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';

const mockStore = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItemSync: (k: string) => mockStore.get(k) ?? null,
    setItemSync: (k: string, v: string) => mockStore.set(k, v),
    removeItemSync: (k: string) => mockStore.delete(k),
    getAllKeysSync: () => [...mockStore.keys()],
  },
}));
jest.mock('expo-device', () => ({ deviceType: 1, DeviceType: { TABLET: 2, DESKTOP: 3 }, osVersion: '15', totalMemory: 8e9 }));
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/offline', () => ({ newId: () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2), remember: async (_g: string, _k: string, w: () => Promise<unknown>) => w(), must: async (q: Promise<{ data: unknown }>) => (await q).data, send: async () => ({}), outbox: () => {}, invalidate: () => {}, pendingJobs: () => [], useShelf: () => 0 }));

import { CATALOG } from '@/llm/catalog';
import { fitOn, fitTogether, needMb, haveMb } from '@/llm/fit';
import { probeAll } from '@/llm/cluster';
import { isPeerQr, takePeerQr } from '@/llm/peers';
import { peers } from '@/llm/store';
import type { Passport } from '@/passport/contract';

const phone = (over: Partial<Passport> = {}): Passport => ({
  schema: 'passport/0.3', device: 'Pixel 6a', soc: 'Tensor', android: '15', ram_total_gb: 6, ram_free_gb: 3.2, app_mem_cap_mb: 512,
  cpu_cores: 8, cpu_max_ghz: 2.8, mem_bw_gbs: 14, gflops: 40, storage_free_gb: 20, battery_pct: 80, charging: true,
  largest_model_q4: '~3B', est_tps: 6, measured_at: '2026-11-04T00:00:00Z', device_id: 'dev-1', kind: 'phone', mem_bw_read_gbs: 18,
  budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: 2.1, q4_k_m_b: 3, q3_k_s_b: 4, q8_0_b: 1 }, ...over,
});

describe('the catalog', () => {
  it('has verified single files with a checksum, a size and an https url', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(8);
    const ids = new Set<string>();
    for (const m of CATALOG) {
      expect(ids.has(m.id)).toBe(false);
      ids.add(m.id);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.size).toBeGreaterThan(100e6);
      expect(m.file.endsWith('.gguf')).toBe(true);
      expect(m.file).not.toMatch(/-of-/);
      expect(m.kv_mb_per_1k).toBeGreaterThan(0);
      expect(m.blurb.tr && m.blurb.de && m.blurb.en).toBeTruthy();
    }
  });
});

describe('fit', () => {
  const small = CATALOG.find((m) => m.id === 'qwen3-0.6b-q8')!;
  const big = CATALOG.find((m) => m.id === 'qwen2.5-7b-q4')!;
  it('needs more than the file and less than twice it at 2k context', () => {
    const mb = needMb({ size: small.size, kv_mb_per_1k: small.kv_mb_per_1k, ctx: 2048 });
    expect(mb).toBeGreaterThan(small.size / 1048576);
    expect(mb).toBeLessThan((small.size / 1048576) * 2);
  });
  it('reads the budget when the passport has one, free ram otherwise', () => {
    expect(haveMb(phone())).toBe(Math.round(2.1 * 1024));
    expect(haveMb(phone({ budget: undefined, ram_free_gb: 3 }))).toBe(Math.round(3 * 1024 * 0.8));
    expect(haveMb(null)).toBe(0);
  });
  it('a 0.6B fits a 6 gb phone, a 7B does not, and together two phones hold more', () => {
    const f = fitOn(phone(), { size: small.size, kv_mb_per_1k: small.kv_mb_per_1k, ctx: 2048 });
    expect(f.verdict).toBe('fits');
    expect(f.maxCtx).toBeGreaterThanOrEqual(2048);
    expect(f.tps!.high).toBeGreaterThan(f.tps!.low);
    const b = fitOn(phone(), { size: big.size, kv_mb_per_1k: big.kv_mb_per_1k, ctx: 2048 });
    expect(b.verdict).toBe('no');
    const t = fitTogether([phone(), phone({ device: 'S24', device_id: 'dev-2', budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: 4, q4_k_m_b: 7, q3_k_s_b: 8, q8_0_b: 3 } })], { size: big.size, kv_mb_per_1k: big.kv_mb_per_1k, ctx: 2048 });
    expect(t.haveMb).toBeGreaterThan(b.haveMb);
    expect(t.shares.length).toBe(2);
    expect(t.shares.map((s) => s.name).sort()).toEqual(['Pixel 6a', 'S24']);
  });
});

describe('the planner without a phone', () => {
  it('skips every peer as nonative instead of handing llama an unreachable endpoint', async () => {
    const r = await probeAll([{ id: 'p', name: 'x', host: '10.0.0.9', port: 50551, secret: 'a'.repeat(64), kind: 'phone', ram: 3000, bw: 10, added_at: '' }]);
    expect(r.ok).toEqual([]);
    expect(r.bad[0].why).toBe('nonative');
  });
});

describe('the peer qr', () => {
  const qr = { k: 'kula-peer', v: 2, id: 'w-1', name: 'MacBook', host: '192.168.1.5', port: 50551, secret: 'ab'.repeat(32), kind: 'pc', ram: 16000, bw: 60 };
  it('tells a peer code from a passport code', () => {
    expect(isPeerQr(JSON.stringify(qr))).toBe(true);
    expect(isPeerQr(JSON.stringify(phone()))).toBe(false);
    expect(isPeerQr('hello')).toBe(false);
  });
  it('remembers the peer, newest first, once per id', () => {
    takePeerQr(JSON.stringify(qr));
    takePeerQr(JSON.stringify({ ...qr, host: '192.168.1.6' }));
    expect(peers().filter((p) => p.id === 'w-1')).toHaveLength(1);
    expect(peers()[0].host).toBe('192.168.1.6');
    expect(peers()[0].kind).toBe('pc');
  });
  it('refuses what it should', () => {
    expect(() => takePeerQr('{}')).toThrow('notPeer');
    expect(() => takePeerQr(JSON.stringify({ ...qr, v: 1 }))).toThrow('old');
    expect(() => takePeerQr(JSON.stringify({ ...qr, secret: 'short' }))).toThrow('notPeer');
  });
});
