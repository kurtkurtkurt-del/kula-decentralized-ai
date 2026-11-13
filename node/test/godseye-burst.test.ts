// the refusal burst per hour of day (L9 P53): burst.ts's numbers, worked by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  A0, B0, CUSUM_CAP, DECAY, W_FLAG, burstStep, freshBurst, nbTail, saneBurst, type BurstFit,
} from '../src/godseye/branches/burst.ts';

const near = (x: number, want: number, tol: number, what: string): void =>
  assert.ok(Math.abs(x - want) <= tol, `${what}: ${x}, want ${want} ± ${tol}`);

test('nbTail: the negative binomial tail, worked by hand', () => {
  assert.equal(nbTail(0, 2, 1), 1);
  near(nbTail(1, 2, 1), 0.75, 1e-12, 'nbTail(1, 2, 1)');
  near(nbTail(2, 2, 1), 0.5, 1e-12, 'nbTail(2, 2, 1)');
  near(nbTail(5, 0.5, 1), 0.01012, 1e-4, 'nbTail(5, 0.5, 1)');
  near(nbTail(2, 0.5, 1), 0.116117, 1e-5, 'nbTail(2, 0.5, 1)');
  assert.equal(nbTail(3, 0, 1), 0);
  assert.equal(nbTail(3, -1, 1), 0);
  assert.equal(nbTail(3, Number.NaN, 1), 0);
  assert.equal(nbTail(3, Infinity, 1), 0);
  assert.equal(nbTail(3, 1, 0), 0);
  assert.equal(nbTail(3, 1, Infinity), 0);
  const big = nbTail(50, 20000, 50);
  assert.ok(Number.isFinite(big) && big >= 0 && big <= 1, `nbTail(50, 20000, 50): ${big}`);
});

test('burstStep from a fresh fit: the hour is held and learned at full weight', () => {
  const r1 = burstStep(freshBurst(), 3, 2);
  near(r1.p, 0.116117, 1e-5, 'p');
  assert.equal(r1.usual, 0.5);
  assert.equal(r1.tail, false);
  assert.equal(r1.rise, false);
  near(r1.fit.a[3], 2.5, 1e-12, 'a[3]');
  near(r1.fit.b[3], 2, 1e-12, 'b[3]');
  assert.equal(r1.fit.n, 1);
  assert.equal(r1.fit.s, 0);
  // the other hours stay the prior
  assert.equal(r1.fit.a[4], A0);
  assert.equal(r1.fit.b[4], B0);
  const r2 = burstStep(r1.fit, 3, 4);
  near(r2.fit.a[3], 6.46, 1e-12, 'a[3] after (3, 4)');
  near(r2.fit.b[3], 2.98, 1e-12, 'b[3] after (3, 4)');
  assert.equal(r2.fit.n, 2);
});

test('a known hour: the CUSUM by hand, tail follows p', () => {
  const f = freshBurst();
  f.n = 30;
  f.a[10] = 12.5;
  f.b[10] = 4;
  const r = burstStep(f, 10, 10);
  // 10 ln 3 - 2 * max(0.5, 12.5 / 4) = 10.986123 - 6.25
  near(r.fit.s, 4.736123, 1e-5, 's');
  assert.equal(r.usual, 3.125);
  assert.equal(r.rise, false);
  assert.equal(r.tail, r.p < 0.001);
});

test('the CUSUM never passes its cap, and a flagged hour is learned at W_FLAG', () => {
  let f: BurstFit = freshBurst();
  for (let i = 0; i < 72; i++) f = burstStep(f, i % 24, 0).fit;
  let flagged = 0;
  for (let i = 72; i < 72 + 48; i++) {
    const h = i % 24;
    const before = f;
    const r = burstStep(f, h, 200);
    assert.ok(r.fit.s <= CUSUM_CAP && r.fit.s >= 0, `s ${r.fit.s}`);
    if (r.tail || r.rise) {
      flagged++;
      near(r.fit.b[h], B0 + (before.b[h] - B0) * DECAY + W_FLAG, 1e-12, 'b[h] of a flagged hour');
      near(r.fit.a[h], A0 + (before.a[h] - A0) * DECAY + W_FLAG * 200, 1e-9, 'a[h] of a flagged hour');
    }
    f = r.fit;
  }
  assert.ok(flagged > 0, 'a 200 an hour flood is flagged');
  assert.equal(f.s, CUSUM_CAP);
});

test('bad input returns the same fit object', () => {
  const f = freshBurst();
  for (const [h, k] of [[-1, 1], [24, 1], [1.5, 1], [Number.NaN, 1], [3, -1], [3, Number.NaN], [3, Infinity]] as const) {
    const r = burstStep(f, h, k);
    assert.equal(r.fit, f);
    assert.deepStrictEqual({ tail: r.tail, rise: r.rise, p: r.p, usual: r.usual }, { tail: false, rise: false, p: 1, usual: 0 });
  }
});

test('saneBurst: a round trip, and each bad shape is null', () => {
  let f = freshBurst();
  for (let i = 0; i < 50; i++) f = burstStep(f, i % 24, i % 5).fit;
  const back = saneBurst(JSON.parse(JSON.stringify(f)));
  assert.deepStrictEqual(back, f);
  const ok = (): BurstFit => JSON.parse(JSON.stringify(f));
  const bad: unknown[] = [
    null, 3, 'x', [],
    { ...ok(), a: ok().a.slice(1) },
    { ...ok(), b: [...ok().b, 1] },
    { ...ok(), a: ok().a.map((x, i) => (i === 2 ? A0 - 1e-6 : x)) },
    { ...ok(), b: ok().b.map((x, i) => (i === 2 ? B0 - 1e-6 : x)) },
    { ...ok(), a: ok().a.map((x, i) => (i === 2 ? Number.NaN : x)) },
    { ...ok(), b: ok().b.map((x, i) => (i === 2 ? '1' : x)) },
    { ...ok(), a: undefined },
    { ...ok(), n: -1 },
    { ...ok(), n: 1.5 },
    { ...ok(), n: '3' },
    { ...ok(), s: -0.1 },
    { ...ok(), s: CUSUM_CAP + 0.01 },
    { ...ok(), s: Number.NaN },
  ];
  for (const x of bad) assert.equal(saneBurst(x), null, JSON.stringify(x));
  // within 1e-9 of the floors is accepted
  assert.ok(saneBurst({ ...ok(), a: ok().a.map((x, i) => (i === 0 ? A0 - 5e-10 : x)) }) !== null);
});
