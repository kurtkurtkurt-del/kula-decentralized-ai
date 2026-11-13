// god's eye, branch 4 (learning loop): it guesses each device's next look and speed, scores the
// guesses against the next snapshot, tunes alpha within bounds, keeps bounded notes and says little.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-learning-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { create, tune, brier, skill, calibration, ALPHA_MIN, ALPHA_MAX } = await import('../src/godseye/branches/learning.ts');
const { create: forecastCreate, createFixed, V1 } = await import('../src/godseye/branches/forecast.ts');
const { GodsEye, dark } = await import('../src/godseye/index.ts');

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const loaded = (devices: any[]) => ({ mode: 'apart', model: { id: 'm', name: 'm', file: 'm.gguf', size: 1 }, ctx: 4096, since: 0, devices });
const snap = (devices: any[], at: number, ld: any = null) => ({
  at, host: { name: 'mac', freeMb: 4000 }, devices,
  work: { loaded: ld, loading: null, chatting: 0, plan: [], decisions: [], llama: true },
  models: [], projects: [],
});

function fakeCtx(stored: unknown = null) {
  let t = 0;
  const c = {
    stored, saves: 0, events: [] as string[], peeked: null as any,
    tick(ms: number) { t += ms; },
    set(ms: number) { t = ms; },
    ctx: {
      now: () => t,
      load: <T>(fb: T): T => (c.stored ?? fb) as T,
      save: (d: unknown) => { c.stored = JSON.parse(JSON.stringify(d)); c.saves++; },
      emit: (s: string) => { c.events.push(s); },
      peek: (id: string) => (id === 'forecast' ? c.peeked : null),
    },
  };
  return c;
}

test('nothing to learn yet: built, plain words, no gauge', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  b.observe(snap([], 1000) as any, null);
  const v = b.view();
  assert.equal(v.built, true);
  assert.equal(v.stat, 'nothing to learn yet');
  assert.equal(v.gauge, null);
  assert.match(v.note!, /no device yet/);
  b.observe(snap([dev()], 2000) as any, null);
  assert.match(b.view().note!, /first guesses/);
});

test('reachability: guesses scored only on a new look, a miss is noted, the stat and the gauge follow', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  let checked = 0;
  const look = (reachable: boolean, newLook = true) => { if (newLook) checked++; b.observe(snap([dev({ reachable, checkedAt: checked })], checked * 5000) as any, null); };
  look(true);                                   // first look: nothing to score
  for (let i = 0; i < 9; i++) look(true);       // 9 hits
  look(true, false);                            // the same look again: not scored
  look(false);                                  // 1 miss
  const v = b.view();
  assert.equal(v.stat, 'reachability right 90%');
  assert.equal(v.gauge, 90);
  assert.deepEqual(v.rows[0], ['guesses scored', '10']);
  assert.match(v.lines[0], /^pixel · reach right 90% of 10 · α 0\.\d+/);
  assert.match(v.note!, /learned last \(\d\d:\d\d\): guessed pixel would answer, it did not(; reachability changes, it adapts faster \(α 0\.3 → 0\.\d+\))?$/);
});

test('speed: scored only when an answer was done, percent off, the estimate follows', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const at = (tps: number, done: number, t: number) => b.observe(snap([dev({ checkedAt: 1 })], t, loaded([{ id: 'p1', name: 'pixel', local: false, busy: false, tps, done }])) as any, null);
  at(10, 1, 1000);                              // first speed: the start of the guess
  at(10, 1, 2000);                              // no new answer: nothing scored
  at(12, 2, 3000);                              // off |12-10|/12 = 17%
  let v = b.view();
  assert.equal(v.stat, 'speed off 17%');
  assert.equal(v.gauge, 83);
  assert.match(v.lines[0], /speed off 17% · guess 10\.6 tok\/s · α 0\.3/);
  at(8, 3, 4000);                               // off |8-10.6|/8 = 32.5%, a note
  v = b.view();
  assert.match(v.note!, /guessed pixel at 10\.6 tok\/s, it ran at 8 \(off 3[23]%\)/);
});

test('alpha: up when the error grows, down when it settles, always within bounds', () => {
  const l: any = { alpha: 0.3, fast: 0, slow: 0, n: 0, emittedAlpha: 0.3 };
  for (let i = 0; i < 10; i++) tune(l, 0.05);
  assert.equal(l.alpha, 0.3);                   // a flat error: no change
  for (let i = 0; i < 5; i++) tune(l, 0.6);
  assert.ok(l.alpha > 0.3, `faster: ${l.alpha}`);
  const high = l.alpha;
  for (let i = 0; i < 30; i++) tune(l, 0);
  assert.ok(l.alpha < high, `steadier: ${l.alpha}`);
  for (let i = 0; i < 500; i++) tune(l, i % 2 ? 1 : 0 + (i % 7) * 0.1);
  assert.ok(l.alpha >= ALPHA_MIN && l.alpha <= ALPHA_MAX);
  for (let i = 0; i < 500; i++) tune(l, 0);
  assert.ok(l.alpha >= ALPHA_MIN);
  for (let i = 0; i < 200; i++) tune(l, i);
  assert.ok(l.alpha <= ALPHA_MAX);
});

test('a flaky device: reachability alpha rises and one feed line says so; accuracy crossing 80% is said once', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  let checked = 0;
  const look = (reachable: boolean) => { checked++; b.observe(snap([dev({ reachable, checkedAt: checked })], checked * 5000) as any, null); };
  for (let i = 0; i < 20; i++) look(true);
  assert.deepEqual(f.events, ['learning: its guesses are now 100% right']);
  for (let i = 0; i < 12; i++) look(i % 2 === 0);
  const flips = f.events.filter((e) => /reachability is changing, it adapts faster/.test(e));
  assert.ok(flips.length >= 1 && flips.length <= 2, f.events.join('\n'));
  assert.ok(f.events.length < 8, `rare: ${f.events.length}`);
  assert.match(b.view().lines[0], /α 0\.[4-8]/);
});

test('saves about once a minute, bounded, and reads its notes back', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  for (let i = 1; i <= 24; i++) { f.tick(5000); b.observe(snap([dev({ checkedAt: i })], i * 5000) as any, null); }
  assert.equal(f.saves, 2);                     // 120 s of looks: two saves
  const many = Array.from({ length: 50 }, (_, i) => dev({ id: `d${i}`, name: `d${i}`, checkedAt: 1 }));
  b.observe(snap(many, 200_000) as any, null);
  f.tick(60_000);
  b.observe(snap(many, 260_000) as any, null);
  assert.ok(Object.keys((f.stored as any).devices).length <= 32);
  for (let i = 0; i < 300; i++) b.observe(snap([dev({ checkedAt: 1000 + i })], 300_000 + i) as any, null);
  f.tick(60_000);
  b.observe(snap([dev({ checkedAt: 2000 })], 400_000) as any, null);
  assert.ok((f.stored as any).devices.p1.reach.hits.length <= 100);
  const again = create(fakeCtx(f.stored).ctx as any);
  again.observe(snap([dev({ checkedAt: 2000 })], 400_000) as any, null);
  assert.match(again.view().stat, /^reachability right \d+%$/);
  const broken = create(fakeCtx({ v: 9, junk: true }).ctx as any);
  broken.observe(snap([], 1) as any, null);
  assert.equal(broken.view().stat, 'nothing to learn yet');
});

test('shows the forecast\'s stat beside its own, nothing more', () => {
  const f = fakeCtx();
  f.peeked = { ...dark(), built: true, stat: 'pixel free at 23:00' };
  const b = create(f.ctx as any);
  b.observe(snap([dev()], 1) as any, null);
  assert.deepEqual(b.view().rows.find((r) => r[0] === 'forecast says'), ['forecast says', 'pixel free at 23:00']);
  f.peeked = dark();
  assert.equal(b.view().rows.find((r) => r[0] === 'forecast says'), undefined);
});

// ---- scoring the forecast's finished hours

const fcView = (pairs: unknown) => ({ built: true, stat: 'x', gauge: null, rows: [], lines: [], pairs });
const pair = (t: number, p: number, lo: number, hi: number, p0: number, x: number) => [t, p, lo, hi, p0, x];
/** n pairs with p, p0 and the 80% interval [lo, hi], x alternating 1, 0 */
const alt = (n: number, p: number, lo: number, hi: number, p0: number) => Array.from({ length: n }, (_, i) => pair(i, p, lo, hi, p0, i % 2));

test('brier, skill, calibration: the formulas, by hand', () => {
  // bs = ((0.8-1)^2 + (0.4-0)^2) / 2 = (0.04 + 0.16) / 2 = 0.1;
  // bs0 = ((0.5-1)^2 + (0.5-0)^2) / 2 = (0.25 + 0.25) / 2 = 0.25
  assert.deepEqual(brier([[0, 0.8, 0.6, 1, 0.5, 1], [1, 0.4, 0.2, 0.6, 0.5, 0]]), { bs: 0.1, bs0: 0.25 });
  assert.equal(skill(0.1, 0.25), 0.6);                   // 1 - 0.1 / 0.25
  assert.equal(skill(0.25, 0.5), 0.5);                   // 1 - 0.5
  assert.equal(skill(0.5, 0.25), -1);                    // 1 - 2
  assert.equal(skill(0, 1), 1);
  // said = mean(p) = (0.8 + 0.4) / 2 = 0.6, was = mean(x) = (1 + 0) / 2 = 0.5, n = 2
  const c = calibration([[0, 0.8, 0.6, 1, 0.5, 1], [1, 0.4, 0.2, 0.6, 0.5, 0]]);
  assert.equal(c.n, 2);
  assert.ok(Math.abs(c.said - 0.6) < 1e-12, `said ${c.said}`);
  assert.ok(Math.abs(c.was - 0.5) < 1e-12, `was ${c.was}`);
  assert.deepEqual(brier([]), { bs: 0, bs0: 0 });
  assert.deepEqual(calibration([]), { said: 0, was: 0, n: 0 });
});

