// The bench on the phone without a phone (5.11.2026): the native module, the peer's /blob
// and kv-store are faked at the edge. Every record must fit tools/bench-schema.json, the
// one kula-node bench writes too; a measured tok/s must reach fit.ts, the split planner,
// the apart dispatcher and the simulator.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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
jest.mock('@/data/passport', () => ({ lastPassport: () => ({ device: 'Galaxy S25+', mem_bw_read_gbs: 65.9, kind: 'phone' }), deviceId: () => 'dev-s25' }));
jest.mock('expo-device', () => ({ deviceType: 1, DeviceType: { TABLET: 2, DESKTOP: 3 }, osVersion: '15', totalMemory: 12e9, modelName: 'SM-S936B' }));

type Listener = (e: unknown) => void;
const mockListeners: Record<string, Set<Listener>> = { onToken: new Set(), onDone: new Set(), onPeerFound: new Set() };
const mockEmit = (ev: string, e: unknown) => mockListeners[ev].forEach((fn) => fn(e));
let mockGen = 0;
const mockGenTps = [30, 28, 33];
const mockCalls: string[] = [];
const mockNative = {
  addListener: (ev: string, fn: Listener) => {
    mockListeners[ev].add(fn);
    return { remove: () => mockListeners[ev].delete(fn) };
  },
  info: async () => ({ ramFreeMb: 5000, workerId: 'me', wifiIp: '10.0.0.2', fastCores: 6, abi: 'arm64-v8a' }),
  memBandwidth: async (threads: number) => { mockCalls.push(`bw:${threads}`); return 61.23; },
  loadModel: async () => { mockCalls.push('load'); return { loadMs: 10, localLayers: 26, layers: 26, ctx: 2048, split: [] }; },
  unload: async () => { mockCalls.push('unload'); },
  tokensUsed: () => 130 + 64,
  generate: () => {
    const id = ++mockGen;
    const tps = mockGenTps[(id - 1) % 3];
    setTimeout(() => mockEmit('onDone', { id, tokens: 64, ms: 300 + (64 / tps) * 1000, firstMs: 300, tps, stopped: false, error: null }), 1);
    return id;
  },
  probePeer: async (host: string) => (host === '10.0.0.9' ? 'connect timeout' : null),
  apiTunnel: async () => 4321,
  closeTunnels: async () => { mockCalls.push('closeTunnels'); },
  workerStatus: async () => ({ state: 'stopped' }),
};
jest.mock('@/llm/native', () => ({ native: () => mockNative, hasNative: () => true, get llama() { return mockNative; } }));

import { readFileSync } from 'fs';
import { join } from 'path';
import { runPhoneBench } from '@/bench/run';
import { benchHistory, MAX_BENCH, measuredFor, saveBench } from '@/bench/store';
import { measuredTps, series, validate, type BenchRecord } from '@/bench/core';
import { fitOn } from '@/llm/fit';
import { engine, load, unload } from '@/llm/engine';
import { asLocal, DEVICES, effFromTps, estimateAlone, modelById, planShares, withMeasured, NETWORKS } from '@/llm/sim';
import { CATALOG } from '@/llm/catalog';
import { describe as describeModel, type LocalModel, type Peer } from '@/llm/store';

const schema = JSON.parse(readFileSync(join(__dirname, '../../../tools/bench-schema.json'), 'utf8'));
const cat = CATALOG.find((m) => m.id === 'gemma3-1b-q4')!;
const gemma: LocalModel = { ...describeModel(cat), path: '/data/models/g.gguf', added_at: 't' };
const peer = (id: string, host: string): Peer => ({ id, name: id, host, port: 50551, secret: 'aa'.repeat(16), kind: 'phone', ram: 3000, bw: 20, added_at: 't' });

const blobFetch = jest.fn(async (url: string) => {
  const mb = Number(/mb=(\d+)/.exec(url)![1]);
  return { ok: true, status: 200, blob: async () => ({ size: mb * 1024 * 1024 }) };
});
(globalThis as unknown as { fetch: unknown }).fetch = blobFetch;

