// 3 forecast: when will each device be there tonight, and how fast will it be. A decayed
// beta-binomial per device and hour of the week:
//  - slot = hour of the week, 0..167 = day (0 = sunday, local clock of snapshot.at) * 24 + hour.
//    While the slot of snapshot.at stays the same, accumulate per device cur = { slot, looks, there }
//    (there: util.active(dev); a look with reachable == null says nothing and is skipped). When a
//    look falls in another slot (or the same slot number but more than one hour later), fold the
//    finished one: if cur.looks >= 12, x = there/looks is ONE observation of weight 1 for that slot:
//    with dtWeeks = max(0, (tFold - slot.t) / (7*24*3600*1000)) and d = 0.5 ** (dtWeeks / HALF_LIFE_WEEKS),
//    HALF_LIFE_WEEKS = 4:  n = n*d + 1;  s = s*d + x;  slot.t = tFold.  Fewer than 12 looks: dropped.
//    A backward clock jump of more than an hour observes the same real hours again as new observations.
//  - device prior: N = sum of n over its slots, S = sum of s; p0 = (S + 0.5) / (N + 1).
//    K = 4 pseudo-observations: a = K*p0, b = K*(1-p0).
//  - slot estimate: mean = (a + s) / (K + n). Interval (80%): wilson on p = mean with
//    m = K + n, z = 1.2816: centre = (p + z*z/(2m)) / (1 + z*z/m);
//    half = z*sqrt(p*(1-p)/m + z*z/(4*m*m)) / (1 + z*z/m); lo = max(0, centre-half),
//    hi = min(1, centre+half).
//  - tonight = the nine slots 22:00..06:00 of the night that starts on snapshot.at's day (after
//    midnight and before 07:00: the night already running). tonight.mean = the average of the slot
//    means, lo/hi = the average of the slot lo/hi; known = Math.round(N * 10) / 10 >= 3 (the value
//    as shown: three folded hours are known, "3 of 3" can never say not enough), else guess
//    'unknown' and the line says "not enough recent hours yet (N of 3)".
//    guess: mean >= 0.6 likely, < 0.4 unlikely, else maybe. When none of tonight's nine slots has
//    n > 0 the guess stands but the line says ", from daytime only". The stat counts only devices
//    in the current snapshot, and says "no known device here now" when none of them is known while
//    a gone one has a guess, or when none of them has a recent hour shown while a gone one has;
//    a device gone from it keeps its line with "last seen today" (the same local date), "last seen
//    yesterday" (the day before) or "last seen N days ago" (whole calendar days, "over a year ago"
//    past 365) and is listed after the present ones. view() before the first look reads the notes
//    at the newest seen and shows no "last seen" suffix.
//  - when tonight is read, every slot's n and s decay to the look's time first (same
//    d = 0.5 ** (dtWeeks / HALF_LIFE_WEEKS), dt never negative) and are not written back, so a
//    device that went quiet fades from the estimate and from the prior.
//  - per device and model file: an exponentially weighted average of the tok/s it answered with,
//    sampled when its answer count grows (or the first time a speed is seen); a speed over
//    MAX_TPS is not a measurement and is dropped.
//  - a clock far forward: a look more than 8 weeks after the last good one is not trusted on its
//    own: it neither folds nor advances any time and is not counted; once two looks in a row agree
//    on the new time the last good look re-anchors there and looks count again. A fold whose
//    slot.t is later than the look folds with dt = 0 and rewrites slot.t, and a cur stamped by a
//    far-forward clock is folded and re-anchored too, so later hours fold normally.
// The snapshot is not trusted: its arrays and entries are checked field by field (a wrong type or
// an absurd number is skipped, never thrown) through one helper used by observe and view both, and
// device ids and model files are keys in null-prototype objects, so "__proto__" and friends cannot
// pollute anything. Ids over MAX_ID chars are skipped, a non-string name falls back to the id,
// names are cut to NAME_LEN; every number in a line goes through one formatter.
// Its notes are one small json (ctx.save), bounded: at most MAX_DEVICES devices, MAX_MODELS
// models each, one entry per seen hour of the week (168). Notes with v: 1 on disk are not
// converted: only the tok/s averages are carried over (the availability held a few days of
// over-counted 5 s looks), the availability starts fresh. Saved at most once a minute.
//  - every folded hour is scored for the learning branch: just before the fold, what the slot and
//    the prior said then (decayed to the fold time) against x, kept as the last MAX_PAIRS pairs per
//    device, only while the device is known (the view's own rule), and handed over in the view.
// A feed line only when a device's tonight guess flips from likely to unlikely or back.
import type { Branch, BranchCtx, BranchView, EyeDevice, Snapshot } from '../types.js';
import { active } from './util.js';