test('the forecast score rows and the per-device line, with numbers worked out by hand', () => {
  const f = fakeCtx();
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(24, 0.75, 0.4, 1, 0.5) }]);
  const b = create(f.ctx as any);
  b.observe(snap([dev()], 1000) as any, null);
  const v = b.view();
  // 12 ones and 12 zeros: bs = (12 * 0.0625 + 12 * 0.5625) / 24 = 0.3125 -> 0.31;
  // bs0 = 24 * 0.25 / 24 = 0.25; skill = 1 - 0.3125 / 0.25 = -0.25;
  // calibration: said = mean(p) = 0.75, was = mean(x) = 12 / 24 = 0.5
  assert.deepEqual(v.rows.slice(-3), [
    ['forecast scored', '24 hours'],
    ['forecast skill', '-0.25 against each device\'s own average (Brier 0.31 vs 0.25)'],
    ['forecast calibration', 'said 75% on average, devices were there 50% of 24 hours'],
  ]);
  assert.ok(v.lines.includes('pixel · forecast skill -0.25 (Brier 0.31 vs 0.25) · said 75% on average, there 50% of 24 hours'));
  assert.equal(f.events.length, 0, 'under 48 pairs: no feed line');
});

test('fewer than 24 pairs: the skill row says not enough, the count beside it is under the threshold', () => {
  const f = fakeCtx();
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(23, 0.75, 0.4, 1, 0.5) }]);
  const b = create(f.ctx as any);
  b.observe(snap([dev()], 1000) as any, null);
  const v = b.view();
  assert.deepEqual(v.rows[v.rows.length - 2], ['forecast skill', 'not enough scored hours yet (23 of 24)']);
  assert.deepEqual(v.rows[v.rows.length - 1], ['forecast calibration', 'not enough scored hours yet (23 of 24)']);
  assert.ok(v.lines.includes('pixel · forecast: not enough scored hours yet (23 of 24)'));
});

test('a device always there: the baseline is 0.00 as shown, the skill stays hidden, and no line claims it exact', () => {
  const f = fakeCtx();
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: Array.from({ length: 50 }, (_, i) => pair(i, 0.9, 0.5, 1, 1, 1)) }]);
  const b = create(f.ctx as any);
  b.observe(snap([dev()], 1000) as any, null);
  const v = b.view();
  // bs = (0.9-1)^2 = 0.01, bs0 = (1-1)^2 = 0: nothing to beat; said 90%, was 100%.
  // the baseline is 0.00 only as shown (the brier is 0.01): the line must not claim it exact
  assert.deepEqual(v.rows[v.rows.length - 2], ['forecast skill', 'no skill to beat: the device\'s own average leaves nothing to compare (Brier 0.01 vs 0.00)']);
  assert.doesNotMatch(v.rows[v.rows.length - 2][1], /exact/, 'the brier is 0.01, not 0.00: not exact');
  assert.deepEqual(v.rows[v.rows.length - 1], ['forecast calibration', 'said 90% on average, devices were there 100% of 50 hours']);
  assert.ok(v.lines.includes('pixel · forecast: no skill to beat (Brier 0.01 vs 0.00) · said 90% on average, there 100% of 50 hours'));
  assert.equal(f.events.length, 0, 'a baseline of zero gives no skill to cross with');
});

test('both shown values 0.00: only then is the device\'s own average called exact', () => {
  const f = fakeCtx();
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: Array.from({ length: 48 }, (_, i) => pair(i, 1, 0.5, 1, 1, 1)) }]);
  const b = create(f.ctx as any);
  b.observe(snap([dev()], 1000) as any, null);
  const v = b.view();
  assert.deepEqual(v.rows[v.rows.length - 2], ['forecast skill', 'no skill to beat: the device\'s own average was exact (Brier 0.00 vs 0.00)']);
  assert.deepEqual(v.rows[v.rows.length - 1], ['forecast calibration', 'said 100% on average, devices were there 100% of 48 hours']);
  assert.ok(v.lines.includes('pixel · forecast: no skill to beat (Brier 0.00 vs 0.00) · said 100% on average, there 100% of 48 hours'));
  assert.equal(f.events.length, 0);
});

test('a baseline just under 0.005, a device missing one hour: nothing to beat, never a -0.07 skill', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  // one missing hour among the 200 scored hours the forecast keeps, the device there in 199;
  // its own average said 99.5% each hour: bs0 = (199 * 0.005^2 + 0.995^2) / 200 = 0.004975,
  // shown 0.00 but not zero. the forecast said 98.2% on the hours it was there and 100% on the
  // one it missed: bs = (199 * 0.018^2 + 1) / 200 = 0.005322 -> shown 0.01,
  // raw skill = 1 - 0.005322 / 0.004975 = -0.0698: the old guard (bs0 <= 0.0001) showed
  // "-0.07 against ... (Brier 0.01 vs 0.00)"; a baseline shown 0.00 is nothing to beat
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: [
    ...Array.from({ length: 199 }, (_, i) => pair(i, 0.982, 0.4, 1, 0.995, 1)),
    pair(199, 1, 0.4, 1, 0.995, 0),
  ] }]);
  b.observe(snap([dev()], 1000) as any, null);
  assert.equal(b.view().rows.find((r) => r[0] === 'forecast skill')![1],
    'no skill to beat: the device\'s own average leaves nothing to compare (Brier 0.01 vs 0.00)');
  assert.equal(f.events.length, 0);
});

test('the worse feed line once with hysteresis, and the recovery line above 0.05', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const skillRow = () => b.view().rows.find((r) => r[0] === 'forecast skill')![1];
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.5, 0.4, 1, 0.5) }]);    // p never left p0
  b.observe(snap([dev()], 1000) as any, null);
  assert.equal(skillRow(), 'still at the device\'s own average');
  assert.equal(f.events.length, 0, 'a forecast still at the device\'s own average is not a verdict');
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.75, 0.4, 1, 0.5) }]);   // skill -0.25
  b.observe(snap([dev()], 1000) as any, null);
  assert.deepEqual(f.events, ['learning: the forecast is doing worse than each device\'s own average (skill -0.25 over 48 hours)']);
  b.observe(snap([dev()], 2000) as any, null);                                            // still worse: said once
  assert.equal(f.events.length, 1);
  // 40 ones and 8 zeros, p = 0.515: bs = (40 * 0.235225 + 8 * 0.265225) / 48 = 0.240225,
  // skill = 1 - 0.240225 / 0.25 = 0.0391: shown +0.04, below the +0.05 recovery line
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: Array.from({ length: 48 }, (_, i) => pair(i, 0.515, 0.5, 1, 0.5, i < 40 ? 1 : 0)) }]);
  b.observe(snap([dev()], 4000) as any, null);
  assert.equal(f.events.length, 1, 'just under 0.05 is not a recovery');
  assert.equal(skillRow(), '+0.04 against each device\'s own average (Brier 0.24 vs 0.25)');
  // p = 0.5175: bs = (40 * 0.23280625 + 8 * 0.26780625) / 48 = 0.23864, raw skill = 0.0454,
  // which is shown as +0.05: the line and the row use that same shown value
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: Array.from({ length: 48 }, (_, i) => pair(i, 0.5175, 0.5, 1, 0.5, i < 40 ? 1 : 0)) }]);
  b.observe(snap([dev()], 5000) as any, null);
  assert.equal(skillRow(), '+0.05 against each device\'s own average (Brier 0.24 vs 0.25)');
  assert.equal(f.events.length, 2, 'the row shows +0.05: the recovery line must fire');
  assert.equal(f.events[1], 'learning: the forecast is doing better than each device\'s own average again (skill +0.05 over 48 hours)');
  b.observe(snap([dev()], 6000) as any, null);                                            // still fine: said once
  assert.equal(f.events.length, 2);
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.75, 0.4, 1, 0.5) }]);    // a fall to -0.05 says it again
  b.observe(snap([dev()], 7000) as any, null);
  assert.equal(f.events.length, 3);
  assert.equal(f.events[2], 'learning: the forecast is doing worse than each device\'s own average (skill -0.25 over 48 hours)');
});

test('when the row stops showing a skill, the worse state clears with one line, not silence', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const worse = 'learning: the forecast is doing worse than each device\'s own average (skill -0.25 over 48 hours)';
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.75, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 1000) as any, null);
  assert.deepEqual(f.events, [worse]);
  // p = p0 again: the row shows no skill any more; the state clears with one line
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.5, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 2000) as any, null);
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1], 'learning: the forecast is no longer doing worse than each device\'s own average (still at the device\'s own average)');
  b.observe(snap([dev()], 3000) as any, null);                                            // still no skill: said once
  assert.equal(f.events.length, 2);
  // worse again, then the baseline shows 0.00: cleared again, with its own reason
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.75, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 4000) as any, null);
  assert.equal(f.events.length, 3);
  assert.equal(f.events[2], worse);
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: Array.from({ length: 48 }, (_, i) => pair(i, 0.9, 0.5, 1, 1, 1)) }]);
  b.observe(snap([dev()], 5000) as any, null);
  assert.equal(f.events.length, 4);
  assert.equal(f.events[3], 'learning: the forecast is no longer doing worse than each device\'s own average (nothing to compare)');
  // worse once more, then too few hours: cleared once more, and the clear is saved
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.75, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 6000) as any, null);
  assert.equal(f.events.length, 5);
  assert.equal(f.events[4], worse);
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(10, 0.75, 0.4, 1, 0.5) }]);
  f.tick(60_000);                                                                         // this look saves
  b.observe(snap([dev()], 7000) as any, null);
  assert.equal(f.events.length, 6);
  assert.equal(f.events[5], 'learning: the forecast is no longer doing worse than each device\'s own average (too few scored hours)');
  assert.equal((f.stored as any).skillBad, false, 'the cleared state is saved, so a restart does not raise it again');
});

test('the worse line needs a shown skill of -0.05: -0.04 does not fire it, -0.05 does', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  // 48 alternating hours, p0 = 0.5: p = 0.6 -> bs = (0.16 + 0.36) / 2 = 0.26,
  // skill = 1 - 0.26 / 0.25 = -0.04 exactly: shown -0.04, above the -0.05 line
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.6, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 1000) as any, null);
  assert.equal(b.view().rows.find((r) => r[0] === 'forecast skill')![1],
    '-0.04 against each device\'s own average (Brier 0.26 vs 0.25)');
  assert.equal(f.events.length, 0, 'a shown -0.04 is above -0.05: noise is not a verdict');
  // p = 0.61 -> bs = (0.1521 + 0.3721) / 2 = 0.2621, raw skill = 1 - 0.2621 / 0.25 = -0.0484,
  // which is shown as -0.05: the line and the threshold use that same shown value
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.61, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 2000) as any, null);
  assert.equal(b.view().rows.find((r) => r[0] === 'forecast skill')![1],
    '-0.05 against each device\'s own average (Brier 0.26 vs 0.25)');
  assert.deepEqual(f.events, ['learning: the forecast is doing worse than each device\'s own average (skill -0.05 over 48 hours)']);
});

