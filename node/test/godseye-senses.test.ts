// god's eye, branch 1 senses: the pure maths (median, MAD, RFC 6298, flap change, staleness) with
// numbers worked out by hand, then the branch through create(ctx): whole view lines, the probe
// window, spikes, flapping with hysteresis, staleness, backward and far-forward clocks, the caps,
// corrupt notes, bad snapshot values, device ids that are object keys, a quiet cluster, a restart,
// null containers, a ghost at the cap, absurd numbers, a nameless device, a lasting latency shift.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { create, median, mad, rfc6298, flapChange, isStale, usualGap } = await import('../src/godseye/branches/senses.ts');

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const snap = (devices: any[], at: number): any => ({
  at, host: { name: 'mac', freeMb: 4000 }, devices,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true },
  models: [], projects: [],
});

/** a fake ctx: its own clock, a notes "file" in memory, the feed in an array */
function fakeCtx(stored: unknown = undefined) {
  const c = { t: new Date(2026, 10, 8, 23, 0, 0).getTime(), stored, saves: 0, feed: [] as string[] };
  const ctx = {
    now: () => c.t,
    load: <T>(fallback: T): T => (c.stored === undefined ? fallback : structuredClone(c.stored) as T),
    save: (d: unknown) => { c.stored = structuredClone(d); c.saves++; },
    emit: (s: string) => { c.feed.push(s); },
    peek: () => null,
  };
  return { c, ctx };
}

const row = (v: any, k: string) => v.rows.find((r: [string, string]) => r[0] === k)![1];
const close = (got: number | null, want: number) => assert.ok(got != null && Math.abs(got - want) < 1e-12, `${got} ≈ ${want}`);

// ---- the pure maths

test('median: the middle value, the mean of the two middle ones, null for none', () => {
  assert.equal(median([]), null);
  assert.equal(median([3]), 3);
  assert.equal(median([3, 1, 2]), 2);              // sorted 1 2 3
  assert.equal(median([1, 2, 3, 4]), 2.5);         // (2 + 3) / 2
  assert.equal(median([12, 11, 800, 13, 12]), 12); // sorted 11 12 12 13 800
});

test('mad: the median distance from the median', () => {
  assert.equal(mad([]), null);
  assert.equal(mad([10, 12, 14]), 2);              // median 12, distances 2 0 2, median 2
  assert.equal(mad([1, 2, 3, 4, 5]), 1);           // median 3, distances 2 1 0 1 2, median 1
  assert.equal(mad([11, 12, 12, 13]), 0.5);        // median 12, distances 1 0 0 1, (0 + 1) / 2
});

test('rfc 6298: the first sample, then RTTVAR before SRTT', () => {
  assert.deepEqual(rfc6298(null, null, 100), { srtt: 100, rttvar: 50 });
  const a = rfc6298(100, 50, 200);
  assert.equal(a.rttvar, 62.5);                    // 3/4 * 50 + 1/4 * |100 - 200| = 37.5 + 25
  assert.equal(a.srtt, 112.5);                     // 7/8 * 100 + 1/8 * 200 = 87.5 + 25
  const b = rfc6298(a.srtt, a.rttvar, 100);
  assert.equal(b.rttvar, 50);                      // 3/4 * 62.5 + 1/4 * |112.5 - 100| = 46.875 + 3.125
  assert.equal(b.srtt, 110.9375);                  // 7/8 * 112.5 + 1/8 * 100 = 98.4375 + 12.5
});

test('flap change: weighted places, newer weighs more, null under 8 readings', () => {
  assert.equal(flapChange([true, false, true, false, true, false, true]), null);
  assert.equal(flapChange([true, true, true, true, true, true, true, true]), 0);
  assert.equal(flapChange([true, false, true, false, true, false, true, false]), 1);   // every place changed
  // 8 readings: 7 places, weights 0.8 .. 0.8 + 0.4 * 6/19; first and newest changed:
  // (0.8 + 0.8 + 2.4/19) / (5.6 + 8.4/19) = 32.8 / 114.8 = 2/7
  close(flapChange([true, false, false, false, false, false, false, true]), 2 / 7);
  // 21 readings: 20 places of total weight 20; only the oldest changed: 0.8 / 20 = 0.04,
  // only the newest: 1.2 / 20 = 0.06
  const twenty = Array(20).fill(true);
  close(flapChange([false, ...twenty]), 0.04);
  close(flapChange([...twenty, false]), 0.06);
});

test('stale: three usual gaps, the default before, clamped to 5–120 s, no negative gap', () => {
  assert.equal(isStale(60_000, 20_000, []), false);                        // default 15 s: 40 s < 45 s
  assert.equal(isStale(66_000, 20_000, []), true);                         // 46 s > 45 s
  assert.equal(isStale(45_000, 15_000, [10_000, 10_000, 20_000]), false);  // gap 10 s: exactly 30 s
  assert.equal(isStale(45_001, 15_000, [10_000, 10_000, 20_000]), true);   // a hair over
  assert.equal(isStale(6_000, 0, [1_000, 1_000, 1_000]), false);           // 1 s gaps clamp to 5 s: 6 s < 15 s
  assert.equal(isStale(400_000, 0, [200_000, 200_000, 200_000]), true);    // clamped to 120 s: 400 s > 360 s
  assert.equal(isStale(1_000, 60_000, [10_000, 10_000, 10_000]), false);   // at 59 s before checkedAt: no silence
  assert.equal(isStale(95_000, 60_000, [10_000, 10_000, 10_000]), true);   // at 35 s after: 35 s > 30 s
  assert.equal(isStale(10_000, null, []), false);                          // never looked at: not stale
  assert.equal(isStale(50_000, 0, [-50_000, 10_000, 20_000, 30_000]), false); // the -50 s gap is not a gap: 50 s < 60 s
  assert.equal(isStale(1e300, 0, []), false);                              // an absurd at: no staleness judged
  assert.equal(isStale(NaN, 0, []), false);
  assert.equal(isStale(10_000, 1e300, []), false);                         // an absurd checkedAt: the same
});

test('the usual gap: the median of the positive gaps, 15 s under three, clamped to 5–120 s', () => {
  assert.equal(usualGap([]), 15_000);                                      // the default
  assert.equal(usualGap([10_000, 20_000]), 15_000);                        // two gaps: still the default
  assert.equal(usualGap([10_000, 10_000, 20_000]), 10_000);                // median of 10, 10, 20
  assert.equal(usualGap([-50_000, 10_000, 20_000, 30_000]), 20_000);       // the negative one is no gap: 10, 20, 30
  assert.equal(usualGap([NaN, 10_000, 10_000, 10_000]), 10_000);           // neither is a NaN
  assert.equal(usualGap([1_000, 1_000, 1_000]), 5_000);                    // clamped up
  assert.equal(usualGap([200_000, 200_000, 200_000]), 120_000);            // clamped down
});

// ---- the branch

test('an empty snapshot: built, no device, and no invented numbers', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  b.observe(snap([], 1_000), null);
  const v = b.view();
  assert.equal(v.built, true);
  assert.equal(v.stat, 'no device yet');
  assert.equal(v.gauge, null);
  assert.deepEqual(v.rows, [['devices', '0'], ['flapping', 'none'], ['stale', 'none']]);
  assert.deepEqual(v.lines, []);
  assert.equal(v.note, 'no device yet. devices (top right) adds one.');
  assert.match(v.what!, /last 30/);
});

test('the reach lines stay: stopped answering, then answers again', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const up = snap([dev({ checkedAt: 1_000 })], 1_000);
  const down = snap([dev({ reachable: false, reachMs: null, reason: 'connect timeout', checkedAt: 16_000 })], 16_000);
  b.observe(up, null);
  b.observe(down, up);
  b.observe(snap([dev({ checkedAt: 31_000 })], 31_000), down);
  assert.deepEqual(c.feed, ['pixel stopped answering: connect timeout', 'pixel answers again']);
});