export const HALF_LIFE_WEEKS = 4;    // a slot's past halves this many weeks without a look there
export const SLOTS = 168;            // hours of the week
const HOUR_MS = 3600_000;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const PRIOR_K = 4;                   // pseudo-observations of the device's own rate
const Z = 1.2816;                    // the 80% interval's z
const LIKELY = 0.6;
const UNLIKELY = 0.4;
const MIN_HOUR = 12;                 // looks in an hour before it folds into its slot
const MIN_SLOTS = 3;                 // folded hours for a device before it guesses tonight
const ALPHA = 0.3;                   // weight of a new tok/s sample
const MAX_DEVICES = 40;
const MAX_MODELS = 8;
const MAX_PAIRS = 200;             // scored hours kept per device
const SAVE_EVERY_MS = 60_000;
const MAX_AT = 8.64e15;              // ms: a snapshot.at beyond this is absurd
const MAX_TPS = 100_000;             // tok/s beyond this is not a measurement
const FAR_MS = 8 * WEEK_MS;          // a look this far ahead of the last good one is not trusted on its own
const MAX_ID = 200;                  // an id or file longer than this is not usable as a key
const NAME_LEN = 80;                 // names shown are cut to this
const MAX_N = 1e4;                   // a slot's decayed count beyond this is not plausible
const MAX_LOOKS = 1e9;               // looks beyond this is not plausible (5 s looks for decades)
const DAY_MS = 86400_000;            // a whole day, for "last seen N days ago"

type Guess = 'likely' | 'maybe' | 'unlikely' | 'unknown';

interface Speed { name: string; avg: number; n: number; at: number }
/** one unfinished hour of the week, folded into its slot only once it is over */
interface Cur { slot: number; looks: number; there: number; t: number }
/** one finished hour, scored: what the branch believed just before the fold, against what happened */
interface Pair { t: number; p: number; lo: number; hi: number; p0: number; x: number }
interface DevNotes {
  name: string;
  seen: number;                                       // ms, the last look it was in
  slots: Record<string, [number, number, number]>;    // hour of the week -> [n, s, t]
  cur: Cur | null;                                    // the hour being counted now
  tps: Record<string, Speed>;                         // by model file
  pairs: Pair[];                                      // the last MAX_PAIRS scored hours, oldest first
  last?: 'likely' | 'unlikely';                       // the last firm tonight guess (for the feed)
}
export interface ForecastNotes {
  v: 2;
  looks: number;
  since: number | null;                               // ms, the first look
  lastGood: number | null;                            // ms, the last look trusted as data
  dev: Record<string, DevNotes>;
}

export interface SlotStats { n: number; s: number; t: number }

/** slot = hour of the week, 0..167 = day (0 = sunday, this computer's clock) * 24 + hour */
export function slotOf(at: number): number {
  const d = new Date(at);
  return d.getDay() * 24 + d.getHours();
}

