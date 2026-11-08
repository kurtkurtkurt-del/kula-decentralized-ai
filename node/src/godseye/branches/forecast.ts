// 3 forecast: when will each device be there tonight, and how fast will it be. Simple counting,
// nothing clever yet (the learning loop will tune it later):
//  - every look, per device and hour of the day (0..23, this computer's clock): one more look, and
//    one more "there" when it was active (reachable, and plugged in if it is on a cable). Tonight
//    (22:00–07:00) = the share of "there" over those nine hours. 60% or more: likely; under 40%:
//    unlikely; between: maybe; fewer than MIN_TONIGHT looks in them: no guess yet.
//  - per device and model file: an exponentially weighted average of the tok/s it answered with,
//    sampled when its answer count grows (or the first time a speed is seen).
// Its notes are one small json (ctx.save), bounded: at most MAX_DEVICES devices, MAX_MODELS
// models each, a bucket halves once it holds BUCKET_CAP looks. Saved at most once a minute.
// A feed line only when a device's tonight guess flips from likely to unlikely or back.
import type { Branch, BranchCtx, BranchView, Snapshot } from '../types.js';
import { active } from './util.js';

export const TONIGHT = [22, 23, 0, 1, 2, 3, 4, 5, 6];   // 22:00–07:00
const LIKELY = 0.6;
const UNLIKELY = 0.4;
const MIN_TONIGHT = 12;          // looks in tonight's hours before it guesses (one minute of looks)
const MIN_HOUR = 12;             // looks in an hour before that hour counts as seen (the gauge)
const LEARNING = 120;            // under this many looks in all: "still learning"
const ALPHA = 0.3;               // weight of a new tok/s sample
const BUCKET_CAP = 2000;         // a bucket halves past this, so old habits fade
const MAX_DEVICES = 40;
const MAX_MODELS = 8;
const SAVE_EVERY_MS = 60_000;

type Guess = 'likely' | 'maybe' | 'unlikely' | 'unknown';

interface Speed { name: string; avg: number; n: number; at: number }
interface DevNotes {
  name: string;
  seen: number;                  // ms, the last look it was in
  h: [number, number][];         // 24 hours of the day: [looks, there]
  tps: Record<string, Speed>;    // by model file
  last?: 'likely' | 'unlikely';  // the last firm tonight guess (for the feed)
}
export interface ForecastNotes { v: 1; looks: number; since: number | null; dev: Record<string, DevNotes> }

const fresh = (): ForecastNotes => ({ v: 1, looks: 0, since: null, dev: {} });
const hours = (): [number, number][] => Array.from({ length: 24 }, () => [0, 0] as [number, number]);

/** notes read back from disk, or fresh ones when they are not what this file wrote */
function sane(x: unknown): ForecastNotes {
  const n = x as ForecastNotes;
  if (!n || n.v !== 1 || typeof n.looks !== 'number' || !n.dev || typeof n.dev !== 'object') return fresh();
  for (const [id, d] of Object.entries(n.dev)) {
    const ok = d && typeof d.name === 'string' && typeof d.seen === 'number' && Array.isArray(d.h) && d.h.length === 24
      && d.h.every((b) => Array.isArray(b) && typeof b[0] === 'number' && typeof b[1] === 'number')
      && typeof d.tps === 'object' && d.tps != null && Object.values(d.tps).every((s) => s && typeof s.avg === 'number');
    if (!ok) delete n.dev[id];
  }
  return n;
}

export function tonight(d: DevNotes): { looks: number; there: number; share: number | null; guess: Guess } {
  let looks = 0, there = 0;
  for (const h of TONIGHT) { looks += d.h[h][0]; there += d.h[h][1]; }
  if (looks < MIN_TONIGHT) return { looks, there, share: null, guess: 'unknown' };
  const share = there / looks;
  return { looks, there, share, guess: share >= LIKELY ? 'likely' : share < UNLIKELY ? 'unlikely' : 'maybe' };
}

const fmtTps = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));