test('the same checkedAt seen three times is one reading', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  b.observe(snap([dev({ checkedAt: 1_000 })], 1_000), null);
  c.t += 30_000;
  b.observe(snap([dev({ checkedAt: 1_000 })], 5_000), null);
  c.t += 30_000;
  b.observe(snap([dev({ checkedAt: 1_000 })], 10_000), null);   // 60 s of looks: the notes are saved
  const saved = c.stored as any;
  assert.equal(saved.v, 1);
  assert.deepEqual(saved.dev.p1.r, [{ at: 1_000, ok: true, ms: 12 }]);
});

test('under five ok looks it says so, it does not guess', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (let i = 0; i < 4; i++) { b.observe(snap([dev({ checkedAt: t })], t), null); t += 15_000; }
  const line = b.view().lines[0];
  assert.match(line, /not enough looks yet/);
  assert.doesNotMatch(line, /usually/);
});

test('five 12 ms looks: the whole line, name first, with the usual range', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (let i = 0; i < 5; i++) { b.observe(snap([dev({ checkedAt: t })], t), null); t += 15_000; }
  // first sample: SRTT 12, RTTVAR 6; four smooth steps: 6 * (3/4)^4 = 1.8984375,
  // 4 * RTTVAR = 7.59375: lo round(12 - 7.59375) = 4, hi round(12 + 7.59375) = 20
  assert.equal(b.view().lines[0], 'pixel · reachable · 12 ms · usually 12 ms (4–20) · 3.3 GB free · 60 GB/s');
});

test('an 800 ms spike among 12 ms looks is an outlier: the whole line after it stays put', () => {
  const ms = [11, 12, 13, 11, 12, 13, 11, 12, 13, 11, 12, 13, 11, 12, 13];   // five of each
  assert.equal(median(ms), 12);
  assert.equal(mad(ms), 1);                     // ten distances of 1, five of 0
  const withSpike = [...ms, 800];
  assert.equal(median(withSpike), 12);          // the spike does not move the middle
  assert.equal(mad(withSpike), 1);              // sigma = 1.4826: 800 is far over 3.5 sigma

  const { ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (const x of ms) { b.observe(snap([dev({ reachMs: x, checkedAt: t })], t), null); t += 15_000; }
  b.observe(snap([dev({ reachMs: 800, checkedAt: t })], t), null);
  // the 15 good samples: SRTT 11.94184720871067, RTTVAR 0.9334087168758742,
  // 4 * RTTVAR = 3.733634867503497: lo round(8.2082...) = 8, hi round(15.6755...) = 16
  assert.equal(b.view().lines[0], 'pixel · reachable · 800 ms · usually 12 ms (8–16) · 3.3 GB free · 60 GB/s');
});

test('an 800 ms spike among identical 12 ms looks is a spike and does not enter SRTT', () => {
  const same = Array(10).fill(12);
  assert.equal(median(same), 12);
  assert.equal(mad(same), 0);                    // MAD 0: the 3.5 * max(1 ms, 5% of median) floor decides
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (const x of same) { b.observe(snap([dev({ reachMs: x, checkedAt: t })], t), null); t += 15_000; }
  // ten 12 ms samples: SRTT 12, RTTVAR 6 * (3/4)^9 = 0.45050811767578125,
  // 4 * RTTVAR = 1.802032470703125: lo round(10.1979...) = 10, hi round(13.8020...) = 14
  c.t += 60_000;
  b.observe(snap([dev({ reachMs: 800, checkedAt: t })], t), null);
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.r.length, 11, 'the spike is still in the window');
  assert.equal(saved.dev.p1.srtt, 12, 'but it stayed out of the smooth');
  assert.equal(b.view().lines[0], 'pixel · reachable · 800 ms · usually 12 ms (10–14) · 3.3 GB free · 60 GB/s');
});

test('flapping starts at 8 alternating looks and ends with hysteresis: exactly two lines', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (const ok of [true, false, true, false, true, false, true, false]) {
    b.observe(snap([dev({ reachable: ok, reachMs: ok ? 12 : null, checkedAt: t })], t), null);
    t += 15_000;
  }
  // 8 readings, 7 places, every one changed: change = 1.0
  assert.deepEqual(c.feed, ['pixel is flapping: its link went up and down 7 times in the last 8 looks']);
  assert.equal(row(b.view(), 'flapping'), 'pixel');
  assert.equal(b.view().lines[0], 'pixel · not reachable: no answer · not enough looks yet · flapping · 3.3 GB free · 60 GB/s');
  // 17 steady looks push the old changes to the oldest places: 3 changes of weights 0.8, 0.821, 0.842
  // over 20 -> change 0.123 <= 0.15, while 16 steady looks give 4 changes -> 0.166 > 0.15
  for (let i = 0; i < 16; i++) { b.observe(snap([dev({ reachable: false, reachMs: null, checkedAt: t })], t), null); t += 15_000; }
  assert.equal(c.feed.length, 1, 'still flapping at 0.166');
  b.observe(snap([dev({ reachable: false, reachMs: null, checkedAt: t })], t), null);
  assert.deepEqual(c.feed, [
    'pixel is flapping: its link went up and down 7 times in the last 8 looks',
    'pixel stopped flapping',
  ]);
  assert.equal(row(b.view(), 'flapping'), 'none');
});

test('a device the engine stopped probing is stale: whole line, no ms, no usual latency', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (let i = 0; i < 5; i++) { b.observe(snap([dev({ checkedAt: t })], t), null); t += 15_000; }
  const last = t - 15_000;                                       // 61 000: the last new reading
  b.observe(snap([dev({ checkedAt: last })], last + 45_000), null);   // exactly three 15 s gaps: not yet
  assert.equal(row(b.view(), 'stale'), 'none');
  assert.match(b.view().lines[0], /usually 12 ms \(4–20\)/);
  b.observe(snap([dev({ checkedAt: last })], last + 45_001), null);
  const v = b.view();
  assert.equal(row(v, 'stale'), 'pixel');
  assert.equal(v.lines[0], 'pixel · reachable · stale: last looked at 45 s ago · 3.3 GB free · 60 GB/s');
  assert.doesNotMatch(v.lines[0], /\d+ ms/);
});

test('a backward clock: readings are taken in, no negative gap, staleness follows the clock', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  b.observe(snap([dev({ checkedAt: 60_000 })], 60_000), null);
  c.t += 60_000;
  b.observe(snap([dev({ checkedAt: 30_000 })], 30_000), null);   // the clock stepped back
  const saved = c.stored as any;
  assert.deepEqual(saved.dev.p1.r.map((r: any) => r.at), [60_000, 30_000]);
  assert.equal(row(b.view(), 'stale'), 'none');
  // at well before checkedAt: a negative silence, never stale
  b.observe(snap([dev({ checkedAt: 30_000 })], 1_000), null);
  assert.equal(row(b.view(), 'stale'), 'none');
  assert.doesNotMatch(b.view().lines[0], /stale:/);
  // at after checkedAt: stale, no loop and no negative number
  b.observe(snap([dev({ checkedAt: 30_000 })], 10_000_000_000), null);
  assert.equal(row(b.view(), 'stale'), 'pixel');
});

