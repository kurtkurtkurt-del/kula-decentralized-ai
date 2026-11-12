// god's eye, branch 3 forecast: tonight's guess per device from a decayed beta-binomial over the
// hours of the week, tok/s as a weighted average, notes saved at most once a minute and read back,
// a feed line only when a firm guess flips. The expected numbers are worked out by hand.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { create, slotOf, fold, decay, prior, estimate, wilson, tonightSlots, dayOf } = await import('../src/godseye/branches/forecast.ts');
const { GodsEye } = await import('../src/godseye/index.ts');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-forecast-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  // checkedAt null: the probe's time is not given, so every look counts (a number far from the look's at is stale)
  checkedAt: null, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
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
/** the top of `hour` on `day` (day 0 = sunday 8 nov 2026); the date rolls over past midnight */
const hourAt = (day: number, hour: number) => new Date(2026, 10, 8 + day, hour, 0, 0).getTime();
/** 12 looks, 5 s apart, from the top of the hour: enough for that hour to fold */
function hourLooks(b: any, devices: any[], day: number, hour: number) {
  const t = hourAt(day, hour);
  for (let i = 0; i < 12; i++) b.observe(snap(devices, t + i * 5000), null);
}

// ---- the pure maths, against numbers worked out by hand

test('slotOf: the hour of the week from the local clock', () => {
  assert.equal(slotOf(new Date(2026, 10, 8, 23, 0).getTime()), 23);    // sunday 23:00
  assert.equal(slotOf(new Date(2026, 10, 9, 6, 30).getTime()), 30);    // monday 06:30
  assert.equal(slotOf(new Date(2026, 10, 14, 22, 0).getTime()), 166);  // saturday 22:00
});

test('fold: one observation of weight 1, and after exactly 4 weeks n and s halve before the +1', () => {
  const WEEK = 7 * 24 * 3600 * 1000;
  const at = new Date(2026, 10, 8, 23).getTime();
  assert.deepEqual(fold({ n: 0, s: 0, t: 0 }, 1, at), { n: 1, s: 1, t: at });     // a fresh slot: its whole past decays away
  assert.deepEqual(fold({ n: 2, s: 2, t: WEEK }, 1, 5 * WEEK), { n: 2, s: 2, t: 5 * WEEK });  // d = 0.5 ** (4/4) = 0.5
  assert.deepEqual(fold({ n: 2, s: 2, t: 10 * WEEK }, 1, 9 * WEEK), { n: 3, s: 3, t: 9 * WEEK }); // clock backwards: no decay, just +1
});

test('decay: n and s fade to the look\'s time, never negatively, t is not written', () => {
  const WEEK = 7 * 24 * 3600 * 1000;
  assert.deepEqual(decay({ n: 2, s: 2, t: WEEK }, 5 * WEEK), { n: 1, s: 1, t: WEEK });          // 4 weeks later: d = 0.5, halves
  assert.deepEqual(decay({ n: 2, s: 2, t: 10 * WEEK }, 9 * WEEK), { n: 2, s: 2, t: 10 * WEEK }); // clock backwards: no decay
  assert.deepEqual(decay({ n: 4, s: 4, t: 0 }, 4 * WEEK), { n: 2, s: 2, t: 0 });                 // dt = 4 weeks, t stays
});

test('prior: the device\'s own rate and its four pseudo-observations', () => {
  // N = 1 + 2 = 3, S = 1 + 0 = 1; p0 = (1 + 0.5) / (3 + 1) = 0.375; a = 4 * 0.375, b = 4 - a
  assert.deepEqual(prior([{ n: 1, s: 1, t: 0 }, { n: 2, s: 0, t: 0 }]), { N: 3, S: 1, p0: 0.375, a: 1.5, b: 2.5 });
  assert.equal(prior([]).p0, 0.5);    // no slots at all: an even prior
});

test('wilson: the 80% interval by hand, clamped to 0..1', () => {
  // z = 2, p = 0, m = 4: centre = (0 + 4/8) / (1 + 4/4) = 0.25, half = 2*sqrt(0 + 4/64) / 2 = 0.25, lo clamps to 0
  assert.deepEqual(wilson(0, 4, 2), { lo: 0, hi: 0.5 });
  // z = 2, p = 1, m = 4: centre = 0.75, half = 0.25, hi clamps to 1
  assert.deepEqual(wilson(1, 4, 2), { lo: 0.5, hi: 1 });
  // z = 1.2816, p = 0.5, m = 100: symmetric around 0.5, half = 0.0635601...
  const s = wilson(0.5, 100, 1.2816);
  assert.ok(Math.abs(s.lo + s.hi - 1) < 1e-9, 'symmetric');
  assert.ok(Math.abs(s.lo - 0.43644) < 1e-4, `lo ${s.lo}`);
  assert.ok(Math.abs(s.hi - 0.56356) < 1e-4, `hi ${s.hi}`);
});

test('estimate: the beta-binomial mean and its 80% interval', () => {
  // a = 2, one look there in the slot, k = 4: mean = (2 + 1) / (4 + 1) = 0.6 exactly;
  // m = 5, z = 1.2816: centre = 0.5752729..., half = 0.2448602..., lo = 0.33041, hi = 0.82013
  const e = estimate(2, 1, 1, 4);
  assert.equal(e.mean, 0.6);
  assert.ok(Math.abs(e.lo - 0.3304) < 1e-4, `lo ${e.lo}`);
  assert.ok(Math.abs(e.hi - 0.8201) < 1e-4, `hi ${e.hi}`);
});

test('tonightSlots: the nine slots of the night that starts on that day', () => {
  const sunNight = [22, 23, 24, 25, 26, 27, 28, 29, 30];
  assert.deepEqual(tonightSlots(new Date(2026, 10, 8, 23).getTime()), sunNight);   // sunday evening
  assert.deepEqual(tonightSlots(new Date(2026, 10, 9, 3).getTime()), sunNight);    // after midnight: the night already running
  assert.deepEqual(tonightSlots(new Date(2026, 10, 9, 7).getTime()), [46, 47, 48, 49, 50, 51, 52, 53, 54]); // monday 07:00: a fresh night
  assert.deepEqual(tonightSlots(new Date(2026, 10, 14, 10).getTime()), [166, 167, 0, 1, 2, 3, 4, 5, 6]); // saturday wraps into sunday
});

test('dayOf: the local calendar day as a whole number, whatever the hour', () => {
  const d = (day: number, hour: number) => new Date(2026, 10, 8 + day, hour, 0, 0).getTime();
  assert.equal(dayOf(d(0, 9)), dayOf(d(0, 23)), 'same date, any hour');
  assert.equal(dayOf(d(1, 0)) - dayOf(d(0, 23)), 1, 'across midnight is one day');
  assert.equal(dayOf(d(2, 11)) - dayOf(d(0, 23)), 2, '1.5 days later is two calendar days');
  assert.equal(dayOf(d(0, 9)) - dayOf(d(2, 11)), -2, 'backwards is a negative difference; the caller clamps');
});

// ---- the branch

test('with no history it is built and says it is still learning', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  b.observe(snap([dev()], at23(0)), null);
  const v = b.view();
  assert.equal(v.built, true);
  assert.equal(v.stat, 'still learning: 0 recent hours so far');
  assert.equal(v.gauge, 0);
  assert.equal(v.lines[0], 'pixel · tonight 22–07: not enough recent hours yet (0 of 3)');
  assert.equal(v.rows[0][1], '1');
});

test('an empty snapshot: no devices, no guess', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  b.observe(snap([], at23(0)), null);
  const v = b.view();
  assert.equal(v.stat, 'still learning: 0 recent hours so far');
  assert.equal(v.gauge, 0);
  assert.deepEqual(v.lines, []);
  assert.equal(v.note, 'no device seen yet.');
});

