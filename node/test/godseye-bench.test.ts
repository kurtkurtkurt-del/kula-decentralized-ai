// the brain bench (L5 P30): every scenario of test/brain-bench/synth.ts through the forecast,
// learning and senses branches, scored by test/brain-bench/bench.ts and printed as a scorecard.
// The thresholds below are the design's predictions; a scenario is never tuned to pass them.
// KULA_BENCH_BOX=<dir> also scores a recorded black box (read-only; numbers only, shape asserted).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { runBench, fromSnapshots, boxLooks, scorecardText, flipScore } = await import('./brain-bench/bench.ts');
const { scenario, speed, rateOf, SCENARIOS, START, flip, control, flipRate } = await import('./brain-bench/synth.ts');
const { brier } = await import('../src/godseye/branches/learning.ts');
const { createFixed, createV2, V1 } = await import('../src/godseye/branches/forecast.ts');
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

// ---- L7 P37: the habit flip (F7), two fast hour-of-day experts, against the L6 forecast

type Maker = NonNullable<Parameters<typeof runBench>[2]>['forecast'];
type Flip = ReturnType<typeof flipScore>;

/** L7 P37 step 0: the L6 forecast as HEAD (808a50e) printed it, copied at full precision before
 *  forecast.ts was touched. The seed-1 cards round to node-test6.log:201-208 (weekly brier .086261,
 *  ece .050963, rateCover80 .906873; coin brier .255214, ece .052106). bins: [n, said, was] */
const V2_CARD = {
  weekly: {
    n: 2008, brier: 0.08626096716617346, brier0: 0.2204958646300744, ece: 0.05096293521621127, rateCover80: 0.9068725099601593, width80: 0.44286802841726114,
    bins: [
      [798, 0.0428903180403841, 0.07017543859649122],
      [314, 0.14071894167209528, 0.08917197452229299],
      [177, 0.24455762091168767, 0.11864406779661017],
      [60, 0.34641832443320403, 0.11666666666666667],
      [36, 0.44974682450701764, 0.3888888888888889],
      [26, 0.5536730877309766, 0.6153846153846154],
      [32, 0.6605133154144223, 0.6875],
      [62, 0.755025904810574, 0.9838709677419355],
      [133, 0.8651458126859887, 0.8345864661654135],
      [370, 0.9313763368621264, 0.9459459459459459],
    ],
  },
  coin: {
    n: 668, brier: 0.2552136207727337, brier0: 0.2513611574909116, ece: 0.05210573731880469, rateCover80: 1, width80: 0.436223457065187,
    bins: [
      [0, null, null],
      [0, null, null],
      [1, 0.2774342120600573, 1],
      [33, 0.3587333631272393, 0.5151515151515151],
      [377, 0.4629366949403789, 0.48010610079575594],
      [245, 0.5380960180173423, 0.46530612244897956],
      [12, 0.6346564418745403, 0.25],
      [0, null, null],
      [0, null, null],
      [0, null, null],
    ],
  },
} as const;

/** the same HEAD on the flip, mean of seeds 1-5 (week1, d3to10, before, whole), and the mean
 *  Brier of coin and of office on control. They round to SCAN-F's -0.264, -0.006, 0.607, 0.003. */
const V2_FLIP = {
  week1: -0.2635404486613856, d3to10: -0.006415947317857685, before: 0.6073648118318363, whole: 0.0028907373042268425,
  coin: 0.2535167307207637, office: 0.08802719083950938,
} as const;

const SEEDS = [1, 2, 3, 4, 5];
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const brierOf = (ps: Pair[]): number => ps.reduce((a, q) => a + (q[1] - q[5]) ** 2, 0) / ps.length;

const flips = new Map<string, Flip>();
/** one forecast on the flip, 12 looks an hour, its windows */
const flipOf = (which: string, mk: Maker, seed: number): Flip => {
  const key = `${which}|${seed}`;
  let s = flips.get(key);
  if (s === undefined) {
    const keep: { pairs?: Pair[] } = {};
    runBench(fromSnapshots(flip(seed)), keep, { forecast: mk, rate: flipRate, pairsEvery: 1200 });
    s = flipScore(keep.pairs as Pair[]);
    flips.set(key, s);
  }
  return s;
};
const controls = new Map<string, { coin: number; office: number }>();
/** one forecast on control: the Brier of coin and of office */
const controlOf = (which: string, mk: Maker, seed: number): { coin: number; office: number } => {
  const key = `${which}|${seed}`;
  let c = controls.get(key);
  if (c === undefined) {
    const keep: { pairs?: Pair[]; ids?: string[] } = {};
    runBench(fromSnapshots(control(seed)), keep, { forecast: mk, pairsEvery: 1200 });
    const of = (id: string): number => brierOf((keep.pairs as Pair[]).filter((_, i) => (keep.ids as string[])[i] === id));
    c = { coin: of('coin'), office: of('office') };
    controls.set(key, c);
  }
  return c;
};
/** the mean over seeds 1-5 of the flip's windows and the control's two Briers */
const flipMean = (which: string, mk: Maker) => {
  const fs5 = SEEDS.map((sd) => flipOf(which, mk, sd));
  const cs5 = SEEDS.map((sd) => controlOf(which, mk, sd));
  const m = (k: 'week1' | 'd3to10' | 'before' | 'whole'): number => mean(fs5.map((s) => s[k] as number));
  return {
    week1: m('week1'), d3to10: m('d3to10'), before: m('before'), whole: m('whole'),
    lag: [...fs5.map((s) => s.lag)].sort((a, b) => a - b)[2],
    coin: mean(cs5.map((c) => c.coin)), office: mean(cs5.map((c) => c.office)),
  };
};