test('a far-forward clock: readings land, show and save; a restart keeps them', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (let i = 0; i < 5; i++) { b.observe(snap([dev({ checkedAt: t })], t), null); t += 15_000; }
  const far = Date.UTC(2400, 0, 1);                   // years ahead, still a usable time
  assert.ok(far > 8.64e12 && far < 8.64e15);
  c.t = far;
  b.observe(snap([dev({ checkedAt: far })], far), null);
  // six 12 ms samples: RTTVAR 6 * (3/4)^5 = 1.423828125, 4 * RTTVAR = 5.6953125: 6 and 18
  assert.equal(b.view().lines[0], 'pixel · reachable · 12 ms · usually 12 ms (6–18) · 3.3 GB free · 60 GB/s');
  let saved = c.stored as any;
  assert.equal(saved.dev.p1.r[saved.dev.p1.r.length - 1].at, far);
  assert.equal(saved.dev.p1.seen, far);

  // the clock is right again: a normal time, behind the jump
  const right = 300_000;
  c.t = new Date(2026, 10, 8, 23, 5, 0).getTime();
  b.observe(snap([dev({ checkedAt: right })], right), null);
  // seven samples: RTTVAR 6 * (3/4)^6 = 1.06787109375, 4 * RTTVAR = 4.271484375: 8 and 16
  assert.equal(b.view().lines[0], 'pixel · reachable · 12 ms · usually 12 ms (8–16) · 3.3 GB free · 60 GB/s');
  c.t += 60_000;
  b.observe(snap([dev({ checkedAt: right + 15_000 })], right + 15_000), null);
  saved = c.stored as any;
  assert.deepEqual(saved.dev.p1.r.slice(-2).map((r: any) => r.at), [right, right + 15_000]);
  assert.ok(saved.dev.p1.r.some((r: any) => r.at === far), 'the far reading is still in the window');

  // a restart reads it back and keeps taking readings
  const b2 = create(ctx);
  b2.observe(snap([dev({ checkedAt: right + 30_000 })], right + 30_000), null);
  // nine samples: RTTVAR 6 * (3/4)^8 = 0.600677490234375, 4 * RTTVAR = 2.4027099609375: 10 and 14
  assert.equal(b2.view().lines[0], 'pixel · reachable · 12 ms · usually 12 ms (10–14) · 3.3 GB free · 60 GB/s');
  c.t += 60_000;
  b2.observe(snap([dev({ checkedAt: right + 45_000 })], right + 45_000), null);
  const after = c.stored as any;
  assert.ok(after.dev.p1.r.some((r: any) => r.at === far));
  assert.equal(after.dev.p1.r[after.dev.p1.r.length - 1].at, right + 45_000);
});

test('41 devices: the least recently seen is the one dropped', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  b.observe(snap(Array.from({ length: 40 }, (_, i) => dev({ id: `d${i}`, name: `dev ${i}`, checkedAt: 1_000 })), 1_000), null);
  c.t += 60_000;
  // d0 misses this look: its seen stays 1 000 while d1..d39 move to 2 000; d40 appears
  b.observe(snap(Array.from({ length: 40 }, (_, i) => dev({ id: `d${i + 1}`, name: `dev ${i + 1}`, checkedAt: 2_000 })), 2_000), null);
  const saved = c.stored as any;
  assert.equal(Object.keys(saved.dev).length, 40);
  assert.equal(saved.dev.d0, undefined, 'the one not seen in the last look went');
  assert.ok(saved.dev.d1);
  assert.ok(saved.dev.d40);
});

test('the window keeps the last 30 new readings', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (let i = 0; i < 35; i++) { b.observe(snap([dev({ checkedAt: t })], t), null); c.t += 60_000; t += 15_000; }
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.r.length, 30);
  assert.equal(saved.dev.p1.r[0].at, 76_000);       // reading 6 of 35 (1 s + 15 s steps)
  assert.equal(saved.dev.p1.r[29].at, 511_000);     // the last one
});

test('notes that are not its own give fresh notes, never a throw', () => {
  const keep = { name: 'keep', seen: 0, r: [], srtt: null, rttvar: null, flapping: false };
  const bad = [
    null, 'x', 42, { v: 2, dev: {} }, { v: 1, dev: [] }, { v: 1, dev: { p1: null } },
    { v: 1, dev: { keep, p1: { name: 'pixel', seen: 0, r: [{ at: 0, ok: true, ms: -5 }], srtt: null, rttvar: null, flapping: false } } },
    { v: 1, dev: { keep, p1: { name: 'pixel', seen: 0, r: [{ at: 0, ok: true, ms: NaN }], srtt: null, rttvar: null, flapping: false } } },
    { v: 1, dev: { keep, p1: { name: 'pixel', seen: -1, r: [], srtt: null, rttvar: null, flapping: false } } },
    { v: 1, dev: { keep, p1: { name: 'pixel', seen: 0, r: [], srtt: Infinity, rttvar: null, flapping: false } } },
    { v: 1, dev: { keep, p1: { name: 'pixel', seen: 0, r: [{ at: 0, ok: true, ms: 8e15 }], srtt: null, rttvar: null, flapping: false } } },
    { v: 1, dev: { keep, p1: { name: 'pixel', seen: 0, r: [], srtt: 8e15, rttvar: 4e15, flapping: false } } },
  ];
  for (const stored of bad) {
    const { c, ctx } = fakeCtx(stored);
    const b = create(ctx);
    assert.doesNotThrow(() => b.observe(snap([dev({ checkedAt: 1_000 })], 1_000), null));
    c.t += 60_000;
    b.observe(snap([dev({ checkedAt: 16_000 })], 16_000), null);
    const saved = c.stored as any;
    assert.equal(saved.v, 1);
    assert.deepEqual(Object.keys(saved.dev), ['p1'], `fresh notes for ${JSON.stringify(stored)}`);
    assert.equal(saved.dev.p1.r.length, 2);
  }
});

test('on read-back a long device key is dropped and a long name is cut to 80', () => {
  const longKey = 'k'.repeat(201);
  const stored = { v: 1, dev: {
    [longKey]: { name: 'long key', seen: 1, r: [], srtt: null, rttvar: null, flapping: false },
    old: { name: 'n'.repeat(120), seen: 1, r: [], srtt: null, rttvar: null, flapping: false },
  } };
  const { c, ctx } = fakeCtx(stored);
  const b = create(ctx);
  b.observe(snap([dev({ checkedAt: 10_000 })], 10_000), null);
  c.t += 60_000;
  b.observe(snap([dev({ checkedAt: 25_000 })], 25_000), null);
  const saved = c.stored as any;
  assert.deepEqual(Object.keys(saved.dev).sort(), ['old', 'p1']);
  assert.equal(saved.dev.old.name, 'n'.repeat(80));
});

test('notes saved then read back keep the probe window across a restart', () => {
  const { c, ctx } = fakeCtx();
  const b1 = create(ctx);
  let t = 1_000;
  for (let i = 0; i < 6; i++) {
    b1.observe(snap([dev({ checkedAt: t })], t), null);
    c.t += 60_000;                                  // one save a minute
    t += 15_000;
  }
  assert.equal(c.saves, 5);
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.r.length, 6);

  const b2 = create(ctx);
  b2.observe(snap([dev({ checkedAt: t - 15_000 })], t - 15_000), null);   // the same probe again: no new reading
  // six 12 ms samples: SRTT 12, RTTVAR 6 * (3/4)^5 = 1.423828125,
  // 4 * RTTVAR = 5.6953125: lo round(6.3046875) = 6, hi round(17.6953125) = 18
  assert.equal(b2.view().lines[0], 'pixel · reachable · 12 ms · usually 12 ms (6–18) · 3.3 GB free · 60 GB/s');

  b2.observe(snap([dev({ checkedAt: t })], t), null);
  c.t += 60_000;
  b2.observe(snap([dev({ checkedAt: t + 1 })], t + 1), null);
  const again = c.stored as any;
  assert.deepEqual(again.dev.p1.r.map((r: any) => r.at), [1_000, 16_000, 31_000, 46_000, 61_000, 76_000, 91_000, 91_001]);
});

test('a device appears, vanishes and comes back with its history', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (let i = 0; i < 5; i++) { b.observe(snap([dev({ checkedAt: t })], t), null); t += 15_000; }
  assert.match(b.view().lines[0], /usually 12 ms/);
  b.observe(snap([], t), null);
  const gone = b.view();
  assert.equal(gone.stat, 'no device yet');
  assert.deepEqual(gone.lines, []);
  assert.equal(row(gone, 'devices'), '0');
  assert.equal(row(gone, 'flapping'), 'none');
  assert.equal(row(gone, 'stale'), 'none');
  b.observe(snap([dev({ checkedAt: t })], t), null);
  assert.match(b.view().lines[0], /usually 12 ms/, 'the window came back with the device');
});

