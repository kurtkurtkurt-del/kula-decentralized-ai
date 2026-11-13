// the brain bench v2 (L6 P32): every scenario of test/brain-bench/synth2.ts through the senses,
// learning and connections branches, scored by test/brain-bench/bench2.ts and printed as a
// scorecard: learning's speed interval, its reachability guess, and the link latency guesses.
// The thresholds below are the design's predictions; a scenario is never tuned to pass them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runBench2, fromSnapshots, scorecard2Text } = await import('./brain-bench/bench2.ts');
const { scenario2, SCENARIOS2 } = await import('./brain-bench/synth2.ts');

type Card = ReturnType<typeof runBench2>;
type Name = (typeof SCENARIOS2)[number];

const run = (name: Name, seed: number): Card => runBench2(fromSnapshots(scenario2(name, seed)));

// seed 1 of every scenario, run once and shared by the tests below
const cards = new Map<Name, Card>();
const card = (name: Name): Card => {
  let c = cards.get(name);
  if (c === undefined) { c = run(name, 1); cards.set(name, c); }
  return c;
};

test('the scorecard v2 of every scenario, seed 1', () => {
  for (const name of SCENARIOS2) console.log(scorecard2Text(`${name} seed 1`, card(name)));
});

test('1: the same seed gives the same scorecard, another seed another one', () => {
  for (const name of SCENARIOS2) {
    assert.deepStrictEqual(run(name, 1), card(name), `${name}: seed 1 twice`);
    assert.notDeepStrictEqual(run(name, 2), card(name), `${name}: seed 2`);
  }
});

test('2: speed, p2\'s 80% interval covers about 80%', () => {
  const s = card('speed').speed;
  console.log(`p1 interval: ${JSON.stringify(s.p1)}`);
  const p2 = s.p2;
  assert.ok(p2.n >= 300, `n ${p2.n}`);
  assert.ok((p2.cover80 as number) >= 0.70 && (p2.cover80 as number) <= 0.92, `cover80 ${p2.cover80}`);
});

test('3: reach, steady: the guess is no worse than the last outcome', () => {
  const r = card('reach').reach;
  console.log(`bursty reach: ${JSON.stringify(r.bursty)}`);
  const s = r.steady;
  assert.ok(s.n >= 1000, `n ${s.n}`);
  assert.ok((s.brier as number) <= (s.brierNaive as number), `brier ${s.brier} vs brierNaive ${s.brierNaive}`);
});

test('4: far, near: connections is no further off than the last ms; far is scored and finite', () => {
  const l = card('far').latency;
  console.log(`far lag: ${JSON.stringify(l.far.lag)} · near lag: ${JSON.stringify(l.near.lag)}`);
  const near = l.near;
  assert.ok((near.connections.pctOff as number) <= (near.naive.pctOff as number), `connections ${near.connections.pctOff} vs naive ${near.naive.pctOff}`);
  const far = l.far;
  assert.ok(far.n >= 1000, `n ${far.n}`);
  for (const k of ['connections', 'senses', 'naive'] as const) {
    for (const v of [far[k].pctOff, far[k].mae]) assert.ok(typeof v === 'number' && Number.isFinite(v), `far ${k} ${v}`);
  }
});