/** one observation x of weight 1 into a slot, after its past decayed:
 *  dtWeeks = max(0, (tFold - slot.t) / (7*24*3600*1000)); d = 0.5 ** (dtWeeks / HALF_LIFE_WEEKS);
 *  n = n*d + 1; s = s*d + x; slot.t = tFold. */
export function fold(slot: SlotStats, x: number, tFold: number): SlotStats {
  const dtWeeks = Math.max(0, (tFold - slot.t) / WEEK_MS);
  const d = 0.5 ** (dtWeeks / HALF_LIFE_WEEKS);
  return { n: slot.n * d + 1, s: slot.s * d + x, t: tFold };
}

/** a slot's n and s decayed to `at` (for reading, not written back):
 *  dtWeeks = max(0, (at - slot.t) / (7*24*3600*1000)); d = 0.5 ** (dtWeeks / HALF_LIFE_WEEKS);
 *  n = n*d; s = s*d. */
export function decay(slot: SlotStats, at: number): SlotStats {
  const dtWeeks = Math.max(0, (at - slot.t) / WEEK_MS);
  const d = 0.5 ** (dtWeeks / HALF_LIFE_WEEKS);
  return { n: slot.n * d, s: slot.s * d, t: slot.t };
}

/** the device's own rate across everything it was seen doing:
 *  N = sum of n over its slots, S = sum of s; p0 = (S + 0.5) / (N + 1);
 *  K = 4 pseudo-observations: a = K*p0, b = K*(1-p0). */
export function prior(slots: Iterable<SlotStats>): { N: number; S: number; p0: number; a: number; b: number } {
  let N = 0, S = 0;
  for (const st of slots) { N += st.n; S += st.s; }
  const p0 = (S + 0.5) / (N + 1);
  const a = PRIOR_K * p0, b = PRIOR_K * (1 - p0);
  return { N, S, p0, a, b };
}

/** the 80% wilson interval for a share p seen m times:
 *  centre = (p + z*z/(2m)) / (1 + z*z/m);
 *  half = z*sqrt(p*(1-p)/m + z*z/(4*m*m)) / (1 + z*z/m); lo = max(0, centre-half),
 *  hi = min(1, centre+half). */
