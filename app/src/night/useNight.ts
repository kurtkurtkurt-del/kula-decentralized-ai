import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Battery from 'expo-battery';
import NetInfo from '@react-native-community/netinfo';
import Storage from 'expo-sqlite/kv-store';
import { SimulatedWorker, inWindow } from './SimulatedWorker';
import { LlamaWorker } from './LlamaWorker';
import type { NightStatus } from './NightWorker';
import { hasNative } from '@/llm/native';
import { localModels } from '@/llm/store';
import { endNight, forgetNight, startNight } from '@/data/contribution';
import { kept } from '@/data/friends';
import { lastPassport } from '@/data/passport';
import { nightWindow } from '@/data/settings';

// One worker for the app. The passport tab shows its status; the night starts by itself
// when the conditions are met (window, charging, wi-fi when asked, a kept project, a
// passport) and the app is in the foreground, and ends when they stop being met or the
// window closes. The card comes with the end (contribution_end). TONIGHT_KEY remembers
// which project this night is on, so a restart of the app in the night continues it.
//
// Two workers, one active at a time (5.11.2026): the real one when the native module and
// a local model exist, the simulation otherwise. The choice is made when a night starts,
// so a model downloaded in the evening counts that same night.
const sim = new SimulatedWorker();
const real = new LlamaWorker();
let worker: SimulatedWorker | LlamaWorker = sim;
export const canRunForReal = () => hasNative() && localModels().length > 0;
function pickWorker() {
  const next = canRunForReal() ? real : sim;
  if (next !== worker) {
    worker.reset();
    worker = next;
  }
  return worker;
}
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
      pickWorker().start(slug!, p?.est_tps ?? 1);
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
  // units, checked and wrong ride along in the job; the rpc reads only tokens, seconds, kwh
  await endNight({ contributionId: st.id, startId: st.jobId, startedAt: st.at, slug: st.slug, tokens: s.tokens, seconds: s.seconds, kwh: s.kwh, units: s.units ?? 0, checked: s.checked ?? 0, wrong: s.wrong ?? 0, model: s.model ?? null }).catch(() => {});
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
    // both workers report; only the active one's word counts
    const offs = [sim, real].map((w) => w.subscribe((st) => { if (w === worker) setS(st); }));
    return () => offs.forEach((off) => off());
  }, []);
  return s;
}
export const recheck = () => check(true);
