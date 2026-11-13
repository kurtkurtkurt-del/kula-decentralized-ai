// 3 forecast: when will each device be there tonight, and how fast will it be. A decayed
// beta-binomial per device and hour of the week:
//  - slot = hour of the week, 0..167 = day (0 = sunday, local clock of snapshot.at) * 24 + hour.
//    While the slot of snapshot.at stays the same, accumulate per device cur = { slot, looks, there }
//    (there: util.active(dev); a look with reachable == null, or a probe more than 120 s from the
//    look, says nothing and is skipped; a device working in the current load, work.loaded.devices
//    without local entries, is there instead unless a fresh probe says otherwise or its cable is
//    plugged out: the engine does not probe a device in use). When a
//    look falls in another slot (or the same slot number but more than one hour later), fold the
//    finished one: if cur.looks >= 12, x = there/looks is ONE observation of weight 1 for that slot:
//    with dtWeeks = max(0, (tFold - slot.t) / (7*24*3600*1000)) and d = 0.5 ** (dtWeeks / HALF_LIFE_WEEKS),
//    HALF_LIFE_WEEKS = 4:  n = n*d + 1;  s = s*d + x;  slot.t = tFold.  Fewer than 12 looks: dropped.
//    A backward clock jump of more than an hour observes the same real hours again as new observations.
//  - levels (L6 P31, a hierarchical beta-binomial): N = sum of n over its slots, S = sum of s;
//    p0 = (S + 0.5) / (N + 1); per hour of the day h = slot mod 24, Nh and Sh = the sums over the
//    slots with that h (the slot itself included). The slot is shrunk to its hour of the day, the
//    hour to the device's rate, each with a strength: EXPERTS = eight (Kh, Ks) pairs, inf meaning
//    "the level above as it is" (expert 1 = (inf, 4) is the L5 forecast, K = 4 at p0):
//    m = p0 or (Kh*p0 + Sh)/(Kh + Nh), c1 = N + 1 or Kh + Nh; p = m or (Ks*m + s)/(Ks + n),
//    c = c1 or Ks + n; v = p(1-p)/(c+1).
//  - the habit flip (L7 P37): per device and hour of the day h = 0..23 also fast[h] = [nf, sf, tf],
//    folded at the slot's fold with the same x and tFold: d = 0.5 ** (max(0, tFold - tf) / (HF * 24 h)),
//    HF = HALF_LIFE_FAST_DAYS = 1: nf = nf*d + 1; sf = sf*d + x; tf = tFold; read decayed to the
//    read time the same way (not written back). Experts 8 and 9: p = (K*p0 + sf)/(K + nf),
//    c = K + nf, K = FAST_K = 1 and 0.25. Ten experts in all, so after a flip the weights have an
//    expert with a short memory to move to.
//  - slot estimate: the experts blended with the device's weights w: mean = sum w p,
//    V = sum w (v + (p - mean)^2), nu = clamp(mean(1-mean)/V - 1, 1, 1e6). Interval (80% for the
//    hour's chance): wilson on p = mean with m = nu, z = 1.2816: centre = (p + z*z/(2m)) / (1 + z*z/m);
//    half = z*sqrt(p*(1-p)/m + z*z/(4*m*m)) / (1 + z*z/m); lo = max(0, centre-half),
//    hi = min(1, centre+half).
//  - the weights learn at every scored hour (below) by exponential weights on each expert's own
//    squared error, eta = 1/2, with a fixed share of 0.001: w = 0.999 u/sum(u) + 0.001/n (n = 10),
//    u = w exp(-(p - x)^2 / 2). They start uniform and are kept per device in the notes (w).
//    createFixed(k), k 0..9, is the same branch with w the unit vector of expert k, never learning;
//    createV2 is the L6 forecast (the eight slow experts, learning, weights kept in memory only).
//  - tonight = the nine slots 22:00..06:00 of the night that starts on snapshot.at's day (after
//    midnight and before 07:00: the night already running). tonight.mean = the average of the slot
//    means, lo/hi = the average of the slot lo/hi; known = Math.round(N * 10) / 10 >= 3 (the value
//    as shown: three folded hours are known, "3 of 3" can never say not enough), else guess
//    'unknown' and the line says "not enough recent hours yet (N of 3)".
//    guess: mean >= 0.6 likely, < 0.4 unlikely, else maybe. When none of tonight's nine slots has
//    n > 0 the guess stands but the line says ", from other nights" when their hours of the day
//    were seen on other days, else ", from daytime only". The stat counts only devices
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
//  - every folded hour is scored for the learning branch: just before the fold, what the blended
//    slot and the prior said then (decayed to the fold time) against x, kept as the last MAX_PAIRS
//    pairs per device, only while the device is known (the view's own rule), and handed over in
//    the view. The same scored hour then updates the device's weights w. A w in the notes of 8
//    finite numbers in [0, 1] summing to 1 (an L6 file) is read as [0.9 w, 0.05, 0.05]; one that is
//    not 8 or 10 such numbers is dropped (uniform again). A fast that is not 24 sane triples is
//    dropped (empty again), the device stays; v stays 2.
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
const STALE_MS = 120_000;            // a probe further than this from the look (either way) is not counted

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
  w?: number[];                                       // the ten experts' weights (absent: uniform)
  fast?: [number, number, number][];                  // hour of the day 0..23 -> [n, s, t], half-life 1 day
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