beforeEach(() => {
  mockStore.clear();
  mockCalls.length = 0;
});

describe('the bench on this phone', () => {
  it('measures bandwidth, 64 tokens × 3 alone, the gate and the tunnel; the record fits the schema', async () => {
    const steps: string[] = [];
    const r = await runPhoneBench(gemma, [peer('pixel', '10.0.0.5'), peer('gone', '10.0.0.9')], { onStep: (s) => steps.push(s), now: () => new Date('2026-11-05T09:00:00Z') });
    expect(validate(schema, r)).toEqual([]);
    expect(r.source).toBe('app');
    expect(r.device).toMatchObject({ id: 'dev-s25', name: 'Galaxy S25+', kind: 'phone', threads: 6, ram_free_mb: 5000 });
    expect(r.model).toEqual({ id: 'gemma3-1b-q4', file: gemma.file, size_bytes: gemma.size, quant: gemma.quant, layers: 26 });
    expect(r.local.mem_bw_gbs).toBe(61.2);
    expect(r.local.gen).toEqual({ unit: 'tok/s', runs: [30, 28, 33], median: 30, tokens: 64 });
    // 130 prompt tokens in the 300 ms before the first token
    expect(r.local.prompt?.median).toBeCloseTo(433.3, 1);
    expect(r.local.prompt?.tokens).toBe(130);
    expect(r.local.first_token_ms?.median).toBe(300);
    const [pixel, gone] = r.peers;
    expect(pixel).toMatchObject({ id: 'pixel', loopback: false, tunnel_mb: 10, error: null });
    expect(pixel.gate_rtt_ms?.runs).toHaveLength(3);
    expect(pixel.tunnel_mb_s).toBeGreaterThan(0);
    expect(gone).toMatchObject({ id: 'gone', gate_rtt_ms: null, tunnel_mb_s: null, error: 'connect timeout' });
    expect(blobFetch).toHaveBeenCalledWith('http://127.0.0.1:4321/blob?mb=10');
    expect(mockCalls).toEqual(['bw:6', 'load', 'unload', 'closeTunnels']);
    expect(steps[0]).toBe('bw');
    expect(steps.at(-1)).toBe('done');
    expect(r.skipped.map((s) => s.what).sort()).toEqual(['apart', 'split']);
  });

  it('without a model, peers or sharing: memory only, the rest skipped with a reason', async () => {
    const r = await runPhoneBench(null, []);
    expect(validate(schema, r)).toEqual([]);
    expect(r.model).toBeNull();
    expect(r.local.gen).toBeNull();
    expect(r.peers).toEqual([]);
    expect(r.skipped.map((s) => s.what)).toEqual(expect.arrayContaining(['model', 'gate', 'tunnel']));
  });

  it('does not touch a model loaded in another mode', async () => {
    await load(gemma, 'alone', 2048, []);
    const other = { ...gemma, id: 'other' };
    const r = await runPhoneBench(other, []);
    expect(r.local.gen).toBeNull();
    expect(r.skipped.find((s) => s.what === 'gen')?.why).toMatch(/unload it first/);
    expect(engine().model?.id).toBe('gemma3-1b-q4');
    await unload();
  });

  it('history: newest first, at most MAX_BENCH, read back by device and model', () => {
    const rec = (i: number, tps: number): BenchRecord => ({
      v: 1, kind: 'kula-bench', at: `2026-11-05T09:${String(i).padStart(2, '0')}:00.000Z`, source: 'app',
      device: { id: 'dev-s25', name: 's25', kind: 'phone', os: 'android 15', ram_total_mb: 1, ram_free_mb: 1 },
      model: { id: 'gemma3-1b-q4', file: gemma.file, size_bytes: gemma.size, quant: 'Q4_K_M' },
      local: { mem_bw_gbs: 60, prompt: null, gen: series('tok/s', [tps]), first_token_ms: null },
      peers: [{ id: 'pixel', name: 'pixel', loopback: false, gate_rtt_ms: null, tunnel_mb_s: 9, tunnel_mb: 10, apart: { gen: series('tok/s', [tps / 2]), first_token_ms: null }, error: null }],
      split: null, skipped: [],
    });
    for (let i = 0; i < MAX_BENCH + 5; i++) saveBench(rec(i, 10 + i));
    const h = benchHistory();
    expect(h).toHaveLength(MAX_BENCH);
    expect(h[0].at > h[1].at).toBe(true);
    expect(measuredFor('self', { id: 'gemma3-1b-q4' })).toBe(10 + MAX_BENCH + 4);
    expect(measuredFor('pixel', { id: 'x', file: gemma.file, size: gemma.size })).toBe((10 + MAX_BENCH + 4) / 2);
    expect(measuredFor('self', { id: 'qwen3-0.6b-q8' })).toBeNull();
    expect(measuredTps(h, 'nobody', { id: 'gemma3-1b-q4' })).toBeNull();
  });
});

