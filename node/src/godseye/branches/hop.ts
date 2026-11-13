// the split's hop (L8 P47, depth): what one decoded token of a split costs on the links, learned
// from the split's own answers instead of the fixed HOP_MS of decide.ts.
//
// A split token takes the computer's own compute time plus, for each worker in the chain, some
// trips over that worker's link. How many trips (and how much of each trip is the activation, not
// the latency) is not known: the probe is not one round trip (BENCH.md:43) and the trips per token
// are assumed (PLANNER.md:110). So one number k stands for all of it:
//
//   ms per token = computeMs + k * (sum of the workers' srtt)        tok/s = 1000 / that
//
// with srtt the senses branch's RFC 6298 smoothed round trip of each worker. k starts at the prior
// HOP_PRIOR and is learned by watching: each split answer's measured tok/s, with the compute time
// and the links of the look before, gives one k; the fit keeps the last HOP_KEEP of them and uses
// their median. Its last HOP_ERRS relative errors (|tps - est| / tps) give a split-conformal 80%
// interval around the guess.
//
// planner.ts and decide.ts read it (L9 P49): split() prices the links with k, the planner learns k from
// split answers and says the range in the split card's why. Pure: no clock, no ctx, no import.

/** one worker's link, in ms: senses' srtt and rttvar */
export interface Link { srtt: number; rttvar: number }
/** the learned hop: the last ks (one per split answer) and the last relative errors */
export interface HopFit { ks: number[]; errs: number[] }

export const HOP_PRIOR = 1;     // k before 3 answers: one srtt per worker per token
export const HOP_KEEP = 15;     // ks kept
export const HOP_ERRS = 30;     // errs kept
export const K_MIN = 0.05;
export const K_MAX = 20;

/** an empty fit */
export function freshHop(): HopFit {
  return { ks: [], errs: [] };
}

const pos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** the k in use: the median of the kept ks once there are 3, else HOP_PRIOR */
export function hopK(f: HopFit): number {
  const n = f.ks.length;
  if (n < 3) return HOP_PRIOR;
  const s = [...f.ks].sort((a, b) => a - b);
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** the chain's tok/s: 1000 / (computeMs + k * sum srtt) */
export function chainTps(computeMs: number, links: Link[], k: number): number {
  let sum = 0;
  for (const l of links) sum += l.srtt;
  return 1000 / (computeMs + k * sum);
}

/** a new fit after one split answer at tps; the same fit object when the input is unusable */
export function hopStep(f: HopFit, computeMs: number, links: Link[], tps: number): HopFit {
  if (!pos(computeMs) || !pos(tps) || !Array.isArray(links) || links.length === 0) return f;
  let sum = 0;
  for (const l of links) {
    if (l === null || typeof l !== 'object' || !pos(l.srtt)) return f;
    sum += l.srtt;
  }
  const est = chainTps(computeMs, links, hopK(f));
  const errs = [...f.errs, Math.abs(tps - est) / tps].slice(-HOP_ERRS);
  const ks = [...f.ks, clamp((1000 / tps - computeMs) / sum, K_MIN, K_MAX)].slice(-HOP_KEEP);
  return { ks, errs };
}

/** the split-conformal 80% interval around est from the errs: r = ceil(0.8 (m + 1)), q the r-th
 *  smallest err; null when there is no err or r > m; hi is Infinity when q >= 1 */
export function hopInterval(est: number, errs: number[]): { lo: number; hi: number } | null {
  const m = errs.length;
  const r = Math.ceil(0.8 * (m + 1));
  if (m === 0 || r > m) return null;
  const q = [...errs].sort((a, b) => a - b)[r - 1];
  return { lo: est / (1 + q), hi: q >= 1 ? Infinity : est / (1 - q) };
}

/** a fit read back (from notes, later): a copy when it has the shape this file writes, else null */
export function saneHop(x: unknown): HopFit | null {
  if (x === null || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const ks = o.ks;
  const errs = o.errs;
  if (!Array.isArray(ks) || !Array.isArray(errs)) return null;
  if (ks.length > HOP_KEEP || errs.length > HOP_ERRS) return null;
  for (const k of ks) if (typeof k !== 'number' || !Number.isFinite(k) || k < K_MIN || k > K_MAX) return null;
  for (const e of errs) if (typeof e !== 'number' || !Number.isFinite(e) || e < 0) return null;
  return { ks: [...ks] as number[], errs: [...errs] as number[] };
}