// ---- depth step 2 (L6 P31): the prior strength learned by prediction

/** the eight ways to lean on the device's rate and its hour of the day, as (Kh, Ks) strengths;
 *  Infinity means "take the level above as it is". The index is fixed: 1 is v1 (K = 4 at the
 *  device's rate), 0 is the bare device rate. */
export const EXPERTS: readonly (readonly [number, number])[] = [
  [Infinity, Infinity], [Infinity, 4], [Infinity, 1], [Infinity, 0.25],
  [1, Infinity], [1, 4], [1, 1], [1, 0.25],
];
export const V1 = 1;
const NS = EXPERTS.length;           // the eight slow experts
const ETA = 0.5;                     // squared loss on [0,1] is exp-concave for eta <= 1/2
const SHARE = 0.001;                 // fixed share: no expert's weight falls under SHARE / n

// ---- depth step 3 (L7 P37): the habit flip. Two fast hour-of-day experts with a short memory,
// so the weights have somewhere to go when a habit changes.

export const HALF_LIFE_FAST_DAYS = 1;                   // an hour of the day's last days halve every day
export const FAST_K: readonly number[] = [1, 0.25];     // the fast experts' pull toward the device's rate
const FAST_MS = HALF_LIFE_FAST_DAYS * DAY_MS;
const NE = NS + FAST_K.length;                          // ten experts in all

export interface Levels { N: number; S: number; p0: number; Nh: number[]; Sh: number[] }
export interface Expert { p: number; c: number }
export interface FastStats { n: number; s: number; t: number }

/** one observation x into an hour of the day's fast memory, after its past decayed:
 *  d = 0.5 ** (max(0, tFold - t) / (HALF_LIFE_FAST_DAYS * 24 h)); n = n*d + 1; s = s*d + x; t = tFold. */
export function foldFast(st: FastStats, x: number, tFold: number): FastStats {
  const d = 0.5 ** (Math.max(0, tFold - st.t) / FAST_MS);
  return { n: st.n * d + 1, s: st.s * d + x, t: tFold };
}

/** the fast memory's n and s decayed to `at` with the same d (for reading, not written back) */
export function decayFast(st: FastStats, at: number): FastStats {
  const d = 0.5 ** (Math.max(0, at - st.t) / FAST_MS);
  return { n: st.n * d, s: st.s * d, t: st.t };
}

/** experts 8 and 9 from the device's rate p0 and an hour of the day's decayed fast n and s:
 *  p = (K*p0 + s) / (K + n), c = K + n, K = 1 and K = 0.25. */
export function fastExperts(p0: number, n: number, s: number): Expert[] {
  return FAST_K.map((K) => ({ p: (K * p0 + s) / (K + n), c: K + n }));
}

/** the device's levels from its slots (already decayed to the read time): N = sum n, S = sum s,
 *  p0 = (S + 0.5) / (N + 1); Nh[h], Sh[h] = the sums over the slots with slot mod 24 = h. */
