import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as Battery from 'expo-battery';
import * as Network from 'expo-network';
import Storage from 'expo-sqlite/kv-store';
import { lastPassport } from '@/data/passport';
import { nightRules, type NightRules } from '@/data/settings';
import { inWindow } from './SimulatedWorker';

// When may the night start, and when must it pause? (5.11.2026, night-2)
//
// evaluate() is a pure function: the facts of the moment and the person's rules in, a
// verdict out, each condition on its own so the card can say which one is missing. The
// readers around it (readFacts, useConditions) use expo-battery and expo-network as they
// are in SDK 57: getBatteryStateAsync / getBatteryLevelAsync / addBatteryStateListener /
// addBatteryLevelListener, getNetworkStateAsync / addNetworkStateListener. The thermal
// flag comes from the passport (the last measurement's thermal status), not from a live
// sensor: a phone that was throttling when it was measured does not get a night.
//
// Order of the reasons, when more than one is missing: the person's own choice first
// (off), then what needs their hand (project, passport), then the clock, then the plug,
// the battery, the heat, the network.
export type NetKind = 'wifi' | 'cellular' | 'none' | 'unknown';
export type Facts = {
  now: Date;
  charging: boolean;
  net: NetKind;
  batteryPct: number | null; // 0–100, null when the phone does not say
  hot: boolean; // the passport's thermal flag
  wanted: boolean; // "work tonight" is on
  hasProject: boolean;
  hasPassport: boolean;
};
export type Flags = { off: boolean; noproject: boolean; nopassport: boolean; window: boolean; charge: boolean; battery: boolean; hot: boolean; wifi: boolean };
export type Reason = keyof Flags;
export type Verdict = { ok: boolean; flags: Flags; reason: Reason | null };
const ORDER: Reason[] = ['off', 'noproject', 'nopassport', 'window', 'charge', 'battery', 'hot', 'wifi'];

// Android's PowerManager thermal status: 0 none, 1 light, 2 moderate, 3 severe and up.
// Severe (or a battery over HOT_C) is a flag; light and moderate are not.
export const HOT_STATUS = 3;
export const HOT_C = 42;
export function passportHot(p: { thermal?: { status: number; battery_c: number } } | null): boolean {
  const t = p?.thermal;
  if (!t) return false;
  return t.status >= HOT_STATUS || t.battery_c >= HOT_C;
}

/** Each flag true when that condition is MISSING; ok when none is. */
export function evaluate(f: Facts, r: NightRules): Verdict {
  const flags: Flags = {
    off: !f.wanted,
    noproject: !f.hasProject,
    nopassport: !f.hasPassport,
    window: !inWindow(r.from, r.to, f.now),
    charge: r.chargeOnly && !f.charging,
    battery: f.batteryPct !== null && f.batteryPct < r.minBattery,
    hot: f.hot,
    wifi: r.wifiOnly && f.net !== 'wifi',
  };
  const reason = ORDER.find((k) => flags[k]) ?? null;
  return { ok: reason === null, flags, reason };
}

// "work tonight": on unless the person switched it off; the switch lives on the phone.
const WANT = 'night.want';
export const wantTonight = () => Storage.getItemSync(WANT) !== '0';
export const setWantTonight = (on: boolean) => Storage.setItemSync(WANT, on ? '1' : '0');

const netKind = (s: { type?: Network.NetworkStateType; isConnected?: boolean } | null): NetKind => {
  if (!s || s.isConnected === false) return 'none';
  if (s.type === Network.NetworkStateType.WIFI || s.type === Network.NetworkStateType.ETHERNET) return 'wifi';
  if (s.type === Network.NetworkStateType.CELLULAR) return 'cellular';
  if (s.type === Network.NetworkStateType.NONE) return 'none';
  return 'unknown';
};

/** The facts of this moment, from the phone. hasProject is given by the caller (it is
 * a server read); the rest is local. Every reader fails soft: unknown, not wrong. */
export async function readFacts(hasProject: boolean, now = new Date()): Promise<Facts> {
  const [state, level, net] = await Promise.all([
    Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN),
    Battery.getBatteryLevelAsync().catch(() => -1),
    Network.getNetworkStateAsync().catch(() => null),
  ]);
  const p = lastPassport();
  return {
    now,
    charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
    net: netKind(net),
    batteryPct: level >= 0 && level <= 1 ? Math.round(level * 100) : null,
    hot: passportHot(p),
    wanted: wantTonight(),
    hasProject,
    hasPassport: !!p,
  };
}
export async function readVerdict(hasProject: boolean, now = new Date()): Promise<Verdict> {
  return evaluate(await readFacts(hasProject, now), nightRules());
}

/** Listens to the plug, the level and the network; re-reads on each change, on return to
 * the foreground and every `everyMs` (the clock moves into or out of the window). */
export function watchConditions(hasProject: () => boolean, onChange: (v: Verdict) => void, everyMs = 30_000): () => void {
  let live = true;
  const read = () => readVerdict(hasProject()).then((v) => live && onChange(v)).catch(() => {});
  read();
  const timer = setInterval(read, everyMs);
  const subs: { remove(): void }[] = [];
  try { subs.push(Battery.addBatteryStateListener(read)); } catch {}
  try { subs.push(Battery.addBatteryLevelListener(read)); } catch {}
  try { subs.push(Network.addNetworkStateListener(read)); } catch {}
  const app = AppState.addEventListener('change', (s) => { if (s === 'active') read(); });
  return () => {
    live = false;
    clearInterval(timer);
    subs.forEach((s) => s.remove());
    app.remove();
  };
}

export function useConditions(hasProject: boolean): Verdict | null {
  const [v, setV] = useState<Verdict | null>(null);
  useEffect(() => watchConditions(() => hasProject, setV), [hasProject]);
  return v;
}