test('up all evening for three nights: likely, and the interval narrows as nights are added', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const newOne = dev({ id: 'p4', name: 'new one', reachable: null });
  const late = dev({ id: 'p5', name: 'late' });
  const night = (day: number, from: number, to: number) => {
    for (let h = from; h <= to; h++) hourLooks(b, [dev(), newOne], day, 22 + h);
  };
  night(0, 0, 5);                                   // sunday 22:00 .. monday 02:55
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: likely 93% (64–99%)');
  assert.equal(b.view().gauge, Math.round((5 / 168) * 100));   // slots 22..26 of the week seen
  assert.equal(b.view().stat, '1 device · tonight 1 likely');
  night(0, 6, 8);                                   // monday 04:00 .. 06:55
  night(1, 0, 5);                                   // monday 22:00 .. tuesday 02:55
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: likely 97% (69–100%)');
  night(1, 6, 8);
  for (let h = 0; h <= 4; h++) hourLooks(b, [dev(), newOne], 2, 22 + h);         // tuesday 22:00 .. wednesday 01:55
  hourLooks(b, [dev(), late, newOne], 2, 27);                                    // late joins: wednesday 03:00
  const v = b.view();
  assert.equal(v.lines[0], 'pixel · tonight 22–07: likely 98% (71–100%)');       // 97%'s interval is wider than 98%'s
  assert.equal(v.lines[1], 'late · tonight 22–07: not enough recent hours yet (0 of 3)');
  assert.ok(!v.lines.some((l) => l.startsWith('new one')), 'a device not looked at yet says nothing');
  assert.equal(v.stat, '2 devices · tonight 1 likely');
  assert.equal(v.rows[1][1], '23 of 168');          // three nights: 9 + 9 + 5 slots seen (late's one is among them)
  assert.equal(c.feed.length, 0, 'staying likely is not news');
});

test('a device never there is unlikely, and a cable phone that is not plugged in is not there', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const gone = dev({ id: 'p2', name: 'galaxy', reachable: false, reason: 'no answer' });
  const loose = dev({ id: 'p3', name: 'cable phone', via: 'cable', plugged: false });
  for (let h = 0; h < 6; h++) hourLooks(b, [gone, loose], 0, 22 + h);   // sunday 22:00 .. monday 02:55
  const v = b.view();
  // both fold 5 hours of x = 0: p0 = 0.5 / 6 = 0.0833, a = 0.3333; mean = 0.0741 -> 7%, lo 1%, hi 36%
  assert.equal(v.lines[0], 'cable phone · tonight 22–07: unlikely 7% (1–36%)');   // same guess: sorted by name
  assert.equal(v.lines[1], 'galaxy · tonight 22–07: unlikely 7% (1–36%)');
  assert.equal(c.feed.length, 0, 'the first guess is not news');
});

test('a weekday-only device: likely on a monday, unlikely on a saturday', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  const away = dev({ reachable: false, reason: 'off' });
  const driveWeekday = (d: number) => {
    for (let h = 8; h <= 21; h++) hourLooks(b, [away], d, h);    // day hours: looked at, not there (14 slots)
    for (let h = 22; h <= 30; h++) hourLooks(b, [dev()], d, h);  // 22:00 .. next day 06:00: there (9 slots)
    if (d % 7 === 5) b.observe(snap([away], hourAt(d + 1, 7)), null); // folds the friday-night tail at the same time weekly
  };
  for (const d of [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 15, 16, 17, 18, 19]) driveWeekday(d);   // three weeks
  b.observe(snap([dev()], hourAt(22, 7) + 55 * 60_000), null);   // monday 30 nov, 07:55: its own night has 3 weeks of data
  // the folds are ~6 days old by now, so tonight is read with n and s decayed to the look's time
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: likely 61% (36–81%)');
  for (const d of [22, 23, 24, 25, 26]) driveWeekday(d);          // a fourth week
  b.observe(snap([dev()], hourAt(27, 7) + 55 * 60_000), null);    // saturday 5 dec, 07:55: the night slots were never seen
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: unlikely 39% (16–69%), from daytime only');
});

test('eleven looks in an hour are dropped, twelve are folded', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const t = hourAt(0, 22);
  for (let i = 0; i < 11; i++) b.observe(snap([dev()], t + i * 5000), null);   // 11 looks in slot 22
  hourLooks(b, [dev()], 0, 23);                                                // 12 looks in slot 23
  b.observe(snap([dev()], hourAt(0, 24)), null);                               // its first look folds slot 23
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (1 of 3)');
  for (let i = 1; i < 12; i++) b.observe(snap([dev()], hourAt(0, 24) + i * 5000), null);
  c.t += 61_000;
  b.observe(snap([dev()], hourAt(0, 24) + 55_000), null);                      // and this one saves
  const saved = c.stored as any;
  assert.ok(!('22' in saved.dev.p1.slots), 'eleven looks are dropped');
  assert.deepEqual(saved.dev.p1.slots['23'].slice(0, 2), [1, 1], 'twelve looks fold into the slot');
});

test('a stale probe is not a look: 3 h of 5 s looks with a fixed checkedAt fold no slot; a fresh (or no) checkedAt still folds', () => {
  const start = hourAt(0, 21);
  const run = (checked: (at: number) => unknown) => {
    const { c, ctx } = fakeCtx();
    const b = create(ctx);
    for (let at = start; at < start + 3 * 3600_000; at += 5000) b.observe(snap([dev({ checkedAt: checked(at) })], at), null);
    c.t += 61_000;
    b.observe(snap([dev({ checkedAt: checked(start + 3 * 3600_000) })], start + 3 * 3600_000), null);   // and this one saves
    return Object.keys((c.stored as any)?.dev?.p1?.slots ?? {}).sort();
  };
  // the page was closed: the 21:00 probe is carried along unchanged, it must not teach "there tonight"
  assert.deepEqual(run(() => start), []);
  // a probe stamped far in the future is no better
  assert.deepEqual(run((at) => at + 121_000), []);
  // fresh probes (within 120 s either way), and a missing checkedAt (today's behaviour), fold 21:00..23:00
  assert.deepEqual(run((at) => at), ['21', '22', '23']);
  assert.deepEqual(run((at) => at - 120_000), ['21', '22', '23']);
  assert.deepEqual(run((at) => at + 120_000), ['21', '22', '23']);
  assert.deepEqual(run(() => null), ['21', '22', '23']);
  assert.deepEqual(run(() => undefined), ['21', '22', '23']);
});

test('a feed line when the firm guess flips, with the interval, not on every look', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const gone = dev({ reachable: false, reason: 'gone' });
  hourLooks(b, [dev()], 0, 22);         // up: sunday 22:00
  hourLooks(b, [dev()], 0, 23);
  hourLooks(b, [dev()], 0, 24);         // monday 00:00: 3 folds of x = 1
  assert.equal(c.feed.length, 0, 'the first firm guess is not news');
  for (let h = 25; h <= 29; h++) hourLooks(b, [gone], 0, h);   // monday 01:00 .. 05:55, gone
  hourLooks(b, [gone], 0, 30);          // monday 06:00: the fifth fold of x = 0 flips it
  assert.equal(c.feed.length, 1);
  // N = 8, S = 3: p0 = 3.5/9, mean = 0.3864, lo = 0.1722, hi = 0.6579
  assert.equal(c.feed[0], 'forecast: pixel is now unlikely tonight 22–07 (39%, 17–66%)');
});

test('a re-folded slot: the decayed N is shown with one decimal, whole numbers plain', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  hourLooks(b, [dev()], 1, 20);                          // monday nov 9, 20:00
  hourLooks(b, [dev()], 1, 21);                          // its first look folds slot 44
  b.observe(snap([dev()], hourAt(1, 22)), null);         // folds slot 45: N = 2
  hourLooks(b, [dev()], 8, 20);                          // monday nov 16, 20:00
  hourLooks(b, [dev()], 8, 21);                          // its first look re-folds slot 44, one week later
  // slot 44: n = 1 * 0.5 ** (1/4) + 1 = 1.8409, fresh; slot 45: 1, ~6.96 days old, d = 0.8418
  // N = 1.8409 + 0.8418 = 2.68: shown as 2.7, not the raw sum
  const v = b.view();
  assert.equal(v.lines[0], 'pixel · tonight 22–07: not enough recent hours yet (2.7 of 3)');
  assert.equal(v.stat, 'still learning: 2.7 recent hours so far');
});

