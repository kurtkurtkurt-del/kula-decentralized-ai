// 4 learning loop: guess, check, tune. For every device it guesses the next look (will it answer?)
// and, while a model is loaded, its next speed (tok/s), each with an exponentially weighted average
// of rate alpha. When the next look comes it scores the guess (hit or miss; percent off), keeps a
// rolling error and tunes alpha a little: error going up → adapt faster, error going down → steadier.
// It also scores the forecast branch's real guesses, read from its view (never its file): per
// finished hour the forecast said p, its 80% interval [lo, hi] and the device's own average p0
// beforehand, against what happened x:
//  - brier: BS = mean((p - x)^2), BS0 = mean((p0 - x)^2) (the baseline: the device's own average
//    as the naive guess);
//  - skill = 1 - BS / BS0, shown only when there are at least 24 pairs, the baseline Brier shown
//    to two decimals is not 0.00 (nothing to beat) and some slot has been seen twice (until then
//    p equals p0 by construction); what is shown is clamped to [-9.99, +1.00], and the feed's
//    thresholds compare that same shown value, never the raw one;
//  - calibration: said = mean(p), was = mean(x) over the same pairs (is the chance it gave about
//    right on average), with the not-enough line under 24 pairs.
// A feed line when the overall skill (at least 48 pairs) crosses below 0, and one when it comes
// back above 0.05; the state lives in the notes so a restart does not repeat or skip a line.
// The snapshot and the notes are not trusted: null containers, non-object entries, wrong types and
// NaN or absurd numbers are skipped or dropped (a bad device is dropped, a bad file starts fresh),
// device ids are keys in a null-prototype object, and a look at an unusable time changes nothing.
// A look more than a week ahead of the last good one (kept in the notes) neither records nor
// forgets until the next look is near it; a remembered seen later than the look is clamped.
// Saves are paced on ctx.now() alone and re-anchor when it steps back.
// It only reads the snapshot; it never touches a device or the work. Notes: <dir>/learning.json.
import type { Branch, BranchCtx, BranchView, Snapshot } from '../types.js';
import { hhmm } from './util.js';

export const ALPHA_MIN = 0.05;
export const ALPHA_MAX = 0.8;
const ALPHA_START = 0.3;
const FAST = 0.3;                  // rate of the recent error
const SLOW = 0.05;                 // rate of the long error
const WARMUP = 5;                  // scored guesses before alpha is tuned
const HITS_MAX = 100;              // reachability: the last 100 hits/misses per device
const ERRS_MAX = 30;               // speed: the last 30 percent-offs per device
const DEVICES_MAX = 32;
const FORGET_MS = 7 * 24 * 3600_000;
const SAVE_MS = 60_000;
const GOOD = 80;                   // the accuracy line worth a feed line when crossed
const MIN_SCORED = 10;             // …but only once there is enough to say so
const FC_DEVICES_MAX = 40;         // the forecast view's own cap: this much of it is read, no more
const FC_PAIRS_MAX = 200;          // …and its cap on scored hours per device
const SKILL_MIN_PAIRS = 24;        // scored hours before the skill is shown
const FEED_MIN_PAIRS = 48;         // …for the feed lines
const SKILL_WORSE = -0.01;         // the shown skill at or below this: worse than the device's own average
const SKILL_BETTER = 0.05;         // at or above this again: recovered (between the two, nothing happens)
const SKILL_SHOWN_MIN = -9.99;     // a shown skill never goes below this
const SKILL_SHOWN_MAX = 1.00;      // …nor above this
const MAX_ERR = 100;               // a stored percent-off is clamped to this when read back, never dropped
const MAX_AT = 8.64e15;            // a time beyond this is absurd
const MAX_ID = 200;                // an id longer than this is not usable
const NAME_LEN = 80;               // names shown are cut to this
const MAX_TPS = 100_000;           // tok/s beyond this is not a measurement
const MAX_DONE = 1e15;             // an answer count beyond this is not plausible
const MAX_N = 1e9;                 // scored guesses beyond this are not plausible

