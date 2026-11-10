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
const { create, cleanNotes, levelOf, energyWh, minutesOf, minutesWord, gaugeOf, percentWord, gbShown, dayKey, WH_MAX, MINUTES_MAX } = await import('../src/godseye/branches/limits.ts');

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

// ---- the tests below were added for the review: bad clocks and bad values. Every bad-input
// test calls view() and reads the feed while that snapshot is still the current one, as the eye does.

const HOUR = 3_600_000;
const FIVE_YEARS = 5 * 365 * 24 * 60 * MIN;

/** a fake ctx whose wall clock the test moves on its own, and whose save is a real json round trip */
function clockCtx(stored: unknown = null, start = T0) {
  const out = { saved: [] as any[], events: [] as string[], file: stored as any, wall: start };
  const ctx = {
    now: () => out.wall,
    load: <T>(fb: T): T => (out.file ?? fb) as T,
    save: (d: unknown) => { out.file = JSON.parse(JSON.stringify(d)); out.saved.push(out.file); },
    emit: (t: string) => { out.events.push(t); },
    peek: () => null,
  };
  return { ctx, out };
}

/** a snapshot with any field overridable, including null, where snap() would substitute a default */
const rawWork = (loaded: unknown = null) => ({ loaded, loading: null, chatting: 0, plan: [], decisions: [], llama: true });
const rawSnap = (at: number, o: Record<string, unknown> = {}) => ({
  at, host: { name: 'mac', freeMb: 8000 }, devices: [dev()],
  work: rawWork(), models: [model(2000)], projects: [], ...o,
});

const pcDevices = [dev({ id: 'pc1', name: 'tower', kind: 'pc' })];
const pcLoaded = loaded([ld({ id: 'pc1', name: 'tower', busy: true })]);