test('device ids that are object keys do not reach Object.prototype and survive save/load', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const ids = [['__proto__', 'proto'], ['constructor', 'ctor'], ['toString', 'tostring']] as const;
  const look = (at: number) => snap(ids.map(([id, name]) => dev({ id, name, checkedAt: at })), at);
  let t = 1_000;
  assert.doesNotThrow(() => {
    for (let i = 0; i < 5; i++) { b.observe(look(t), null); c.t += 60_000; t += 15_000; }
  });
  assert.equal(({} as any).name, undefined, 'Object.prototype was not touched');
  const saved = c.stored as any;
  assert.equal(Object.keys(saved.dev).length, 3);
  assert.equal(saved.dev['__proto__'].name, 'proto');
  assert.equal(saved.dev['constructor'].name, 'ctor');
  assert.equal(saved.dev['toString'].name, 'tostring');

  const b2 = create(ctx);                                          // reads the notes back
  b2.observe(look(t), null);
  const lines = b2.view().lines;
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l: string) => l.startsWith('proto · ')));
  assert.ok(lines.some((l: string) => l.startsWith('ctor · ')));
  assert.ok(lines.some((l: string) => l.startsWith('tostring · ')));
  assert.ok(lines.every((l: string) => /usually 12 ms/.test(l)), 'the loaded window carries the history');
});

test('a quiet cluster is saved once, then not again every minute', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  b.observe(snap([dev({ checkedAt: 1_000 })], 1_000), null);
  c.t += 60_000;
  b.observe(snap([dev({ checkedAt: 1_000 })], 2_000), null);       // the same probe: only seen moves
  assert.equal(c.saves, 1);
  for (let i = 0; i < 10; i++) {
    c.t += 12_000;
    b.observe(snap([dev({ checkedAt: 1_000 })], 2_000 + (i + 1) * 1_000), null);
  }
  assert.equal(c.saves, 1, 'ten identical looks over two minutes: nothing new, nothing saved');
});

test('a bad snapshot value never writes notes the next read-back would reject', () => {
  const cases = [
    { what: 'checkedAt -5', d: dev({ checkedAt: -5 }), at: 91_000, reading: false },
    { what: 'checkedAt NaN', d: dev({ checkedAt: NaN }), at: 91_000, reading: false },
    { what: 'checkedAt Infinity', d: dev({ checkedAt: Infinity }), at: 91_000, reading: false },
    { what: 'checkedAt 1e300', d: dev({ checkedAt: 1e300 }), at: 91_000, reading: false },
    { what: 'reachable yes', d: dev({ reachable: 'yes' }), at: 91_000, reading: false },
    { what: 'at NaN', d: dev({ checkedAt: 91_000 }), at: NaN, reading: true },
    { what: 'at null', d: dev({ checkedAt: 91_000 }), at: null, reading: true },
    { what: 'at -1', d: dev({ checkedAt: 91_000 }), at: -1, reading: true },
    { what: 'at 1e300', d: dev({ checkedAt: 91_000 }), at: 1e300, reading: true },
  ];
  for (const k of cases) {
    const { c, ctx } = fakeCtx();
    const b = create(ctx);
    let t = 1_000;
    for (let i = 0; i < 5; i++) { b.observe(snap([dev({ checkedAt: t })], t), null); t += 15_000; }
    c.t += 60_000;
    b.observe(snap([dev({ checkedAt: t })], t), null);              // 76 000: six readings on disk
    assert.equal((c.stored as any).dev.p1.r.length, 6);
    c.t += 60_000;
    b.observe(snap([k.d as any], k.at as any), null);               // the bad look, one save interval later
    // whatever the bad look wrote, if anything, is on disk now: read it back at once
    const saved = c.stored as any;
    assert.equal(saved.dev.p1.seen, 76_000, `${k.what}: seen stays the last usable look`);
    assert.equal(saved.dev.p1.r.length, 6 + (k.reading ? 1 : 0), `${k.what}: readings`);
    const ats = saved.dev.p1.r.map((r: any) => r.at);
    assert.ok(ats.includes(1_000) && ats.includes(76_000), `${k.what}: the earlier window is here`);
    assert.equal(ats.includes(91_000), k.reading, `${k.what}: a bad look adds no reading unless its time is good`);
    const b2 = create(ctx);
    b2.observe(snap([dev({ checkedAt: 121_000 })], 121_000), null);
    assert.match(b2.view().lines[0], /usually 12 ms/, `${k.what}: the window survived the restart`);
    assert.doesNotMatch(b2.view().lines[0], /not enough looks yet/);
  }
});

test('null and non-object device entries are skipped, never a throw', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const good = dev({ checkedAt: 1_000 });
  assert.doesNotThrow(() => b.observe(
    snap([good, null, undefined, 42, 'x', dev({ id: '' }), dev({ id: 'k'.repeat(201) }), dev({ id: 7 }), dev({ name: 42 })], 1_000),
    { devices: [null, undefined, 42] } as any,
  ));
  assert.equal(b.view().built, true);
  assert.equal(b.view().stat, '1 of 1 devices active');
  assert.equal(b.view().lines.length, 1);
  assert.equal(b.view().lines[0], 'pixel · reachable · 12 ms · not enough looks yet · 3.3 GB free · 60 GB/s');
  // the up/down loop: a null entry in before.devices must not throw either
  assert.doesNotThrow(() => b.observe(
    snap([null, dev({ reachable: false, reason: 'gone', checkedAt: 16_000 })], 16_000),
    { devices: [null, good] } as any,
  ));
  assert.deepEqual(c.feed, ['pixel stopped answering: gone']);
});

test('bad snapshot values never reach the view as NaN, undefined or [object]', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  const longReason = 'x'.repeat(300);
  b.observe(snap([
    dev({ id: 'a', name: 'nan ms', reachMs: NaN, checkedAt: 1_000 }),
    dev({ id: 'b', name: 'string ms', reachMs: 'x', checkedAt: 1_000 }),
    dev({ id: 'c', name: 'nan ram', ramMb: NaN, bwGBs: Infinity, checkedAt: 1_000 }),
    dev({ id: 'd', name: 'object reason', reachable: false, reason: 42, checkedAt: 1_000 }),
    dev({ id: 'e', name: 'yes reach', reachable: 'yes', checkedAt: 1_000 }),
    dev({ id: 'f', name: 'far at', checkedAt: 1e300 }),
    dev({ id: 'g', name: 'long reason', reachable: false, reason: longReason, checkedAt: 1_000 }),
  ], 1e300), null);
  const v = b.view();
  assert.equal(v.lines.length, 7);
  assert.doesNotMatch(JSON.stringify(v), /NaN|undefined|\[object/);
  const reason = v.lines.find((l) => l.startsWith('long reason · '))!;
  assert.ok(reason.includes('x'.repeat(120)));
  assert.ok(!reason.includes('x'.repeat(121)));
  assert.match(v.lines.find((l) => l.startsWith('object reason · '))!, /not reachable: no answer/);
  assert.doesNotMatch(v.lines.find((l) => l.startsWith('far at · '))!, /last looked at/);
});

test('a name longer than 200 chars is a real device, cut to 80 and tracked', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const long = 'L'.repeat(250);
  const expected = 'L'.repeat(80);
  let t = 1_000;
  for (let i = 0; i < 5; i++) { b.observe(snap([dev({ name: long, checkedAt: t })], t), null); t += 15_000; }
  assert.equal(b.view().stat, '1 of 1 devices active');
  assert.ok(b.view().lines[0].startsWith(`${expected} · `));
  assert.ok(!b.view().lines[0].includes('L'.repeat(81)));
  c.t += 60_000;
  b.observe(snap([dev({ name: long, checkedAt: t })], t), null);
  assert.equal((c.stored as any).dev.p1.name, expected);
  const b2 = create(ctx);
  b2.observe(snap([dev({ name: long, checkedAt: t + 15_000 })], t + 15_000), null);
  assert.ok(b2.view().lines[0].startsWith(`${expected} · `), 'the cut name comes back from the notes');
});

