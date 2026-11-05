// The bench on the phone without a phone (5.11.2026): the json it writes matches
// tools/bench-schema.json (the copy in src/llm must equal it), the history is kept and
// capped, and a measured tok/s for a device and a mockModel replaces the bandwidth formula in
// fitOn / fitTogether / planSplit. The native module and the engine are fakes.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

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
jest.mock('@/lib/offline', () => ({ newId: () => 'id', remember: async (_g: string, _k: string, w: () => Promise<unknown>) => w(), must: async (q: Promise<{ data: unknown }>) => (await q).data, send: async () => ({}), outbox: () => {}, invalidate: () => {}, pendingJobs: () => [], useShelf: () => 0 }));

const mockPhone = { schema: 'passport/0.3', device: 'S25+', device_id: 'dev-s25', kind: 'phone', soc: 'Snapdragon 8 Elite', android: '15', ram_total_gb: 12, ram_free_gb: 6, app_mem_cap_mb: 512, cpu_cores: 8, cpu_max_ghz: 4.3, mem_bw_gbs: 60, mem_bw_read_gbs: 65.9, gflops: 100, storage_free_gb: 50, battery_pct: 80, charging: true, largest_model_q4: '~7B', est_tps: 10, measured_at: '2026-11-04T00:00:00Z', budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: 4, q4_k_m_b: 7, q3_k_s_b: 8, q8_0_b: 3 } };
jest.mock('@/data/passport', () => ({ lastPassport: () => mockPhone }));

// the native module: bandwidth, info, mockProbes that answer, a tunnel port
const mockProbes: string[] = [];
const mockNative = {
  info: async () => ({ available: true, abi: 'arm64-v8a', fastCores: 4, ramFreeMb: 5000, modelsDir: '/m', freeDiskMb: 1000, workerId: 'w-1', wifiIp: '10.0.0.2' }),
  memBandwidth: async (threads: number) => (threads === 0 ? 61.25 : 1),
  probePeer: async (host: string, port: number, _s: string, ch: string) => { mockProbes.push(`${host}:${port}:${ch}`); return port === 1 ? 'connect refused' : null; },
  apiTunnel: async () => 4321,
  addListener: () => ({ remove: () => {} }),
};
// a getter: the factory runs before the const above is assigned (jest hoists the mock)
jest.mock('@/llm/native', () => ({ get llama() { return mockNative; }, native: () => mockNative, hasNative: () => true, GATE_PORT: 50551 }));

// the engine: a loaded model in apart mode with one remote device; generation at fixed speeds
const mockModel = { id: 'qwen3-0.6b-q8', name: 'Qwen3 0.6B', file: 'Qwen3-0.6B-Q8_0.gguf', path: '/m/Qwen3-0.6B-Q8_0.gguf', size: 639 * 1024 * 1024, sha256: 'ab'.repeat(32), params_b: 0.6, quant: 'Q8_0', kv_mb_per_1k: 28, ctx_max: 32768, license: 'apache-2.0', source: 'catalog', url: 'https://x/y.gguf', added_at: 't' };
const mockEngine: any = { model: mockModel, mode: 'apart', loading: null, error: null, load: { loadMs: 2345, localLayers: 29, layers: 29, ctx: 2048, split: [] }, plan: null, split: [], devices: [{ id: 'me', name: 'S25+', local: true, busy: false }, { id: 'peer-mac', name: 'mac', local: false, busy: false, apiPort: 5555 }], generating: false };
const mockLocalCalls: any[] = [];
const mockRemoteCalls: any[] = [];
const mockReply = (tps: number, firstMs: number, device: string) => Object.assign(Promise.resolve({ tokens: 64, ms: 1000, firstMs, tps, stopped: false, device }), { stop: () => {} });
jest.mock('@/llm/engine', () => ({
  engine: () => mockEngine,
  chatLocal: (msgs: unknown, _on: unknown, opts: any) => { mockLocalCalls.push(opts); return mockReply(21 + mockLocalCalls.length * 0.1, 300, 'S25+'); },
  chatRemote: (dev: any, _m: unknown, _on: unknown, opts: any) => { mockRemoteCalls.push({ dev: dev.id, ...opts }); return mockReply(34, 120, dev.name); },
}));