test('the feed line uses the checked name: a non-string name falls back to the id, a long one is cut', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const p2 = dev({ id: 'p2', name: 42 });
  const p3 = dev({ id: 'p3', name: 'n'.repeat(250) });
  const gone2 = dev({ id: 'p2', name: 42, reachable: false, reason: 'gone' });
  const gone3 = dev({ id: 'p3', name: 'n'.repeat(250), reachable: false, reason: 'gone' });
  hourLooks(b, [p2, p3], 0, 22);
  hourLooks(b, [p2, p3], 0, 23);
  hourLooks(b, [p2, p3], 0, 24);
  assert.equal(c.feed.length, 0, 'the first firm guess is not news');
  for (let h = 25; h <= 29; h++) hourLooks(b, [gone2, gone3], 0, h);
  hourLooks(b, [gone2, gone3], 0, 30);                   // the fifth fold of x = 0 flips both
  assert.equal(c.feed.length, 2);
  assert.equal(c.feed[0], 'forecast: p2 is now unlikely tonight 22–07 (39%, 17–66%)');
  assert.equal(c.feed[1], 'forecast: ' + 'n'.repeat(80) + ' is now unlikely tonight 22–07 (39%, 17–66%)');
});

test('a device absent from the snapshot for nine weeks: the estimate decays when read, the interval widens', () => {
  const t0 = hourAt(0, 23);
  const slots: any = {};
  for (let k = 22; k <= 41; k++) slots[String(k)] = [1, 1, t0];   // 20 hours up one sunday night, all folded at t0
  const { ctx } = fakeCtx({ v: 2, looks: 100, since: t0, lastGood: t0, dev: { p1: { name: 'pixel', seen: t0, slots, cur: null, tps: {} } } });
  const b = create(ctx);
  b.observe(snap([dev()], t0 + 5000), null);
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: likely 98% (73–100%)');   // fresh: N = 20, m = 5
  for (let w = 1; w <= 8; w++) b.observe(snap([], hourAt(7 * w, 23)), null);        // the eye keeps looking, the device is gone
  b.observe(snap([dev()], hourAt(63, 23)), null);                                   // nine weeks later, back
  // every slot: d = 0.5 ** (9/4) = 0.2102241; N = 20 * d = 4.2045, p0 = 4.7045/5.2045 = 0.903929,
  // a = 3.615716; slot mean = (3.615716 + 0.2102241) / 4.2102241 = 0.908726 -> 91%, m = 4.21:
  // lo = 0.6031 -> 60%, hi = 0.9849 -> 98%. The interval widened from 27 points to 38.
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: likely 91% (60–98%)');
});

test('daytime hours only: the guess stands, but the line says it is from daytime only', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  hourLooks(b, [dev()], 1, 10);                          // monday 10:00
  hourLooks(b, [dev()], 1, 11);
  hourLooks(b, [dev()], 1, 12);
  b.observe(snap([dev()], hourAt(1, 13)), null);         // folds slot 36: three folded hours
  // tonight's nine slots were never seen: mean = p0 = (N + 0.5) / (N + 1) with N = 2.9969, shown
  // as 3.0 so the three hours are known: 0.8749 -> 87%; wilson: lo 0.5566 -> 56%, hi 0.9750 -> 97%
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: likely 87% (56–97%), from daytime only');
});

test('a value just under the threshold: "(2.9 of 3)", not enough', () => {
  const t = hourAt(1, 13);
  const { ctx } = fakeCtx({ v: 2, looks: 3, since: t, lastGood: t, dev: { p1: { name: 'pixel', seen: t, slots: { '34': [1, 1, t], '35': [1, 1, t - 3600_000], '36': [1, 1, t - 3 * 86400_000] }, cur: null, tps: {} } } });
  const b = create(ctx);
  b.observe(snap([dev()], t), null);
  // N = 1 + 0.5 ** (1/672) + 0.5 ** (3/28) = 1 + 0.99897 + 0.92837 = 2.9273, shown as 2.9: not enough
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (2.9 of 3)');
  assert.equal(b.view().stat, 'still learning: 2.9 recent hours so far');
});

test('no line says "not enough" with "(3 of 3)": the threshold compares the value as shown', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  hourLooks(b, [dev()], 1, 10);                          // three fresh hours: shown as 3, known
  hourLooks(b, [dev()], 1, 11);
  hourLooks(b, [dev()], 1, 12);
  b.observe(snap([dev()], hourAt(1, 13)), null);
  assert.ok(!b.view().lines[0].includes('not enough'), 'three fresh hours are known');
  const t = hourAt(1, 13);
  const { ctx: ctx2 } = fakeCtx({ v: 2, looks: 3, since: t, lastGood: t, dev: { p1: { name: 'pixel', seen: t, slots: { '34': [1, 1, t], '35': [1, 1, t - 3600_000], '36': [1, 1, t - 3 * 86400_000] }, cur: null, tps: {} } } });
  const b2 = create(ctx2);
  b2.observe(snap([dev()], t), null);
  for (const l of [...b.view().lines, ...b2.view().lines]) {
    if (l.includes('not enough')) {
      const m = l.match(/\((\d+(\.\d)?) of 3\)/)!;
      assert.ok(Number(m[1]) < 3, `the shown value is below the threshold: ${l}`);
      assert.notEqual(m[1], '3', `"3 of 3" never says not enough: ${l}`);
    }
  }
});

test('a decayed N just under one hour: "1 recent hour", not "1.0 hours"', () => {
  const t = hourAt(1, 13);
  const { ctx } = fakeCtx({ v: 2, looks: 1, since: t, lastGood: t, dev: { p1: { name: 'pixel', seen: t, slots: { '46': [0.96, 0.96, t] }, cur: null, tps: {} } } });
  const b = create(ctx);
  b.observe(snap([dev()], t), null);
  const v = b.view();
  assert.equal(v.stat, 'still learning: 1 recent hour so far');
  assert.equal(v.lines[0], 'pixel · tonight 22–07: not enough recent hours yet (1 of 3)');
});

test('a device gone from the snapshot: not counted in the stat, listed after with "last seen"', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  const gone = dev({ id: 'p2', name: 'galaxy', reachable: false, reason: 'no answer' });
  for (let h = 0; h < 6; h++) hourLooks(b, [dev()], 0, 22 + h);    // pixel, sunday night
  for (let h = 0; h < 6; h++) hourLooks(b, [gone], 1, 22 + h);     // galaxy, monday night; pixel gone from the snapshot
  const v = b.view();
  assert.equal(v.stat, '1 device · tonight 0 likely');             // only galaxy counts
  assert.equal(v.lines[0], 'galaxy · tonight 22–07: unlikely 7% (1–36%)');
  // pixel's data is a day old: p0 = 0.9148 -> 91%, wilson: lo 0.6010 -> 60%, hi 0.9871 -> 99%
  assert.equal(v.lines[1], 'pixel · tonight 22–07: likely 91% (60–99%), from daytime only · last seen yesterday');
});

/** notes of a device that is not in the snapshot any more: three folded hours, N = 3, a firm guess.
 *  Slots 46..48 are not part of a sunday night, so tonight stands on the prior alone:
 *  p0 = 3.5 / 4 = 0.875, each of the nine slots means 0.875 -> 88%; wilson m = 4:
 *  lo = 0.556664 -> 56%, hi = 0.975012 -> 98%, and the line says "from daytime only". */
const goneNotes = (t: number) => ({ v: 2, looks: 9, since: t, lastGood: t, dev: { p1: { name: 'pixel', seen: t, slots: { '46': [1, 1, t], '47': [1, 1, t], '48': [1, 1, t] }, cur: null, tps: {} } } });
const GONE_LINE = 'pixel · tonight 22–07: likely 88% (56–98%), from daytime only';