test('a devices field that is null or not an array counts as empty, and the next look still records', () => {
  for (const bad of [null, {}, 'x', 42, undefined]) {
    const { c, ctx } = fakeCtx();
    const b = create(ctx);
    const good = snap([dev({ checkedAt: 1_000 })], 1_000);
    assert.doesNotThrow(() => b.observe({ ...snap([], 1_000), devices: bad }, null), `now.devices ${JSON.stringify(bad)}`);
    assert.equal(b.view().stat, 'no device yet');
    assert.deepEqual(b.view().lines, []);
    assert.doesNotThrow(() => b.observe({ ...snap([], 2_000), devices: bad }, { ...good, devices: bad }), 'both');
    assert.equal(b.view().stat, 'no device yet');
    // a good look after a look whose devices were bad: before.devices is the bad one
    assert.doesNotThrow(() => b.observe(good, { ...good, devices: bad }), `before.devices ${JSON.stringify(bad)}`);
    assert.equal(b.view().lines[0], 'pixel · reachable · 12 ms · not enough looks yet · 3.3 GB free · 60 GB/s');
    c.t += 60_000;
    b.observe(snap([dev({ reachable: false, reachMs: null, checkedAt: 16_000 })], 16_000), { ...good, devices: bad });
    assert.deepEqual((c.stored as any).dev.p1.r, [{ at: 1_000, ok: true, ms: 12 }, { at: 16_000, ok: false, ms: null }]);
    assert.deepEqual(c.feed, [], 'nothing to compare with: no line');
  }
});

test('the cap never drops a device that is here for a ghost seen under a far-forward clock', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const far = Date.UTC(2400, 0, 1);
  b.observe(snap([dev({ id: 'ghost', name: 'ghost', checkedAt: far })], far), null);   // seen = far, then it leaves
  const live = (at: number) => snap(Array.from({ length: 40 }, (_, i) => dev({ id: `d${i}`, name: `dev ${i}`, checkedAt: at })), at);
  b.observe(live(1_000), null);
  c.t += 60_000;
  b.observe(live(16_000), null);
  const saved = c.stored as any;
  assert.equal(Object.keys(saved.dev).length, 40);
  assert.equal(saved.dev.ghost, undefined, 'the one that is not here went');
  for (let i = 0; i < 40; i++) assert.equal(saved.dev[`d${i}`].r.length, 2, `d${i} kept its window`);
});

test('a seen from a far-forward clock is brought back: a later leaver outlasts the ghost', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const far = Date.UTC(2400, 0, 1);
  b.observe(snap([dev({ id: 'ghost', name: 'ghost', checkedAt: far })], far), null);
  b.observe(snap([dev({ id: 'later', name: 'later', checkedAt: 1_000 })], 1_000), null);   // ghost's seen comes back to 1 000
  b.observe(snap([dev({ id: 'later', name: 'later', checkedAt: 1_000 })], 2_000), null);   // later was seen at 2 000, then leaves
  c.t += 60_000;
  b.observe(snap(Array.from({ length: 40 }, (_, i) => dev({ id: `d${i}`, name: `dev ${i}`, checkedAt: 3_000 })), 3_000), null);
  const saved = c.stored as any;
  assert.equal(Object.keys(saved.dev).length, 40);
  assert.equal(saved.dev.d0.seen, 3_000);
  assert.equal(saved.dev.ghost, undefined);
  assert.equal(saved.dev.later, undefined, 'both absent ones went: 40 are here');
  // 39 here and two absent: the one seen last of the two stays
  const { c: c2, ctx: ctx2 } = fakeCtx();
  const b2 = create(ctx2);
  b2.observe(snap([dev({ id: 'ghost', name: 'ghost', checkedAt: far })], far), null);
  b2.observe(snap([dev({ id: 'later', name: 'later', checkedAt: 1_000 })], 1_000), null);
  b2.observe(snap([dev({ id: 'later', name: 'later', checkedAt: 1_000 })], 2_000), null);
  c2.t += 60_000;
  b2.observe(snap(Array.from({ length: 39 }, (_, i) => dev({ id: `d${i}`, name: `dev ${i}`, checkedAt: 3_000 })), 3_000), null);
  const saved2 = c2.stored as any;
  assert.equal(Object.keys(saved2.dev).length, 40);
  assert.equal(saved2.dev.ghost, undefined, 'seen 1 000 after the clamp: the older of the two');
  assert.equal(saved2.dev.later.seen, 2_000);
});

test('finite but absurd numbers are left out: whole lines, and no exponent anywhere in the view', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const look = (at: number) => snap([
    dev({ id: 'a', name: 'slow', reachMs: 8e15, checkedAt: 1_000 }),
    dev({ id: 'b', name: 'roomy', ramMb: 1e300, bwGBs: 1e300, checkedAt: 1_000 }),
    dev({ id: 'c', name: 'edge', reachMs: 600_000, ramMb: 4 * 1024 * 1024, bwGBs: 10_000, checkedAt: 1_000 }),
    dev({ id: 'd', name: 'small', reachMs: 12.4, ramMb: 1e22, bwGBs: 0.001, checkedAt: 1_000 }),
    dev({ id: 'e', name: 'fine', reachMs: 0.4, bwGBs: 59.996, checkedAt: 1_000 }),
  ], at);
  b.observe(look(1_000), null);
  let v = b.view();
  assert.deepEqual(v.lines, [
    'slow · reachable · not enough looks yet · 3.3 GB free · 60 GB/s',           // 8e15 ms is no latency
    'roomy · reachable · 12 ms · not enough looks yet',                          // no memory, no bandwidth
    'edge · reachable · 600000 ms · not enough looks yet · 4096.0 GB free · 10000 GB/s',   // the bounds themselves show
    'small · reachable · 12 ms · not enough looks yet',                          // 12.4 rounds; 0.001 GB/s is under 0.01
    'fine · reachable · 0 ms · not enough looks yet · 3.3 GB free · 60 GB/s',    // 59.996 to two decimals
  ]);
  assert.doesNotMatch(JSON.stringify(v), /e\+\d|e-\d/);
  c.t += 60_000;
  b.observe(look(8.64e15), null);                                                // the largest date: all five long silent
  v = b.view();
  assert.equal(v.lines[0], 'slow · reachable · stale: last looked at over a year ago · 3.3 GB free · 60 GB/s');
  assert.equal(v.lines[2], 'edge · reachable · stale: last looked at over a year ago · 4096.0 GB free · 10000 GB/s');
  assert.doesNotMatch(JSON.stringify(v), /e\+\d|e-\d/);
  assert.equal((c.stored as any).dev.a.r[0].ms, null, 'the absurd latency is not kept either');
  // exactly a year of silence still shows its seconds
  b.observe(snap([dev({ checkedAt: 1_000 })], 1_000 + 365 * 86_400_000), null);
  assert.equal(b.view().lines[0], 'pixel · reachable · stale: last looked at 31536000 s ago · 3.3 GB free · 60 GB/s');
});

test('a device with an empty name goes by its id in lines, rows and the feed', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const up = snap([dev({ name: '', checkedAt: 1_000 }), dev({ id: 'p2', name: '   ', checkedAt: 1_000 })], 1_000);
  b.observe(up, null);
  assert.deepEqual(b.view().lines, [
    'p1 · reachable · 12 ms · not enough looks yet · 3.3 GB free · 60 GB/s',
    'p2 · reachable · 12 ms · not enough looks yet · 3.3 GB free · 60 GB/s',
  ]);
  b.observe(snap([dev({ name: '', reachable: false, reachMs: null, reason: 'gone', checkedAt: 16_000 }), dev({ id: 'p2', name: '   ', checkedAt: 1_000 })], 16_000), up);
  assert.deepEqual(c.feed, ['p1 stopped answering: gone']);
  b.observe(snap([dev({ name: '', checkedAt: 16_000 }), dev({ id: 'p2', name: '   ', checkedAt: 1_000 })], 100_000), null);
  assert.equal(row(b.view(), 'stale'), 'p1, p2');
});

