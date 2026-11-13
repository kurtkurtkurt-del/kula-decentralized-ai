// the split's hop (L8 P47): hop.ts's exact math, before anything reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chainTps, hopK, hopStep, hopInterval, saneHop, freshHop, HOP_PRIOR, HOP_KEEP, HOP_ERRS, K_MIN, K_MAX } = await import('../src/godseye/branches/hop.ts');

const close = (a: number, b: number, eps = 1e-5, what = ''): void => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b}`);
const L1 = [{ srtt: 20, rttvar: 2 }];

test('chainTps: 1000 / (compute + k * sum srtt)', () => {
  close(chainTps(120, L1, 1), 7.142857, 1e-6);
  close(chainTps(150, [{ srtt: 20, rttvar: 2 }, { srtt: 140, rttvar: 30 }], 0.5), 1000 / 230, 1e-12);
});

test('hopK: the prior below 3 ks, then the median', () => {
  assert.equal(HOP_PRIOR, 1);
  assert.equal(hopK({ ks: [], errs: [] }), 1);
  assert.equal(hopK({ ks: [0.4, 0.6], errs: [] }), 1);
  assert.equal(hopK({ ks: [0.4, 0.6, 0.5], errs: [] }), 0.5);
  close(hopK({ ks: [0.9, 0.2, 0.6, 0.4], errs: [] }), 0.5, 1e-12, 'mean of the middle two');
});

test('hopStep: one answer adds one err and one k', () => {
  const f = hopStep(freshHop(), 120, L1, 7.692308);
  assert.equal(f.errs.length, 1);
  assert.equal(f.ks.length, 1);
  close(f.errs[0], 0.071429, 1e-5, 'err');
  close(f.ks[0], 0.5, 1e-5, 'k');
});

test('hopStep: a k below the floor is K_MIN, above the ceiling K_MAX', () => {
  assert.equal(hopStep(freshHop(), 120, L1, 10).ks[0], K_MIN);
  assert.equal(hopStep(freshHop(), 120, L1, 0.01).ks[0], K_MAX);
});

test('hopStep: a 16th k drops the oldest, a 31st err too', () => {
  let f = freshHop();
  for (let j = 0; j < HOP_KEEP; j++) f = hopStep(f, 100, L1, 1000 / (100 + 20 * (0.1 + j * 0.01)));
  assert.equal(f.ks.length, 15);
  close(f.ks[0], 0.1, 1e-9, 'oldest k');
  f = hopStep(f, 100, L1, 1000 / (100 + 20 * 0.9));
  assert.equal(f.ks.length, 15);
  close(f.ks[0], 0.11, 1e-9, 'oldest k after the 16th');
  close(f.ks[14], 0.9, 1e-9, 'newest k');

  let g = freshHop();
  for (let j = 0; j < HOP_ERRS; j++) g = hopStep(g, 100, L1, 5 + j);
  assert.equal(g.errs.length, 30);
  const first = g.errs[0];
  const second = g.errs[1];
  g = hopStep(g, 100, L1, 50);
  assert.equal(g.errs.length, 30);
  assert.notEqual(g.errs[0], first);
  assert.equal(g.errs[0], second);
});

test('hopStep: unusable input returns the same object', () => {
  const f = hopStep(freshHop(), 120, L1, 7.692308);
  for (const [c, links, tps] of [
    [0, L1, 7], [-1, L1, 7], [NaN, L1, 7], [Infinity, L1, 7],
    [120, L1, 0], [120, L1, -3], [120, L1, NaN], [120, L1, Infinity],
    [120, [], 7], [120, null, 7],
    [120, [{ srtt: 0, rttvar: 1 }], 7], [120, [{ srtt: NaN, rttvar: 1 }], 7], [120, [{ srtt: Infinity, rttvar: 1 }], 7],
    [120, [{ srtt: 20, rttvar: 2 }, { srtt: -5, rttvar: 2 }], 7], [120, [null], 7],
  ] as [number, any, number][]) {
    assert.equal(hopStep(f, c, links, tps), f, `${c} ${JSON.stringify(links)} ${tps}`);
  }
});

test('hopInterval: split-conformal 80%', () => {
  const iv = hopInterval(10, [0.1, 0.2, 0.3, 0.4]);
  assert.ok(iv !== null);
  close(iv.lo, 7.142857, 1e-6, 'lo');
  close(iv.hi, 16.666667, 1e-6, 'hi');
  assert.equal(hopInterval(10, [0.1, 0.2, 0.3]), null);
  assert.equal(hopInterval(10, []), null);
  const open = hopInterval(10, [1, 1, 1, 1]);
  assert.ok(open !== null);
  assert.equal(open.hi, Infinity);
  close(open.lo, 5, 1e-12, 'lo with q 1');
});

test('saneHop: a round trip, and every bad shape is null', () => {
  let f = freshHop();
  for (let j = 0; j < 40; j++) f = hopStep(f, 120, L1, 5 + (j % 7));
  const back = saneHop(JSON.parse(JSON.stringify(f)));
  assert.deepStrictEqual(back, f);
  assert.deepStrictEqual(saneHop({ ks: [], errs: [] }), freshHop());
  for (const bad of [
    null, undefined, 1, 'x', [], {},
    { ks: [] }, { errs: [] }, { ks: 'a', errs: [] }, { ks: [], errs: {} },
    { ks: [0.01], errs: [] }, { ks: [21], errs: [] }, { ks: [NaN], errs: [] }, { ks: ['1'], errs: [] },
    { ks: new Array(16).fill(1), errs: [] },
    { ks: [], errs: [-0.1] }, { ks: [], errs: [Infinity] }, { ks: [], errs: [null] },
    { ks: [], errs: new Array(31).fill(0.1) },
  ]) {
    assert.equal(saneHop(bad), null, JSON.stringify(bad));
  }
});