export function wilson(p: number, m: number, z: number): { lo: number; hi: number } {
  const zz = z * z;
  const centre = (p + zz / (2 * m)) / (1 + zz / m);
  const half = z * Math.sqrt(p * (1 - p) / m + zz / (4 * m * m)) / (1 + zz / m);
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** a slot's estimate from the device prior a and the slot's own n looks with s there:
 *  mean = (a + s) / (K + n), and the 80% wilson interval around it (m = K + n). */
export function estimate(a: number, s: number, n: number, k: number, z = Z): { mean: number; lo: number; hi: number } {
  const m = k + n;
  const mean = (a + s) / m;
  return { mean, ...wilson(mean, m, z) };
}

/** the nine slots of the night that starts on `at`'s day, 22:00..06:00 (after midnight and before
 *  07:00 that is the night already running, which started the day before). */
export function tonightSlots(at: number): number[] {
  const d = new Date(at);
  const day = d.getHours() < 7 ? (d.getDay() + 6) % 7 : d.getDay();
  const next = (day + 1) % 7;
  return [22, 23].map((h) => day * 24 + h).concat([0, 1, 2, 3, 4, 5, 6].map((h) => next * 24 + h));
}

/** the local calendar day an ms falls on, as a whole day number: Date.UTC of its local year, month
 *  and date / one day, so the hour does not matter and a 23 or 25 hour DST day still counts once. */
export function dayOf(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
}

const fresh = (): ForecastNotes => ({ v: 2, looks: 0, since: null, lastGood: null, dev: Object.create(null) });

const okNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** the value as shown in a line: one decimal, whole numbers plain ("1", not "1.0"). The known
 *  threshold compares this same value, so the line and the guess can never contradict. */
const fmtN = (x: number) => {
  const r = Math.round(x * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
const fmtPct = (x: number) => Math.round(x * 100);
const fmtTps = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));

/** one speed entry, checked and cut; null when it is not usable */
function okSpeed(f: string, e: unknown): Speed | null {
  if (f.length === 0 || f.length > MAX_ID) return null;
  const sp = e as any;
  if (!sp || typeof sp !== 'object' || typeof sp.name !== 'string') return null;
  if (!okNum(sp.avg) || !okNum(sp.n) || !okNum(sp.at)) return null;
  if (!(sp.avg > 0) || sp.avg > MAX_TPS || sp.n < 1 || sp.at < 0 || sp.at > MAX_AT) return null;
  return { name: sp.name.slice(0, NAME_LEN), avg: sp.avg, n: sp.n, at: sp.at };
}

/** notes read back from disk, or fresh ones when they are not what this file wrote. Devices,
 *  slots and tps are rebuilt as null-prototype objects, so a "__proto__" key from the file cannot
 *  pollute. */
function sane(x: unknown): ForecastNotes {
  const n = x as any;                                  // untrusted input, checked field by field below
  if (!n || typeof n !== 'object' || !n.dev || typeof n.dev !== 'object' || Array.isArray(n.dev)) return fresh();
  if (n.v === 1) {
    // v: 1 held a few days of over-counted 5 s looks: only the tok/s averages are carried over,
    // the availability starts fresh
    const dev = Object.create(null) as Record<string, DevNotes>;
    for (const [id, d] of Object.entries(n.dev) as [string, any][]) {
      if (id.length === 0 || id.length > MAX_ID) continue;
      if (!d || typeof d !== 'object' || !d.tps || typeof d.tps !== 'object' || Array.isArray(d.tps)) continue;
      const tps = Object.create(null) as Record<string, Speed>;
      for (const [f, e] of Object.entries(d.tps)) {
        const sp = okSpeed(f, e);
        if (sp) tps[f] = sp;
      }
      if (Object.keys(tps).length === 0) continue;   // nothing worth keeping
      dev[id] = { name: typeof d.name === 'string' ? d.name.slice(0, NAME_LEN) : id, seen: okNum(d.seen) && d.seen >= 0 && d.seen <= MAX_AT ? d.seen : 0, slots: Object.create(null), cur: null, tps, pairs: [] };
    }
    return { v: 2, looks: 0, since: null, lastGood: null, dev };
  }
  if (n.v !== 2 || !okNum(n.looks) || n.looks < 0 || n.looks > MAX_LOOKS) return fresh();
  if (!okNum(n.since) || n.since < 0 || n.since > MAX_AT) n.since = null;
  if (n.lastGood == null || !okNum(n.lastGood) || n.lastGood < 0 || n.lastGood > MAX_AT) n.lastGood = null;
  const dev = Object.create(null) as Record<string, DevNotes>;
  for (const [id, d] of Object.entries(n.dev) as [string, any][]) {
    if (id.length === 0 || id.length > MAX_ID) continue;
    if (!okDev(d)) continue;
    d.name = d.name.slice(0, NAME_LEN);
    dev[id] = d;
  }
  n.dev = dev;
  return n;
}

/** one device's notes: finite numbers, 0 <= s <= n, slot keys 0..167; a bad device is dropped.
 *  A bad speed entry is dropped on its own, the device's slots are kept. */
function okDev(d: any): d is DevNotes {
  if (!d || typeof d !== 'object' || typeof d.name !== 'string' || !okNum(d.seen) || d.seen < 0 || d.seen > MAX_AT) return false;
  if (d.last != null && d.last !== 'likely' && d.last !== 'unlikely') delete d.last;
  if (!d.slots || typeof d.slots !== 'object' || Array.isArray(d.slots)) return false;
  const slots = Object.create(null) as Record<string, [number, number, number]>;
  for (const [k, st] of Object.entries(d.slots)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i > SLOTS - 1) return false;
    if (!Array.isArray(st) || st.length !== 3) return false;
    const [n, s, t] = st as unknown[];
    if (!okNum(n) || !okNum(s) || !okNum(t)) return false;
    if (!(n >= 0) || !(s >= 0) || !(s <= n) || n > MAX_N) return false;
    if (t < 0 || t > MAX_AT) return false;
    slots[k] = [n, s, t];
  }
  d.slots = slots;
  if (!okCur(d.cur)) return false;
  if (!d.tps || typeof d.tps !== 'object' || Array.isArray(d.tps)) return false;
  const tps = Object.create(null) as Record<string, Speed>;
  for (const [f, e] of Object.entries(d.tps)) {
    const sp = okSpeed(f, e);
    if (sp) tps[f] = sp;
  }
  d.tps = tps;
  const pairs: Pair[] = [];
  for (const q of Array.isArray(d.pairs) ? d.pairs : []) {
    if (!q || typeof q !== 'object') continue;
    if (!okNum(q.t) || q.t < 0 || q.t > MAX_AT) continue;
    if (!okNum(q.p) || q.p < 0 || q.p > 1 || !okNum(q.lo) || q.lo < 0 || q.lo > 1
      || !okNum(q.hi) || q.hi < 0 || q.hi > 1 || !okNum(q.p0) || q.p0 < 0 || q.p0 > 1
      || !okNum(q.x) || q.x < 0 || q.x > 1) continue;
    if (q.lo > q.hi) continue;
    pairs.push({ t: q.t, p: q.p, lo: q.lo, hi: q.hi, p0: q.p0, x: q.x });
  }
  d.pairs = pairs.slice(-MAX_PAIRS);
  return true;
}