test('no present device known but a gone one has a guess: the stat says no known device here now (empty snapshot)', () => {
  const t0 = hourAt(0, 23);
  const b = create(fakeCtx(goneNotes(t0)).ctx);
  b.observe(snap([], t0), null);
  const v = b.view();
  assert.equal(v.stat, 'no known device here now');
  assert.deepEqual(v.lines, [GONE_LINE + ' · last seen today']);
});

test('no present device known but a gone one has a guess: the stat says no known device here now (only a new device present)', () => {
  const t0 = hourAt(0, 23);
  const b = create(fakeCtx(goneNotes(t0)).ctx);
  b.observe(snap([dev({ id: 'p2', name: 'new one' })], t0), null);
  const v = b.view();
  assert.equal(v.stat, 'no known device here now');
  assert.deepEqual(v.lines, [
    'new one · tonight 22–07: not enough recent hours yet (0 of 3)',
    GONE_LINE + ' · last seen today',
  ]);
});

test('no present device known but a gone one has a guess: the stat says no known device here now (a present device with one hour)', () => {
  const t0 = hourAt(0, 23);
  // p1 gone with three folded hours: a firm guess; p2 present with one: not known
  const stored = { v: 2, looks: 9, since: t0, lastGood: t0, dev: {
    p1: { name: 'pixel', seen: t0, slots: { '46': [1, 1, t0], '47': [1, 1, t0], '48': [1, 1, t0] }, cur: null, tps: {} },
    p2: { name: 'phone', seen: t0, slots: { '49': [1, 1, t0] }, cur: null, tps: {} },
  } };
  const b = create(fakeCtx(stored).ctx);
  b.observe(snap([dev({ id: 'p2', name: 'phone' })], t0), null);
  const v = b.view();
  assert.equal(v.stat, 'no known device here now');   // not "still learning: 1 recent hour so far"
  assert.deepEqual(v.lines, [
    'phone · tonight 22–07: not enough recent hours yet (1 of 3)',
    GONE_LINE + ' · last seen today',
  ]);
});

test('no present device known but a gone one has a guess: the stat says no known device here now (the first seconds after a restart)', () => {
  const t0 = hourAt(0, 23);
  const b = create(fakeCtx(goneNotes(t0)).ctx);   // a restart: the notes come from disk
  const v = b.view();                             // before the first look
  assert.equal(v.stat, 'no known device here now');
  assert.deepEqual(v.lines, [GONE_LINE]);         // no look time yet: no "last seen" suffix
});

