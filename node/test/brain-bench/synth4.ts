// the brain bench v4 scenarios (L9 P53): 14 days of one device's refusals, one count per finished
// hour, hour of day i % 24. No clock, no network: every number comes from mulberry32 on the
// scenario's own stream, so the same name and seed give the same counts.
//
// The rates and the attack sizes are invented (DECISIONS-L9 risks), not measured on a phone.
//  - flat: 0.3 an hour all day.
//  - diurnal: 4 an hour for 9 <= h < 17, else 0.1 (an honest daily rhythm, S/g9.test.mts).
//  - over: the diurnal rate times a Gamma(2, 0.5) draw per hour (mean 1): overdispersed honest hours.
//  - step10: diurnal + 40 for hours 226..231 (day 9, 10:00-15:59).
//  - step3: diurnal + 8 for hours 226..231.
//  - night: diurnal + 6 for hours 218..220 (day 9, 02:00-04:59).
//  - ramp: the diurnal rate times 1.02^(i - 240) from hour 240 to the end.
//  - flood (L10 P54): diurnal, hour 226 (day 9, 10:00) gets + 5000 after the draw (Knuth's product
//    cannot draw a rate that large), and hour 250 (day 10, 10:00) the rate + 40: one loud hour must
//    not blind that hour of day the next day.
import { mulberry32 } from './synth.ts';

export const HOURS4 = 336;
export const SCENARIOS4 = ['flat', 'diurnal', 'over', 'step10', 'step3', 'night', 'ramp', 'flood'] as const;
export type Scenario4 = (typeof SCENARIOS4)[number];

/** a scenario's own stream: the seed mixed with the scenario's name (copied from synth2.ts) */
function rngFor(name: string, seed: number): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return mulberry32((h ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0);
}

/** one Poisson draw by Knuth's product of uniforms */
function poisson(rng: () => number, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

const diurnal = (h: number): number => (h >= 9 && h < 17 ? 4 : 0.1);

/** the hours an attack runs, inclusive, or null for an honest scenario */
export function attackOf(name: Scenario4): { from: number; to: number } | null {
  switch (name) {
    case 'step10': case 'step3': return { from: 226, to: 231 };
    case 'night': return { from: 218, to: 220 };
    case 'ramp': return { from: 240, to: HOURS4 - 1 };
    case 'flood': return { from: 226, to: 250 };
    default: return null;
  }
}

/** 336 hourly refusal counts of scenario `name` on `seed` */
export function trace(name: Scenario4, seed: number): number[] {
  const rng = rngFor(name, seed);
  const out: number[] = [];
  for (let i = 0; i < HOURS4; i++) {
    const h = i % 24;
    let rate = name === 'flat' ? 0.3 : diurnal(h);
    if (name === 'over') {
      // Gamma(2, 0.5) as half the sum of two exponentials; 1 - u keeps the log off 0
      const u1 = 1 - rng();
      const u2 = 1 - rng();
      rate *= 0.5 * (-Math.log(u1) - Math.log(u2));
    } else if (name === 'step10' && i >= 226 && i <= 231) rate += 40;
    else if (name === 'step3' && i >= 226 && i <= 231) rate += 8;
    else if (name === 'night' && i >= 218 && i <= 220) rate += 6;
    else if (name === 'ramp' && i >= 240) rate *= 1.02 ** (i - 240);
    else if (name === 'flood' && i === 250) rate += 40;
    out.push(poisson(rng, rate) + (name === 'flood' && i === 226 ? 5000 : 0));
  }
  return out;
}