export function levels(slots: Iterable<[number, SlotStats]>): Levels {
  let N = 0, S = 0;
  const Nh = new Array<number>(24).fill(0);
  const Sh = new Array<number>(24).fill(0);
  for (const [k, st] of slots) {
    N += st.n; S += st.s;
    const h = ((k % 24) + 24) % 24;
    Nh[h] += st.n; Sh[h] += st.s;
  }
  return { N, S, p0: (S + 0.5) / (N + 1), Nh, Sh };
}

/** every expert's mean p and strength c for a slot of hour h with its own (decayed) n and s:
 *  m = p0 (Kh inf) or (Kh*p0 + Sh)/(Kh + Nh); c1 = N + 1 or Kh + Nh;
 *  p = m (Ks inf) or (Ks*m + s)/(Ks + n); c = c1 or Ks + n. */
export function experts(L: Levels, h: number, n: number, s: number): Expert[] {
  const Nh = L.Nh[h] ?? 0, Sh = L.Sh[h] ?? 0;
  return EXPERTS.map(([Kh, Ks]) => {
    let m: number, c1: number;
    if (Kh === Infinity) { m = L.p0; c1 = L.N + 1; } else { m = (Kh * L.p0 + Sh) / (Kh + Nh); c1 = Kh + Nh; }
    if (Ks === Infinity) return { p: m, c: c1 };
    return { p: (Ks * m + s) / (Ks + n), c: Ks + n };
  });
}

/** the experts blended with weights w (sum 1): mean = sum w p; V = sum w (p(1-p)/(c+1) + (p - mean)^2);
 *  nu = clamp(mean(1-mean)/V - 1, 1, 1e6) (1e6 when V is not > 0); the 80% interval is wilson on
 *  the moment-matched beta of the mixture: wilson(mean, nu, z). */
export function blend(ex: Expert[], w: readonly number[], z = Z): { mean: number; lo: number; hi: number; nu: number } {
  let mean = 0;
  for (let k = 0; k < ex.length; k++) mean += w[k] * ex[k].p;
  let V = 0;
  for (let k = 0; k < ex.length; k++) {
    const { p, c } = ex[k];
    V += w[k] * (p * (1 - p) / (c + 1) + (p - mean) ** 2);
  }
  const nu = V > 0 ? Math.min(1e6, Math.max(1, mean * (1 - mean) / V - 1)) : 1e6;
  return { mean, ...wilson(mean, nu, z), nu };
}

/** one scored hour with outcome x: u = w exp(-eta (p - x)^2), eta = 1/2; then the fixed share
 *  w = (1 - 0.001) u / sum(u) + 0.001 / n, n = the number of experts given. */
export function learn(w: readonly number[], ex: Expert[], x: number): number[] {
  const n = ex.length;
  const u = ex.map((e, k) => w[k] * Math.exp(-ETA * (e.p - x) ** 2));
  const sum = u.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) return uniform(n);
  return u.map((v) => (1 - SHARE) * v / sum + SHARE / n);
}

const uniform = (n: number): number[] => new Array<number>(n).fill(1 / n);
const unit = (k: number): number[] => Array.from({ length: NE }, (_, i) => (i === k ? 1 : 0));