function okCur(c: unknown): c is Cur | null {
  if (c == null) return true;
  if (typeof c !== 'object') return false;
  const cur = c as Cur;
  return Number.isInteger(cur.slot) && cur.slot >= 0 && cur.slot <= SLOTS - 1
    && okNum(cur.looks) && cur.looks >= 0 && okNum(cur.there) && cur.there >= 0 && cur.there <= cur.looks
    && okNum(cur.t) && cur.t >= 0 && cur.t <= MAX_AT;
}

/** the snapshot's devices as clean entries: containers and entries checked, ids and names cut.
 *  observe and view both read the snapshot through this, never raw. */
function snapshotDevices(snap: Snapshot | null): { id: string; name: string; dev: EyeDevice }[] {
  const out: { id: string; name: string; dev: EyeDevice }[] = [];
  if (!snap || !Array.isArray(snap.devices)) return out;
  for (const dev of snap.devices) {
    if (!dev || typeof dev !== 'object') continue;
    const id: unknown = dev.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) continue;
    out.push({ id, name: typeof dev.name === 'string' ? dev.name.slice(0, NAME_LEN) : id, dev });
  }
  return out;
}

/** the device's tonight: N (sum of its slots' decayed n), the mean and 80% interval over tonight's
 *  nine slots (an unseen slot stands on the prior alone), the guess, and whether any of the nine
 *  slots has ever been folded. */
function tonightOf(d: DevNotes, at: number): { N: number; mean: number; lo: number; hi: number; guess: Guess; night: boolean } {
  const slots = tonightSlots(at);
  // every slot decays to the look's time first, so a device that went quiet fades (not written back)
  const pr = prior(Object.values(d.slots).map(([n, s, t]) => decay({ n, s, t }, at)));
  let mean = 0, lo = 0, hi = 0;
  let night = false;
  for (const sl of slots) {
    const st = d.slots[String(sl)];
    if (st && st[0] > 0) night = true;
    const de = st ? decay({ n: st[0], s: st[1], t: st[2] }, at) : null;
    const e = estimate(pr.a, de ? de.s : 0, de ? de.n : 0, PRIOR_K);
    mean += e.mean; lo += e.lo; hi += e.hi;
  }
  mean /= slots.length; lo /= slots.length; hi /= slots.length;
  const guess: Guess = Math.round(pr.N * 10) / 10 < MIN_SLOTS ? 'unknown' : mean >= LIKELY ? 'likely' : mean < UNLIKELY ? 'unlikely' : 'maybe';
  return { N: pr.N, mean, lo, hi, guess, night };
}