test('last seen: today only on the same local date; 23 hours across midnight is yesterday', () => {
  const t0 = hourAt(0, 23);                       // sunday 23:00
  const DAY = 86400_000;
  // the look is close to lastGood; only seen moves, so the far-forward guard stays out of it
  const mk = (seen: number) => ({ v: 2, looks: 5, since: seen, lastGood: t0, dev: { p1: { name: 'pixel', seen, slots: { '46': [1, 1, seen] }, cur: null, tps: {} } } });
  const same = create(fakeCtx(mk(hourAt(0, 9))).ctx);
  same.observe(snap([], t0), null);               // sunday 09:00 seen, sunday 23:00: the same date -> today
  assert.equal(same.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (1 of 3) · last seen today');
  const across = create(fakeCtx(mk(t0)).ctx);
  across.observe(snap([], t0 + 23 * 3600_000), null);   // sunday 23:00 -> monday 22:00: 23 h, the day before -> yesterday
  assert.equal(across.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (1 of 3) · last seen yesterday');
  const day = create(fakeCtx(mk(t0)).ctx);
  day.observe(snap([], t0 + DAY), null);          // exactly one whole day: still one calendar day
  assert.equal(day.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (1 of 3) · last seen yesterday');
  const back = create(fakeCtx(mk(t0)).ctx);
  back.observe(snap([], t0 - DAY), null);         // a clock that stepped back: no negative days
  assert.equal(back.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (1 of 3) · last seen today');
});

test('last seen: N days ago counts local calendar days (1.5 days is two), and the cap is past 365', () => {
  const t0 = hourAt(0, 23);
  // the look at t0 is close to lastGood; only seen is old, so the far-forward guard stays out of it
  const mk = (seen: number) => ({ v: 2, looks: 5, since: seen, lastGood: t0, dev: { p1: { name: 'pixel', seen, slots: { '46': [1, 1, seen] }, cur: null, tps: {} } } });
  const half = create(fakeCtx(mk(t0)).ctx);
  half.observe(snap([], hourAt(2, 11)), null);    // 36 h later, but sunday -> tuesday: two calendar days
  assert.equal(half.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (1 of 3) · last seen 2 days ago');
  const edge = create(fakeCtx(mk(hourAt(-365, 23))).ctx);
  edge.observe(snap([], t0), null);               // exactly 365 local dates is still whole days
  assert.equal(edge.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (0 of 3) · last seen 365 days ago');
  const past = create(fakeCtx(mk(hourAt(-366, 23))).ctx);
  past.observe(snap([], t0), null);               // 366: over a year ago
  assert.equal(past.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (0 of 3) · last seen over a year ago');
});

test('a gone device with hours but no present one: the stat says no known device here now, not "0 recent hours"', () => {
  const t0 = hourAt(0, 23);
  // two folded hours: N = 2, shown "2 of 3", under the guess threshold
  const stored = { v: 2, looks: 9, since: t0, lastGood: t0, dev: { p1: { name: 'pixel', seen: t0, slots: { '46': [1, 1, t0], '47': [1, 1, t0] }, cur: null, tps: {} } } };
  const b = create(fakeCtx(stored).ctx);
  b.observe(snap([], t0), null);
  const v = b.view();
  assert.equal(v.stat, 'no known device here now');   // not "still learning: 0 recent hours so far"
  assert.deepEqual(v.lines, ['pixel · tonight 22–07: not enough recent hours yet (2 of 3) · last seen today']);
});

test('a present device with an hour keeps the present-only count, beside a gone one with two', () => {
  const t0 = hourAt(0, 23);
  const stored = { v: 2, looks: 9, since: t0, lastGood: t0, dev: {
    p1: { name: 'pixel', seen: t0, slots: { '46': [1, 1, t0], '47': [1, 1, t0] }, cur: null, tps: {} },
    p2: { name: 'phone', seen: t0, slots: { '48': [1, 1, t0] }, cur: null, tps: {} },
  } };
  const b = create(fakeCtx(stored).ctx);
  b.observe(snap([dev({ id: 'p2', name: 'phone' })], t0), null);
  const v = b.view();
  assert.equal(v.stat, 'still learning: 1 recent hour so far');   // the stat sums present devices only
  assert.deepEqual(v.lines, [
    'phone · tonight 22–07: not enough recent hours yet (1 of 3)',
    'pixel · tonight 22–07: not enough recent hours yet (2 of 3) · last seen today',
  ]);
});

test('view() before the first look: the notes are read at the newest seen, so the decay still applies', () => {
  const t0 = hourAt(0, 23);
  const seen = hourAt(14, 23);                                     // two weeks after the fold
  const { ctx } = fakeCtx({ v: 2, looks: 1, since: t0, lastGood: seen, dev: { p1: { name: 'pixel', seen, slots: { '46': [1, 1, t0] }, cur: null, tps: {} } } });
  const b = create(ctx);
  // no observe yet: read at the newest seen; d = 0.5 ** (2/4) = 0.7071, N = 0.7071 -> 0.7
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (0.7 of 3)');
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
  for (let i = 0; i < 30; i++) { b.observe(snap([dev()], at23(i)), null); c.t += 5000; }   // 150 s of looks in one hour
  assert.equal(c.saves, 2);
  const saved = c.stored as any;
  assert.equal(saved.v, 2);
  assert.ok(saved.looks >= 12 && saved.looks <= 30);
  assert.ok(JSON.stringify(saved).length < 4000, 'small notes');
  const again = create(ctx);
  again.observe(snap([dev()], at23(100)), null);
  assert.equal(again.view().rows[0][1], String(saved.looks + 1));
});

test('notes with v: 1 on disk: the over-counted availability starts fresh', () => {
  const { c, ctx } = fakeCtx({ v: 1, looks: 200, since: 1, dev: { p1: { name: 'pixel', seen: 1, h: Array.from({ length: 24 }, () => [9, 9]), tps: {} } } });
  const b = create(ctx);
  b.observe(snap([dev()], at23(0)), null);
  c.t += 61_000;
  b.observe(snap([dev()], at23(1)), null);   // saves
  const saved = c.stored as any;
  assert.equal(saved.v, 2);
  assert.equal(saved.looks, 2);              // started over: the 200 v: 1 looks are gone
  assert.deepEqual(Object.keys(saved.dev.p1.slots), []);
});

test('notes with v: 1 on disk: the tok/s averages are carried over, the availability starts fresh', () => {
  const t = at23(0);
  const { c, ctx } = fakeCtx({ v: 1, looks: 200, since: t, dev: { p1: { name: 'pixel', seen: t, h: Array.from({ length: 24 }, () => [9, 9]), tps: { 'qwen3-0.6b.gguf': { name: 'Qwen3 0.6B', avg: 14, n: 7, at: t } } } } });
  const b = create(ctx);
  b.observe(snap([dev({ holds: 'qwen3-0.6b.gguf' })], t + 5000), null);
  c.t += 61_000;
  b.observe(snap([dev({ holds: 'qwen3-0.6b.gguf' })], t + 10_000), null);
  const saved = c.stored as any;
  assert.equal(saved.v, 2);
  assert.equal(saved.looks, 2, 'the availability started fresh');
  assert.deepEqual(Object.keys(saved.dev.p1.slots), []);
  assert.equal(saved.dev.p1.tps['qwen3-0.6b.gguf'].avg, 14, 'the speed average was carried over');
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (0 of 3) · ~14 tok/s on Qwen3 0.6B');
});

test('corrupt v: 2 notes: the bad device is dropped, the good one kept, never a throw', () => {
  const t = at23(0);
  const good = { name: 'pixel', seen: t, slots: { '46': [1, 1, t] }, cur: null, tps: {} };
  const cases: [string, any][] = [
    ['s over n', { ...good, slots: { '46': [1, 2, t] } }],
    ['nan', { ...good, slots: { '46': [NaN, 0, t] } }],
    ['negative', { ...good, slots: { '46': [-1, 0, t] } }],
    ['n beyond plausible', { ...good, slots: { '46': [1e5, 0, t] } }],
    ['slot t absurd', { ...good, slots: { '46': [1, 1, 9e15] } }],
    ['seen absurd', { ...good, seen: 9e15 }],
    ['slot key out of range', { ...good, slots: { '200': [1, 1, t] } }],
    ['slot key not a number', { ...good, slots: { 'x': [1, 1, t] } }],
    ['cur nonsense', { ...good, slots: {}, cur: { slot: 3 } }],
  ];
  for (const [what, bad] of cases) {
    const { c, ctx } = fakeCtx({ v: 2, looks: 5, since: t, dev: { good: structuredClone(good), bad: structuredClone(bad) } });
    const b = create(ctx);
    b.observe(snap([dev()], at23(0)), null);
    c.t += 61_000;
    b.observe(snap([dev()], at23(1)), null);
    const saved = c.stored as any;
    assert.ok(saved.dev.good, `${what}: the good device survives`);
    assert.equal(saved.dev.bad, undefined, `${what}: the bad device is dropped`);
  }
  for (const bad of [null, 'x', 42, { v: 9 }, { v: 2 }, { v: 2, looks: NaN, dev: {} }, { v: 2, looks: 3, dev: [] }]) {
    const { ctx } = fakeCtx(bad);
    const b = create(ctx);
    assert.doesNotThrow(() => b.observe(snap([dev()], at23(0)), null));
    assert.equal(b.view().built, true);
  }
});

test('a clock that jumps backwards and far forwards: no throw, the notes stay valid', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  for (let h = 0; h < 9; h++) hourLooks(b, [dev()], 0, 22 + h);    // one full night, 9 folds
  b.observe(snap([dev()], hourAt(-3, 22)), null);                  // backwards: thursday 22:00
  for (let i = 1; i < 12; i++) b.observe(snap([dev()], hourAt(-3, 22) + i * 5000), null);
  hourLooks(b, [dev()], -3, 23);                                   // folds the thursday hour normally
  b.observe(snap([dev()], hourAt(21, 8)), null);                   // forwards ~3 weeks: one fold, no loop over missed hours
  c.t += 61_000;
  b.observe(snap([dev()], hourAt(21, 8) + 5000), null);            // saves
  const saved = c.stored as any;
  assert.equal(Object.keys(saved.dev.p1.slots).length, 11);        // the 9 night slots plus the two thursday ones
  const again = create(ctx);
  assert.doesNotThrow(() => again.observe(snap([dev()], hourAt(21, 8) + 10_000), null));
  assert.equal(again.view().built, true);
  assert.ok((c.stored as any).dev.p1, 'the device\'s notes are still valid after the jumps');
});

test('caps the notes at 40 devices', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const many = Array.from({ length: 45 }, (_, i) => dev({ id: `p${i}`, name: `phone ${i}` }));
  b.observe(snap(many, at23(0)), null);
  c.t += 61_000;
  b.observe(snap(many, at23(1)), null);   // saves, trimmed
  const saved = c.stored as any;
  assert.equal(Object.keys(saved.dev).length, 40);
  assert.ok(saved.dev.p0, 'the first seen stays');
  assert.equal(saved.dev.p44, undefined, 'the last of 45 goes');
});

test('prototype keys: __proto__ and friends neither pollute nor throw (null-prototype notes)', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const tricky = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map((id, i) =>
    dev({ id, name: `tricky ${i}`, holds: '__proto__' }));
  const loaded = { ...loadedWith([]), model: { id: 'q', name: 'Fancy', file: '__proto__', size: 1 } };
  for (let h = 0; h < 6; h++) {
    const t = hourAt(0, 22 + h);
    for (let i = 0; i < 12; i++) {
      const first = h === 0 && i === 0;
      b.observe(snap(tricky, t + i * 5000, { ...loaded, devices: tricky.map((d) => ({ id: d.id, name: d.name, local: false, busy: false, tps: first ? 8 : 6, done: first ? 1 : 2 })) }), null);
    }
  }
  assert.equal(({} as any).name, undefined, 'Object.prototype was not touched');
  assert.equal(({} as any).seen, undefined, 'Object.prototype was not touched');
  const v = b.view();
  assert.equal(v.lines.length, 4);
  assert.equal(v.lines[0], 'tricky 0 · tonight 22–07: likely 93% (64–99%) · ~7.4 tok/s on Fancy');
  assert.ok(v.lines.every((l) => /^tricky \d · tonight 22–07: likely 93% \(64–99%\) · ~7\.4 tok\/s on Fancy$/.test(l)));
  c.t += 61_000;
  b.observe(snap(tricky, hourAt(0, 28) + 55_000), null);
  const saved = c.stored as any;
  assert.ok(Object.prototype.hasOwnProperty.call(saved.dev, '__proto__'), 'the id is an own key in the notes');
  assert.equal(saved.dev['__proto__'].name, 'tricky 0');
  assert.ok(saved.dev['__proto__'].tps['__proto__'], 'the model file is an own key too');
});

test('ids and names: unusable ids are skipped, a non-string name falls back to the id, names are cut to 80', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const mixed = [
    dev({ id: '', name: 'empty' }),
    dev({ id: 7, name: 'seven' }),
    dev({ id: null, name: 'nully' }),
    dev({ id: 'x'.repeat(201), name: 'long id' }),
    dev({ id: 'p2', name: 42 }),
    dev({ id: 'p3', name: 'n'.repeat(100) }),
  ];
  for (let i = 0; i < 12; i++) b.observe(snap(mixed, at23(i)), null);
  const v = b.view();
  assert.ok(!v.lines.some((l) => /empty|seven|nully|long id/.test(l)), 'unusable ids are skipped');
  assert.equal(v.lines[0].slice(0, 82), 'n'.repeat(80) + ' ·', 'the name is cut to 80');
  assert.equal(v.lines[1], 'p2 · tonight 22–07: not enough recent hours yet (0 of 3)');
  c.t += 61_000;
  b.observe(snap(mixed, at23(13)), null);
  const saved = c.stored as any;
  assert.deepEqual(Object.keys(saved.dev).sort(), ['p2', 'p3'], 'only usable ids reached the notes');
  assert.equal(saved.dev.p2.name, 'p2', 'a non-string name falls back to the id');
  assert.equal(saved.dev.p3.name.length, 80);
});

test('the snapshot is not trusted: null containers and bad entries never throw nor reach the notes or view', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  for (let h = 0; h < 6; h++) hourLooks(b, [dev()], 0, 22 + h);   // a real night first
  const t = hourAt(1, 7);
  const garbage: any[] = [
    { ...snap([], t), devices: null },                            // null container
    { ...snap([], t), devices: 'x' },                             // not an array
    snap([null, 42, 'x', dev({ id: 'p9', reachable: 'yes' }), dev({ id: 'p8', reachable: 1 }), dev({ id: '' }), dev({ id: 'p7', holds: 42, reachable: 'yes' })], t),
    { ...snap([dev()], t), work: null },                          // null work
    { ...snap([dev()], t), work: { loaded: null } },
    snap([dev()], t, { ...loadedWith([null, 7]), devices: null }),
    snap([dev()], t, loadedWith([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: NaN, done: 1 }])),
    snap([dev()], t, loadedWith([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: -3, done: 1 }])),
    snap([dev()], t, loadedWith([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: 1e300, done: 1 }])),
    snap([dev()], t, loadedWith([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: 6, done: NaN }])),
    snap([dev()], t, loadedWith([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: 6, done: '2' }])),
    snap([dev()], t, { ...loadedWith([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: 6, done: 2 }]), model: { id: 'q', name: 'Q', file: 42, size: 1 } }),
    snap([dev()], NaN),                                           // absurd times: the look is skipped whole
    snap([dev()], -5),
    snap([dev()], 9e15),
  ];
  for (const s of garbage) {
    assert.doesNotThrow(() => { b.observe(s, null); b.view(); }, 'the eye reads the view right after every look');
  }
  assert.equal(c.feed.length, 0, 'garbage produced no feed lines');
  b.observe(snap([dev()], hourAt(1, 8)), null);                   // a good look still records
  c.t += 61_000;
  b.observe(snap([dev()], hourAt(1, 8) + 55_000), null);          // saves
  const saved = c.stored as any;
  assert.deepEqual(Object.keys(saved.dev), ['p1'], 'nothing bogus reached the notes');
  assert.deepEqual(Object.keys(saved.dev.p1.tps), [], 'no speed from bogus samples');
  assert.equal(saved.dev.p1.slots['26'][0], 1, 'the night survived');
  const again = create(ctx);
  assert.doesNotThrow(() => again.observe(snap([dev()], hourAt(1, 9)), null));
  assert.equal(again.view().built, true);
  const j = JSON.stringify(b.view());
  assert.doesNotMatch(j, /NaN|undefined|\[object|e\+\d/, j);
  assert.doesNotMatch(JSON.stringify(saved), /e\+\d/, 'no exponent in the notes either');
});