test('a skill verdict needs the baseline shown at 0.05: 0.04 stays quiet, 0.05 may speak', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const skillRow = () => b.view().rows.find((r) => r[0] === 'forecast skill')![1];
  // 200 hours, the device away in 8, its own average 90%:
  // bs0 = (192 * 0.1^2 + 8 * 0.9^2) / 200 = 0.042 -> shown 0.04. the forecast said 88.8% on the
  // hours it was there and 90% on the ones it missed:
  // bs = (192 * 0.112^2 + 8 * 0.9^2) / 200 = 0.0444, skill = 1 - 0.0444 / 0.042 = -0.058 -> -0.06
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: Array.from({ length: 200 }, (_, i) => pair(i, i >= 192 ? 0.9 : 0.888, 0.4, 1, 0.9, i < 192 ? 1 : 0)) }]);
  b.observe(snap([dev()], 1000) as any, null);
  assert.equal(skillRow(), '-0.06 against each device\'s own average (Brier 0.04 vs 0.04)');
  assert.equal(f.events.length, 0, 'a shown baseline 0.04 is under the floor: no verdict on noise');
  // 200 hours, the device away in 10: bs0 = (190 * 0.1^2 + 10 * 0.9^2) / 200 = 0.05 exactly;
  // the forecast said 88% on the hours it was there:
  // bs = (190 * 0.12^2 + 10 * 0.9^2) / 200 = 0.0542, skill = 1 - 0.0542 / 0.05 = -0.084 -> -0.08
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: Array.from({ length: 200 }, (_, i) => pair(200 + i, i >= 190 ? 0.9 : 0.88, 0.4, 1, 0.9, i < 190 ? 1 : 0)) }]);
  b.observe(snap([dev()], 2000) as any, null);
  assert.equal(skillRow(), '-0.08 against each device\'s own average (Brier 0.05 vs 0.05)');
  assert.deepEqual(f.events, ['learning: the forecast is doing worse than each device\'s own average (skill -0.08 over 200 hours)'], 'a shown baseline of 0.05 may speak');
});

test('when the shown baseline falls under 0.05, the worse state clears with one line', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.75, 0.4, 1, 0.5) }]);   // baseline 0.25
  b.observe(snap([dev()], 1000) as any, null);
  assert.deepEqual(f.events, ['learning: the forecast is doing worse than each device\'s own average (skill -0.25 over 48 hours)']);
  // the same noise as above: the row shows -0.06 at Brier 0.04 vs 0.04, but the baseline is too small
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: Array.from({ length: 200 }, (_, i) => pair(i, i >= 192 ? 0.9 : 0.888, 0.4, 1, 0.9, i < 192 ? 1 : 0)) }]);
  b.observe(snap([dev()], 2000) as any, null);
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1], 'learning: the forecast is no longer doing worse than each device\'s own average (the baseline is too small to compare)');
  b.observe(snap([dev()], 3000) as any, null);                                            // still too small: said once
  assert.equal(f.events.length, 2);
});

test('a broken forecast: the row says nothing to score yet and no recovery line is said', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.75, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 1000) as any, null);
  assert.equal(f.events.length, 1);                                                       // the worse line
  f.peeked = null;                                                                        // the forecast has no view at all
  f.tick(60_000);                                                                         // this look saves
  b.observe(snap([dev()], 2000) as any, null);
  assert.equal(b.view().rows.find((r) => r[0] === 'forecast skill')![1], 'nothing to score yet');
  assert.equal(f.events.length, 1, 'no recovery line while there is nothing to score');
  assert.equal((f.stored as any).skillBad, true, 'with no forecast to read, the state is left alone');
  // the forecast is back and still worse: the state is still set, so nothing is said again
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.75, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 3000) as any, null);
  assert.equal(f.events.length, 1, 'still worse: said once');
});

test('a device missing 1 hour in 40 is not "doing worse": -0.01 at Brier 0.02 vs 0.02 says nothing', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  // 200 hours, the device away in 5 (1 in 40); its own average 97.5%, the forecast said 99%:
  // bs0 = (195 * 0.025^2 + 5 * 0.975^2) / 200 = 0.024375 -> shown 0.02
  // bs  = (195 * 0.01^2  + 5 * 0.99^2)  / 200 = 0.0246   -> shown 0.02
  // skill = 1 - 0.0246 / 0.024375 = -0.0092 -> shown -0.01: under the bar, no feed line
  const scored = Array.from({ length: 200 }, (_, i) => pair(i, 0.99, 0.4, 1, 0.975, i < 195 ? 1 : 0));
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored }]);
  b.observe(snap([dev()], 1000) as any, null);
  assert.equal(b.view().rows.find((r) => r[0] === 'forecast skill')![1],
    '-0.01 against each device\'s own average (Brier 0.02 vs 0.02)');
  assert.equal(f.events.length, 0, 'a hundredth of a Brier point is noise: the worse line needs a shown -0.05');
});

test('a shown skill of -0.00 is not "doing worse": the feed compares the value as shown', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  // p = 0.49, p0 = 0.5, x alternating: bs = (0.2601 + 0.2401) / 2 = 0.2501, skill = -0.0004 -> -0.00
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.49, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 1000) as any, null);
  assert.equal(b.view().rows.find((r) => r[0] === 'forecast skill')![1], '+0.00 against each device\'s own average (Brier 0.25 vs 0.25)');
  assert.equal(f.events.length, 0, 'the shown -0.00 is above -0.01: no worse line');
});

test('a skill far below the baseline is shown clamped to -9.99, not as a huge number', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  // p0 = 0.9, x = 1: bs0 = 0.01; p = 0.1: bs = 0.81; raw skill = 1 - 81 = -80
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: Array.from({ length: 48 }, (_, i) => pair(i, 0.1, 0, 0.2, 0.9, 1)) }]);
  b.observe(snap([dev()], 1000) as any, null);
  const v = b.view();
  assert.deepEqual(v.rows.find((r) => r[0] === 'forecast skill'), ['forecast skill', '-9.99 against each device\'s own average (Brier 0.81 vs 0.01)']);
  assert.ok(v.lines.includes('pixel · forecast skill -9.99 (Brier 0.81 vs 0.01) · said 10% on average, there 100% of 48 hours'));
  assert.equal(f.events.length, 0, 'a baseline shown 0.01 is under the 0.05 floor: no verdict is said');
});

// L6 P31: this stage was called "no slot seen twice yet"; under the learned forecast p can leave p0
// before any slot is seen twice (it borrows the hour of the day), so it is named for what it checks
test('still at the device\'s own average: p only differs from p0 below two decimals', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  // p = 0.502, p0 = 0.5: the same to two decimals; bs = 0.250004, skill = -0.000016
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.502, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 1000) as any, null);
  const v = b.view();
  assert.deepEqual(v.rows.find((r) => r[0] === 'forecast skill'), ['forecast skill', 'still at the device\'s own average']);
  assert.ok(v.lines.includes('pixel · forecast: still at its own average'));
  assert.equal(f.events.length, 0, 'no skill is shown, so no feed line');
  // one pair where p differs at two decimals is one pair: the forecast still says the average
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: [...alt(47, 0.502, 0.4, 1, 0.5), pair(99, 0.2, 0.4, 1, 0.5, 1)] }]);
  b.observe(snap([dev()], 2000) as any, null);
  assert.deepEqual(b.view().rows.find((r) => r[0] === 'forecast skill'), ['forecast skill', 'still at the device\'s own average']);
});

test('still at the device\'s own average until at least 24 pairs differ from p0 to two decimals', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const skillRow = () => b.view().rows.find((r) => r[0] === 'forecast skill')![1];
  const same = (n: number) => alt(n, 0.5, 0.4, 1, 0.5);
  const off = (n: number) => Array.from({ length: n }, (_, i) => pair(100 + i, 0.52, 0.4, 1, 0.5, i % 2));
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: [...same(47), pair(99, 0.2, 0.4, 1, 0.5, 1)] }]);
  b.observe(snap([dev()], 1000) as any, null);
  assert.equal(skillRow(), 'still at the device\'s own average', 'one pair that differs is not enough');
  assert.ok(b.view().lines.includes('pixel · forecast: still at its own average'));
  assert.equal(f.events.length, 0);
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: [...same(25), ...off(23)] }]);
  b.observe(snap([dev()], 2000) as any, null);
  assert.equal(skillRow(), 'still at the device\'s own average', '23 pairs that differ are still under 24');
  // the 24th: bs = (24 * 0.25 + 24 * 0.2504) / 48 = 0.2502, bs0 = 0.25,
  // skill = 1 - 0.2502 / 0.25 = -0.0008 -> shown +0.00, but now it is shown at all
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: [...same(24), ...off(24)] }]);
  b.observe(snap([dev()], 3000) as any, null);
  assert.equal(skillRow(), '+0.00 against each device\'s own average (Brier 0.25 vs 0.25)');
  assert.equal(f.events.length, 0, 'a shown +0.00 is no verdict');
});

test('under 48 pairs: no worse feed line however bad the skill', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(47, 0.75, 0.4, 1, 0.5) }]);    // skill -0.25
  b.observe(snap([dev()], 1000) as any, null);
  assert.equal(f.events.length, 0);
});

