// 4 learning loop: guess, check, tune. For every device it guesses the next look (will it answer?)
// and, while a model is loaded, its next speed (tok/s), each with an exponentially weighted average
// of rate alpha. When the next look comes it scores the guess (hit or miss; percent off), keeps a
// rolling error and tunes alpha a little: error going up → adapt faster, error going down → steadier.
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

interface Loop { alpha: number; fast: number; slow: number; n: number; emittedAlpha: number }
interface Reach extends Loop { p: number; hits: string; at: number | null }
interface Speed extends Loop { est: number; errs: number[]; done: number }
interface Dev { name: string; seen: number; reach?: Reach; speed?: Speed }
export interface LearningNotes { v: 1; devices: Record<string, Dev>; last: { at: number; text: string } | null; good: boolean }

const fresh = (): LearningNotes => ({ v: 1, devices: {}, last: null, good: false });
const loop = (): Loop => ({ alpha: ALPHA_START, fast: 0, slow: 0, n: 0, emittedAlpha: ALPHA_START });
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const hitRate = (h: string) => (h.length ? [...h].filter((c) => c === '1').length / h.length : 0);

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

/** A notes file from disk, kept only if it has the shape we wrote. */
function sane(x: unknown): LearningNotes {
  const n = x as LearningNotes;
  if (!n || n.v !== 1 || typeof n.devices !== 'object' || n.devices === null) return fresh();
  return { v: 1, devices: n.devices, last: n.last ?? null, good: !!n.good };
}

export function create(ctx: BranchCtx): Branch {
  const notes = sane(ctx.load<unknown>(null));
  let present: { id: string; name: string }[] = [];
  let dirty = false;
  let savedAt = ctx.now();

  const learned = (text: string) => { notes.last = { at: ctx.now(), text }; dirty = true; };
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

  function dev(id: string, name: string, at: number): Dev {
    let d = notes.devices[id];
    if (!d) {
      d = notes.devices[id] = { name, seen: at };
      const ids = Object.keys(notes.devices);
      if (ids.length > DEVICES_MAX) {
        const oldest = ids.filter((x) => x !== id).sort((a, b) => notes.devices[a].seen - notes.devices[b].seen)[0];
        delete notes.devices[oldest];
      }
    }
    d.name = name;
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

  function seeSpeed(d: Dev, tps: number | null, done: number) {
    if (tps == null || !(tps > 0)) return;
    const s = d.speed;
    if (!s) { d.speed = { ...loop(), est: tps, errs: [], done }; dirty = true; return; }
    if (done <= s.done) { s.done = done; return; }                 // no new answer: no new speed to score
    s.done = done;
    const off = Math.abs(tps - s.est) / tps;
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
      const at = now.at;
      const seen = new Map<string, string>();
      for (const d of now.devices) { seen.set(d.id, d.name); seeReach(dev(d.id, d.name, at), d.reachable, d.checkedAt); }
      for (const d of now.work.loaded?.devices ?? []) { seen.set(d.id, d.name); seeSpeed(dev(d.id, d.name, at), d.tps, d.done); }
      present = [...seen].map(([id, name]) => ({ id, name }));
      for (const [id, d] of Object.entries(notes.devices)) if (at - d.seen > FORGET_MS) { delete notes.devices[id]; dirty = true; }

      // a feed line when accuracy crosses 80% (and back below 75%), not every look
      const { accuracy, scored } = score();
      if (accuracy != null && scored >= MIN_SCORED) {
        if (!notes.good && accuracy >= GOOD) { notes.good = true; dirty = true; ctx.emit(`learning: its guesses are now ${accuracy}% right`); }
        else if (notes.good && accuracy < GOOD - 5) { notes.good = false; dirty = true; ctx.emit(`learning: its guesses fell to ${accuracy}% right; it is adapting`); }
      }

      if (dirty && ctx.now() - savedAt >= SAVE_MS) { ctx.save(notes); savedAt = ctx.now(); dirty = false; }
    },
    view(): BranchView {
      const { reachRight, speedOff, scored, accuracy } = score();
      const fc = ctx.peek('forecast');
      const rows: [string, string][] = [['guesses scored', String(scored)], ['devices it learns', String(present.length)]];
      if (fc?.built) rows.push(['forecast says', fc.stat]);
      const lines = present.map(({ id, name }) => {
        const d = notes.devices[id];
        const r = d?.reach, s = d?.speed;
        return [
          name,
          r ? (r.hits.length ? `reach right ${Math.round(hitRate(r.hits) * 100)}% of ${r.hits.length}` : 'reach: first look') + ` · α ${r2(r.alpha)}` : null,
          s ? (s.errs.length ? `speed off ${Math.round(mean(s.errs) * 100)}%` : 'speed: first answer') + ` · guess ${r2(s.est)} tok/s · α ${r2(s.alpha)}` : null,
        ].filter(Boolean).join(' · ');
      });
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
