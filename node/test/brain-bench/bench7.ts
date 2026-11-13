// the brain bench v7 (L11 P62): reach's 80% range, measured. reach.ts gives the blend's range from
// nu, the mixture's variance of the chance (reach.ts:76-83), and it holds the true rate far more than
// 80% of the looks. Four candidate ranges are scored beside today's on the same outcomes, read
// through bench2's `eachReach` from the mix saved at the look before. For each outcome with a mix,
// ex = reachExperts(m, p, alpha):
//  - now:   [m.lo, m.hi] (today's);
//  - count: wilson((s+0.5)/(n+1), n+1), the running mean with all its looks;
//  - wsum:  wilson(m.q, nu), nu = sum w[k] c[k] (the weighted evidence), clamped to [1, 1e6];
//  - slow:  wilson(m.e, 39), the slow average with its own evidence;
//  - heavy: wilson(m.q, nu), nu = c of the heaviest weight (the first on a tie), clamped to [1, 1e6].
// Three streams of synth2.ts: reach (steady at 0.95), far (far at 0.97) and drift (drifty, 0.95 then
// 0.70 from DRIFT_AT). Per candidate: n, cover (the true rate is inside), the mean width, and the
// mean score (hi-lo) + 10 max(0, lo-rate) + 10 max(0, rate-hi) (bench2's weights). For drift also
// the same from DRIFT_AT on, and lag: the scored outcomes from DRIFT_AT before the range first holds
// 0.70 (null if never). No clock, no random and no network. Nothing here is shipped or wired.
import { reachExperts, type ReachMix } from '../../src/godseye/branches/reach.ts';
import { runBench2, fromSnapshots, type ReachSeen } from './bench2.ts';
import { scenario2, drift, driftRate, DRIFT_AT } from './synth2.ts';

const Z80 = 1.2816;
const NU_MAX = 1e6;
const SLOW_C = 39;

export const CANDIDATES7 = ['now', 'count', 'wsum', 'slow', 'heavy'] as const;
export type Cand7 = (typeof CANDIDATES7)[number];
export const SCENARIOS7 = ['reach', 'far', 'drift'] as const;
export type Scenario7Name = (typeof SCENARIOS7)[number];

/** the one device scored in each stream */
export const DEVICE7: Record<Scenario7Name, string> = { reach: 'steady', far: 'far', drift: 'drifty' };

/** the device's true chance of an answer at look i */
export function rate7(name: Scenario7Name, i: number): number {
  switch (name) {
    case 'reach': return 0.95;
    case 'far': return 0.97;
    case 'drift': return driftRate(i);
  }
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const clampNu = (x: number): number => Math.min(NU_MAX, Math.max(1, x));

/** Wilson's 80% interval of a chance q seen over nu looks (copied from reach.ts:64-70, z 1.2816) */
export function wilson(q: number, nu: number): { lo: number; hi: number } {
  const z = Z80;
  const z2 = z * z;
  const d = 1 + z2 / nu;
  const mid = (q + z2 / (2 * nu)) / d;
  const half = (z / d) * Math.sqrt(q * (1 - q) / nu + z2 / (4 * nu * nu));
  return { lo: clamp01(mid - half), hi: clamp01(mid + half) };
}

/** every candidate's range from the mix of the look before and learning's p and alpha */
export function ranges7(m: ReachMix, p: number, alpha: number): Record<Cand7, { lo: number; hi: number }> {
  const ex = reachExperts(m, p, alpha);
  let nuW = 0;
  let top = 0;
  for (let k = 0; k < m.w.length; k++) {
    nuW += m.w[k] * ex.c[k];
    if (m.w[k] > m.w[top]) top = k;
  }
  return {
    now: { lo: m.lo, hi: m.hi },
    count: wilson((m.s + 0.5) / (m.n + 1), m.n + 1),
    wsum: wilson(m.q, clampNu(nuW)),
    slow: wilson(m.e, SLOW_C),
    heavy: wilson(m.q, clampNu(ex.c[top])),
  };
}

export interface Part7 { n: number; cover: number | null; width: number | null; score: number | null }
export interface Bench7Card {
  name: Scenario7Name; seed: number;
  bad: number;                              // ranges outside 0 <= lo <= hi <= 1, over every candidate
  whole: Record<Cand7, Part7>;
  after: Record<Cand7, Part7> | null;       // drift only: the outcomes at looks >= DRIFT_AT
  lag: Record<Cand7, number | null> | null; // drift only
}

class Tally {
  n = 0; cov = 0; width = 0; score = 0;
  add(lo: number, hi: number, rate: number): void {
    this.n++;
    if (lo <= rate && rate <= hi) this.cov++;
    this.width += hi - lo;
    this.score += (hi - lo) + 10 * Math.max(0, lo - rate) + 10 * Math.max(0, rate - hi);
  }
  part(): Part7 {
    const m = (x: number): number | null => (this.n ? x / this.n : null);
    return { n: this.n, cover: m(this.cov), width: m(this.width), score: m(this.score) };
  }
}

const each = <V>(make: () => V): Record<Cand7, V> => Object.fromEntries(CANDIDATES7.map((c) => [c, make()])) as Record<Cand7, V>;
const parts = (t: Record<Cand7, Tally>): Record<Cand7, Part7> => Object.fromEntries(CANDIDATES7.map((c) => [c, t[c].part()])) as Record<Cand7, Part7>;

/** the stream of one scenario and seed through bench2, every candidate scored on its device */
export function runBench7(name: Scenario7Name, seed: number): Bench7Card {
  const dev = DEVICE7[name];
  const whole = each(() => new Tally());
  const after = each(() => new Tally());
  const lag = each<number | null>(() => null);
  const since = each(() => 0);
  const found = each(() => false);
  let bad = 0;
  const look = (a: ReachSeen): void => {
    if (a.id !== dev || a.m === null) return;
    const rate = rate7(name, a.i);
    const rs = ranges7(a.m, a.p, a.alpha);
    for (const c of CANDIDATES7) {
      const { lo, hi } = rs[c];
      if (!(lo >= 0 && lo <= hi && hi <= 1)) bad++;
      whole[c].add(lo, hi, rate);
      if (name === 'drift' && a.i >= DRIFT_AT) {
        after[c].add(lo, hi, rate);
        if (!found[c]) {
          if (lo <= 0.70 && 0.70 <= hi) { found[c] = true; lag[c] = since[c]; } else since[c]++;
        }
      }
    }
  };
  const looks = name === 'drift' ? drift(seed) : scenario2(name, seed);
  runBench2(fromSnapshots(looks), { eachReach: look });
  const isDrift = name === 'drift';
  return { name, seed, bad, whole: parts(whole), after: isDrift ? parts(after) : null, lag: isDrift ? lag : null };
}

// ---- the words

const r4 = (x: number | null): string => (x === null ? '-' : (Math.round(x * 1e4) / 1e4).toFixed(4));

/** one row: a candidate's cover, width and score */
export function part7Text(p: Part7): string {
  return `cover ${r4(p.cover)} \u{b7} width ${r4(p.width)} \u{b7} score ${r4(p.score)}`;
}