test('malformed pairs from the forecast view: ignored without throwing, and the view stays clean', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const cases: [string, unknown][] = [
    ['no view', null],
    ['no pairs field', fcView(undefined)],
    ['pairs not an array', fcView('x')],
    ['bad entries and pairs', fcView([null, 42, {}, { id: 7, name: 'x', scored: [] }, { id: 'p', name: 42, scored: 'x' },
      { id: 'x'.repeat(201), name: 'long', scored: [[0, 0.5, 0.2, 0.8, 0.5, 1]] },
      { id: 'ok', scored: [[NaN, 0.5, 0.2, 0.8, 0.5, 1], [0, 2, 0.2, 0.8, 0.5, 1], [0, 0.5, 0.8, 0.2, 0.5, 1],
        [0, 0.5, 0.2, 0.8, 0.5, 9], [0, -1, 0.2, 0.8, 0.5, 1], [9e15, 0.5, 0.2, 0.8, 0.5, 1],
        [0, 0.5, 0.2, 0.8, 0.5, 1, 2], 'x', [0, 0.5, 0.2, 0.8, 0.5, 0.5]] }])],
  ];
  const zero: [string, string][] = [
    ['forecast scored', '0 hours'],
    ['forecast skill', 'not enough scored hours yet (0 of 24)'],
    ['forecast calibration', 'not enough scored hours yet (0 of 24)'],
  ];
  const noView: [string, string][] = [
    ['forecast scored', '0 hours'],
    ['forecast skill', 'nothing to score yet'],
    ['forecast calibration', 'not enough scored hours yet (0 of 24)'],
  ];
  for (const [what, peeked] of cases) {
    f.peeked = peeked;
    assert.doesNotThrow(() => { b.observe(snap([dev()], 1000) as any, null); b.view(); }, what);
    assert.equal(f.events.length, 0, what);
    if (what === 'bad entries and pairs') {
      // the one valid pair: [t, 0.5, 0.2, 0.8, 0.5, 0.5]
      const v = b.view();
      assert.deepEqual(v.rows.slice(-3), [
        ['forecast scored', '1 hour'],
        ['forecast skill', 'not enough scored hours yet (1 of 24)'],
        ['forecast calibration', 'not enough scored hours yet (1 of 24)'],
      ]);
      assert.ok(v.lines.includes('ok · forecast: not enough scored hours yet (1 of 24)'));
      assert.doesNotMatch(JSON.stringify(v), /NaN|undefined|\[object|e\+\d/, JSON.stringify(v));
    } else {
      assert.deepEqual(b.view().rows.slice(-3), what === 'no view' ? noView : zero, what);
      assert.doesNotMatch(JSON.stringify(b.view()), /NaN|undefined|\[object|e\+\d/, what);
    }
  }
});

test('the forecast view is read at its own bounds: at most 40 devices and 200 pairs each', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const devs = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, name: `phone ${i}`, scored: alt(300, 0.5, 0.2, 0.8, 0.5) }));
  f.peeked = fcView(devs);
  b.observe(snap([dev()], 1000) as any, null);
  const v = b.view();
  assert.equal(v.rows.find((r) => r[0] === 'forecast scored')![1], '8000 hours');   // 40 * 200
  assert.equal(v.lines.filter((l) => l.includes('forecast')).length, 40, 'one line per device read');
});

test('a long or missing name in the pairs: cut to 80, falls back to the id', () => {
  const f = fakeCtx();
  f.peeked = fcView([
    { id: 'p1', name: 'n'.repeat(150), scored: alt(24, 0.75, 0.4, 1, 0.5) },
    { id: 'p2', name: 42, scored: alt(24, 0.75, 0.4, 1, 0.5) },
  ]);
  const b = create(f.ctx as any);
  b.observe(snap([dev()], 1000) as any, null);
  const lines = b.view().lines;
  assert.ok(lines.includes('n'.repeat(80) + ' · forecast skill -0.25 (Brier 0.31 vs 0.25) · said 75% on average, there 50% of 24 hours'));
  assert.ok(lines.includes('p2 · forecast skill -0.25 (Brier 0.31 vs 0.25) · said 75% on average, there 50% of 24 hours'));
});

test('the total counts every device\'s hours, the lines list them in the view\'s order', () => {
  const f = fakeCtx();
  f.peeked = fcView([
    { id: 'p1', name: 'pixel', scored: alt(24, 0.75, 0.4, 1, 0.5) },
    { id: 'p9', name: 'galaxy', scored: alt(10, 0.5, 0.2, 0.8, 0.5) },
  ]);
  const b = create(f.ctx as any);
  b.observe(snap([dev()], 1000) as any, null);
  const v = b.view();
  assert.equal(v.rows.find((r) => r[0] === 'forecast scored')![1], '34 hours');
  const lines = v.lines;
  const a = lines.indexOf('pixel · forecast skill -0.25 (Brier 0.31 vs 0.25) · said 75% on average, there 50% of 24 hours');
  const g = lines.indexOf('galaxy · forecast: not enough scored hours yet (10 of 24)');
  assert.ok(a >= 0 && g > a, 'in the order the forecast view gave them');
});

test('the worse line and its state survive a restart; old notes load; nothing of the pairs is kept', () => {
  // the notes exactly as the merged branch wrote them: v: 1, no skillBad field
  const f = fakeCtx({ v: 1, devices: { p1: { name: 'pixel', seen: 1, reach: { alpha: 0.3, fast: 0, slow: 0, n: 3, emittedAlpha: 0.3, p: 0.9, hits: '111', at: 1 } } }, last: null, good: false });
  const b = create(f.ctx as any);
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.75, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 1000) as any, null);
  assert.equal(b.view().lines[0], 'pixel · reach right 100% of 3 · α 0.3', 'the earlier history survived');
  assert.deepEqual(f.events, ['learning: the forecast is doing worse than each device\'s own average (skill -0.25 over 48 hours)']);
  f.tick(60_000);
  b.observe(snap([dev()], 2000) as any, null);                      // saves
  assert.equal((f.stored as any).skillBad, true);
  assert.ok(!JSON.stringify(f.stored).includes('scored'), 'the pairs are not copied into the notes');
  assert.ok((f.stored as any).devices.p1, 'the device history survived the save');
  const g = fakeCtx(f.stored);
  const again = create(g.ctx as any);
  g.peeked = fcView([{ id: 'p1', name: 'pixel', scored: Array.from({ length: 48 }, (_, i) => pair(i, 0.9, 0.7, 1, 0.5, i < 40 ? 1 : 0)) }]);
  again.observe(snap([dev()], 3000) as any, null);                  // the recovery line fires after the restart
  assert.deepEqual(g.events, ['learning: the forecast is doing better than each device\'s own average again (skill +0.43 over 48 hours)']);
});

test('three weeks of a weekly pattern, through the real forecast branch: the row at every hour, positive skill after enough', () => {
  const fcF = fakeCtx();
  const fc = forecastCreate(fcF.ctx as any);
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const hourAt = (day: number, hour: number) => new Date(2026, 10, 8 + day, hour, 0, 0).getTime();
  const hourLooks = (day: number, hour: number, there: boolean) => {
    const t = hourAt(day, hour);
    for (let i = 0; i < 12; i++) {
      const s = snap([dev({ reachable: there, reason: there ? null : 'off', checkedAt: t + i * 5000 })], t + i * 5000) as any;
      fc.observe(s, null);
      f.peeked = fc.view();
      b.observe(s, null);
    }
  };
  // after every hour, the row must say exactly what its own data allows: not enough under 24 pairs,
  // "still at the device's own average" while fewer than 24 pairs' p differs from p0 at two
  // decimals, else a skill
  const rows: string[] = [];
  const rowNow = () => {
    const scored = (fc.view() as any).pairs.flatMap((d: any) => d.scored) as number[][];
    const differ = scored.filter((q) => Math.round(q[1] * 100) !== Math.round(q[4] * 100)).length;
    const row = b.view().rows.find((r) => r[0] === 'forecast skill')![1];
    if (scored.length < 24) assert.equal(row, `not enough scored hours yet (${scored.length} of 24)`);
    else if (differ < 24) assert.equal(row, 'still at the device\'s own average');
    else assert.match(row, /^[+-]\d\.\d\d against each device's own average \(Brier 0\.\d\d vs 0\.\d\d\)$/);
    rows.push(row);
  };
  for (let day = 0; day < 21; day++) { hourLooks(day, 10, false); rowNow(); hourLooks(day, 22, true); rowNow(); }   // three weeks, two hours a day
  // L6 P31: under L5 p equalled p0 until a slot was seen twice, so the row passed through that
  // stage here. The learned forecast leans on the hour of the day from its first scored hour, so
  // every pair already says something of its own: the row goes from "not enough" straight to a
  // skill (the stage itself is tested above, on pairs made for it)
  assert.ok(!rows.includes('still at the device\'s own average'), 'the learned forecast leaves the device\'s own average at once');
  assert.ok(rows.includes('not enough scored hours yet (23 of 24)'), 'one pair at a time is still not a verdict');
  const v = b.view();
  // 42 hours looked at: 41 folds, the first four not scored (the device was not known yet)
  assert.equal(v.rows.find((r) => r[0] === 'forecast scored')![1], '37 hours');
  assert.match(v.rows.find((r) => r[0] === 'forecast skill')![1], /^\+0\.\d\d against each device's own average \(Brier 0\.\d\d vs 0\.\d\d\)$/);
  // each look carries a new probe, so learning scores its own reachability guesses and may say so;
  // what must stay silent is the forecast verdict
  assert.deepEqual(f.events.filter((e) => /the forecast is doing/.test(e)), [], 'a weekly pattern is not worse than the device\'s own average');
});

/** a forecast branch and the learning branch driven together, two hours a day (10:00 and 22:00) */
function habitRun(makeForecast: (ctx: any) => any) {
  const fcF = fakeCtx();
  const fc = makeForecast(fcF.ctx as any);
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const hourAt = (day: number, hour: number) => new Date(2026, 10, 8 + day, hour, 0, 0).getTime();
  const hourLooks = (day: number, hour: number, there: boolean) => {
    const t = hourAt(day, hour);
    for (let i = 0; i < 12; i++) {
      const s = snap([dev({ reachable: there, reason: there ? null : 'off', checkedAt: t + i * 5000 })], t + i * 5000) as any;
      fc.observe(s, null);
      f.peeked = fc.view();
      b.observe(s, null);
    }
  };
  const days = (from: number, to: number, nights: boolean) => {
    for (let day = from; day < to; day++) { hourLooks(day, 10, !nights); hourLooks(day, 22, nights); }
  };
  const skillRow = () => b.view().rows.find((r) => r[0] === 'forecast skill')![1];
  /** the forecast's own skill over the hours it scored from t on: 1 - BS / BS0 */
  const skillSince = (t: number) => {
    const pairs = (fc.view() as any).pairs.flatMap((d: any) => d.scored).filter((q: number[]) => q[0] >= t);
    const { bs, bs0 } = brier(pairs);
    return { n: pairs.length, skill: 1 - bs / bs0 };
  };
  return { f, days, skillRow, skillSince, hourAt };
}
const WORSE = /^learning: the forecast is doing worse than each device's own average \(skill -\d+\.\d\d over \d+ hours\)$/;

// L6 P31: this test is about learning's detector, which needs a forecast that gets worse: it runs
// the L5 forecast (createFixed(V1)); the learned forecast's own case follows
test('a habit flip: the skill goes negative, said once, and comes back once the habit returns', () => {
  const r = habitRun(createFixed(V1));
  r.days(0, 21, true);                                                       // three weeks of nights
  assert.match(r.skillRow(), /^\+0\.\d\d against/);
  r.days(21, 42, false);                                                     // the habit flips to days
  const worse = r.f.events.filter((e) => WORSE.test(e));
  assert.equal(worse.length, 1, r.f.events.join('\n'));
  assert.match(r.skillRow(), /^-\d\.\d\d against/, 'the flipped forecast is worse than the device\'s own average');
  r.days(42, 84, true);                                                      // back to nights, six weeks
  const better = r.f.events.filter((e) => /^learning: the forecast is doing better than each device's own average again \(skill \+\d+\.\d\d over \d+ hours\)$/.test(e));
  assert.equal(better.length, 1, r.f.events.join('\n'));
  assert.match(r.skillRow(), /^\+0\.\d\d against/);
});

// measured, not assumed: right after the flip the learned forecast is surer of the old habit and
// pays more (its skill over the whole flip is below the L5 one), but it adapts faster: over the
// flip's last week it beats the device's own average while the L5 forecast does not. Its strong
// skill before the flip keeps learning's whole-window skill above the worse line
test('a habit flip with the learned forecast (L6 P31): no worse line, and over the flip\'s last week it adapts past the L5 one', () => {
  const v1 = habitRun(createFixed(V1));
  const v2 = habitRun(forecastCreate);
  for (const r of [v1, v2]) { r.days(0, 21, true); r.days(21, 42, false); }
  assert.deepEqual(v2.f.events.filter((e) => WORSE.test(e)), [], v2.f.events.join('\n'));
  const flip = (r: typeof v1) => r.skillSince(r.hourAt(21, 0));
  const lastWeek = (r: typeof v1) => r.skillSince(r.hourAt(35, 0));
  console.log(`skill over the whole flip: L5 ${flip(v1).skill.toFixed(3)}, learned ${flip(v2).skill.toFixed(3)} (n ${flip(v2).n})`);
  console.log(`skill over its last week: L5 ${lastWeek(v1).skill.toFixed(3)}, learned ${lastWeek(v2).skill.toFixed(3)} (n ${lastWeek(v2).n})`);
  assert.equal(flip(v2).n, flip(v1).n, 'the same hours scored');
  assert.ok(lastWeek(v2).skill > lastWeek(v1).skill, `last week: learned ${lastWeek(v2).skill} vs L5 ${lastWeek(v1).skill}`);
  assert.ok(lastWeek(v2).skill > 0, 'by the last week of the flip the learned forecast beats the device\'s own average again');
});

test('learning reads only the view: its file never imports the forecast branch', () => {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '../src/godseye/branches/learning.ts');
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/from '([^']+)'/g)) assert.ok(!m[1].includes('forecast'), m[0]);
});

