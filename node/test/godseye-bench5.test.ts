// the brain bench v5 (L10 P57): the faster-split card's rule, the point against the interval's low
// end, on every scenario of test/brain-bench/synth3.ts, seeds 1-5. Only the bench's soundness is
// asserted; the shares and the verdict lines V1-V3 are printed for L11 to read, never asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBench5, wrong, missed, shares5Text, RATIOS, RULES5, type Bench5Card, type Shares5 } from './brain-bench/bench5.ts';
import { runBench3, fromSnapshots } from './brain-bench/bench3.ts';
import { scenario3, truth3, SCENARIOS3, SHIFT_AT, type Scenario3Name } from './brain-bench/synth3.ts';

const SEEDS = [1, 2, 3, 4, 5];

const cards = new Map<string, Bench5Card>();
const card = (name: Scenario3Name, seed: number): Bench5Card => {
  const key = `${name}:${seed}`;
  let c = cards.get(key);
  if (c === undefined) { c = runBench5(name, seed); cards.set(key, c); }
  return c;
};

/** the mean over seeds 1-5 of each rule's share at each ratio */
const meanShares = (name: Scenario3Name, pick: (c: Bench5Card) => Shares5): Shares5 => {
  const out = {} as Shares5;
  for (const rule of RULES5) out[rule] = RATIOS.map((_, j) => SEEDS.reduce((s, seed) => s + pick(card(name, seed))[rule][j], 0) / SEEDS.length);
  return out;
};

test('bench5: seed 1 twice is equal', () => {
  for (const name of SCENARIOS3) assert.deepStrictEqual(runBench5(name, 1), card(name, 1), `${name}: seed 1 twice`);
});

test('bench5: n >= 500, nBand <= n and every share in [0, 1], each scenario and seed', () => {
  for (const name of SCENARIOS3) {
    for (const seed of SEEDS) {
      const c = card(name, seed);
      assert.ok(c.n >= 500, `${name} seed ${seed}: n ${c.n}`);
      assert.ok(c.nBand <= c.n, `${name} seed ${seed}: nBand ${c.nBand} n ${c.n}`);
      assert.ok(c.first.nBand <= c.first.n, `${name} seed ${seed}: first nBand ${c.first.nBand} n ${c.first.n}`);
      for (const part of [c.shares, c.first.shares]) {
        for (const rule of RULES5) {
          assert.equal(part[rule].length, RATIOS.length);
          for (const x of part[rule]) assert.ok(x >= 0 && x <= 1, `${name} seed ${seed} ${rule}: ${x}`);
        }
      }
    }
  }
});

test('bench5: bench3 with `each` gives the same scorecard as without (far seed 1)', () => {
  const opts = { computeMs: truth3('far').computeMs, shiftAt: SHIFT_AT, first: 100 };
  const plain = runBench3(fromSnapshots(scenario3('far', 1)), opts);
  let seen = 0;
  const read = runBench3(fromSnapshots(scenario3('far', 1)), { ...opts, each: () => { seen++; } });
  assert.deepStrictEqual(read, plain);
  assert.equal(seen, plain.n);
});

test('bench5: the mean shares per scenario and the verdict lines (printed, never asserted)', () => {
  const whole = new Map<Scenario3Name, Shares5>();
  const first = new Map<Scenario3Name, Shares5>();
  for (const name of SCENARIOS3) {
    whole.set(name, meanShares(name, (c) => c.shares));
    first.set(name, meanShares(name, (c) => c.first.shares));
    const n = SEEDS.map((seed) => `${card(name, seed).n}/${card(name, seed).nBand}`).join(',');
    console.log(`${name} n/nBand per seed: ${n}`);
    for (const line of shares5Text(`${name} mean`, whole.get(name)!)) console.log(line);
    for (const line of shares5Text(`${name} first100 mean`, first.get(name)!)) console.log(line);
  }
  const yes = (b: boolean): string => (b ? 'yes' : 'no');
  const v1 = SCENARIOS3.every((name) => {
    const s = whole.get(name)!;
    return [1.1, 1.3].every((r) => wrong(s, 'low', r) <= wrong(s, 'point', r) + 0.01);
  });
  const v2 = SCENARIOS3.every((name) => {
    const s = whole.get(name)!;
    return missed(s, 'low', 0.8) <= missed(s, 'point', 0.8) + 0.02;
  });
  const f = first.get('far')!;
  const v3 = wrong(f, 'low', 1.1) <= wrong(f, 'point', 1.1);
  console.log(`V1 holds: ${yes(v1)} (every scenario, wrong(low) <= wrong(point) + 0.01 at 1.1 and 1.3)`);
  console.log(`V2 holds: ${yes(v2)} (every scenario, missed(low) <= missed(point) + 0.02 at 0.8)`);
  console.log(`V3 holds: ${yes(v3)} (far, first 100 from the shift, wrong(low) <= wrong(point) at 1.1)`);
});