test('a lasting latency shift is taken in from the third outlier in a row; one or two stay out', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  const look = (ms: number) => { b.observe(snap([dev({ reachMs: ms, checkedAt: t })], t), null); t += 15_000; };
  for (let i = 0; i < 10; i++) look(12);
  // ten 12 ms samples: SRTT 12, RTTVAR 6 * (3/4)^9 = 0.45050811767578125: 10 and 14 (as in the spike test)
  look(40);
  look(40);
  assert.equal(b.view().lines[0], 'pixel · reachable · 40 ms · usually 12 ms (10–14) · 3.3 GB free · 60 GB/s');
  look(12);                                         // back to normal: the run is over, and 12 changes little
  look(40);
  look(40);
  // the 12: RTTVAR 3/4 * 0.45050811767578125 = 0.3378810882568359, 4 * RTTVAR = 1.35: 11 and 13
  assert.equal(b.view().lines[0], 'pixel · reachable · 40 ms · usually 12 ms (11–13) · 3.3 GB free · 60 GB/s');
  look(40);                                         // the third 40 in a row: a shift
  // RTTVAR = 3/4 * 0.3378810882568359 + 1/4 * |12 - 40| = 7.253410816192627, SRTT = 7/8 * 12 + 1/8 * 40 = 15.5
  // lo = max(0, 15.5 - 29.01...) = 0, hi = round(15.5 + 29.0136...) = 45
  assert.equal(b.view().lines[0], 'pixel · reachable · 40 ms · usually 16 ms (0–45) · 3.3 GB free · 60 GB/s');
  c.t += 60_000;
  look(40);                                         // SRTT = 7/8 * 15.5 + 1/8 * 40 = 18.5625
  assert.equal((c.stored as any).dev.p1.srtt, 18.5625);
  for (let i = 0; i < 80; i++) look(40);            // the window is all 40 now
  // SRTT = 40 - 24.5 * (7/8)^81 = 39.9995; RTTVAR follows that distance down (about twice it,
  // 0.001), so 4 * RTTVAR is far under half a ms: 40 and 40
  assert.equal(b.view().lines[0], 'pixel · reachable · 40 ms · usually 40 ms (40–40) · 3.3 GB free · 60 GB/s');
});

// ---- the second review: a bad snapshot, the linear pass, the 41st, the view cap, read-back,
// the clamp, a link that goes quiet, and the other side of a shift

test('a snapshot of null or a string is not a look: observe and view never throw, and a good look records', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  assert.doesNotThrow(() => b.view());                       // before any look
  assert.equal(b.view().stat, 'no device yet');
  for (const bad of [null, 'x', 42, undefined, {}, { at: 'now', devices: null }]) {
    assert.doesNotThrow(() => b.observe(bad as any, null), `observe ${JSON.stringify(bad)}`);
    const v = b.view();                                      // checked while it is the current snapshot
    assert.equal(v.built, true);
    assert.equal(v.stat, 'no device yet');
    assert.deepEqual(v.lines, []);
    assert.doesNotMatch(JSON.stringify(v), /NaN|undefined|\[object/);
  }
  assert.deepEqual(c.feed, []);
  b.observe(snap([dev({ checkedAt: 1_000 })], 1_000), null);
  assert.equal(b.view().lines[0], 'pixel · reachable · 12 ms · not enough looks yet · 3.3 GB free · 60 GB/s');
});

test('the up/down line compares with the first earlier device of that id', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  b.observe(snap([dev({ checkedAt: 1_000 })], 1_000), null);
  const saidUp = { ...snap([], 1_000), devices: [dev({ reachable: true, checkedAt: 1_000 }), dev({ reachable: false, checkedAt: 1_000 })] } as any;
  b.observe(snap([dev({ reachable: false, reachMs: null, reason: 'gone', checkedAt: 16_000 })], 16_000), saidUp);
  assert.deepEqual(c.feed, ['pixel stopped answering: gone']);   // the first entry said true

  const { c: c2, ctx: ctx2 } = fakeCtx();
  const b2 = create(ctx2);
  b2.observe(snap([dev({ checkedAt: 1_000 })], 1_000), null);
  const saidDown = { ...snap([], 1_000), devices: [dev({ reachable: false, checkedAt: 1_000 }), dev({ reachable: true, checkedAt: 1_000 })] } as any;
  b2.observe(snap([dev({ reachable: false, reachMs: null, reason: 'gone', checkedAt: 16_000 })], 16_000), saidDown);
  assert.deepEqual(c2.feed, [], 'the first entry said false: no change');
});

test('41 devices present: the 41st gets no notes, so ten minutes save once, and its line still shows', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const forty = Array.from({ length: 40 }, (_, i) => dev({ id: `d${i}`, name: `dev ${i}`, checkedAt: 1_000 }));
  b.observe(snap(forty, 1_000), null);                      // 40 notes, one save's worth of new
  let at = 1_000;
  for (let i = 0; i < 10; i++) {
    c.t += 60_000;
    at += 60_000;
    b.observe(snap([dev({ id: 'extra', name: 'extra', checkedAt: at }), ...forty], at), null);
  }
  assert.ok(c.saves <= 1, `${c.saves} saves in ten minutes`);
  const saved = c.stored as any;
  assert.equal(Object.keys(saved.dev).length, 40);
  assert.equal(saved.dev.extra, undefined, 'no notes for the 41st');
  const v = b.view();
  assert.equal(v.lines.length, 41);
  // no notes, but the snapshot still gives its reach, memory and bandwidth
  assert.equal(v.lines[0], 'extra · reachable · 12 ms · 3.3 GB free · 60 GB/s');
  assert.equal(v.lines[40], 'and 1 more');
});

test('the view lists 40 device lines at most, then how many more', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  const ds = Array.from({ length: 42 }, (_, i) => dev({ id: `d${i}`, name: `dev ${i}`, checkedAt: 1_000 }));
  b.observe(snap(ds, 1_000), null);
  const v = b.view();
  assert.equal(v.lines.length, 41);
  assert.equal(v.lines[0], 'dev 0 · reachable · 12 ms · not enough looks yet · 3.3 GB free · 60 GB/s');
  assert.equal(v.lines[39], 'dev 39 · reachable · 12 ms · not enough looks yet · 3.3 GB free · 60 GB/s');
  assert.equal(v.lines[40], 'and 2 more');
  assert.equal(v.stat, '42 of 42 devices active');
});

test('an empty device key in the notes is dropped on read-back and holds no slot', () => {
  const note = (name: string, seen: number) => ({ name, seen, r: [{ at: 1_000, ok: true, ms: 12 }], srtt: 12, rttvar: 6, flapping: false });
  const all: Record<string, unknown> = { '': note('empty', 9e12) };
  for (let i = 0; i < 40; i++) all[`d${i}`] = note(`dev ${i}`, i + 1);
  const { c, ctx } = fakeCtx({ v: 1, dev: all });
  const b = create(ctx);
  c.t += 60_000;
  b.observe(snap([dev({ id: 'd0', name: 'renamed', checkedAt: 2_000 })], 2_000), null);
  const saved = c.stored as any;
  assert.equal(Object.keys(saved.dev).length, 40);
  assert.equal(saved.dev[''], undefined, 'the empty key was dropped on read-back');
  assert.ok(saved.dev.d1, 'and held no slot: no real device was pushed out');
  assert.equal(saved.dev.d0.name, 'renamed');
  assert.equal(saved.dev.d0.r.length, 2, 'd0 kept its reading and took the new one');
});

test('a seen brought back from a far-forward clock is marked changed and saved', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const far = Date.UTC(2400, 0, 1);
  b.observe(snap([dev({ id: 'ghost', name: 'ghost', checkedAt: far })], far), null);
  c.t += 60_000;
  b.observe(snap([], far), null);                           // the look that saves the far notes
  assert.equal((c.stored as any).dev.ghost.seen, far);
  c.t += 60_000;
  b.observe(snap([], 2_000), null);                         // the clock is right again: only the clamp changes
  assert.equal((c.stored as any).dev.ghost.seen, 2_000, 'the correction reaches the disk, so a restart keeps it');
});

