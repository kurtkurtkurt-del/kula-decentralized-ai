// learning's reach guess, blended (L7 P41): four experts on "will the next probe answer", mixed
// by exponential weights on squared error with a fixed share (the forecast's aggregation). Pure:
// no clock, no ctx, no import from forecast.ts or learning.ts. learning.ts keeps one mix per device
// in its notes (reach.m); nothing here is shown yet.
//  - experts, from the state before the outcome, each a chance p and a weight of evidence c:
//    0 mean:   p = (s+0.5)/(n+1), c = n+1
//    1 v1:     p = learning's own p, c = (2-alpha)/alpha (the evidence of its average of rate alpha)
//    2 slow:   p = e (an average of rate 0.05), c = 39
//    3 markov: after the last outcome k, a = t[2k+1] answers of b = t[2k] + a looks,
//              p = (a+0.5)/(b+1), c = b+1; as the mean while there is no last outcome
//  - blend: q = sum w p; V = sum w (p(1-p)/(c+1) + (p-q)^2) (the mixture's variance of the chance);
//    nu = clamp(q(1-q)/V - 1, 1, 1e6), 1e6 when V is not > 0; [lo, hi] = Wilson's 80% interval
//    (z 1.2816) of q with nu looks.
//  - learn with outcome y: u = w exp(-0.5 (p-y)^2); w = 0.999 u/sum(u) + 0.001/4. The total squared
//    error is at most the best expert's plus 2(ln 4 + 0.001 T).

export const EXPERTS = 4;
const ETA = 0.5;
const SHARE = 0.001;
const SLOW = 0.05;
const SLOW_C = (2 - SLOW) / SLOW;     // 39
const Z80 = 1.2816;
const NU_MAX = 1e6;
const MAX_N = 1e9;                    // a count beyond this is not plausible
const W_SUM_TOL = 1e-6;

export interface ReachMix {
  n: number;                          // outcomes seen
  s: number;                          // of them answers
  t: [number, number, number, number]; // transitions [n00, n01, n10, n11]: from the last outcome to this
  last: 0 | 1 | null;                 // the last outcome
  e: number;                          // the slow average
  w: [number, number, number, number]; // the experts' weights
  q: number;                          // the blend's chance of an answer at the next probe
  lo: number;                         // its 80% interval
  hi: number;
}

export interface Experts { p: [number, number, number, number]; c: [number, number, number, number] }
export interface Blend { q: number; nu: number; lo: number; hi: number }

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function freshMix(): ReachMix {
  return { n: 0, s: 0, t: [0, 0, 0, 0], last: null, e: 0.5, w: [0.25, 0.25, 0.25, 0.25], q: 0.5, lo: 0, hi: 1 };
}

/** the four experts from the mix's state and learning's own p and alpha */
export function reachExperts(m: ReachMix, p: number, alpha: number): Experts {
  const mp = (m.s + 0.5) / (m.n + 1);
  const mc = m.n + 1;
  let kp = mp, kc = mc;
  if (m.last !== null) {
    const a = m.t[2 * m.last + 1];
    const b = m.t[2 * m.last] + a;
    kp = (a + 0.5) / (b + 1);
    kc = b + 1;
  }
  return { p: [mp, p, m.e, kp], c: [mc, (2 - alpha) / alpha, SLOW_C, kc] };
}

/** Wilson's interval of a chance q seen over nu looks, at z */
function wilson(q: number, nu: number, z: number): { lo: number; hi: number } {
  const z2 = z * z;
  const d = 1 + z2 / nu;
  const mid = (q + z2 / (2 * nu)) / d;
  const half = (z / d) * Math.sqrt(q * (1 - q) / nu + z2 / (4 * nu * nu));
  return { lo: clamp01(mid - half), hi: clamp01(mid + half) };
}

/** the weighted blend of the experts: its chance, its evidence nu and its 80% interval */
export function reachBlend(ex: Experts, w: readonly number[]): Blend {
  let q = 0;
  for (let k = 0; k < EXPERTS; k++) q += w[k] * ex.p[k];
  let V = 0;
  for (let k = 0; k < EXPERTS; k++) {
    const p = ex.p[k];
    V += w[k] * (p * (1 - p) / (ex.c[k] + 1) + (p - q) ** 2);
  }
  const nu = V > 0 ? Math.min(NU_MAX, Math.max(1, q * (1 - q) / V - 1)) : NU_MAX;
  const { lo, hi } = wilson(q, nu, Z80);
  return { q, nu, lo, hi };
}

/** the weights after outcome y: exponential weights on squared error, then the fixed share */
export function reachLearn(w: readonly number[], p: readonly number[], y: 0 | 1): [number, number, number, number] {
  const u = [0, 0, 0, 0];
  let sum = 0;
  for (let k = 0; k < EXPERTS; k++) { u[k] = w[k] * Math.exp(-ETA * (p[k] - y) ** 2); sum += u[k]; }
  return u.map((x) => (1 - SHARE) * x / sum + SHARE / EXPERTS) as [number, number, number, number];
}

/** one outcome y: learn from the experts taken before it (ex), count it, and blend again with
 *  learning's new p and alpha; q, lo and hi rounded to 1e-4. Returns a new mix. */
export function reachStep(m: ReachMix, ex: Experts, y: 0 | 1, p: number, alpha: number): ReachMix {
  const w = reachLearn(m.w, ex.p, y);
  const t: ReachMix['t'] = [m.t[0], m.t[1], m.t[2], m.t[3]];
  if (m.last !== null) t[2 * m.last + y] += 1;
  const e = m.n === 0 ? y : m.e + SLOW * (y - m.e);
  const next: ReachMix = { n: m.n + 1, s: m.s + y, t, last: y, e, w, q: 0, lo: 0, hi: 0 };
  const b = reachBlend(reachExperts(next, p, alpha), w);
  next.q = r4(b.q);
  next.lo = r4(b.lo);
  next.hi = r4(b.hi);
  return next;
}

const okNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const okCount = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= MAX_N;
const ok01 = (x: unknown): x is number => okNum(x) && x >= 0 && x <= 1;

/** a mix from the notes, checked; null when it is not what this file wrote */
export function saneMix(x: unknown): ReachMix | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const m = x as any;                                    // untrusted input, checked field by field
  if (!okCount(m.n) || !okCount(m.s) || m.s > m.n) return null;
  if (!Array.isArray(m.t) || m.t.length !== 4 || !m.t.every(okCount)) return null;
  if (m.t[0] + m.t[1] + m.t[2] + m.t[3] > m.n) return null;
  if (m.last !== null && m.last !== 0 && m.last !== 1) return null;
  if (!ok01(m.e)) return null;
  if (!Array.isArray(m.w) || m.w.length !== EXPERTS || !m.w.every(ok01)) return null;
  if (Math.abs(m.w[0] + m.w[1] + m.w[2] + m.w[3] - 1) > W_SUM_TOL) return null;
  if (!ok01(m.q) || !ok01(m.lo) || !ok01(m.hi) || m.lo > m.hi) return null;
  return {
    n: m.n, s: m.s, t: [m.t[0], m.t[1], m.t[2], m.t[3]], last: m.last, e: m.e,
    w: [m.w[0], m.w[1], m.w[2], m.w[3]], q: m.q, lo: m.lo, hi: m.hi,
  };
}