test('pin: a good busy pc keeps its exact line, rows, gauge and note', () => {
  const { ctx } = clockCtx();
  const b = create(ctx as any);
  for (let at = T0; at <= T0 + 45_000; at += 15_000) {
    b.observe(snap(at, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  }
  const v = b.view();
  assert.equal(v.stat, 'all within limits');
  assert.equal(v.gauge, 96);
  assert.deepEqual(v.lines, ['tower · memory 2.0 GB of 3.9 GB (50%) ok · answering 1 min, rest at 20 · 0 answers in the last hour · 0.2 Wh today']);
  assert.deepEqual(v.rows, [
    ['energy today', '0.2 Wh (a guess)'],
    ['busy today', '1 min'],
    ['rules', 'memory tight over 80% · rest after 20 min · phone 3 W, pc 15 W'],
  ]);
  assert.equal(v.note, 'it only warns, it never stops a device. it cannot see battery or heat yet.');
});

test('pin: the rest and night warning lines and their feed text are unchanged', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  let done = 0;
  for (let at = T0; at <= T0 + 21 * MIN; at += 5000) {
    if ((at - T0) % MIN === 0) done++;
    b.observe(snap(at, { loaded: loaded([ld({ busy: true, done })]) }) as any, null);
  }
  assert.equal(b.view().stat, '1 warning');
  // the warning line follows the run; the feed text is from the moment it crossed 20 minutes
  assert.equal(b.view().lines[0], 'warning: pixel should rest: answering for 21 min without a break');
  assert.deepEqual(out.events.filter((e) => /should rest/.test(e)), ['limits: pixel should rest: answering for 20 min without a break']);
  // while the cause goes on the all clear is not said
  const seen = out.events.length;
  b.observe(snap(T0 + 21 * MIN + 5000, { loaded: loaded([ld({ busy: true, done })]) }) as any, null);
  assert.equal(out.events.length, seen);
  assert.equal(out.events.filter((e) => /had its break/.test(e)).length, 0);

  const { ctx: ctx2, out: out2 } = clockCtx();
  const b2 = create(ctx2 as any);
  const proj = { id: 'n1', title: 'summaries', request: 'x', start: T0 - 60 * MIN, end: T0, state: 'running', mode: 'phone', model: 'm1', peers: ['p1'] };
  b2.observe(snap(T0 - 5000, { loaded: loaded([ld({ busy: true })]), projects: [proj] }) as any, null);
  b2.observe(snap(T0 + 10 * MIN, { loaded: loaded([ld({ busy: true })]), projects: [proj] }) as any, null);
  assert.equal(b2.view().stat, '2 warnings');
  assert.equal(b2.view().lines[0], 'warning: night project "summaries" still running 10 min past its end at 12:00');
  assert.equal(b2.view().lines[1], 'warning: pixel still working after the night window of "summaries" (ended 12:00)');
  assert.deepEqual(out2.events, [
    'limits: night project "summaries" still running 10 min past its end at 12:00',
    'limits: pixel still working after the night window of "summaries" (ended 12:00)',
  ]);
});

test('pin: the memory level follows the raw share while the percent beside it is rounded', () => {
  // 4000 MB free: 3188/4000 = 79.7%, 3212 = 80.3%, 3988 = 99.7%, 4012 = 100.3%
  const cases = [
    { need: 3188, level: 'ok', gauge: 41 },
    { need: 3212, level: 'tight', gauge: 39 },
    { need: 3988, level: 'tight', gauge: 1 },
    { need: 4012, level: 'over', gauge: 0 },
  ];
  for (const c of cases) {
    const { ctx, out } = clockCtx();
    const b = create(ctx as any);
    b.observe(snap(T0, { loaded: loaded([ld()]), needMb: c.need }) as any, null);
    const v = b.view();
    const gbWord = c.need < 3900 ? '3.1 GB' : '3.9 GB';
    const percent = c.need < 3900 ? 80 : 100;
    assert.equal(v.gauge, c.gauge, `need ${c.need}`);
    if (c.level === 'ok') {
      assert.equal(v.stat, 'all within limits');
      assert.deepEqual(v.lines, [`pixel · memory ${gbWord} of 3.9 GB (${percent}%) ok · free · 0 answers in the last hour`]);
      assert.deepEqual(out.events, []);
    } else {
      assert.equal(v.stat, '1 warning');
      const tail = c.level === 'over' ? 'more than it has' : 'tight';
      const warn = `pixel: the model needs ${gbWord} of its 3.9 GB (${percent}%), ${tail}`;
      assert.deepEqual(v.lines, [
        `warning: ${warn}`,
        `pixel · memory ${gbWord} of 3.9 GB (${percent}%) ${c.level} · free · 0 answers in the last hour`,
      ]);
      assert.deepEqual(out.events, [`limits: ${warn}`]);
    }
  }
});

test("a far-forward clock cannot push the look's own day out of the notes", () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const look = (at: number) => {
    out.wall = at;
    b.observe(snap(at, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  };
  // fifteen days forty days ahead fill and overfill the fourteen day slots
  for (let d = 0; d < 15; d++) {
    look(T0 + 40 * 24 * HOUR + d * 24 * HOUR);
    look(T0 + 40 * 24 * HOUR + d * 24 * HOUR + 15_000);
  }
  // the clock is corrected: today's work must still be kept and saved
  for (let at = T0; at <= T0 + 60_000; at += 15_000) look(at);
  const v = b.view();
  assert.equal(Object.fromEntries(v.rows)['energy today'], '0.3 Wh (a guess)');   // 4 × 15 s at 15 W = 0.25
  const keys = Object.keys(out.file.days);
  assert.ok(keys.length <= 14, keys.join(','));
  assert.ok(keys.includes('2026-11-08'), keys.join(','));
  assert.ok(out.file.days['2026-11-08'].wh > 0, 'today was not saved');
  const b2 = create(ctx as any);                                                 // restart
  assert.equal(Object.fromEntries(b2.view().rows)['energy today'], '0.3 Wh (a guess)');
});

test('a look without a usable time changes nothing and writes no NaN day key', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  b.observe(snap(T0, { loaded: loaded([ld({ busy: true })]) }) as any, null);
  b.observe(snap(T0 + 5000, { loaded: loaded([ld({ busy: true })]) }) as any, null);
  assert.ok(out.saved.length >= 1);
  const viewBefore = JSON.stringify(b.view());
  const eventsBefore = out.events.length;
  const savedBefore = JSON.stringify(out.file);
  for (const at of [NaN, Infinity, -Infinity, -1, 8.64e15 + 1]) {
    assert.doesNotThrow(() => b.observe(snap(at, { loaded: loaded([ld({ busy: true })]) }) as any, null));
    assert.equal(JSON.stringify(b.view()), viewBefore, `view changed by at=${at}`);
    assert.doesNotMatch(JSON.stringify(b.view()), /NaN|undefined|\[object Object\]|e\+\d/);
  }
  assert.equal(out.events.length, eventsBefore);
  assert.equal(JSON.stringify(out.file), savedBefore, 'a bad look saved notes');
  assert.ok(Object.keys(out.file.days).every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)), JSON.stringify(Object.keys(out.file.days)));
});

