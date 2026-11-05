// The night's planner (night-2) driven by hand: a fake clock, a fake worker and a verdict
// the test sets. Waiting → running when the window opens; a pulled plug pauses and keeps a
// segment; the plug back in continues the same night; the window closing ends it with one
// report and one contribution_end; the same window does not start twice; a pile run dry
// ends the night; "end now" ends it by hand.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockStore = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItemSync: (k: string) => mockStore.get(k) ?? null,
    setItemSync: (k: string, v: string) => mockStore.set(k, v),
    removeItemSync: (k: string) => mockStore.delete(k),
  },
}));

jest.mock('expo-battery', () => ({ BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 }, getBatteryStateAsync: async () => 2, getBatteryLevelAsync: async () => 1, addBatteryStateListener: () => ({ remove() {} }), addBatteryLevelListener: () => ({ remove() {} }) }));
jest.mock('expo-network', () => ({ NetworkStateType: { WIFI: 'WIFI' }, getNetworkStateAsync: async () => ({ type: 'WIFI', isConnected: true }), addNetworkStateListener: () => ({ remove() {} }) }));
jest.mock('@/data/passport', () => ({ lastPassport: () => null }));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: async () => ({ data: null, error: null }), auth: { onAuthStateChange: () => {} } }, DEMO: true }));

import { evaluate, type Facts } from '@/night/conditions';
import type { NightStatus } from '@/night/NightWorker';
import { reports, segments, type NightReport } from '@/night/report';
import { Scheduler, type Deps, type Worker } from '@/night/scheduler';
import type { NightRules } from '@/data/settings';

const rules: NightRules = { from: '23:00', to: '07:30', wifiOnly: true, chargeOnly: true, minBattery: 30 };
const T = (h: number, m = 0, day = 5) => new Date(2026, 10, day, h, m).getTime();

// A worker that counts: 10 tokens and one unit per second of fake time while running.
class FakeWorker implements Worker {
  s: NightStatus = { state: 'idle', slug: null, startedAt: null, tokens: 0, seconds: 0, kwh: 0, tps: 0 };
  starts: string[] = [];
  keys: (string | undefined)[] = [];
  constructor(private clock: () => number, public real = true) {}
  start(slug: string, tps: number, key?: string) {
    this.starts.push(slug);
    this.keys.push(key);
    this.s = { state: 'running', slug, startedAt: this.clock(), tokens: 0, seconds: 0, kwh: 0, tps, real: this.real, units: 0, checked: 0, wrong: 0, devices: [{ id: 'me', name: 'this phone', tokens: 0, units: 0 }] };
  }
  tickWork() {
    if (this.s.state !== 'running') return;
    const seconds = Math.round((this.clock() - this.s.startedAt!) / 1000);
    this.s = { ...this.s, seconds, tokens: seconds * 10, units: seconds, checked: Math.floor(seconds / 8), wrong: 0, kwh: (4 * seconds) / 3600 / 1000, devices: [{ id: 'me', name: 'this phone', tokens: seconds * 10, units: seconds }] };
  }
  stop() {
    this.tickWork();
    if (this.s.state === 'running') this.s = { ...this.s, state: 'done' };
  }
  drain() {
    this.stop();
  }
  reset() {
    this.s = { state: 'idle', slug: null, startedAt: null, tokens: 0, seconds: 0, kwh: 0, tps: 0 };
  }
  wait(reason: NonNullable<NightStatus['reason']>) {
    if (this.s.state !== 'running') this.s = { ...this.s, state: 'waiting', reason };
  }
  status() {
    return this.s;
  }
  subscribe() {
    return () => {};
  }
}

