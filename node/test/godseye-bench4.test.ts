// the brain bench v4 (L9 P53): the refusal burst per hour of day. Every scenario of
// test/brain-bench/synth4.ts scored by test/brain-bench/bench4.ts under today's rule (trust.ts on
// finished hours) and burst.ts. Seeds 1-5, the thresholds on the mean or a count of seeds. The
// thresholds below are the design's predictions; a scenario is never tuned to pass them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBench4, scorecard4Text, newReds, levelReds, runOpened, openedText, type Bench4Card, type OpenedCard } from './brain-bench/bench4.ts';
import { SCENARIOS4, OPENED4, HOURS_OPEN, trace, openedTrace, type Scenario4, type Opened4 } from './brain-bench/synth4.ts';

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

// P3 (17.11.2026): a device's own gate opened to the internet. synth4.ts's opened scenarios under
// three rules (bench4.ts): today (burst.ts alone), level (step a, level.ts's refit) and soft (step
// b on top: a stranger-only burst on a gate that faces the internet is a card, not red). The pass
// lines are DECISIONS P3's; the scenario's rates are invented, never tuned to them.
const opened = new Map<string, OpenedCard>();
const ocard = (name: Opened4, seed: number): OpenedCard => {
  const key = `${name}:${seed}`;
  let c = opened.get(key);
  if (c === undefined) { c = runOpened(name, seed); opened.set(key, c); }
  return c;
};
const omean = (name: Opened4, pick: (c: OpenedCard) => number): number =>
  SEEDS.reduce((s, seed) => s + pick(ocard(name, seed)), 0) / SEEDS.length;

test('P3 opened: each seed and the mean under today, level (a) and soft (b)', () => {
  for (const name of OPENED4) {
    for (const seed of SEEDS) console.log(openedText(ocard(name, seed)));
    const row = (rule: 'today' | 'level' | 'soft') =>
      `${rule} week1 red ${omean(name, (c) => c[rule].week1).toFixed(1)} · false red/device-week ${omean(name, (c) => c[rule].perWeek).toFixed(2)}`
      + ` (held ${omean(name, (c) => c[rule].heldPerWeek).toFixed(2)})`
      + `${name === 'opened+guess' ? ` · attack hour red on ${SEEDS.filter((s) => ocard(name, s)[rule].attack).length} of 5` : ''}`;
    console.log(`${name} mean: ${row('today')} | ${row('level')} | ${row('soft')}`);
  }
});

test('P3 determinism: the same seed gives the same trace, opened+guess is opened plus the wrong codes', () => {
  for (const name of OPENED4) {
    assert.deepStrictEqual(runOpened(name, 1), runOpened(name, 1), name);
    assert.notDeepStrictEqual(openedTrace(name, 2).k, openedTrace(name, 1).k, name);
    assert.equal(openedTrace(name, 1).k.length, HOURS_OPEN);
  }
  for (const seed of SEEDS) {
    const a = openedTrace('opened', seed);
    const b = openedTrace('opened+guess', seed);
    assert.deepStrictEqual(b.k.map((k, i) => k - b.guess[i]), a.k, `seed ${seed}`);
    assert.equal(b.guess.reduce((x, y) => x + y, 0), 10);
  }
});

test('P3 today: burst.ts alone keeps an opened gate red most of the week after opening (the reason for a and b)', () => {
  const week1 = omean('opened', (c) => c.today.week1);
  console.log(`P3 opened today: ${week1.toFixed(1)} red hours in the 7 days after opening`);
  assert.ok(week1 >= 84, `today ${week1} red hours of 168: the case for P3 is gone`);
});

test('P3 a: the level refit learns the opened gate, and moves no older scenario', () => {
  for (const seed of SEEDS) {
    const c = ocard('opened', seed);
    // one refit within two days of opening (a quarter of the 24 hours may still hold quiet hours
    // from before, as long as its opened hours fill it), never one before
    assert.ok(c.level.refits.length >= 1 && c.level.refits[0] >= 168 && c.level.refits[0] < 168 + 48, `seed ${seed}: refits ${c.level.refits}`);
    assert.ok(c.level.perWeek < c.today.perWeek, `seed ${seed}`);
  }
  // B1-B8's scenarios: the refit never fires, every red hour stays where it was
  for (const name of SCENARIOS4) for (const seed of SEEDS) assert.deepStrictEqual(levelReds(trace(name, seed)), newReds(trace(name, seed)), `${name} seed ${seed}`);
});

test('P3 pass: opened at most 2 false red hours a device-week from 72 h after opening; opened+guess red in the attack hour on 5 of 5', () => {
  const level = omean('opened', (c) => c.level.perWeek);
  const soft = omean('opened', (c) => c.soft.perWeek);
  console.log(`P3 opened false red/device-week from 72 h: level (a) ${level.toFixed(2)} soft (b) ${soft.toFixed(2)}`);
  assert.ok(soft <= 2, `soft ${soft} > 2`);
  for (const rule of ['today', 'level', 'soft'] as const) {
    const n = SEEDS.filter((s) => ocard('opened+guess', s)[rule].attack).length;
    assert.equal(n, 5, `${rule}: attack hour red on ${n} of 5`);
  }
});
