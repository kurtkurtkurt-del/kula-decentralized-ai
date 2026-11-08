// god's eye, branch 9 limits: memory (ok / tight / over), rest after a long run, the night window,
// the energy guess kept per day, and feed lines only when a warning starts or ends.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-limits-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { GodsEye } = await import('../src/godseye/index.ts');
const { create } = await import('../src/godseye/branches/limits.ts');

const T0 = new Date(2026, 10, 8, 12, 0, 0).getTime();
const MIN = 60_000;

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 4000, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const model = (needMb: number) => ({ id: 'm1', name: 'small', file: 'small.gguf', size: 1, quant: null, params_b: 1, catalog: true, here: true, needMb });
const loaded = (devices: any[], o: Record<string, unknown> = {}) => ({ mode: 'phone', model: { id: 'm1', name: 'small', file: 'small.gguf', size: 1 }, ctx: 4096, since: T0, devices, ...o });
const ld = (o: Record<string, unknown> = {}) => ({ id: 'p1', name: 'pixel', local: false, busy: false, tps: 10, done: 0, ...o });
const snap = (at: number, o: { devices?: any[]; loaded?: any; needMb?: number; projects?: any[] } = {}) => ({
  at, host: { name: 'mac', freeMb: 8000 }, devices: o.devices ?? [dev()],
  work: { loaded: o.loaded ?? null, loading: null, chatting: 0, plan: [], decisions: [], llama: true },
  models: [model(o.needMb ?? 2000)], projects: o.projects ?? [],
});

function fakeCtx(stored: unknown = null) {
  const out = { saved: [] as any[], events: [] as string[], file: stored };
  const ctx = {
    now: () => T0,
    load: <T>(fb: T): T => (out.file ?? fb) as T,
    save: (d: unknown) => { out.file = structuredClone(d); out.saved.push(out.file); },
    emit: (t: string) => { out.events.push(t); },
    peek: () => null,
  };
  return { ctx, out };
}

test('nothing loaded: built, all within limits, full headroom, and the note says it cannot see battery or heat', () => {
  const { ctx, out } = fakeCtx();
  const b = create(ctx as any);
  b.observe(snap(T0) as any, null);
  const v = b.view();
  assert.equal(v.built, true);
  assert.equal(v.stat, 'all within limits');
  assert.equal(v.gauge, 100);
  assert.match(v.note!, /battery or heat/);
  assert.deepEqual(out.events, []);
});

test('memory: ok under 80%, tight over it, over past the device\'s memory; a line when it starts and when it ends', () => {
  const { ctx, out } = fakeCtx();
  const b = create(ctx as any);
  b.observe(snap(T0, { loaded: loaded([ld()]), needMb: 2000 }) as any, null);
  assert.equal(b.view().stat, 'all within limits');
  assert.match(b.view().lines[0], /pixel · memory 2\.0 GB of 3\.9 GB \(50%\) ok/);
  assert.equal(b.view().gauge, 100);

  b.observe(snap(T0 + 5000, { loaded: loaded([ld()]), needMb: 3400 }) as any, null);
  assert.equal(b.view().stat, '1 warning');
  assert.match(b.view().lines[0], /^warning: pixel: .*85%.*tight/);
  assert.equal(b.view().gauge, 30);
  assert.equal(out.events.length, 1);
  b.observe(snap(T0 + 10000, { loaded: loaded([ld()]), needMb: 3400 }) as any, null);
  assert.equal(out.events.length, 1, 'no line on every look');

  b.observe(snap(T0 + 15000, { loaded: loaded([ld()]), needMb: 5000 }) as any, null);
  assert.match(b.view().lines[0], /more than it has/);
  assert.equal(b.view().gauge, 0);
  assert.match(out.events.at(-2)!, /more than it has/);
  assert.match(out.events.at(-1)!, /no longer tight/);

  b.observe(snap(T0 + 20000, { loaded: null }) as any, null);
  assert.equal(b.view().stat, 'all within limits');
  assert.match(out.events.at(-1)!, /no longer over/);
});

test('memory in split mode: each part against its own device; this computer\'s part is not judged', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx as any);
  const parts = [{ id: 'p1', name: 'pixel', local: false, mb: 3900, layers: 10 }, { id: 'p2', name: 'moto', local: false, mb: 1000, layers: 4 }, { id: 'here', name: 'mac', local: true, mb: 9000, layers: 14 }];
  const l = loaded([ld(), ld({ id: 'p2', name: 'moto' }), ld({ id: 'here', name: 'mac', local: true })], { mode: 'split', parts });
  b.observe(snap(T0, { devices: [dev(), dev({ id: 'p2', name: 'moto', ramMb: 3000 })], loaded: l, needMb: 99999 }) as any, null);
  const v = b.view();
  assert.equal(v.stat, '1 warning');
  assert.match(v.lines[0], /pixel: .*98%.*tight/);
  assert.ok(v.lines.some((x) => /^moto · memory 1\.0 GB of 2\.9 GB \(33%\) ok/.test(x)));
  assert.ok(v.lines.some((x) => /^mac \(this computer\)/.test(x) && !/memory/.test(x)));
});