import { benchHistory, benchLines, effectiveBw, forgetBench, KEEP, measuredTps, measuredTunnel, median, rememberBench, stat, type BenchResult } from '@/llm/bench';
import { validate } from '@/llm/benchschema';
import { BENCH_PROMPT, runPhoneBench, tunnelSpeed } from '@/llm/benchrun';
import { fitOn, fitTogether } from '@/llm/fit';
import { planSplit } from '@/llm/cluster';
import { rememberPeer, type Peer } from '@/llm/store';
import { COMBINE, type Passport } from '@/passport/contract';
import appSchema from '@/llm/bench-schema.json';

const sharedSchema = JSON.parse(readFileSync(join(__dirname, '../../../tools/bench-schema.json'), 'utf8'));
const mac: Peer = { id: 'peer-mac', name: 'mac', host: '10.0.0.3', port: 50551, secret: 'abcd1234abcd1234', kind: 'pc', ram: 16000, bw: 40, added_at: 't' };
const dead: Peer = { ...mac, id: 'peer-dead', name: 'dead', port: 1 };

const blob = (bytes: number, status = 200) => Object.assign(async () => ({ status, ok: status === 200, arrayBuffer: async () => new ArrayBuffer(bytes) }), {}) as unknown as typeof fetch;

describe('the schema', () => {
  it('is the same file on both sides', () => {
    expect(appSchema).toEqual(sharedSchema);
    expect(sharedSchema.$id).toBe('kula-bench/1');
  });
  it('median and stat', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(stat([10.26, 9.94])).toEqual({ median: 10.1, runs: [10.3, 9.9] });
  });
});

