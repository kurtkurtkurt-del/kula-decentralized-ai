// the brain bench v6 (L11 P61): burst's start measured. Every scenario of synth4.ts and synth6.ts,
// seeds 1-5, scored by test/brain-bench/bench6.ts under four starts (base, own, med3, need1). Only
// the bench's soundness is asserted: determinism, the traces' shape, base pinned to bench4's newReds
// (burst.ts itself) and its fit to the fold of burstStep. The rows and the verdict lines W1-W5 are
// printed for L12 to read, never asserted. Nothing is wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBench6, foldV, redsOf, traceAny6, VARIANTS6, BASE6, SCENARIOS_ALL6, type Bench6Card, type Scenario6Any } from './brain-bench/bench6.ts';
import { newReds } from './brain-bench/bench4.ts';
import { burstStep, freshBurst } from '../src/godseye/branches/burst.ts';

const SEEDS = [1, 2, 3, 4, 5];

const cards = new Map<string, Bench6Card>();
const card = (name: Scenario6Any, seed: number): Bench6Card => {
  const key = `${name}:${seed}`;
  let c = cards.get(key);
  if (c === undefined) { c = runBench6(name, seed); cards.set(key, c); }
  return c;
};
const mean = (name: Scenario6Any, pick: (c: Bench6Card) => number): number =>
  SEEDS.reduce((s, seed) => s + pick(card(name, seed)), 0) / SEEDS.length;
const delayOf = (name: Scenario6Any, seed: number, v: string): number | null => card(name, seed).scores[v].delay;
const delays = (name: Scenario6Any, v: string): string =>
  SEEDS.map((seed) => { const d = delayOf(name, seed, v); return d === null ? 'none' : String(d); }).join(',');
const perWeek = (name: Scenario6Any, v: string): number => mean(name, (c) => c.scores[v].perWeek);

test('bench6: seed 1 twice is equal', () => {
  for (const name of SCENARIOS_ALL6) assert.deepStrictEqual(runBench6(name, 1), card(name, 1), `${name}: seed 1 twice`);
});

test('bench6: every trace has 336 whole counts >= 0', () => {
  for (const name of SCENARIOS_ALL6) {
    for (const seed of SEEDS) {
      const counts = traceAny6(name, seed);
      assert.equal(counts.length, 336, `${name} seed ${seed}`);
      assert.ok(counts.every((k) => Number.isInteger(k) && k >= 0), `${name} seed ${seed}: a count is not whole or < 0`);
    }
  }
});

test('bench6: base is burst.ts: its reds deep-equal bench4\u{2019}s newReds on every scenario and seed', () => {
  for (const name of SCENARIOS_ALL6) {
    for (const seed of SEEDS) {
      const counts = traceAny6(name, seed);
      assert.deepStrictEqual(redsOf(counts, BASE6), newReds(counts), `${name} seed ${seed}`);
    }
  }
});

test('bench6: on diurnal seed 1 the base fit deep-equals the fold of burstStep', () => {
  const counts = traceAny6('diurnal', 1);
  let fit = freshBurst();
  counts.forEach((k, i) => { fit = burstStep(fit, i % 24, k).fit; });
  const mine = foldV(counts, BASE6).state.fit;
  assert.deepStrictEqual({ a: mine.a, b: mine.b, n: mine.n, s: mine.s }, { a: fit.a, b: fit.b, n: fit.n, s: fit.s });
});

test('bench6 rows: per scenario and start, the mean false red per device-week, detected k of 5, the mean delay, after24', () => {
  for (const name of SCENARIOS_ALL6) {
    for (const v of VARIANTS6) {
      const ds = SEEDS.map((seed) => delayOf(name, seed, v.name)).filter((d): d is number => d !== null);
      const meanDelay = ds.length ? (ds.reduce((s, d) => s + d, 0) / ds.length).toFixed(2) : 'none';
      console.log(
        `${name} ${v.name}: false red/device-week ${perWeek(name, v.name).toFixed(2)}`
        + ` detected ${ds.length} of 5 (${delays(name, v.name)}) mean delay ${meanDelay}`
        + ` after24 ${mean(name, (c) => c.scores[v.name].after).toFixed(2)}`,
      );
    }
  }
});

test('bench6 verdicts W1-W5 (printed, never asserted)', () => {
  // W1: floodStart, hour 106 red
  const w1 = VARIANTS6.map((v) => `${v.name} ${SEEDS.filter((seed) => card('floodStart', seed).scores[v.name].red.includes(106)).length}`);
  console.log(`W1 floodStart red at hour 106, k of 5: ${w1.join(', ')}`);

  // W2 (prediction): honest scenarios, the mean false red per device-week <= base + 0.5
  const honest: Scenario6Any[] = ['flat', 'diurnal', 'over', 'busy', 'loud'];
  for (const v of ['own', 'med3', 'need1']) {
    let worst = honest[0];
    let worstGap = -Infinity;
    for (const name of honest) {
      const gap = perWeek(name, v) - perWeek(name, 'base');
      if (gap > worstGap) { worstGap = gap; worst = name; }
    }
    console.log(
      `W2 ${v}: ${worstGap <= 0.5 ? 'yes' : 'no'} (worst ${worst}: ${perWeek(worst, v).toFixed(2)} against base ${perWeek(worst, 'base').toFixed(2)})`,
    );
  }

  // W3: per seed no delay longer than base; a missing detection counts as longer
  const attacked: Scenario6Any[] = ['step10', 'step3', 'night', 'flood', 'ramp'];
  for (const v of ['own', 'med3']) {
    const longer: string[] = [];
    for (const name of attacked) {
      for (const seed of SEEDS) {
        const dv = delayOf(name, seed, v);
        const db = delayOf(name, seed, 'base');
        if (dv === null || (db !== null && dv > db)) longer.push(`${name} seed ${seed} (${dv ?? 'none'} against ${db ?? 'none'})`);
      }
    }
    console.log(`W3 ${v}: ${longer.length === 0 ? 'yes' : `no: ${longer.join('; ')}`}`);
  }

  // W4: early, detected k of 5
  const k = (v: string): number => SEEDS.filter((seed) => delayOf('early', seed, v) !== null).length;
  console.log(`W4 early detected: need1 ${k('need1')} of 5 (${delays('early', 'need1')}), base ${k('base')} of 5 (${delays('early', 'base')})`);

  // W5: dst under base, the red hours in 168..335 with the UTC hour and with the hour that follows the clock
  const utc = mean('dst', (c) => c.dst?.utc ?? 0);
  const local = mean('dst', (c) => c.dst?.local ?? 0);
  const rows = SEEDS.map((seed) => `${card('dst', seed).dst?.utc}/${card('dst', seed).dst?.local}`).join(', ');
  console.log(`W5 dst base, mean red hours in 168..335: UTC ${utc.toFixed(2)}, local ${local.toFixed(2)} (per seed utc/local ${rows})`);
});
