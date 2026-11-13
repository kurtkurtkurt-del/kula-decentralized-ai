// the brain bench v6 scenarios (L11 P61): burst's start. 14 days of one device's refusals, one
// count per finished hour, the UTC hour of day i % 24. No clock, no network: every number comes
// from mulberry32 on the scenario's own stream, so the same name and seed give the same counts.
//
// The rates and the attack sizes are invented (DECISIONS-L11 risks), not measured on a phone.
//  - busy: 30 an hour all day, honest.
//  - loud: 40 an hour for 9 <= h < 17, else 1, honest.
//  - early: diurnal + 40 for hours 34..39 (day 1, 10:00-15:59): an attack before the device is judged.
//  - floodStart: diurnal, hour 10 (day 0, 10:00) gets + 5000 after the draw, and hour 106 (day 4,
//    10:00) the rate + 40: one loud hour in the first days must not blind that hour of day.
//  - dst: diurnal with the busy hours 9..16 up to hour 167 and 10..17 from hour 168: the device's
//    clock moved one hour while the UTC hour did not. No attack.
import { mulberry32 } from './synth.ts';

export const HOURS6 = 336;
export const SCENARIOS6 = ['busy', 'loud', 'early', 'floodStart', 'dst'] as const;
export type Scenario6 = (typeof SCENARIOS6)[number];

/** a scenario's own stream: the seed mixed with the scenario's name (copied from synth4.ts) */
function rngFor(name: string, seed: number): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return mulberry32((h ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0);
}

/** one Poisson draw by Knuth's product of uniforms (copied from synth4.ts) */
function poisson(rng: () => number, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

const diurnal = (h: number): number => (h >= 9 && h < 17 ? 4 : 0.1);

/** the hours an attack runs, inclusive, or null for an honest scenario */
export function attack6(name: Scenario6): { from: number; to: number } | null {
  switch (name) {
    case 'early': return { from: 34, to: 39 };
    case 'floodStart': return { from: 106, to: 106 };
    default: return null;
  }
}

/** the rate of scenario `name` in finished hour i (before any after-the-draw addition) */
function rate6(name: Scenario6, i: number): number {
  const h = i % 24;
  switch (name) {
    case 'busy': return 30;
    case 'loud': return h >= 9 && h < 17 ? 40 : 1;
    case 'early': return diurnal(h) + (i >= 34 && i <= 39 ? 40 : 0);
    case 'floodStart': return diurnal(h) + (i === 106 ? 40 : 0);
    case 'dst': {
      const busy = i < 168 ? h >= 9 && h < 17 : h >= 10 && h < 18;
      return busy ? 4 : 0.1;
    }
  }
}

/** 336 hourly refusal counts of scenario `name` on `seed` */
export function trace6(name: Scenario6, seed: number): number[] {
  const rng = rngFor(name, seed);
  const out: number[] = [];
  for (let i = 0; i < HOURS6; i++) {
    out.push(poisson(rng, rate6(name, i)) + (name === 'floodStart' && i === 10 ? 5000 : 0));
  }
  return out;
}
