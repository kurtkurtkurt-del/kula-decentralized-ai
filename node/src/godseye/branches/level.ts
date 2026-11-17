// a new level of refusals for one device (17.11.2026, P3 step a): a device whose gate starts facing
// the internet (an anchor, a forwarded port, a global ipv6 address) goes from a few refusals a day
// to scanners every hour. burst.ts alone learns a flagged hour at W_FLAG and at most RHO times its
// usual, so after quiet learning it would keep that device red for weeks. Here the device keeps its
// last LEVEL_HOURS finished hours (hour of day and count, consecutive: a gap in the looks clears
// them), and when those hours together, and each LEVEL_PARTS quarter of them alone, hold more than
// RHO × the sum of max(RATE_FLOOR, usual) of their hours of day, the fit starts again from
// freshBurst() on those hours. The rule is gatewatch.ts newLevel (its lines 144-162) for this
// computer's own gate, here for the devices' own gates: one loud hour fills one quarter only and
// stays a burst; a rate that stays this high for a whole day reads as a new level.
//
// What it does not do: it never touches the guess, replay or rpc guard checks (trust.ts holds those
// apart from the burst), so 5 or more wrong codes, a replay and the rpc guard stay red. A focused try
// that keeps one high rate for a whole day reads as a new level, as at the gate.
// Pure: no clock, no ctx.
import { burstStep, freshBurst, NEED, RHO, RATE_FLOOR, type BurstFit, type BurstStep } from './burst.js';

/** one finished hour: its hour of day (0..23) and its count */
export interface LevelHour { h: number; k: number }

export const LEVEL_HOURS = 24;        // the newest finished hours a new level is read from
export const LEVEL_PARTS = 4;         // ... and each quarter of them (6 hours) on its own

/** the newest LEVEL_HOURS hours hold a new level against `fit` (gatewatch.ts newLevel's rule): only
 *  once past learning (NEED hours taken in), the hours together and each quarter alone above RHO ×
 *  the sum of max(RATE_FLOOR, usual) */
export function isNewLevel(fit: BurstFit, hours: readonly LevelHour[]): boolean {
  if (fit.n < NEED || hours.length < LEVEL_HOURS) return false;
  const last = hours.slice(-LEVEL_HOURS);
  const per = LEVEL_HOURS / LEVEL_PARTS;
  const over = (part: readonly LevelHour[]) => {
    let k = 0;
    let usual = 0;
    for (const x of part) {
      k += x.k;
      usual += Math.max(RATE_FLOOR, fit.a[x.h] / fit.b[x.h]);
    }
    return k > RHO * usual;
  };
  if (!over(last)) return false;
  for (let i = 0; i < LEVEL_PARTS; i++) if (!over(last.slice(i * per, (i + 1) * per))) return false;
  return true;
}

/** a fit learned from freshBurst() on these hours, oldest first */
export function refit(hours: readonly LevelHour[]): BurstFit {
  let fit = freshBurst();
  for (const x of hours) fit = burstStep(fit, x.h, x.k).fit;
  return fit;
}

/** one finished hour into the fit and the kept hours: burst.ts's step first (what this hour said is
 *  judged against the fit before it), then the new-level check on the fit after it. `level` true:
 *  the fit started again on the newest LEVEL_HOURS hours */
export function levelStep(fit: BurstFit, kept: readonly LevelHour[], h: number, k: number): BurstStep & { kept: LevelHour[]; level: boolean } {
  const r = burstStep(fit, h, k);
  if (r.fit === fit) return { ...r, kept: [...kept], level: false };   // an hour burst.ts refused
  const next = [...kept, { h, k: Math.floor(k) }].slice(-LEVEL_HOURS);
  if (isNewLevel(r.fit, next)) return { ...r, fit: refit(next), kept: next, level: true };
  return { ...r, kept: next, level: false };
}

/** kept hours read back from notes: at most LEVEL_HOURS, each a whole hour of day and a finite
 *  count, or none when the shape is wrong */
export function saneLevel(x: unknown): LevelHour[] {
  if (!Array.isArray(x)) return [];
  const out: LevelHour[] = [];
  for (const e of x.slice(-LEVEL_HOURS)) {
    if (!e || typeof e !== 'object') return [];
    const { h, k } = e as Record<string, unknown>;
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h > 23) return [];
    if (typeof k !== 'number' || !Number.isFinite(k) || k < 0) return [];
    out.push({ h, k: Math.floor(k) });
  }
  return out;
}
