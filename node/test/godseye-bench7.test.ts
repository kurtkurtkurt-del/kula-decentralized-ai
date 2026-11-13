// the brain bench v7 (L11 P62): reach's 80% range, today's and four candidates, on steady, far and a
// drift (test/brain-bench/bench7.ts), seeds 1-5. Only the bench's soundness is asserted; the rows
// and the lines I1-I3 are printed for L12 to read, never asserted. Their bounds are predictions.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBench7, wilson, part7Text, CANDIDATES7, SCENARIOS7, DEVICE7, type Bench7Card, type Cand7, type Part7, type Scenario7Name } from './brain-bench/bench7.ts';
import { runBench2, fromSnapshots } from './brain-bench/bench2.ts';
import { scenario2, reachRate } from './brain-bench/synth2.ts';
import { reachBlend, type Experts } from '../src/godseye/branches/reach.ts';

const SEEDS = [1, 2, 3, 4, 5];

const cards = new Map<string, Bench7Card>();
const card = (name: Scenario7Name, seed: number): Bench7Card => {
  const key = `${name}:${seed}`;
  let c = cards.get(key);
  if (c === undefined) { c = runBench7(name, seed); cards.set(key, c); }
  return c;
};

/** the mean over seeds 1-5 of a candidate's cover, width and score */
const mean = (name: Scenario7Name, cand: Cand7, pick: (c: Bench7Card) => Part7): Part7 => {
  const ps = SEEDS.map((seed) => pick(card(name, seed))[cand]);
  const avg = (k: 'cover' | 'width' | 'score'): number => ps.reduce((s, p) => s + (p[k] as number), 0) / ps.length;
  return { n: ps.reduce((s, p) => s + p.n, 0), cover: avg('cover'), width: avg('width'), score: avg('score') };
};

test('bench7: seed 1 twice is equal', () => {
  for (const name of SCENARIOS7) assert.deepStrictEqual(runBench7(name, 1), card(name, 1), `${name}: seed 1 twice`);
});

test('bench7: n >= 1000 per device and seed, and every range has 0 <= lo <= hi <= 1', () => {
  for (const name of SCENARIOS7) {
    for (const seed of SEEDS) {
      const c = card(name, seed);
      assert.equal(c.bad, 0, `${name} seed ${seed}: ${c.bad} ranges out of order`);
      for (const cand of CANDIDATES7) assert.ok(c.whole[cand].n >= 1000, `${name} seed ${seed} ${cand}: n ${c.whole[cand].n}`);
    }
  }
});

test('bench7: the copied wilson gives reachBlend\'s lo and hi on three inputs', () => {
  const inputs: [Experts, number[]][] = [
    [{ p: [0.95, 0.9, 0.93, 0.96], c: [400, 9, 39, 380] }, [0.4, 0.1, 0.2, 0.3]],
    [{ p: [0.5, 0.5, 0.5, 0.5], c: [1, 9, 39, 1] }, [0.25, 0.25, 0.25, 0.25]],
    [{ p: [0.7, 0.2, 0.95, 0.4], c: [12, 3, 39, 5] }, [0.1, 0.6, 0.05, 0.25]],
  ];
  for (const [ex, w] of inputs) {
    const b = reachBlend(ex, w);
    const v = wilson(b.q, b.nu);
    assert.ok(Math.abs(v.lo - b.lo) <= 1e-12, `lo ${v.lo} vs ${b.lo}`);
    assert.ok(Math.abs(v.hi - b.hi) <= 1e-12, `hi ${v.hi} vs ${b.hi}`);
  }
});

test('bench7: now on steady seed 1 is bench2\'s cover80 and width80', () => {
  const b2 = runBench2(fromSnapshots(scenario2('reach', 1)), { rate: (id: string) => reachRate('reach', id) }).reach.steady;
  const now = card('reach', 1).whole.now;
  assert.ok(Math.abs((now.cover as number) - (b2.cover80 as number)) <= 1e-12, `cover ${now.cover} vs ${b2.cover80}`);
  assert.ok(Math.abs((now.width as number) - (b2.width80 as number)) <= 1e-12, `width ${now.width} vs ${b2.width80}`);
});

test('bench7: bench2 on reach seed 1 with and without eachReach is the same', () => {
  const plain = runBench2(fromSnapshots(scenario2('reach', 1)));
  let seen = 0;
  const read = runBench2(fromSnapshots(scenario2('reach', 1)), { eachReach: () => { seen++; } });
  assert.deepStrictEqual(read, plain);
  assert.ok(seen > 0);
});

test('bench7: the rows and the lines I1-I3 (printed, never asserted)', () => {
  const steady = (cand: Cand7): Part7 => mean('reach', cand, (c) => c.whole);
  const far = (cand: Cand7): Part7 => mean('far', cand, (c) => c.whole);
  const drift = (cand: Cand7): Part7 => mean('drift', cand, (c) => c.whole);
  const after = (cand: Cand7): Part7 => mean('drift', cand, (c) => c.after as Record<Cand7, Part7>);
  const lags = (cand: Cand7): (number | null)[] => SEEDS.map((seed) => (card('drift', seed).lag as Record<Cand7, number | null>)[cand]);

  console.log(`bench7, seeds ${SEEDS.join(',')}, the mean over seeds; devices ${JSON.stringify(DEVICE7)}`);
  for (const cand of CANDIDATES7) {
    console.log(`  ${cand}: steady ${part7Text(steady(cand))} | far ${part7Text(far(cand))}`);
    console.log(`    drift ${part7Text(drift(cand))} | after the shift ${part7Text(after(cand))} | lag per seed ${lags(cand).map((x) => (x === null ? '-' : String(x))).join(',')}`);
  }

  const i1 = (cand: Cand7): boolean => [steady(cand), far(cand)].every((p) => (p.cover as number) >= 0.75 && (p.cover as number) <= 0.90);
  const i2 = (cand: Cand7): boolean => (after(cand).cover as number) >= 0.60 && lags(cand).every((x) => x !== null && x <= 100);
  const yes = (b: boolean): string => (b ? 'holds' : 'fails');
  console.log(`I1 (prediction, mean cover on steady and far in [0.75, 0.90]): ${CANDIDATES7.map((c) => `${c} ${yes(i1(c))}`).join(' \u{b7} ')}`);
  console.log(`I2 (prediction, drift after the shift cover >= 0.60 and every lag <= 100): ${CANDIDATES7.map((c) => `${c} ${yes(i2(c))}`).join(' \u{b7} ')}`);

  // the pick is among the four candidates; now is today's and stays when none holds both
  const both = CANDIDATES7.filter((c) => c !== 'now' && i1(c) && i2(c));
  const score3 = (cand: Cand7): number => ((steady(cand).score as number) + (far(cand).score as number) + (drift(cand).score as number)) / 3;
  const ranked = [...both].sort((a, b) => score3(a) - score3(b));
  console.log(`I3 (mean score over steady, far and drift): ${CANDIDATES7.map((c) => `${c} ${score3(c).toFixed(4)}`).join(' \u{b7} ')}`);
  console.log(`I3: ${ranked.length ? `pick: ${ranked[0]}` : 'pick: none (now stays)'}`);
});
