import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Battery from 'expo-battery';
import { router } from 'expo-router';
import { GodsEye, sameAction, type BranchId, type BranchMaker, type EyeCard, type EyeView } from '@godseye/core';
import { lastPassport } from '@/data/passport';
import { getLang, t, translator } from '@/i18n/core';
import { verifyChain } from '@/llm/audit';
import { brainLog, latest } from '@/llm/brainlog';
import { CATALOG } from '@/llm/catalog';
import { probeAll } from '@/llm/cluster';
import { engine, load, unload, useEngine } from '@/llm/engine';
import { hasNative, llama } from '@/llm/native';
import { describe, localModels, peers as savedPeers, settings, startDownload } from '@/llm/store';
import { clusterReport, deviceReport, hostCheck } from '@/llm/trust';
import { trustNotes } from '@/llm/trustStore';
import { passportHot } from '@/night/conditions';
import { listTasks } from '@/tasks/store';
import { LeftOut, route, type PhoneAct, type PhoneEnv } from './apply';
import { kvNotes } from './notes';
import { phoneSnapshot, type PhoneInput, type Power, type Reach } from './snapshot';
import { phoneTrust } from './trustBranch';

// god's eye on the phone (11.11.2026): the twelve branches, the same source as kula-node's
// (node/src/godseye, through @godseye/core), fed the phone's own look (snapshot.ts) every 5 s like
// the computer's. It runs only while the app is in the foreground and something wants it: the
// brain tab on screen, or a cluster this phone runs (a model apart or split, or a load under way);
// in the background it pauses and nothing is read. The notes live in the kv-store (notes.ts); the
// black box stays on the computer. The eye only watches: a card is carried out by the person's
// tap (applyCard), through the phone's engine (apply.ts).

export const EYE_EVERY_MS = 5000;
const SIDE_EVERY_MS = 30_000;   // battery, heat and this phone's ledger: slower than a look
const LEDGER = 200;
const DECISIONS = 20;

const thisName = () => lastPassport()?.device ?? 'this phone';

// ---- what is read in the background, the look takes the latest

const side = {
  freeMb: null as number | null,
  workerId: null as string | null,
  ledger: null as PhoneInput['ledger'],
  chain: null as { ok: boolean; lines: number } | null,
  power: null as Power | null,
  slowAt: 0,
};
const reach: Record<string, Reach> = {};
const since = { key: '', loaded: null as number | null, loading: null as number | null };

function readSide(now: number) {
  if (!hasNative()) return;
  llama!.info().then((i) => { side.freeMb = i.ramFreeMb; side.workerId = i.workerId; }, () => {});
  if (now - side.slowAt < SIDE_EVERY_MS) return;
  side.slowAt = now;
  llama!.auditLedger(LEDGER).then((lines) => {
    const c = verifyChain(lines);
    side.chain = { ok: c.ok, lines: lines.length };
    side.ledger = lines.length ? { ok: c.ok, count: lines.length, problem: c.ok ? null : `line ${(c.broken ?? 0) + 1} of the last ${lines.length} does not follow the one before` } : null;
  }, () => {});
  Promise.all([Battery.getBatteryLevelAsync().catch(() => -1), Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN)]).then(([level, state]) => {
    side.power = {
      battery: level >= 0 && level <= 1 ? Math.round(level * 100) : null,
      charging: state === Battery.BatteryState.UNKNOWN ? null : state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
      hot: lastPassport() ? passportHot(lastPassport()) : null,
    };
  }, () => {});
}

/** when the model now loaded (or loading) began, kept across looks */
function track(now: number) {
  const e = engine();
  const key = e.model ? `${e.model.id}:${e.mode}:${e.loading ? 'loading' : 'loaded'}` : '';
  if (key === since.key) return;
  since.key = key;
  since.loading = e.model && e.loading ? now : null;
  since.loaded = e.model && !e.loading ? now : null;
}

const en = translator('en');
/** The phone's look, gathered from the app. */
export function readPhone(now = Date.now()): PhoneInput {
  track(now);
  return {
    at: now,
    name: thisName(),
    freeMb: side.freeMb,
    ledger: side.ledger,
    power: side.power,
    engine: engine(),
    since: { loaded: since.loaded, loading: since.loading },
    peers: savedPeers(),
    reach,
    trust: trustNotes(),
    models: localModels(),
    catalog: CATALOG,
    tasks: listTasks(),
    // the branches speak english on both homes; the phone's decisions log keeps i18n keys
    decisions: latest(brainLog(), DECISIONS).reverse().map((e) => ({ at: e.at, text: [en.tx(e.key, e.key, e.vars), e.detail].filter(Boolean).join(': ') })),
    llama: hasNative(),
  };
}

const trustReport = () => {
  const notes = trustNotes();
  return clusterReport(savedPeers().map((p) => deviceReport(p, notes[p.id] ?? null)), hostCheck(side.chain));
};

// ---- the eye

let eye: GodsEye | null = null;
let view: EyeView | null = null;
let testMakers: Partial<Record<BranchId, BranchMaker>> = {};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

function theEye(): GodsEye {
  eye ??= new GodsEye({
    snapshot: () => phoneSnapshot(readPhone()),
    notes: kvNotes,
    keys: null,   // the phone's trust branch reads its native-verified report instead (trustBranch.ts)
    makers: { trust: phoneTrust({ report: trustReport, tx: () => translator(getLang()).tx, self: () => translator(getLang()).t('brain.this') }), ...testMakers },
  });
  return eye;
}

/** One look: the background reads started for the next one, the branches, the view. */
export function look(): EyeView {
  const e = theEye();
  readSide(Date.now());
  e.tick();
  view = e.view();
  notify();
  return view;
}