test('an absurd snapshot.at skips the whole look', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  b.observe(snap([dev()], at23(0)), null);
  for (const at of [NaN, -5, 9e15]) {
    b.observe(snap([dev()], at), null);
    assert.equal(b.view().rows[0][1], '1', `at ${at}: the look was skipped`);
    assert.equal(b.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (0 of 3)');
  }
  b.observe(snap([dev()], at23(1)), null);
  assert.equal(b.view().rows[0][1], '2', 'a good look counts again');
});

test('a far-forward look is not trusted until the next one agrees; tonight is unchanged and later hours still fold', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  for (let h = 0; h < 6; h++) hourLooks(b, [dev()], 0, 22 + h);   // sunday 22:00 .. monday 02:55: N = 5
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: likely 93% (64–99%)');
  const far1 = hourAt(365, 12);                                   // a year ahead
  b.observe(snap([dev()], far1), null);
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: likely 93% (64–99%)', 'one far look changes nothing');
  b.observe(snap([dev()], far1 + 5000), null);                    // a second far look agrees: the clock really moved
  hourLooks(b, [dev()], 0, 28);                                   // back to normal: the hour folds and re-anchors
  hourLooks(b, [dev()], 0, 29);                                   // the next hour folds normally too
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: likely 95% (67–99%)');
  c.t += 61_000;
  b.observe(snap([dev()], hourAt(0, 29) + 55_000), null);         // saves
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.seen, hourAt(0, 29) + 55_000, 'seen is re-anchored');
  assert.equal(saved.lastGood, hourAt(0, 29) + 55_000, 'the last good look is re-anchored');
  assert.equal(saved.since, hourAt(0, 22), 'since stays the first good look');
  assert.equal(saved.dev.p1.slots['27'][2], far1 + 5000, 'the agreed far fold kept its time');
  // after a restart the clock is right again: the far slot folds with dt = 0 and is rewritten
  const again = create(ctx);
  for (let h = 0; h < 6; h++) hourLooks(again, [dev()], 7, 22 + h);   // the next sunday night
  c.t += 61_000;
  again.observe(snap([dev()], hourAt(7, 28)), null);                  // folds slot 27, whose t is far ahead
  again.observe(snap([dev()], hourAt(7, 28) + 55_000), null);         // saves
  const saved2 = c.stored as any;
  assert.deepEqual(saved2.dev.p1.slots['27'].slice(0, 2), [2, 2], 'dt = 0 across the far gap: n = 1*1 + 1');
  assert.equal(saved2.dev.p1.slots['27'][2], hourAt(7, 28), 'the far slot time was rewritten');
  assert.equal(saved2.dev.p1.seen, hourAt(7, 28), 'seen is re-anchored after the restart (the fold look saved)');
});

test('a cur stamped by a far-forward clock is folded and re-anchored', () => {
  const t = at23(0);
  const far = hourAt(365, 12);
  const { c, ctx } = fakeCtx({ v: 2, looks: 0, since: t, lastGood: t, dev: { p1: { name: 'pixel', seen: t, slots: {}, cur: { slot: 23, looks: 5, there: 5, t: far }, tps: {} } } });
  const b = create(ctx);
  b.observe(snap([dev()], t + 5000), null);   // same slot 23, but the cur's clock is a year ahead
  c.t += 61_000;
  b.observe(snap([dev()], t + 10_000), null); // saves
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.cur.t, t + 5000, 'the new cur starts at the look\'s time, not the far one');
  assert.equal(saved.dev.p1.cur.looks, 2);    // the 5 far looks are dropped, the 2 normal looks count
  assert.equal(saved.lastGood, t + 10_000);
});

test('the cap never evicts a device in the current snapshot, even against a vanished one with a far-forward seen', () => {
  const t = at23(0);
  const mk = (seen: number) => ({ name: 'd', seen, slots: {}, cur: null, tps: {} });
  const notesDev: any = Object.create(null);
  for (let i = 0; i < 40; i++) notesDev[`p${i}`] = mk(t);
  notesDev.ghost = mk(hourAt(365, 12));       // vanished, but its seen is a year ahead of the live ones
  const { c, ctx } = fakeCtx({ v: 2, looks: 0, since: t, lastGood: t, dev: notesDev });
  const b = create(ctx);
  const live = Array.from({ length: 40 }, (_, i) => dev({ id: `p${i}`, name: `phone ${i}` }));
  b.observe(snap(live, t), null);
  c.t += 61_000;
  b.observe(snap(live, t + 5000), null);      // saves, trimmed
  const saved = c.stored as any;
  assert.equal(Object.keys(saved.dev).length, 40, 'still capped at 40');
  for (let i = 0; i < 40; i++) assert.ok(saved.dev[`p${i}`], `the live p${i} stays`);
  assert.equal(saved.dev.ghost, undefined, 'the vanished device goes, far-forward seen and all');
});

