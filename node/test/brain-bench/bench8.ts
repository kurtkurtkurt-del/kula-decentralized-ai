// the brain bench v8 (17.11.2026, P1): the one-road card's interval, measured. The card says "Y
// missed a of n probes in 7 days, 80% interval lo-hi%". Three ways to state that interval are scored
// on the same traces (synth8.ts: 28 days of an anchor with true availability 0.99, 0.9 and 0.7,
// outages in blocks, probes in bursts), all read from connections.ts so the bench scores what ships:
//  - probe:  missByProbe, Wilson over probes (today's `loss` way);
//  - hour:   missByHour, Wilson over hours, each hour with a probe one block;
//  - block4: missByBlock(hs, 4), Wilson over 4-hour blocks (floor(h/4)) that had a probe.
// A window is the 7 days the card looks at; one ends at each whole day from day 7 to day 28 (22
// windows a trace). A window covers when lo <= truth <= hi, truth = 1 - A. Per level, seed and
// method: the share of windows that cover, the mean width, and how many windows had no probe.
// A seed covers when at least COVER_NEED of its windows do (an 80% interval, less 0.05 for 22
// overlapping windows). The rule (DECISIONS P1 DO 3): keep the method that covers on at least 4 of
// 5 seeds at every level; when more than one does, the narrower (mean width over every level and
// seed); when none does, none (`pick8` says null). runBench8 with an outMean other than OUT_MEAN is a
// longer outage shape, printed only. No clock, no random and no network. Nothing here is shipped.
import { missByProbe, missByHour, missByBlock, type HourProbes, type MissShare } from '../../src/godseye/branches/connections.ts';
import { trace8, DAYS8, LEVELS8, OUT_MEAN, type Level8 } from './synth8.ts';

export const METHODS8 = ['probe', 'hour', 'block4'] as const;
export type Method8 = (typeof METHODS8)[number];
export const WINDOW_DAYS = 7;
export const COVER_NEED = 0.75;
export const SEEDS_NEED = 4;

const ways: Record<Method8, (hs: HourProbes[]) => MissShare | null> = {
  probe: missByProbe, hour: missByHour, block4: (hs) => missByBlock(hs, 4),
};

export interface Part8 { windows: number; empty: number; cover: number; width: number }
export interface Bench8Card { level: Level8; seed: number; truth: number; up: number; probes: number; rows: Record<Method8, Part8> }

/** one level and seed: every method over the 22 windows */
export function runBench8(level: Level8, seed: number, outMean: number = OUT_MEAN): Bench8Card {
  const t = trace8(level, seed, outMean);
  const rows = {} as Record<Method8, Part8>;
  for (const m of METHODS8) {
    let windows = 0, empty = 0, cover = 0, width = 0;
    for (let d = WINDOW_DAYS; d <= DAYS8; d++) {
      const hs = t.hours.slice((d - WINDOW_DAYS) * 24, d * 24);
      const s = ways[m](hs);
      windows++;
      if (s === null) { empty++; continue; }
      if (s.lo <= t.truth && t.truth <= s.hi) cover++;
      width += s.hi - s.lo;
    }
    const scored = windows - empty;
    rows[m] = { windows, empty, cover: scored ? cover / scored : 0, width: scored ? width / scored : 0 };
  }
  return { level, seed, truth: t.truth, up: t.up, probes: t.hours.reduce((s, h) => s + h.n, 0), rows };
}

/** how many of these cards' seeds cover with method m */
export const seedsCovering = (cards: Bench8Card[], m: Method8): number => cards.filter((c) => c.rows[m].cover >= COVER_NEED).length;

/** the rule: a method that covers on SEEDS_NEED of the seeds at every level; more than one: the narrower; none: null */
export function pick8(byLevel: Map<Level8, Bench8Card[]>): Method8 | null {
  const ok = METHODS8.filter((m) => LEVELS8.every((l) => seedsCovering(byLevel.get(l) ?? [], m) >= SEEDS_NEED));
  if (ok.length <= 1) return ok[0] ?? null;
  const meanWidth = (m: Method8) => {
    const all = [...byLevel.values()].flat();
    return all.reduce((s, c) => s + c.rows[m].width, 0) / all.length;
  };
  return ok.reduce((a, b) => (meanWidth(b) < meanWidth(a) ? b : a));
}

/** a card as one printed row */
export function card8Text(c: Bench8Card): string {
  const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
  return `A ${c.level} seed ${c.seed} (up ${pc(c.up)}, ${c.probes} probes): `
    + METHODS8.map((m) => `${m} cover ${pc(c.rows[m].cover)} width ${pc(c.rows[m].width)}${c.rows[m].empty ? ` empty ${c.rows[m].empty}` : ''}`).join(' · ');
}