describe('a measured tok/s replaces the estimate', () => {
  it('fit.ts: the measured number, flagged; without one the bandwidth estimate', () => {
    const p = { device: 'S25+', mem_bw_read_gbs: 65.9, ram_free_gb: 6 } as never;
    const est = fitOn(p, { size: gemma.size, kv_mb_per_1k: gemma.kv_mb_per_1k, ctx: 2048 });
    const got = fitOn(p, { size: gemma.size, kv_mb_per_1k: gemma.kv_mb_per_1k, ctx: 2048 }, 31.4);
    expect(est.measured).toBe(false);
    expect(got.measured).toBe(true);
    expect(got.tps?.high).toBe(31.4);
    expect(got.tps?.high).not.toBe(est.tps?.high);
    expect(fitOn(p, { size: gemma.size, kv_mb_per_1k: gemma.kv_mb_per_1k, ctx: 2048 }, null).tps).toEqual(est.tps);
  });

  it('the simulator: withMeasured makes estimateAlone give back the measured tok/s', () => {
    const q06 = modelById('qwen3-0.6b-q8')!;
    const mac = asLocal(DEVICES.macm1);
    expect(estimateAlone(q06, withMeasured(mac, q06, 34)).tps).toBe(34);
    expect(withMeasured(mac, q06, null)).toBe(mac);
    expect(withMeasured(mac, q06, 0)).toBe(mac);
    expect(effFromTps(q06, 68, 34)).toBeCloseTo(0.31, 2); // the 0.3 the profiles carry for the mac
    // a slow measured worker makes the split no better than with its optimistic estimate
    const w = { id: 'w', capMb: 4000, bw: 65.9, eff: 0.6 };
    const fast = planShares({ model: q06, ctx: 2048, local: mac, workers: [w], net: NETWORKS.wifi5, share: true });
    const slow = planShares({ model: q06, ctx: 2048, local: mac, workers: [withMeasured(w, q06, 4)], net: NETWORKS.wifi5, share: true });
    expect(slow.est.perTokenMs).toBeGreaterThanOrEqual(fast.est.perTokenMs);
  });

  it('the engine: a loaded device starts from its measured speed', async () => {
    mockStore.set('bench.history', JSON.stringify([{
      v: 1, kind: 'kula-bench', at: '2026-11-05T09:00:00.000Z', source: 'app',
      device: { id: 'dev-s25', name: 's25', kind: 'phone', os: 'android 15', ram_total_mb: 1, ram_free_mb: 1 },
      model: { id: gemma.id, file: gemma.file, size_bytes: gemma.size, quant: 'Q4_K_M' },
      local: { mem_bw_gbs: 60, prompt: null, gen: series('tok/s', [27.5]), first_token_ms: null }, peers: [], split: null, skipped: [],
    }]));
    await load(gemma, 'alone', 2048, []);
    expect(engine().devices[0].tps).toBe(27.5);
    await unload();
    mockStore.delete('bench.history');
    await load(gemma, 'alone', 2048, []);
    expect(engine().devices[0].tps).not.toBe(27.5);
    await unload();
  });
});