// ---- the snapshot and the notes are not trusted, and a far-forward clock changes nothing

test('prototype ids: __proto__, constructor and toString are learned like any device, with no pollution', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const ids = ['__proto__', 'constructor', 'toString'];
  const tricky = (checkedAt: number) => ids.map((id, i) => dev({ id, name: `tricky ${i}`, checkedAt }));
  b.observe(snap(tricky(1), 1000) as any, null);
  assert.doesNotThrow(() => b.observe(snap(tricky(2), 2000) as any, null), 'constructor is a device, not a crash');
  assert.equal(({} as any).name, undefined, 'Object.prototype was not touched');
  assert.equal(({} as any).seen, undefined, 'Object.prototype was not touched');
  assert.equal(({} as any).reach, undefined, 'Object.prototype was not touched');
  const v = b.view();
  assert.deepEqual(v.lines, ['tricky 0 · reach right 100% of 1 · α 0.3', 'tricky 1 · reach right 100% of 1 · α 0.3', 'tricky 2 · reach right 100% of 1 · α 0.3']);
  f.tick(60_000);
  b.observe(snap(tricky(2), 2500) as any, null);     // saves
  const saved = f.stored as any;
  for (const id of ids) assert.ok(Object.prototype.hasOwnProperty.call(saved.devices, id), `${id} is an own key in the notes`);
  assert.equal(saved.devices['__proto__'].name, 'tricky 0');
  const g = fakeCtx(saved);
  const again = create(g.ctx as any);
  again.observe(snap(tricky(3), 3000) as any, null);
  assert.deepEqual(again.view().lines, ['tricky 0 · reach right 100% of 2 · α 0.3', 'tricky 1 · reach right 100% of 2 · α 0.3', 'tricky 2 · reach right 100% of 2 · α 0.3']);
  g.tick(60_000);
  again.observe(snap(tricky(3), 3500) as any, null);   // saves
  const saved2 = g.stored as any;
  for (const id of ids) assert.ok(Object.prototype.hasOwnProperty.call(saved2.devices, id), `${id} is still an own key after a restart`);
  assert.equal(({} as any).name, undefined, 'the reloaded notes did not pollute either');
});

test('snapshot ids and names are checked: an unusable id is skipped, a non-string name falls back to the id, names are cut to 80', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const mixed = (checkedAt: number) => [
    dev({ id: '', name: 'empty' }),
    dev({ id: 7, name: 'seven' }),
    dev({ id: null, name: 'nully' }),
    dev({ id: 'x'.repeat(201), name: 'long id' }),
    dev({ id: 'p2', name: 42, checkedAt }),
    dev({ id: 'p3', name: 'n'.repeat(100), checkedAt }),
  ];
  b.observe(snap(mixed(1), 1000) as any, null);
  b.observe(snap(mixed(2), 2000) as any, null);
  const v = b.view();
  assert.deepEqual(v.lines, ['p2 · reach right 100% of 1 · α 0.3', 'n'.repeat(80) + ' · reach right 100% of 1 · α 0.3']);
  assert.equal(v.rows.find((r) => r[0] === 'devices it learns')![1], '2');
  f.tick(60_000);
  b.observe(snap(mixed(2), 2500) as any, null);
  assert.deepEqual(Object.keys((f.stored as any).devices).sort(), ['p2', 'p3'], 'nothing unusable reached the notes');
});

