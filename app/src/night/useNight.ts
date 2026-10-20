import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Battery from 'expo-battery';
import NetInfo from '@react-native-community/netinfo';
import Storage from 'expo-sqlite/kv-store';
import { SimulatedWorker, inWindow } from './SimulatedWorker';
import type { NightStatus } from './NightWorker';
import { endNight, forgetNight, startNight } from '@/data/contribution';
import { kept } from '@/data/friends';
import { lastPassport } from '@/data/passport';
import { nightWindow } from '@/data/settings';

// One worker for the app. The passport tab shows its status; the night starts by itself
// when the conditions are met (window, charging, wi-fi when asked, a kept project, a
// passport) and the app is in the foreground, and ends when they stop being met or the
// window closes. The card comes with the end (contribution_end). TONIGHT_KEY remembers
// which project this night is on, so a restart of the app in the night continues it.
const worker = new SimulatedWorker();
const TONIGHT = 'night.project';
const START = 'night.start';
let checking = false;

export function tonightProject(): string | null {
  return Storage.getItemSync(TONIGHT);
}
export function chooseTonight(slug: string | null) {
  if (slug) Storage.setItemSync(TONIGHT, slug);
  else Storage.removeItemSync(TONIGHT);
}

// What is the case right now: the conditions, each on its own.
export async function conditions() {
  const w = nightWindow();
  const [charge, net] = await Promise.all([Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN), NetInfo.fetch().catch(() => null)]);
  return {
    window: inWindow(w.from, w.to),
    charging: charge === Battery.BatteryState.CHARGING || charge === Battery.BatteryState.FULL,
    wifi: !w.wifiOnly || net?.type === 'wifi',
    passport: !!lastPassport(),
  };
}

let started: { id: string | null; jobId: string; at: number; slug: string } | null = null;
async function check(force = false) {
  if (checking) return;
  checking = true;
  try {
    const c = await conditions();
    const slug = tonightProject() ?? (await kept().catch(() => [])).find(() => true)?.slug ?? null;
    const s = worker.status();
    const ok = c.window && c.charging && c.wifi && c.passport && !!slug;
    if (ok && s.state !== 'running') {
      const p = lastPassport();
      const r = await startNight(slug!).catch(() => null);
      if (!r) return;
      started = { ...r, slug: slug! };
      Storage.setItemSync(START, JSON.stringify(started));
      worker.start(slug!, p?.est_tps ?? 1);
    } else if (!ok && s.state === 'running') {
      await finish();
    } else if (!ok && s.state !== 'running') {
      worker.wait(!slug ? 'noproject' : !c.passport ? 'nopassport' : !c.window ? 'window' : !c.charging ? 'charge' : 'wifi');
    }
    void force;
  } finally {
    checking = false;
  }
}
async function finish() {
  const s = worker.status();
  worker.stop();
  const st = started ?? (JSON.parse(Storage.getItemSync(START) ?? 'null') as typeof started);
  if (!st) return;
  started = null;
  Storage.removeItemSync(START);
  await endNight({ contributionId: st.id, startId: st.jobId, startedAt: st.at, slug: st.slug, tokens: s.tokens, seconds: s.seconds, kwh: s.kwh }).catch(() => {});
  forgetNight();
  worker.reset();
}
// "end the night now": the morning by hand.
export const endNow = () => (worker.status().state === 'running' ? finish() : Promise.resolve());

let running = false;
export function startNightWatch() {
  if (running) return;
  running = true;
  check().catch(() => {});
  setInterval(() => check().catch(() => {}), 30_000);
  AppState.addEventListener('change', (st) => {
    if (st === 'active') check().catch(() => {});
  });
  try {
    Battery.addBatteryStateListener(() => check().catch(() => {}));
  } catch {
    /* the web has no battery listener */
  }
}
export function useNight(): NightStatus {
  const [s, setS] = useState(worker.status());
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      check().catch(() => {});
    }
    return worker.subscribe(setS);
  }, []);
  return s;
}
export const recheck = () => check(true);
