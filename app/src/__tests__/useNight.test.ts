// The night's watch (5.11.2026): the conditions, the choice of worker, the start when
// everything is met, the wait with its reason, the end with the totals sent, the project
// kept for tonight, and the hook. Battery, network, clock and server are all fakes.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import { AppState } from 'react-native';

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
const mockWorld = {
  battery: 2 as number, // 2 = CHARGING, 3 = FULL, 1 = UNPLUGGED
  net: 'wifi' as string | null,
  passport: { device: 'Pixel', est_tps: 6 } as { device: string; est_tps: number } | null,
  kept: [{ slug: 'beyin' }] as { slug: string }[],
  native: false,
  models: [] as unknown[],
  startFails: false,
  started: [] as string[],
  ended: [] as Record<string, unknown>[],
  appState: [] as ((s: string) => void)[],
  batteryListeners: [] as (() => void)[],
};
jest.mock('expo-battery', () => ({
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 },
  getBatteryStateAsync: async () => mockWorld.battery,
  addBatteryStateListener: (fn: () => void) => { mockWorld.batteryListeners.push(fn); return { remove: () => {} }; },
}));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: async () => (mockWorld.net === null ? null : { type: mockWorld.net }) } }));
jest.mock('@/llm/native', () => ({ hasNative: () => mockWorld.native, llama: null, native: () => { throw new Error('nonative'); } }));
jest.mock('@/llm/store', () => ({ localModels: () => mockWorld.models }));
jest.mock('@/data/contribution', () => ({
  startNight: async (slug: string) => { if (mockWorld.startFails) throw new Error('offline'); mockWorld.started.push(slug); return { id: 'c-1', jobId: 'j-1', at: 1_000 }; },
  endNight: async (p: Record<string, unknown>) => { mockWorld.ended.push(p); return 42; },
  forgetNight: () => {},
}));
jest.mock('@/data/friends', () => ({ kept: async () => mockWorld.kept }));
jest.mock('@/data/passport', () => ({ lastPassport: () => mockWorld.passport }));
jest.mock('@/data/settings', () => ({ nightWindow: () => ({ from: '00:00', to: '23:59', wifiOnly: mockStore.get('night.wifi') !== '0' }) }));
jest.mock('@/night/LlamaWorker', () => {
  class FakeLlamaWorker {
    s: Record<string, unknown> = { state: 'idle', slug: null, startedAt: null, tokens: 0, seconds: 0, kwh: 0, tps: 0, real: true, units: 0 };
    fns = new Set<Function>();
    start(slug: string, tps: number) { this.s = { ...this.s, state: 'running', slug, tps, tokens: 77, seconds: 10, kwh: 0.001, units: 3 }; this.tell(); }
    stop() { if (this.s.state === 'running') { this.s = { ...this.s, state: 'done' }; this.tell(); } }
    reset() { this.s = { ...this.s, state: 'idle', slug: null, tokens: 0, units: 0 }; this.tell(); }
    wait(reason: string) { if (this.s.state !== 'running') { this.s = { ...this.s, state: 'waiting', reason }; this.tell(); } }
    status() { return this.s; }
    subscribe(fn: Function) { this.fns.add(fn); return () => this.fns.delete(fn); }
    tell() { this.fns.forEach((fn) => fn(this.s)); }
  }
  return { LlamaWorker: FakeLlamaWorker };
});

import { canRunForReal, chooseTonight, conditions, endNow, recheck, startNightWatch, tonightProject, useNight } from '@/night/useNight';
import type { NightStatus } from '@/night/NightWorker';

// the hook, rendered in a bare component
let latest: NightStatus | null = null;
const note = (s: NightStatus) => { latest = s; };
function Probe({ onStatus }: { onStatus: (s: NightStatus) => void }) { onStatus(useNight()); return null; }
const render = async () => { let r: ReturnType<typeof create> | null = null; await act(async () => { r = create(createElement(Probe, { onStatus: note })); }); return r!; };

beforeEach(() => {
  mockStore.clear();
  mockWorld.battery = 2;
  mockWorld.net = 'wifi';
  mockWorld.passport = { device: 'Pixel', est_tps: 6 };
  mockWorld.kept = [{ slug: 'beyin' }];
  mockWorld.native = false;
  mockWorld.models = [];
  mockWorld.startFails = false;
  mockWorld.started = [];
  mockWorld.ended = [];
  jest.useFakeTimers();
});
afterEach(async () => {
  await endNow();
  jest.useRealTimers();
});

describe('conditions', () => {
  it('reads charging (or full), wi-fi when asked, the window and the passport', async () => {
    expect(await conditions()).toEqual({ window: true, charging: true, wifi: true, passport: true });
    mockWorld.battery = 3;
    expect((await conditions()).charging).toBe(true);
    mockWorld.battery = 1;
    expect((await conditions()).charging).toBe(false);
    mockWorld.net = 'cellular';
    expect((await conditions()).wifi).toBe(false);
    mockStore.set('night.wifi', '0');
    expect((await conditions()).wifi).toBe(true);
    mockWorld.net = null;
    mockStore.delete('night.wifi');
    expect((await conditions()).wifi).toBe(false);
    mockWorld.passport = null;
    expect((await conditions()).passport).toBe(false);
  });
});

