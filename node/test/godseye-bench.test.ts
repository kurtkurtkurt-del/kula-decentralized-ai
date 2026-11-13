// the brain bench (L5 P30): every scenario of test/brain-bench/synth.ts through the forecast,
// learning and senses branches, scored by test/brain-bench/bench.ts and printed as a scorecard.
// The thresholds below are the design's predictions; a scenario is never tuned to pass them.
// KULA_BENCH_BOX=<dir> also scores a recorded black box (read-only; numbers only, shape asserted).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { runBench, fromSnapshots, boxLooks, scorecardText } = await import('./brain-bench/bench.ts');
const { scenario, speed, rateOf, SCENARIOS, START } = await import('./brain-bench/synth.ts');
const { brier } = await import('../src/godseye/branches/learning.ts');
const { createFixed, V1 } = await import('../src/godseye/branches/forecast.ts');
const { NodeGodsEye } = await import('../src/godseye/node.ts');
const { memoryNotes } = await import('../src/godseye/platform.ts');

type Card = ReturnType<typeof runBench>;
type Name = (typeof SCENARIOS)[number];
type Pair = [number, number, number, number, number, number];

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-bench-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const run = (name: Name, seed: number, keep?: { pairs?: Pair[] }): Card => runBench(fromSnapshots(scenario(name, seed)), keep, { rate: rateOf(name) });
/** the L5 forecast (expert 1 alone, never learning) on the same looks */
const runV1 = (name: Name, seed: number): Card => runBench(fromSnapshots(scenario(name, seed)), undefined, { forecast: createFixed(V1), rate: rateOf(name) });

/** L6 P31 step 0: the seed-1 forecast scorecards of weekly and coin as HEAD (71bc4f5, the L5
 *  forecast, K = 4) printed them, copied at full precision before forecast.ts was touched.
 *  They round to the LOG's .1527 / .174 (weekly brier / ece) and .2593 / .086 (coin).
 *  bins: [n, said, was] */
const V1_CARD = {
  weekly: {
    n: 2008, brier: 0.1527060296722143, brier0: 0.2204958646300744, ece: 0.17440208395086648, cover80: 0,
    bins: [
      [5, 0.06478829465697196, 0.2],
      [321, 0.16514526582161984, 0.056074766355140186],
      [519, 0.24610767755391738, 0.08285163776493257],
      [503, 0.3484850680639747, 0.21669980119284293],
      [239, 0.4377995731915112, 0.5732217573221757],
      [258, 0.5512073931770263, 0.8682170542635659],
      [163, 0.6420894032903905, 0.9447852760736196],
      [0, null, null],
      [0, null, null],
      [0, null, null],
    ],
  },
  coin: {
    n: 668, brier: 0.25930068921967897, brier0: 0.2513611574909116, ece: 0.08596979108050323, cover80: 0,
    bins: [
      [0, null, null],
      [0, null, null],
      [1, 0.2774342120600573, 1],
      [79, 0.3414803147152013, 0.5189873417721519],
      [258, 0.4450186289294644, 0.47674418604651164],
      [263, 0.5424220938700254, 0.46387832699619774],
      [67, 0.6394029118257055, 0.43283582089552236],
      [0, null, null],
      [0, null, null],
      [0, null, null],
    ],
  },
} as const;

// seed 1 of every scenario, run once and shared by the tests below
const cards = new Map<Name, Card>();
const weeklyKeep: { pairs?: Pair[] } = {};
const card = (name: Name): Card => {
  let c = cards.get(name);
  if (c === undefined) {
    c = run(name, 1, name === 'weekly' ? weeklyKeep : undefined);
    cards.set(name, c);
  }
  return c;
};

test('the scorecard of every scenario, seed 1', () => {
  for (const name of SCENARIOS) console.log(scorecardText(`${name} seed 1`, card(name)));
});

test('1: the same seed gives the same scorecard, another seed another one', () => {
  for (const name of SCENARIOS) {
    assert.deepStrictEqual(run(name, 1), card(name), `${name}: seed 1 twice`);
    assert.notDeepStrictEqual(run(name, 2), card(name), `${name}: seed 2`);
  }
});

test('2: weekly, the forecast beats its own prior and a coin', () => {
  const f = card('weekly').forecast;
  assert.ok(f.n >= 500, `n ${f.n}`);
  assert.ok((f.brier as number) < (f.brier0 as number), `brier ${f.brier} vs brier0 ${f.brier0}`);
  assert.ok((f.brier as number) < (f.brierHalf as number), `brier ${f.brier} vs brierHalf ${f.brierHalf}`);
  assert.equal(f.bins.reduce((s, b) => s + b.n, 0), f.n);
  const pairs = weeklyKeep.pairs as Pair[];
  assert.equal(pairs.length, f.n);
  assert.ok(Math.abs((f.brier as number) - brier(pairs).bs) <= 1e-9, `bench ${f.brier} vs learning.ts ${brier(pairs).bs}`);
});

test('3: speed, the learning loop guesses no worse than the last tok/s seen', () => {
  const l = card('speed').learning;
  assert.ok(l.n >= 300, `n ${l.n}`);
  assert.ok((l.pctOff as number) <= (l.naive.pctOff as number), `learning ${l.pctOff} vs naive ${l.naive.pctOff}`);
});