test('a stale flapping device does not say flapping, and ten usual gaps of silence clear the flag', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (const ok of [true, false, true, false, true, false, true, false]) {
    b.observe(snap([dev({ reachable: ok, reachMs: ok ? 12 : null, checkedAt: t })], t), null);
    t += 15_000;
  }
  const last = t - 15_000;                                  // 106 000, the last new reading
  c.t += 60_000;
  b.observe(snap([dev({ reachable: false, reachMs: null, checkedAt: last })], last - 56_000), null);   // the clock stepped back: no silence to judge
  assert.equal(c.feed.length, 1, 'a backward clock does not clear flapping');
  b.observe(snap([dev({ reachable: false, reachMs: null, checkedAt: last })], last + 45_001), null);   // stale: 45 s > 3 * 15 s
  assert.equal(row(b.view(), 'stale'), 'pixel');
  assert.equal(row(b.view(), 'flapping'), 'none');
  assert.equal(b.view().lines[0], 'pixel · not reachable: no answer · stale: last looked at 45 s ago · 3.3 GB free · 60 GB/s');
  assert.deepEqual(c.feed, ['pixel is flapping: its link went up and down 7 times in the last 8 looks']);
  assert.equal((c.stored as any).dev.p1.flapping, true, 'stale alone does not clear the flag');

  c.t += 60_000;
  b.observe(snap([dev({ reachable: false, reachMs: null, checkedAt: last })], last + 150_000), null);  // exactly ten 15 s gaps
  assert.equal(c.feed.length, 1, 'exactly ten gaps: still flapping');
  c.t += 60_000;
  b.observe(snap([dev({ reachable: false, reachMs: null, checkedAt: last })], last + 150_001), null);  // a hair over
  assert.deepEqual(c.feed, [
    'pixel is flapping: its link went up and down 7 times in the last 8 looks',
    'pixel stopped flapping',
  ]);
  assert.equal((c.stored as any).dev.p1.flapping, false, 'the cleared flag is saved');
  assert.equal(row(b.view(), 'flapping'), 'none');
});

test('a flapping device that is no longer probed stops flapping after ten usual gaps', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (const ok of [true, false, true, false, true, false, true, false]) {
    b.observe(snap([dev({ reachable: ok, reachMs: ok ? 12 : null, checkedAt: t })], t), null);
    t += 15_000;
  }
  const last = t - 15_000;
  c.t += 60_000;
  b.observe(snap([], last + 150_001), null);                // gone from the snapshot, no new reading
  assert.deepEqual(c.feed, [
    'pixel is flapping: its link went up and down 7 times in the last 8 looks',
    'pixel stopped flapping',
  ]);
  assert.equal((c.stored as any).dev.p1.flapping, false, 'the cleared flag is saved');
  assert.equal(Object.keys((c.stored as any).dev).length, 1, 'the device is still remembered');
});

test('a third outlier on the other side is still a spike: the usual stays at 50 ms', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const lookAt = (ms: number, at: number) => b.observe(snap([dev({ reachMs: ms, checkedAt: at })], at), null);
  let t = 1_000;
  for (let i = 0; i < 10; i++) { lookAt(50, t); t += 15_000; }
  // ten 50 ms samples: SRTT 50, RTTVAR 25 * (3/4)^9 = 1.8771171569824219,
  // 4 * RTTVAR = 7.508468627929688: lo 42, hi 58
  lookAt(90, t); t += 15_000;
  lookAt(90, t); t += 15_000;
  assert.equal(b.view().lines[0], 'pixel · reachable · 90 ms · usually 50 ms (42–58) · 3.3 GB free · 60 GB/s');
  lookAt(10, t);                                            // the third outlier is on the other side, not a shift
  assert.equal(b.view().lines[0], 'pixel · reachable · 10 ms · usually 50 ms (42–58) · 3.3 GB free · 60 GB/s');
  c.t += 60_000;
  b.observe(snap([dev({ reachMs: 10, checkedAt: t })], t + 5_000), null);   // the same probe: only the save follows
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.srtt, 50);
  close(saved.dev.p1.rttvar, 1.8771171569824219);
});

// ---- C7: freshness. the engine does not probe a device in use, and the phone sends checkedAt =
// last heard, so a device in the loaded model is "in use", not stale; a stale device is not active.

/** a look with work.loaded set: devs sit on the load (work.loaded.devices), partIds hold layers */
const loadedSnap = (devices: any[], at: number, devs: string[], partIds: string[] = []): any => ({
  ...snap(devices, at),
  work: {
    loaded: {
      mode: partIds.length ? 'split' : 'apart', model: { id: 'm', name: 'M', file: 'm.gguf', size: 1e9 }, ctx: 4096, since: at - 900_000,
      devices: [
        { id: 'local', name: 'this computer', local: true, busy: false, tps: 20, done: 30 },
        ...devs.map((id) => ({ id, name: id, local: false, busy: true, tps: 18, done: 41 })),
      ],
      ...(partIds.length ? { parts: partIds.map((id) => ({ id, name: id, local: false, mb: 900, layers: 12 })) } : {}),
    },
    loading: null, chatting: 1, plan: [], decisions: [], llama: true,
  },
});

/** five 15 s probes of pixel and tab, the last at 61 000 */
function probedTwo() {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  for (let i = 0; i < 5; i++) {
    b.observe(snap([dev({ checkedAt: t }), dev({ id: 'p2', name: 'tab', checkedAt: t })], t), null);
    t += 15_000;
  }
  return { c, b, last: t - 15_000 };
}

test('c7 (a): a device answering in the loaded model is in use, not stale: whole line, usual latency kept', () => {
  const { b, last } = probedTwo();
  const at = last + 600_000;
  b.observe(loadedSnap([dev({ checkedAt: last }), dev({ id: 'p2', name: 'tab', checkedAt: at })], at, ['p1']), null);
  const v = b.view();
  assert.equal(v.lines[0], 'pixel · reachable · 12 ms · usually 12 ms (4–20) · in use · 3.3 GB free · 60 GB/s');
  assert.doesNotMatch(v.lines[0], /stale/);
  assert.equal(row(v, 'stale'), 'none');
  assert.equal(v.stat, '2 of 2 devices active');
  assert.equal(v.gauge, 100);
});

test('c7 (a): a device holding layers of a split (work.loaded.parts) is in use, not stale', () => {
  const { b, last } = probedTwo();
  const at = last + 600_000;
  b.observe(loadedSnap([dev({ checkedAt: last }), dev({ id: 'p2', name: 'tab', checkedAt: at })], at, [], ['p1']), null);
  const v = b.view();
  assert.doesNotMatch(v.lines[0], /stale/);
  assert.match(v.lines[0], / · in use · /);
  assert.equal(row(v, 'stale'), 'none');
});

test('c7 (a): a local entry or a bad id in the load marks nothing; a device not in the load still goes stale', () => {
  const { b, last } = probedTwo();
  const at = last + 600_000;
  const s = loadedSnap([dev({ checkedAt: last }), dev({ id: 'p2', name: 'tab', checkedAt: last })], at, ['p2']);
  s.work.loaded.devices.push(null, { id: 42 }, { id: 'p1', name: 'pixel', local: true });   // a local p1 is this computer
  s.work.loaded.parts = [null, 'p1', { id: '' }];
  b.observe(s, null);
  const v = b.view();
  assert.equal(v.lines[0], 'pixel · reachable · stale: last looked at 600 s ago · 3.3 GB free · 60 GB/s');
  assert.match(v.lines[1], /^tab · reachable · 12 ms · usually 12 ms \(4–20\) · in use · /);
  assert.equal(row(v, 'stale'), 'pixel');
});

test('c7 (b): a stale device is left out of the active count, the stat and the gauge', () => {
  const { b, last } = probedTwo();
  const at = last + 8 * 3600_000;
  b.observe(snap([dev({ checkedAt: at }), dev({ id: 'p2', name: 'tab', checkedAt: last })], at), null);
  const v = b.view();
  assert.equal(row(v, 'stale'), 'tab');
  assert.equal(v.stat, '1 of 2 devices active · 1 not checked lately');
  assert.equal(v.gauge, 50);
  // both stale: none active, and the stat still starts "N of M" for the brain map
  b.observe(snap([dev({ checkedAt: last }), dev({ id: 'p2', name: 'tab', checkedAt: last })], at), null);
  assert.equal(b.view().stat, '0 of 2 devices active · 2 not checked lately');
  assert.equal(b.view().gauge, 0);
});

// ---- B5: a flapping link floods the feed with up/down lines

