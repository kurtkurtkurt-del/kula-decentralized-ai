// The split planner against a mockGate gate (5.11.2026): which peers are handed to llama.cpp
// and how much each carries. The native module is a mockGate whose probePeer answers per host,
// whose discover() can "find" a moved peer again, and whose clock is jest's.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

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

type Found = { serviceName: string; name: string; host: string | null; port: number; id: string | null; ram: number | null; bw: number | null; kind: string; v: string | null };
const mockGate = {
  answers: {} as Record<string, string | null>, // host → probe answer (null = ok)
  found: [] as Found[],                          // what discover(true) announces
  probes: [] as string[],
  listeners: new Set<(f: Found) => void>(),
  probePeer: async (host: string, _port: number, _secret: string, channel: string) => {
    mockGate.probes.push(`${host}/${channel}`);
    return host in mockGate.answers ? mockGate.answers[host] : 'refused';
  },
  addListener: (_ev: string, fn: (f: Found) => void) => {
    mockGate.listeners.add(fn);
    return { remove: () => mockGate.listeners.delete(fn) };
  },
  discover: async (on: boolean) => {
    if (on) setTimeout(() => mockGate.found.forEach((f) => mockGate.listeners.forEach((fn) => fn(f))), 10);
  },
};
// getters: the factory runs when cluster.ts is first required, above the const
jest.mock('@/llm/native', () => ({ get llama() { return mockGate; }, native: () => mockGate, hasNative: () => true, GATE_PORT: 50551 }));

import { LOCAL_SHARE, WORKER_SHARE, peerArgs, planSplit, probeAll, relocate, splitSummary } from '@/llm/cluster';
import { peers, rememberPeer, type LocalModel, type Peer } from '@/llm/store';

const MB = 1024 * 1024;
const model = (mb: number): LocalModel => ({ id: 'm', name: 'm', file: 'm.gguf', path: '/m.gguf', size: mb * MB, sha256: null, params_b: 1, quant: 'q4', kv_mb_per_1k: 10, ctx_max: 4096, license: null, source: 'catalog', url: '', added_at: '' });
const peer = (id: string, host: string, ram: number, bw: number): Peer => ({ id, name: id, host, port: 50551, secret: 'a'.repeat(64), kind: 'phone', ram, bw, added_at: '' });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

beforeEach(() => {
  jest.useFakeTimers();
  mockGate.answers = {};
  mockGate.found = [];
  mockGate.probes = [];
  mockGate.listeners.clear();
  mockStore.clear();
});
afterEach(() => {
  jest.useRealTimers();
});

// planSplit waits up to 4 s of discovery for each dead peer: run the clock along with it
const plan = async (...args: Parameters<typeof planSplit>) => {
  const p = planSplit(...args);
  p.catch(() => {}); // a toobig thrown before the clock moves is still awaited below
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(1000);
  return p;
};

describe('probeAll', () => {
  it('splits the answered from the refused and stamps last_ok on the answered', async () => {
    rememberPeer(peer('a', '10.0.0.1', 3000, 10));
    mockGate.answers = { '10.0.0.1': null };
    const r = await probeAll([peer('a', '10.0.0.1', 3000, 10), peer('b', '10.0.0.2', 3000, 10)], 'api');
    expect(r.ok.map((p) => p.id)).toEqual(['a']);
    expect(r.bad).toEqual([{ peer: expect.objectContaining({ id: 'b' }), why: 'refused' }]);
    expect(mockGate.probes.sort()).toEqual(['10.0.0.1/api', '10.0.0.2/api']);
    expect(peers()[0].last_ok).toBeTruthy();
  });
  it('turns a thrown probe into a reason', async () => {
    mockGate.probePeer = async () => { throw new Error('timeout'); };
    const r = await probeAll([peer('a', '10.0.0.1', 3000, 10)]);
    expect(r.bad[0].why).toBe('timeout');
    mockGate.probePeer = async (host: string, _p: number, _s: string, channel: string) => { mockGate.probes.push(`${host}/${channel}`); return host in mockGate.answers ? mockGate.answers[host] : 'refused'; };
  });
});