type World = { now: number; facts: Omit<Facts, 'now'>; slug: string | null };
function build() {
  const world: World = { now: T(22, 0), facts: { charging: true, net: 'wifi', batteryPct: 90, hot: false, wanted: true, hasProject: true, hasPassport: true }, slug: 'beyin' };
  const worker = new FakeWorker(() => world.now);
  const calls = { starts: 0, ends: [] as Parameters<Deps['endNight']>[0][], reports: [] as NightReport[], shown: 0, hidden: 0 };
  const deps: Deps = {
    worker: () => worker,
    verdict: async () => evaluate({ ...world.facts, now: new Date(world.now) }, rules),
    project: async () => world.slug,
    rules: () => rules,
    now: () => world.now,
    tps: () => 5,
    watts: () => null,
    store: { get: (k) => mockStore.get(k) ?? null, set: (k, v) => mockStore.set(k, v), del: (k) => mockStore.delete(k) },
    startNight: async () => ({ id: `c${++calls.starts}`, jobId: `j${calls.starts}`, at: world.now }),
    endNight: async (p) => { calls.ends.push(p); },
    sendReport: async (r) => { calls.reports.push(r); return true; },
    notify: { show: () => { calls.shown++; }, hide: () => { calls.hidden++; } },
  };
  const sch = new Scheduler(deps);
  // move the clock and look again
  const at = async (ms: number) => { world.now = ms; worker.tickWork(); return sch.tick(); };
  return { world, worker, calls, sch, at };
}

beforeEach(() => mockStore.clear());