test('b5: 40 alternating probes give one flapping line and no flip lines while flapping; stopped flapping still comes', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  let t = 1_000;
  let before: any = null;
  const look = (ok: boolean) => {
    const s = snap([dev({ reachable: ok, reachMs: ok ? 12 : null, reason: ok ? null : 'gone', checkedAt: t })], t);
    b.observe(s, before);
    before = s;
    t += 15_000;
  };
  for (let i = 0; i < 40; i++) look(i % 2 === 0);
  const flips = (xs: string[]) => xs.filter((x) => /answers again|stopped answering/.test(x));
  const startAt = c.feed.findIndex((x) => x.startsWith('pixel is flapping'));
  assert.ok(startAt >= 0, 'it says flapping');
  assert.equal(c.feed.filter((x) => /is flapping/.test(x)).length, 1, 'one flapping line');
  // flapping starts at the 8th reading: the 7 flips up to it are said, none after
  assert.equal(flips(c.feed.slice(0, startAt)).length, 7);
  assert.deepEqual(flips(c.feed.slice(startAt)), [], 'no flip lines while flapping');
  assert.equal(c.feed.length, 8);
  // the last look was down: 17 steady down looks end it (0.123 <= 0.15), as in the hysteresis test
  for (let i = 0; i < 17; i++) look(false);
  assert.equal(c.feed[c.feed.length - 1], 'pixel stopped flapping');
  assert.equal(c.feed.length, 9);
  look(true);                                                   // no longer flapping: the flip is said again
  assert.equal(c.feed[c.feed.length - 1], 'pixel answers again');
});

// ---- scan D M2: a worker's own /status, observed only (no card, no hint, ramMb untouched)

test('m2: a busy worker not in our load is "answering someone else"; only a line, no card and no hint', () => {
  const { c, b, last } = probedTwo();
  const at = last;                                   // the same probe looked at again: the usual stays (4–20)
  const feedBefore = c.feed.length;
  b.observe(snap([dev({ checkedAt: at, worker: { at, busy: true, tokensUsed: 10, ctx: 4096, ramFreeMb: 500 } }), dev({ id: 'p2', name: 'tab', checkedAt: at })], at), null);
  const v = b.view();
  assert.equal(v.lines[0], 'pixel · reachable · 12 ms · usually 12 ms (4–20) · answering someone else · 3.3 GB free · 60 GB/s');
  assert.doesNotMatch(v.lines[1], /answering someone else|context/);
  assert.equal(v.suggestions, undefined, 'no card');
  assert.equal(v.hints, undefined, 'no hint');
  assert.equal(c.feed.length, feedBefore, 'no feed line either');
});

test('m2: a busy worker in our own load says nothing more; a free one says nothing', () => {
  const { b, last } = probedTwo();
  const at = last + 15_000;
  b.observe(loadedSnap([dev({ checkedAt: at, worker: { at, busy: true, tokensUsed: 10, ctx: 4096, ramFreeMb: null } }), dev({ id: 'p2', name: 'tab', checkedAt: at, worker: { at, busy: false, tokensUsed: 0, ctx: 0, ramFreeMb: null } })], at, ['p1']), null);
  const v = b.view();
  assert.doesNotMatch(v.lines[0], /answering someone else/);
  assert.doesNotMatch(v.lines[1], /answering someone else|context/);
});

test('m2: a context 90% full is said; under 90% or no ctx is not', () => {
  const look = (worker: any) => {
    const { b, last } = probedTwo();
    const at = last;
    b.observe(snap([dev({ checkedAt: at, worker: { at, ramFreeMb: null, busy: false, ...worker } })], at), null);
    return b.view().lines[0];
  };
  assert.equal(look({ tokensUsed: 3700, ctx: 4096 }), 'pixel · reachable · 12 ms · usually 12 ms (4–20) · context 90% full · 3.3 GB free · 60 GB/s');
  assert.match(look({ tokensUsed: 4096, ctx: 4096 }), / · context 100% full · /);
  assert.doesNotMatch(look({ tokensUsed: 3000, ctx: 4096 }), /context/);
  assert.doesNotMatch(look({ tokensUsed: 3000, ctx: 0 }), /context/);
  assert.doesNotMatch(look({ tokensUsed: null, ctx: 4096 }), /context/);
  // both at once, busy first
  assert.match(look({ busy: true, tokensUsed: 4000, ctx: 4096 }), / · answering someone else · context 97% full · /);
});

test('m2: an old reading says nothing: a stale or unreachable device, a reading from before our load', () => {
  const { b, last } = probedTwo();
  const at = last + 600_000;
  const w = { at: last, busy: true, tokensUsed: 4000, ctx: 4096, ramFreeMb: null };
  b.observe(snap([dev({ checkedAt: last, worker: w }), dev({ id: 'p2', name: 'tab', checkedAt: at, reachable: false, reason: 'no answer', worker: { ...w, at } })], at), null);
  let v = b.view();
  assert.match(v.lines[0], /stale/);
  assert.doesNotMatch(v.lines[0], /answering someone else|context/);
  assert.doesNotMatch(v.lines[1], /answering someone else|context/);
  // in use: the engine does not probe it, so a reading older than the load is not about our work
  const s = loadedSnap([dev({ checkedAt: last, worker: { ...w, at: at - 10_001 } })], at, ['p1']);
  s.work.loaded.since = at - 10_000;
  b.observe(s, null);
  assert.doesNotMatch(b.view().lines[0], /context/);
  s.devices[0].worker.at = at - 1_000;
  b.observe(s, null);
  assert.match(b.view().lines[0], / · in use · context 97% full · /);
});

test('f2: a worker busy while we load our model is not "answering someone else"; a reading from the load stays quiet after it', () => {
  const { b, last } = probedTwo();
  const loading = { mode: 'apart', model: 'm', since: last, line: 'loading M on pixel' };
  const busy = (at: number) => ({ at, busy: true, tokensUsed: 10, ctx: 4096, ramFreeMb: null });
  // the load is under way: pixel is busy with our /load and not yet in work.loaded
  let t = last + 15_000;
  const s1 = snap([dev({ checkedAt: t, worker: busy(t) })], t);
  s1.work.loading = loading;
  b.observe(s1, null);
  assert.equal(b.view().lines[0], 'pixel · reachable · 12 ms · usually 12 ms (6–18) · 3.3 GB free · 60 GB/s');
  // the next look, still loading, a reading taken between the two looks
  const mid = t + 3_000;
  t += 5_000;
  const s2 = snap([dev({ checkedAt: mid, worker: busy(mid) })], t);
  s2.work.loading = loading;
  b.observe(s2, null);
  assert.doesNotMatch(b.view().lines[0], /answering someone else/);
  // the load ended (failed: pixel is not in work.loaded); the newest reading is still one from the
  // load, or from between the last loading look and the first look without it
  const gap = t + 2_000;
  t += 5_000;
  b.observe(snap([dev({ checkedAt: gap, worker: busy(gap) })], t), null);
  assert.doesNotMatch(b.view().lines[0], /answering someone else/);
  b.observe(snap([dev({ checkedAt: mid, worker: busy(mid) })], t), null);
  assert.doesNotMatch(b.view().lines[0], /answering someone else/);
  // a reading taken after the load is said again: busy then is someone else's
  const after = t + 15_000;
  b.observe(snap([dev({ checkedAt: after, worker: busy(after) })], after), null);
  assert.match(b.view().lines[0], / · answering someone else · /);
  // only busy is dropped while loading: a full context is still said
  const s3 = snap([dev({ checkedAt: after, worker: { ...busy(after), tokensUsed: 4000 } })], after);
  s3.work.loading = loading;
  b.observe(s3, null);
  assert.doesNotMatch(b.view().lines[0], /answering someone else/);
  assert.match(b.view().lines[0], / · context 97% full · /);
});

test('m1: the worker\'s live free memory leaves ramMb as it is (observation only)', () => {
  const { b, last } = probedTwo();
  const at = last + 15_000;
  b.observe(snap([dev({ checkedAt: at, ramMb: 3400, worker: { at, busy: false, tokensUsed: 0, ctx: 0, ramFreeMb: 800 } })], at), null);
  assert.match(b.view().lines[0], / · 3.3 GB free · /);
});
