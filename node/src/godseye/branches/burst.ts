// the refusal burst per hour of day (L9 P53, G9, depth): an hour's refusal count held against what
// that same hour of the day usually holds, not against the median of all hours.
//
// Today (trust.ts:384-393) a finished hour is held against the median of all finished hours, floored
// at 0.5, and a flagged hour is never learned. An honest daily rhythm (4 an hour by day, 0.1 at
// night) has a median of 0, so every busy hour with 5+ refusals is red, and it never catches up.
//
// Here each of the 24 hours of the day keeps a Gamma(a, b) belief on its own rate (prior A0, B0).
// An hour's count k is held against the negative binomial that belief predicts (the Gamma-Poisson
// mixture): `tail` when P(X >= k) < TAIL_P. Beside it a Poisson CUSUM for a rate RHO times the usual
// gathers several hours that are each only a little high: `rise` when it passes CUSUM_H. Both wait
// until NEED hours were taken in and that hour of the day has STRATUM_NEED hours of weight. After
// the test the hour is learned with a decay, a flagged hour at the weight W_FLAG only (so a burst
// teaches little, and an honest new level is learned in the end), and a flagged hour teaches at
// most RHO times its usual as its count (L10 P54), so one loud hour cannot blind that hour of day.
// The CUSUM is held at most CUSUM_HOLD above its alarm line, so one quiet hour clears it.
//
// Nothing reads this file yet: no branch, hint, card or note imports it (L9). The bench
// (test/brain-bench/bench4.ts) measures it first; wiring it into trust.ts is L10.
// Pure: no clock, no ctx, no import.

/** 24 alphas and 24 betas (one Gamma per hour of day), the hours taken in, the CUSUM */
export interface BurstFit { a: number[]; b: number[]; n: number; s: number }

/** what one hour did to the fit, and what it said */
export interface BurstStep {
  fit: BurstFit;
  tail: boolean;     // this hour alone is unlikely for this hour of day
  rise: boolean;     // the CUSUM says the rate went up over the last hours
  p: number;         // P(X >= k) under this hour's belief before the hour
  usual: number;     // this hour's usual rate before the hour (a / b)
}

export const A0 = 0.5;                       // the prior's alpha per hour of day
export const B0 = 1;                         // the prior's beta (one hour of weight)
export const DECAY = 0.98;                   // each stratum's weight kept per hour taken in
export const W_FLAG = 0.25;                  // the weight a flagged hour is learned at
export const TAIL_P = 0.001;                 // an hour this unlikely is a burst
export const MIN_K = 3;                      // fewer refusals in an hour are never a burst
export const NEED = 24;                      // hours taken in before anything is flagged
export const STRATUM_NEED = 2.5;             // that hour of day's weight above the prior
export const RHO = 3;                        // the CUSUM looks for a rate this many times the usual
export const CUSUM_H = Math.log(1000);       // the CUSUM's alarm line
export const RATE_FLOOR = 0.5;               // the usual rate the CUSUM charges at least
// one finished hour with no refusals takes off (RHO - 1) * max(RATE_FLOOR, usual) >= twice the hold,
// so held at the cap the CUSUM always clears the alarm line on one quiet hour (L10 P54)
export const CUSUM_HOLD = 0.5 * (RHO - 1) * RATE_FLOOR;   // 0.5
export const CUSUM_CAP = CUSUM_H + CUSUM_HOLD;            // the CUSUM is held at most here

const HOURS = 24;

/** a fit that knows nothing: the prior in every hour of day */
export function freshBurst(): BurstFit {
  return { a: new Array<number>(HOURS).fill(A0), b: new Array<number>(HOURS).fill(B0), n: 0, s: 0 };
}

/** P(X >= k) for a negative binomial with r and p = beta / (beta + 1): the count a Gamma(r, beta)
 *  rate gives in one hour. pmf(0) = p^r, pmf(x + 1) = pmf(x) * (x + r) / (x + 1) * (1 - p),
 *  worked in logs with a running largest term, as trust.ts poissonTail does. */
export function nbTail(k: number, r: number, beta: number): number {
  if (!(k > 0)) return 1;
  if (!(r > 0) || !Number.isFinite(r) || !(beta > 0) || !Number.isFinite(beta)) return 0;
  const logP = -Math.log1p(1 / beta);        // ln(beta / (beta + 1))
  const logQ = -Math.log1p(beta);            // ln(1 / (beta + 1))
  const mode = r > 1 ? Math.floor((r - 1) / beta) : 0;   // (r - 1)(1 - p) / p: the largest term
  let lt = r * logP;                         // ln pmf(0)
  let m = lt;                                // the largest log term so far
  let sum = 1;                               // sum of exp(term - m)
  for (let x = 1; x < k; x++) {
    lt += Math.log(x - 1 + r) - Math.log(x) + logQ;
    if (lt > m) { sum = sum * Math.exp(m - lt) + 1; m = lt; }
    else {
      const term = Math.exp(lt - m);
      if (x > mode && term <= sum * Number.EPSILON) break;   // the rest cannot change the double
      sum += term;
    }
  }
  const p = 1 - Math.exp(m + Math.log(sum));
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
}

/** take in one finished hour: `hour` of day 0..23 with k refusals */
export function burstStep(f: BurstFit, hour: number, k: number): BurstStep {
  if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS || !Number.isFinite(k) || k < 0) {
    return { fit: f, tail: false, rise: false, p: 1, usual: 0 };
  }
  const h = hour;
  const c = Math.floor(k);
  const usual = f.a[h] / f.b[h];
  const p = nbTail(c, f.a[h], f.b[h]);
  const known = f.n >= NEED && f.b[h] - B0 >= STRATUM_NEED;
  const tail = known && c >= MIN_K && p < TAIL_P;
  const s = known
    ? Math.min(CUSUM_CAP, Math.max(0, f.s + c * Math.log(RHO) - (RHO - 1) * Math.max(RATE_FLOOR, usual)))
    : 0;
  const rise = known && s > CUSUM_H;
  const w = tail || rise ? W_FLAG : 1;
  // a flagged hour teaches at most RHO times its usual (L10 P54): one loud hour cannot blind that
  // hour of the day. An unflagged hour is learned whole.
  const learn = tail || rise ? Math.min(c, Math.ceil(RHO * Math.max(RATE_FLOOR, usual))) : c;
  const a = [...f.a];
  const b = [...f.b];
  a[h] = A0 + (a[h] - A0) * DECAY + w * learn;
  b[h] = B0 + (b[h] - B0) * DECAY + w;
  return { fit: { a, b, n: f.n + 1, s }, tail, rise, p, usual };
}

/** a fit read back from notes, or null when its shape is wrong */
export function saneBurst(x: unknown): BurstFit | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  const arr = (v: unknown, min: number): number[] | null => {
    if (!Array.isArray(v) || v.length !== HOURS) return null;
    for (const e of v) if (typeof e !== 'number' || !Number.isFinite(e) || e < min - 1e-9) return null;
    return [...(v as number[])];
  };
  const a = arr(o.a, A0);
  const b = arr(o.b, B0);
  if (a === null || b === null) return null;
  const n = o.n;
  const s = o.s;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > CUSUM_CAP) return null;
  return { a, b, n, s };
}
