// The real night without a phone (5.11.2026): a fake engine with two devices stands in
// for llama.cpp, so the worker's loop can be watched: units handed out round-robin, a
// failing device put out for five minutes, known answers counted, stop() ending the loops
// with totals, and the demo source handing out every unit once.
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
jest.mock('@/llm/native', () => ({ llama: { keepScreenOn: async () => {} }, hasNative: () => true, native: () => { throw new Error('nonative'); } }));
const model = { id: 'm', name: 'tiny', file: 'tiny.gguf', path: '/m/tiny.gguf', size: 500e6, sha256: null, params_b: 0.6, quant: 'q8', kv_mb_per_1k: 28, ctx_max: 4096, license: null, source: 'catalog', url: '', added_at: '' };
jest.mock('@/llm/store', () => ({
  settings: () => ({ modelId: 'm', ctx: 2048, temperature: 0.7, maxTokens: 512, lastMode: 'alone' }),
  localById: (id: string) => (id === 'm' ? model : null),
  localModels: () => [model],
  peers: () => [{ id: 'p1', name: 'tablet', host: '10.0.0.2', port: 50551, secret: 'a'.repeat(64), kind: 'tablet', ram: 4000, bw: 10, added_at: '' }],
}));

// The fake engine: two devices; chat answers after a tick with a reply the test chooses.
type Behave = (dev: string, prompt: string) => { text: string; tokens: number } | Error;
const fake = { behave: null as Behave | null, calls: [] as { dev: string; unit: string }[] };
const devices = [{ id: 'me', name: 'this phone', local: true, busy: false }, { id: 'p1', name: 'tablet', local: false, busy: false }];
jest.mock('@/llm/engine', () => ({
  load: jest.fn(async () => {}),
  unload: jest.fn(async () => {}),
  engine: () => ({ devices }),
  chat: (messages: { content: string }[], onToken: (t: string) => void, opts: { device: string }) => {
    const prompt = messages[1].content;
    fake.calls.push({ dev: opts.device, unit: prompt });
    const p = new Promise((resolve, reject) => {
      setTimeout(() => {
        const r = fake.behave!(opts.device, prompt);
        if (r instanceof Error) return reject(r);
        onToken(r.text);
        resolve({ tokens: r.tokens, ms: 10, firstMs: 5, tps: 100, stopped: false, device: opts.device === 'me' ? 'this phone' : 'tablet' });
      }, 1);
    }) as Promise<unknown> & { stop: () => void };
    p.stop = () => {};
    return p;
  },
}));

import { load } from '@/llm/engine';
import { DEMO_UNITS, DemoJobs, checkAnswer, storedResults, type Unit } from '@/night/jobs';
import { LlamaWorker } from '@/night/LlamaWorker';

const unit = (i: number, expected?: string): Unit => ({ id: `u${i}`, type: 'classify', prompt: `u${i}`, maxTokens: 4, ...(expected ? { expected } : {}) });
const units = (n: number) => Array.from({ length: n }, (_, i) => unit(i + 1));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

let clock = 1_000_000;
const make = (list: Unit[]) => new LlamaWorker({ source: () => new DemoJobs(list), now: () => clock, idleMs: 2 });

beforeEach(() => {
  fake.calls = [];
  fake.behave = () => ({ text: 'positive', tokens: 3 });
  mockStore.clear();
  clock = 1_000_000;
});

