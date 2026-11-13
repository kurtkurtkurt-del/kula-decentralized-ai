// the brain bench v5 (L10 P57): the faster-split card's rule, measured. planner.ts shows "would run
// faster split" on a point, S.tps >= A.tps * GAIN; hop.ts's 80% interval is only words on the card.
// This bench asks whether the interval's low end is the better rule. bench3's stream (synth3.ts) is
// replayed and every scored answer is read through bench3's `each`: the learned guess `est` and its
// interval `band`. Against it stand made-up "alone" speeds A = trueTps(name, i) * r for each ratio r
// of RATIOS, so the truth is known: the split is faster exactly when r < 1. Three rules:
//  - point:   est >= A * GAIN (today's card);
//  - low:     band ? band.lo >= A : est >= A * GAIN;
//  - lowGain: band ? band.lo >= A * GAIN : est >= A * GAIN.
// For each rule and ratio the share of answers where the rule says "faster", over the whole run and
// over the first 100 answers from SHIFT_AT. Wrong = the share at r 1.1 and 1.3; missed = 1 minus the
// share at r 0.6 and 0.8. No clock, no random and no network. Nothing here is shipped or wired.
import { GAIN } from '../../src/godseye/branches/decide.ts';
import { runBench3, fromSnapshots } from './bench3.ts';
import { scenario3, truth3, trueTps, SHIFT_AT, type Scenario3Name } from './synth3.ts';

export const RATIOS = [0.6, 0.8, 0.9, 1.0, 1.1, 1.3] as const;
export const RULES5 = ['point', 'low', 'lowGain'] as const;
export type Rule5 = (typeof RULES5)[number];
export const FIRST5 = 100;

/** per rule, one share per ratio of RATIOS (same order) */
export type Shares5 = Record<Rule5, number[]>;
export interface Part5 { n: number; nBand: number; shares: Shares5 }
export interface Bench5Card extends Part5 { name: Scenario3Name; seed: number; first: Part5 }

class Count {
  n = 0; nBand = 0;
  says: Record<Rule5, number[]> = { point: RATIOS.map(() => 0), low: RATIOS.map(() => 0), lowGain: RATIOS.map(() => 0) };
  part(): Part5 {
    const share = (xs: number[]): number[] => xs.map((x) => (this.n ? x / this.n : 0));
    return { n: this.n, nBand: this.nBand, shares: { point: share(this.says.point), low: share(this.says.low), lowGain: share(this.says.lowGain) } };
  }
}

/** bench3's stream for one scenario and seed, the three rules scored on each answer */
export function runBench5(name: Scenario3Name, seed: number): Bench5Card {
  const whole = new Count();
  const first = new Count();
  runBench3(fromSnapshots(scenario3(name, seed)), {
    computeMs: truth3(name).computeMs, shiftAt: SHIFT_AT, first: FIRST5,
    each: ({ i, est, band }) => {
      const counts = [whole];
      if (i >= SHIFT_AT && first.n < FIRST5) counts.push(first);
      const truth = trueTps(name, i);
      for (const c of counts) {
        c.n++;
        if (band !== null) c.nBand++;
        RATIOS.forEach((r, j) => {
          const A = truth * r;
          const point = est >= A * GAIN;
          if (point) c.says.point[j]++;
          if (band ? band.lo >= A : point) c.says.low[j]++;
          if (band ? band.lo >= A * GAIN : point) c.says.lowGain[j]++;
        });
      }
    },
  });
  return { name, seed, ...whole.part(), first: first.part() };
}

const at = (r: number): number => {
  const j = RATIOS.indexOf(r as (typeof RATIOS)[number]);
  if (j < 0) throw new Error(`ratio ${r} is not in RATIOS`);
  return j;
};

/** the share of answers where `rule` says faster though the split is slower (r > 1) */
export function wrong(s: Shares5, rule: Rule5, r: number): number { return s[rule][at(r)]; }
/** the share of answers where `rule` does not say faster though the split is faster (r < 1) */
export function missed(s: Shares5, rule: Rule5, r: number): number { return 1 - s[rule][at(r)]; }

// ---- the words

/** one line per rule: its share at each ratio */
export function shares5Text(label: string, s: Shares5): string[] {
  return RULES5.map((rule) => `${label} ${rule}: ${RATIOS.map((r, j) => `${r.toFixed(1)} ${s[rule][j].toFixed(4)}`).join(' | ')}`);
}
