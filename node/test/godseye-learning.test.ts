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
const { create: forecastCreate } = await import('../src/godseye/branches/forecast.ts');
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

test('a device always there: the baseline is exact, the skill is hidden, no feed line', () => {
  const f = fakeCtx();
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: Array.from({ length: 50 }, (_, i) => pair(i, 0.9, 0.5, 1, 1, 1)) }]);
  const b = create(f.ctx as any);
  b.observe(snap([dev()], 1000) as any, null);
  const v = b.view();
  // bs = (0.9-1)^2 = 0.01, bs0 = (1-1)^2 = 0: nothing to beat; said 90%, was 100%
  assert.deepEqual(v.rows[v.rows.length - 2], ['forecast skill', 'no skill to beat: the device\'s own average was exact (Brier 0.01 vs 0.00)']);
  assert.deepEqual(v.rows[v.rows.length - 1], ['forecast calibration', 'said 90% on average, devices were there 100% of 50 hours']);
  assert.ok(v.lines.includes('pixel · forecast: no skill to beat (Brier 0.01 vs 0.00) · said 90% on average, there 100% of 50 hours'));
  assert.equal(f.events.length, 0, 'a baseline of zero gives no skill to cross with');
});

test('the worse feed line once with hysteresis, and the recovery line above 0.05', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const skillRow = () => b.view().rows.find((r) => r[0] === 'forecast skill')![1];
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.5, 0.4, 1, 0.5) }]);    // p never left p0
  b.observe(snap([dev()], 1000) as any, null);
  assert.equal(skillRow(), 'no slot seen twice yet');
  assert.equal(f.events.length, 0, 'no slot seen twice yet is not a verdict');
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.75, 0.4, 1, 0.5) }]);   // skill -0.25
  b.observe(snap([dev()], 1000) as any, null);
  assert.deepEqual(f.events, ['learning: the forecast is doing worse than each device\'s own average (skill -0.25 over 48 hours)']);
  b.observe(snap([dev()], 2000) as any, null);                                            // still worse: said once
  assert.equal(f.events.length, 1);
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.5, 0.4, 1, 0.5) }]);    // p = p0 again: no skill to compare
  b.observe(snap([dev()], 3000) as any, null);
  assert.equal(f.events.length, 1, 'no slot seen twice yet is no recovery either');
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
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.75, 0.4, 1, 0.5) }]);    // a fall below 0 says it again
  b.observe(snap([dev()], 7000) as any, null);
  assert.equal(f.events.length, 3);
  assert.equal(f.events[2], 'learning: the forecast is doing worse than each device\'s own average (skill -0.25 over 48 hours)');
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
  assert.deepEqual(f.events, ['learning: the forecast is doing worse than each device\'s own average (skill -9.99 over 48 hours)']);
});

test('no slot seen twice yet: p only differs from p0 below two decimals', () => {
  const f = fakeCtx();
  const b = create(f.ctx as any);
  // p = 0.502, p0 = 0.5: the same to two decimals; bs = 0.250004, skill = -0.000016
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: alt(48, 0.502, 0.4, 1, 0.5) }]);
  b.observe(snap([dev()], 1000) as any, null);
  const v = b.view();
  assert.deepEqual(v.rows.find((r) => r[0] === 'forecast skill'), ['forecast skill', 'no slot seen twice yet']);
  assert.ok(v.lines.includes('pixel · forecast: no slot seen twice yet'));
  assert.equal(f.events.length, 0, 'no skill is shown, so no feed line');
  // one pair where p differs at two decimals brings the skill back
  f.peeked = fcView([{ id: 'p1', name: 'pixel', scored: [...alt(47, 0.502, 0.4, 1, 0.5), pair(99, 0.2, 0.4, 1, 0.5, 1)] }]);
  b.observe(snap([dev()], 2000) as any, null);
  assert.match(b.view().rows.find((r) => r[0] === 'forecast skill')![1], /^-\d\.\d\d against/);
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
      assert.deepEqual(b.view().rows.slice(-3), zero, what);
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