test('4: stable, senses says nothing and nothing goes stale', () => {
  const s = card('stable').senses;
  assert.equal(s.feedLines, 0);
  assert.equal(s.staleLooks, 0);
});

test('5: a box the eye wrote replays to the same scorecard', () => {
  const box = path.join(ROOT, 'box');
  const snaps = [...speed(1, 300)];
  let i = 0;
  let at = START;
  const eye = new NodeGodsEye({ dir: path.join(ROOT, 'notes'), notes: memoryNotes(), box: { dir: box }, now: () => at, snapshot: () => snaps[i] });
  for (; i < snaps.length; i++) {
    at = snaps[i].at;
    eye.tick();
  }
  const looks = boxLooks(box);
  assert.equal(looks.length, 300);
  const direct = runBench(fromSnapshots(snaps));
  const replayed = runBench(looks);
  console.log(scorecardText('speed seed 1, first 300 looks, from the box', replayed));
  assert.deepStrictEqual(replayed, direct);
});

// ---- L6 P31: the forecast's prior strength learned by prediction, against the L5 forecast

const near = (a: number | null, b: number | null, what: string): void => {
  if (a === null || b === null) { assert.equal(a, b, what); return; }
  assert.ok(Math.abs(a - b) <= 1e-9, `${what}: ${a} vs ${b}`);
};

const v1Cards = new Map<string, Card>();
const v1Card = (name: Name, seed: number): Card => {
  const key = `${name}|${seed}`;
  let c = v1Cards.get(key);
  if (c === undefined) { c = runV1(name, seed); v1Cards.set(key, c); }
  return c;
};

test('P31 A: createFixed(V1) is the L5 forecast exactly (V1_CARD, recorded at HEAD before the change)', () => {
  for (const name of ['weekly', 'coin'] as const) {
    const f = v1Card(name, 1).forecast;
    const want = V1_CARD[name];
    assert.equal(f.n, want.n, `${name} n`);
    near(f.brier, want.brier, `${name} brier`);
    near(f.brier0, want.brier0, `${name} brier0`);
    near(f.ece, want.ece, `${name} ece`);
    near(f.cover80, want.cover80, `${name} cover80`);
    assert.equal(f.bins.length, 10);
    f.bins.forEach((b, k) => {
      const [n, said, was] = want.bins[k];
      assert.equal(b.n, n, `${name} bin ${k} n`);
      near(b.said, said, `${name} bin ${k} said`);
      near(b.was, was, `${name} bin ${k} was`);
    });
  }
});

test('P31 B (acceptance): the learned forecast beats the L5 one on weekly and is no worse on coin', () => {
  const w1 = v1Card('weekly', 1).forecast, w2 = card('weekly').forecast;
  assert.ok((w2.brier as number) < (w1.brier as number), `weekly brier v2 ${w2.brier} vs v1 ${w1.brier}`);
  assert.ok((w2.ece as number) < (w1.ece as number), `weekly ece v2 ${w2.ece} vs v1 ${w1.ece}`);
  const c1 = v1Card('coin', 1).forecast, c2 = card('coin').forecast;
  assert.ok((c2.brier as number) <= (c1.brier as number), `coin brier v2 ${c2.brier} vs v1 ${c1.brier}`);
  assert.ok((c2.ece as number) <= (c1.ece as number), `coin ece v2 ${c2.ece} vs v1 ${c1.ece}`);
});

test('P31 printed: v1 against v2 for weekly and coin, seeds 1 and 2', () => {
  const r = (x: number | null): string => (x === null ? '-' : x.toFixed(6));
  for (const name of ['weekly', 'coin'] as const) for (const seed of [1, 2]) {
    const rows: [string, Card][] = [['v1', seed === 1 ? v1Card(name, 1) : runV1(name, seed)], ['v2', seed === 1 ? card(name) : run(name, seed)]];
    for (const [which, c] of rows) {
      const f = c.forecast;
      const d0 = f.brier === null || f.brier0 === null ? null : f.brier - f.brier0;
      console.log(`${name} seed ${seed} ${which}: n ${f.n} · brier ${r(f.brier)} · brier - brier0 ${r(d0)} · ece ${r(f.ece)} · rateCover80 ${r(f.rateCover80)} (n ${f.rateN}) · width80 ${r(f.width80)}`);
    }
  }
});

test('a recorded box (KULA_BENCH_BOX), numbers only', { skip: process.env.KULA_BENCH_BOX ? false : 'KULA_BENCH_BOX is not set' }, () => {
  const sc = runBench(boxLooks(process.env.KULA_BENCH_BOX as string));
  console.log(scorecardText('recorded box', sc));
  assert.equal(typeof sc.looks, 'number');
  assert.equal(sc.forecast.bins.length, 10);
  for (const k of ['learning', 'forecastSpeed'] as const) {
    assert.equal(typeof sc[k].n, 'number');
    assert.equal(sc[k].interval, null);
  }
  assert.equal(typeof sc.senses.feedLines, 'number');
});
