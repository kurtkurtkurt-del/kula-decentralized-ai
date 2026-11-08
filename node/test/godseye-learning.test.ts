// god's eye, branch 4 (learning loop): it guesses each device's next look and speed, scores the
// guesses against the next snapshot, tunes alpha within bounds, keeps bounded notes and says little.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-learning-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { create, tune, ALPHA_MIN, ALPHA_MAX } = await import('../src/godseye/branches/learning.ts');
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