interface Loop { alpha: number; fast: number; slow: number; n: number; emittedAlpha: number }
interface Reach extends Loop { p: number; hits: string; at: number | null }
interface Speed extends Loop { est: number; errs: number[]; done: number }
interface Dev { name: string; seen: number; reach?: Reach; speed?: Speed }
export interface LearningNotes {
  v: 1;
  devices: Record<string, Dev>;
  last: { at: number; text: string } | null;
  good: boolean;
  skillBad?: boolean;              // the forecast skill is below the device's own average (said once)
  lastGood?: number | null;        // the last look trusted as data (for the far-forward guard)
}

/** one scored hour from the forecast view: [t, p, lo, hi, p0, x] */
export type ScoredHour = [number, number, number, number, number, number];

const fresh = (): LearningNotes => ({ v: 1, devices: Object.create(null), last: null, good: false, skillBad: false, lastGood: null });
const loop = (): Loop => ({ alpha: ALPHA_START, fast: 0, slow: 0, n: 0, emittedAlpha: ALPHA_START });
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const hitRate = (h: string) => (h.length ? [...h].filter((c) => c === '1').length / h.length : 0);
const fmt2 = (x: number) => r2(x).toFixed(2);
/** the skill as shown: rounded to two decimals and clamped, so the line, the thresholds and the
 *  feed state can never disagree about it */
export function shownSkill(x: number): number { return Math.min(SKILL_SHOWN_MAX, Math.max(SKILL_SHOWN_MIN, r2(x))); }
const fmtSkill = (x: number) => {
  const s = shownSkill(x);
  return `${s < 0 ? '-' : '+'}${Math.abs(s).toFixed(2)}`;
};
const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;
const fmtCal = (c: { said: number; was: number; n: number }) =>
  `said ${Math.round(c.said * 100)}% on average, devices were there ${Math.round(c.was * 100)}% of ${hours(c.n)}`;
const fmtCalShort = (c: { said: number; was: number; n: number }) =>
  `said ${Math.round(c.said * 100)}% on average, there ${Math.round(c.was * 100)}% of ${hours(c.n)}`;

/** BS = mean((p - x)^2), BS0 = mean((p0 - x)^2) over the scored hours. */
export function brier(pairs: ScoredHour[]): { bs: number; bs0: number } {
  let sq = 0, sq0 = 0;
  for (const [, p, , , p0, x] of pairs) { sq += (p - x) ** 2; sq0 += (p0 - x) ** 2; }
  return pairs.length ? { bs: sq / pairs.length, bs0: sq0 / pairs.length } : { bs: 0, bs0: 0 };
}

/** skill = 1 - BS / BS0 */
export function skill(bs: number, bs0: number): number { return 1 - bs / bs0; }

/** calibration: said = mean(p), was = mean(x), n = pairs */
export function calibration(pairs: ScoredHour[]): { said: number; was: number; n: number } {
  if (!pairs.length) return { said: 0, was: 0, n: 0 };
  let sp = 0, sx = 0;
  for (const [, p, , , , x] of pairs) { sp += p; sx += x; }
  return { said: sp / pairs.length, was: sx / pairs.length, n: pairs.length };
}

/** Score one error and tune alpha: returns the old alpha when it changed, else null. */
export function tune(l: Loop, err: number): number | null {
  l.n++;
  if (l.n === 1) { l.fast = err; l.slow = err; return null; }
  l.fast = r3(l.fast + FAST * (err - l.fast));
  l.slow = r3(l.slow + SLOW * (err - l.slow));
  if (l.n < WARMUP) return null;
  const old = l.alpha;
  if (l.fast > l.slow * 1.2 + 0.01) l.alpha = Math.min(ALPHA_MAX, l.alpha * 1.15);
  else if (l.fast < l.slow * 0.8) l.alpha = Math.max(ALPHA_MIN, l.alpha * 0.95);
  l.alpha = r3(l.alpha);
  return l.alpha !== old ? old : null;
}

const okNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
/** a time usable as data: finite, 0..8.64e15 ms */
const okTime = (x: unknown): x is number => okNum(x) && x >= 0 && x <= MAX_AT;
/** an id usable as a key in the notes */
const cleanId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_ID;
/** the name shown: a string cut to 80, or the id when it is not a string */
const cleanName = (x: unknown, id: string): string => (typeof x === 'string' && x.length ? x.slice(0, NAME_LEN) : id);

/** the shared running guess, checked: alpha and its emitted copy within bounds, fast and slow errors
 *  in 0..1, n a plausible whole count. */
