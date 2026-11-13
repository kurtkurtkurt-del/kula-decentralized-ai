// the brain bench v4 (L9 P53, depth): the refusal burst. One scenario of synth4.ts, 336 finished
// hours, scored under two rules:
//  - today: trust.ts:384-393 on finished hours. lambda = the median of the kept hours, floored at
//    0.5 (at most 9999.9); red when 24+ hours are kept, k >= 3 and P(X >= k | lambda) < 0.001;
//    a red hour is not kept; 168 hours are kept.
//  - new: burst.ts's burstStep, red when `tail || rise`.
// A false red is a red hour outside [from, to + 24] (every red hour when there is no attack); per
// device-week it is the count over (the hours counted / 168). The detection is the first red hour in
// [from, to] as a delay in hours, or null. No clock, no random and no network. Nothing here is
// shipped (tsconfig includes src only).
import { poissonTail, medianOf } from '../../src/godseye/branches/trust.ts';
import { burstStep, freshBurst } from '../../src/godseye/branches/burst.ts';
import { attackOf, trace, type Scenario4 } from './synth4.ts';

const HIST_NEED = 24;
const HIST_MAX = 168;
const BURST_P = 0.001;
const LAMBDA_MAX = 9999.9;

/** one rule's score on one trace */
export interface RuleScore {
  red: number[];             // the red hours
  falseRed: number;          // red hours outside [from, to + 24]
  perWeek: number;           // falseRed per device-week
  delay: number | null;      // the first red hour in [from, to] minus from, or null
  after: number;             // red hours in (to, to + 24] (0 without an attack)
}

export interface Bench4Card { name: Scenario4; seed: number; counts: number[]; today: RuleScore; fresh: RuleScore }

/** the red hours under today's rule (trust.ts on finished hours) */
export function todayReds(counts: number[]): number[] {
  const hist: number[] = [];
  const red: number[] = [];
  counts.forEach((k, i) => {
    const lambda = Math.min(Math.max(0.5, hist.length ? medianOf(hist) : 0), LAMBDA_MAX);
    const burst = hist.length >= HIST_NEED && k >= 3 && poissonTail(k, lambda) < BURST_P;
    if (burst) red.push(i);
    else {
      hist.push(k);
      if (hist.length > HIST_MAX) hist.shift();
    }
  });
  return red;
}

/** the red hours under burst.ts */
export function newReds(counts: number[]): number[] {
  let fit = freshBurst();
  const red: number[] = [];
  counts.forEach((k, i) => {
    const r = burstStep(fit, i % 24, k);
    if (r.tail || r.rise) red.push(i);
    fit = r.fit;
  });
  return red;
}

export function score(red: number[], hours: number, attack: { from: number; to: number } | null): RuleScore {
  const inside = (i: number): boolean => attack !== null && i >= attack.from && i <= attack.to + 24;
  let counted = 0;
  for (let i = 0; i < hours; i++) if (!inside(i)) counted++;
  const falseRed = red.filter((i) => !inside(i)).length;
  const perWeek = counted > 0 ? falseRed / (counted / 168) : 0;
  const first = attack === null ? undefined : red.find((i) => i >= attack.from && i <= attack.to);
  const delay = attack === null || first === undefined ? null : first - attack.from;
  const after = attack === null ? 0 : red.filter((i) => i > attack.to && i <= attack.to + 24).length;
  return { red, falseRed, perWeek, delay, after };
}

export function runBench4(name: Scenario4, seed: number): Bench4Card {
  const counts = trace(name, seed);
  const attack = attackOf(name);
  return {
    name, seed, counts,
    today: score(todayReds(counts), counts.length, attack),
    fresh: score(newReds(counts), counts.length, attack),
  };
}

const d = (x: number | null): string => (x === null ? 'none' : String(x));

export function scorecard4Text(c: Bench4Card): string {
  const row = (label: string, s: RuleScore): string =>
    `${label} false red ${s.falseRed} (${s.perWeek.toFixed(2)}/device-week) detect ${d(s.delay)} after24 ${s.after}`;
  return `${c.name} seed ${c.seed}: ${row('today', c.today)} | ${row('new', c.fresh)}`;
}