test('rest: answering 20 minutes without a break warns once; a break of a minute ends it; answers per hour counted', () => {
  const { ctx, out } = fakeCtx();
  const b = create(ctx as any);
  let done = 0;
  let at = T0;
  for (; at <= T0 + 21 * MIN; at += 5000) {
    if ((at - T0) % MIN === 0) done++;
    b.observe(snap(at, { loaded: loaded([ld({ busy: true, done })]) }) as any, null);
  }
  const v = b.view();
  assert.equal(v.stat, '1 warning');
  assert.match(v.lines[0], /pixel should rest: answering for 21 min without a break/);
  assert.match(v.lines[1], /answering 21 min, rest at 20 · 21 answers in the last hour/);
  assert.equal(out.events.filter((e) => /should rest/.test(e)).length, 1);
  assert.equal(v.gauge, 0);
  // a short pause is not a break
  b.observe(snap(at, { loaded: loaded([ld({ busy: false, done })]) }) as any, null);
  assert.equal(b.view().stat, '1 warning');
  // a minute and more without work is
  b.observe(snap(at + 5000, { loaded: loaded([ld({ busy: false, done })]) }) as any, null);
  for (let t = at + 10000; t <= at + 70000; t += 5000) b.observe(snap(t, { loaded: loaded([ld({ busy: false, done })]) }) as any, null);
  assert.equal(b.view().stat, 'all within limits');
  assert.match(out.events.at(-1)!, /pixel had its break/);
  b.observe(snap(at + 75000, { loaded: loaded([ld({ busy: true, done })]) }) as any, null);
  assert.match(b.view().lines[0], /answering 0 min/);
});

test('night window: a running project past its end warns, and so does its device still working then', () => {
  const { ctx, out } = fakeCtx();
  const b = create(ctx as any);
  const proj = (state: string) => ({ id: 'n1', title: 'summaries', request: 'x', start: T0 - 60 * MIN, end: T0, state, mode: 'phone', model: 'm1', peers: ['p1'] });
  b.observe(snap(T0 - 5000, { loaded: loaded([ld({ busy: true })]), projects: [proj('running')] }) as any, null);
  assert.equal(b.view().stat, 'all within limits');
  b.observe(snap(T0 + 10 * MIN, { loaded: loaded([ld({ busy: true })]), projects: [proj('running')] }) as any, null);
  const v = b.view();
  assert.equal(v.stat, '2 warnings');
  assert.ok(v.lines.some((x) => /night project "summaries" still running 10 min past its end/.test(x)));
  assert.ok(v.lines.some((x) => /pixel still working after the night window/.test(x)));
  assert.equal(v.gauge, 0);
  b.observe(snap(T0 + 11 * MIN, { loaded: loaded([ld()]), projects: [proj('done')] }) as any, null);
  assert.equal(b.view().stat, 'all within limits');
  assert.equal(out.events.length, 4);
});

test('energy: busy time × watts by kind, per day, saved about once a minute, read back by a new eye', () => {
  const dir = path.join(HOME, 'eye-energy');
  let s: any = snap(T0);
  const eye = new GodsEye({ snapshot: () => s, dir, now: () => s.at });
  const devices = [dev(), dev({ id: 'pc1', name: 'tower', kind: 'pc' })];
  // 10 minutes: the phone and the pc busy, this computer free
  for (let at = T0; at <= T0 + 10 * MIN; at += 5000) {
    s = snap(at, { devices, loaded: loaded([ld({ busy: true }), ld({ id: 'pc1', name: 'tower', busy: true }), ld({ id: 'here', name: 'mac', local: true })]) });
    eye.tick();
  }
  const lim = eye.view().branches.find((b) => b.id === 'limits')!;
  assert.equal(lim.built, true);
  const row = Object.fromEntries(lim.rows);
  assert.equal(row['energy today'], '3 Wh (a guess)');      // 3 W × 10 min + 15 W × 10 min = 0.5 + 2.5 Wh
  assert.equal(row['busy today'], '20 min');
  assert.ok(lim.lines.some((x) => /^tower .* 2\.5 Wh today/.test(x)));
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'limits.json'), 'utf8'));
  const day = Object.values(file.days)[0] as any;
  assert.ok(day.wh > 2.5 && day.wh <= 3, `saved ${day.wh}`);

  // a gap between looks (the computer slept) is not counted as work
  s = snap(T0 + 70 * MIN, { devices, loaded: loaded([ld({ busy: true })]) });
  eye.tick();
  assert.equal(Object.fromEntries(eye.view().branches.find((b) => b.id === 'limits')!.rows)['busy today'], '20 min');

  // the next day starts at zero, yesterday is kept
  const eye2 = new GodsEye({ snapshot: () => snap(T0 + 24 * 60 * MIN) as any, dir });
  eye2.tick();
  const rows2 = Object.fromEntries(eye2.view().branches.find((b) => b.id === 'limits')!.rows);
  assert.equal(rows2['energy today'], '0 Wh (a guess)');
  assert.match(rows2['energy yesterday'], /^3 Wh$/);
});

test('notes stay bounded: old days dropped, a bad file is ignored', () => {
  const days: Record<string, unknown> = {};
  for (let i = 1; i <= 30; i++) days[`2026-10-${String(i).padStart(2, '0')}`] = { wh: i, busyMin: i, by: { pixel: i } };
  days['nonsense'] = { wh: 1 };
  const { ctx, out } = fakeCtx({ days });
  const b = create(ctx as any);
  for (let at = T0; at <= T0 + 2 * MIN; at += 5000) b.observe(snap(at, { loaded: loaded([ld({ busy: true })]) }) as any, null);
  assert.ok(out.saved.length >= 1 && out.saved.length <= 3, `saved ${out.saved.length} times in two minutes`);
  const keys = Object.keys(out.file.days);
  assert.ok(keys.length <= 14);
  assert.ok(keys.includes('2026-11-08'));
  assert.ok(!keys.includes('nonsense') && !keys.includes('2026-10-01'));
  assert.doesNotThrow(() => create(fakeCtx({ days: 'broken' }).ctx as any).view());
});