function okLoop(x: any): boolean {
  return !!x && typeof x === 'object' && !Array.isArray(x)
    && okNum(x.alpha) && x.alpha >= ALPHA_MIN && x.alpha <= ALPHA_MAX
    && okNum(x.fast) && x.fast >= 0 && x.fast <= 1
    && okNum(x.slow) && x.slow >= 0 && x.slow <= 1
    && Number.isInteger(x.n) && x.n >= 0 && x.n <= MAX_N
    && okNum(x.emittedAlpha) && x.emittedAlpha >= ALPHA_MIN && x.emittedAlpha <= ALPHA_MAX;
}

/** one device's reachability guess, checked; null when it is not what this file wrote */
function saneReach(x: any): Reach | null {
  if (!okLoop(x)) return null;
  if (!okNum(x.p) || x.p < 0 || x.p > 1) return null;
  if (typeof x.hits !== 'string' || x.hits.length > HITS_MAX || !/^[01]*$/.test(x.hits)) return null;
  if (x.at != null && !okTime(x.at)) return null;
  return { alpha: x.alpha, fast: x.fast, slow: x.slow, n: x.n, emittedAlpha: x.emittedAlpha, p: x.p, hits: x.hits, at: x.at ?? null };
}

/** one device's speed guess, checked; null when it is not what this file wrote */
function saneSpeed(x: any): Speed | null {
  if (!okLoop(x)) return null;
  if (!okNum(x.est) || x.est < 0 || x.est > MAX_TPS) return null;
  if (!Array.isArray(x.errs)) return null;
  // the merged version stored percent-offs uncapped: an error above 100 is clamped, never a reason
  // to drop the device; an entry that is not a number (a NaN the old file wrote as null) is skipped
  const errs: number[] = [];
  for (const e of x.errs) {
    if (!okNum(e)) continue;
    errs.push(Math.min(Math.max(e, 0), MAX_ERR));
  }
  if (!okNum(x.done) || x.done < 0 || x.done > MAX_DONE) return null;
  return { alpha: x.alpha, fast: x.fast, slow: x.slow, n: x.n, emittedAlpha: x.emittedAlpha, est: x.est, errs: errs.slice(-ERRS_MAX), done: x.done };
}

/** A notes file from disk, kept only if it has the shape we wrote: devices are rebuilt as a
 *  null-prototype object (so an id like "__proto__" cannot pollute) and every device and number is
 *  checked; a bad device is dropped and a bad file starts fresh, never a throw. */
function sane(x: unknown): LearningNotes {
  const n = x as any;                                  // untrusted input, checked field by field below
  if (!n || typeof n !== 'object' || Array.isArray(n) || n.v !== 1) return fresh();
  if (!n.devices || typeof n.devices !== 'object' || Array.isArray(n.devices)) return fresh();
  const devices = Object.create(null) as Record<string, Dev>;
  for (const [id, d] of Object.entries(n.devices)) {
    if (!cleanId(id)) continue;
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    const o = d as any;
    if (!okTime(o.seen)) continue;
    const out: Dev = { name: cleanName(o.name, id), seen: o.seen };
    if (o.reach != null) {
      const r = saneReach(o.reach);
      if (!r) continue;                                // a bad device is dropped whole
      out.reach = r;
    }
    if (o.speed != null) {
      const s = saneSpeed(o.speed);
      if (!s) continue;
      out.speed = s;
    }
    devices[id] = out;
  }
  let last: { at: number; text: string } | null = null;
  if (n.last && typeof n.last === 'object' && okTime(n.last.at) && typeof n.last.text === 'string') {
    last = { at: n.last.at, text: n.last.text.slice(0, 200) };
  }
  return {
    v: 1, devices, last, good: n.good === true, skillBad: n.skillBad === true,
    lastGood: okTime(n.lastGood) ? n.lastGood : null,
  };
}

const ok = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;

/** the forecast's pairs as read from its view, cleaned: another branch's data, so every entry and
 *  every pair is checked and a bad one is skipped, never thrown; the read is capped at the forecast
 *  view's own bounds. */
