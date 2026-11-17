// the brain bench v9 (17 Nov, P2): the far split's first estimate from the engine's measured link
// against the probe, on every scenario of test/brain-bench/synth9.ts, seeds 1-5, 20 homes each. The
// bench's soundness is asserted, the medians printed, and the adoption rule of DECISIONS (P2) checked:
// the new first-estimate median error below the old one and at most 20%. The truth is drawn from the
// same 0.95–1.16 the new pricing assumes (circular, DECISIONS RISK): the real-points test in
// godseye-hop-points.test.ts is the proof against measured answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBench9, runVariant9, summary9, summary9Text, type Home9 } from './brain-bench/bench9.ts';
import { SCENARIOS9, HOMES9, type Scenario9Name } from './brain-bench/synth9.ts';

const SEEDS = [1, 2, 3, 4, 5];

const runs = new Map<string, Home9[]>();
const homes = (name: Scenario9Name, seed: number): Home9[] => {
  const key = `${name}:${seed}`;
  let h = runs.get(key);
  if (h === undefined) { h = runBench9(name, seed); runs.set(key, h); }
  return h;
};
const all = (): Home9[] => SCENARIOS9.flatMap((name) => SEEDS.flatMap((seed) => homes(name, seed)));

test('bench9: one home twice is equal', () => {
  for (const name of SCENARIOS9) {
    assert.deepStrictEqual(runVariant9(name, 1, 0, 'new'), homes(name, 1)[0].new, name);
    assert.deepStrictEqual(runVariant9(name, 1, 0, 'old'), homes(name, 1)[0].old, name);
  }
});

test('bench9: every home is scored first and after 3 answers, both ways', () => {
  for (const name of SCENARIOS9) {
    for (const seed of SEEDS) {
      const hs = homes(name, seed);
      assert.equal(hs.length, HOMES9);
      for (const h of hs) {
        for (const v of ['old', 'new'] as const) {
          const r = h[v];
          assert.ok(r.first !== null && r.first >= 0, `${name} ${seed} ${h.home} ${v}: first ${r.first}`);
          assert.ok(r.after3 !== null && r.after3 >= 0, `${name} ${seed} ${h.home} ${v}: after3 ${r.after3}`);
          assert.equal(r.after3At, 5, `${name} ${seed} ${h.home} ${v}: the 5th answer`);
          assert.ok(r.firstIn !== null);
          assert.ok(r.k !== null);
        }
        // the old pricing learns about a quarter of the true k (the probe is about 4 round trips), the new one k itself
        assert.ok(h.old.k! > 0.15 && h.old.k! < 0.4, `${name} ${seed} ${h.home}: old k ${h.old.k}`);
        assert.ok(Math.abs(h.new.k! - h.truth.k) < 0.25, `${name} ${seed} ${h.home}: new k ${h.new.k} vs ${h.truth.k}`);
      }
    }
  }
});

test('bench9: the medians (printed) and the adoption rule (asserted)', () => {
  for (const name of SCENARIOS9) {
    const hs = SEEDS.flatMap((seed) => homes(name, seed));
    const sc = summary9(hs);
    console.log(summary9Text(name, sc));
    // the widened assumed range (DECISIONS 2 b, RTT_NOISE): at least 65% of first answers inside it, per scenario
    assert.ok(sc.new.cover! >= 0.65, `${name}: new first range holds ${sc.new.cover}`);
  }
  const s = summary9(all());
  console.log(summary9Text('all', s));
  // overall it holds about 8 in 10, neither too narrow (under 70%) nor too wide (over 92%)
  assert.ok(s.new.cover! >= 0.7 && s.new.cover! <= 0.92, `all: new first range holds ${s.new.cover}`);
  const adopt = s.new.first! < s.old.first! && s.new.first! <= 0.2;
  console.log(`P2 adopted: ${adopt ? 'yes' : 'no'} (new first ${(s.new.first! * 100).toFixed(1)}% < old ${(s.old.first! * 100).toFixed(1)}% and <= 20%)`);
  assert.ok(adopt, 'the measured-link pricing must beat the probe on the first estimate, and stay within 20%');
  // learning keeps it: after 3 answers the new estimate is no worse than the old one by more than 2 points
  assert.ok(s.new.after3! <= s.old.after3! + 0.02, `after3 new ${s.new.after3} old ${s.old.after3}`);
});