describe('the watch', () => {
  it('starts the night on the kept project when everything is met, and remembers the start', async () => {
    await recheck();
    expect(mockWorld.started).toEqual(['beyin']);
    expect(JSON.parse(mockStore.get('night.start')!)).toMatchObject({ id: 'c-1', jobId: 'j-1', at: 1000, slug: 'beyin' });
    const r = await render();
    expect(latest).toMatchObject({ state: 'running', slug: 'beyin', tps: 6 });
    expect(latest!.real).toBeUndefined(); // the simulation: no native module
    r.unmount();
  });
  it('prefers tonight’s chosen project over the kept list', async () => {
    chooseTonight('mine');
    expect(tonightProject()).toBe('mine');
    await recheck();
    expect(mockWorld.started).toEqual(['mine']);
    chooseTonight(null);
    expect(tonightProject()).toBeNull();
  });
  it('waits with the first reason that is missing, in order: project, passport, window, charge, wi-fi', async () => {
    mockWorld.kept = [];
    const r = await render(); // the hook's own first check: nothing to work on
    expect(latest).toMatchObject({ state: 'waiting', reason: 'noproject' });
    const reason = async () => { await act(async () => { await recheck(); }); return (latest as NightStatus & { reason?: string }).reason; };
    expect(await reason()).toBe('noproject');
    mockWorld.kept = [{ slug: 'x' }];
    mockWorld.passport = null;
    expect(await reason()).toBe('nopassport');
    mockWorld.passport = { device: 'P', est_tps: 1 };
    mockWorld.battery = 1;
    expect(await reason()).toBe('charge');
    mockWorld.battery = 2;
    mockWorld.net = 'cellular';
    expect(await reason()).toBe('wifi');
    expect(mockWorld.started).toEqual([]);
    r.unmount();
  });
  it('does not start when the server refuses the start', async () => {
    mockWorld.startFails = true;
    await recheck();
    expect(mockStore.get('night.start')).toBeUndefined();
    const r = await render();
    expect(latest!.state).not.toBe('running');
    r.unmount();
  });
  it('ends the night when a condition goes, sends the totals, and resets', async () => {
    await recheck();
    mockWorld.battery = 1;
    await recheck();
    expect(mockWorld.ended).toHaveLength(1);
    expect(mockWorld.ended[0]).toMatchObject({ contributionId: 'c-1', startId: 'j-1', startedAt: 1000, slug: 'beyin', units: 0, checked: 0, wrong: 0, model: null });
    expect(typeof mockWorld.ended[0].tokens).toBe('number');
    expect(mockStore.get('night.start')).toBeUndefined();
    const r = await render(); // reset to idle, then the hook's first check: waiting for the charger
    expect(latest).toMatchObject({ state: 'waiting', reason: 'charge', tokens: 0 });
    r.unmount();
  });
  it('endNow ends a running night by hand and is a no-op otherwise', async () => {
    await endNow();
    expect(mockWorld.ended).toEqual([]);
    await recheck();
    await endNow();
    expect(mockWorld.ended).toHaveLength(1);
  });
  it('picks the real worker when the native module and a model are there, and carries its counts to the end', async () => {
    mockWorld.native = true;
    mockWorld.models = [{ id: 'm' }];
    expect(canRunForReal()).toBe(true);
    await recheck();
    const r = await render();
    expect(latest).toMatchObject({ state: 'running', real: true, units: 3 });
    await act(async () => { await endNow(); });
    expect(mockWorld.ended[0]).toMatchObject({ tokens: 77, seconds: 10, units: 3 });
    expect(latest!.state).toBe('idle');
    // back to the simulation when the model is gone
    mockWorld.models = [];
    expect(canRunForReal()).toBe(false);
    await act(async () => { await recheck(); });
    expect(latest!.real).toBeUndefined();
    r.unmount();
  });
  it('startNightWatch checks now, every 30 s, when the app comes back and when the plug changes', async () => {
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, fn: (s: string) => void) => { mockWorld.appState.push(fn); return { remove: () => {} }; }) as unknown as typeof AppState.addEventListener);
    startNightWatch();
    startNightWatch(); // once
    await act(async () => { await Promise.resolve(); });
    expect(mockWorld.started).toEqual(['beyin']);
    expect(mockWorld.appState).toHaveLength(1);
    expect(mockWorld.batteryListeners).toHaveLength(1);
    mockWorld.battery = 1;
    mockWorld.batteryListeners[0]();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockWorld.ended).toHaveLength(1);
    mockWorld.battery = 2;
    mockWorld.appState[0]('active');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockWorld.started).toEqual(['beyin', 'beyin']);
    mockWorld.battery = 1;
    await act(async () => { jest.advanceTimersByTime(30_000); await Promise.resolve(); await Promise.resolve(); });
    expect(mockWorld.ended).toHaveLength(2);
  });
});