function cleanPairs(raw: unknown): { id: string; name: string; scored: ScoredHour[] }[] {
  if (!Array.isArray(raw)) return [];
  const out: { id: string; name: string; scored: ScoredHour[] }[] = [];
  for (const e of raw.slice(0, FC_DEVICES_MAX)) {
    if (!e || typeof e !== 'object') continue;
    const o = e as { id?: unknown; name?: unknown; scored?: unknown };
    if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > MAX_ID) continue;
    const name = typeof o.name === 'string' && o.name.length ? o.name.slice(0, NAME_LEN) : o.id;
    if (!Array.isArray(o.scored)) continue;
    const scored: ScoredHour[] = [];
    for (const p of o.scored.slice(0, FC_PAIRS_MAX)) {
      if (!Array.isArray(p) || p.length !== 6) continue;
      const [t, pr, lo, hi, p0, x] = p as unknown[];
      if (!ok(t, 0, MAX_AT) || !ok(pr, 0, 1) || !ok(lo, 0, 1) || !ok(hi, 0, 1) || !ok(p0, 0, 1) || !ok(x, 0, 1)) continue;
      if (lo > hi) continue;
      scored.push([t, pr, lo, hi, p0, x]);
    }
    if (scored.length) out.push({ id: o.id, name, scored });
  }
  return out;
}

/** one list of scored hours: the brier pair, the raw skill (0 when the baseline is exact), whether
 *  every p still equals p0 to two decimals, and the calibration. */
const scorePairs = (pairs: ScoredHour[]) => {
  const { bs, bs0 } = brier(pairs);
  return {
    n: pairs.length, bs, bs0,
    sk: bs0 > 0 ? skill(bs, bs0) : 0,
    same: pairs.every(([, p, , , p0]) => r2(p) === r2(p0)),
    cal: calibration(pairs),
  };
};
type Scored = ReturnType<typeof scorePairs>;

/** what the skill row says, decided on the values as shown: nothing under 24 pairs, nothing to beat
 *  when the baseline Brier shown is 0.00, no slot seen twice while p still equals p0, else the shown
 *  skill. The feed compares exactly the same shown value. */
type SkillShow =
  | { kind: 'less'; n: number }
  | { kind: 'noskill'; n: number; bs: number; bs0: number; cal: Scored['cal'] }
  | { kind: 'noslot'; n: number; cal: Scored['cal'] }
  | { kind: 'skill'; n: number; bs: number; bs0: number; cal: Scored['cal']; shown: number };

function shownOf(s: Scored): SkillShow {
  if (s.n < SKILL_MIN_PAIRS) return { kind: 'less', n: s.n };
  if (r2(s.bs0) === 0) return { kind: 'noskill', n: s.n, bs: s.bs, bs0: s.bs0, cal: s.cal };
  if (s.same) return { kind: 'noslot', n: s.n, cal: s.cal };
  return { kind: 'skill', n: s.n, bs: s.bs, bs0: s.bs0, cal: s.cal, shown: shownSkill(s.sk) };
}

/** the "forecast skill" row */
function skillRowText(s: SkillShow): string {
  if (s.kind === 'less') return `not enough scored hours yet (${s.n} of ${SKILL_MIN_PAIRS})`;
  if (s.kind === 'noskill') return `no skill to beat: the device's own average was exact (Brier ${fmt2(s.bs)} vs ${fmt2(s.bs0)})`;
  if (s.kind === 'noslot') return 'no slot seen twice yet';
  return `${fmtSkill(s.shown)} against each device's own average (Brier ${fmt2(s.bs)} vs ${fmt2(s.bs0)})`;
}

/** one device's forecast line, the same in short */
function devLine(name: string, s: SkillShow): string {
  if (s.kind === 'less') return `${name} · forecast: not enough scored hours yet (${s.n} of ${SKILL_MIN_PAIRS})`;
  if (s.kind === 'noskill') return `${name} · forecast: no skill to beat (Brier ${fmt2(s.bs)} vs ${fmt2(s.bs0)}) · ${fmtCalShort(s.cal)}`;
  if (s.kind === 'noslot') return `${name} · forecast: no slot seen twice yet`;
  return `${name} · forecast skill ${fmtSkill(s.shown)} (Brier ${fmt2(s.bs)} vs ${fmt2(s.bs0)}) · ${fmtCalShort(s.cal)}`;
}

