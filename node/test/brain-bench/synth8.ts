// the brain bench v8 scenarios (17.11.2026, P1): an anchor's availability as this computer's probes
// see it. 28 days of one anchor, minute by minute, with a true availability A of 0.99, 0.9 or 0.7.
// No clock, no network: every number comes from mulberry32 on the scenario's own stream, so the
// same level and seed give the same trace.
//
// The shapes are invented (they are not measured on a real anchor):
//  - outages come in blocks: the anchor alternates up and down, each stretch an exponential number
//    of minutes (at least 1), down for OUT_MEAN minutes on average (a reboot, a router restart, a
//    sleeping lid) and up for OUT_MEAN * A / (1 - A), so the long-run share of minutes up is A;
//  - probes come the way kula's page makes them: in each hour, with chance SESSION_P the brain is
//    open for 5..60 minutes and every device is looked at every 15 s (4 a minute, app.js's 15 s
//    round); besides that, a Poisson(1) number of single looks an hour (a page load, a refresh);
//  - a probe answers exactly when the anchor is up at that minute: no loss of its own.
// The trace is what the connections branch keeps: per hour, how many probes and how many missed.
import { mulberry32 } from './synth.ts';

export const DAYS8 = 28;
export const HOURS8 = DAYS8 * 24;
export const LEVELS8 = [0.99, 0.9, 0.7] as const;
export type Level8 = (typeof LEVELS8)[number];
export const OUT_MEAN = 45;          // minutes an outage lasts on average
export const SESSION_P = 0.25;       // the chance the brain is open in an hour
const PER_MIN = 4;                   // probes a minute while it is open (one every 15 s)

/** a level's own stream: the seed mixed with the level (copied from synth6.ts's rngFor) */
function rngFor(name: string, seed: number): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return mulberry32((h ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0);
}

/** one Poisson draw by Knuth's product of uniforms (copied from synth6.ts) */
function poisson(rng: () => number, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

/** an exponential number of whole minutes with this mean, at least 1 */
const expMin = (rng: () => number, mean: number): number => Math.max(1, Math.round(-mean * Math.log(1 - rng())));

/** One hour as the branch keeps it: h its hour number (0 is a whole UTC day's first hour), probes n,
 *  of them missed m. */
export interface Hour8 { h: number; n: number; m: number }
export interface Trace8 { level: Level8; seed: number; truth: number; up: number; hours: Hour8[] }

/** 28 days of the anchor at availability `level` on `seed`: per hour, probes and misses. truth is
 *  the miss share the interval should hold (1 - A); up the share of minutes it was really up.
 *  outMean: minutes an outage lasts on average (OUT_MEAN unless a longer shape is tried). */
export function trace8(level: Level8, seed: number, outMean: number = OUT_MEAN): Trace8 {
  const rng = rngFor(`anchor-${level}`, seed);
  const minutes = HOURS8 * 60;
  const upMean = outMean * level / (1 - level);
  // the anchor's state, minute by minute; it starts up or down in proportion to A
  const up: boolean[] = new Array(minutes);
  let state = rng() < level;
  let left = expMin(rng, state ? upMean : outMean);
  let upCount = 0;
  for (let t = 0; t < minutes; t++) {
    if (left === 0) { state = !state; left = expMin(rng, state ? upMean : outMean); }
    up[t] = state;
    if (state) upCount++;
    left--;
  }
  // the probes: a session in some hours, single looks in every hour
  const probes = new Array<number>(minutes).fill(0);
  for (let h = 0; h < HOURS8; h++) {
    if (rng() < SESSION_P) {
      const start = h * 60 + Math.floor(rng() * 60);
      const len = 5 + Math.floor(rng() * 56);
      for (let t = start; t < Math.min(minutes, start + len); t++) probes[t] += PER_MIN;
    }
    const singles = poisson(rng, 1);
    for (let i = 0; i < singles; i++) probes[h * 60 + Math.floor(rng() * 60)]++;
  }
  const hours: Hour8[] = [];
  for (let h = 0; h < HOURS8; h++) {
    let n = 0, m = 0;
    for (let t = h * 60; t < h * 60 + 60; t++) {
      n += probes[t];
      if (!up[t]) m += probes[t];
    }
    hours.push({ h, n, m });
  }
  return { level, seed, truth: 1 - level, up: upCount / minutes, hours };
}