describe('the llama worker', () => {
  it('loads apart with the saved peers and hands units out over both devices, one in flight each', async () => {
    const w = make(units(8));
    w.start('beyin', 5);
    await w.settled();
    expect(load).toHaveBeenCalledWith(model, 'apart', expect.any(Number), expect.arrayContaining([expect.objectContaining({ id: 'p1' })]));
    const mine = fake.calls.filter((c) => c.dev === 'me').length;
    const theirs = fake.calls.filter((c) => c.dev === 'p1').length;
    expect(mine + theirs).toBe(8);
    expect(Math.abs(mine - theirs)).toBeLessThanOrEqual(1);
    // the first two go out at once, one per device, before either has answered
    expect(fake.calls.slice(0, 2).map((c) => c.dev).sort()).toEqual(['me', 'p1']);
    const s = w.status();
    expect(s.state).toBe('done'); // the pile ran dry
    expect(s.units).toBe(8);
    expect(s.tokens).toBe(24);
    expect(s.real).toBe(true);
    expect(s.model).toBe('tiny');
    expect(s.devices!.map((d) => d.name)).toEqual(['this phone', 'tablet']);
    expect(s.devices!.reduce((a, d) => a + d.tokens, 0)).toBe(24);
  });

  it('runs prepare (the projects\' photos read by a vision model) before it loads the model; a failing prepare does not stop the night', async () => {
    const order: string[] = [];
    (load as jest.Mock).mockImplementationOnce(async () => { order.push('load'); });
    const w = new LlamaWorker({ source: () => new DemoJobs(units(2)), now: () => clock, idleMs: 2, prepare: async () => { order.push('prepare'); throw new Error('novision'); } });
    w.start('beyin', 5);
    await w.settled();
    expect(order).toEqual(['prepare', 'load']);
    expect(w.status().units).toBe(2);
  });

  it('puts a failing device out for five minutes and gives its unit to the other', async () => {
    fake.behave = (dev) => (dev === 'p1' ? new Error('peer gone') : { text: 'ok', tokens: 2 });
    const w = make(units(6));
    w.start('beyin', 5);
    await tick(60);
    // the tablet failed once (its unit went back on the pile), the phone did all six
    expect(w.status().units).toBe(6);
    expect(fake.calls.filter((c) => c.dev === 'p1')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.dev === 'me')).toHaveLength(6);
    expect(new Set(fake.calls.filter((c) => c.dev === 'me').map((c) => c.unit)).size).toBe(6);
    const tablet = w.status().devices!.find((d) => d.id === 'p1')!;
    expect(tablet.out).toBe(true);
    expect(tablet.units).toBe(0);
    expect(w.status().state).toBe('done');
  });

  it('tries an out device again after five minutes', async () => {
    let fail = true;
    fake.behave = (dev) => (dev === 'p1' && fail ? new Error('peer gone') : { text: 'ok', tokens: 1 });
    // a source that never runs dry: the loop stays alive and the clock can be moved
    const endless = { n: 0, async next() { return unit(++this.n); }, async done() {}, async retry() {} };
    const w = new LlamaWorker({ source: () => endless, now: () => clock, idleMs: 2 });
    w.start('beyin', 5);
    await tick(30);
    expect(fake.calls.filter((c) => c.dev === 'p1')).toHaveLength(1);
    fail = false;
    clock += 4 * 60_000;
    await tick(30);
    expect(fake.calls.filter((c) => c.dev === 'p1')).toHaveLength(1); // still out at four minutes
    clock += 61_000;
    await tick(30);
    expect(fake.calls.filter((c) => c.dev === 'p1').length).toBeGreaterThan(1);
    expect(w.status().devices!.find((d) => d.id === 'p1')!.out).toBe(false);
    w.stop();
    await w.settled();
  });

  it('counts known-answer units right and wrong', async () => {
    fake.behave = (_dev, prompt) => ({ text: prompt === 'u2' ? 'Negative.' : 'positive', tokens: 1 });
    const w = make([unit(1, 'positive'), unit(2, 'positive'), unit(3), unit(4, 'negative')]);
    w.start('beyin', 5);
    await w.settled();
    const s = w.status();
    expect(s.units).toBe(4);
    expect(s.checked).toBe(3);
    expect(s.wrong).toBe(2);
    const kept = storedResults();
    expect(kept).toHaveLength(4);
    expect(kept.find((r) => r.id === 'u2')!.ok).toBe(false);
    expect(kept.find((r) => r.id === 'u1')!.ok).toBe(true);
    expect(kept.find((r) => r.id === 'u3')!.ok).toBeUndefined();
  });

  it('stop() ends the loops and reports the totals, with seconds and kwh for two devices', async () => {
    const seen: string[] = [];
    const w = make(units(1000));
    w.subscribe((s) => seen.push(s.state));
    w.start('beyin', 5);
    await tick(40);
    clock += 3600_000;
    w.stop();
    const s = w.status();
    expect(s.state).toBe('done');
    const did = s.units!;
    expect(did).toBeGreaterThan(2);
    expect(s.tokens).toBe(did * 3);
    expect(s.seconds).toBe(3600);
    expect(s.kwh).toBeCloseTo(0.006, 6); // 4 W + 2 W for the tablet, one hour
    await w.settled();
    await tick(10);
    expect(w.status().units).toBe(did); // nothing counted after the stop
    expect(seen[0]).toBe('running');
    expect(seen[seen.length - 1]).toBe('done');
  });
});

describe('the demo jobs', () => {
  it('hand out every unit once, in three kinds, with a known answer on about one in eight', async () => {
    const src = new DemoJobs();
    const got: Unit[] = [];
    for (let u = await src.next(); u; u = await src.next()) got.push(u);
    expect(got).toHaveLength(DEMO_UNITS.length);
    expect(DEMO_UNITS.length).toBeGreaterThanOrEqual(55);
    expect(new Set(got.map((u) => u.id)).size).toBe(got.length);
    expect(new Set(got.map((u) => u.type))).toEqual(new Set(['classify', 'summarise', 'translate']));
    const known = got.filter((u) => u.expected).length;
    expect(known).toBeGreaterThanOrEqual(Math.floor(got.length / 10));
    expect(known).toBeLessThanOrEqual(Math.ceil(got.length / 6));
    expect(got.every((u) => u.maxTokens > 0 && u.prompt.length > 0)).toBe(true);
  });
  it('checks an answer by its first word, whatever the case and punctuation', () => {
    expect(checkAnswer('positive', ' Positive.\n')).toBe(true);
    expect(checkAnswer('sports', 'Sports, clearly.')).toBe(true);
    expect(checkAnswer('weather', 'It is about sports')).toBe(false);
  });
});