test('a speed beyond plausibility in the notes is dropped, the device and its slots stay', () => {
  const t = at23(0);
  const t2 = t + 10_000;   // the slot's fold time is the look time, so N reads as a whole 1
  const { c, ctx } = fakeCtx({ v: 2, looks: 3, since: t, lastGood: t, dev: { p1: { name: 'pixel', seen: t, slots: { '46': [1, 1, t2] }, cur: null, tps: { 'big.gguf': { name: 'Big', avg: 1e300, n: 1, at: t }, 'ok.gguf': { name: 'Ok', avg: 12, n: 1, at: t } } } } });
  const b = create(ctx);
  b.observe(snap([dev({ holds: 'ok.gguf' })], t + 5000), null);
  c.t += 61_000;
  b.observe(snap([dev({ holds: 'ok.gguf' })], t2), null);
  const saved = c.stored as any;
  assert.deepEqual(Object.keys(saved.dev.p1.tps), ['ok.gguf'], 'the absurd speed is dropped');
  assert.equal(saved.dev.p1.slots['46'][0], 1, 'the slots stay');
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: not enough recent hours yet (1 of 3) · ~12 tok/s on Ok');
});

test('a known device with a speed: the whole line, guess and interval first', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  for (let h = 0; h < 6; h++) {
    const t = hourAt(0, 22 + h);
    for (let i = 0; i < 12; i++) {
      const first = h === 0 && i === 0;
      b.observe(snap([dev({ holds: 'qwen3-0.6b.gguf' })], t + i * 5000, loadedWith([{ id: 'p1', name: 'pixel', local: false, busy: false, tps: first ? 8 : 6, done: first ? 1 : 2 }])), null);
    }
  }
  assert.equal(b.view().lines[0], 'pixel · tonight 22–07: likely 93% (64–99%) · ~7.4 tok/s on Qwen3 0.6B');
});

test('restart keeps the folded slots', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  for (let h = 0; h < 9; h++) hourLooks(b, [dev()], 0, 22 + h);    // one full night, 9 folds
  c.t += 61_000;
  b.observe(snap([dev()], hourAt(1, 7)), null);                    // folds slot 30, then saves
  assert.equal(c.saves, 1);
  const again = create(ctx);
  again.observe(snap([dev()], hourAt(1, 8)), null);                // folds the one-look cur: dropped
  const v = again.view();
  // N = 9, decayed a few hours: p0 = 0.9499; tonight is monday's night, which the device never saw
  assert.equal(v.lines[0], 'pixel · tonight 22–07: likely 95% (64–99%), from daytime only');
  assert.equal(v.rows[0][1], String((c.stored as any).looks + 1));
});

// ---- the scored hours, handed to the learning branch

test('a pair at every fold once the device is known: the slot\'s estimate just before, the prior, x', () => {
  const F = hourAt(0, 22);   // sunday 22:00: slot 22; the notes' slot times equal the fold time, so nothing decays
  const { c, ctx } = fakeCtx({ v: 2, looks: 36, since: F, lastGood: F, dev: { p1: {
    name: 'pixel', seen: F, slots: { '46': [1, 1, F], '47': [1, 1, F], '48': [1, 1, F] },
    cur: { slot: 49, looks: 12, there: 9, t: F }, tps: {},
  } } });
  const b = create(ctx);
  b.observe(snap([dev()], F), null);                    // slot 22 != 49: folds slot 49
  c.t += 61_000;
  b.observe(snap([dev()], F + 5000), null);             // saves
  const saved = c.stored as any;
  const q = saved.dev.p1.pairs[0];
  // N = 3, S = 3: p0 = 3.5 / 4 = 0.875, a = 3.5; slot 49 was never seen: p = 3.5 / 4 = 0.875;
  // x = 9 / 12 = 0.75; the 80% wilson interval around 0.875 with m = 4: lo ~ 0.55666, hi ~ 0.97502
  assert.equal(q.t, F);
  assert.equal(q.p, 0.875);
  assert.equal(q.p0, 0.875);
  assert.equal(q.x, 0.75);
  assert.ok(Math.abs(q.lo - 0.55666) < 1e-4, `lo ${q.lo}`);
  assert.ok(Math.abs(q.hi - 0.97502) < 1e-4, `hi ${q.hi}`);
  assert.deepEqual(saved.dev.p1.slots['49'].slice(0, 2), [1, 0.75], 'the fold itself is unchanged');
  const vp = b.view().pairs!;
  assert.equal(vp.length, 1);
  assert.equal(vp[0].id, 'p1');
  assert.equal(vp[0].name, 'pixel');
  assert.deepEqual(vp[0].scored, [[F, 0.875, q.lo, q.hi, 0.875, 0.75]], 'handed over oldest first');
});

test('the very first folds of a device are not scored: no pair while it has under three folded hours', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  hourLooks(b, [dev()], 0, 22);                          // fold 22: N = 0 -> no pair
  hourLooks(b, [dev()], 0, 23);                          // fold 23: N ~ 1 -> no pair
  hourLooks(b, [dev()], 0, 24);                          // fold 24: N ~ 2 -> no pair
  hourLooks(b, [dev()], 0, 25);
  assert.equal(b.view().pairs![0].scored.length, 0, 'three folded hours are not known yet');
  hourLooks(b, [dev()], 0, 26);                          // fold 25: N ~ 3 -> the first pair
  c.t += 61_000;
  b.observe(snap([dev()], hourAt(0, 26) + 55_000), null);   // saves
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.pairs.length, 1);
  assert.equal(saved.dev.p1.pairs[0].x, 1);
  assert.equal(saved.dev.p1.pairs[0].t, hourAt(0, 26));
});

test('the pairs cap at 200 per device, the oldest dropped', () => {
  const F = hourAt(0, 22);
  const T0 = hourAt(0, 1);
  const pairs = Array.from({ length: 200 }, (_, i) => ({ t: T0 + i * 60_000, p: 0.5, lo: 0.2, hi: 0.8, p0: 0.5, x: 1 }));
  const { c, ctx } = fakeCtx({ v: 2, looks: 36, since: F, lastGood: F, dev: { p1: {
    name: 'pixel', seen: F, slots: { '46': [1, 1, F], '47': [1, 1, F], '48': [1, 1, F] },
    cur: { slot: 49, looks: 12, there: 12, t: F }, tps: {}, pairs,
  } } });
  const b = create(ctx);
  b.observe(snap([dev()], F), null);                    // folds slot 49: one more pair
  c.t += 61_000;
  b.observe(snap([dev()], F + 5000), null);             // saves
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.pairs.length, 200);
  assert.equal(saved.dev.p1.pairs[0].t, T0 + 60_000, 'the oldest went');
  assert.equal(saved.dev.p1.pairs[199].t, F, 'the new fold is the newest');
});

test('more than 200 pairs on disk: the last 200 are kept', () => {
  const t = hourAt(0, 23);
  const { c, ctx } = fakeCtx({ v: 2, looks: 5, since: t, lastGood: t, dev: { p1: {
    name: 'pixel', seen: t, slots: { '46': [1, 1, t] }, cur: null, tps: {},
    pairs: Array.from({ length: 300 }, (_, i) => ({ t: t + i * 60_000, p: 0.5, lo: 0.2, hi: 0.8, p0: 0.5, x: 1 })),
  } } });
  const b = create(ctx);
  b.observe(snap([dev()], t), null);
  c.t += 61_000;
  b.observe(snap([dev()], t + 5000), null);
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.pairs.length, 200);
  assert.equal(saved.dev.p1.pairs[0].t, t + 100 * 60_000, 'the 101st pair is now the oldest');
});