describe('relocate', () => {
  it('finds a peer again by id and keeps the new address', async () => {
    rememberPeer(peer('a', '10.0.0.1', 3000, 10));
    mockGate.found = [{ serviceName: 'x', name: 'a', host: '10.0.0.9', port: 50552, id: 'a', ram: 3500, bw: null, kind: 'phone', v: '1' }];
    const p = relocate(peer('a', '10.0.0.1', 3000, 10), 500);
    await jest.advanceTimersByTimeAsync(50);
    const moved = await p;
    expect(moved).toMatchObject({ host: '10.0.0.9', port: 50552, ram: 3500, bw: 10 });
    expect(peers()[0].host).toBe('10.0.0.9');
    expect(mockGate.listeners.size).toBe(0);
  });
  it('gives up after the wait when nothing with that id shows up', async () => {
    mockGate.found = [{ serviceName: 'x', name: 'b', host: '10.0.0.9', port: 50551, id: 'b', ram: null, bw: null, kind: 'phone', v: '1' }];
    const p = relocate(peer('a', '10.0.0.1', 3000, 10), 500);
    await jest.advanceTimersByTimeAsync(600);
    expect(await p).toBeNull();
    expect(mockGate.listeners.size).toBe(0);
  });
});

describe('planSplit', () => {
  // The numbers come from the planner's model (sim/model.ts, its own tests in sim.test.ts);
  // here the rules it must keep whatever the formula: the shares add up to the need, the
  // output layer stays on this phone, the fastest leads, dead peers are left out with a reason.
  const total = (r: Awaited<ReturnType<typeof plan>>) => r.localMb + sum(r.used.map((u) => u.assignedMb));
  it('with no peers keeps everything here when it fits, and says so', async () => {
    const r = await plan(model(1000), 4000, 20, [], false);
    expect(r.fitsAlone).toBe(true);
    expect(r.needMb).toBeGreaterThan(1000);
    expect(r.localMb).toBe(r.needMb);
    expect(r.used).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(mockGate.probes).toEqual([]);
  });
  it('with no peers throws toobig when this phone cannot hold it', async () => {
    await expect(plan(model(4000), 4000, 20, [], false)).rejects.toThrow('toobig');
  });
  it('with one answering peer and a model that does not fit here, shares it and keeps the output layer here', async () => {
    mockGate.answers = { '10.0.0.1': null };
    const r = await plan(model(1000), 1000, 5, [peer('a', '10.0.0.1', 3000, 30)], false);
    expect(r.fitsAlone).toBe(false);
    expect(r.used.map((p) => p.id)).toEqual(['a']);
    expect(r.localMb).toBeGreaterThan(0);
    expect(r.localMb).toBeLessThanOrEqual(Math.round(1000 * LOCAL_SHARE));
    expect(total(r)).toBe(r.needMb);
  });
  it('leaves out the peers that are not needed', async () => {
    mockGate.answers = { '10.0.0.1': null, '10.0.0.2': null };
    const r = await plan(model(1000), 1000, 1, [peer('a', '10.0.0.1', 4000, 30), peer('b', '10.0.0.2', 4000, 20)], false);
    expect(r.used.map((p) => p.id)).toEqual(['a']); // a alone holds what this phone cannot
    expect(total(r)).toBe(r.needMb);
  });
  it('skips an unreachable peer with its reason, and plans with the rest', async () => {
    mockGate.answers = { '10.0.0.1': null, '10.0.0.2': 'NO wrong secret' };
    const r = await plan(model(1000), 1000, 5, [peer('a', '10.0.0.1', 3000, 30), peer('b', '10.0.0.2', 3000, 40)], false);
    expect(r.used.map((p) => p.id)).toEqual(['a']);
    expect(r.skipped).toEqual([expect.objectContaining({ peer: expect.objectContaining({ id: 'b' }), why: 'NO wrong secret' })]);
    expect(peerArgs(r)).toEqual([expect.objectContaining({ host: '10.0.0.1', port: 50551, secret: 'a'.repeat(64), weight: r.used[0].assignedMb })]);
  });
  it('throws toobig when the only peer big enough is unreachable', async () => {
    await expect(plan(model(1000), 1000, 5, [peer('a', '10.0.0.1', 8000, 30)], false)).rejects.toThrow('toobig');
  });
  it('finds a moved peer again and uses it at its new address', async () => {
    mockGate.answers = { '10.0.0.9': null };
    mockGate.found = [{ serviceName: 'x', name: 'a', host: '10.0.0.9', port: 50551, id: 'a', ram: null, bw: null, kind: 'phone', v: '1' }];
    const r = await plan(model(1000), 1000, 5, [peer('a', '10.0.0.1', 3000, 30)], false);
    expect(r.skipped).toEqual([]);
    expect(r.used[0]).toMatchObject({ id: 'a', host: '10.0.0.9' });
  });
  it('shares when asked to although it fits here, each side within its capacity', async () => {
    mockGate.answers = { '10.0.0.1': null };
    const r = await plan(model(1000), 4000, 30, [peer('a', '10.0.0.1', 1000, 10)], true);
    expect(r.fitsAlone).toBe(true);
    expect(r.used).toHaveLength(1);
    expect(r.localMb).toBeGreaterThan(r.used[0].assignedMb); // this phone is the faster one
    expect(r.used[0].assignedMb).toBeLessThanOrEqual(Math.round(1000 * WORKER_SHARE));
    expect(total(r)).toBe(r.needMb);
    // a peer whose share would overflow its capacity: the overflow stays here
    const r2 = await plan(model(2000), 8000, 10, [peer('a', '10.0.0.1', 400, 30)], true);
    expect(r2.used[0].assignedMb).toBeLessThanOrEqual(300); // 400 × 0.75
    expect(total(r2)).toBe(r2.needMb);
  });
  it('keeps everything here when it fits and sharing was not asked for', async () => {
    mockGate.answers = { '10.0.0.1': null };
    const r = await plan(model(1000), 4000, 30, [peer('a', '10.0.0.1', 1000, 10)], false);
    expect(r.used).toEqual([]);
    expect(r.localMb).toBe(r.needMb);
    expect(peerArgs(r)).toEqual([]);
  });
  it('defaults an unknown bandwidth and an unknown ram (2000 mb)', async () => {
    mockGate.answers = { '10.0.0.1': null };
    const r = await plan(model(1000), 2000, 0, [{ ...peer('a', '10.0.0.1', 0, 0), ram: null, bw: null }], true);
    expect(r.used).toHaveLength(1);
    expect(r.used[0].assignedMb).toBeLessThanOrEqual(2000 * WORKER_SHARE);
    expect(total(r)).toBe(r.needMb);
    expect(r.totalMb).toBe(Math.round(2000 * LOCAL_SHARE + 2000 * WORKER_SHARE));
  });
});

describe('splitSummary', () => {
  it('adds the buffers up per device, this phone unnamed, biggest first, in tenths of a gb', () => {
    const names = new Map([['127.0.0.1:4001', 'tablet']]);
    const out = splitSummary([
      { buffer: 'CPU', mb: 300 }, { buffer: 'CPU_Mapped', mb: 200 },
      { buffer: 'RPC0[127.0.0.1:4001]', mb: 1024 }, { buffer: 'RPC0[127.0.0.1:4001]', mb: null },
      { buffer: 'RPC1[127.0.0.1:4002]', mb: 100 },
    ], names, 'this phone');
    expect(out).toEqual([{ name: 'tablet', gb: 1 }, { name: 'this phone', gb: 0.5 }, { name: '127.0.0.1:4002', gb: 0.1 }]);
  });
});