const v2Cards = new Map<string, Card>();
const v2Card = (name: Name, seed: number): Card => {
  const key = `${name}|${seed}`;
  let c = v2Cards.get(key);
  if (c === undefined) { c = runBench(fromSnapshots(scenario(name, seed)), undefined, { forecast: createV2, rate: rateOf(name) }); v2Cards.set(key, c); }
  return c;
};
const v3Cards = new Map<string, Card>();
const v3Card = (name: Name, seed: number): Card => {
  if (seed === 1) return card(name);
  const key = `${name}|${seed}`;
  let c = v3Cards.get(key);
  if (c === undefined) { c = run(name, seed); v3Cards.set(key, c); }
  return c;
};

test('P37 A: createV2 is the L6 forecast exactly (V2_CARD and V2_FLIP, recorded at HEAD before the change)', () => {
  for (const name of ['weekly', 'coin'] as const) {
    const f = v2Card(name, 1).forecast;
    const want = V2_CARD[name];
    assert.equal(f.n, want.n, `${name} n`);
    near(f.brier, want.brier, `${name} brier`);
    near(f.brier0, want.brier0, `${name} brier0`);
    near(f.ece, want.ece, `${name} ece`);
    near(f.rateCover80, want.rateCover80, `${name} rateCover80`);
    near(f.width80, want.width80, `${name} width80`);
    assert.equal(f.bins.length, 10);
    f.bins.forEach((b, k) => {
      const [n, said, was] = want.bins[k];
      assert.equal(b.n, n, `${name} bin ${k} n`);
      near(b.said, said, `${name} bin ${k} said`);
      near(b.was, was, `${name} bin ${k} was`);
    });
  }
  const v2 = flipMean('v2', createV2);
  for (const k of ['week1', 'd3to10', 'before', 'whole', 'coin', 'office'] as const) near(v2[k], V2_FLIP[k], `flip v2 ${k}`);
});

test('P37 acceptance (A1-A3, mean of seeds 1-5): the forecast learns a habit flip in days and loses nothing elsewhere', () => {
  const v2 = flipMean('v2', createV2), v3 = flipMean('v3', undefined);
  assert.ok(v3.week1 >= 0, `A1: the flip's first week is not worse than the device's own rate (skill ${v3.week1})`);
  assert.ok(v3.d3to10 >= 0.2, `A2: days 3-10 after the flip are learned (skill ${v3.d3to10})`);
  assert.ok(v3.before >= v2.before - 0.02, `A3: the weeks before the flip (v3 ${v3.before} vs v2 ${v2.before})`);
  assert.ok(v3.coin <= v2.coin + 0.005, `A3: control coin Brier (v3 ${v3.coin} vs v2 ${v2.coin})`);
  assert.ok(v3.office <= v2.office + 0.005, `A3: control office Brier (v3 ${v3.office} vs v2 ${v2.office})`);
  for (const name of ['weekly', 'coin'] as const) for (const seed of [1, 2]) {
    const a = v3Card(name, seed).forecast.brier as number, b = v2Card(name, seed).forecast.brier as number;
    assert.ok(a <= b + 0.005, `A3: ${name} seed ${seed} Brier (v3 ${a} vs v2 ${b})`);
  }
});

test('P37 A3b (prediction): calibration and the rate\'s 80% cover hold on weekly and coin, seeds 1 and 2', () => {
  for (const name of ['weekly', 'coin'] as const) for (const seed of [1, 2]) {
    const a = v3Card(name, seed).forecast, b = v2Card(name, seed).forecast;
    assert.ok((a.ece as number) <= (b.ece as number) + 0.02, `${name} seed ${seed} ece (v3 ${a.ece} vs v2 ${b.ece})`);
    if (name === 'weekly') assert.ok((a.rateCover80 as number) >= 0.8, `weekly seed ${seed} rateCover80 ${a.rateCover80}`);
  }
});

test('P37 printed: v1, v2, v3 and createFixed(8) on the flip; v1, v2, v3 on weekly and coin, seeds 1 and 2', () => {
  const r = (x: number | null): string => (x === null ? '-' : x.toFixed(6));
  const s1 = flipOf('v1', createFixed(V1), 1);
  console.log(`flip v1 (seed 1 only): week1 ${r(s1.week1)} \u{b7} d3to10 ${r(s1.d3to10)} \u{b7} whole ${r(s1.whole)} \u{b7} before ${r(s1.before)} \u{b7} lag ${s1.lag} d`);
  for (const [which, mk] of [['v2', createV2], ['v3', undefined], ['fixed8', createFixed(8)]] as [string, Maker][]) {
    const m = flipMean(which, mk);
    console.log(`flip ${which} (mean of seeds 1-5): week1 ${r(m.week1)} \u{b7} d3to10 ${r(m.d3to10)} \u{b7} whole ${r(m.whole)} \u{b7} before ${r(m.before)} \u{b7} median lag ${m.lag} d \u{b7} control coin brier ${r(m.coin)} \u{b7} office brier ${r(m.office)}`);
  }
  for (const name of ['weekly', 'coin'] as const) for (const seed of [1, 2]) {
    const rows: [string, Card][] = [['v1', seed === 1 ? v1Card(name, 1) : runV1(name, seed)], ['v2', v2Card(name, seed)], ['v3', v3Card(name, seed)]];
    for (const [which, c] of rows) {
      const f = c.forecast;
      const d0 = f.brier === null || f.brier0 === null ? null : f.brier - f.brier0;
      console.log(`${name} seed ${seed} ${which}: n ${f.n} \u{b7} brier ${r(f.brier)} \u{b7} brier - brier0 ${r(d0)} \u{b7} ece ${r(f.ece)} \u{b7} rateCover80 ${r(f.rateCover80)} (n ${f.rateN}) \u{b7} width80 ${r(f.width80)}`);
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