test('corrupt pairs in the notes: bad entries dropped, the device and its slots stay, never a throw', () => {
  const t = hourAt(0, 23);
  const good = { name: 'pixel', seen: t, slots: { '46': [1, 1, t] }, cur: null, tps: {} };
  const cases: [string, unknown][] = [
    ['not an array', 'x'],
    ['null', null],
    ['bad entries', [null, 42, {}, { t: NaN, p: 0.5, lo: 0.2, hi: 0.8, p0: 0.5, x: 1 },
      { t, p: 2, lo: 0.2, hi: 0.8, p0: 0.5, x: 1 }, { t, p: 0.5, lo: 0.8, hi: 0.2, p0: 0.5, x: 1 },
      { t: -1, p: 0.5, lo: 0.2, hi: 0.8, p0: 0.5, x: 1 }, { t: 9e15, p: 0.5, lo: 0.2, hi: 0.8, p0: 0.5, x: 1 },
      { t, p: 0.5, lo: 0.2, hi: 0.8, p0: 0.5, x: 1 }]],
  ];
  for (const [what, pairs] of cases) {
    const { c, ctx } = fakeCtx({ v: 2, looks: 5, since: t, lastGood: t, dev: { p1: { ...structuredClone(good), pairs: structuredClone(pairs) } } });
    const b = create(ctx);
    b.observe(snap([dev()], t), null);
    c.t += 61_000;
    b.observe(snap([dev()], t + 5000), null);
    const saved = c.stored as any;
    assert.ok(saved.dev.p1, `${what}: the device survives`);
    assert.equal(saved.dev.p1.slots['46'][0], 1, `${what}: the slots survive`);
    if (what === 'bad entries') assert.equal(saved.dev.p1.pairs.length, 1, 'only the valid pair survives');
    else assert.deepEqual(saved.dev.p1.pairs, [], `${what}: an empty list`);
  }
});

test('restart keeps the pairs; a notes file as the merged branch wrote it (no pairs) loads with an empty list', () => {
  const t = hourAt(0, 23);
  const { c, ctx } = fakeCtx({ v: 2, looks: 24, since: t, lastGood: t, dev: { p1: {
    name: 'pixel', seen: t, slots: { '46': [1, 1, t], '47': [1, 1, t], '48': [1, 1, t] }, cur: null, tps: {},
  } } });   // the exact shape the merged branch wrote: no pairs field
  const b = create(ctx);
  hourLooks(b, [dev()], 0, 22);                          // the cur for slot 22
  hourLooks(b, [dev()], 0, 23);                          // folds slot 22 at hour 23, the slots' own time: N = 3, a pair
  c.t += 61_000;
  b.observe(snap([dev()], hourAt(0, 23) + 55_000), null);   // saves
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.pairs.length, 1, 'the merged-shape notes load with an empty list, then score');
  assert.deepEqual(Object.keys(saved.dev.p1.slots).sort(), ['22', '46', '47', '48'], 'the old slots survived');
  const again = create(ctx);
  hourLooks(again, [dev()], 0, 24);                      // after the restart: folds slot 23, another pair
  c.t += 61_000;
  again.observe(snap([dev()], hourAt(0, 24) + 55_000), null);
  assert.equal((c.stored as any).dev.p1.pairs.length, 2, 'the pairs survived the restart and grew');
});

test('a far-forward clock: the untrusted fold scores nothing, after the re-anchor pairs come back, live and after a restart', () => {
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  for (let h = 0; h < 6; h++) hourLooks(b, [dev()], 0, 22 + h);   // sunday 22:00 .. monday 02:55: two pairs
  const far1 = hourAt(365, 12);
  b.observe(snap([dev()], far1), null);                  // not trusted on its own
  b.observe(snap([dev()], far1 + 5000), null);           // agreed: folds the old cur at the far time, nothing known -> no pair
  hourLooks(b, [dev()], 0, 28);                          // the far cur is dropped (one look), the hour folds and re-anchors
  hourLooks(b, [dev()], 0, 29);                          // folds slot 28: known again -> a pair
  c.t += 61_000;
  b.observe(snap([dev()], hourAt(0, 29) + 55_000), null);   // saves
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.pairs.length, 3, 'no pair from the far fold, pairs again after the re-anchor');
  assert.equal(saved.dev.p1.pairs[2].t, hourAt(0, 29));
  const again = create(ctx);
  hourLooks(again, [dev()], 0, 30);                      // after the restart: another fold, another pair
  c.t += 61_000;
  again.observe(snap([dev()], hourAt(0, 30) + 55_000), null);
  const saved2 = c.stored as any;
  assert.equal(saved2.dev.p1.pairs.length, 4);
  assert.equal(saved2.dev.p1.pairs[3].t, hourAt(0, 30));
});

test('a device gone from the snapshot: its pairs stay, no new pair while it is away, scoring resumes when it is back', () => {
  const F = hourAt(0, 22);
  const { c, ctx } = fakeCtx({ v: 2, looks: 36, since: F, lastGood: F, dev: { p1: {
    name: 'pixel', seen: F, slots: { '46': [1, 1, F], '47': [1, 1, F], '48': [1, 1, F] },
    cur: { slot: 49, looks: 12, there: 12, t: F }, tps: {},
  } } });
  const b = create(ctx);
  b.observe(snap([dev()], F), null);                     // folds slot 49: the first pair
  for (let h = 1; h <= 3; h++) b.observe(snap([], hourAt(0, 22 + h)), null);   // the device is away
  c.t += 61_000;
  b.observe(snap([], hourAt(1, 1)), null);               // saves
  assert.equal((c.stored as any).dev.p1.pairs.length, 1, 'no pair while the device was away');
  hourLooks(b, [dev()], 1, 22);                          // back: a full hour
  hourLooks(b, [dev()], 1, 23);                          // its first look folds slot 22: known again -> a pair
  c.t += 61_000;
  b.observe(snap([dev()], hourAt(1, 23) + 55_000), null);   // saves
  const saved = c.stored as any;
  assert.equal(saved.dev.p1.pairs.length, 2, 'scoring resumes when the device is back');
  assert.equal(saved.dev.p1.pairs[1].t, hourAt(1, 23));
  assert.equal(saved.dev.p1.pairs[0].t, F, 'the old pair stayed');
});

test('the view hands the pairs to learning: at most 40 devices, at most 200 pairs each, oldest first', () => {
  const t = hourAt(0, 23);
  const mk = (seen: number, nPairs: number) => ({
    name: 'd', seen, slots: { '46': [1, 1, t] }, cur: null, tps: {},
    pairs: Array.from({ length: nPairs }, (_, i) => ({ t: t + i * 60_000, p: 0.5, lo: 0.2, hi: 0.8, p0: 0.5, x: 1 })),
  });
  const devs: any = Object.create(null);
  devs.big = mk(t, 300);                                 // first, so it stays within the 40
  for (let i = 0; i < 44; i++) devs[`p${i}`] = mk(t, 1);
  const { ctx } = fakeCtx({ v: 2, looks: 0, since: t, lastGood: t, dev: devs });
  const b = create(ctx);
  const v = b.view();                                    // before any look: the pairs come from the notes alone
  assert.equal(v.pairs!.length, 40, 'at most 40 devices (45 in the notes)');
  assert.equal(v.pairs![0].id, 'big');
  assert.equal(v.pairs![0].name, 'd');
  assert.deepEqual(v.pairs![0].scored[0], [t + 100 * 60_000, 0.5, 0.2, 0.8, 0.5, 1], 'oldest first, capped at 200');
  assert.equal(v.pairs![0].scored.length, 200, 'at most 200 pairs each');
  assert.equal(v.pairs![1].id, 'p0');
  assert.equal(v.pairs![1].scored[0][0], t, 'one pair, untouched');
  assert.ok(v.pairs!.every((p) => p.scored.length <= 200));
});

test('in the eye: the forecast tile is lit and keeps its notes in forecast.json', () => {
  let t = at23(0);
  const dir = path.join(HOME, 'eye');
  const eye = new GodsEye({ snapshot: () => snap([dev()], t), dir, now: () => t });
  for (let i = 0; i < 20; i++) { eye.tick(); t += 5000; }
  const f = eye.view().branches.find((b) => b.id === 'forecast')!;
  assert.equal(f.built, true);
  assert.equal(f.error, undefined);
  assert.match(f.stat, /still learning: 0 recent hours so far/);
  assert.ok(fs.existsSync(path.join(dir, 'forecast.json')));
});
