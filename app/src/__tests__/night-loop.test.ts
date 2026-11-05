// The night's loop at its edges (5.11.2026), beyond night.test.ts: a device that drops
// in the middle of a unit (the unit goes back to the front of the pile and the next
// device takes it), a source that throws, stop() while the model is still loading, a
// start() during a night (the old loops die), a load that fails (the night ends on its
// own), the known-answer check against what models really say, and the simulation's
// clock. The engine is a fake with two devices whose behaviour each test chooses.
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
jest.mock('@/data/passport', () => ({ lastPassport: () => null }));
const mockScreen = { on: [] as boolean[] };
jest.mock('@/llm/native', () => ({ llama: { keepScreenOn: async (on: boolean) => { mockScreen.on.push(on); } }, hasNative: () => true, native: () => { throw new Error('nonative'); } }));
const model = { id: 'm', name: 'tiny', file: 'tiny.gguf', path: '/m/tiny.gguf', size: 500e6, sha256: null, params_b: 0.6, quant: 'q8', kv_mb_per_1k: 28, ctx_max: 4096, license: null, source: 'catalog', url: '', added_at: '' };
const mockModels = { list: [model], chosen: 'm' as string | null, peers: [] as unknown[] };
jest.mock('@/llm/store', () => ({
  settings: () => ({ modelId: mockModels.chosen, ctx: 2048, temperature: 0.7, maxTokens: 512, lastMode: 'alone' }),
  localById: (id: string) => mockModels.list.find((m) => m.id === id) ?? null,
  localModels: () => mockModels.list,
  peers: () => mockModels.peers,
}));

// the fake engine: chat answers after `delay` ms with whatever behave() says; a pending
// call can be failed from outside (the device dropped) or stopped by the worker
type Pending = { dev: string; unit: string; resolve: (r: { text: string; tokens: number }) => void; reject: (e: Error) => void };
const fake = {
  behave: ((_dev: string, _prompt: string) => ({ text: 'positive', tokens: 3 })) as (dev: string, prompt: string) => { text: string; tokens: number } | Error | 'hang',
  calls: [] as { dev: string; unit: string }[],
  pending: [] as Pending[],
  stopped: [] as string[],
  loadFails: false,
  loadMs: 0,
  loadWait: null as Promise<void> | null,
  loads: 0,
  unloads: 0,
};
const devices = [{ id: 'me', name: 'this phone', local: true, busy: false }, { id: 'p1', name: 'tablet', local: false, busy: false }];
jest.mock('@/llm/engine', () => ({
  load: async () => {
    fake.loads++;
    if (fake.loadMs) await new Promise((r) => setTimeout(r, fake.loadMs));
    if (fake.loadWait) await fake.loadWait;
    if (fake.loadFails) throw new Error('toobig');
  },
  unload: async () => { fake.unloads++; },
  engine: () => ({ devices }),
  chat: (messages: { content: string }[], onToken: (t: string) => void, opts: { device: string }) => {
    const unit = messages[1].content;
    fake.calls.push({ dev: opts.device, unit });
    const p = new Promise<{ tokens: number; ms: number; firstMs: number; tps: number; stopped: boolean; device: string }>((resolve, reject) => {
      const pend: Pending = { dev: opts.device, unit, resolve: (r) => { onToken(r.text); resolve({ tokens: r.tokens, ms: 10, firstMs: 5, tps: 100, stopped: false, device: opts.device }); }, reject };
      setTimeout(() => {
        const r = fake.behave(opts.device, unit);
        if (r === 'hang') { fake.pending.push(pend); return; }
        if (r instanceof Error) return reject(r);
        pend.resolve(r);
      }, 1);
    }) as Promise<unknown> & { stop: () => void };
    p.stop = () => fake.stopped.push(opts.device);
    return p;
  },
}));

import { DemoJobs, checkAnswer, storedResults, type JobSource, type Unit } from '@/night/jobs';
import { LlamaWorker, pickModel } from '@/night/LlamaWorker';
import { SimulatedWorker, inWindow, work } from '@/night/SimulatedWorker';