/** one device from the snapshot, checked: an unusable id skips it, a non-string name falls back to
 *  the id, names are cut to 80; a reachable that is not a boolean and a checkedAt that is not a
 *  usable time say "not scored" rather than reaching the notes raw. */
function snapDevice(x: unknown): { id: string; name: string; reachable: boolean | null; checkedAt: number | null } | null {
  if (!x || typeof x !== 'object') return null;
  const d = x as any;
  if (!cleanId(d.id)) return null;
  return {
    id: d.id,
    name: cleanName(d.name, d.id),
    reachable: typeof d.reachable === 'boolean' ? d.reachable : null,
    checkedAt: okTime(d.checkedAt) ? d.checkedAt : null,
  };
}

/** one loaded model device, checked: tps a measurement within bounds, done a plausible count */
function snapSpeed(x: unknown): { id: string; name: string; tps: number; done: number } | null {
  if (!x || typeof x !== 'object') return null;
  const d = x as any;
  if (!cleanId(d.id)) return null;
  if (!okNum(d.tps) || !(d.tps > 0) || d.tps > MAX_TPS) return null;
  if (!okNum(d.done) || d.done < 0 || d.done > MAX_DONE) return null;
  return { id: d.id, name: cleanName(d.name, d.id), tps: d.tps, done: d.done };
}