test('a far-forward clock does not silence the branch: normal looks record, the minutes stay sane, saves happen and rest warns', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const look = (at: number, wall = at) => {
    out.wall = wall;
    b.observe(snap(at, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  };
  for (let at = T0; at <= T0 + 2 * MIN; at += 15_000) look(at);
  look(T0 + FIVE_YEARS, T0 + 2 * MIN);          // the snapshot clock runs five years ahead, the wall clock does not
  for (let at = T0 + 2 * MIN + 15_000; at <= T0 + 23 * MIN; at += 15_000) look(at);
  const v = b.view();
  assert.equal(v.stat, '1 warning');
  assert.equal(v.gauge, 0);
  assert.deepEqual(v.lines, [
    'warning: tower should rest: answering for 21 min without a break',
    'tower · memory 2.0 GB of 3.9 GB (50%) ok · answering 21 min, rest at 20 · 0 answers in the last hour · 5.7 Wh today',
  ]);
  assert.ok(out.saved.length >= 5, `saved ${out.saved.length} times`);
  assert.deepEqual(out.events.filter((e) => /should rest/.test(e)), ['limits: tower should rest: answering for 20 min without a break']);
});

test('a far-forward clock then a restart: the file loads, normal looks record and the rest warning fires', () => {
  const { ctx, out } = clockCtx();
  const look = (branch: any, at: number, wall = at) => {
    out.wall = wall;
    branch.observe(snap(at, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  };
  let b = create(ctx as any);
  look(b, T0);
  look(b, T0 + 15_000);                          // one counted step, saved
  assert.ok(out.saved.length >= 1);
  look(b, T0 + 5 * 365 * 24 * 60 * MIN, T0 + 30_000);
  b = create(ctx as any);                        // restart from what the far-forward look left on disk
  for (let at = T0 + 45_000; at <= T0 + 22 * MIN; at += 15_000) look(b, at);
  const v = b.view();
  assert.equal(v.stat, '1 warning');
  assert.deepEqual(v.lines, [
    'warning: tower should rest: answering for 21 min without a break',
    'tower · memory 2.0 GB of 3.9 GB (50%) ok · answering 21 min, rest at 20 · 0 answers in the last hour · 5.4 Wh today',
  ]);
  assert.ok(out.saved.length >= 4, `saved ${out.saved.length} times`);
});

test('a hostile snapshot never writes notes the loader rejects: the earlier history survives a restart', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const devices = [dev({ id: 'pc1', name: 'tower', kind: 'pc' })];
  const good = (at: number) => snap(at, { devices, loaded: loaded([ld({ id: 'pc1', name: 'tower', busy: true })]) });
  out.wall = T0;
  b.observe(good(T0) as any, null);
  out.wall = T0 + 15_000;
  b.observe(good(T0 + 15_000) as any, null);                 // one counted step, saved
  assert.equal(Object.fromEntries(b.view().rows)['energy today'], '0.1 Wh (a guess)');
  const hostile = [
    rawSnap(T0 + 30_000, { work: rawWork(loaded([ld({ id: 'pc1', name: 'tower', busy: 'yes', done: 'many' })])), devices: [null] }),
    rawSnap(T0 + 45_000, { at: NaN }),
    rawSnap(-1, {}),
    rawSnap(T0 + 60_000, { work: rawWork(loaded([ld({ id: 'pc1', name: 'tower', busy: true, done: NaN })])), models: [null], projects: [null], devices: null }),
  ];
  for (const s of hostile) assert.doesNotThrow(() => b.observe(s, null));
  out.wall = T0 + 75_000;
  b.observe(good(T0 + 75_000) as any, null);                 // a good look after them saves again
  assert.ok(out.saved.length >= 2);
  assert.doesNotMatch(JSON.stringify(out.file), /NaN|undefined|e\+\d/);
  const b2 = create(ctx as any);                             // restart from that file
  assert.equal(Object.fromEntries(b2.view().rows)['energy today'], '0.1 Wh (a guess)', 'the history did not survive');
});

test('a clock that steps back three hours does not stop saving, and the branch still counts after re-anchoring', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const look = (at: number, wall = at) => {
    out.wall = wall;
    b.observe(snap(at, { loaded: loaded([ld({ busy: true })]) }) as any, null);
  };
  for (let at = T0; at <= T0 + 2 * MIN; at += 5000) look(at);
  const first = out.saved.length;
  assert.ok(first >= 2 && first <= 4, `saved ${first} times in two minutes`);
  // the computer's clock steps back three hours; the looks continue and are counted again
  const BACK = 3 * HOUR;
  for (let at = T0 + 2 * MIN + 5000; at <= T0 + 4 * MIN; at += 5000) look(at - BACK);
  assert.ok(out.saved.length > first, `saved ${out.saved.length - first} times after the step back`);
  assert.equal(Object.fromEntries(b.view().rows)['busy today'], '4 min');
  assert.doesNotMatch(JSON.stringify(b.view()), /answering -|NaN/);
});

test('a far-forward run then the right clock and an idle device: the warning ends after a minute', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  let t = T0 + FIVE_YEARS;
  for (let i = 0; i <= 88; i++) {                       // 22 minutes of work on the wrong clock
    out.wall = t;
    b.observe(snap(t, { devices: pcDevices, loaded: pcLoaded }) as any, null);
    t += 15_000;
  }
  assert.equal(b.view().stat, '1 warning');
  assert.equal(b.view().lines[0], 'warning: tower should rest: answering for 22 min without a break');
  assert.equal(b.view().gauge, 0);
  // the clock is right again and the device idle: the break is counted from here
  for (let at = T0; at <= T0 + 75_000; at += 15_000) {
    out.wall = at;
    b.observe(snap(at, { devices: pcDevices, loaded: loaded([ld({ id: 'pc1', name: 'tower' })]) }) as any, null);
  }
  const v = b.view();
  assert.equal(v.stat, 'all within limits');
  assert.deepEqual(v.lines.filter((x) => x.startsWith('warning:')), []);
  assert.ok(!v.lines.some((x) => x.includes('should rest')), v.lines.join('\n'));
  assert.equal(v.gauge, 100);
  assert.deepEqual(out.events.filter((e) => /had its break/.test(e)), ['limits: tower had its break']);
  // the idle looks re-anchored the look clock too: a busy step after them is counted
  out.wall = T0 + 90_000;
  b.observe(snap(T0 + 90_000, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  assert.equal(Object.fromEntries(b.view().rows)['energy today'], '0.1 Wh (a guess)');
});

test('a clock an hour ahead then an hour back while idle: the warning ends after the break, not after an hour', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  let t = T0 + HOUR;
  for (let i = 0; i <= 84; i++) {                       // 21 minutes of work on the wrong clock
    out.wall = t;
    b.observe(snap(t, { devices: pcDevices, loaded: pcLoaded }) as any, null);
    t += 15_000;
  }
  assert.equal(b.view().stat, '1 warning');
  assert.equal(b.view().lines[0], 'warning: tower should rest: answering for 21 min without a break');
  // the clock steps back an hour and the device is idle: the break runs from the correction
  for (let at = T0; at <= T0 + 75_000; at += 15_000) {
    out.wall = at;
    b.observe(snap(at, { devices: pcDevices, loaded: loaded([ld({ id: 'pc1', name: 'tower' })]) }) as any, null);
  }
  const v = b.view();
  assert.equal(v.stat, 'all within limits');
  assert.ok(!v.lines.some((x) => x.startsWith('warning:')), v.lines.join('\n'));
  assert.deepEqual(out.events.filter((e) => /had its break/.test(e)), ['limits: tower had its break']);
});

test('when days must be pruned the future ones go before any real past day', () => {
  const days: Record<string, unknown> = {};
  for (let i = 26; i <= 31; i++) days[`2026-10-${i}`] = { wh: 1, busyMin: 1, by: {} };   // 6
  for (let i = 1; i <= 7; i++) days[`2026-11-0${i}`] = { wh: 1, busyMin: 1, by: {} };    // 7
  const { ctx, out } = clockCtx({ v: 1, days });
  const b = create(ctx as any);
  const future = T0 + 40 * 24 * HOUR;
  out.wall = future;
  b.observe(snap(future, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  out.wall = future + 15_000;
  b.observe(snap(future + 15_000, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  // the clock is corrected: today arrives with 13 real past days behind it, the future day goes
  for (let at = T0; at <= T0 + 60_000; at += 15_000) {
    out.wall = at;
    b.observe(snap(at, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  }
  const keys = Object.keys(out.file.days);
  assert.ok(keys.includes('2026-11-08'), keys.join(','));
  assert.ok(!keys.some((k) => k > '2026-11-08'), keys.join(','));       // no future day survives
  assert.ok(keys.includes('2026-10-26'), keys.join(','));               // the oldest past day is kept
  assert.ok(keys.length <= 14, keys.join(','));
});

test('a future day never pre-fills energy today when its date arrives', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const future = T0 + 40 * 24 * HOUR;
  // the wrong clock records a future day with 0.1 Wh on it
  out.wall = future;
  b.observe(snap(future, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  out.wall = future + 15_000;
  b.observe(snap(future + 15_000, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  assert.equal(Object.fromEntries(b.view().rows)['energy today'], '0.1 Wh (a guess)');
  // the clock is corrected: the future day is dropped, not left waiting for its date
  for (let at = T0; at <= T0 + 60_000; at += 15_000) {
    out.wall = at;
    b.observe(snap(at, { devices: pcDevices, loaded: loaded([ld({ id: 'pc1', name: 'tower' })]) }) as any, null);
  }
  assert.ok(!(dayKey(future) in out.file.days), dayKey(future));
  // the date arrives for real: a fresh zero day, not the old prefilled one
  out.wall = future;
  b.observe(snap(future, { devices: pcDevices, loaded: loaded([ld({ id: 'pc1', name: 'tower' })]) }) as any, null);
  assert.equal(Object.fromEntries(b.view().rows)['energy today'], '0 Wh (a guess)');
});

test('an answer counter past its ceiling does not invent answers', () => {
  const { ctx } = clockCtx();
  const b = create(ctx as any);
  b.observe(snap(T0, { loaded: loaded([ld({ busy: true, done: 1_000_000_005 })]) }) as any, null);
  b.observe(snap(T0 + 5000, { loaded: loaded([ld({ busy: true, done: 1_000_000_015 })]) }) as any, null);
  // two counters past 1e9 both read as the ceiling, not as ten answers
  assert.equal(b.view().lines[0], 'pixel · memory 2.0 GB of 3.9 GB (50%) ok · answering 0 min, rest at 20 · 0 answers in the last hour · 0 Wh today');
});

test('notes are saved at most once a minute on the wall clock', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  for (let at = T0; at <= T0 + 3 * MIN; at += 5000) {
    out.wall = at;
    b.observe(snap(at, { loaded: loaded([ld({ busy: true })]) }) as any, null);
  }
  assert.ok(out.saved.length >= 3 && out.saved.length <= 4, `saved ${out.saved.length} times in three minutes`);
});

test('an idle branch does not rewrite its notes', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  for (let at = T0; at <= T0 + 5 * MIN; at += 5000) {
    out.wall = at;
    b.observe(snap(at) as any, null);
  }
  assert.deepEqual(out.saved, []);
});

test('save pacing follows this computer\'s clock, not the snapshot\'s at', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  // looks a wall minute apart while the snapshot's own clock advances only 15 s
  for (let i = 0; i <= 3; i++) {
    out.wall = T0 + i * MIN;
    b.observe(snap(T0 + i * 15_000, { loaded: loaded([ld({ busy: true })]) }) as any, null);
  }
  // the first counted look saves, then one per wall minute: 3, not one per 15 s of at
  assert.equal(out.saved.length, 3);
});

test('ids and names like "__proto__" and "constructor" and an odd kind are safe: real keys, no NaN', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const longId = 'x'.repeat(300);
  const longName = 'n'.repeat(300);
  const devices = [
    dev({ id: '__proto__', name: 'constructor' }),
    dev({ id: 'constructor', name: '__proto__' }),
    dev({ id: 'p3', name: 'odd', kind: 'constructor' }),
    dev({ id: longId, name: 'long-id' }),
    dev({ id: 'p4', name: longName }),
  ];
  const lds = [
    ld({ id: '__proto__', name: 'constructor', busy: true }),
    ld({ id: 'constructor', name: '__proto__', busy: true }),
    ld({ id: 'p3', name: 'odd', busy: true }),
    ld({ id: longId, name: 'long-id', busy: true }),
    ld({ id: 'p4', name: longName, busy: true }),
  ];
  for (let at = T0; at <= T0 + 60_000; at += 15_000) {
    out.wall = at;
    b.observe(snap(at, { devices, loaded: loaded(lds) }) as any, null);
  }
  const v = b.view();
  assert.doesNotMatch(JSON.stringify(v), /NaN|undefined|\[object Object\]|e\+\d/);
  assert.ok(v.lines.some((x) => x.startsWith('constructor · memory 2.0 GB of 3.9 GB (50%) ok')));
  assert.ok(v.lines.some((x) => x.startsWith('__proto__ · memory 2.0 GB of 3.9 GB (50%) ok')));
  // an id or a name over 200 chars is not a device this branch keys or shows
  assert.ok(!v.lines.some((x) => x.includes('long-id') || x.startsWith('nnn')), v.lines.join('\n'));
  const day = out.file.days['2026-11-08'];
  assert.ok(Object.prototype.hasOwnProperty.call(day.by, 'constructor'));
  assert.ok(Object.prototype.hasOwnProperty.call(day.by, '__proto__'));
  for (const name of ['constructor', '__proto__', 'odd']) {
    assert.equal(typeof day.by[name], 'number', name);
    assert.ok(Number.isFinite(day.by[name]) && day.by[name] > 0 && day.by[name] <= WH_MAX, name);
  }
});

test('notes read back are validated and bounded: 1e300 is capped, NaN and negative days are dropped', () => {
  const days = {
    '2026-11-08': { wh: 1e300, busyMin: -5, by: { pixel: 1e300 } },
    '2026-11-07': { wh: 5, busyMin: 7, by: { pixel: 1 } },
    '2026-11-06': { wh: NaN, busyMin: 1, by: {} },
    nonsense: { wh: 1 },
  };
  const { ctx } = clockCtx({ v: 1, days });
  const b = create(ctx as any);
  b.observe(snap(T0) as any, null);
  const rows = Object.fromEntries(b.view().rows);
  assert.equal(rows['energy today'], '0 Wh (a guess)');    // the corrupt day is dropped, never shown
  assert.equal(rows['energy yesterday'], '5 Wh');          // the good day survives
  assert.doesNotMatch(JSON.stringify(b.view()), /NaN|undefined|\[object Object\]|e\+\d/);

  const by = Object.fromEntries([['pixel', -1], ['bad', NaN], ['__proto__', 1e300], ['long', 2]]);
  const n = cleanNotes({ v: 1, days: { '2026-11-08': { wh: 1e300, busyMin: 1e300, by } } });
  assert.equal(n.days['2026-11-08'].wh, WH_MAX * 32);
  assert.equal(n.days['2026-11-08'].busyMin, MINUTES_MAX);
  assert.equal(n.days['2026-11-08'].by['pixel'], undefined);   // negative: dropped
  assert.equal(n.days['2026-11-08'].by['bad'], undefined);     // NaN: dropped
  assert.equal(n.days['2026-11-08'].by['__proto__'], WH_MAX);  // capped, an own key
  assert.equal(n.days['2026-11-08'].by['long'], 2);
  assert.deepEqual(Object.keys(cleanNotes({ days: 'broken' }).days), []);   // never a throw
  assert.deepEqual(Object.keys(cleanNotes({ v: 1, days: [] }).days), []);  // an array is not a day map
  assert.deepEqual(Object.keys(cleanNotes({ v: 1, days: { nonsense: { wh: 1, busyMin: 1, by: {} } } }).days), []);   // the key must be a day
  assert.deepEqual(Object.keys(cleanNotes({ v: 1, days: { '2026-11-08': { wh: 1, busyMin: 1, by: [1, 2] } } }).days['2026-11-08'].by), []);
  assert.deepEqual(Object.keys(cleanNotes({ v: 2, days }).days), []);       // another version
  // the file the last merged version wrote had no v; the good day in it still loads
  const old = cleanNotes({ days });
  assert.deepEqual(Object.keys(old.days), ['2026-11-07']);
  assert.equal(old.days['2026-11-07'].wh, 5);
});

test('null containers and odd entries never throw and never reach the view or feed as NaN, undefined or an object', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const cases: any[] = [
    null, 'not a snapshot', 42,
    rawSnap(T0, { devices: null }),
    rawSnap(T0 + 1, { devices: [null] }),
    rawSnap(T0 + 2, { work: null }),
    rawSnap(T0 + 3, { work: { loaded: null } }),
    rawSnap(T0 + 4, { work: { loaded: { mode: 'phone', model: null, devices: [], since: T0 } } }),
    rawSnap(T0 + 5, { work: { loaded: { mode: 'phone', model: { id: 'm1' }, devices: [null] } } }),
    rawSnap(T0 + 6, { work: { loaded: { mode: 'split', model: { id: 'm1' }, parts: [null], devices: null } } }),
    rawSnap(T0 + 7, { work: { loaded: 'loaded' } }),
    rawSnap(T0 + 8, { models: [null], projects: [null] }),
    rawSnap(T0 + 9, { models: null, projects: null, devices: null }),
    rawSnap(T0 + 10, { projects: [{ id: 'n1', title: 42, state: 'running', end: T0, peers: ['p1'] }] }),
    rawSnap(T0 + 11, { projects: [{ id: 7, title: 'x', state: 'running', end: T0 - 10 * MIN, peers: 'p1' }] }),
    rawSnap(T0 + 12, { projects: [{ id: 'n2', title: 'x', state: 'running', end: NaN, peers: [] }] }),
    rawSnap(T0 + 13, { at: NaN }),
    rawSnap(T0 + 14, { work: rawWork(loaded([ld()])), models: null }),   // a model loaded, no model table
  ];
  for (const s of cases) {
    assert.doesNotThrow(() => b.observe(s, null), `observe ${JSON.stringify(s)?.slice(0, 80)}`);
    const v = b.view();
    assert.equal(typeof v.gauge, 'number');
    assert.doesNotMatch(JSON.stringify(v), /NaN|undefined|\[object Object\]|e\+\d/, JSON.stringify(s)?.slice(0, 80));
    assert.doesNotMatch(JSON.stringify(out.events), /NaN|undefined|\[object Object\]|e\+\d/);
  }
});

test('a project with an unusable end or id raises no night warning', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const bad = [
    { id: 'n1', title: 'late', state: 'running', end: -1, peers: ['p1'] },
    { id: 'n2', title: 'late', state: 'running', end: 8.64e15 + 1, peers: ['p1'] },
    { id: {}, title: 'late', state: 'running', end: T0 - 10 * MIN, peers: ['p1'] },
    { id: 'n4', title: 'late', state: 'running', end: NaN, peers: ['p1'] },
  ];
  b.observe(rawSnap(T0 + 10 * MIN, { projects: bad }), null);
  assert.doesNotThrow(() => b.view());
  assert.deepEqual(b.view().lines, []);
  assert.deepEqual(out.events, []);
});

test('a project whose peers are not an array is no window warning and does not throw', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const p = { id: 'n5', title: 'late', state: 'running', end: T0 - 10 * MIN, peers: {} };
  b.observe(rawSnap(T0 + 10 * MIN, { work: rawWork(loaded([ld({ busy: true })])), projects: [p] }), null);
  assert.doesNotThrow(() => b.view());
  // the project itself is past its end (one warning), but its device is not tied to it
  assert.deepEqual(b.view().lines, [
    'warning: night project "late" still running 20 min past its end at 11:50',
    'pixel · memory 2.0 GB of 3.9 GB (50%) ok · answering 0 min, rest at 20 · 0 answers in the last hour',
  ]);
  assert.deepEqual(out.events, ['limits: night project "late" still running 20 min past its end at 11:50']);
});

test('memory numbers are bounded and a need far past the memory still warns red', () => {
  const { ctx } = clockCtx();
  const b = create(ctx as any);
  b.observe(snap(T0, { loaded: loaded([ld()]), needMb: 1e300 }) as any, null);
  const v = b.view();
  assert.equal(v.stat, '1 warning');
  assert.equal(v.gauge, 0);
  assert.equal(v.lines[0], 'warning: pixel: the model needs over 4096.0 GB of its 3.9 GB (over 100000%), more than it has');
  assert.ok(v.lines[1].startsWith('pixel · memory over 4096.0 GB of 3.9 GB (over 100000%) over'), v.lines[1]);
  assert.doesNotMatch(JSON.stringify(v), /NaN|undefined|\[object Object\]|e\+\d/);
  // a device that claims an absurd amount of memory is bounded too
  b.observe(snap(T0 + 5000, { devices: [dev({ ramMb: 1e300 })], loaded: loaded([ld()]), needMb: 2000 }) as any, null);
  assert.doesNotMatch(JSON.stringify(b.view()), /NaN|undefined|\[object Object\]|e\+\d/);
  assert.ok(b.view().lines[0].includes('of over 4096.0 GB'), b.view().lines[0]);
});

test('a memory need or size that is not a positive number is unknown, never NaN', () => {
  const cases = [
    { need: NaN, ram: 4000 },
    { need: -5, ram: 4000 },
    { need: '2000', ram: 4000 },
    { need: 2000, ram: NaN },
    { need: 2000, ram: '4000' },
    { need: 2000, ram: 0 },
  ];
  for (const c of cases) {
    const { ctx, out } = clockCtx();
    const b = create(ctx as any);
    b.observe(snap(T0, { devices: [dev({ ramMb: c.ram })], loaded: loaded([ld()]), needMb: c.need }) as any, null);
    const v = b.view();
    assert.equal(v.stat, 'all within limits', JSON.stringify(c));
    assert.deepEqual(v.lines, ['pixel · memory unknown · free · 0 answers in the last hour'], JSON.stringify(c));
    assert.deepEqual(out.events, []);
    assert.doesNotMatch(JSON.stringify(v), /NaN|undefined|\[object Object\]|e\+\d/);
  }
});

test('a bad answer counter is forgotten, not turned into a burst of answers', () => {
  const { ctx } = clockCtx();
  const b = create(ctx as any);
  b.observe(snap(T0, { loaded: loaded([ld({ busy: true, done: -5 })]) }) as any, null);
  b.observe(snap(T0 + 5000, { loaded: loaded([ld({ busy: true, done: 0 })]) }) as any, null);
  // -5 → 0 is not five answers: a counter that is not a count starts a new baseline
  assert.equal(b.view().lines[0], 'pixel · memory 2.0 GB of 3.9 GB (50%) ok · answering 0 min, rest at 20 · 0 answers in the last hour · 0 Wh today');
});

test('answers in the last hour are only those that can be placed: a night and a week of silence add none', () => {
  const { ctx } = clockCtx();
  const b = create(ctx as any);
  let done = 1;
  const look = (at: number) => b.observe(snap(at, { loaded: loaded([ld({ busy: true, done })]) }) as any, null);
  look(T0);
  for (let i = 1; i <= 4; i++) { done++; look(T0 + i * 5000); }
  assert.match(b.view().lines[0], /4 answers in the last hour/);
  // ten hours of silence: five answers happened somewhere in it and cannot be placed
  done += 5;
  look(T0 + 10 * HOUR);
  assert.match(b.view().lines[0], /0 answers in the last hour/);
  // one new answer between two close looks is placed again
  done++; look(T0 + 10 * HOUR + 5000);
  assert.equal(b.view().lines[0], 'pixel · memory 2.0 GB of 3.9 GB (50%) ok · answering 0 min, rest at 20 · 1 answer in the last hour · 0 Wh today');
  // a week of silence adds none either
  done += 5;
  look(T0 + 7 * 24 * HOUR);
  assert.match(b.view().lines[0], /0 answers in the last hour/);
});

test('an answer stamped by a far-forward clock expires an hour after the clock is right again', () => {
  const { ctx } = clockCtx();
  const b = create(ctx as any);
  let done = 1;
  const look = (at: number) => b.observe(snap(at, { loaded: loaded([ld({ busy: true, done })]) }) as any, null);
  look(T0);
  done++; look(T0 + 15_000);                       // one answer at T0 + 15 s
  look(T0 + FIVE_YEARS - 15_000);                  // clock jumps ahead: the answer cannot be placed
  done++; look(T0 + FIVE_YEARS);                   // a close pair at the far-forward time: one answer stamped there
  assert.match(b.view().lines[0], /1 answer in the last hour/);
  for (let at = T0 + 30_000; at <= T0 + 75 * MIN; at += 5 * MIN) look(at);   // clock right again
  assert.equal(b.view().lines[0], 'pixel · memory 2.0 GB of 3.9 GB (50%) ok · answering 0 min, rest at 20 · 0 answers in the last hour · 0 Wh today');
});

test('a 50 KB unbroken project title is cut before masking: the look stays fast and every line stays short', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const p = { id: 'n1', title: 'a'.repeat(50_000), request: 'x', start: T0 - 60 * MIN, end: T0, state: 'running', mode: 'phone', model: 'm1', peers: ['p1'] };
  const started = Date.now();
  b.observe(rawSnap(T0 + 10 * MIN, { work: rawWork(loaded([ld({ busy: true })])), projects: [p] }), null);
  const took = Date.now() - started;
  assert.ok(took < 1000, `took ${took} ms`);
  for (const line of b.view().lines) assert.ok(line.length <= 400, `line of ${line.length}`);
  for (const e of out.events) assert.ok(e.length <= 400, `event of ${e.length}`);
});

test('nothing secret leaves the branch: a title is masked, the request never reaches notes, view or feed', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const p = { id: 'n1', title: 'report for ada@example.com', request: 'summarize the private ledger 4111 1111 1111 1111', start: T0 - 60 * MIN, end: T0, state: 'running', mode: 'phone', model: 'm1', peers: ['p1'] };
  const t1 = T0 + 10 * MIN;
  out.wall = t1;
  b.observe(rawSnap(t1, { work: rawWork(loaded([ld({ busy: true })])), projects: [p] }), null);
  out.wall = t1 + 5000;
  b.observe(rawSnap(t1 + 5000, { work: rawWork(loaded([ld({ busy: true })])), projects: [p] }), null);
  assert.ok(out.saved.length >= 1, 'notes were saved');
  const secret = /ada@example\.com|4111 1111 1111 1111|summarize the private ledger/;
  assert.doesNotMatch(JSON.stringify(b.view()), secret);
  assert.doesNotMatch(JSON.stringify(out.events), secret);
  assert.doesNotMatch(JSON.stringify(out.file), secret);
  assert.ok(b.view().lines.some((x) => x.includes('night project "report for …"')), b.view().lines.join('\n'));
});

test('a device that appears and vanishes: its line and run go, its work stays in the notes, back it starts at 0 min', () => {
  const { ctx } = clockCtx();
  const b = create(ctx as any);
  const devices = [dev({ id: 'pc1', name: 'tower', kind: 'pc' })];
  const l = loaded([ld({ id: 'pc1', name: 'tower', busy: true })]);
  b.observe(snap(T0, { devices, loaded: l }) as any, null);
  b.observe(snap(T0 + 15_000, { devices, loaded: l }) as any, null);
  assert.match(b.view().lines[0], /^tower .* answering 0 min/);
  b.observe(snap(T0 + 30_000, { devices: [], loaded: null }) as any, null);
  const v = b.view();
  assert.deepEqual(v.lines, []);
  assert.equal(v.stat, 'all within limits');
  assert.match(v.note!, /no model loaded, nothing is working/);
  assert.equal(Object.fromEntries(v.rows)['energy today'], '0.1 Wh (a guess)');
  b.observe(snap(T0 + 45_000, { devices, loaded: l }) as any, null);
  assert.match(b.view().lines[0], /^tower .* answering 0 min, rest at 20 · 0 answers in the last hour/);
});

test('the notes keep at most 32 names a day while the total still counts every device', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  const devices: any[] = [];
  const lds: any[] = [];
  for (let i = 0; i < 40; i++) {
    devices.push(dev({ id: `p${i}`, name: `dev${i}` }));
    lds.push(ld({ id: `p${i}`, name: `dev${i}`, busy: true }));
  }
  for (let at = T0; at <= T0 + 15_000; at += 15_000) {
    out.wall = at;
    b.observe(snap(at, { devices, loaded: loaded(lds) }) as any, null);
  }
  const day = out.file.days['2026-11-08'];
  assert.equal(Object.keys(day.by).length, 32);
  for (const name of Object.keys(day.by)) assert.match(name, /^dev\d+$/);
  assert.equal(Object.fromEntries(b.view().rows)['energy today'], '0.5 Wh (a guess)');
});

