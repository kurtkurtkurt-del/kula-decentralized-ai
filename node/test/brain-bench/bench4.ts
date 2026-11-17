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
import { levelStep, type LevelHour } from '../../src/godseye/branches/level.ts';
import { GUESS_LIMIT } from '../../src/godseye/branches/gatewatch.ts';
import { attackOf, trace, openedTrace, OPEN_AT, LEARN_HOURS, GUESS_AT, type Scenario4, type Opened4 } from './synth4.ts';

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

/** a fold of burst.ts over the hours, with level.ts's refit (`level`) or without it: per hour its
 *  tail, its rise and whether the fit started again after it */
export function fold(counts: number[], level: boolean): { tail: boolean[]; rise: boolean[]; refit: boolean[] } {
  let fit = freshBurst();
  let kept: LevelHour[] = [];
  const tail: boolean[] = [];
  const rise: boolean[] = [];
  const refit: boolean[] = [];
  counts.forEach((k, i) => {
    const r = level ? levelStep(fit, kept, i % 24, k) : { ...burstStep(fit, i % 24, k), kept, level: false };
    tail.push(r.tail);
    rise.push(r.rise);
    refit.push(r.level);
    fit = r.fit;
    kept = r.kept;
  });
  return { tail, rise, refit };
}

/** the red hours under burst.ts with level.ts's refit (trust.ts's devices since 17.11.2026) */
export function levelReds(counts: number[]): number[] {
  const f = fold(counts, true);
  return counts.map((_, i) => i).filter((i) => f.tail[i] || f.rise[i]);
}

// the opened scenarios (P3): a device's refused check is red in an hour when burst.ts says tail or
// rise, or when its last 24 hours hold GUESS_LIMIT or more wrong codes (trust.ts; the guess check is
// apart from the burst and never softened). Scored:
//  - week1: red hours in the 7 days after opening (OPEN_AT .. OPEN_AT + 167)
//  - false: red hours from LEARN_HOURS after opening to the end, outside [GUESS_AT, GUESS_AT + 24]
//    for opened+guess, per device-week
//  - attack: red in hour GUESS_AT (opened+guess)
//  - held: the same false count with the hour after a tail added, as trust.ts shows it (a finished
//    tail hour stays red, "still above its usual", until a finished hour is quiet; a refit ends it)
//  Three rules: today (burst.ts alone, trust.ts before P3), level (with level.ts's refit, step a)
//  and soft (step b on top of a: from OPEN_AT the gate faces the internet, and a burst or a rise
//  whose last 24 hours hold strangers' refusals only is a card, not red; the wrong codes, the only
//  other reason here, keep it red for 24 hours, as rejectsDay does in trust.ts)
export type OpenedRule = 'today' | 'level' | 'soft';
export interface OpenedScore { red: number[]; week1: number; falseRed: number; perWeek: number; held: number; heldPerWeek: number; attack: boolean; refits: number[] }
export interface OpenedCard { name: Opened4; seed: number; k: number[]; guess: number[]; today: OpenedScore; level: OpenedScore; soft: OpenedScore }

function scoreOpened(name: Opened4, k: number[], guess: number[], rule: OpenedRule): OpenedScore {
  const f = fold(k, rule !== 'today');
  const guessDay = (i: number): number => {
    let g = 0;
    for (let j = Math.max(0, i - 23); j <= i; j++) g += guess[j];
    return g;
  };
  const guessRed = (i: number): boolean => guessDay(i) >= GUESS_LIMIT;
  const softAt = (i: number): boolean => rule === 'soft' && i >= OPEN_AT && guessDay(i) === 0;
  const redAt = (i: number): boolean => ((f.tail[i] || f.rise[i]) && !softAt(i)) || guessRed(i);
  const heldAt = (i: number): boolean => redAt(i) || (i > 0 && f.tail[i - 1] && !f.refit[i - 1] && !softAt(i));
  const inAttack = (i: number): boolean => name === 'opened+guess' && i >= GUESS_AT && i <= GUESS_AT + 24;
  const red: number[] = [];
  for (let i = 0; i < k.length; i++) if (redAt(i)) red.push(i);
  let counted = 0;
  let falseRed = 0;
  let held = 0;
  for (let i = OPEN_AT + LEARN_HOURS; i < k.length; i++) {
    if (inAttack(i)) continue;
    counted++;
    if (redAt(i)) falseRed++;
    if (heldAt(i)) held++;
  }
  const weeks = counted / 168;
  return {
    red,
    week1: red.filter((i) => i >= OPEN_AT && i < OPEN_AT + 168).length,
    falseRed, perWeek: falseRed / weeks, held, heldPerWeek: held / weeks,
    attack: redAt(GUESS_AT),
    refits: f.refit.flatMap((x, i) => (x ? [i] : [])),
  };
}

export function runOpened(name: Opened4, seed: number): OpenedCard {
  const { k, guess } = openedTrace(name, seed);
  return {
    name, seed, k, guess,
    today: scoreOpened(name, k, guess, 'today'),
    level: scoreOpened(name, k, guess, 'level'),
    soft: scoreOpened(name, k, guess, 'soft'),
  };
}

export function openedText(c: OpenedCard): string {
  const row = (label: string, s: OpenedScore): string =>
    `${label} week1 red ${s.week1} · false red from ${LEARN_HOURS} h ${s.falseRed} (${s.perWeek.toFixed(2)}/device-week, held ${s.heldPerWeek.toFixed(2)})`
    + `${c.name === 'opened+guess' ? ` · attack hour ${s.attack ? 'red' : 'not red'}` : ''} · refits ${s.refits.length ? s.refits.join(',') : 'none'}`;
  return `${c.name} seed ${c.seed}: ${row('today', c.today)} | ${row('level', c.level)} | ${row('soft', c.soft)}`;
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