/** a weights vector from the notes: n finite numbers in [0, 1] summing to 1 within 1e-6 */
function okW(w: unknown, n: number): w is number[] {
  if (!Array.isArray(w) || w.length !== n) return false;
  let sum = 0;
  for (const v of w) {
    if (!okNum(v) || v < 0 || v > 1) return false;
    sum += v;
  }
  return Math.abs(sum - 1) <= 1e-6;
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
  // the weights: ten kept; eight (an L6 notes file) padded as [0.9 w, 0.05, 0.05]; anything else
  // dropped (uniform again), the device stays
  if (d.w !== undefined) {
    if (okW(d.w, NE)) { /* kept */ } else if (okW(d.w, NS)) d.w = [...d.w.map((v: number) => 0.9 * v), 0.05, 0.05];
    else delete d.w;
  }
  if (d.fast !== undefined && !okFast(d.fast)) delete d.fast;   // a bad fast memory: empty again, the device stays
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

/** a fast memory from the notes: 24 triples [n, s, t] of finite numbers, 0 <= s <= n <= 1e4,
 *  0 <= t <= MAX_AT */
function okFast(f: unknown): f is [number, number, number][] {
  if (!Array.isArray(f) || f.length !== 24) return false;
  for (const st of f) {
    if (!Array.isArray(st) || st.length !== 3) return false;
    const [n, s, t] = st as unknown[];
    if (!okNum(n) || !okNum(s) || !okNum(t)) return false;
    if (!(s >= 0) || !(s <= n) || n > MAX_N || t < 0 || t > MAX_AT) return false;
  }
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
/** the device's slots decayed to `at` (for reading, not written back), as levels */
function levelsAt(d: DevNotes, at: number): Levels {
  return levels(Object.entries(d.slots).map(([k, [n, s, t]]) => [Number(k), decay({ n, s, t }, at)] as [number, SlotStats]));
}

/** a slot's experts at `at`: the eight slow ones from the device's levels and the slot decayed to
 *  `at`, then (withFast) the fast pair from its hour of the day's fast memory decayed to `at` */
function expertsAt(d: DevNotes, L: Levels, sl: number, at: number, withFast: boolean): Expert[] {
  const st = d.slots[String(sl)];
  const de = st && st[0] > 0 ? decay({ n: st[0], s: st[1], t: st[2] }, at) : { n: 0, s: 0 };
  const ex = experts(L, sl % 24, de.n, de.s);
  if (!withFast) return ex;
  const f = d.fast?.[sl % 24];
  const fd = f ? decayFast({ n: f[0], s: f[1], t: f[2] }, at) : { n: 0, s: 0 };
  return ex.concat(fastExperts(L.p0, fd.n, fd.s));
}

/** one slot's blended estimate at `at` from the device's levels and the weights w */
function slotEstimate(d: DevNotes, L: Levels, sl: number, at: number, w: readonly number[], withFast: boolean) {
  return blend(expertsAt(d, L, sl, at, withFast), w);
}

/** the device's tonight: N (sum of its slots' decayed n), the mean and 80% interval over tonight's
 *  nine slots (each blended from the experts with the weights w), the guess, whether any of the
 *  nine slots has ever been folded, and whether any of their hours of the day was (on any day). */
function tonightOf(d: DevNotes, at: number, w: readonly number[], withFast: boolean): { N: number; mean: number; lo: number; hi: number; guess: Guess; night: boolean; hourSeen: boolean; hours: number[] } {
  const slots = tonightSlots(at);
  const hours: number[] = [];
  // every slot decays to the look's time first, so a device that went quiet fades (not written back)
  const L = levelsAt(d, at);
  let mean = 0, lo = 0, hi = 0;
  let night = false;
  for (const sl of slots) {
    const st = d.slots[String(sl)];
    if (st && st[0] > 0) night = true;
    const e = slotEstimate(d, L, sl, at, w, withFast);
    mean += e.mean; lo += e.lo; hi += e.hi;
    hours.push(Math.round(e.mean * 100) / 100);
  }
  mean /= slots.length; lo /= slots.length; hi /= slots.length;
  const nightHours = new Set(slots.map((sl) => sl % 24));
  let hourSeen = night;
  if (!hourSeen) for (const [k, st] of Object.entries(d.slots)) if (st[0] > 0 && nightHours.has(Number(k) % 24)) { hourSeen = true; break; }
  const guess: Guess = Math.round(L.N * 10) / 10 < MIN_SLOTS ? 'unknown' : mean >= LIKELY ? 'likely' : mean < UNLIKELY ? 'unlikely' : 'maybe';
  return { N: L.N, mean, lo, hi, guess, night, hourSeen, hours };
}

/** the ids of the other devices the current load sits on (work.loaded.devices, local entries left
 *  out), matched to the snapshot's devices by id as limits and planner do */
function seatedIds(snap: Snapshot): Set<string> {
  const out = new Set<string>();
  const L = snap.work && typeof snap.work === 'object' ? snap.work.loaded : null;
  if (!L || typeof L !== 'object' || !Array.isArray(L.devices)) return out;
  for (const ld of L.devices) {
    if (!ld || typeof ld !== 'object' || ld.local === true) continue;
    if (typeof ld.id === 'string' && ld.id.length > 0 && ld.id.length <= MAX_ID) out.add(ld.id);
  }
  return out;
}

/** the learning branch: each device's ten weights learn from its own scored hours (kept in w) */
export function create(ctx: BranchCtx): Branch {
  return make(ctx, { fixed: null, fast: true });
}

/** the L6 forecast exactly: learning over the eight slow experts only, its weights kept in a
 *  private map, never reading or writing w (the fast memory is still folded). Not a branch the eye
 *  builds: the bench's v2 row. */
export function createV2(ctx: BranchCtx): Branch {
  return make(ctx, { fixed: null, fast: false });
}

/** the same branch with the weights fixed to the unit vector of expert k (0..9) on every read
 *  (V1: the L5 forecast exactly). It never learns and never writes w. Not a branch the eye builds. */
export function createFixed(k: number): (ctx: BranchCtx) => Branch {
  if (!Number.isInteger(k) || k < 0 || k >= NE) throw new RangeError(`no expert ${k}`);
  return (ctx) => make(ctx, { fixed: k, fast: true });
}

/** drops every `device|file|since` answer count that is not the current load's (`suffix` is
 *  `|file|since`): a device id may hold '|', so the key is matched by its end. */
export function keepLoad(done: Map<string, number>, suffix: string): void {
  for (const key of [...done.keys()]) if (!key.endsWith(suffix)) done.delete(key);
}

function make(ctx: BranchCtx, o: { fixed: number | null; fast: boolean }): Branch {
  const fixedW = o.fixed === null ? null : unit(o.fixed);
  const withFast = o.fast;
  // createV2's weights: per device, in memory only, so the notes' w is never read or written
  const priv = new WeakMap<DevNotes, number[]>();
  const weightsOf = (d: DevNotes): readonly number[] => fixedW
    ?? (withFast ? d.w ?? uniform(NE) : priv.get(d) ?? uniform(NS));
  const notes = sane(ctx.load<unknown>(null));
  let snap: Snapshot | null = null;
  let pendingAt: number | null = null;             // a far-forward look waiting for the next one to agree
  let lastSave = ctx.now();
  // device|file|since -> answers, this run only; only the current load's keys are kept (keepLoad),
  // so a reload does not leave a key per device behind for the life of the process
  const lastDone = new Map<string, number>();

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
      const working = seatedIds(now);
      for (const { id, name, dev } of snapshotDevices(now)) {
        // a probe carried along unchanged (the page closed overnight) is not a look at this time:
        // only one within STALE_MS of the look, either way, counts. no checkedAt: as before
        const fresh = typeof dev.reachable === 'boolean'
          && !(typeof dev.checkedAt === 'number' && !(Math.abs(dev.checkedAt - now.at) <= STALE_MS));
        // a device working in the current load is there: the engine leaves a device in use out of
        // its probe (lookOnce) and never probes a cable one there, so its own probe goes stale while
        // it works. a fresh probe still speaks for itself; a plugged-out cable phone is not there
        const seated = !fresh && working.has(id);
        if (!fresh && !seated) continue;                             // not looked at, a non-answer, or stale
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
            // score the guess first: what the slot, its hour and the device's rate said just
            // before, decayed to the fold time, blended with the weights then; recorded only while
            // the device is known (the view's own rule), so the very first folds of a device are
            // not scored. A scored hour then teaches the weights (the learning branches only)
            const L = levelsAt(d, now.at);
            if (Math.round(L.N * 10) / 10 >= MIN_SLOTS) {
              const ex = expertsAt(d, L, cur.slot, now.at, withFast);   // the fast pair decayed to now
              const e = blend(ex, weightsOf(d));
              d.pairs.push({ t: now.at, p: e.mean, lo: e.lo, hi: e.hi, p0: L.p0, x });
              if (d.pairs.length > MAX_PAIRS) d.pairs.splice(0, d.pairs.length - MAX_PAIRS);
              if (fixedW === null) {
                const w = learn(weightsOf(d), ex, x);
                if (withFast) d.w = w; else priv.set(d, w);
              }
            }
            const f = fold({ n: st[0], s: st[1], t: st[2] }, x, now.at);
            d.slots[key] = [f.n, f.s, f.t];
            // every mode folds the hour of the day's fast memory, with the same x and time
            const fast = (d.fast ??= Array.from({ length: 24 }, (): [number, number, number] => [0, 0, 0]));
            const h = cur.slot % 24;
            const ff = foldFast({ n: fast[h][0], s: fast[h][1], t: fast[h][2] }, x, now.at);
            fast[h] = [ff.n, ff.s, ff.t];
          }
          d.cur = null;                                // fewer than MIN_HOUR looks: dropped
        }
        if (!d.cur) d.cur = { slot, looks: 0, there: 0, t: now.at };
        d.cur.looks++;
        if (seated ? dev.plugged !== false : active(dev)) d.cur.there++;
        const t = tonightOf(d, now.at, weightsOf(d), withFast);
        if ((t.guess === 'likely' || t.guess === 'unlikely') && t.guess !== d.last) {
          if (d.last) ctx.emit(`forecast: ${name} is now ${t.guess} tonight 22–07 (${fmtPct(t.mean)}%, ${fmtPct(t.lo)}–${fmtPct(t.hi)}%)`);
          d.last = t.guess;
        }
      }
      notes.looks++;
      if (notes.since == null || now.at < notes.since) notes.since = now.at;

      const L = now.work && typeof now.work === 'object' ? now.work.loaded : null;
      // a split runs one model across devices: its speed is the chain's, not one device's, so a
      // split load books no speed to anyone
      if (L && typeof L === 'object' && L.mode !== 'split' && L.model && typeof L.model === 'object'
        && typeof L.model.file === 'string' && L.model.file.length > 0 && L.model.file.length <= MAX_ID
        && Array.isArray(L.devices)) {
        const mName = typeof L.model.name === 'string' ? L.model.name.slice(0, NAME_LEN) : L.model.file;
        for (const ld of L.devices) {
          if (!ld || typeof ld !== 'object') continue;
          if (typeof ld.id !== 'string' || ld.id.length === 0 || ld.id.length > MAX_ID) continue;
          if (!okNum(ld.tps) || !(ld.tps > 0) || ld.tps > MAX_TPS) continue;
          if (!okNum(ld.done)) continue;
          const key = `${ld.id}|${L.model.file}|${typeof L.since === 'number' ? L.since : ''}`;   // a reload (new since) counts from 0 again
          const before = lastDone.get(key);
          if (before === undefined || ld.done > before) {
            const d = (notes.dev[ld.id] ??= { name: typeof ld.name === 'string' ? ld.name.slice(0, NAME_LEN) : ld.id, seen: now.at, slots: Object.create(null), cur: null, tps: Object.create(null), pairs: [] });
            noteSpeed(d, L.model.file, mName, ld.tps, now.at);
          }
          lastDone.set(key, ld.done);
        }
        keepLoad(lastDone, `|${L.model.file}|${typeof L.since === 'number' ? L.since : ''}`);
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
      const rated = ids.map((id) => ({ id, d: notes.dev[id], t: tonightOf(notes.dev[id], at, weightsOf(notes.dev[id]), withFast) }))
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
          : `tonight 22–07: ${t.guess} ${fmtPct(t.mean)}% (${fmtPct(t.lo)}–${fmtPct(t.hi)}%)${t.night ? '' : t.hourSeen ? ', from other nights' : ', from daytime only'}`;
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
      // for the deciding branches (peek): each present device's tonight, as data
      const hints = rated.filter((r) => present(r.id)).map(({ id, t }) => ({ id, tonight: { guess: t.guess, p: Math.round(t.mean * 100) / 100, hours: t.hours } }));
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
          ['memory', `a slot's past halves every ${HALF_LIFE_WEEKS} weeks without a look there, decayed again when tonight is read; its last days halve every day`],
          ['prior', 'learned per device: ten ways to lean on its own rate, its hour of the day and its last days, weighted by how each scored'],
          ['interval', `80% for the hour's chance, tonight = the average of its nine slots`],
          ['tonight', '22:00–07:00 · likely: 60% or more · unlikely: under 40%'],
        ],
        lines,
        note: rated.length ? undefined : 'no device seen yet.',
        what: 'guesses when each device is there tonight (22–07) from its hours of the week, each leaning on the same hour of other days, on the same hour of its last days and on the device\'s own rate as much as that predicted well, and how fast it will be from the tok/s it answered with.',
        pairs,
        hints,
      };
    },
  };
}