export function create(ctx: BranchCtx): Branch {
  const notes = sane(ctx.load<unknown>(null));
  let snap: Snapshot | null = null;
  let lastSave = ctx.now();
  const lastDone = new Map<string, number>();   // device|file -> answers, this run only

  function trim() {
    const ids = Object.keys(notes.dev);
    if (ids.length > MAX_DEVICES) {
      ids.sort((a, b) => notes.dev[b].seen - notes.dev[a].seen);
      for (const id of ids.slice(MAX_DEVICES)) delete notes.dev[id];
    }
  }

  function noteSpeed(d: DevNotes, file: string, name: string, tps: number, at: number) {
    const s = d.tps[file];
    if (s) { s.avg = s.avg + ALPHA * (tps - s.avg); s.n++; s.at = at; s.name = name; }
    else d.tps[file] = { name, avg: tps, n: 1, at };
    const files = Object.keys(d.tps);
    if (files.length > MAX_MODELS) {
      files.sort((a, b) => d.tps[b].at - d.tps[a].at);
      for (const f of files.slice(MAX_MODELS)) delete d.tps[f];
    }
  }

  return {
    id: 'forecast',
    observe(now) {
      snap = now;
      const hour = new Date(now.at).getHours();
      for (const dev of now.devices) {
        if (dev.reachable == null) continue;            // not looked at yet: says nothing
        const d = (notes.dev[dev.id] ??= { name: dev.name, seen: now.at, h: hours(), tps: {} });
        d.name = dev.name;
        d.seen = now.at;
        const b = d.h[hour];
        b[0]++;
        if (active(dev)) b[1]++;
        if (b[0] > BUCKET_CAP) { b[0] = Math.round(b[0] / 2); b[1] = Math.round(b[1] / 2); }
        const t = tonight(d);
        if ((t.guess === 'likely' || t.guess === 'unlikely') && t.guess !== d.last) {
          if (d.last) ctx.emit(`forecast: ${dev.name} is now ${t.guess} tonight 22–07 (${Math.round(t.share! * 100)}% of ${t.looks} past looks)`);
          d.last = t.guess;
        }
      }
      notes.looks++;
      notes.since ??= now.at;

      const L = now.work.loaded;
      if (L) {
        for (const ld of L.devices) {
          if (ld.tps == null || !(ld.tps > 0)) continue;
          const key = `${ld.id}|${L.model.file}`;
          const before = lastDone.get(key);
          if (before === undefined || ld.done > before) {
            const d = (notes.dev[ld.id] ??= { name: ld.name, seen: now.at, h: hours(), tps: {} });
            noteSpeed(d, L.model.file, L.model.name, ld.tps, now.at);
          }
          lastDone.set(key, ld.done);
        }
      }
      trim();
      const t = ctx.now();
      if (t - lastSave >= SAVE_EVERY_MS) { ctx.save(notes); lastSave = t; }
    },
    view(): BranchView {
      const current = new Map((snap?.devices ?? []).map((d) => [d.id, d]));
      const ids = Object.keys(notes.dev).filter((id) => current.has(id) || notes.dev[id].h.some((h) => h[0] > 0));
      const rated = ids.map((id) => ({ id, d: notes.dev[id], t: tonight(notes.dev[id]) }))
        .sort((a, b) => (b.t.share ?? -1) - (a.t.share ?? -1) || a.d.name.localeCompare(b.d.name));
      const likely = rated.filter((r) => r.t.guess === 'likely').length;
      const seenHours = Array.from({ length: 24 }, (_, h) => ids.some((id) => notes.dev[id].h[h][0] >= MIN_HOUR)).filter(Boolean).length;
      const learning = notes.looks < LEARNING;

      const lines = rated.map(({ id, d, t }) => {
        const when = t.guess === 'unknown' ? 'tonight 22–07: no looks then yet' : `tonight 22–07: ${t.guess} (${Math.round(t.share! * 100)}% of past looks)`;
        const holds = current.get(id)?.holds ?? null;
        const speeds = Object.entries(d.tps);
        const best = (holds && d.tps[holds] ? [holds, d.tps[holds]] as const : null)
          ?? speeds.sort((a, b) => b[1].n - a[1].n || b[1].at - a[1].at)[0] ?? null;
        const speed = best ? ` · ~${fmtTps(best[1].avg)} tok/s on ${best[1].name}` : '';
        return `${d.name} · ${when}${speed}`;
      });

      return {
        built: true,
        stat: learning ? `still learning: ${notes.looks} look${notes.looks === 1 ? '' : 's'} so far`
          : `${rated.length} device${rated.length === 1 ? '' : 's'} · tonight ${likely} likely`,
        gauge: Math.round((seenHours / 24) * 100),
        rows: [
          ['looks so far', String(notes.looks)],
          ['hours of the day seen', `${seenHours} of 24`],
          ['tonight', '22:00–07:00 · likely: there in 60% or more of past looks · unlikely: under 40%'],
        ],
        lines,
        note: learning
          ? `still learning: ${notes.looks} look${notes.looks === 1 ? '' : 's'} so far; a guess needs a few minutes of looks in tonight's hours.`
          : rated.length ? undefined : 'no device seen yet.',
        what: 'guesses when each device is there tonight (22–07) from how often it answered at those hours before, and how fast it will be from the tok/s it answered with.',
      };
    },
  };
}
