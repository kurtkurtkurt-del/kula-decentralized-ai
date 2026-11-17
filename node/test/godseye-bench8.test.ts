// the brain bench v8 (17.11.2026, P1): the one-road card's 80% interval, Wilson over probes, over
// hours and over 4-hour blocks, on 28 days of an anchor at availability 0.99, 0.9 and 0.7, seeds 1-5
// (test/brain-bench/bench8.ts). Every way's coverage per level and seed is printed, and one row at A
// 0.9 with outages of 240 minutes on average (printed only, no gate). Asserted: the bench's
// soundness, and that the way the card ships (connections.ts ONE_ROAD_WAY) is the one the rule picks.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBench8, pick8, seedsCovering, card8Text, METHODS8, COVER_NEED, SEEDS_NEED, type Bench8Card, type Method8 } from './brain-bench/bench8.ts';
import { trace8, HOURS8, LEVELS8, type Level8 } from './brain-bench/synth8.ts';
import { ONE_ROAD_WAY } from '../src/godseye/branches/connections.ts';

const SEEDS = [1, 2, 3, 4, 5];
const LONG_OUT = 240;                // the longer outage shape, minutes on average

const byLevel = new Map<Level8, Bench8Card[]>();
for (const l of LEVELS8) byLevel.set(l, SEEDS.map((seed) => runBench8(l, seed)));
const meanOf = (cards: Bench8Card[], m: Method8, k: 'cover' | 'width') => cards.reduce((s, c) => s + c.rows[m][k], 0) / cards.length;
const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
const levelLine = (head: string, cards: Bench8Card[]) =>
  `${head}: seeds covering (>= ${COVER_NEED * 100}% of windows) ${METHODS8.map((m) => `${m} ${seedsCovering(cards, m)}/5`).join(' · ')}`
  + ` · mean cover ${METHODS8.map((m) => `${m} ${pc(meanOf(cards, m, 'cover'))}`).join(' · ')}`
  + ` · mean width ${METHODS8.map((m) => `${m} ${pc(meanOf(cards, m, 'width'))}`).join(' · ')}`;

test('bench8: seed 1 twice is equal', () => {
  for (const l of LEVELS8) assert.deepStrictEqual(runBench8(l, 1), byLevel.get(l)![0], `A ${l}: seed 1 twice`);
});

test('bench8: every trace has 672 hours, 0 <= m <= n, and its minutes up near A', () => {
  for (const l of LEVELS8) {
    for (const seed of SEEDS) {
      const t = trace8(l, seed);
      assert.equal(t.hours.length, HOURS8);
      assert.ok(t.hours.every((h) => Number.isInteger(h.n) && Number.isInteger(h.m) && h.m >= 0 && h.m <= h.n), `A ${l} seed ${seed}`);
      assert.ok(Math.abs(t.up - l) < 0.06, `A ${l} seed ${seed}: up ${t.up}`);
      assert.ok(Math.abs(t.truth - (1 - l)) < 1e-12);
    }
  }
});

test('bench8: every way\'s coverage per level and seed (printed), and the card ships the rule\'s way', () => {
  const lines: string[] = [];
  for (const l of LEVELS8) {
    for (const c of byLevel.get(l)!) lines.push(card8Text(c));
    lines.push(levelLine(`A ${l}`, byLevel.get(l)!));
  }
  const pick = pick8(byLevel);
  lines.push(`rule (${SEEDS_NEED} of 5 seeds at every level): ${pick ?? 'none'} · the card ships ${ONE_ROAD_WAY}`);
  // the longer outage shape: printed only, no gate
  lines.push(levelLine(`A 0.9, outages ${LONG_OUT} min (printed only)`, SEEDS.map((seed) => runBench8(0.9, seed, LONG_OUT))));
  console.log(lines.join('\n'));
  for (const c of [...byLevel.values()].flat()) {
    for (const m of METHODS8) assert.equal(c.rows[m].windows, 22, `${card8Text(c)}`);
  }
  assert.equal(pick, ONE_ROAD_WAY, 'the card ships the way the rule picks');
});
