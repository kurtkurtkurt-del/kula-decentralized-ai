// the brain bench v4 (L9 P53): the refusal burst per hour of day. Every scenario of
// test/brain-bench/synth4.ts scored by test/brain-bench/bench4.ts under today's rule (trust.ts on
// finished hours) and burst.ts. Seeds 1-5, the thresholds on the mean or a count of seeds. The
// thresholds below are the design's predictions; a scenario is never tuned to pass them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBench4, scorecard4Text, type Bench4Card } from './brain-bench/bench4.ts';
import { SCENARIOS4, trace, type Scenario4 } from './brain-bench/synth4.ts';

const SEEDS = [1, 2, 3, 4, 5];

const cards = new Map<string, Bench4Card>();
const card = (name: Scenario4, seed: number): Bench4Card => {
  const key = `${name}:${seed}`;
  let c = cards.get(key);
  if (c === undefined) { c = runBench4(name, seed); cards.set(key, c); }
  return c;
};
const mean = (name: Scenario4, pick: (c: Bench4Card) => number): number =>
  SEEDS.reduce((s, seed) => s + pick(card(name, seed)), 0) / SEEDS.length;
const seedsWhere = (name: Scenario4, ok: (c: Bench4Card) => boolean): number =>
  SEEDS.filter((seed) => ok(card(name, seed))).length;
const delays = (name: Scenario4, rule: 'today' | 'fresh'): string =>
  SEEDS.map((seed) => { const d = card(name, seed)[rule].delay; return d === null ? 'none' : String(d); }).join(',');

test('the scorecard v4: every scenario, each seed and the mean of seeds 1-5', () => {
  for (const name of SCENARIOS4) {
    for (const seed of SEEDS) console.log(scorecard4Text(card(name, seed)));
    console.log(
      `${name} mean: false red/device-week today ${mean(name, (c) => c.today.perWeek).toFixed(2)}`
      + ` new ${mean(name, (c) => c.fresh.perWeek).toFixed(2)}`
      + ` | detect today ${delays(name, 'today')} new ${delays(name, 'fresh')}`
      + ` | red in the 24 h after today ${mean(name, (c) => c.today.after).toFixed(2)} new ${mean(name, (c) => c.fresh.after).toFixed(2)}`,
    );
  }
});

test('determinism: seed 1 twice is the same, seed 2 is not', () => {
  for (const name of SCENARIOS4) {
    assert.deepStrictEqual(runBench4(name, 1), runBench4(name, 1), name);
    assert.notDeepStrictEqual(trace(name, 2), trace(name, 1), name);
    assert.equal(trace(name, 1).length, 336);
  }
});

test('B1 diurnal: the new rule turns an honest daily rhythm red at most 2 hours a device-week and 0.2 of today', () => {
  const today = mean('diurnal', (c) => c.today.perWeek);
  const fresh = mean('diurnal', (c) => c.fresh.perWeek);
  console.log(`B1 diurnal false red/device-week: today ${today.toFixed(2)} new ${fresh.toFixed(2)}`);
  assert.ok(today >= 10, `today's false alarm is expected at 10+ a device-week: ${today}`);
  assert.ok(fresh <= 2, `new ${fresh} > 2`);
  assert.ok(fresh <= 0.2 * today, `new ${fresh} > 0.2 * today ${today}`);
});

test('B2 flat: the new rule is no noisier than today on a flat rate (+0.5)', () => {
  const today = mean('flat', (c) => c.today.perWeek);
  const fresh = mean('flat', (c) => c.fresh.perWeek);
  assert.ok(fresh <= today + 0.5, `flat: new ${fresh} > today ${today} + 0.5`);
});

test('B3 step10: the new rule flags the first attack hour on 5 of 5 seeds', () => {
  const n = seedsWhere('step10', (c) => c.fresh.delay === 0);
  assert.equal(n, 5, `step10 delays: ${delays('step10', 'fresh')}`);
});

test('B4 step3: the new rule flags the first or second attack hour on at least 4 of 5 seeds', () => {
  const n = seedsWhere('step3', (c) => c.fresh.delay !== null && c.fresh.delay <= 1);
  assert.ok(n >= 4, `step3 delays: ${delays('step3', 'fresh')}`);
});

test('B5 night: the new rule flags the first attack hour on at least 4 of 5 seeds', () => {
  const n = seedsWhere('night', (c) => c.fresh.delay === 0);
  assert.ok(n >= 4, `night delays: ${delays('night', 'fresh')}`);
});

// L10 P54: a flagged hour teaches at most RHO times its usual, and the CUSUM clears on one quiet hour
test('B6 flood: after + 5000 in a 10:00 hour, 40 more in the next 10:00 hour is still red on 5 of 5 seeds', () => {
  const n = seedsWhere('flood', (c) => c.fresh.red.includes(250));
  const rows = SEEDS.map((seed) => `${seed}:${card('flood', seed).counts[250]}${card('flood', seed).fresh.red.includes(250) ? ' red' : ''}`);
  console.log(`B6 flood hour 250 (count, red): ${rows.join(', ')}`);
  assert.equal(n, 5, `flood: hour 250 red on ${n} of 5 seeds`);
});

test('B7 (prediction): the mean red hours in the 24 h after an attack, new <= today on step10, step3 and night', () => {
  for (const name of ['step10', 'step3', 'night'] as const) {
    const today = mean(name, (c) => c.today.after);
    const fresh = mean(name, (c) => c.fresh.after);
    console.log(`B7 ${name} red in the 24 h after: today ${today.toFixed(2)} new ${fresh.toFixed(2)}`);
    assert.ok(fresh <= today, `${name}: new ${fresh} > today ${today}`);
  }
});

test('B8 (prediction): no new delay is longer than L9\u{2019}s, per seed', () => {
  const l9: Record<'step10' | 'step3' | 'night' | 'ramp', number[]> = {
    step10: [0, 0, 0, 0, 0],
    step3: [1, 2, 1, 0, 1],
    night: [1, 0, 0, 0, 0],
    ramp: [36, 37, 40, 34, 39],
  };
  for (const name of ['step10', 'step3', 'night', 'ramp'] as const) {
    console.log(`B8 ${name} new delays ${delays(name, 'fresh')} (L9 ${l9[name].join(',')})`);
    SEEDS.forEach((seed, i) => {
      const d = card(name, seed).fresh.delay;
      assert.ok(d !== null && d <= l9[name][i], `${name} seed ${seed}: delay ${d} > L9 ${l9[name][i]}`);
    });
  }
});