test('three weeks of a weekly pattern, through the real forecast branch: positive skill after enough hours', () => {
  const fcF = fakeCtx();
  const fc = forecastCreate(fcF.ctx as any);
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const hourAt = (day: number, hour: number) => new Date(2026, 10, 8 + day, hour, 0, 0).getTime();
  const hourLooks = (day: number, hour: number, there: boolean) => {
    const t = hourAt(day, hour);
    for (let i = 0; i < 12; i++) {
      const s = snap([dev({ reachable: there, reason: there ? null : 'off' })], t + i * 5000) as any;
      fc.observe(s, null);
      f.peeked = fc.view();
      b.observe(s, null);
    }
  };
  for (let day = 0; day < 21; day++) { hourLooks(day, 10, false); hourLooks(day, 22, true); }   // three weeks, two hours a day
  const v = b.view();
  // 42 hours looked at: 41 folds, the first four not scored (the device was not known yet)
  assert.equal(v.rows.find((r) => r[0] === 'forecast scored')![1], '37 hours');
  assert.match(v.rows.find((r) => r[0] === 'forecast skill')![1], /^\+0\.\d\d against each device's own average \(Brier 0\.\d\d vs 0\.\d\d\)$/);
  assert.equal(f.events.length, 0, 'a weekly pattern is not worse than the device\'s own average');
});

test('a habit flip: the skill goes negative, said once, and comes back once the habit returns', () => {
  const fcF = fakeCtx();
  const fc = forecastCreate(fcF.ctx as any);
  const f = fakeCtx();
  const b = create(f.ctx as any);
  const hourAt = (day: number, hour: number) => new Date(2026, 10, 8 + day, hour, 0, 0).getTime();
  const hourLooks = (day: number, hour: number, there: boolean) => {
    const t = hourAt(day, hour);
    for (let i = 0; i < 12; i++) {
      const s = snap([dev({ reachable: there, reason: there ? null : 'off' })], t + i * 5000) as any;
      fc.observe(s, null);
      f.peeked = fc.view();
      b.observe(s, null);
    }
  };
  for (let day = 0; day < 21; day++) { hourLooks(day, 10, false); hourLooks(day, 22, true); }    // three weeks of nights
  assert.match(b.view().rows.find((r) => r[0] === 'forecast skill')![1], /^\+0\.\d\d against/);
  for (let day = 21; day < 42; day++) { hourLooks(day, 10, true); hourLooks(day, 22, false); }   // the habit flips to days
  const worse = f.events.filter((e) => /^learning: the forecast is doing worse than each device's own average \(skill -\d+\.\d\d over \d+ hours\)$/.test(e));
  assert.equal(worse.length, 1, f.events.join('\n'));
  assert.match(b.view().rows.find((r) => r[0] === 'forecast skill')![1], /^-\d\.\d\d against/, 'the flipped forecast is worse than the device\'s own average');
  for (let day = 42; day < 84; day++) { hourLooks(day, 10, false); hourLooks(day, 22, true); }   // back to nights, six weeks
  const better = f.events.filter((e) => /^learning: the forecast is doing better than each device's own average again \(skill \+\d+\.\d\d over \d+ hours\)$/.test(e));
  assert.equal(better.length, 1, f.events.join('\n'));
  assert.match(b.view().rows.find((r) => r[0] === 'forecast skill')![1], /^\+0\.\d\d against/);
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
  let i = 0, checked = 0;
  // twelve 5 s looks at the top of each hour: enough for that hour to fold, 300 hours in all
  const eye = new GodsEye({ snapshot: () => snap([dev({ checkedAt: ++checked })], hour0 + Math.floor(i / 12) * HOUR + (i % 12) * 5000), dir, now: () => 0 });
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