test('corrupt notes: a bad device is dropped, a bad file starts fresh, never a throw, never NaN in the view', () => {
  const loopOk = { alpha: 0.3, fast: 0, slow: 0, n: 1, emittedAlpha: 0.3 };
  const withReach = (reach: unknown) => ({ v: 1, devices: { p9: { name: 'pixel', seen: 1, reach } } });
  const withSpeed = (speed: unknown) => ({ v: 1, devices: { p9: { name: 'pixel', seen: 1, speed } } });
  const cases: [string, any][] = [
    ['null device', { v: 1, devices: { p9: null } }],
    ['device not an object', { v: 1, devices: { p9: 'x' } }],
    ['reach {}', withReach({})],
    ['reach not an object', withReach(7)],
    ['alpha out of bounds', withReach({ ...loopOk, alpha: 5, p: 0.5, hits: '', at: 1 })],
    ['alpha not a number', withReach({ ...loopOk, alpha: 'fast', p: 0.5, hits: '', at: 1 })],
    ['p out of bounds', withReach({ ...loopOk, p: 2, hits: '', at: 1 })],
    ['hits not 0/1', withReach({ ...loopOk, p: 0.5, hits: 'abc', at: 1 })],
    ['hits too long', withReach({ ...loopOk, p: 0.5, hits: '1'.repeat(101), at: 1 })],
    ['at NaN', withReach({ ...loopOk, p: 0.5, hits: '', at: NaN })],
    ['speed est NaN', withSpeed({ ...loopOk, est: NaN, errs: [], done: 1 })],
    ['speed done NaN', withSpeed({ ...loopOk, est: 10, errs: [], done: NaN })],
    ['seen NaN', { v: 1, devices: { p9: { name: 'pixel', seen: NaN } } }],
    ['seen negative', { v: 1, devices: { p9: { name: 'pixel', seen: -5 } } }],
  ];
  for (const [what, stored] of cases) {
    const f = fakeCtx(stored);
    const b = create(f.ctx as any);
    assert.doesNotThrow(() => { b.observe(snap([dev({ checkedAt: 1 })], 1000) as any, null); b.view(); }, what);
    const v = b.view();
    assert.doesNotMatch(JSON.stringify(v), /NaN|undefined|\[object|e\+\d/, what);
    assert.equal(f.events.length, 0, what);
    f.tick(60_000);
    b.observe(snap([dev({ checkedAt: 2 })], 2000) as any, null);   // saves
    const saved = f.stored as any;
    assert.equal(saved.devices.p9, undefined, `${what}: the bad device is dropped, not written back`);
    assert.ok(saved.devices.p1, `${what}: the good one stays`);
    assert.doesNotMatch(JSON.stringify(saved), /NaN|undefined|\[object|e\+\d/, what);
    assert.doesNotThrow(() => create(fakeCtx(saved).ctx as any), what);
  }
  // ids in the notes are checked too: an unusable key is not written back
  for (const id of ['', 'x'.repeat(201)]) {
    const f = fakeCtx({ v: 1, devices: { [id]: { name: 'n', seen: 1 } } });
    const b = create(f.ctx as any);
    b.observe(snap([dev({ checkedAt: 1 })], 1000) as any, null);
    f.tick(60_000);
    b.observe(snap([dev({ checkedAt: 2 })], 2000) as any, null);
    assert.deepEqual(Object.keys((f.stored as any).devices), ['p1'], `a bad id ${JSON.stringify(id)} is dropped`);
  }
  for (const bad of [null, 'x', 42, { v: 9 }, { v: 1 }, { v: 1, devices: [] }, { v: 1, devices: null }, { v: 1, devices: 'x' }]) {
    const f = fakeCtx(bad);
    const b = create(f.ctx as any);
    assert.doesNotThrow(() => b.observe(snap([dev()], 1000) as any, null), JSON.stringify(bad));
    assert.equal(b.view().built, true);
    assert.doesNotMatch(JSON.stringify(b.view()), /NaN|undefined|\[object|e\+\d/, JSON.stringify(bad));
  }
});

test('a far-forward look without devices forgets nothing: guesses continue, live and after a restart', () => {
  const far = 1000 + 365 * 86400_000;
  const f = fakeCtx();
  const b = create(f.ctx as any);
  let checked = 0;
  const look = (t: number) => b.observe(snap([dev({ checkedAt: ++checked })], t) as any, null);
  for (let i = 0; i < 6; i++) look(1000 + i * 1000);          // first look starts, then 5 hits
  assert.equal(b.view().lines[0], 'pixel · reach right 100% of 5 · α 0.3');
  f.tick(60_000);
  look(6000);                                                 // 6th hit, saves
  assert.equal(f.saves, 1);
  assert.equal((f.stored as any).devices.p1.reach.hits, '111111');
  b.observe(snap([], far) as any, null);                      // a year ahead, no devices: not trusted
  assert.equal(b.view().lines[0], 'pixel · reach right 100% of 6 · α 0.3', 'the far look changed nothing');
  assert.equal(b.view().stat, 'reachability right 100%', 'the last good look still shows');
  look(7000);                                                 // normal again: records and scores
  assert.equal(b.view().lines[0], 'pixel · reach right 100% of 7 · α 0.3');
  f.tick(60_000);
  look(8000);                                                 // 8th hit, saves
  const saved = f.stored as any;
  assert.equal(saved.devices.p1.reach.hits, '11111111', 'nothing was forgotten');
  // after a restart the same far-forward look forgets nothing either
  const g = fakeCtx(saved);
  const again = create(g.ctx as any);
  again.observe(snap([], far) as any, null);
  assert.equal(again.view().built, true);
  again.observe(snap([dev({ checkedAt: 99 })], 9000) as any, null);
  assert.equal(again.view().lines[0], 'pixel · reach right 100% of 9 · α 0.3');
  g.tick(60_000);
  again.observe(snap([dev({ checkedAt: 100 })], 10_000) as any, null);
  assert.equal((g.stored as any).devices.p1.reach.hits, '1111111111');
});

test('a look behind the last good one re-anchors and still records', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  let checked = 0;
  const look = (t: number) => b.observe(snap([dev({ checkedAt: ++checked })], t) as any, null);
  look(100_000);
  look(90_000);                                               // the clock jumped back: a normal look
  assert.equal(b.view().lines[0], 'pixel · reach right 100% of 1 · α 0.3', 'it records behind its last good time');
  f.tick(60_000);
  look(95_000);                                               // saves
  assert.equal((f.stored as any).lastGood, 95_000, 'lastGood re-anchored down, not stuck ahead');
  assert.equal((f.stored as any).devices.p1.reach.hits, '11');
});

test('the device cap never evicts one in the current snapshot in favour of a vanished one with a far-forward seen', () => {
  const t = 50_000;
  const ghost = { name: 'ghost', seen: t + 365 * 86400_000 };   // vanished, a year ahead
  const devices: any = Object.create(null);
  const snapshot: any[] = [];
  for (let i = 0; i < 31; i++) {
    devices[`p${i}`] = { name: `phone ${i}`, seen: 1 };
    snapshot.push(dev({ id: `p${i}`, name: `phone ${i}`, checkedAt: 1 }));
  }
  devices.ghost = ghost;                                      // 32 remembered, one vanished far ahead
  snapshot.push(dev({ id: 'p31', name: 'phone 31', checkedAt: 1 }));   // a 32nd live device
  const f = fakeCtx({ v: 1, devices });
  const b = create(f.ctx as any);
  b.observe(snap(snapshot, t) as any, null);                  // the trim happens here, while the ghost's seen is still ahead
  f.tick(60_000);
  b.observe(snap([], t + 5000) as any, null);                 // saves; no devices, so no later look can repair it
  const saved = f.stored as any;
  assert.equal(Object.keys(saved.devices).length, 32);
  assert.equal(saved.devices.ghost, undefined, 'the vanished device went, far-forward seen and all');
  for (const d of snapshot) assert.ok(saved.devices[d.id], `${d.id} stays`);
});

test('a real clock jump of more than a week: one far look is held, two that agree are trusted', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  let checked = 0;
  const look = (t: number) => b.observe(snap([dev({ checkedAt: ++checked })], t) as any, null);
  look(1000);
  look(2000);
  const far = 1000 + 8 * 86400_000;                           // eight days ahead: more than the forget window
  b.observe(snap([], far) as any, null);                      // one far look: held, nothing forgotten
  assert.equal(b.view().rows.find((r) => r[0] === 'devices it learns')![1], '1');
  b.observe(snap([], far + 5000) as any, null);               // a second look near it: the clock really moved
  assert.equal(b.view().rows.find((r) => r[0] === 'devices it learns')![1], '0');
  f.tick(60_000);
  b.observe(snap([], far + 10_000) as any, null);             // saves
  assert.equal((f.stored as any).devices.p1, undefined, 'eight days of silence forget the device');
});

test('a seen later than the look is clamped, so a far stamp does not keep a device forever', () => {
  const t0 = 5000;
  const future = t0 + 30 * 86400_000;
  const f = fakeCtx({ v: 1, devices: { p9: { name: 'ghost', seen: future } } });
  const b = create(f.ctx as any);
  b.observe(snap([], t0) as any, null);                       // the clock is back: the future stamp is clamped
  f.tick(60_000);
  b.observe(snap([], t0) as any, null);                       // saves
  assert.equal((f.stored as any).devices.p9.seen, t0, 'seen was clamped to the look');
  // eight days later (two looks agree on the new time): the clamped device is forgotten
  const t8 = t0 + 8 * 86400_000;
  b.observe(snap([], t8) as any, null);
  b.observe(snap([], t8 + 1000) as any, null);
  f.tick(60_000);
  b.observe(snap([], t8 + 2000) as any, null);                // saves
  assert.equal((f.stored as any).devices.p9, undefined, 'the 7-day forget took it');
});

test('save pacing uses ctx.now only: a wall clock three hours back does not stall the saves', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  let checked = 0;
  const look = (t: number) => b.observe(snap([dev({ checkedAt: ++checked })], t) as any, null);
  look(1000);
  f.tick(60_000);
  look(2000);
  assert.equal(f.saves, 1);
  f.set(f.ctx.now() - 3 * 3600_000);                          // the wall clock steps back three hours
  look(3000);                                                 // a new hit, dirty
  f.tick(60_000);
  look(4000);
  assert.equal(f.saves, 2, 'the pace re-anchored instead of stalling for three hours');
  assert.equal((f.stored as any).devices.p1.reach.hits, '111');
});

test('the snapshot is not trusted: null containers and bad entries never throw nor reach notes, view or feed', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  let checked = 0;
  const clean = (t: number, there = true) => b.observe(snap([dev({ checkedAt: ++checked, reachable: there })], t) as any, null);
  for (let i = 0; i < 6; i++) clean(1000 + i * 1000);         // a real history first
  const t = 10_000;
  const withDev = (o: Record<string, unknown> = {}) => snap([dev({ checkedAt: ++checked, ...o })], t);
  const garbage: any[] = [
    { ...snap([], t), devices: null },                        // null container
    { ...snap([], t), devices: 'x' },                         // not an array
    { ...snap([], t), devices: [null, 42, 'x'] },             // entries that are not devices
    { ...snap([], t), work: null },                           // null work
    { ...snap([], t), work: { loaded: null } },
    { ...snap([], t), work: { loaded: { ...loaded([]), devices: null } } },
    snap([dev()], t, loaded([null, 7])),
    snap([dev()], t, loaded([{ id: 7, name: 'seven', local: false, busy: false, tps: 6, done: 1 }])),
    snap([dev()], t, loaded([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: NaN, done: 1 }])),
    snap([dev()], t, loaded([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: 1e300, done: 1 }])),
    snap([dev()], t, loaded([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: 6, done: NaN }])),
    withDev({ checkedAt: NaN }),
    withDev({ checkedAt: 9e15 }),
    withDev({ reachable: 'yes' }),
    snap([dev()], NaN),                                       // unusable times: the look changes nothing
    snap([dev()], -5),
    snap([dev()], 9e15),
    null,
  ];
  for (const s of garbage) {
    assert.doesNotThrow(() => { b.observe(s, null); b.view(); }, JSON.stringify(s));
    const v = b.view();
    assert.doesNotMatch(JSON.stringify(v), /NaN|undefined|\[object|e\+\d/, JSON.stringify(s));
    for (const e of f.events) assert.doesNotMatch(e, /NaN|undefined|\[object|e\+\d/, JSON.stringify(s));
  }
  // a loaded id that is not a string is skipped, right then
  b.observe(snap([dev()], t, loaded([{ id: 7, name: 'seven', local: false, busy: false, tps: 6, done: 1 }])) as any, null);
  assert.ok(!b.view().lines.some((l) => l.startsWith('seven')), 'a loaded id that is not a string is skipped');
  // an unusable time changes nothing: the last good look's devices still show
  b.observe(snap([], NaN) as any, null);
  b.observe(snap([], -5) as any, null);
  assert.equal(b.view().rows.find((r) => r[0] === 'devices it learns')![1], '1', 'an unusable time changes nothing');
  // a reachable that is not a boolean is not a look: a string is never scored
  const odd = (checkedAt: number) => snap([dev({ id: 'p3', name: 'odd', reachable: 'yes', checkedAt })], t) as any;
  b.observe(odd(1), null);
  b.observe(odd(2), null);
  assert.equal(b.view().lines.find((l) => l.startsWith('odd')), 'odd', 'a string is not a look: no reach guess is made');
  // a checkedAt that is not a usable time is not a look either
  const noTime = (checkedAt: any) => snap([dev({ id: 'p4', name: 'no time', checkedAt })], t) as any;
  b.observe(noTime(NaN), null);
  assert.equal(b.view().lines.find((l) => l.startsWith('no time')), 'no time', 'a NaN checkedAt is not a look');
  b.observe(noTime(9e15), null);
  assert.equal(b.view().lines.find((l) => l.startsWith('no time')), 'no time', 'an absurd checkedAt is not a look');
  clean(20_000);
  f.tick(60_000);
  clean(30_000);                                              // saves
  const saved = f.stored as any;
  assert.ok(saved.devices.p1, 'the earlier history survived');
  assert.match(saved.devices.p1.reach.hits, /^1{5,}$/, saved.devices.p1.reach.hits);
  assert.doesNotMatch(JSON.stringify(saved), /NaN|undefined|\[object|e\+\d/);
  const again = create(fakeCtx(saved).ctx as any);
  again.observe(snap([dev({ checkedAt: ++checked })], 40_000) as any, null);
  assert.equal(again.view().built, true);
  assert.match(again.view().lines[0], /^pixel · reach right 100% of \d+ · α 0\.3$/);
});

test('an answer count that goes back scores nothing and is not remembered lower', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const at = (tps: number, done: number, t: number) => b.observe(snap([dev({ checkedAt: 1 })], t, loaded([{ id: 'p1', name: 'pixel', local: false, busy: false, tps, done }])) as any, null);
  at(10, 5, 1000);                                // the first answer: the start of the guess
  at(30, 3, 2000);                                // a lower count: not a new answer
  at(35, 4, 2500);                                // still below the 5 already seen: not scored
  assert.equal(b.view().lines[0], 'pixel · reach: first look · α 0.3 · speed: first answer · guess 10 tok/s · α 0.3');
  at(40, 6, 3000);                                // a new answer: off |40-10|/40 = 0.75
  assert.equal(b.view().lines[0], 'pixel · reach: first look · α 0.3 · speed off 75% · guess 19 tok/s · α 0.3');
  f.set(f.ctx.now() + 60_000);
  at(40, 6, 3500);                                // saves
  assert.equal((f.stored as any).devices.p1.speed.done, 6, 'the remembered count never went back');
});