// ---- when it runs: foreground, and someone holding it

const holders = new Set<string>();
let active = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
let timer: ReturnType<typeof setInterval> | null = null;
let appSub: { remove(): void } | null = null;

export const eyeRunning = () => timer !== null;

function sync() {
  const want = holders.size > 0 && active;
  if (want && !timer) {
    look();
    timer = setInterval(look, EYE_EVERY_MS);
  } else if (!want && timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!holders.size && appSub) { appSub.remove(); appSub = null; }
}

/** The eye runs while anyone holds it and the app is in the foreground; returns the release. */
export function holdEye(who: string): () => void {
  if (!appSub) {
    appSub = AppState.addEventListener('change', (s: AppStateStatus) => {
      active = s === 'active';
      sync();
    });
  }
  holders.add(who);
  sync();
  return () => {
    holders.delete(who);
    sync();
  };
}

/** The tabs hold the eye while this phone runs a cluster: a model apart or split, or a load under way. */
export function useClusterEye() {
  const e = useEngine();
  const cluster = !!e.loading || (!!e.model && e.mode !== 'alone');
  useEffect(() => (cluster ? holdEye('cluster') : undefined), [cluster]);
}

/** The eye's view, new after every look (null before the first). */
export function useEyeView(): EyeView | null {
  const [v, setV] = useState(view);
  useEffect(() => {
    const fn = () => setV(view);
    listeners.add(fn);
    fn();
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return v;
}

// ---- the cards: the person's tap, carried out by the phone's engine

export const phoneEnv: PhoneEnv = {
  native: hasNative(),
  models: localModels,
  catalog: CATALOG,
  peers: savedPeers,
  selfIds: () => ['me', ...(side.workerId ? [side.workerId] : [])],
  busy: () => !!engine().loading,
  loaded: () => !!engine().model,
  ctx: () => settings().ctx,
  // the other devices the loaded model really uses: apart drops a peer that failed and still resolves
  load: async (m, mode, ctx, peers) => {
    await load(m, mode, ctx, peers);
    const s = engine();
    return mode === 'split' ? (s.plan?.used ?? []).map((p) => p.id) : s.devices.filter((d) => !d.local).map((d) => d.id);
  },
  unload,
  fetch: (c) => startDownload(describe(c)),
  probe: async (list) => {
    const r = await probeAll(list, 'api');
    const at = Date.now();
    for (const p of r.ok) reach[p.id] = { ok: true, at, why: null };
    for (const b of r.bad) reach[b.peer.id] = { ok: false, at, why: b.why };
    return { ok: r.ok.length, bad: r.bad.length };
  },
  open: (to) => router.push(to),
  openBranch: (b) => router.push({ pathname: '/branch/[id]', params: { id: b } }),
};

/** What a tap on this card would do on the phone, or null: no button. */
export const actOf = (c: EyeCard, env: PhoneEnv = phoneEnv): PhoneAct | null => route(c.action, env);

/** Carries a card out; the card is hidden while its branch still says it. Throws what failed.
 *  [shown] is the action the person saw: when the card now says another (a device joined between
 *  showing and pressing), nothing runs and it throws 'changed', like the computer's brain/apply 409.
 *  An open card only moves the page and needs no match.
 *  A load card (finding D2) is hidden while its load runs, like the computer's; a load that throws,
 *  or an apart load that left out every device the card named, shows it again (eye.unhide, written
 *  in the box as apply-failed) and the tap says why. Nothing retries: only the person's next tap loads. */
export async function applyCard(id: string, shown: unknown, env: PhoneEnv = phoneEnv): Promise<string> {
  const e = theEye();
  const c = e.card(id);
  if (!c) throw new Error('gone');
  if (c.action?.do !== 'open' && !sameAction(shown, c.action)) throw new Error('changed');
  const act = route(c.action, env);
  if (!act) throw new Error('not here');
  const fresh = () => { view = e.view(); notify(); };
  const loading = c.action?.do === 'load' ? c.action : null;
  if (loading) {
    e.applied(c.id, `loading ${loading.model} (${loading.mode})`);
    fresh();
  }
  let word: string;
  try {
    word = await act.run();
  } catch (err) {
    if (!loading) throw err;
    const left = err instanceof LeftOut ? err : null;
    e.unhide(c.id, left ? `every device was left out: ${left.leftOut.join(', ')}` : `the load failed: ${(err as Error)?.message ?? String(err)}`, loading);
    fresh();
    throw left ? new Error(t('eye.card.leftOut', { list: left.leftOut.join(', '), model: left.model })) : err;
  }
  if (!loading) e.applied(c.id, word);
  fresh();
  return word;
}

export function dismissCard(id: string): boolean {
  const e = theEye();
  const ok = e.dismiss(id);
  view = e.view();
  notify();
  return ok;
}

/** A branch's page asked for: the branch's view as of the last look. */
export const branchOf = (v: EyeView | null, id: BranchId) => v?.branches.find((b) => b.id === id) ?? null;

/** For tests: a fresh eye, nothing held; [makers] stand in for branches. */
export function resetEye(makers: Partial<Record<BranchId, BranchMaker>> = {}) {
  testMakers = makers;
  if (timer) clearInterval(timer);
  timer = null;
  holders.clear();
  appSub?.remove();
  appSub = null;
  eye = null;
  view = null;
  since.key = '';
  for (const k of Object.keys(reach)) delete reach[k];
  Object.assign(side, { freeMb: null, workerId: null, ledger: null, chain: null, power: null, slowAt: 0 });
}