export function create(ctx: BranchCtx): Branch {
  const notes = sane(ctx.load<unknown>(null));
  let snap: Snapshot | null = null;
  let pendingAt: number | null = null;             // a far-forward look waiting for the next one to agree
  let lastSave = ctx.now();
  const lastDone = new Map<string, number>();      // device|file -> answers, this run only

  /** at most MAX_DEVICES devices; one in the current snapshot is never evicted in favour of one
   *  that is not, however far its seen is. */
  function trim(now: Snapshot) {
    const ids = Object.keys(notes.dev);
    if (ids.length <= MAX_DEVICES) return;
    const live = new Set<string>();
    for (const { id } of snapshotDevices(now)) live.add(id);
    ids.sort((a, b) => (live.has(b) ? 1 : 0) - (live.has(a) ? 1 : 0) || notes.dev[b].seen - notes.dev[a].seen);
    for (const id of ids.slice(MAX_DEVICES)) delete notes.dev[id];
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
      if (!okNum(now.at) || now.at < 0 || now.at > MAX_AT) return;   // the whole look is skipped
      if (notes.lastGood != null && now.at - notes.lastGood > FAR_MS) {
        // a look far ahead of the last good one is not trusted on its own: it is counted only
        // once the next look agrees on the new time
        if (pendingAt != null && now.at - pendingAt <= FAR_MS) {
          pendingAt = null;                        // two looks in a row agree: the clock really moved
        } else {
          pendingAt = now.at;
          return;
        }
      } else {
        pendingAt = null;                          // a normal look: a lone far look was a fluke
      }
      snap = now;
      notes.lastGood = now.at;
      const slot = slotOf(now.at);
      for (const { id, name, dev } of snapshotDevices(now)) {
        if (typeof dev.reachable !== 'boolean') continue;            // not looked at, or not a real answer
        const d = (notes.dev[id] ??= { name, seen: now.at, slots: Object.create(null), cur: null, tps: Object.create(null), pairs: [] });
        d.name = name;
        d.seen = now.at;
        const cur = d.cur;
        if (cur && (cur.slot !== slot || now.at - cur.t > HOUR_MS || cur.t > now.at + HOUR_MS)) {
          // the hour of the week changed (or this look is over an hour from the last in it, or the
          // cur was stamped by a far-forward clock): fold it
          if (cur.looks >= MIN_HOUR) {
            const key = String(cur.slot);
            const st = d.slots[key] ?? [0, 0, 0];
            const x = cur.there / cur.looks;
            // score the guess first: what the slot and the prior said just before, decayed to the
            // fold time; recorded only while the device is known (the view's own rule), so the
            // very first folds of a device are not scored
            const pr = prior(Object.values(d.slots).map(([n, s, t]) => decay({ n, s, t }, now.at)));
            if (Math.round(pr.N * 10) / 10 >= MIN_SLOTS) {
              const de = st[0] > 0 ? decay({ n: st[0], s: st[1], t: st[2] }, now.at) : { n: 0, s: 0 };
              const e = estimate(pr.a, de.s, de.n, PRIOR_K);
              d.pairs.push({ t: now.at, p: e.mean, lo: e.lo, hi: e.hi, p0: pr.p0, x });
              if (d.pairs.length > MAX_PAIRS) d.pairs.splice(0, d.pairs.length - MAX_PAIRS);
            }
            const f = fold({ n: st[0], s: st[1], t: st[2] }, x, now.at);
            d.slots[key] = [f.n, f.s, f.t];
          }
          d.cur = null;                                // fewer than MIN_HOUR looks: dropped
        }
        if (!d.cur) d.cur = { slot, looks: 0, there: 0, t: now.at };
        d.cur.looks++;
        if (active(dev)) d.cur.there++;
        const t = tonightOf(d, now.at);
        if ((t.guess === 'likely' || t.guess === 'unlikely') && t.guess !== d.last) {
          if (d.last) ctx.emit(`forecast: ${name} is now ${t.guess} tonight 22–07 (${fmtPct(t.mean)}%, ${fmtPct(t.lo)}–${fmtPct(t.hi)}%)`);
          d.last = t.guess;
        }
      }
      notes.looks++;
      if (notes.since == null || now.at < notes.since) notes.since = now.at;

      const L = now.work && typeof now.work === 'object' ? now.work.loaded : null;
      if (L && typeof L === 'object' && L.model && typeof L.model === 'object'
        && typeof L.model.file === 'string' && L.model.file.length > 0 && L.model.file.length <= MAX_ID
        && Array.isArray(L.devices)) {
        const mName = typeof L.model.name === 'string' ? L.model.name.slice(0, NAME_LEN) : L.model.file;
        for (const ld of L.devices) {
          if (!ld || typeof ld !== 'object') continue;
          if (typeof ld.id !== 'string' || ld.id.length === 0 || ld.id.length > MAX_ID) continue;
          if (!okNum(ld.tps) || !(ld.tps > 0) || ld.tps > MAX_TPS) continue;
          if (!okNum(ld.done)) continue;
          const key = `${ld.id}|${L.model.file}`;
          const before = lastDone.get(key);
          if (before === undefined || ld.done > before) {
            const d = (notes.dev[ld.id] ??= { name: typeof ld.name === 'string' ? ld.name.slice(0, NAME_LEN) : ld.id, seen: now.at, slots: Object.create(null), cur: null, tps: Object.create(null), pairs: [] });
            noteSpeed(d, L.model.file, mName, ld.tps, now.at);
          }
          lastDone.set(key, ld.done);
        }
      }
      trim(now);
      const t = ctx.now();
      if (t - lastSave >= SAVE_EVERY_MS) { ctx.save(notes); lastSave = t; }
    },
    view(): BranchView {
      const current = new Map(snapshotDevices(snap).map(({ id, dev }) => [id, dev]));
      const present = (id: string) => current.has(id);
      let at = snap?.at ?? 0;
      if (snap == null) {
        // before the first look: read the notes at the newest seen, so the decay still applies
        for (const id of Object.keys(notes.dev)) at = Math.max(at, notes.dev[id].seen);
      }
      const ids = Object.keys(notes.dev).filter((id) => present(id) || Object.keys(notes.dev[id].slots).length > 0
        || (notes.dev[id].cur != null && notes.dev[id].cur!.looks > 0));
      const rated = ids.map((id) => ({ id, d: notes.dev[id], t: tonightOf(notes.dev[id], at) }))
        .sort((a, b) => (present(b.id) ? 1 : 0) - (present(a.id) ? 1 : 0)
          || (b.t.guess === 'unknown' ? -1 : b.t.mean) - (a.t.guess === 'unknown' ? -1 : a.t.mean)
          || a.d.name.localeCompare(b.d.name));
      const presentRated = rated.filter((r) => present(r.id));
      const likely = presentRated.filter((r) => r.t.guess === 'likely').length;
      const known = presentRated.filter((r) => r.t.guess !== 'unknown').length;
      // a gone device still on the page with a guess: the stat must not say nothing is known
      const goneKnown = rated.some((r) => !present(r.id) && r.t.guess !== 'unknown');
      const seen = new Set<number>();
      for (const r of rated) for (const k of Object.keys(r.d.slots)) if (r.d.slots[k][0] >= 1) seen.add(Number(k));

      const lines = rated.map(({ id, d, t }) => {
        const when = t.guess === 'unknown'
          ? `tonight 22–07: not enough recent hours yet (${fmtN(t.N)} of ${MIN_SLOTS})`
          : `tonight 22–07: ${t.guess} ${fmtPct(t.mean)}% (${fmtPct(t.lo)}–${fmtPct(t.hi)}%)${t.night ? '' : ', from daytime only'}`;
        const holds0 = current.get(id)?.holds;
        const holds = typeof holds0 === 'string' ? holds0 : null;
        const speeds = Object.entries(d.tps);
        const best = (holds && d.tps[holds] ? [holds, d.tps[holds]] as const : null)
          ?? speeds.sort((a, b) => b[1].n - a[1].n || b[1].at - a[1].at)[0] ?? null;
        const speed = best ? ` · ~${fmtTps(best[1].avg)} tok/s on ${best[1].name}` : '';
        let absent = '';
        if (snap != null && !present(id)) {
          // gone from the snapshot: kept in the list, after the present ones, with its last seen
          // counted in local calendar days (23 h across midnight is yesterday), never negative
          const days = Math.max(0, dayOf(at) - dayOf(d.seen));
          absent = days === 0 ? ' · last seen today'
            : days === 1 ? ' · last seen yesterday'
            : days > 365 ? ' · last seen over a year ago'
            : ` · last seen ${days} days ago`;
        }
        return `${d.name} · ${when}${speed}${absent}`;
      });

      const maxN = presentRated.reduce((m, r) => Math.max(m, r.t.N), 0);
      const maxShown = Math.round(maxN * 10) / 10;
      // the stat sums present devices only: when none of them has a recent hour shown but a gone
      // device does, "still learning: 0 recent hours" would contradict that device's line
      const goneHours = maxShown === 0 && rated.some((r) => !present(r.id) && Math.round(r.t.N * 10) / 10 > 0);
      // the scored hours for the learning branch: every device in the notes (at most MAX_DEVICES,
      // a live one never evicted), oldest pair first
      const pairs = Object.keys(notes.dev)
        .sort((a, b) => (present(b) ? 1 : 0) - (present(a) ? 1 : 0) || notes.dev[b].seen - notes.dev[a].seen)
        .slice(0, MAX_DEVICES)
        .map((id) => ({
          id,
          name: notes.dev[id].name,
          scored: notes.dev[id].pairs.map((q) => [q.t, q.p, q.lo, q.hi, q.p0, q.x] as [number, number, number, number, number, number]),
        }));
      return {
        built: true,
        stat: known === 0
          ? goneKnown || goneHours ? 'no known device here now' : `still learning: ${fmtN(maxN)} recent hour${maxShown === 1 ? '' : 's'} so far`
          : `${presentRated.length} device${presentRated.length === 1 ? '' : 's'} · tonight ${likely} likely`,
        gauge: Math.round((seen.size / SLOTS) * 100),
        rows: [
          ['looks so far', String(notes.looks)],
          ['slots of the week seen', `${seen.size} of ${SLOTS}`],
          ['slot', `hour of the week, 0..${SLOTS - 1} = day (0 = sunday) * 24 + hour`],
          ['memory', `a slot's past halves every ${HALF_LIFE_WEEKS} weeks without a look there, decayed again when tonight is read`],
          ['prior', `${PRIOR_K} pseudo-observations at the device's own overall rate`],
          ['interval', `80% (wilson), tonight = the average of its nine slots`],
          ['tonight', '22:00–07:00 · likely: 60% or more · unlikely: under 40%'],
        ],
        lines,
        note: rated.length ? undefined : 'no device seen yet.',
        what: 'guesses when each device is there tonight (22–07) from a decayed beta-binomial over its hours of the week, and how fast it will be from the tok/s it answered with.',
        pairs,
      };
    },
  };
}
