// god's eye, branch 3 forecast: tonight's guess per device from past looks, tok/s as a weighted
// average, notes saved at most once a minute and read back, a feed line only when a guess flips.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { create } = await import('../src/godseye/branches/forecast.ts');
const { GodsEye } = await import('../src/godseye/index.ts');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-forecast-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const snap = (devices: any[], at: number, loaded: any = null): any => ({
  at, host: { name: 'mac', freeMb: 4000 }, devices,
  work: { loaded, loading: null, chatting: 0, plan: [], decisions: [], llama: true },
  models: [], projects: [],
});
const loadedWith = (devices: any[]) => ({
  mode: 'apart', model: { id: 'q', name: 'Qwen3 0.6B', file: 'qwen3-0.6b.gguf', size: 1 }, ctx: 4096, since: 0, devices,
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

const at23 = (i: number) => new Date(2026, 10, 8, 23, 0, 0).getTime() + i * 5000;

test('with no history it is built and says it is still learning', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  b.observe(snap([dev()], at23(0)), null);
  const v = b.view();
  assert.equal(v.built, true);
  assert.equal(v.stat, 'still learning: 1 look so far');
  assert.equal(v.gauge, 0);
  assert.match(v.lines[0], /^pixel · tonight 22–07: no looks then yet$/);
  assert.match(v.note!, /still learning: 1 look so far/);
});

test('looks at night: the one that answered is likely, the one that did not is unlikely; a device not looked at yet says nothing', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  for (let i = 0; i < 130; i++) {
    b.observe(snap([
      dev(),
      dev({ id: 'p2', name: 'galaxy', reachable: false, reason: 'no answer' }),
      dev({ id: 'p3', name: 'cable phone', via: 'cable', plugged: false }),
      dev({ id: 'p4', name: 'new one', reachable: null }),
    ], at23(i)), null);
  }
  const v = b.view();
  assert.equal(v.stat, '3 devices · tonight 1 likely');
  assert.equal(v.lines[0], 'pixel · tonight 22–07: likely (100% of past looks)');
  assert.ok(v.lines.includes('galaxy · tonight 22–07: unlikely (0% of past looks)'));
  assert.ok(v.lines.includes('cable phone · tonight 22–07: unlikely (0% of past looks)'), 'unplugged cable phone is not there');
  assert.ok(!v.lines.some((l) => l.startsWith('new one')));
  assert.equal(v.gauge, Math.round(100 / 24));    // one hour of the day seen
});

test('tok/s: a weighted average, sampled only when the answer count grows', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  const s = (i: number, tps: number | null, done: number) => snap([dev({ holds: 'qwen3-0.6b.gguf' })], at23(i), loadedWith([{ id: 'p1', name: 'pixel', local: false, busy: false, tps, done }]));
  b.observe(s(0, 8, 1), null);
  b.observe(s(1, 20, 1), null);           // same answer count: not a new sample
  b.observe(s(2, null, 1), null);
  b.observe(s(3, 6, 2), null);            // 8 + 0.3 * (6 - 8) = 7.4
  assert.match(b.view().lines[0], / · ~7\.4 tok\/s on Qwen3 0\.6B$/);
});

test('saves at most once a minute, and a new branch reads its notes back', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  for (let i = 0; i < 30; i++) { b.observe(snap([dev()], at23(i)), null); c.t += 5000; }   // 150 s of looks
  assert.equal(c.saves, 2);
  const saved = c.stored as any;
  assert.equal(saved.v, 1);
  assert.ok(saved.looks >= 12 && saved.looks <= 30);
  assert.ok(JSON.stringify(saved).length < 4000, 'small notes');
  const again = create(ctx);
  again.observe(snap([dev()], at23(100)), null);
  assert.equal(again.view().rows[0][1], String(saved.looks + 1));
});

test('notes that are not its own are dropped for fresh ones', () => {
  for (const bad of [null, 'x', { v: 2 }, { v: 1, looks: 3, dev: { p1: { h: [1, 2] } } }]) {
    const { ctx } = fakeCtx(bad);
    const b = create(ctx);
    assert.doesNotThrow(() => b.observe(snap([dev()], at23(0)), null));
    assert.equal(b.view().built, true);
  }
});

test('a feed line only when tonight\'s guess flips from likely to unlikely, not on every look', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  for (let i = 0; i < 20; i++) b.observe(snap([dev()], at23(i)), null);
  assert.equal(c.feed.length, 0, 'the first guess is not news');
  for (let i = 20; i < 80; i++) b.observe(snap([dev({ reachable: false, reason: 'gone' })], at23(i)), null);
  assert.equal(c.feed.length, 1);
  assert.match(c.feed[0], /^forecast: pixel is now unlikely tonight 22–07 \(\d+% of \d+ past looks\)$/);
});

test('in the eye: the forecast tile is lit and keeps its notes in forecast.json', () => {
  let t = at23(0);
  const dir = path.join(HOME, 'eye');
  const eye = new GodsEye({ snapshot: () => snap([dev()], t), dir, now: () => t });
  for (let i = 0; i < 20; i++) { eye.tick(); t += 5000; }
  const f = eye.view().branches.find((b) => b.id === 'forecast')!;
  assert.equal(f.built, true);
  assert.equal(f.error, undefined);
  assert.match(f.stat, /still learning: 20 looks so far/);
  assert.ok(fs.existsSync(path.join(dir, 'forecast.json')));
});
