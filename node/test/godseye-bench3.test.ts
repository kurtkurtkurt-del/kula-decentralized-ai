// the brain bench v3 (L8 P47): the split's hop. Every scenario of test/brain-bench/synth3.ts
// through senses, scored by test/brain-bench/bench3.ts: decide.ts's fixed HOP_MS, hop.ts with the
// prior k and hop.ts with the learned k, on each split answer. Seeds 1-5, the thresholds on the
// mean. The thresholds below are the design's predictions; a scenario is never tuned to pass them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runBench3, fromSnapshots, scorecard3Text } = await import('./brain-bench/bench3.ts');
const { scenario3, truth3, SCENARIOS3, SHIFT_AT } = await import('./brain-bench/synth3.ts');

type Card = ReturnType<typeof runBench3>;
type Name = (typeof SCENARIOS3)[number];

const SEEDS = [1, 2, 3, 4, 5];
const run = (name: Name, seed: number): Card =>
  runBench3(fromSnapshots(scenario3(name, seed)), { computeMs: truth3(name).computeMs, shiftAt: SHIFT_AT, first: 100 });

// every scenario and seed, run once and shared by the tests below
const cards = new Map<string, Card>();
const card = (name: Name, seed: number): Card => {
  const key = `${name}:${seed}`;
  let c = cards.get(key);
  if (c === undefined) { c = run(name, seed); cards.set(key, c); }
  return c;
};

const mean = (name: Name, pick: (c: Card) => number | null): number => {
  let s = 0;
  for (const seed of SEEDS) {
    const v = pick(card(name, seed));
    assert.ok(typeof v === 'number' && Number.isFinite(v), `${name} seed ${seed}: ${v}`);
    s += v;
  }
  return s / SEEDS.length;
};

const f4 = (x: number): string => x.toFixed(4);

test('the scorecard v3: every scenario, each seed and the mean of seeds 1-5', () => {
  for (const name of SCENARIOS3) {
    const K = truth3(name).k;
    for (const seed of SEEDS) console.log(scorecard3Text(`${name} seed ${seed}`, card(name, seed), K));
    console.log(
      `${name} mean: fixed ${f4(mean(name, (c) => c.fixed.whole))} / ${f4(mean(name, (c) => c.fixed.after))}`
      + ` | prior ${f4(mean(name, (c) => c.prior.whole))} / ${f4(mean(name, (c) => c.prior.after))}`
      + ` | learned ${f4(mean(name, (c) => c.learned.whole))} / ${f4(mean(name, (c) => c.learned.after))}`
      + ` | first100 after shift: fixed ${f4(mean(name, (c) => c.fixed.first))} prior ${f4(mean(name, (c) => c.prior.first))} learned ${f4(mean(name, (c) => c.learned.first))}`
      + ` | cover80 ${f4(mean(name, (c) => c.interval.cover80))} width80 ${f4(mean(name, (c) => c.interval.width80))}`
      + ` | k ${f4(mean(name, (c) => c.k))} K ${K}`,
    );
  }
});

test('determinism: seed 1 twice is equal, seed 2 is another card', () => {
  for (const name of SCENARIOS3) {
    assert.deepStrictEqual(run(name, 1), card(name, 1), `${name}: seed 1 twice`);
    assert.notDeepStrictEqual(card(name, 2), card(name, 1), `${name}: seed 2`);
  }
});

test('H1 far: learned is at most half of fixed, and no worse than the prior + 0.01', () => {
  const fixed = mean('far', (c) => c.fixed.whole);
  const prior = mean('far', (c) => c.prior.whole);
  const learned = mean('far', (c) => c.learned.whole);
  assert.ok(learned <= 0.5 * fixed, `learned ${learned} vs fixed ${fixed}`);
  assert.ok(learned <= prior + 0.01, `learned ${learned} vs prior ${prior}`);
});

test('H2 lan: learned is no worse than fixed + 0.03', () => {
  const fixed = mean('lan', (c) => c.fixed.whole);
  const learned = mean('lan', (c) => c.learned.whole);
  assert.ok(learned <= fixed + 0.03, `learned ${learned} vs fixed ${fixed}`);
});

test('H3 two: learned is at most half of fixed', () => {
  const fixed = mean('two', (c) => c.fixed.whole);
  const learned = mean('two', (c) => c.learned.whole);
  assert.ok(learned <= 0.5 * fixed, `learned ${learned} vs fixed ${fixed}`);
});

test('H4: the 80% interval covers within [0.70, 0.92], each with n >= 500', () => {
  for (const name of SCENARIOS3) {
    for (const seed of SEEDS) assert.ok(card(name, seed).interval.n >= 500, `${name} seed ${seed}: n ${card(name, seed).interval.n}`);
    const cover = mean(name, (c) => c.interval.cover80);
    assert.ok(cover >= 0.70 && cover <= 0.92, `${name}: cover80 ${cover}`);
  }
});

test('H5 far: the first 100 answers from the shift, learned <= 0.25 and <= fixed', () => {
  for (const seed of SEEDS) assert.equal(card('far', seed).nFirst, 100, `far seed ${seed}`);
  const fixed = mean('far', (c) => c.fixed.first);
  const learned = mean('far', (c) => c.learned.first);
  assert.ok(learned <= 0.25, `learned ${learned}`);
  assert.ok(learned <= fixed, `learned ${learned} vs fixed ${fixed}`);
});

test('H6: at the end k is within 25% of the true K on far and two; lan printed only', () => {
  console.log(`lan k ${f4(mean('lan', (c) => c.k))} K ${truth3('lan').k}`);
  for (const name of ['far', 'two'] as const) {
    const K = truth3(name).k;
    const k = mean(name, (c) => c.k);
    assert.ok(Math.abs(k - K) / K <= 0.25, `${name}: k ${k} K ${K}`);
  }
});
