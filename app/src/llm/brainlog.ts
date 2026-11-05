import { useEffect, useState } from 'react';
import Storage from 'expo-sqlite/kv-store';
import type { Plan } from '@/llm/cluster';
import type { Mode } from '@/llm/store';

// The brain's decisions log (5.11.2026): what beyin decided on this phone and why, in the
// order it happened, for the brain tab. The audit ledger (llm/audit.ts) is what the checker
// signed about peers; this is the planner and the dispatcher thinking aloud: how a load was
// planned (who holds how much, who was skipped and why, "alone would be faster"), which
// device a chat went to and at what expected speed, what the night handed out and how the
// known-answer checks came back. Each line carries an i18n key and its values, so the tab
// shows it in the reader's language; detail is data (names, numbers) shown as it is.
// The newest KEEP lines are kept on the phone (kv, brain.log) and survive a restart.

export type BrainKind = 'plan' | 'skip' | 'load' | 'dispatch' | 'retry' | 'night' | 'unit' | 'check' | 'out' | 'error';
export type Tone = 'info' | 'ok' | 'warn' | 'bad';
export type BrainEntry = {
  at: number;
  kind: BrainKind;
  key: string; // brain.* in i18n/parts/brain.ts
  vars?: Record<string, string | number>;
  detail?: string;
  tone: Tone;
};

export const KEEP = 200;
const KEY = 'brain.log';

/** The list with e added at the end, the oldest dropped past keep. Pure. */
export function append(list: BrainEntry[], e: BrainEntry | BrainEntry[], keep = KEEP): BrainEntry[] {
  const next = list.concat(e);
  return next.length > keep ? next.slice(next.length - keep) : next;
}

/**
 * A night's units as one running line per device instead of one line each: the newest run
 * of 'unit' lines at the end of the list is searched for this device's line, which takes the
 * new counts and moves its time on. Anything else in between (a wrong check, a device out)
 * starts a new line, so the order of events stays readable. Pure.
 */
export function tally(list: BrainEntry[], at: number, device: string, add: { n: number; tokens: number; right: number }, keep = KEEP): BrainEntry[] {
  for (let i = list.length - 1; i >= 0 && list[i].kind === 'unit'; i--) {
    const e = list[i];
    if (e.vars?.device !== device) continue;
    const v = e.vars;
    const merged: BrainEntry = { ...e, at, vars: { ...v, n: Number(v.n) + add.n, tokens: Number(v.tokens) + add.tokens, right: Number(v.right) + add.right } };
    return [...list.slice(0, i), merged, ...list.slice(i + 1)];
  }
  return append(list, { at, kind: 'unit', key: 'brain.unit', vars: { device, ...add }, tone: 'ok' }, keep);
}

/** Newest first, at most n. Pure. */
export const latest = (list: BrainEntry[], n = 50): BrainEntry[] => list.slice(-n).reverse();

export type BrainCounts = { total: number; warn: number; bad: number; byKind: Partial<Record<BrainKind, number>> };
export function countOf(list: BrainEntry[]): BrainCounts {
  const c: BrainCounts = { total: list.length, warn: 0, bad: 0, byKind: {} };
  for (const e of list) {
    if (e.tone === 'warn') c.warn++;
    if (e.tone === 'bad') c.bad++;
    c.byKind[e.kind] = (c.byKind[e.kind] ?? 0) + 1;
  }
  return c;
}

const gb = (mb: number) => Math.round((mb / 1024) * 10) / 10;
const tps = (n: number | undefined) => (n && isFinite(n) ? Math.round(n * 10) / 10 : 0);

/** A probe's reason as an i18n key when it is one of ours, else the raw text. */
export function whyKey(why: string): { key: string } | { raw: string } {
  if (why === 'remote') return { key: 'brain.why.remote' };
  if (why === 'nonative') return { key: 'brain.why.nonative' };
  if (/timeout|timed out/i.test(why)) return { key: 'brain.why.timeout' };
  if (/refused|unreachable|no route|ECONN/i.test(why)) return { key: 'brain.why.unreachable' };
  if (/secret|auth|pin|fingerprint|tls/i.test(why)) return { key: 'brain.why.auth' };
  return { raw: why };
}