export function create(ctx: BranchCtx): Branch {
  const notes = sane(ctx.load<unknown>(null));
  let present: { id: string; name: string }[] = [];
  let dirty = false;
  const t0 = ctx.now();
  let savedAt = okTime(t0) ? t0 : 0;
  let pendingAt: number | null = null;            // a far-forward look waiting for the next to agree

  const learned = (text: string) => {
    const t = ctx.now();
    notes.last = { at: okTime(t) ? t : 0, text: text.slice(0, 200) };   // never write a time the loader rejects
    dirty = true;
  };
  /** what one scored guess taught: the miss (if any) and the alpha move (if any), as one note */
  const taught = (miss: string | null, name: string, what: string, l: Loop, old: number | null) => {
    const moved = old == null ? null : `${what} ${l.alpha > old ? 'changes, it adapts faster' : 'is steady, it settles'} (α ${r2(old)} → ${r2(l.alpha)})`;
    if (miss || moved) learned([miss, moved && (miss ? moved : `${name}: ${moved}`)].filter(Boolean).join('; '));
    if (old != null) alphaMoved(name, what, l);
  };
  const alphaMoved = (name: string, what: string, l: Loop) => {
    // a feed line only when alpha has moved a lot since the last one (half again, or a third down)
    if (l.alpha >= l.emittedAlpha * 1.5 || l.alpha <= l.emittedAlpha / 1.5) {
      ctx.emit(`learning: ${name}'s ${what} ${l.alpha > l.emittedAlpha ? 'is changing, it adapts faster' : 'has settled, it guesses steadier'} (α ${r2(l.emittedAlpha)} → ${r2(l.alpha)})`);
      l.emittedAlpha = l.alpha;
    }
  };

  /** at most DEVICES_MAX devices; one in the current snapshot is never evicted in favour of one
   *  that is not, however far its seen is. */
  function dev(id: string, name: string, at: number, live: Set<string>): Dev {
    let d = notes.devices[id];
    if (!d) {
      d = notes.devices[id] = { name: cleanName(name, id), seen: at };
      const ids = Object.keys(notes.devices);
      if (ids.length > DEVICES_MAX) {
        const oldest = ids.filter((x) => x !== id).sort((a, b) =>
          (live.has(a) ? 1 : 0) - (live.has(b) ? 1 : 0) || notes.devices[a].seen - notes.devices[b].seen)[0];
        delete notes.devices[oldest];
      }
    }
    d.name = cleanName(name, id);
    d.seen = at;
    return d;
  }

  function seeReach(d: Dev, reachable: boolean | null, checkedAt: number | null) {
    if (reachable == null || checkedAt == null) return;
    const y = reachable ? 1 : 0;
    const r = d.reach;
    if (!r) { d.reach = { ...loop(), p: y, hits: '', at: checkedAt }; dirty = true; return; }
    if (r.at === checkedAt) return;                                // the same look as before: nothing new
    r.at = checkedAt;
    const guess = r.p >= 0.5 ? 1 : 0;
    r.hits = (r.hits + (guess === y ? '1' : '0')).slice(-HITS_MAX);
    const miss = guess !== y ? `guessed ${d.name} would ${guess ? 'answer' : 'stay silent'}, it ${y ? 'answered' : 'did not'}` : null;
    const old = tune(r, Math.abs(y - r.p));
    r.p = r3(r.p + r.alpha * (y - r.p));
    taught(miss, d.name, 'reachability', r, old);
    dirty = true;
  }

  function seeSpeed(d: Dev, tps: number, done: number) {
    const s = d.speed;
    if (!s) { d.speed = { ...loop(), est: tps, errs: [], done }; dirty = true; return; }
    if (done <= s.done) return;                                    // no new answer: no new speed to score
    s.done = done;
    const off = Math.abs(tps - s.est) / tps;                       // uncapped, as the merged version scored it
    s.errs = [...s.errs, r3(off)].slice(-ERRS_MAX);
    const miss = off > 0.25 ? `guessed ${d.name} at ${r2(s.est)} tok/s, it ran at ${r2(tps)} (off ${Math.round(off * 100)}%)` : null;
    const old = tune(s, Math.min(1, off));
    s.est = r2(s.est + s.alpha * (tps - s.est));
    taught(miss, d.name, 'speed', s, old);
    dirty = true;
  }

  function score() {
    const devs = present.map((p) => notes.devices[p.id]).filter(Boolean);
    const hits = devs.map((d) => d.reach?.hits ?? '').join('');
    const errs = devs.flatMap((d) => d.speed?.errs ?? []);
    const reachRight = hits.length ? Math.round(hitRate(hits) * 100) : null;
    const speedOff = errs.length ? Math.round(mean(errs) * 100) : null;
    const parts = [reachRight, speedOff == null ? null : Math.max(0, 100 - speedOff)].filter((x): x is number => x != null);
    return { reachRight, speedOff, scored: hits.length + errs.length, accuracy: parts.length ? Math.round(mean(parts)) : null };
  }

  return {
    id: 'learning',
    observe(now: Snapshot) {
      if (!now || typeof now !== 'object') return;            // no snapshot: nothing to learn
      const at = (now as any).at;
      if (!okTime(at)) return;                                 // an unusable time changes nothing
      if (notes.lastGood != null && at - notes.lastGood > FORGET_MS) {
        // a look more than a week ahead of the last good one is not trusted on its own: it records
        // and forgets nothing until the next look is near it
        if (pendingAt != null && at - pendingAt <= FORGET_MS) pendingAt = null;
        else { pendingAt = at; return; }
      } else pendingAt = null;                                 // a normal look: a lone far one was a fluke
      notes.lastGood = at;

      const seen = new Map<string, string>();
      const rawDevs = Array.isArray((now as any).devices) ? (now as any).devices : [];
      const devs: NonNullable<ReturnType<typeof snapDevice>>[] = [];
      for (const raw of rawDevs) {
        const d = snapDevice(raw);
        if (d) devs.push(d);
      }
      const W = (now as any).work;
      const L = W && typeof W === 'object' ? W.loaded : null;
      const rawLdevs = L && typeof L === 'object' && Array.isArray(L.devices) ? L.devices : [];
      const ldevs: NonNullable<ReturnType<typeof snapSpeed>>[] = [];
      for (const raw of rawLdevs) {
        const s = snapSpeed(raw);
        if (s) ldevs.push(s);
      }
      const live = new Set<string>();                       // everyone in this look: the cap's first keepers
      for (const d of devs) live.add(d.id);
      for (const s of ldevs) live.add(s.id);
      for (const d of devs) {
        seen.set(d.id, d.name);
        seeReach(dev(d.id, d.name, at, live), d.reachable, d.checkedAt);
      }
      for (const s of ldevs) {
        seen.set(s.id, s.name);
        seeSpeed(dev(s.id, s.name, at, live), s.tps, s.done);
      }
      present = [...seen].map(([id, name]) => ({ id, name }));
      for (const [id, d] of Object.entries(notes.devices)) {
        if (d.seen > at) { d.seen = at; dirty = true; }        // a future stamp (clock back): clamp
        else if (at - d.seen > FORGET_MS) { delete notes.devices[id]; dirty = true; }
      }

      // a feed line when accuracy crosses 80% (and back below 75%), not every look
      const { accuracy, scored } = score();
      if (accuracy != null && scored >= MIN_SCORED) {
        if (!notes.good && accuracy >= GOOD) { notes.good = true; dirty = true; ctx.emit(`learning: its guesses are now ${accuracy}% right`); }
        else if (notes.good && accuracy < GOOD - 5) { notes.good = false; dirty = true; ctx.emit(`learning: its guesses fell to ${accuracy}% right; it is adapting`); }
      }

      // the forecast's own score, from its view: one feed line when the shown overall skill crosses
      // below -0.01 (at least 48 pairs) and one when it comes back to +0.05, not every look; the
      // row and this state use the same shown value
      const shown = shownOf(scorePairs(cleanPairs(ctx.peek('forecast')?.pairs).flatMap((d) => d.scored)));
      if (shown.kind === 'skill' && shown.n >= FEED_MIN_PAIRS) {
        if (!notes.skillBad && shown.shown <= SKILL_WORSE) {
          notes.skillBad = true; dirty = true;
          ctx.emit(`learning: the forecast is doing worse than each device's own average (skill ${fmtSkill(shown.shown)} over ${hours(shown.n)})`);
        } else if (notes.skillBad && shown.shown >= SKILL_BETTER) {
          notes.skillBad = false; dirty = true;
          ctx.emit(`learning: the forecast is doing better than each device's own average again (skill ${fmtSkill(shown.shown)} over ${hours(shown.n)})`);
        }
      }

      const t = ctx.now();
      if (t < savedAt) savedAt = t;                            // the wall clock went back: keep the pace
      if (dirty && t - savedAt >= SAVE_MS) { ctx.save(notes); savedAt = t; dirty = false; }
    },
    view(): BranchView {
      const { reachRight, speedOff, scored, accuracy } = score();
      const fc = ctx.peek('forecast');
      const rows: [string, string][] = [['guesses scored', String(scored)], ['devices it learns', String(present.length)]];
      if (fc?.built) rows.push(['forecast says', fc.stat]);
      // the forecast's finished hours, scored from its view alone: three overall rows, and the
      // same in short as one line per device
      const fcDevs = cleanPairs(fc?.pairs);
      const all = scorePairs(fcDevs.flatMap((d) => d.scored));
      const allShow = shownOf(all);
      rows.push(
        ['forecast scored', hours(all.n)],
        ['forecast skill', skillRowText(allShow)],
        ['forecast calibration', all.cal.n >= SKILL_MIN_PAIRS ? fmtCal(all.cal) : `not enough scored hours yet (${all.cal.n} of ${SKILL_MIN_PAIRS})`],
      );
      const lines = present.map(({ id, name }) => {
        const d = notes.devices[id];
        const r = d?.reach, s = d?.speed;
        return [
          name,
          r ? (r.hits.length ? `reach right ${Math.round(hitRate(r.hits) * 100)}% of ${r.hits.length}` : 'reach: first look') + ` · α ${r2(r.alpha)}` : null,
          s ? (s.errs.length ? `speed off ${Math.round(mean(s.errs) * 100)}%` : 'speed: first answer') + ` · guess ${r2(s.est)} tok/s · α ${r2(s.alpha)}` : null,
        ].filter(Boolean).join(' · ');
      });
      for (const d of fcDevs) lines.push(devLine(d.name, shownOf(scorePairs(d.scored))));
      if (!scored) {
        return {
          built: true, stat: 'nothing to learn yet', gauge: null, rows, lines,
          note: present.length
            ? 'it has made its first guesses; the next look tells it whether they were right.'
            : 'no device yet. once there are devices it guesses each next look and, while a model runs, each speed, then checks itself.',
        };
      }
      const stat = [reachRight != null ? `reachability right ${reachRight}%` : null, speedOff != null ? `speed off ${speedOff}%` : null].filter(Boolean).join(' · ');
      return {
        built: true, stat, gauge: accuracy, rows, lines,
        note: notes.last ? `learned last (${hhmm(notes.last.at)}): ${notes.last.text}` : 'every guess so far was right; nothing to tune.',
      };
    },
  };
}
