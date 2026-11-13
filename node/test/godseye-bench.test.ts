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
const { scenario, speed, SCENARIOS, START } = await import('./brain-bench/synth.ts');
const { brier } = await import('../src/godseye/branches/learning.ts');
const { NodeGodsEye } = await import('../src/godseye/node.ts');
const { memoryNotes } = await import('../src/godseye/platform.ts');

type Card = ReturnType<typeof runBench>;
type Name = (typeof SCENARIOS)[number];
type Pair = [number, number, number, number, number, number];

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-bench-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const run = (name: Name, seed: number, keep?: { pairs?: Pair[] }): Card => runBench(fromSnapshots(scenario(name, seed)), keep);

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