const unit = (i: number, expected?: string): Unit => ({ id: `u${i}`, type: 'classify', prompt: `u${i}`, maxTokens: 4, ...(expected ? { expected } : {}) });
const units = (n: number) => Array.from({ length: n }, (_, i) => unit(i + 1));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
// waits for what a test is about to check instead of a fixed sleep: a loaded machine (the
// whole suite at once) can take longer than 10 ms for a few promise hops
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(2);
};
let clock = 1_000_000;
const make = (list: Unit[] | JobSource) => new LlamaWorker({ source: () => (Array.isArray(list) ? new DemoJobs(list) : list), now: () => clock, idleMs: 2 });

beforeEach(() => {
  fake.calls = [];
  fake.pending = [];
  fake.stopped = [];
  fake.behave = () => ({ text: 'positive', tokens: 3 });
  fake.loadFails = false;
  fake.loadMs = 0;
  fake.loadWait = null;
  fake.loads = 0;
  fake.unloads = 0;
  mockModels.chosen = 'm';
  mockModels.list = [model];
  mockModels.peers = [];
  mockScreen.on = [];
  mockStore.clear();
  clock = 1_000_000;
});

describe('a device that drops mid-unit', () => {
  it('puts the unit back at the front, the other device does it next, the dropped one is out', async () => {
    // the tablet hangs on its first unit; the phone answers at once
    fake.behave = (dev) => (dev === 'p1' ? 'hang' : { text: 'ok', tokens: 1 });
    const w = make(units(4));
    w.start('beyin', 5);
    await until(() => fake.pending.length === 1 && fake.calls.filter((c) => c.dev === 'me').length === 3);
    expect(fake.pending.map((p) => `${p.dev}:${p.unit}`)).toEqual(['p1:u2']);
    // the phone has meanwhile taken u1, u3, u4 and found the pile empty
    expect(fake.calls.filter((c) => c.dev === 'me').map((c) => c.unit)).toEqual(['u1', 'u3', 'u4']);
    expect(w.status().state).toBe('running'); // waits for the tablet's unit
    // now the tablet's socket dies
    fake.pending[0].reject(new Error('peer gone'));
    await until(() => !!w.status().devices?.find((d) => d.id === 'p1')?.out);
    // u2 went back to the pile. Whether the phone's loop was still looking (it takes u2) or had
    // already ended (nobody does: the tablet is out) depends on timing; both are right. What
    // must hold: the tablet is out, u2 is never counted for it, and nothing is done twice.
    await w.settled();
    const s = w.status();
    expect(s.devices!.find((d) => d.id === 'p1')!.out).toBe(true);
    const done = storedResults().map((r) => r.id).sort();
    expect([['u1', 'u3', 'u4'], ['u1', 'u2', 'u3', 'u4']]).toContainEqual(done);
    expect(s.units).toBe(done.length);
    expect(fake.calls.filter((c) => c.dev === 'p1').map((c) => c.unit)).toEqual(['u2']);
    expect(w.status().state).toBe('done');
  });
  it('hands the unit to the other device when the pile is not yet empty', async () => {
    let hung = false;
    fake.behave = (dev) => {
      if (dev === 'p1' && !hung) { hung = true; return 'hang'; }
      return { text: 'ok', tokens: 1 };
    };
    // the phone is slow: a source whose next() waits lets the drop land before the phone is done
    const src = new DemoJobs(units(6));
    const slow: JobSource = { next: async () => { await tick(5); return src.next(); }, done: (u, r) => src.done(u, r), retry: (u) => src.retry(u) };
    const w = make(slow);
    w.start('beyin', 5);
    await until(() => fake.pending.length === 1);
    expect(fake.pending).toHaveLength(1);
    const dropped = fake.pending[0].unit;
    fake.pending[0].reject(new Error('peer gone'));
    await w.settled();
    // every unit was finished, the dropped one by the phone, once
    const byPhone = fake.calls.filter((c) => c.dev === 'me').map((c) => c.unit);
    expect(byPhone).toContain(dropped);
    expect(w.status().units).toBe(6);
    expect(storedResults().map((r) => r.id).sort()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
    expect(storedResults().filter((r) => r.id === dropped)).toHaveLength(1);
    expect(storedResults().find((r) => r.id === dropped)!.device).toBe('me');
  });
  it('a source that throws on next() ends the night cleanly', async () => {
    const bad: JobSource = { next: async () => { throw new Error('offline'); }, done: async () => {} };
    const w = make(bad);
    w.start('beyin', 5);
    await w.settled();
    expect(w.status().state).toBe('done');
    expect(w.status().units).toBe(0);
    expect(fake.calls).toEqual([]);
  });
  it('a source whose done() throws does not stop the counting', async () => {
    const src = new DemoJobs(units(3));
    const flaky: JobSource = { next: () => src.next(), done: async () => { throw new Error('offline'); }, retry: (u) => src.retry(u) };
    const w = make(flaky);
    w.start('beyin', 5);
    await w.settled();
    expect(w.status().units).toBe(3);
    expect(w.status().tokens).toBe(9);
  });
});

describe('stopping', () => {
  it('stop() while the model loads: no loop starts, the model is unloaded once more, nothing counted', async () => {
    let open = () => {};
    fake.loadWait = new Promise<void>((r) => { open = r; });
    const w = make(units(5));
    w.start('beyin', 5);
    await until(() => fake.loads === 1);
    expect(w.status().state).toBe('running');
    w.stop();
    expect(w.status().state).toBe('done');
    open(); // the load ends only after the stop
    await w.settled();
    expect(fake.calls).toEqual([]);
    expect(fake.unloads).toBe(2); // once in stop(), once when begin() finds it is no longer alive
    expect(mockScreen.on).toEqual([true, false]);
  });
  it('stop() in the middle of a unit stops it on the device and does not count it', async () => {
    fake.behave = () => 'hang';
    const w = make(units(5));
    w.start('beyin', 5);
    await until(() => fake.pending.length === 2);
    expect(fake.pending).toHaveLength(2);
    w.stop();
    expect(fake.stopped.sort()).toEqual(['me', 'p1']);
    // the answers land after the stop: not counted, not stored
    fake.pending.forEach((p) => p.resolve({ text: 'late', tokens: 9 }));
    await w.settled();
    expect(w.status().units).toBe(0);
    expect(w.status().tokens).toBe(0);
    expect(storedResults()).toEqual([]);
  });
  it('a second start() during a night ends the first: its late answers count for nothing', async () => {
    fake.behave = () => 'hang';
    const w = make(units(5));
    w.start('first', 5);
    await until(() => fake.pending.length === 2);
    const old = [...fake.pending];
    fake.pending = [];
    fake.behave = () => ({ text: 'ok', tokens: 1 });
    w.start('second', 5);
    old.forEach((p) => p.resolve({ text: 'late', tokens: 100 }));
    await w.settled();
    expect(w.status().slug).toBe('second');
    expect(w.status().units).toBe(5);
    expect(w.status().tokens).toBe(5);
    expect(fake.loads).toBe(2);
  });
  it('stop() when nothing runs does nothing; wait() is ignored while running', async () => {
    const w = make(units(1));
    w.stop();
    expect(w.status().state).toBe('idle');
    w.wait('charge');
    expect(w.status()).toMatchObject({ state: 'waiting', reason: 'charge' });
    fake.behave = () => 'hang';
    w.start('beyin', 5);
    w.wait('window');
    expect(w.status().state).toBe('running');
    w.stop();
    await w.settled();
    w.reset();
    expect(w.status()).toMatchObject({ state: 'idle', slug: null, units: 0 });
  });
});

describe('the model and the load', () => {
  it('a load that fails ends the night on its own', async () => {
    fake.loadFails = true;
    const w = make(units(5));
    w.start('beyin', 5);
    await w.settled();
    expect(w.status().state).toBe('done');
    expect(fake.calls).toEqual([]);
  });
  it('no local model: the night ends at once', async () => {
    mockModels.list = [];
    mockModels.chosen = null;
    const w = make(units(5));
    w.start('beyin', 5);
    await w.settled();
    expect(w.status().state).toBe('done');
    expect(fake.loads).toBe(0);
  });
  it('pickModel: the chosen one, else the largest that fits, else the largest', () => {
    const big = { ...model, id: 'big', name: 'big', size: 9e9 };
    const mid = { ...model, id: 'mid', name: 'mid', size: 2e9 };
    mockModels.list = [model, big, mid];
    expect(pickModel()!.id).toBe('m');
    mockModels.chosen = 'nope';
    // no passport here: nothing "fits", so the largest is taken
    expect(pickModel()!.id).toBe('big');
    mockModels.chosen = null;
    expect(pickModel()!.id).toBe('big');
    mockModels.list = [];
    expect(pickModel()).toBeNull();
  });
});

describe('the known answer', () => {
  it('reads the first word through what small models actually print', () => {
    expect(checkAnswer('positive', 'positive')).toBe(true);
    expect(checkAnswer('positive', 'POSITIVE')).toBe(true);
    expect(checkAnswer('positive', '**Positive**')).toBe(true);
    expect(checkAnswer('positive', '"positive".')).toBe(true);
    expect(checkAnswer('positive', '\n\npositive\n')).toBe(true);
    expect(checkAnswer('negative', 'Negative — the train was late.')).toBe(true);
    expect(checkAnswer('weather', 'Weather.\nThe text is about rain.')).toBe(true);
    expect(checkAnswer('positive', 'The sentiment is positive')).toBe(false);
    expect(checkAnswer('positive', 'positively')).toBe(false);
    expect(checkAnswer('positive', '')).toBe(false);
    expect(checkAnswer('positive', '   ')).toBe(false);
    expect(checkAnswer('sports', 'Spor')).toBe(false);
    expect(checkAnswer('Sports', 'sports')).toBe(true);
  });
  it('is counted on the unit, not on the device: a wrong tablet still counts the unit', async () => {
    fake.behave = (dev) => ({ text: dev === 'p1' ? 'negative' : 'positive', tokens: 1 });
    const w = make([unit(1, 'positive'), unit(2, 'positive'), unit(3, 'positive'), unit(4, 'positive')]);
    w.start('beyin', 5);
    await w.settled();
    const s = w.status();
    expect(s.units).toBe(4);
    expect(s.checked).toBe(4);
    const byTablet = fake.calls.filter((c) => c.dev === 'p1').length;
    expect(s.wrong).toBe(byTablet);
    expect(storedResults().filter((r) => r.ok === false).every((r) => r.device === 'p1')).toBe(true);
  });
});

describe('the simulated worker', () => {
  it('counts tokens by tps and time, 4 W, and ends with done', () => {
    jest.useFakeTimers();
    const w = new SimulatedWorker();
    const seen: string[] = [];
    w.subscribe((s) => seen.push(s.state));
    w.start('beyin', 7);
    jest.advanceTimersByTime(30_000);
    expect(w.status().tokens).toBe(210);
    expect(w.status().seconds).toBe(30);
    expect(w.status().kwh).toBeCloseTo((4 * 30) / 3600 / 1000, 9);
    w.stop();
    expect(w.status().state).toBe('done');
    expect(w.status().real).toBeUndefined();
    jest.advanceTimersByTime(30_000);
    expect(w.status().tokens).toBe(210);
    w.wait('wifi');
    expect(w.status()).toMatchObject({ state: 'waiting', reason: 'wifi' });
    w.reset();
    expect(w.status().state).toBe('idle');
    expect(seen[0]).toBe('running');
    jest.useRealTimers();
    expect(Number.isFinite(work())).toBe(true);
  });
  it('knows the window, across midnight too', () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 5, h, m);
    expect(inWindow('23:00', '07:00', at(23))).toBe(true);
    expect(inWindow('23:00', '07:00', at(3, 30))).toBe(true);
    expect(inWindow('23:00', '07:00', at(7))).toBe(false);
    expect(inWindow('23:00', '07:00', at(12))).toBe(false);
    expect(inWindow('22:30', '23:30', at(22, 29))).toBe(false);
    expect(inWindow('22:30', '23:30', at(23))).toBe(true);
    expect(inWindow('00:00', '00:00', at(5))).toBe(false); // an empty window
    expect(inWindow('8', '9', at(8, 15))).toBe(true); // "8" reads as 8:00
  });
});