test('a reload of another model: every answer of the new load scores, the guess restarts from its own speed', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const ld = (file: string, since: number, tps: number, done: number) =>
    ({ mode: 'apart', model: { id: file, name: file, file, size: 1 }, ctx: 4096, since, devices: [{ id: 'p1', name: 'pixel', local: false, busy: false, tps, done }] });
  let t = 1000;
  for (let i = 1; i <= 20; i++) b.observe(snap([dev({ checkedAt: 1 })], t += 1000, ld('small.gguf', 500, 20, i)) as any, null);
  f.set(f.ctx.now() + 60_000);
  b.observe(snap([dev({ checkedAt: 1 })], t += 1000, ld('small.gguf', 500, 20, 20)) as any, null);   // saves
  const before = (f.stored as any).devices.p1.speed.errs.length;
  assert.equal(before, 19, 'load 1: the first answer seeds the guess, the next 19 score');
  // load 2: big.gguf, a new since, 4 tok/s, its own count from 1
  b.observe(snap([dev({ checkedAt: 1 })], t += 1000, ld('big.gguf', 99_000, 4, 1)) as any, null);
  assert.match(b.view().lines[0], /guess 4 tok\/s · α 0\.3$/, 'the first guess for big is its own speed, not small\'s 20');
  assert.doesNotMatch(f.events.join('\n') + ((f.stored as any).last?.text ?? ''), /guessed pixel at 20 tok\/s, it ran at 4/);
  for (let i = 2; i <= 10; i++) b.observe(snap([dev({ checkedAt: 1 })], t += 1000, ld('big.gguf', 99_000, 4, i)) as any, null);
  f.set(f.ctx.now() + 60_000);
  b.observe(snap([dev({ checkedAt: 1 })], t += 1000, ld('big.gguf', 99_000, 4, 10)) as any, null);   // saves
  const s = (f.stored as any).devices.p1.speed;
  assert.equal(s.errs.length, Math.min(30, before + 9), 'every answer of load 2 after its seed scored (none waited for 20)');
  assert.equal(s.est, 4);
  assert.equal(s.file, 'big.gguf');
  assert.equal(s.key, 'big.gguf|99000');
  assert.equal(s.done, 10);
});

test('saved notes with done 50 and no load key score on the next load', () => {
  const t = 5000;
  const f = fakeCtx({ v: 1, devices: { p1: { name: 'pixel', seen: t, speed: { alpha: 0.3, fast: 0, slow: 0, n: 3, emittedAlpha: 0.3, est: 10, errs: [0], done: 50 } } }, last: null, good: false });
  const b = create(f.ctx as any);
  b.observe(snap([dev({ checkedAt: 1 })], t + 1000, loaded([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: 12, done: 1 }])) as any, null);
  // off |12-10|/12 = 17%; mean([0, 0.167]) = 8%
  assert.equal(b.view().lines[0], 'pixel · reach: first look · α 0.3 · speed off 8% · guess 10.6 tok/s · α 0.3');
  b.observe(snap([dev({ checkedAt: 1 })], t + 2000, loaded([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: 12, done: 1 }])) as any, null);
  assert.equal(b.view().lines[0], 'pixel · reach: first look · α 0.3 · speed off 8% · guess 10.6 tok/s · α 0.3', 'the same answer is not scored twice');
});

test('a split load records no speed: its chain speed is not one device\'s', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const split = (tps: number, done: number) => ({ ...loaded([{ id: 'p1', name: 'pixel', local: false, busy: false, tps, done }, { id: 'local', name: 'this computer', local: true, busy: false, tps, done }]), mode: 'split' });
  b.observe(snap([dev({ checkedAt: 1 })], 1000, split(6, 1)) as any, null);
  b.observe(snap([dev({ checkedAt: 1 })], 2000, split(9, 2)) as any, null);
  f.set(f.ctx.now() + 60_000);
  b.observe(snap([dev({ checkedAt: 1 })], 3000, split(9, 3)) as any, null);
  assert.equal(b.view().lines.length, 1, 'only the device from the look, no "this computer" from the chain');
  assert.doesNotMatch(b.view().lines[0], /speed/);
  const saved = f.stored as any;
  assert.equal(saved?.devices?.p1?.speed, undefined);
  assert.equal(saved?.devices?.local, undefined);
});

test('a 20-vs-5 speed miss scores exactly as the merged version did: stat, gauge and line', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const at = (tps: number, done: number, t: number) => b.observe(snap([dev({ checkedAt: 1 })], t, loaded([{ id: 'p1', name: 'pixel', local: false, busy: false, tps, done }])) as any, null);
  at(20, 1, 1000);                                // the guess starts at 20 tok/s
  at(5, 2, 2000);                                 // off = |5 - 20| / 5 = 3: 300%, not capped
  const v = b.view();
  assert.equal(v.stat, 'speed off 300%');         // the merged version's stat, unchanged
  assert.equal(v.gauge, 0);                       // 100 - 300 is negative: the speed part counts 0
  assert.equal(v.lines[0], 'pixel · reach: first look · α 0.3 · speed off 300% · guess 15.5 tok/s · α 0.3');
  f.set(f.ctx.now() + 60_000);
  at(5, 2, 2500);                                 // saves
  assert.deepEqual((f.stored as any).devices.p1.speed.errs, [3], 'the merged version stored it uncapped');
});

test('five uncapped misses tune exactly as the merged version did', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const at = (tps: number, done: number, t: number) => b.observe(snap([dev({ checkedAt: 1 })], t, loaded([{ id: 'p1', name: 'pixel', local: false, busy: false, tps, done }])) as any, null);
  at(20, 1, 1000);                                // est 20
  at(5, 2, 2000);                                 // off 3; est 15.5
  at(5, 3, 3000);                                 // off 2.1; est 12.35
  at(5, 4, 4000);                                 // off 1.47; est 10.15
  at(5, 5, 5000);                                 // off 1.03; est 8.61
  at(5, 6, 6000);                                 // off 0.722; est 7.53; the errors still tune at most 1
  // mean([3, 2.1, 1.47, 1.03, 0.722]) = 1.6644 -> 166%; alpha never moves (every clamped error is 1)
  assert.equal(b.view().lines[0], 'pixel · reach: first look · α 0.3 · speed off 166% · guess 7.53 tok/s · α 0.3');
  assert.equal(b.view().stat, 'speed off 166%');
  assert.equal(b.view().gauge, 0);
});

test('merged-version notes with speed errors above 1 load with the same line, not a wiped history', () => {
  const t = 5000;
  // the notes exactly as the merged branch wrote them: errs uncapped, a reach history, a speed guess
  const stored = {
    v: 1,
    devices: {
      p1: {
        name: 'pixel', seen: t,
        reach: { alpha: 0.3, fast: 0, slow: 0, n: 6, emittedAlpha: 0.3, p: 0.9, hits: '11111', at: 5 },
        speed: { alpha: 0.3, fast: 0, slow: 0, n: 3, emittedAlpha: 0.3, est: 20, errs: [3, 1.708], done: 5 },
      },
    },
    last: null,
    good: false,
  };
  const f = fakeCtx(stored);
  const b = create(f.ctx as any);
  b.observe(snap([dev({ checkedAt: 5 })], t) as any, null);   // the same look: nothing new is scored
  // mean([3, 1.708]) = 2.354 -> 235%
  assert.equal(b.view().lines[0], 'pixel · reach right 100% of 5 · α 0.3 · speed off 235% · guess 20 tok/s · α 0.3');
  assert.equal(b.view().stat, 'reachability right 100% · speed off 235%');
  f.tick(60_000);
  b.observe(snap([dev({ checkedAt: 6 })], t + 5000) as any, null);   // one more hit, then saves
  assert.deepEqual((f.stored as any).devices.p1.speed.errs, [3, 1.708], 'the errors are kept as written');
  const again = create(fakeCtx(f.stored).ctx as any);
  again.observe(snap([dev({ checkedAt: 6 })], t + 10_000) as any, null);
  assert.equal(again.view().lines[0], 'pixel · reach right 100% of 6 · α 0.35 · speed off 235% · guess 20 tok/s · α 0.3', 'the history survived the restart');
});

test('speed errors are clamped only above 100 on read, never at record time', () => {
  const loopOk = { alpha: 0.3, fast: 0, slow: 0, n: 3, emittedAlpha: 0.3 };
  const t = 5000;
  const f = fakeCtx({ v: 1, devices: { p1: { name: 'wild', seen: t, speed: { ...loopOk, est: 20, errs: [250, null, 0.5], done: 5 } } } });
  const b = create(f.ctx as any);
  b.observe(snap([dev({ checkedAt: 5, name: 'wild' })], t) as any, null);
  // 250 is clamped to 100, the null entry is skipped: mean([100, 0.5]) = 50.25 -> 5025%
  assert.equal(b.view().lines[0], 'wild · reach: first look · α 0.3 · speed off 5025% · guess 20 tok/s · α 0.3');
  f.tick(60_000);
  b.observe(snap([dev({ checkedAt: 5, name: 'wild' })], t + 5000) as any, null);   // saves
  assert.deepEqual((f.stored as any).devices.p1.speed.errs, [100, 0.5], 'nothing above 100 reaches the notes');
});

