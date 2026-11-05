// The night's conditions (night-2): each flag on its own, the order of the reasons, the
// window key, the passport's heat flag, and the readers over expo-battery / expo-network.
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
const phone = { state: 2, level: 0.8, net: 'WIFI', connected: true, passport: { est_tps: 5, thermal: { status: 0, headroom: 0.3, battery_c: 30 } } as Record<string, unknown> | null };
jest.mock('expo-battery', () => ({
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 },
  getBatteryStateAsync: async () => phone.state,
  getBatteryLevelAsync: async () => phone.level,
  addBatteryStateListener: () => ({ remove() {} }),
  addBatteryLevelListener: () => ({ remove() {} }),
}));
jest.mock('expo-network', () => ({
  NetworkStateType: { NONE: 'NONE', UNKNOWN: 'UNKNOWN', CELLULAR: 'CELLULAR', WIFI: 'WIFI', ETHERNET: 'ETHERNET' },
  getNetworkStateAsync: async () => ({ type: phone.net, isConnected: phone.connected, isInternetReachable: phone.connected }),
  addNetworkStateListener: () => ({ remove() {} }),
}));
jest.mock('@/data/passport', () => ({ lastPassport: () => phone.passport }));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: async () => ({ data: null, error: null }), auth: { onAuthStateChange: () => {} } }, DEMO: true }));

import { evaluate, passportHot, readFacts, readVerdict, setWantTonight, type Facts } from '@/night/conditions';
import { windowKey } from '@/night/report';
import { nightRules, saveNightRules, type NightRules } from '@/data/settings';

const rules: NightRules = { from: '23:00', to: '07:30', wifiOnly: true, chargeOnly: true, minBattery: 30 };
const night = new Date(2026, 10, 5, 23, 30); // 5.11.2026 23:30
const good: Facts = { now: night, charging: true, net: 'wifi', batteryPct: 80, hot: false, wanted: true, hasProject: true, hasPassport: true };

beforeEach(() => {
  mockStore.clear();
  Object.assign(phone, { state: 2, level: 0.8, net: 'WIFI', connected: true, passport: { est_tps: 5, thermal: { status: 0, headroom: 0.3, battery_c: 30 } } });
});

describe('evaluate', () => {
  it('says ok when everything is there', () => {
    expect(evaluate(good, rules)).toEqual({ ok: true, reason: null, own: false, flags: { off: false, noproject: false, nopassport: false, window: false, charge: false, battery: false, hot: false, wifi: false } });
  });
  it.each([
    ['off', { wanted: false }],
    ['noproject', { hasProject: false }],
    ['nopassport', { hasPassport: false }],
    ['window', { now: new Date(2026, 10, 5, 12, 0) }],
    ['charge', { charging: false }],
    ['battery', { batteryPct: 29 }],
    ['hot', { hot: true }],
    ['wifi', { net: 'cellular' as const }],
  ])('names %s when only that is missing', (reason, patch) => {
    const v = evaluate({ ...good, ...patch }, rules);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(reason);
    expect(Object.entries(v.flags).filter(([, on]) => on).map(([k]) => k)).toEqual([reason]);
  });
  it('lets the rules switch a condition off', () => {
    expect(evaluate({ ...good, charging: false, batteryPct: 50 }, { ...rules, chargeOnly: false }).ok).toBe(true);
    expect(evaluate({ ...good, net: 'cellular' }, { ...rules, wifiOnly: false }).ok).toBe(true);
    expect(evaluate({ ...good, batteryPct: 25 }, { ...rules, minBattery: 20 }).ok).toBe(true);
    expect(evaluate({ ...good, batteryPct: 30 }, rules).ok).toBe(true); // at the threshold is enough
    expect(evaluate({ ...good, batteryPct: null }, rules).ok).toBe(true); // unknown is not under
  });
  it('puts the person first, the clock before the plug, the plug before the network', () => {
    expect(evaluate({ ...good, wanted: false, charging: false, net: 'none' }, rules).reason).toBe('off');
    expect(evaluate({ ...good, now: new Date(2026, 10, 5, 12, 0), charging: false }, rules).reason).toBe('window');
    expect(evaluate({ ...good, charging: false, net: 'none' }, rules).reason).toBe('charge');
    expect(evaluate({ ...good, batteryPct: 10, hot: true, net: 'none' }, rules).reason).toBe('battery');
  });
  it('is inside the window after midnight too', () => {
    expect(evaluate({ ...good, now: new Date(2026, 10, 6, 3, 0) }, rules).ok).toBe(true);
    expect(evaluate({ ...good, now: new Date(2026, 10, 6, 7, 30) }, rules).reason).toBe('window');
  });
});

describe('the passport heat flag', () => {
  it('is severe thermal status or a hot battery, not light or moderate', () => {
    expect(passportHot(null)).toBe(false);
    expect(passportHot({})).toBe(false);
    expect(passportHot({ thermal: { status: 2, battery_c: 35 } })).toBe(false);
    expect(passportHot({ thermal: { status: 3, battery_c: 35 } })).toBe(true);
    expect(passportHot({ thermal: { status: 0, battery_c: 43 } })).toBe(true);
    expect(passportHot({ thermal: { status: -1, battery_c: -1 } })).toBe(false);
  });
});

describe('the window key', () => {
  it('is the date the window opened on, before and after midnight', () => {
    expect(windowKey('23:00', '07:30', new Date(2026, 10, 5, 23, 30))).toBe('2026-11-05');
    expect(windowKey('23:00', '07:30', new Date(2026, 10, 6, 3, 0))).toBe('2026-11-05');
    expect(windowKey('23:00', '07:30', new Date(2026, 10, 6, 12, 0))).toBe('2026-11-06');
    expect(windowKey('01:00', '06:00', new Date(2026, 10, 6, 3, 0))).toBe('2026-11-06'); // no midnight inside
  });
});

describe('the readers', () => {
  it('read the plug, the level, the network and the passport from the phone', async () => {
    const f = await readFacts(true, night);
    expect(f).toMatchObject({ charging: true, net: 'wifi', batteryPct: 80, hot: false, wanted: true, hasProject: true, hasPassport: true });
    phone.state = 1; phone.level = 0.2; phone.net = 'CELLULAR';
    phone.passport = { est_tps: 5, thermal: { status: 3, headroom: 1, battery_c: 44 } };
    const g = await readFacts(false, night);
    expect(g).toMatchObject({ charging: false, net: 'cellular', batteryPct: 20, hot: true, hasProject: false });
    phone.connected = false;
    expect((await readFacts(true, night)).net).toBe('none');
    phone.passport = null;
    expect((await readFacts(true, night)).hasPassport).toBe(false);
  });
  it('full counts as charging, and "work tonight" is on until switched off', async () => {
    phone.state = 3;
    expect((await readFacts(true, night)).charging).toBe(true);
    setWantTonight(false);
    expect((await readVerdict(true, night)).reason).toBe('off');
    setWantTonight(true);
    expect((await readVerdict(true, night)).ok).toBe(true);
  });
  it('uses the rules saved on the phone', async () => {
    expect(nightRules()).toEqual({ from: '23:00', to: '07:30', wifiOnly: true, chargeOnly: true, minBattery: 30 });
    saveNightRules({ minBattery: 50, chargeOnly: false });
    expect(nightRules()).toMatchObject({ minBattery: 50, chargeOnly: false });
    phone.level = 0.4; phone.state = 1;
    expect((await readVerdict(true, night)).reason).toBe('battery');
    phone.level = 0.6;
    expect((await readVerdict(true, night)).ok).toBe(true);
  });
});