describe('the scheduler', () => {
  it('waits outside the window, starts when it opens, ends when it closes with one report', async () => {
    const { world, worker, calls, sch, at } = build();
    expect(await at(T(22, 0))).toBe('waiting');
    expect(worker.status()).toMatchObject({ state: 'waiting', reason: 'window' });
    expect(await at(T(23, 0))).toBe('running');
    expect(worker.starts).toEqual(['beyin']);
    expect(worker.keys).toEqual(['2026-11-05']);
    expect(calls.shown).toBe(1);
    expect(sch.open()).toMatchObject({ id: 'c1', slug: 'beyin', key: '2026-11-05' });
    expect(await at(T(3, 0, 6))).toBe('running');
    expect(await at(T(7, 30, 6))).toBe('done');
    expect(calls.ends).toHaveLength(1);
    expect(calls.ends[0]).toMatchObject({ contributionId: 'c1', slug: 'beyin', seconds: 8.5 * 3600, tokens: 8.5 * 3600 * 10, units: 8.5 * 3600 });
    expect(calls.reports).toHaveLength(1);
    expect(calls.hidden).toBeGreaterThanOrEqual(1);
    const r = reports();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: '2026-11-05', segments: 1, seconds: 30600, units: 30600, tps: 10, wh: 25.5, watts: 3, measured: false, sent: true });
    expect(sch.open()).toBeNull();
    expect(segments()).toEqual([]);
    // the morning: nothing starts again, the next evening does
    world.facts.charging = true;
    expect(await at(T(8, 0, 6))).toBe('waiting');
    expect(worker.status().reason).toBe('window');
    expect(await at(T(23, 30, 6))).toBe('running');
    expect(worker.keys).toEqual(['2026-11-05', '2026-11-06']);
    expect(calls.starts).toBe(2);
  });

  it('pauses when the plug comes out, keeps the segment, and continues the same night', async () => {
    const { world, worker, calls, sch, at } = build();
    await at(T(23, 0));
    world.facts.charging = false;
    expect(await at(T(0, 0, 6))).toBe('paused');
    expect(worker.status()).toMatchObject({ state: 'waiting', reason: 'charge' });
    expect(segments()).toHaveLength(1);
    expect(segments()[0]).toMatchObject({ tokens: 36000, units: 3600 });
    expect(sch.open()).toMatchObject({ id: 'c1' }); // the night is still open
    expect(calls.ends).toHaveLength(0);
    expect(calls.hidden).toBe(1);
    // the battery falls under the threshold too: still paused, no second segment
    world.facts.batteryPct = 20;
    expect(await at(T(0, 30, 6))).toBe('paused');
    expect(worker.status().reason).toBe('charge');
    expect(segments()).toHaveLength(1);
    // back on the plug: the same night, the same key, no second contribution_start
    world.facts.charging = true;
    expect(await at(T(0, 45, 6))).toBe('paused'); // on the plug, but still under the threshold
    expect(worker.status().reason).toBe('battery');
    world.facts.batteryPct = 50;
    expect(await at(T(1, 0, 6))).toBe('running');
    expect(worker.starts).toEqual(['beyin', 'beyin']);
    expect(worker.keys).toEqual(['2026-11-05', '2026-11-05']);
    expect(calls.starts).toBe(1);
    expect(calls.shown).toBe(2);
    expect(await at(T(7, 30, 6))).toBe('done');
    const r = reports()[0];
    expect(r.segments).toBe(2);
    expect(r.seconds).toBe(3600 + 6.5 * 3600); // the pause is left out
    expect(r.units).toBe(3600 + 6.5 * 3600);
    expect(calls.ends[0]).toMatchObject({ contributionId: 'c1', seconds: r.seconds, units: r.units });
    expect(calls.ends).toHaveLength(1);
  });

  it('ends the night when the worker runs the pile dry, and does not start it again that window', async () => {
    const { worker, calls, sch, at } = build();
    await at(T(23, 0));
    worker.tickWork();
    await at(T(23, 10));
    worker.drain();
    expect(await at(T(23, 11))).toBe('done');
    expect(calls.ends).toHaveLength(1);
    expect(reports()[0]).toMatchObject({ units: 600, segments: 1 });
    expect(await at(T(23, 12))).toBe('done');
    expect(worker.status()).toMatchObject({ state: 'waiting', reason: 'done' });
    expect(calls.starts).toBe(1);
    expect(sch.doneKey()).toBe('2026-11-05');
  });

  it('"end now" ends it by hand; a night open from before a restart is found again in the store', async () => {
    const a = build();
    await a.at(T(23, 0));
    await a.at(T(23, 20));
    // the app restarts: a new scheduler over the same store, the window still open
    const b = build();
    b.world.now = T(23, 21);
    expect(await b.sch.tick()).toBe('running');
    expect(b.calls.starts).toBe(0); // no second start: the open night came from the store
    expect(b.worker.keys).toEqual(['2026-11-05']);
    b.world.now = T(23, 40);
    b.worker.tickWork();
    await b.sch.endNow();
    expect(b.sch.state().phase).toBe('done');
    expect(b.calls.ends).toHaveLength(1);
    expect(b.calls.ends[0].contributionId).toBe('c1');
    expect(reports()).toHaveLength(1);
    // a's segment was never written (the restart cut it): only b's time counts
    expect(reports()[0].seconds).toBe(19 * 60);
  });

  it('shows the person why it waits: off, no project, no passport, battery', async () => {
    const { world, worker, at } = build();
    world.facts.wanted = false;
    await at(T(23, 0));
    expect(worker.status().reason).toBe('off');
    world.facts.wanted = true;
    world.slug = null;
    await at(T(23, 1));
    expect(worker.status().reason).toBe('noproject');
    world.slug = 'beyin';
    world.facts.hasPassport = false;
    await at(T(23, 2));
    expect(worker.status().reason).toBe('nopassport');
    world.facts.hasPassport = true;
    world.facts.batteryPct = 10;
    await at(T(23, 3));
    expect(worker.status().reason).toBe('battery');
    world.facts.batteryPct = 50;
    expect(await at(T(23, 4))).toBe('running');
  });

  it('a start the server refuses leaves it waiting, and a report the server cannot take stays unsent', async () => {
    const { calls, sch, at, world } = build();
    const deps = (sch as unknown as { d: Deps }).d;
    deps.startNight = async () => null;
    expect(await at(T(23, 0))).toBe('waiting');
    expect(sch.open()).toBeNull();
    deps.startNight = async () => ({ id: 'c9', jobId: 'j9', at: world.now });
    deps.sendReport = async () => false;
    expect(await at(T(23, 1))).toBe('running');
    await at(T(7, 30, 6));
    expect(reports()[0].sent).toBe(false);
    expect(calls.reports).toHaveLength(0);
  });
});