test('rest fires only when the shown minutes pass 20: 20 min stays quiet, 21 warns', () => {
  const quiet = create(clockCtx().ctx as any);
  for (let at = T0; at <= T0 + 20 * MIN; at += 5000) quiet.observe(snap(at, { loaded: loaded([ld({ busy: true })]) }) as any, null);
  assert.equal(quiet.view().stat, 'all within limits');
  assert.match(quiet.view().lines[0], /answering 20 min, rest at 20/);
  const loud = create(clockCtx().ctx as any);
  for (let at = T0; at <= T0 + 20 * MIN + 45_000; at += 5000) loud.observe(snap(at, { loaded: loaded([ld({ busy: true })]) }) as any, null);
  assert.equal(loud.view().stat, '1 warning');
});

test('the pure helpers: energy, minutes, gauge, level and bounded memory words', () => {
  assert.equal(energyWh(3, 600_000), 0.5);
  assert.equal(energyWh(15, 15_000), 0.0625);
  assert.equal(minutesOf(45_000), 1);
  assert.equal(minutesOf(-120_000), 0);
  assert.equal(minutesWord(21 * MIN), '21 min');
  assert.equal(minutesWord(200_000 * MIN), 'over 100000 min');
  assert.equal(gaugeOf([]), 100);
  assert.equal(gaugeOf([100, 96.25]), 96);
  assert.equal(gaugeOf([-3.75]), 0);
  assert.equal(gaugeOf([NaN, 50]), 50);
  assert.equal(gaugeOf([-Infinity]), 0);      // a share that overflowed is no headroom
  assert.equal(gaugeOf([Infinity]), 100);
  // the level follows the raw share; the percentage printed beside it is rounded
  assert.equal(levelOf(0.797), 'ok');
  assert.equal(levelOf(0.8), 'ok');          // 80% exactly is the old boundary: still ok
  assert.equal(levelOf(0.803), 'tight');
  assert.equal(levelOf(0.997), 'tight');
  assert.equal(levelOf(1), 'tight');         // 100% exactly: tight, as before
  assert.equal(levelOf(1.003), 'over');
  assert.equal(percentWord(2_500_000), 'over 100000');
  assert.equal(percentWord(85), '85');
  assert.equal(gbShown(4000), '3.9 GB');
  assert.equal(gbShown(1e300), 'over 4096.0 GB');
  assert.equal(dayKey(new Date(2026, 10, 8, 12, 0, 0).getTime()), '2026-11-08');
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
