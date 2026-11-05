import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import { SimulatedWorker } from './SimulatedWorker';
import { LlamaWorker } from './LlamaWorker';
import { ResumableJobs } from './queue';
import { Scheduler, type Phase } from './scheduler';
import { readVerdict, watchConditions } from './conditions';
import { showNightNotification, hideNightNotification } from './notify';
import type { NightStatus } from './NightWorker';
import { hasNative } from '@/llm/native';
import { localModels } from '@/llm/store';
import { endNight, forgetNight, startNight } from '@/data/contribution';
import { sendNightReport } from '@/data/night';
import { kept } from '@/data/friends';
import { lastPassport } from '@/data/passport';
import { nightRules } from '@/data/settings';
import { t } from '@/i18n/core';

// One night for the app, planned by the Scheduler (scheduler.ts) over one of two workers:
// the real one (LlamaWorker, a model on this phone and its peers, the pile kept on the
// phone by ResumableJobs) when the native module and a local model exist, the simulation
// otherwise. The choice is made at every start, so a model downloaded in the evening
// counts that same night. The passport tab shows the status (useNight); the conditions
// (conditions.ts) are read every half minute and on every change of plug, level, network
// or foreground. TONIGHT_KEY remembers which project this night is on.
const sim = new SimulatedWorker();
const real = new LlamaWorker({ source: (key) => new ResumableJobs(key ?? 'tonight') });
export const canRunForReal = () => hasNative() && localModels().length > 0;
const TONIGHT = 'night.project';

export function tonightProject(): string | null {
  return Storage.getItemSync(TONIGHT);
}
export function chooseTonight(slug: string | null) {
  if (slug) Storage.setItemSync(TONIGHT, slug);
  else Storage.removeItemSync(TONIGHT);
}
let hasProject = false;
const project = async () => {
  const slug = tonightProject() ?? (await kept().catch(() => [])).find(() => true)?.slug ?? null;
  hasProject = !!slug;
  return slug;
};

export const scheduler = new Scheduler({
  worker: () => (canRunForReal() ? real : sim),
  verdict: () => readVerdict(hasProject),
  project,
  rules: nightRules,
  now: Date.now,
  tps: () => lastPassport()?.est_tps ?? 1,
  // the passport has no wattage yet; a `watts` field of a newer passport would be read here
  watts: () => {
    const w = Number((lastPassport() as { watts?: unknown } | null)?.watts);
    return w > 0 ? w : null;
  },
  store: { get: (k) => Storage.getItemSync(k), set: (k, v) => Storage.setItemSync(k, v), del: (k) => Storage.removeItemSync(k) },
  startNight: (slug) => startNight(slug).catch(() => null),
  endNight: async (p) => {
    await endNight(p).catch(() => {});
    forgetNight();
  },
  sendReport: sendNightReport,
  notify: {
    show: ({ slug, units }) => showNightNotification(t('night.notify.title'), t('night.notify.body', { slug: slug.replace(/-/g, ' '), n: units })),
    hide: hideNightNotification,
  },
});

// What is the case right now: the conditions, each on its own (kept for callers of the
// first night layer; the verdict's flags say which is missing).
export const conditions = () => readVerdict(hasProject);

export const endNow = () => scheduler.endNow();
export const recheck = () => scheduler.tick().then(() => undefined);

let running = false;
export function startNightWatch() {
  if (running) return;
  running = true;
  // every change of plug, level or network, the foreground, and every half minute
  watchConditions(() => hasProject, () => scheduler.tick().catch(() => {}));
  AppState.addEventListener('change', (st) => {
    if (st === 'active') scheduler.tick().catch(() => {});
  });
}
export type NightView = NightStatus & { phase: Phase };
const view = (): NightView => {
  const { phase, night } = scheduler.state();
  return { ...(night ?? { state: 'idle', slug: null, startedAt: null, tokens: 0, seconds: 0, kwh: 0, tps: 0 }), phase };
};
export function useNight(): NightView {
  const [s, setS] = useState(view);
  useEffect(() => {
    scheduler.tick().catch(() => {});
    return scheduler.subscribe(() => setS(view()));
  }, []);
  return s;
}