test('an always-there device through the real eye: the skill stays hidden and no feed line in 300 hours', () => {
  const dir = path.join(HOME, 'eye-always');
  const hour0 = new Date(2026, 10, 8, 22, 0, 0).getTime();
  const HOUR = 3600_000;
  let i = 0;
  // twelve 5 s looks at the top of each hour: enough for that hour to fold, 300 hours in all; each
  // look carries a new probe, made at the look's own time
  const atNow = () => hour0 + Math.floor(i / 12) * HOUR + (i % 12) * 5000;
  const eye = new GodsEye({ snapshot: () => snap([dev({ checkedAt: atNow() })], atNow()), dir, now: () => 0 });
  for (; i < 300 * 12; i++) eye.tick();
  const tile = eye.view().branches.find((b) => b.id === 'learning')!;
  assert.equal(tile.error, undefined, 'learning was not stopped');
  assert.equal(tile.rows.find((r) => r[0] === 'forecast scored')![1], '200 hours', 'it had plenty of scored hours');
  const skill = tile.rows.find((r) => r[0] === 'forecast skill')![1];
  assert.equal(skill, 'no skill to beat: the device\'s own average was exact (Brier 0.00 vs 0.00)', 'the skill stays hidden, never "+0.00"');
  assert.match(tile.rows.find((r) => r[0] === 'forecast calibration')![1], /^said \d+% on average, devices were there 100% of 200 hours$/);
  const noise = eye.view().events.filter((e) => e.branch === 'learning' && /the forecast is doing/.test(e.text));
  assert.deepEqual(noise, [], 'no feed line from rounding noise');
});

/** twelve 5 s looks an hour for `hours` hours through the real eye; `there(h)` says whether the
 *  device answered in hour h. every line the learning branch emits is kept with its look's time,
 *  so the eye's 60-event cap cannot hide one. */
function hourRun(dir: string, hours: number, there: (h: number) => boolean) {
  const hour0 = new Date(2026, 10, 8, 22, 0, 0).getTime();
  const HOUR = 3600_000;
  const emitted: { at: number; text: string }[] = [];
  let look = 0;
  const atNow = () => hour0 + Math.floor(look / 12) * HOUR + (look % 12) * 5000;
  const eye = new GodsEye({
    snapshot: () => {
      const h = Math.floor(look / 12);
      // every look carries a new probe, made at the look's own time
      return snap([dev({ checkedAt: atNow(), reachable: there(h), reason: there(h) ? null : 'off' })], atNow());
    },
    dir,
    now: atNow,
    makers: {
      learning: (ctx) => create({
        ...ctx,
        emit: (s: string) => { emitted.push({ at: ctx.now(), text: s }); ctx.emit(s); },
      }),
    },
  });
  for (look = 0; look < hours * 12; look++) eye.tick();
  return { eye, emitted };
}

/** the learning feed lines that are a verdict on the forecast's skill */
const verdictLines = (es: { at: number; text: string }[]) =>
  es.filter((e) => /the forecast is (doing worse|doing better|no longer doing worse)/.test(e.text));
const alphaLines = (es: { at: number; text: string }[]) =>
  es.filter((e) => /'s (reachability|speed) (is changing, it adapts faster|has settled, it guesses steadier)/.test(e.text));

test('through the real eye: a device missing 1 hour in 40 and one missing 1 hour in 80 say no verdict in 600 hours', () => {
  const miss40 = hourRun(path.join(HOME, 'eye-noise40'), 600, (h) => h > 0 && h % 40 !== 0);
  assert.deepEqual(verdictLines(miss40.emitted), [], '1 missing hour in 40 is noise, not a skill');
  const miss80 = hourRun(path.join(HOME, 'eye-noise80'), 600, (h) => h > 0 && h % 80 !== 0);
  assert.deepEqual(verdictLines(miss80.emitted), [], '1 missing hour in 80 is noise, not a skill');
});

test('through the real eye: a habit flip says worse once and better once', () => {
  const night = (h: number) => { const hod = (22 + h) % 24; return hod >= 22 || hod < 7; };
  // sixteen days of nights, sixteen of days, then nights again: the forecast is right, then wrong,
  // then right again
  const run = hourRun(path.join(HOME, 'eye-habit'), 1300, (h) => (h < 400 || h >= 800 ? night(h) : !night(h)));
  const all = run.emitted.map((e) => `${e.at}: ${e.text}`).join('\n');
  const verdicts = verdictLines(run.emitted);
  const worse = verdicts.filter((e) => /is doing worse/.test(e.text));
  const better = verdicts.filter((e) => /is doing better/.test(e.text));
  assert.equal(worse.length, 1, all);
  assert.equal(better.length, 1, all);
  assert.ok(worse[0].at < better[0].at, `worse at ${worse[0].at}, better at ${better[0].at}`);
  assert.match(worse[0].text, /^learning: the forecast is doing worse than each device's own average \(skill -0\.\d\d over 200 hours\)$/);
  assert.match(better[0].text, /^learning: the forecast is doing better than each device's own average again \(skill \+0\.\d\d over 200 hours\)$/);
});

test('the α feed lines do not flood: a factor of two, at most one an hour per device, in 600 hours', () => {
  const run = hourRun(path.join(HOME, 'eye-alpha'), 600, (h) => h > 0 && h % 40 !== 0);
  const alpha = alphaLines(run.emitted);
  assert.ok(alpha.length >= 1, `α must move here or the test proves nothing:\n${run.emitted.map((e) => e.text).join('\n')}`);
  assert.ok(alpha.length <= 100, `α lines over 600 hours: ${alpha.length} (was 136 before the pacing)`);
  const step = /\(α (\d+(?:\.\d+)?) → (\d+(?:\.\d+)?)\)$/;           // r2 prints 0.3, 0.61, 0.07
  let last = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (i > 0) assert.ok(alpha[i].at - alpha[i - 1].at >= 3_600_000, `α lines ${(alpha[i].at - alpha[i - 1].at) / 1000} s apart`);
    const m = step.exec(alpha[i].text)!;
    assert.ok(m, alpha[i].text);
    const [from, to] = [Number(m[1]), Number(m[2])];
    if (i > 0) assert.equal(from, last, 'each line starts where the last one ended');
    assert.ok(to >= from * 2 - 0.02 || to <= from / 2 + 0.02, `α ${from} → ${to} is under a factor of two (shown to two decimals)`);
    last = to;
  }
});

test('an α line after the clock stepped back is not held for an hour by the remembered time', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  let checked = 0;
  const look = (reachable: boolean, at: number) =>
    b.observe(snap([dev({ reachable, checkedAt: ++checked })], at) as any, null);
  for (let i = 0; i < 20; i++) look(true, 1000 + i * 5000);
  for (let i = 0; i < 12; i++) look(i % 2 === 0, 1000 + (20 + i) * 5000);   // α crosses up: the first line
  const lines = () => f.events.filter((e) => /α /.test(e));
  assert.equal(lines().length, 1, f.events.join('\n'));
  // the clock is back before the line: settling looks at that time must still be able to say one
  for (let i = 0; i < 80; i++) look(true, 20_000);
  assert.equal(lines().length, 2, `the pacing re-anchored to the clock that stepped back:\n${f.events.join('\n')}`);
  assert.match(lines()[1], /has settled, it guesses steadier/);
  // the notes keep the α line's time (the clock it stepped back to)
  f.tick(60_000);
  look(true, 21_000);                                                      // saves
  assert.equal((f.stored as any).devices.p1.alphaAt, 20_000, 'the α line time is saved');
});

test('the α line time is read back: a restart within its hour stays quiet, after the hour it speaks', () => {
  const f = fakeCtx();
  let b = create(f.ctx as any);
  let checked = 0;
  const look = (reachable: boolean, at: number) =>
    b.observe(snap([dev({ reachable, checkedAt: ++checked })], at) as any, null);
  for (let i = 0; i < 20; i++) look(true, 1000 + i * 5000);
  for (let i = 0; i < 12; i++) look(i % 2 === 0, 1000 + (20 + i) * 5000);   // α crosses up: one line
  assert.equal(f.events.filter((e) => /α /.test(e)).length, 1, f.events.join('\n'));
  f.tick(60_000);
  look(true, 200_000);                                                      // saves, the α line time with it
  const stored = f.stored as any;
  const t0 = stored.devices.p1.alphaAt as number;
  assert.equal(typeof t0, 'number', 'the α line time is in the notes');
  // a new branch loads the notes; α settles to half inside the line's hour and must stay quiet
  const g = fakeCtx(stored);
  b = create(g.ctx as any);
  for (let i = 0; i < 80; i++) look(true, t0 + (i + 1) * 1000);
  const said = () => g.events.filter((e) => /α /.test(e));
  assert.equal(said().length, 0, `within the hour the loaded time holds it back:\n${g.events.join('\n')}`);
  // one look past the hour, one that moves α again: the same crossing is said
  look(false, t0 + 3_600_000);
  assert.equal(said().length, 1, g.events.join('\n'));
  assert.match(said()[0], /has settled, it guesses steadier/);
  const m = /\(α ([\d.]+) → ([\d.]+)\)$/.exec(said()[0])!;
  assert.ok(Number(m[2]) <= Number(m[1]) / 2, `a factor of two: ${said()[0]}`);
});

test('through the eye: the learning tile is lit and its notes land in learning.json', () => {
  const dir = path.join(HOME, 'eye');
  let t = 0, checked = 0;
  const eye = new GodsEye({ snapshot: () => snap([dev({ checkedAt: ++checked })], t), dir, now: () => t });
  for (let i = 0; i < 15; i++) { t += 5000; eye.tick(); }
  const tile = eye.view().branches.find((b) => b.id === 'learning')!;
  assert.equal(tile.built, true);
  assert.equal(tile.stat, 'reachability right 100%');
  assert.equal(tile.gauge, 100);
  assert.ok(fs.existsSync(path.join(dir, 'learning.json')));
  assert.ok(eye.view().events.some((e) => e.branch === 'learning' && /now 100% right/.test(e.text)));
});