describe('the bench on the phone', () => {
  it('measures memory, this phone, the peers; skips with a reason; the json matches the schema and is remembered', async () => {
    const steps: string[] = [];
    const r = await runPhoneBench({ peers: [mac, dead], blobMb: 2, fetchImpl: blob(2 * 1024 * 1024), onStep: (s, who) => steps.push(who ? `${s}:${who}` : s) });
    expect(validate(sharedSchema, r)).toEqual([]);
    expect(steps).toEqual(['memory', 'local', 'peers:mac', 'peers:dead', 'done']);
    expect(r.tool).toBe('kula-app 1.0.0');
    expect(r.device).toEqual({ id: 'dev-s25', name: 'S25+', kind: 'phone', os: 'android 15', soc: 'Snapdragon 8 Elite', cores: 8, threads: 4, ram_total_mb: 12288, ram_free_mb: 5000, passport_bw_gbs: 65.9 });
    expect(r.memory).toEqual({ bandwidth_gbs: 61.25, method: 'native memBandwidth (copy on the fast cores)', threads: 4 });
    expect(r.model).toEqual({ name: 'Qwen3-0.6B-Q8_0.gguf', size_bytes: 639 * 1024 * 1024, ctx: 2048, sha256: 'ab'.repeat(32), params_b: 0.6, quant: 'Q8_0' });
    // warm up of 8 tokens, then 3 × 64 with the same prompt, temperature 0, fresh context
    expect(mockLocalCalls.map((c) => c.maxTokens)).toEqual([8, 64, 64, 64]);
    expect(mockLocalCalls.every((c) => c.temperature === 0 && c.reset === true)).toBe(true);
    expect(r.local).toEqual({ mode: 'apart', runs: 3, tokens_per_run: 64, gen_tps: { median: 21.3, runs: [21.2, 21.3, 21.4] }, first_token_ms: { median: 300, runs: [300, 300, 300] }, prompt_tps: null, prompt_tokens: null, load_ms: 2345 });
    // the peers: three api mockProbes each until one fails; the tunnel through the api port; apart on the device of this load
    expect(mockProbes.filter((p) => p.startsWith('10.0.0.3:50551'))).toEqual(['10.0.0.3:50551:api', '10.0.0.3:50551:api', '10.0.0.3:50551:api']);
    expect(mockProbes.filter((p) => p.startsWith('10.0.0.3:1'))).toEqual(['10.0.0.3:1:api']);
    const [m, d] = r.peers;
    expect(m.error).toBeNull();
    expect(m.gate_rtt_ms!.runs).toHaveLength(3);
    expect(m.tunnel!.bytes).toBe(2 * 1024 * 1024);
    expect(m.tunnel!.mb_per_s).toBeGreaterThan(0);
    expect(mockRemoteCalls.map((c) => `${c.dev}:${c.maxTokens}`)).toEqual(['peer-mac:8', 'peer-mac:64', 'peer-mac:64', 'peer-mac:64']);
    expect(m.apart).toEqual({ load_ms: null, runs: 3, tokens_per_run: 64, gen_tps: { median: 34, runs: [34, 34, 34] }, first_token_ms: { median: 120, runs: [120, 120, 120] } });
    expect(d).toEqual({ id: 'peer-dead', name: 'dead', kind: 'pc', gate_rtt_ms: null, tunnel: null, apart: null, error: 'connect refused' });
    expect(r.split).toBeNull();
    expect(r.skipped).toEqual([
      { what: 'split', who: null, why: 'the model runs in apart mode; load it split to measure that' },
      { what: 'peer', who: 'dead', why: 'connect refused' },
    ]);
    expect(r.notes[0]).toMatch(/prompt_tps null/);
    expect(benchHistory()[0].measured_at).toBe(r.measured_at);
    expect(BENCH_PROMPT.length).toBeGreaterThan(200);
    const lines = benchLines(r);
    expect(lines[0]).toBe('S25+ · android 15 · 12 gb');
    expect(lines).toContain('memory bw · 61.25 gb/s (passport 65.9)');
    expect(lines).toContain('apart · gen 21.3 tok/s · first token 300 ms (3×64)');
    expect(lines).toContain('mac · gate ' + m.gate_rtt_ms!.median + ' ms · tunnel ' + m.tunnel!.mb_per_s + ' mb/s · apart 34 tok/s · first 120 ms');
    expect(lines).toContain('dead · connect refused');
  });

  it('a peer without GET /blob keeps its gate time and is noted; a failing blob is a tunnel skip', async () => {
    expect(await tunnelSpeed(1, 1, blob(0, 404))).toBeNull();
    await expect(tunnelSpeed(1, 1, blob(0, 500))).rejects.toThrow('blob: http 500');
    const r = await runPhoneBench({ peers: [mac], fetchImpl: blob(0, 404) });
    expect(r.peers[0].tunnel).toBeNull();
    expect(r.peers[0].gate_rtt_ms).not.toBeNull();
    expect(r.skipped).toContainEqual({ what: 'tunnel', who: 'mac', why: 'the peer has no GET /blob (older build)' });
  });

  it('without a loaded model the speed parts are skipped and said, the rest measured', async () => {
    const saved = { ...mockEngine };
    Object.assign(mockEngine, { model: null, load: null, mode: 'alone', devices: [] });
    try {
      const r = await runPhoneBench({ peers: [mac], fetchImpl: blob(1024) });
      expect(validate(sharedSchema, r)).toEqual([]);
      expect(r.model).toBeNull();
      expect(r.local).toBeNull();
      expect(r.memory!.bandwidth_gbs).toBe(61.25);
      expect(r.peers[0].tunnel!.bytes).toBe(1024);
      expect(r.skipped.map((s) => `${s.what}:${s.why}`)).toEqual(['local:no model loaded: pick one under models and come back', 'split:no model loaded', 'apart:no model loaded']);
    } finally { Object.assign(mockEngine, saved); }
  });

  it('keeps the newest KEEP runs and forgets one by its time', () => {
    const base = benchHistory().find((r) => r.model && r.peers.length === 2)!; // the full run, so the planner tests below find it
    for (let i = 0; i < KEEP + 5; i++) rememberBench({ ...base, measured_at: `2026-11-06T00:00:${String(i).padStart(2, '0')}.000Z` });
    expect(benchHistory()).toHaveLength(KEEP);
    expect(benchHistory()[0].measured_at).toBe('2026-11-06T00:00:24.000Z');
    forgetBench('2026-11-06T00:00:24.000Z');
    expect(benchHistory()[0].measured_at).toBe('2026-11-06T00:00:23.000Z');
    expect(measuredTunnel('peer-mac')!.bytes).toBeGreaterThan(0);
    expect(measuredTunnel('nobody')).toBeNull();
  });
});

