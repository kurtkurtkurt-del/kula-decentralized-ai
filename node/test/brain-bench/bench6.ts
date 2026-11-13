// the brain bench v6 (L11 P61, depth): burst's start. burst.ts:87-105 copied as `stepV` with a
// variant, so the first days can be measured without touching burst.ts:
//  - base: burst.ts as it is (STRATUM_NEED, an unflagged hour learned whole);
//  - own: an hour of day that is not yet known teaches at most RHO times its usual, at weight 1;
//  - med3: learned as base, and each hour of day's first three counts are kept; when the third comes
//    that hour's alpha is set to A0 + their median * (b - B0), with the b just updated;
//  - need1: STRATUM_NEED 1 instead of 2.5, learned whole.
// `base` is pinned to bench4's newReds (burst.ts itself): when the pin fails the copy is wrong.
// Scored with bench4's `score`. No clock, no random and no network. Nothing here is shipped
// (tsconfig includes src only) and nothing is wired.
import {
  A0, B0, DECAY, W_FLAG, TAIL_P, MIN_K, NEED, STRATUM_NEED, RHO, CUSUM_H, RATE_FLOOR, CUSUM_CAP,
  freshBurst, nbTail, type BurstFit,
} from '../../src/godseye/branches/burst.ts';
import { score, type RuleScore } from './bench4.ts';
import { SCENARIOS4, attackOf, trace, type Scenario4 } from './synth4.ts';
import { SCENARIOS6, attack6, trace6, type Scenario6 } from './synth6.ts';

export type Start6 = 'whole' | 'own' | 'med3';
export interface Variant6 { name: string; need: number; start: Start6 }

export const VARIANTS6: readonly Variant6[] = [
  { name: 'base', need: STRATUM_NEED, start: 'whole' },
  { name: 'own', need: STRATUM_NEED, start: 'own' },
  { name: 'med3', need: STRATUM_NEED, start: 'med3' },
  { name: 'need1', need: 1, start: 'whole' },
];
export const BASE6 = VARIANTS6[0];

export type Scenario6Any = Scenario4 | Scenario6;
export const SCENARIOS_ALL6: readonly Scenario6Any[] = [...SCENARIOS4, ...SCENARIOS6];
const isS6 = (name: Scenario6Any): name is Scenario6 => (SCENARIOS6 as readonly string[]).includes(name);

export const traceAny6 = (name: Scenario6Any, seed: number): number[] =>
  isS6(name) ? trace6(name, seed) : trace(name, seed);
export const attackAny6 = (name: Scenario6Any): { from: number; to: number } | null =>
  isS6(name) ? attack6(name) : attackOf(name);

/** burst.ts's fit plus each hour of day's first counts (kept by med3 only, up to three) */
export interface State6 { fit: BurstFit; first: number[][] }

export const freshState6 = (): State6 => ({ fit: freshBurst(), first: Array.from({ length: 24 }, () => []) });

const median3 = (xs: number[]): number => [...xs].sort((x, y) => x - y)[1];

/** burst.ts:87-105 copied, with the variant's STRATUM_NEED and start */
export function stepV(state: State6, hour: number, k: number, v: Variant6): { state: State6; tail: boolean; rise: boolean } {
  const f = state.fit;
  const h = hour;
  const c = Math.floor(k);
  const usual = f.a[h] / f.b[h];
  const p = nbTail(c, f.a[h], f.b[h]);
  const known = f.n >= NEED && f.b[h] - B0 >= v.need;
  const tail = known && c >= MIN_K && p < TAIL_P;
  const s = known
    ? Math.min(CUSUM_CAP, Math.max(0, f.s + c * Math.log(RHO) - (RHO - 1) * Math.max(RATE_FLOOR, usual)))
    : 0;
  const rise = known && s > CUSUM_H;
  const w = tail || rise ? W_FLAG : 1;
  const capped = Math.min(c, Math.ceil(RHO * Math.max(RATE_FLOOR, usual)));
  const learn = tail || rise ? capped : v.start === 'own' && !known ? capped : c;
  const a = [...f.a];
  const b = [...f.b];
  a[h] = A0 + (a[h] - A0) * DECAY + w * learn;
  b[h] = B0 + (b[h] - B0) * DECAY + w;
  let first = state.first;
  if (v.start === 'med3' && first[h].length < 3) {
    first = first.map((xs, j) => (j === h ? [...xs, c] : xs));
    if (first[h].length === 3) a[h] = A0 + median3(first[h]) * (b[h] - B0);
  }
  return { state: { fit: { a, b, n: f.n + 1, s }, first }, tail, rise };
}

/** the whole trace folded under a variant: the last state and the red hours (`tail || rise`) */
export function foldV(counts: number[], v: Variant6, hourOf: (i: number) => number = (i) => i % 24): { state: State6; red: number[] } {
  let state = freshState6();
  const red: number[] = [];
  counts.forEach((k, i) => {
    const r = stepV(state, hourOf(i), k, v);
    if (r.tail || r.rise) red.push(i);
    state = r.state;
  });
  return { state, red };
}

/** the hours with `tail || rise` under a variant */
export const redsOf = (counts: number[], v: Variant6, hourOf: (i: number) => number = (i) => i % 24): number[] =>
  foldV(counts, v, hourOf).red;

/** dst's price of the UTC hour: base's red hours in 168..335, UTC and with the hour that follows the clock */
export interface Dst6 { utc: number; local: number }

export interface Bench6Card {
  name: Scenario6Any;
  seed: number;
  counts: number[];
  scores: Record<string, RuleScore>;
  dst: Dst6 | null;
}

export function runBench6(name: Scenario6Any, seed: number): Bench6Card {
  const counts = traceAny6(name, seed);
  const attack = attackAny6(name);
  const scores: Record<string, RuleScore> = {};
  for (const v of VARIANTS6) scores[v.name] = score(redsOf(counts, v), counts.length, attack);
  let dst: Dst6 | null = null;
  if (name === 'dst') {
    const late = (red: number[]): number => red.filter((i) => i >= 168 && i <= 335).length;
    dst = {
      utc: late(redsOf(counts, BASE6)),
      local: late(redsOf(counts, BASE6, (i) => (i >= 168 ? i - 1 : i) % 24)),
    };
  }
  return { name, seed, counts, scores, dst };
}