/**
 * What a finished plan says, as log lines: the decision, then one line per skipped peer.
 * mode alone has no plan; pass devices for apart (the ones that loaded).
 */
export function planEntries(at: number, model: string, mode: Mode, plan: Plan | null, devices: { name: string; tps: number }[] = [], self = 'this phone'): BrainEntry[] {
  const out: BrainEntry[] = [];
  if (mode === 'alone' || !plan) {
    out.push({ at, kind: 'plan', key: 'brain.plan.alone', vars: { model }, tone: 'info' });
    return out;
  }
  if (mode === 'split') {
    const parts = [`${gb(plan.localMb)} gb · ${self.toLowerCase()}`, ...plan.used.map((p) => `${gb(p.assignedMb)} gb · ${p.name.toLowerCase()}`)];
    out.push({ at, kind: 'plan', key: 'brain.plan.split', vars: { model, n: plan.used.length + 1, need: gb(plan.needMb), total: gb(plan.totalMb) }, detail: parts.join('  ·  '), tone: 'info' });
    if (plan.fitsAlone && !plan.used.length) out.push({ at, kind: 'plan', key: 'brain.plan.keptHere', vars: { model }, tone: 'ok' });
    if (plan.aloneFaster) {
      const vs = plan.est && plan.estAlone ? `${tps(plan.est.tps)} vs ${tps(plan.estAlone.tps)} tok/s` : undefined;
      out.push({ at, kind: 'plan', key: 'brain.plan.aloneFaster', detail: vs, tone: 'warn' });
    } else if (plan.est) {
      out.push({ at, kind: 'plan', key: 'brain.plan.expect', vars: { tps: tps(plan.est.tps), load: Math.round(plan.est.loadS), hops: plan.est.hops }, tone: 'info' });
    }
  } else {
    out.push({ at, kind: 'plan', key: 'brain.plan.apart', vars: { model, n: devices.length }, detail: devices.map((d) => `${d.name.toLowerCase()} ~${tps(d.tps)} tok/s`).join('  ·  '), tone: 'info' });
  }
  for (const s of plan.skipped) {
    const w = whyKey(s.why);
    out.push({ at, kind: 'skip', key: 'key' in w ? w.key : 'brain.why.other', vars: { name: s.peer.name.toLowerCase(), why: 'raw' in w ? w.raw : '' }, tone: 'warn' });
  }
  return out;
}

// ---- the log on this phone -----------------------------------------------------------

let log: BrainEntry[] | null = null;
const listeners = new Set<() => void>();
function read(): BrainEntry[] {
  if (log) return log;
  try {
    const raw = Storage.getItemSync(KEY);
    const parsed = raw ? (JSON.parse(raw) as BrainEntry[]) : [];
    log = Array.isArray(parsed) ? parsed : [];
  } catch {
    log = [];
  }
  return log;
}
let saving: ReturnType<typeof setTimeout> | null = null;
function save() {
  // a burst (a night hands out units fast) is written once
  if (saving) return;
  saving = setTimeout(() => {
    saving = null;
    try {
      Storage.setItemSync(KEY, JSON.stringify(log ?? []));
    } catch {}
  }, 500);
}

/** Adds lines to the log. Never throws: the brain thinking aloud must not stop the work. */
export function note(e: BrainEntry | BrainEntry[]) {
  try {
    log = append(read(), e);
    save();
    listeners.forEach((fn) => fn());
  } catch {}
}
/** One finished unit of the night on a device (folded into that device's running line). */
export function noteUnit(at: number, device: string, tokens: number, right: boolean) {
  try {
    log = tally(read(), at, device, { n: 1, tokens, right: right ? 1 : 0 });
    save();
    listeners.forEach((fn) => fn());
  } catch {}
}
export const brainLog = (): BrainEntry[] => read();
export function clearBrainLog() {
  log = [];
  try {
    Storage.removeItemSync(KEY);
  } catch {}
  listeners.forEach((fn) => fn());
}
export function useBrainLog(): BrainEntry[] {
  const [list, setList] = useState(read);
  useEffect(() => {
    const fn = () => setList(read());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return list;
}