describe('the planner reads the measurements', () => {
  const m = { size: mockModel.size, kv_mb_per_1k: mockModel.kv_mb_per_1k, ctx: 2048, file: mockModel.file };
  const other = { ...m, file: 'Other-1B-Q4_K_M.gguf' };
  it('measuredTps: this phone by passport id and local, a peer by its id and apart; nothing for split runs or other models', () => {
    expect(measuredTps('dev-s25', mockModel.file)).toMatchObject({ tps: 21.3, first_token_ms: 300, mode: 'apart' });
    expect(measuredTps('peer-mac', mockModel.file)).toMatchObject({ tps: 34, mode: 'apart' });
    expect(measuredTps('dev-s25', 'Other-1B-Q4_K_M.gguf')).toBeNull();
    expect(measuredTps('peer-dead', mockModel.file)).toBeNull();
    expect(measuredTps(null, mockModel.file)).toBeNull();
    const base = benchHistory().find((r) => r.model && r.local)!;
    rememberBench({ ...base, measured_at: '2026-11-07T00:00:00.000Z', local: { ...base.local!, mode: 'split' }, peers: [] });
    expect(measuredTps('dev-s25', mockModel.file)!.tps).toBe(21.3); // the split run is passed over, the apart one before it counts
    forgetBench('2026-11-07T00:00:00.000Z');
  });
  it('fitOn: measured tok/s instead of bandwidth × 0.6 / size, flagged; the old estimate for an unmeasured model', () => {
    const measured = fitOn(mockPhone as Passport, m);
    expect(measured.measured).toBe(true);
    expect(measured.tps).toEqual({ low: 10.7, high: 21.3 });
    const guessed = fitOn(mockPhone as Passport, other);
    expect(guessed.measured).toBe(false);
    const gb = mockModel.size / 1024 ** 3;
    expect(guessed.tps!.high).toBe(Math.round(((65.9 * COMBINE.efficiency) / gb) * 10) / 10);
    expect(guessed.tps!.high).not.toBe(21.3);
    // a passport without an id: never measured
    expect(fitOn({ ...mockPhone, device_id: undefined } as Passport, m).measured).toBe(false);
  });
  it('effectiveBw: the bandwidth that explains the measured tok/s, the fallback otherwise', () => {
    const gb = mockModel.size / 1024 ** 3;
    expect(effectiveBw('dev-s25', mockModel.file, mockModel.size, 65.9)).toBe(Math.round(((21.3 * gb) / COMBINE.efficiency) * 100) / 100);
    expect(effectiveBw('dev-s25', 'Other-1B-Q4_K_M.gguf', mockModel.size, 65.9)).toBe(65.9);
    expect(effectiveBw('dev-s25', mockModel.file, 0, 65.9)).toBe(65.9);
  });
  it('fitTogether: a measured slow device drops behind an unmeasured fast one in the share order', () => {
    // on paper S25+ (65.9 GB/s) beats the pixel (30); measured at 21.3 tok/s on a 0.62 GB file it behaves like 22 GB/s, so the pixel is filled first
    const pixel = { ...mockPhone, device: 'Pixel', device_id: 'dev-pixel', mem_bw_read_gbs: 30, mem_bw_gbs: 30 } as Passport;
    const paper = fitTogether([mockPhone as Passport, pixel], other);
    expect(paper.measured).toBe(false);
    expect(paper.shares.map((s) => s.name)).toEqual(['S25+']);
    const real = fitTogether([mockPhone as Passport, pixel], m);
    expect(real.measured).toBe(true);
    expect(real.shares.map((s) => s.name)).toEqual(['Pixel']);
    expect(real.tps!.high).toBeLessThan(paper.tps!.high);
  });
  it('planSplit: shares follow the measured speed of this phone and the peer', async () => {
    rememberPeer(mac);
    const local = { ...mockModel, file: 'Other-1B-Q4_K_M.gguf', size: 1024 ** 3 };
    // unmeasured: 10 vs 40 GB/s → the mac takes four fifths
    const paper = await planSplit(local as any, 10000, 10, [mac], true);
    expect(paper.skipped).toEqual([]);
    expect(paper.used[0].assignedMb / paper.needMb).toBeCloseTo(0.8, 1);
    // measured with this mockModel: this phone 21.3 tok/s on 0.62 GB (≈ 22 GB/s), the mac 34 tok/s (≈ 35 GB/s) → closer to 3:5
    const real = await planSplit(mockModel as any, 10000, 10, [mac], true);
    const localBw = effectiveBw('dev-s25', mockModel.file, mockModel.size, 10);
    const macBw = effectiveBw('peer-mac', mockModel.file, mockModel.size, 40);
    expect(real.used[0].assignedMb / real.needMb).toBeCloseTo(macBw / (localBw + macBw), 1);
    expect(real.localMb / real.needMb).toBeCloseTo(localBw / (localBw + macBw), 1);
  });
});
