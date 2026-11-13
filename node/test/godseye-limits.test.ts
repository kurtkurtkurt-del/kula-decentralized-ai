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

function fakeCtx(stored: unknown = null, views: Record<string, unknown> = {}) {
  const out = { saved: [] as any[], events: [] as string[], file: stored };
  const ctx = {
    now: () => T0,
    load: <T>(fb: T): T => (out.file ?? fb) as T,
    save: (d: unknown) => { out.file = structuredClone(d); out.saved.push(out.file); },
    emit: (t: string) => { out.events.push(t); },
    peek: (id: string) => views[id] ?? null,
  };
  return { ctx, out };
}

test('nothing loaded: built, all within limits, full headroom, and the note says where battery and heat come from', () => {
  const { ctx, out } = fakeCtx();
  const b = create(ctx as any);
  b.observe(snap(T0) as any, null);
  const v = b.view();
  assert.equal(v.built, true);
  assert.equal(v.stat, 'all within limits');
  assert.equal(v.gauge, 100);
  assert.match(v.note!, /heat, battery and throttling come from each phone's newest health line \(fresh for 5 min\), from its signed ledger only when trust verified its identity and its ledger/);
  assert.match(v.note!, /a phone's own brain does not see the other devices' health yet/);
  assert.doesNotMatch(v.what!, /come later/);
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

/** fourteen saved days, 2026-10-26 to 2026-11-08, with distinct Wh values for the checks */
function fourteenDays(): Record<string, unknown> {
  const keys = [
    '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31',
    '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08',
  ];
  const days: Record<string, unknown> = {};
  keys.forEach((k, i) => { days[k] = { wh: i + 1, busyMin: 1, by: { pixel: i + 1 } }; });
  return days;
}

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
  assert.equal(v.note, 'it only warns, it never stops a device. heat, battery and throttling come from each phone\'s newest health line (fresh for 5 min), from its signed ledger only when trust verified its identity and its ledger; a phone\'s own brain does not see the other devices\' health yet.');
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

test('one look with a clock far behind keeps every saved day, live and after a restart', () => {
  const days = fourteenDays();
  const { ctx, out } = clockCtx({ v: 1, days });
  const b = create(ctx as any);
  const back = new Date(2001, 0, 1, 12, 0, 0).getTime();
  // one look far behind the saved days: nothing is dropped and nothing is saved because of it
  out.wall = back;
  b.observe(snap(back) as any, null);
  assert.equal(out.saved.length, 0, 'one look behind saved the notes');
  assert.deepEqual(Object.keys(out.file.days).sort(), Object.keys(days).sort());
  // a second look fifteen seconds later counts today's energy under the look's own day, still
  // in memory only: the saved file is not touched and the fourteen days are not dropped
  out.wall = back + 15_000;
  b.observe(snap(back + 15_000, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  assert.equal(Object.fromEntries(b.view().rows)['energy today'], '0.1 Wh (a guess)');
  assert.equal(out.saved.length, 0, 'an unconfirmed earlier day was saved');
  assert.deepEqual(Object.keys(out.file.days).sort(), Object.keys(days).sort());
  // normal looks record and save again: all fourteen days are still there
  const l = loaded([ld({ id: 'pc1', name: 'tower', busy: true })]);
  for (let at = T0; at <= T0 + 2 * MIN; at += 15_000) {
    out.wall = at;
    b.observe(snap(at, { devices: pcDevices, loaded: l }) as any, null);
  }
  assert.ok(out.saved.length >= 1, 'normal looks save again');
  const after = Object.keys(out.file.days);
  assert.equal(after.length, 14, after.join(','));
  for (const k of Object.keys(days)) assert.ok(after.includes(k), `${k} was erased: ${after.join(',')}`);
  assert.ok(!after.includes('2001-01-01'), after.join(','));
  // the history survives a restart
  const b2 = create(ctx as any);
  const rows = Object.fromEntries(b2.view().rows);
  assert.equal(rows['energy yesterday'], '13 Wh');
});

test('a clock that moved back for good drops the later days after two looks a minute apart', () => {
  const days = fourteenDays();
  const { ctx, out } = clockCtx({ v: 1, days });
  const b = create(ctx as any);
  const back = new Date(2001, 0, 1, 12, 0, 0).getTime();
  const look = (at: number) => {
    out.wall = at;
    b.observe(snap(at, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  };
  look(back);
  look(back + 15_000);                 // 15 s of work on the earlier day: it waits in memory
  look(back + 59_000);                 // fifty-nine seconds: not a minute, so nothing is dropped
  assert.equal(out.saved.length, 0);
  assert.equal(Object.keys(out.file.days).length, 14);
  look(back + 60_000);                 // a minute since the first look: the clock really moved back
  assert.deepEqual(Object.keys(out.file.days), ['2001-01-01']);
  // 15 W × (15 s that waited + 1 s of this look) under the look's own day
  assert.equal(out.file.days['2001-01-01'].wh, 1 / 15);
  // the day and its energy load back
  const b2 = create(ctx as any);
  out.wall = back + 75_000;
  b2.observe(snap(back + 75_000, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  out.wall = back + 90_000;
  b2.observe(snap(back + 90_000, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  assert.equal(Object.fromEntries(b2.view().rows)['energy today'], '0.1 Wh (a guess)');   // 1/15 + 15 s × 15 W
});

test('a look on a saved day earlier than a ran-ahead day keeps that day\'s saved energy', () => {
  const days = {
    '2026-11-08': { wh: 50, busyMin: 10, by: { tower: 50 } },
    '2026-11-09': { wh: 1, busyMin: 1, by: { tower: 1 } },
  };
  const { ctx, out } = clockCtx({ v: 1, days });
  const b = create(ctx as any);
  const look = (at: number) => {
    out.wall = at;
    b.observe(snap(at, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  };
  look(T0);
  look(T0 + 15_000);
  // while the ran-ahead day waits to be confirmed, the saved day is the one shown and counted into
  assert.equal(Object.fromEntries(b.view().rows)['energy today'], '50.1 Wh (a guess)');   // 50 + 15 W × 15 s
  for (let at = T0 + 30_000; at <= T0 + 3 * MIN; at += 15_000) look(at);
  // a wall minute later with no new step: the notes are written
  out.wall = T0 + 3 * MIN + 60_000;
  b.observe(snap(T0 + 3 * MIN, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  // 50 Wh saved + 12 counted steps of 15 s at 15 W = 0.75 Wh
  assert.equal(out.file.days['2026-11-08'].wh, 50.75);
  assert.ok(!('2026-11-09' in out.file.days), Object.keys(out.file.days).join(','));
  assert.equal(Object.fromEntries(b.view().rows)['energy today'], '50.8 Wh (a guess)');
});

test('a look on a saved day stepped back 30 s across midnight keeps that day\'s saved energy', () => {
  const D9 = new Date(2026, 10, 9, 0, 0, 0).getTime();
  const days = { '2026-11-08': { wh: 50, busyMin: 10, by: { tower: 50 } } };
  const { ctx, out } = clockCtx({ v: 1, days });
  const b = create(ctx as any);
  const look = (at: number) => {
    out.wall = at;
    b.observe(snap(at, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  };
  look(D9 - 15_000);                   // 11-08 23:59:45: the saved day, no later day yet
  look(D9);                            // 11-09 00:00:00: a later day from a clock that ran ahead
  look(D9 - 30_000);                   // the clock steps back 30 s across midnight to 11-08 23:59:30
  look(D9 - 15_000);                   // 23:59:45: 15 s of work, 50.0625 Wh
  // while the earlier day waits, the saved 50 Wh is shown and counted into
  assert.equal(Object.fromEntries(b.view().rows)['energy today'], '50.1 Wh (a guess)');   // 50 + 15 W × 15 s
  look(D9);                            // midnight again: the waiting day is merged, not put over
  // a wall minute later with no new step: the notes are written
  out.wall = D9 + 60_000;
  b.observe(snap(D9, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  assert.equal(out.file.days['2026-11-08'].wh, 50.0625);   // 50 + 15 W × 15 s
  assert.equal(out.file.days['2026-11-09'].wh, 0.125);     // 2 × 15 W × 15 s
});

test('energy on a second earlier day is counted under that day, not the first', () => {
  const days = { '2026-11-09': { wh: 1, busyMin: 1, by: { tower: 1 } } };
  const { ctx, out } = clockCtx({ v: 1, days });
  const b = create(ctx as any);
  const look = (at: number) => {
    out.wall = at;
    b.observe(snap(at, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  };
  look(new Date(2026, 10, 7, 23, 59, 30).getTime());   // 11-07 23:59:30: the first earlier day waits
  look(new Date(2026, 10, 7, 23, 59, 45).getTime());   // 11-07 23:59:45: 0.0625 Wh goes into it
  look(new Date(2026, 10, 8, 0, 0, 0).getTime());      // 11-08 00:00:00: a second earlier day shows up
  assert.equal(Object.fromEntries(b.view().rows)['energy today'], '0.1 Wh (a guess)');   // 15 W × 15 s on 11-08
  look(new Date(2026, 10, 8, 0, 1, 0).getTime());      // a minute on 11-08: the clock moved back for good
  // 11-08 is the day that goes into the notes with its own energy; 11-07 was never in them
  assert.deepEqual(Object.keys(out.file.days), ['2026-11-08']);
  assert.equal(out.file.days['2026-11-08'].wh, 0.0625);
});

test('a transient clock behind keeps its energy as a past day when the clock comes back', () => {
  const days = {
    '2026-11-06': { wh: 1, busyMin: 1, by: { pixel: 1 } },
    '2026-11-07': { wh: 2, busyMin: 1, by: { pixel: 2 } },
    '2026-11-08': { wh: 3, busyMin: 1, by: { pixel: 3 } },
  };
  const { ctx, out } = clockCtx({ v: 1, days });
  const b = create(ctx as any);
  const back = new Date(2001, 0, 1, 12, 0, 0).getTime();
  out.wall = back;
  b.observe(snap(back) as any, null);
  out.wall = back + 15_000;
  b.observe(snap(back + 15_000, { devices: pcDevices, loaded: pcLoaded }) as any, null);
  assert.equal(out.saved.length, 0);
  // the clock comes back before a second look agrees: nothing was dropped, and the earlier
  // day goes into the notes as a past day with the energy it counted
  out.wall = T0;
  b.observe(snap(T0) as any, null);
  assert.deepEqual(Object.keys(out.file.days).sort(), ['2001-01-01', '2026-11-06', '2026-11-07', '2026-11-08']);
  assert.deepEqual(out.file.days['2001-01-01'].by, { tower: 0.0625 });   // 15 W × 15 s
  assert.equal(out.file.days['2026-11-08'].wh, 3);
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

test('the rest warning stands 55 s after a far-forward clock is corrected and ends after the break', () => {
  const { ctx, out } = clockCtx();
  const b = create(ctx as any);
  let t = T0 + HOUR;
  for (let i = 0; i <= 84; i++) {                       // 21 minutes of work on a clock an hour ahead
    out.wall = t;
    b.observe(snap(t, { devices: pcDevices, loaded: pcLoaded }) as any, null);
    t += 15_000;
  }
  assert.equal(b.view().lines[0], 'warning: tower should rest: answering for 21 min without a break');
  const idle = (at: number) => {
    out.wall = at;
    b.observe(snap(at, { devices: pcDevices, loaded: loaded([ld({ id: 'pc1', name: 'tower' })]) } as any), null);
  };
  // the clock is corrected: the run keeps its 21 minutes and the break is counted from here
  idle(T0);
  idle(T0 + 55_000);
  assert.equal(b.view().stat, '1 warning');
  assert.equal(b.view().lines[0], 'warning: tower should rest: answering for 21 min without a break');
  idle(T0 + 75_000);                                    // the break reaches a minute
  assert.equal(b.view().stat, 'all within limits');
  assert.ok(!b.view().lines.some((x) => x.startsWith('warning:')));
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

test('answers across a gap are counted while the gap is under an hour, and not at an hour or more', () => {
  const { ctx } = clockCtx();
  const b = create(ctx as any);
  let done = 1;
  const look = (at: number) => b.observe(snap(at, { loaded: loaded([ld({ busy: true, done })]) }) as any, null);
  look(T0);
  // thirty minutes between looks: the three answers happened somewhere in the last half hour,
  // so they can be placed in the hour even though the gap is far longer than a step
  done += 3;
  look(T0 + 30 * MIN);
  assert.equal(b.view().lines[0], 'pixel · memory 2.0 GB of 3.9 GB (50%) ok · answering 0 min, rest at 20 · 3 answers in the last hour');
  // exactly an hour since the last look: nothing can be placed
  done += 4;
  look(T0 + 90 * MIN);
  assert.equal(b.view().lines[0], 'pixel · memory 2.0 GB of 3.9 GB (50%) ok · answering 0 min, rest at 20 · 0 answers in the last hour');
  // more than an hour: nothing either
  done += 2;
  look(T0 + 90 * MIN + 2 * HOUR);
  assert.equal(b.view().lines[0], 'pixel · memory 2.0 GB of 3.9 GB (50%) ok · answering 0 min, rest at 20 · 0 answers in the last hour');
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

test('a phone host says its battery and heat: a row, a warning when hot or low and not charging, a line when it ends', () => {
  const { ctx, out } = fakeCtx();
  const b = create(ctx as any);
  const withPower = (at: number, power: unknown) => ({ ...snap(at), host: { name: 'pixel 8', freeMb: 3000, power } });
  b.observe(withPower(T0, { battery: 64, charging: false, hot: false }) as any, null);
  let v = b.view();
  assert.equal(v.stat, 'all within limits');
  assert.deepEqual(v.rows.find((r) => r[0] === 'pixel 8'), ['pixel 8', 'battery 64% · not charging · not hot']);
  assert.doesNotMatch(v.note!, /cannot see battery or heat yet/);
  b.observe(withPower(T0 + MIN, { battery: 12, charging: false, hot: true }) as any, null);
  v = b.view();
  assert.equal(v.stat, '2 warnings');
  assert.ok(v.lines.some((l) => /pixel 8 is hot/.test(l)));
  assert.ok(v.lines.some((l) => /pixel 8 is at 12% and not charging/.test(l)));
  assert.equal(v.gauge, 0);
  b.observe(withPower(T0 + 2 * MIN, { battery: 12, charging: true, hot: false }) as any, null);
  assert.equal(b.view().stat, 'all within limits');
  assert.ok(out.events.some((e) => /pixel 8 cooled down/.test(e)));
  // junk is unknown, never a warning
  b.observe(withPower(T0 + 3 * MIN, { battery: 'low', charging: 1, hot: 'yes' }) as any, null);
  assert.equal(b.view().stat, 'all within limits');
});

// ---------- the phones' own health (12.11.2026): the newest reading of their ledger health lines,
// as the snapshot carries it (godseye-feed.ts healthOf, guard.ts); whether it is signed is trust's word

const H = (o: Record<string, unknown> = {}) => ({ at: T0, tempC: 36.5, battery: 72, charging: null, throttled: false, ...o });
const withHealth = (at: number, health: unknown, o: Record<string, unknown> = {}) =>
  snap(at, { devices: [dev({ health, ...o })], loaded: loaded([ld()]) });
const CARD = (kind: string, id = 'p1') => ({ id: `limits:${kind}:${id}`, kind: 'warn', weight: 3, action: { do: 'open', panel: 'branch', branch: 'limits' } });
const cardsOf = (v: any) => (v.suggestions ?? []).map((c: any) => ({ id: c.id, kind: c.kind, weight: c.weight, action: c.action }));

test('health: hot, throttled and low battery each a warning line and a card; each ends with the reading', () => {
  const { ctx, out } = fakeCtx();
  const b = create(ctx as any);
  b.observe(withHealth(T0, H()) as any, null);
  let v = b.view();
  assert.equal(v.stat, 'all within limits');
  assert.deepEqual(cardsOf(v), []);
  assert.match(v.lines[0], /^pixel · memory .* · health 36\.5 °C, battery 72%, not throttled, not verified \(see trust\)$/);
  assert.match(v.rows.find((r) => r[0] === 'rules')![1], /hot over 42 °C · battery under 20%/);

  // 42 °C exactly is not hot, 20% exactly is not low
  b.observe(withHealth(T0 + MIN, H({ at: T0 + MIN, tempC: 42, battery: 20 })) as any, null);
  assert.equal(b.view().stat, 'all within limits');

  b.observe(withHealth(T0 + 2 * MIN, H({ at: T0 + 2 * MIN, tempC: 44.5, battery: 12, throttled: true })) as any, null);
  v = b.view();
  assert.equal(v.stat, '3 warnings');
  assert.deepEqual(cardsOf(v), [CARD('heat'), CARD('battery'), CARD('throttled')]);
  const [heat, battery, throttled] = v.suggestions!;
  assert.equal(heat.title, 'pixel is hot: 44.5 °C');
  assert.equal(battery.title, 'pixel is at 12% and not charging');
  assert.equal(throttled.title, 'pixel is throttled');
  for (const c of v.suggestions!) { assert.ok(c.why.length > 20 && c.why.length <= 400, c.why); assert.equal(c.label, 'look'); }
  assert.ok(v.lines.some((l) => l === 'warning: pixel is hot: 44.5 °C, above 42 °C'));
  assert.ok(v.lines.some((l) => l === 'warning: pixel is at 12% and not charging'));
  assert.ok(v.lines.some((l) => l === 'warning: pixel is throttled: its phone moved the work to its slow cores'));
  assert.equal(v.gauge, 0);
  assert.deepEqual(out.events.slice(-3), ['limits: pixel is hot: 44.5 °C, above 42 °C', 'limits: pixel is at 12% and not charging', 'limits: pixel is throttled: its phone moved the work to its slow cores']);
  const n = out.events.length;
  b.observe(withHealth(T0 + 2 * MIN + 5000, H({ at: T0 + 2 * MIN, tempC: 44.5, battery: 12, throttled: true })) as any, null);
  assert.equal(out.events.length, n, 'no line on every look');

  // charging, or plugged in on the cable: no battery card; the others stay
  b.observe(withHealth(T0 + 3 * MIN, H({ at: T0 + 3 * MIN, tempC: 44.5, battery: 12, throttled: true, charging: true })) as any, null);
  assert.deepEqual(cardsOf(b.view()).map((c: any) => c.id), ['limits:heat:p1', 'limits:throttled:p1']);
  assert.equal(out.events.at(-1), 'limits: pixel is charging or above 20% again');
  b.observe(withHealth(T0 + 4 * MIN, H({ at: T0 + 4 * MIN, battery: 12 }), { via: 'cable', plugged: true }) as any, null);
  assert.deepEqual(cardsOf(b.view()), []);
  b.observe(withHealth(T0 + 5 * MIN, H({ at: T0 + 5 * MIN, battery: 12 }), { via: 'cable', plugged: null }) as any, null);
  assert.deepEqual(cardsOf(b.view()).map((c: any) => c.id), ['limits:battery:p1'], 'a cable not known to be plugged in is no charger');

  b.observe(withHealth(T0 + 6 * MIN, H({ at: T0 + 6 * MIN })) as any, null);
  v = b.view();
  assert.equal(v.stat, 'all within limits');
  assert.deepEqual(cardsOf(v), []);
  assert.ok(out.events.includes('limits: pixel is no longer hot'));
  assert.ok(out.events.includes('limits: pixel is no longer throttled'));
});

test('health: stale or absent is no card, and the row says health unknown; fresh is -2 min .. +5 min from the look', () => {
  const { ctx, out } = fakeCtx();
  const b = create(ctx as any);
  const hot = (at: number) => H({ at, tempC: 50, battery: 5, throttled: true });
  const look = (health: unknown) => { b.observe(withHealth(T0, health) as any, null); return b.view(); };

  let v = look(hot(T0 - 300_000));
  assert.equal(cardsOf(v).length, 3, 'five minutes old is still fresh');
  v = look(hot(T0 + 120_000));
  assert.equal(cardsOf(v).length, 3, 'two minutes ahead (the phone\'s clock) is still fresh');

  for (const stale of [hot(T0 - 300_001), hot(T0 + 120_001)]) {
    v = look(stale);
    assert.deepEqual(cardsOf(v), []);
    assert.equal(v.stat, 'all within limits');
    assert.match(v.lines[0], / · health unknown$/);
  }
  v = look(null);
  assert.deepEqual(cardsOf(v), []);
  assert.match(v.lines[0], / · health unknown$/);
  // garbage the guard would have caught is no reading either
  v = look({ at: 'now', tempC: 99, battery: 1, throttled: true });
  assert.deepEqual(cardsOf(v), []);
  v = look({ at: T0, tempC: '99', battery: -5, charging: 'no', throttled: 'yes' });
  assert.deepEqual(cardsOf(v), []);
  assert.match(v.lines[0], / · health heat unknown, battery unknown, throttle unknown, not verified \(see trust\)$/);
  // an older snapshot without health says nothing about it
  b.observe(snap(T0, { loaded: loaded([ld()]) }) as any, null);
  assert.doesNotMatch(b.view().lines[0], /health/);
  assert.ok(out.events.length > 0);
});

test('health: card ids are stable from look to look, at most 5 cards, heat before battery before throttle', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx as any);
  const hotDevs = ['a1', 'b2', 'c3'].map((id) => dev({ id, name: `phone ${id}`, health: H({ tempC: 45, battery: 10, throttled: true }) }));
  const s = snap(T0, { devices: hotDevs, loaded: loaded(hotDevs.map((d) => ld({ id: d.id, name: d.name }))) });
  b.observe(s as any, null);
  const first = b.view().suggestions!.map((c) => c.id);
  assert.deepEqual(first, ['limits:heat:a1', 'limits:battery:a1', 'limits:throttled:a1', 'limits:heat:b2', 'limits:battery:b2']);
  assert.equal(b.view().stat, '9 warnings');
  b.observe({ ...s, at: T0 + 5000 } as any, null);
  assert.deepEqual(b.view().suggestions!.map((c) => c.id), first);
  // an id a card id cannot carry as it is: a warning line and still a card (E2), its id made fit by cardId
  const odd = dev({ id: 'p 1/<x>', name: 'odd', health: H({ tempC: 45 }) });
  b.observe(snap(T0, { devices: [odd], loaded: loaded([ld({ id: odd.id, name: 'odd' })]) }) as any, null);
  const oddCards = b.view().suggestions ?? [];
  assert.equal(oddCards.length, 1);
  assert.match(oddCards[0].id, /^limits:heat:[\w.:@/-]+$/);
  assert.ok(b.view().lines.some((l) => l === 'warning: odd is hot: 45 °C, above 42 °C'));
});

test('health: the hints for the deciding branches are the same with and without health cards', () => {
  const run = (health: unknown) => {
    const { ctx } = fakeCtx();
    const b = create(ctx as any);
    let done = 0;
    for (let at = T0; at <= T0 + 21 * MIN; at += 15_000) {
      if ((at - T0) % MIN === 0) done++;
      b.observe(snap(at, { devices: [dev({ health: health === null ? null : { ...(health as object), at } })], loaded: loaded([ld({ busy: true, done })]) }) as any, null);
    }
    return b.view();
  };
  const calm = run(null);
  const hot = run(H({ tempC: 47, battery: 3, throttled: true }));
  assert.equal(cardsOf(calm).length, 0);
  assert.equal(cardsOf(hot).length, 3);
  assert.deepEqual(hot.hints, calm.hints);
  assert.deepEqual(hot.hints, [{ id: 'p1', no: 'should rest (limits)' }]);
});

// ---------- whose word a health reading is (finding A14): limits never checks a signature itself.
// The trust branch verifies every new ledger line of a device and stops at the first bad one; a
// reading is "from its signed ledger" only when trust's report shows that device's identity and
// ledger checks both ok, else it is "not verified (see trust)". The card is raised either way.

/** the trust branch's view as limits peeks at it: one device with its identity and ledger checks */
const trustView = (identity: boolean | null, ledger: boolean | null, id = 'p1') => ({
  trust: {
    built: true, stat: '', gauge: null, rows: [], lines: [],
    report: {
      verdict: 'ok', headline: '', at: T0, host: { name: 'mac', checks: [] },
      devices: [{ id, name: 'pixel', verdict: 'ok', refused: '', accept: false, checks: [
        { k: 'tls', ok: true, text: '' }, { k: 'identity', ok: identity, text: '' }, { k: 'ledger', ok: ledger, text: '' }] }],
    },
  },
});
const SIGNED = /from its signed ledger/;
const UNVERIFIED = /not verified \(see trust\)/;
const HOT = H({ tempC: 44.5, battery: 12, throttled: true });

test('health: trust runs before limits, so limits peeks at the same look\'s trust report', async () => {
  const { BRANCH_IDS } = await import('../src/godseye/types.ts');
  assert.ok(BRANCH_IDS.indexOf('trust') < BRANCH_IDS.indexOf('limits'));
});

test('health: verified by trust (identity and ledger ok) says "from its signed ledger" on every card and the row', () => {
  const { ctx } = fakeCtx(null, trustView(true, true));
  const b = create(ctx as any);
  b.observe(withHealth(T0, HOT) as any, null);
  const v = b.view();
  assert.deepEqual(cardsOf(v), [CARD('heat'), CARD('battery'), CARD('throttled')]);
  for (const c of v.suggestions!) { assert.match(c.why, SIGNED, c.why); assert.doesNotMatch(c.why, UNVERIFIED, c.why); }
  const row = v.lines.find((l) => l.startsWith('pixel · '))!;
  assert.match(row, /health 44\.5 °C, battery 12%, throttled, from its signed ledger$/);
});

test('health: not verified by trust is still a warning and a card, said "not verified (see trust)", never "signed"', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['identity ok, ledger not ok', trustView(true, false)],
    ['identity ok, ledger not checked yet', trustView(true, null)],
    ['ledger ok, identity not ok', trustView(false, true)],
    ['ledger ok, identity not checked', trustView(null, true)],
    ['no trust view', {}],
    ['a trust view without a report', { trust: { built: true, stat: '', gauge: null, rows: [], lines: [] } }],
    ['trust verified another device only', trustView(true, true, 'other')],
    ['a report of the wrong shape', { trust: { built: true, report: { devices: [{ id: 'p1', checks: 'all ok' }] } } }],
  ];
  for (const [what, views] of cases) {
    const { ctx, out } = fakeCtx(null, views);
    const b = create(ctx as any);
    b.observe(withHealth(T0, HOT) as any, null);
    const v = b.view();
    assert.deepEqual(cardsOf(v), [CARD('heat'), CARD('battery'), CARD('throttled')], what);
    assert.equal(v.stat, '3 warnings', what);
    assert.equal(out.events.length, 3, what);
    for (const c of v.suggestions!) {
      assert.match(c.why, UNVERIFIED, `${what}: ${c.why}`);
      assert.doesNotMatch(c.why, /signed/, `${what}: ${c.why}`);
    }
    const row = v.lines.find((l) => l.startsWith('pixel · '))!;
    assert.match(row, /health 44\.5 °C, battery 12%, throttled, not verified \(see trust\)$/, what);
    assert.doesNotMatch(row, /signed/, what);
    assert.doesNotMatch(v.note!, /signed health/, what);
    assert.doesNotMatch(v.what!, /signed health/, what);
  }
});

test('health: no reading needs no verification: a stale reading still says only "health unknown"', () => {
  const { ctx } = fakeCtx(null, trustView(true, true));
  const b = create(ctx as any);
  b.observe(withHealth(T0, H({ at: T0 - 10 * MIN })) as any, null);
  assert.match(b.view().lines[0], / · health unknown$/);
});

test('slow: the why\'s heat part is "from its signed ledger" only when trust verified the device', () => {
  const series = [64, 64, 63, 40, 37, 37];
  const why = (views: Record<string, unknown>, health: Record<string, unknown>) => {
    const v = slowRig(views).run(series, { health });
    const card = v.suggestions!.find((c) => c.id === 'limits:slow:p1');
    assert.ok(card, JSON.stringify(views));
    return card!.why;
  };
  for (const h of [H({ tempC: 44.5 }), H({ throttled: true }), H()]) {
    assert.match(why(trustView(true, true), h), SIGNED);
    for (const views of [trustView(true, false), trustView(false, true), {}]) {
      const w = why(views, h);
      assert.match(w, UNVERIFIED, w);
      assert.doesNotMatch(w, /signed/, w);
    }
  }
  // no reading: nothing to verify, nothing said about it
  const none = slowRig(trustView(true, true)).run(series, {}).suggestions!.find((c) => c.id === 'limits:slow:p1')!.why;
  assert.match(none, /heat unknown/);
  assert.doesNotMatch(none, /signed|not verified/);
});

test('health: the hints are the same whether trust verified the device, did not, or is not there', () => {
  const run = (views: Record<string, unknown>) => {
    const { ctx } = fakeCtx(null, views);
    const b = create(ctx as any);
    let done = 0;
    for (let at = T0; at <= T0 + 21 * MIN; at += 15_000) {
      if ((at - T0) % MIN === 0) done++;
      b.observe(snap(at, { devices: [dev({ health: { ...HOT, at } })], loaded: loaded([ld({ busy: true, done })]) }) as any, null);
    }
    return b.view();
  };
  const verified = run(trustView(true, true));
  const unverified = run(trustView(true, false));
  const none = run({});
  assert.equal(cardsOf(verified).length, 3);
  assert.deepEqual(cardsOf(unverified), cardsOf(verified));
  assert.deepEqual(cardsOf(none), cardsOf(verified));
  assert.deepEqual(unverified.hints, verified.hints);
  assert.deepEqual(none.hints, verified.hints);
  assert.deepEqual(verified.hints, [{ id: 'p1', no: 'should rest (limits)' }]);
});

// ---------- a device that slows down over a load (12.11.2026, field test selcukv1 T25: a Galaxy S25+
// went 64 -> 46.5 -> 37 tok/s within three minutes, warm, while charging)

const SLOW = (id = 'p1') => ({ id: `limits:slow:${id}`, kind: 'warn', weight: 2, action: { do: 'open', panel: 'branch', branch: 'limits' } });
const slowCards = (v: any) => cardsOf(v).filter((c: any) => c.id.startsWith('limits:slow:'));

/** one branch and a look per tps value 15 s apart, each with one more answer done unless the look
 *  says its own done; since and file name the load, health is stamped with the look's own at */
function slowRig(views: Record<string, unknown> = {}) {
  const { ctx, out } = fakeCtx(null, views);
  const b = create(ctx as any);
  let at = T0;
  let done = 0;
  const look = (tps: unknown, o: { since?: number; file?: string; health?: Record<string, unknown> | null; done?: number } = {}) => {
    at += 15_000;
    done = o.done ?? done + 1;
    const health = o.health ? { at, ...o.health } : null;
    const l = loaded([ld({ tps, done })], { since: o.since ?? T0, model: { id: 'm1', name: 'small', file: o.file ?? 'small.gguf', size: 1 } });
    b.observe(snap(at, { devices: [dev(health ? { health } : {})], loaded: l }) as any, null);
    return b.view();
  };
  const run = (list: unknown[], o: Parameters<typeof look>[1] = {}) => { let v = b.view(); for (const t of list) v = look(t, o); return v; };
  /** a look with nothing loaded (work.loaded = null), the device still in the list */
  const unload = () => {
    at += 15_000;
    b.observe(snap(at, { devices: [dev()], loaded: null }) as any, null);
    return b.view();
  };
  return { b, out, look, run, unload };
}

test('slow: 64, 64, 63 then 40, 37, 37 is one card with both numbers, a warning line and one feed line', () => {
  const { out, look, run } = slowRig();
  let v = run([64, 64, 63, 40, 37]);
  assert.deepEqual(slowCards(v), [], 'five readings are not enough');
  v = look(37);
  assert.deepEqual(slowCards(v), [SLOW()]);
  const card = v.suggestions!.find((c) => c.id === 'limits:slow:p1')!;
  assert.equal(card.title, 'pixel slowed down: 64 -> 37 tok/s');
  assert.match(card.why, /64 -> 37 tok\/s since this load began/);
  assert.ok(card.why.length > 20 && card.why.length <= 400, card.why);
  assert.equal(card.label, 'look');
  assert.equal(v.stat, '1 warning');
  assert.equal(v.lines[0], 'warning: pixel slowed down: 64 -> 37 tok/s since this load began');
  assert.deepEqual(out.events, ['limits: pixel slowed down: 64 -> 37 tok/s since this load began']);
  look(37);
  look(36);
  assert.equal(out.events.length, 1, 'no line on every look');
  assert.deepEqual(slowCards(look(37)), [SLOW()]);
});

test('slow: a flat series and one wobbling by 15% either way are no card', () => {
  const flat = slowRig().run([50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);
  assert.deepEqual(slowCards(flat), []);
  assert.equal(flat.stat, 'all within limits');
  const noisy = slowRig().run([50, 57.5, 42.5, 42.5, 57.5, 42.5, 42.5, 57.5, 42.5, 42.5, 42.5]);
  assert.deepEqual(slowCards(noisy), []);
  assert.equal(noisy.stat, 'all within limits');
});

test('slow: fewer than 6 readings are no card, however slow the last ones', () => {
  const { run } = slowRig();
  assert.deepEqual(slowCards(run([64, 64, 63, 20, 20])), []);
});

test('slow: it ends only once the speed is back to 85% of where the load began, with a feed line', () => {
  const { out, look, run } = slowRig();
  assert.deepEqual(slowCards(run([64, 64, 63, 40, 37, 37])), [SLOW()]);
  // 50 is above 70% of 64 but below 85% (54.4): the card stays
  assert.deepEqual(slowCards(run([50, 50])), [SLOW()]);
  assert.deepEqual(slowCards(look(56)), [SLOW()], 'the median of 50, 50, 56 is still 50');
  const v = look(56);
  assert.deepEqual(slowCards(v), []);
  assert.equal(v.stat, 'all within limits');
  assert.deepEqual(out.events, ['limits: pixel slowed down: 64 -> 37 tok/s since this load began', 'limits: pixel is no longer slowed down']);
});

test('slow: a reload, a new since or a new model file, starts over', () => {
  for (const reload of [{ since: T0 + HOUR }, { file: 'other.gguf' }]) {
    const { out, look, run } = slowRig();
    assert.deepEqual(slowCards(run([64, 64, 63, 40, 37, 37])), [SLOW()]);
    let v = look(37, reload);
    assert.deepEqual(slowCards(v), [], JSON.stringify(reload));
    // the device never recovered: a reload is no "no longer slowed down" (review F2)
    assert.ok(!out.events.includes('limits: pixel is no longer slowed down'), out.events.join('\n'));
    // the new load's own first readings are its baseline: steady at 37 is no slowdown
    v = run([37, 37, 37, 37, 37, 37], reload);
    assert.deepEqual(slowCards(v), [], JSON.stringify(reload));
  }
});

// review F2: an unload or a reload drops the slow card without a recovery line; only a real
// recovery (back to 85% of where the load began) says "no longer slowed down"
test('slow: an unload drops the card with no "no longer slowed down" line', () => {
  const { out, run, unload } = slowRig();
  assert.deepEqual(slowCards(run([64, 64, 63, 40, 37, 37])), [SLOW()]);
  const v = unload();
  assert.deepEqual(slowCards(v), []);
  assert.ok(!v.lines.some((l) => l.includes('slowed down')), v.lines.join('\n'));
  assert.deepEqual(out.events, ['limits: pixel slowed down: 64 -> 37 tok/s since this load began']);
});

test('slow: a reload with a new since drops the card with no "no longer slowed down" line', () => {
  const { out, run, look } = slowRig();
  assert.deepEqual(slowCards(run([64, 64, 63, 40, 37, 37])), [SLOW()]);
  const v = look(37, { since: T0 + HOUR });
  assert.deepEqual(slowCards(v), []);
  assert.deepEqual(out.events, ['limits: pixel slowed down: 64 -> 37 tok/s since this load began']);
});

test('slow: a real recovery within the same load still says "no longer slowed down"', () => {
  const { out, run } = slowRig();
  assert.deepEqual(slowCards(run([64, 64, 63, 40, 37, 37])), [SLOW()]);
  assert.deepEqual(slowCards(run([60, 60, 60])), []);
  assert.deepEqual(out.events, ['limits: pixel slowed down: 64 -> 37 tok/s since this load began', 'limits: pixel is no longer slowed down']);
});

test('slow: a null tps is no reading', () => {
  const { run, look } = slowRig();
  assert.deepEqual(slowCards(run([64, 64, 63, null, null, null, 40, 37])), [], 'five readings, the nulls not among them');
  assert.deepEqual(slowCards(look(37)), [SLOW()]);
});

test('slow: the same tps with done unchanged is not a new reading, a changed tps with done 0 is (the phone\'s own snapshot)', () => {
  const { run, look } = slowRig();
  // the phone always sends done: 0; four readings only, the repeated 40s are one
  assert.deepEqual(slowCards(run([64, 63, 64, 40, 40, 40, 40], { done: 0 })), []);
  assert.deepEqual(slowCards(look(37, { done: 0 })), []);
  assert.deepEqual(slowCards(look(40, { done: 0 })), [SLOW()], 'the sixth reading: 64, 63, 64 then 40, 37, 40');
});

test('slow: the why says hot or throttled from the phone\'s fresh health, else heat unknown', () => {
  const series = [64, 64, 63, 40, 37, 37];
  const why = (health: Record<string, unknown> | null) => {
    const v = slowRig().run(series, { health });
    const card = v.suggestions!.find((c) => c.id === 'limits:slow:p1');
    assert.ok(card, JSON.stringify(health));
    return card!.why;
  };
  assert.match(why(H({ tempC: 44.5 })), /\bhot\b/);
  assert.match(why(H({ throttled: true })), /\bthrottled\b/);
  const none = why(null);
  assert.match(none, /heat unknown/);
  assert.doesNotMatch(none, /\bhot\b|\bthrottled\b/);
  assert.match(why(H({ tempC: null })), /heat unknown/);
  // a stale reading (ten minutes old) is no reading, hot or not
  assert.match(why(H({ at: T0 - 10 * MIN, tempC: 50, throttled: true })), /heat unknown/);
  // a fresh reading that is neither hot nor throttled says so with its heat
  assert.match(why(H()), /not hot \(36\.5 °C\)/);
});

test('slow: an id a card id cannot carry as it is gets the line and a card; the card counts toward the cap of 5', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx as any);
  const id = 'p 1/<x>';
  let at = T0;
  for (const [i, tps] of [64, 64, 63, 40, 37, 37].entries()) {
    at += 15_000;
    b.observe(snap(at, { devices: [dev({ id, name: 'odd' })], loaded: loaded([ld({ id, name: 'odd', tps, done: i + 1 })]) }) as any, null);
  }
  const oddSlow = b.view().suggestions ?? [];
  assert.equal(oddSlow.length, 1);
  assert.match(oddSlow[0].id, /^limits:slow:[\w.:@/-]+$/);
  assert.ok(b.view().lines.includes('warning: odd slowed down: 64 -> 37 tok/s since this load began'), b.view().lines.join('\n'));

  // two phones hot, low and throttled (six health cards) and slow: five cards, the health ones first
  const { ctx: ctx2 } = fakeCtx();
  const b2 = create(ctx2 as any);
  at = T0;
  for (const [i, tps] of [64, 64, 63, 40, 37, 37].entries()) {
    at += 15_000;
    const devs = ['a1', 'b2'].map((x) => dev({ id: x, name: `phone ${x}`, health: H({ at, tempC: 45, battery: 10, throttled: true }) }));
    b2.observe(snap(at, { devices: devs, loaded: loaded(devs.map((d) => ld({ id: d.id, name: d.name, tps, done: i + 1 }))) }) as any, null);
  }
  const v = b2.view();
  assert.deepEqual(v.suggestions!.map((c) => c.id), ['limits:heat:a1', 'limits:battery:a1', 'limits:throttled:a1', 'limits:heat:b2', 'limits:battery:b2']);
  assert.ok(v.lines.includes('warning: phone a1 slowed down: 64 -> 37 tok/s since this load began'));
  assert.ok(v.lines.includes('warning: phone b2 slowed down: 64 -> 37 tok/s since this load began'));
});

test('slow: the hints for the deciding branches are the same with and without the slow card', () => {
  const run = (slow: boolean) => {
    const { ctx } = fakeCtx();
    const b = create(ctx as any);
    let done = 0;
    let i = 0;
    for (let at = T0; at <= T0 + 21 * MIN; at += 15_000, i++) {
      done++;
      const tps = slow && i >= 3 ? 37 : 64;
      b.observe(snap(at, { loaded: loaded([ld({ busy: true, done, tps })]) }) as any, null);
    }
    return b.view();
  };
  const steady = run(false);
  const slowed = run(true);
  assert.deepEqual(slowCards(steady), []);
  assert.deepEqual(slowCards(slowed), [SLOW()]);
  assert.deepEqual(slowed.hints, steady.hints);
  assert.deepEqual(slowed.hints, [{ id: 'p1', no: 'should rest (limits)' }]);
});

test('a device id with a space still gets its hot card and its slow card (E2)', async () => {
  const { cleanCard } = await import('../src/godseye/index.ts');
  // the exact id for an odd device id is decide.ts's cardId; only its shape is asserted here
  const id = 'tab 2';
  const { ctx } = fakeCtx();
  const b = create(ctx as any);
  b.observe(snap(T0, { devices: [dev({ id, health: H({ tempC: 44.5 }) })], loaded: loaded([ld({ id })]) }) as any, null);
  const hot = (b.view().suggestions ?? []).filter((c: any) => c.id.startsWith('limits:heat:'));
  assert.equal(hot.length, 1);
  assert.ok(cleanCard(hot[0]), 'the eye keeps the hot card');

  const s = fakeCtx();
  const sb = create(s.ctx as any);
  let at = T0, done = 0;
  for (const tps of [64, 64, 63, 40, 37, 37]) {
    at += 15_000;
    sb.observe(snap(at, { devices: [dev({ id })], loaded: loaded([ld({ id, tps, done: ++done })]) }) as any, null);
  }
  const slow = (sb.view().suggestions ?? []).filter((c: any) => c.id.startsWith('limits:slow:'));
  assert.equal(slow.length, 1);
  assert.ok(cleanCard(slow[0]), 'the eye keeps the slow card');
});

// ---- a split's parts on other devices (F4, 13.11.2026): kula's engine opens a split with no peers,
// so the phones holding layers are only in loaded.parts. Every token runs through every part: the
// host's busy is each part's busy for rest, energy and the night window; slow stays host-only.
const HOST = (o: Record<string, unknown> = {}) => ({ id: 'local', name: 'mac', local: true, busy: true, tps: 6, done: 3, ...o });
const PARTS = [{ id: 'local', name: 'this computer', local: true, mb: 4000, layers: 16 }, { id: 'p1', name: 'pixel', local: false, mb: 3000, layers: 16 }];
const splitOf = (o: Record<string, unknown> = {}, parts: any[] = PARTS) => loaded([HOST(o)], { mode: 'split', parts });

/** 10 s looks for 25 busy minutes; p1 says a fresh health line on every look */
function busySplit(b: any, extra: (at: number) => Record<string, unknown> = () => ({})) {
  let at = T0;
  for (let i = 0; i <= 25 * 6; i++, at += 10_000) {
    b.observe(snap(at, { devices: [dev({ health: H({ at }) })], loaded: splitOf(), ...extra(at) }) as any, null);
  }
  return at - 10_000;
}

test('split: a phone holding layers for 25 busy minutes should rest like the host; one feed line for it', () => {
  const { ctx, out } = fakeCtx();
  const b = create(ctx as any);
  busySplit(b);
  const v = b.view();
  const hints = (v.hints ?? []).map((h: any) => h.id).sort();
  assert.deepEqual(hints, ['local', 'p1']);
  assert.ok(v.lines.includes('warning: pixel should rest: working in the split for 25 min without a break'), v.lines.join('\n'));
  assert.ok(v.lines.includes('warning: mac should rest: answering for 25 min without a break'), 'the host as today');
  assert.equal(out.events.filter((e) => /^limits: pixel should rest/u.test(e)).length, 1);
});

test('split: energy counts the host at 15 W and the phone part at 3 W; the part gets its own row', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx as any);
  busySplit(b);
  const v = b.view();
  // by hand: 150 counted steps of 10 s = 1500 s busy each. host 15 W x 1500 s / 3600 = 6.25 Wh,
  // the phone 3 W x 1500 s / 3600 = 1.25 Wh, the day 7.5 Wh
  const hostWh = (15 * 1500) / 3600;
  const phoneWh = (3 * 1500) / 3600;
  assert.equal(hostWh, 6.25);
  assert.equal(phoneWh, 1.25);
  const row = (k: string) => v.rows.find((r: any) => r[0] === k)?.[1];
  assert.equal(row('energy today'), `${hostWh + phoneWh} Wh (a guess)`);
  const p1 = v.lines.find((l: string) => /^pixel \u{b7} memory/u.test(l));
  assert.ok(p1, v.lines.join('\n'));
  const [name, mem, run, wh, health] = p1!.split(' \u{b7} ');
  assert.equal(name, 'pixel');
  assert.equal(mem, 'memory 2.9 GB of 3.9 GB (75%) ok');
  assert.equal(run, 'in the split 25 min, rest at 20');
  assert.ok(Math.abs(Number(/^([\d.]+) Wh today$/u.exec(wh)![1]) - phoneWh) <= 0.051, wh);
  assert.match(health, /^health 36\.5 \u{b0}C, battery 72%, not throttled, not verified \(see trust\)$/u);
  assert.ok(!/answer/u.test(p1!), 'a part says no answers of its own');
  const mac = v.lines.find((l: string) => /^mac \(this computer\)/u.test(l))!;
  assert.ok(Math.abs(Number(/ ([\d.]+) Wh today/u.exec(mac)![1]) - hostWh) <= 0.051, mac);
});

test('split: the night window catches a part still working past the end', () => {
  const { ctx, out } = fakeCtx();
  const b = create(ctx as any);
  const proj = { id: 'n1', title: 'summaries', request: 'x', start: T0 - 60 * MIN, end: T0, state: 'running', mode: 'split', model: 'm1', peers: ['p1'] };
  b.observe(snap(T0 + 10 * MIN, { loaded: splitOf(), projects: [proj] }) as any, null);
  const v = b.view();
  assert.ok(v.lines.some((x: string) => /^warning: pixel still working after the night window of "summaries"/u.test(x)), v.lines.join('\n'));
  assert.ok(out.events.some((e) => /^limits: pixel still working after the night window/u.test(e)));
  // an idle split: no window warning for the part
  const q = fakeCtx();
  const qb = create(q.ctx as any);
  qb.observe(snap(T0 + 10 * MIN, { loaded: splitOf({ busy: false }), projects: [proj] }) as any, null);
  assert.ok(!qb.view().lines.some((x: string) => /still working/u.test(x)));
});

test('split: slow is host-only, a part never gets a slow warning', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx as any);
  let at = T0, done = 0;
  for (const tps of [64, 64, 63, 40, 37, 37]) {
    at += 15_000;
    done++;
    const parts = [PARTS[0], { ...PARTS[1], tps }];
    b.observe(snap(at, { loaded: loaded([HOST({ tps: 6, done })], { mode: 'split', parts }) }) as any, null);
  }
  const v = b.view();
  assert.ok(!v.lines.some((l: string) => /slowed down/u.test(l)), v.lines.join('\n'));
  assert.ok(!(v.suggestions ?? []).some((c: any) => c.id.startsWith('limits:slow:')));
});

test('split: parts that are also devices of the load are counted once', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx as any);
  const parts = [{ id: 'p1', name: 'pixel', local: false, mb: 3000, layers: 10 }, { id: 'here', name: 'mac', local: true, mb: 9000, layers: 14 }];
  const l = loaded([ld({ busy: true }), ld({ id: 'here', name: 'mac', local: true, busy: true })], { mode: 'split', parts });
  for (let i = 0; i <= 12; i++) b.observe(snap(T0 + i * 10_000, { loaded: l }) as any, null);
  const v = b.view();
  // 12 counted steps of 10 s: (3 W + 15 W) x 120 s / 3600 = 0.6 Wh; busy 2 x 2 min
  assert.equal(v.rows.find((r: any) => r[0] === 'energy today')![1], '0.6 Wh (a guess)');
  assert.equal(v.rows.find((r: any) => r[0] === 'busy today')![1], '4 min');
  assert.equal(v.lines.filter((x: string) => /^pixel \u{b7}/u.test(x)).length, 1, 'one row for pixel');
});

test('F5: two phones of one name each show their own memory; two tight ones give two warnings and two feed lines', () => {
  const two = (ram1: number, ram2: number) => snap(T0, {
    devices: [dev({ id: 'p1', name: 'Galaxy S25', ramMb: ram1 }), dev({ id: 'p2', name: 'Galaxy S25', ramMb: ram2 })],
    loaded: loaded([ld({ id: 'p1', name: 'Galaxy S25' }), ld({ id: 'p2', name: 'Galaxy S25' })], { mode: 'apart' }),
    needMb: 1500,
  });
  const a = fakeCtx();
  const b = create(a.ctx as any);
  b.observe(two(8000, 1600) as any, null);
  const rows = b.view().lines.filter((l: string) => l.startsWith('Galaxy S25 \u{b7} memory'));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /\(19%\) ok/u);
  assert.match(rows[1], /\(94%\) tight/u, 'p2 (1500 of 1600 MB) reads tight in its own row');

  const c = fakeCtx();
  const cb = create(c.ctx as any);
  cb.observe(two(1700, 1600) as any, null);
  const warns = cb.view().lines.filter((l: string) => l.startsWith('warning: Galaxy S25'));
  assert.equal(warns.length, 2, warns.join('\n'));
  assert.equal(c.out.events.filter((e) => /^limits: Galaxy S25: .* tight$/u.test(e)).length, 2);
});
