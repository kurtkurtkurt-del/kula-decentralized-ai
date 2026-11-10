// god's eye, branch 2 memory: a change-only event log between looks, its bounds, its notes file
// read back, the view, and the rules that a bad clock, a skipped look or an odd snapshot field
// cannot stop it, and that nothing a person wrote reaches the notes, the view or the feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { create, diff, prune, stateOf, newDecisions, MAX_EVENTS, KEEP_MS } = await import('../src/godseye/branches/memory.ts');

const T = new Date(2026, 10, 8, 23, 0, 0).getTime();   // Sunday 8 November 2026, 23:00 local
const at = (s: number) => T + s * 1000;
const DAY = 24 * 3600_000;

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const work = (o: Record<string, unknown> = {}) => ({ loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true, ...o });
const snap = (devices: any[], t: number, w: any = work(), projects: any[] = []): any =>
  ({ at: t, host: { name: 'mac', freeMb: 4000 }, devices, work: w, models: [], projects });
const model = (o: Record<string, unknown> = {}) => ({ id: 'q', name: 'Qwen3 0.6B', file: 'qwen3-0.6b.gguf', size: 1, ...o });
const loaded = (m: any, mode = 'apart') => ({ mode, model: m, ctx: 4096, since: 0, devices: [] });
const proj = (o: Record<string, unknown> = {}) => ({
  id: 'j1', title: 'Read my diary', request: 'summarise my private letter', start: 1, end: 2, state: 'running',
  mode: 'apart', model: 'q', peers: [], line: 'private line', error: 'private error', ...o,
});
const fresh = () => ({ looked: false, devices: [], work: { loaded: null }, projects: [] });
const decision = (t: number, text: string) => ({ at: t, text });

/** a fake ctx: its own clock, a notes "file" in memory, the feed in an array */
function fakeCtx(stored: unknown = undefined) {
  const c = { t: T, stored, saves: 0, feed: [] as string[] };
  const ctx = {
    now: () => c.t,
    load: <X>(fallback: X): X => (c.stored === undefined ? fallback : structuredClone(c.stored) as X),
    save: (d: unknown) => { c.stored = structuredClone(d); c.saves++; },
    emit: (s: string) => { c.feed.push(s); },
    peek: () => null,
  };
  return { c, ctx };
}

/** looks driven straight through the branch: the wall clock follows the snapshot's at */
function drive(snaps: any[], stored: unknown = undefined) {
  const { c, ctx } = fakeCtx(stored);
  const b = create(ctx);
  let before: any = null;
  for (const s of snaps) { c.t = s.at; b.observe(s, before); before = s; }
  return { b, c, ctx };
}

/** everything the branch lets out of itself: the notes, the view and the feed */
function leaked(b: any, c: any): string {
  return JSON.stringify({ notes: c.stored, view: b.view(), feed: c.feed });
}

// ---- the pure parts

test('diff: the very first look has nothing to compare with', () => {
  assert.deepEqual(diff(snap([dev()], at(0)), null, fresh()), []);
  assert.deepEqual(diff(snap([dev()], at(0)), null, null), []);
});

test('diff names every device change; an unknown reachable or plug is ignored', () => {
  const before = snap([
    dev({ id: 'p1', name: 'one', reachable: true }),
    dev({ id: 'p2', name: 'two', reachable: false }),
    dev({ id: 'p3', name: 'three', plugged: null }),
    dev({ id: 'p4', name: 'four', plugged: false }),
    dev({ id: 'p5', name: 'five', via: 'wifi' }),
    dev({ id: 'p6', name: 'six', holds: null }),
    dev({ id: 'p8', name: 'eight' }),
    dev({ id: 'p9', name: 'nine', reachable: true }),
    dev({ id: 'p10', name: 'ten', plugged: true }),
    dev({ id: 'p11', name: 'eleven', holds: 'a.gguf' }),
  ], at(0));
  const now = snap([
    dev({ id: 'p1', name: 'one', reachable: false }),
    dev({ id: 'p2', name: 'two', reachable: true }),
    dev({ id: 'p3', name: 'three', plugged: true }),
    dev({ id: 'p4', name: 'four', plugged: true }),
    dev({ id: 'p5', name: 'five', via: 'cable' }),
    dev({ id: 'p6', name: 'six', holds: 'qwen3-0.6b.gguf' }),
    dev({ id: 'p7', name: 'seven' }),
    dev({ id: 'p9', name: 'nine', reachable: null }),
    dev({ id: 'p10', name: 'ten', plugged: null }),
    dev({ id: 'p11', name: 'eleven', holds: null }),
  ], at(5));

  const evs = diff(now, before, null);
  assert.deepEqual(evs.map((e) => [e.k, e.d, e.n, e.x]), [
    ['down', 'p1', 'one', null],
    ['up', 'p2', 'two', null],
    ['plugged', 'p4', 'four', null],
    ['via', 'p5', 'five', 'wifi → cable'],
    ['holds', 'p6', 'six', 'qwen3-0.6b.gguf'],
    ['appeared', 'p7', 'seven', null],
    ['holds', 'p11', 'eleven', null],
    ['gone', 'p8', 'eight', null],
  ]);
  assert.ok(evs.every((e) => e.t === at(5)), 'every event carries the look\'s at');
});

test('diff names the work changes: loaded, mode, a different file loaded, unloaded', () => {
  const q = model();
  const s0 = snap([], at(0));
  const s1 = snap([], at(1), work({ loaded: loaded(q, 'apart') }));
  const s2 = snap([], at(2), work({ loaded: loaded(q, 'split') }));
  const s3 = snap([], at(3), work({ loaded: loaded(model({ id: 'r', name: 'Llama 3', file: 'llama.gguf' }), 'split') }));
  const s4 = snap([], at(4));

  assert.deepEqual(diff(s1, s0, null).map((e) => [e.k, e.x]), [['loaded', 'Qwen3 0.6B · apart']]);
  assert.deepEqual(diff(s2, s1, null).map((e) => [e.k, e.x]), [['mode', 'apart → split']]);
  assert.deepEqual(diff(s3, s2, null).map((e) => [e.k, e.x]), [['loaded', 'Llama 3 · split']]);
  assert.deepEqual(diff(s4, s3, null).map((e) => [e.k, e.x]), [['unloaded', null]]);
  assert.deepEqual(diff(s1, s0, null).map((e) => [e.d, e.n]), [[null, null]]);
});

test('diff a project keeps its id and new state only; its title, request, line and error stay out', () => {
  const p0 = snap([], at(0), work(), [proj({ state: 'running', title: 'OLD TITLE', request: 'OLD REQUEST' })]);
  const p1 = snap([], at(1), work(), [proj({ state: 'done', title: 'SECRET TITLE', request: 'SECRET REQUEST', line: 'SECRET LINE', error: 'SECRET ERROR' })]);
  const evs = diff(p1, p0, null);
  assert.deepEqual(evs.map((e) => [e.k, e.d, e.n, e.x]), [['project', 'j1', null, 'done']]);
  assert.ok(!/SECRET|OLD/.test(JSON.stringify(evs)));

  // a project that appears or leaves is not one of the asked-for events
  const p2 = snap([], at(2), work(), [proj({ state: 'done' }), proj({ id: 'j2', state: 'running' })]);
  assert.deepEqual(diff(p2, p1, null), []);
  const p3 = snap([], at(3), work(), []);
  assert.deepEqual(diff(p3, p2, null), []);
});

test('diff after a restart compares with what the notes remembered, so a change is a change', () => {
  const remembered = stateOf(snap([dev({ id: 'p1', reachable: true })], at(0)));
  assert.equal(remembered.looked, true);
  const evs = diff(snap([dev({ id: 'p1', reachable: false })], at(5)), null, remembered);
  assert.deepEqual(evs.map((e) => [e.k, e.d]), [['down', 'p1']]);
});

test('newDecisions: only decisions newer than the watermark, text cut to 200, the at kept', () => {
  const started = decision(at(0) - 10_000, 'started');
  const added = decision(at(0) + 1_000, 'added pixel');
  const now = snap([], at(5), work({ decisions: [started, added] }));

  const first = newDecisions(now, at(0) - 10_000);
  assert.deepEqual(first.events.map((e) => [e.t, e.k, e.x]), [[at(5), 'decision', 'added pixel']]);
  assert.equal(first.last, added.at);

  const again = newDecisions(now, first.last);
  assert.deepEqual(again.events, [], 'nothing newer than the watermark');
  assert.equal(again.last, added.at);

  const long = newDecisions(snap([], at(6), work({ decisions: [decision(1, 'x'.repeat(300))] })), null);
  assert.equal(long.events.length, 1);
  assert.equal(long.events[0].x!.length, 200);
});

test('prune: drops what is older than 90 days, keeps at most 2000, never changes its input', () => {
  const e = (t: number) => ({ t, k: 'up' as const, d: 'p1', n: 'pixel', x: null });
  const newest = 1_000_000_000_000;
  const input = [e(newest - KEEP_MS), e(newest - KEEP_MS - 1), e(newest - 5_000), e(newest)];
  const kept = prune(input, newest);
  assert.deepEqual(kept.map((x) => x.t), [newest - KEEP_MS, newest - 5_000, newest]);
  assert.equal(input.length, 4);

  const many = Array.from({ length: MAX_EVENTS + 5 }, (_, i) => e(i + 1));
  const capped = prune(many, MAX_EVENTS + 5);
  assert.equal(capped.length, MAX_EVENTS);
  assert.equal(capped[0].t, 6);
  assert.equal(capped[capped.length - 1].t, MAX_EVENTS + 5);
});

// ---- the branch

test('the first look records no change; ten identical looks record nothing', () => {
  const snaps = [snap([dev()], at(0))];
  for (let i = 1; i <= 10; i++) snaps.push(snap([dev()], at(i)));
  const { b, c } = drive(snaps);

  const v = b.view();
  assert.equal(v.built, true);
  assert.equal(v.stat, '0 events kept · 0 today');
  assert.equal(v.gauge, 0);
  assert.deepEqual(v.rows[0], ['kept since', 'nothing yet']);
  assert.deepEqual(v.rows[1], ['today', 'nothing yet']);
  assert.deepEqual(v.rows[2], ['keeps', 'changes only, at most 2000, 90 days; no prompts, no answers, no addresses']);
  assert.deepEqual(v.lines, []);
  assert.equal(v.note, 'nothing yet.');
  assert.match(v.what!, /^keeps .*never /);

  assert.equal(c.saves, 1, 'the first look remembers the state; the next save is a minute away');
  assert.equal((c.stored as any).ev.length, 0);
  assert.equal((c.stored as any).state.looked, true);
  assert.equal((c.stored as any).state.devices[0].id, 'p1');
});

test('the first look logs the decisions already there, as the old view showed them', () => {
  const started = decision(at(0) - 10_000, 'started');
  const { b, c } = drive([snap([], at(0), work({ decisions: [started] }))]);
  const v = b.view();
  assert.equal(v.stat, '1 events kept · 1 today');
  assert.deepEqual(v.lines, ['23:00  started']);
  assert.deepEqual((c.stored as any).ev.map((x: any) => [x.k, x.x]), [['decision', 'started']]);
  assert.equal((c.stored as any).lastDecisionAt, started.at);
});

test('an empty snapshot is a normal look: built, bounded and empty', () => {
  const { ctx } = fakeCtx();
  const b = create(ctx);
  const before = b.view();
  assert.equal(before.built, true);
  assert.equal(before.stat, '0 events kept · 0 today');

  const { b: b2 } = drive([snap([], at(0)), snap([], at(5))]);
  assert.equal(b2.view().stat, '0 events kept · 0 today');
  assert.deepEqual(b2.view().lines, []);
});

test('the log writes every device change, only when it changes', () => {
  const p = (o: Record<string, unknown>) => dev({ id: 'p1', ...o });
  const { b, c } = drive([
    snap([], at(0)),
    snap([p({ reachable: false, plugged: true })], at(5)),                             // appeared
    snap([p({ reachable: true, plugged: true })], at(10)),                             // up
    snap([p({ reachable: false, plugged: true })], at(15)),                            // down
    snap([p({ reachable: false, plugged: false })], at(20)),                           // unplugged
    snap([p({ reachable: false, plugged: true })], at(25)),                            // plugged
    snap([p({ reachable: false, plugged: true, via: 'cable' })], at(30)),              // via
    snap([p({ reachable: false, plugged: true, via: 'cable', holds: 'qwen3-0.6b.gguf' })], at(35)),  // holds
    snap([p({ reachable: false, plugged: true, via: 'cable', holds: null })], at(40)), // holds nothing
    snap([], at(100)),                                                                 // gone, and the minute is up
  ]);

  const ev = (c.stored as any).ev;
  assert.deepEqual(ev.map((x: any) => [x.k, x.d, x.n, x.x]), [
    ['appeared', 'p1', 'pixel', null],
    ['up', 'p1', 'pixel', null],
    ['down', 'p1', 'pixel', null],
    ['unplugged', 'p1', 'pixel', null],
    ['plugged', 'p1', 'pixel', null],
    ['via', 'p1', 'pixel', 'wifi → cable'],
    ['holds', 'p1', 'pixel', 'qwen3-0.6b.gguf'],
    ['holds', 'p1', 'pixel', null],
    ['gone', 'p1', 'pixel', null],
  ]);
  assert.deepEqual(ev.map((x: any) => x.t), [at(5), at(10), at(15), at(20), at(25), at(30), at(35), at(40), at(100)]);

  const v = b.view();
  assert.equal(v.stat, '9 events kept · 9 today');
  assert.deepEqual(v.lines, [
    '23:01  pixel is gone',
    '23:00  pixel holds nothing now',
    '23:00  pixel now holds qwen3-0.6b.gguf',
    '23:00  pixel is reached differently: wifi → cable',
    '23:00  pixel was plugged in',
    '23:00  pixel was unplugged',
    '23:00  pixel stopped answering',
    '23:00  pixel answers again',
    '23:00  pixel appeared',
  ]);
  assert.equal(v.rows[1][1], '1 appeared · 1 gone · 1 up · 1 down · 1 plugged · 1 unplugged · 1 via · 2 holds');
  assert.equal(v.lines[3], '23:00  pixel is reached differently: wifi → cable');
  assert.equal(v.lines[2], '23:00  pixel now holds qwen3-0.6b.gguf');
  assert.equal(v.lines[4], '23:00  pixel was plugged in');
});

test('the log writes the work changes: loaded, mode, a different model, unloaded', () => {
  const q = model();
  const { b, c } = drive([
    snap([], at(0)),
    snap([], at(5), work({ loaded: loaded(q, 'apart') })),
    snap([], at(10), work({ loaded: loaded(q, 'split') })),
    snap([], at(15), work({ loaded: loaded(q, 'apart') })),
    snap([], at(20), work({ loaded: loaded(model({ id: 'r', name: 'Llama 3', file: 'llama.gguf' }), 'split') })),
    snap([], at(80)),                                          // unloaded, and the minute is up
  ]);

  const ev = (c.stored as any).ev;
  assert.deepEqual(ev.map((x: any) => [x.k, x.x]), [
    ['loaded', 'Qwen3 0.6B · apart'],
    ['mode', 'apart → split'],
    ['mode', 'split → apart'],
    ['loaded', 'Llama 3 · split'],
    ['unloaded', null],
  ]);
  assert.deepEqual(b.view().lines.slice(0, 2), [
    '23:01  the model was unloaded',
    '23:00  the model loaded: Llama 3 · split',
  ]);
  assert.equal(b.view().lines[4], '23:00  the model loaded: Qwen3 0.6B · apart');
});

test('a project state changes; its title, request, line and error reach neither notes, view nor feed', () => {
  const secret = (n: string) => proj({ title: `SECRET TITLE ${n}`, request: `SECRET REQUEST ${n}`, line: `SECRET LINE ${n}`, error: `SECRET ERROR ${n}` });
  const { b, c } = drive([
    snap([], at(0), work(), [secret('1')]),
    snap([], at(5), work(), [{ ...secret('2'), state: 'done' }]),
    snap([], at(65), work(), [{ ...secret('2'), state: 'done' }]),    // flush the save
  ]);

  assert.ok(!leaked(b, c).includes('SECRET'), 'no title, request, line or error in the notes, the view or the feed');
  assert.ok(!leaked(b, c).includes('diary') && !leaked(b, c).includes('private letter'));
  assert.deepEqual(c.feed, [], 'the branch emits nothing');
  const ev = (c.stored as any).ev;
  assert.deepEqual(ev.map((x: any) => [x.k, x.d, x.n, x.x]), [['project', 'j1', null, 'done']]);
  assert.equal(b.view().lines[0], '23:00  project j1 is now done');
});

test('a decision already logged is not logged again; a new one is; the text is cut to 200', () => {
  const started = decision(at(0) - 10_000, 'started');
  const added = decision(at(0) + 1_000, 'added pixel');
  const long = decision(at(0) + 12_000, 'x'.repeat(300));
  const { b, c } = drive([
    snap([], at(0), work({ decisions: [started] })),                                  // first look: the old decision shows
    snap([], at(5), work({ decisions: [started, added] })),
    snap([], at(10), work({ decisions: [started, added] })),                          // already logged: nothing
    snap([], at(15), work({ decisions: [started, added, long] })),
    snap([], at(75), work({ decisions: [started, added, long] })),                    // flush the save
  ]);

  const ev = (c.stored as any).ev;
  assert.deepEqual(ev.map((x: any) => [x.k, x.t, x.x.length]), [
    ['decision', at(0), 7],
    ['decision', at(5), 11],
    ['decision', at(15), 200],
  ]);
  assert.equal(ev[0].x, 'started');
  assert.equal(ev[1].x, 'added pixel');
  assert.equal(ev[2].x, 'x'.repeat(200));
  assert.deepEqual(b.view().lines.slice(0, 3), [`23:00  ${'x'.repeat(200)}`, '23:00  added pixel', '23:00  started']);
  assert.equal(b.view().stat, '3 events kept · 3 today');
});

test('after a restart a change is still a change, not an appearance', () => {
  const { c, ctx } = fakeCtx();
  const first = create(ctx);
  first.observe(snap([dev({ id: 'p1', reachable: true })], at(0)), null);
  assert.equal((c.stored as any).state.looked, true);
  assert.equal((c.stored as any).state.devices[0].reachable, true);

  const again = create(ctx);
  again.observe(snap([dev({ id: 'p1', reachable: false })], at(5)), null);   // the process lost its before
  const v = again.view();
  assert.equal(v.lines.length, 1);
  assert.equal(v.lines[0], '23:00  pixel stopped answering');
  assert.ok(!v.lines[0].includes('appeared'));
  assert.deepEqual((c.stored as any).ev.map((x: any) => [x.k, x.d]), [['down', 'p1']]);
});

test('after a restart the decisions already logged stay logged, new ones arrive once', () => {
  const started = decision(at(0) - 10_000, 'started');
  const added = decision(at(0) + 1_000, 'added pixel');
  const later = decision(at(0) + 12_000, 'read a photo');
  const { c, ctx } = fakeCtx();

  const first = create(ctx);
  c.t = at(0);
  first.observe(snap([], at(0), work({ decisions: [started] })), null);
  assert.equal((c.stored as any).lastDecisionAt, started.at);
  assert.deepEqual((c.stored as any).ev.map((x: any) => x.x), ['started']);

  const again = create(ctx);
  c.t = at(5);
  again.observe(snap([], at(5), work({ decisions: [started, added] })), null);
  c.t = at(10);
  again.observe(snap([], at(10), work({ decisions: [started, added] })), null);
  c.t = at(15);
  again.observe(snap([], at(15), work({ decisions: [started, added, later] })), null);
  c.t = at(75);
  again.observe(snap([], at(75), work({ decisions: [started, added, later] })), null);   // flush

  assert.deepEqual((c.stored as any).ev.map((x: any) => [x.k, x.x]), [
    ['decision', 'started'], ['decision', 'added pixel'], ['decision', 'read a photo'],
  ]);
  assert.equal((c.stored as any).lastDecisionAt, later.at);
});

test('notes of the wrong shape or with a bad time give fresh notes, never a throw', () => {
  const goodState = { looked: true, devices: [], work: { loaded: null }, projects: [] };
  const bads: unknown[] = [
    null,
    'x',
    { v: 2 },
    { v: 1, ev: 'x' },
    { v: 1, ev: [{ t: -1, k: 'up', d: null, n: null, x: null }], lastDecisionAt: null, state: goodState },
    { v: 1, ev: [{ t: Number.NaN, k: 'up', d: null, n: null, x: null }], lastDecisionAt: null, state: goodState },
    { v: 1, ev: [{ t: 1e300, k: 'up', d: null, n: null, x: null }], lastDecisionAt: null, state: goodState },
    { v: 1, ev: [{ t: 8.64e15 + 1, k: 'up', d: null, n: null, x: null }], lastDecisionAt: null, state: goodState },
    { v: 1, ev: [{ t: at(1), k: 'nope', d: null, n: null, x: null }], lastDecisionAt: null, state: goodState },
    { v: 1, ev: [], lastDecisionAt: -5, state: goodState },
    { v: 1, ev: [], lastDecisionAt: 1e300, state: goodState },
    { v: 1, ev: [], lastDecisionAt: null, state: { looked: true, devices: 'x', work: { loaded: null }, projects: [] } },
  ];
  for (const bad of bads) {
    const { ctx } = fakeCtx(bad);
    const b = create(ctx);
    const s0 = snap([dev()], at(0));
    assert.doesNotThrow(() => b.observe(s0, null));
    assert.equal(b.view().stat, '0 events kept · 0 today', 'fresh notes: the first look records no change');
    const s1 = snap([dev({ reachable: false })], at(5));
    b.observe(s1, s0);
    assert.equal(b.view().lines.length, 1);
    assert.equal(b.view().lines[0], '23:00  pixel stopped answering');
  }
});

test('a look with no usable at is skipped, and a change in it is caught by the next good look', () => {
  const { b } = drive([
    snap([dev({ reachable: true })], at(0)),
    snap([dev({ reachable: false })], Number.NaN),       // skipped: a change, but no usable time
    snap([dev({ reachable: false })], 1e300),            // skipped: past the last ms a Date can hold
    snap([dev({ reachable: false })], at(10)),           // good: compares with the remembered true
  ]);
  const v = b.view();
  assert.equal(v.stat, '1 events kept · 1 today');
  assert.deepEqual(v.lines, ['23:00  pixel stopped answering']);
  assert.ok(!JSON.stringify(v).includes('NaN'), 'no NaN:NaN in the view');
});

test('a small backwards step still records and drops nothing', () => {
  const { b } = drive([
    snap([dev({ reachable: true })], at(0)),
    snap([dev({ reachable: false })], at(5)),            // down, 23:00:05
    snap([dev({ reachable: true })], at(5) - 60_000),    // up, one minute back
  ]);
  const v = b.view();
  assert.equal(v.stat, '2 events kept · 2 today');
  assert.deepEqual(v.lines, ['22:59  pixel answers again', '23:00  pixel stopped answering']);
});

test('one bad far-future look does not silence the log', () => {
  const future = T + 400 * DAY;
  const { b, c } = drive([
    snap([dev({ reachable: true })], T),
    snap([dev({ reachable: false })], future),          // down, stamped 400 days ahead (bad clock)
    snap([dev({ reachable: true })], T + 5_000),        // the clock is right again: re-anchor
    snap([dev({ reachable: false })], T + 10_000),      // down
    snap([dev({ reachable: false })], T + 70_000),      // flush the save
  ]);
  const ev = (c.stored as any).ev;
  assert.deepEqual(ev.map((x: any) => [x.k, x.t]), [['up', T + 5_000], ['down', T + 10_000]]);
  assert.ok(ev.every((x: any) => x.t <= T + 10_000), 'the far-future event is gone');
  assert.equal(b.view().stat, '2 events kept · 2 today');
  assert.deepEqual(b.view().lines, ['23:00  pixel stopped answering', '23:00  pixel answers again']);
});

test('one bad far-future look does not silence the log after a restart either', () => {
  const future = T + 400 * DAY;
  const { c, ctx } = fakeCtx();
  const first = create(ctx);
  c.t = T;
  first.observe(snap([dev({ reachable: true })], T), null);
  c.t = future;
  first.observe(snap([dev({ reachable: false })], future), snap([dev({ reachable: true })], T));
  assert.deepEqual((c.stored as any).ev.map((x: any) => [x.k, x.t]), [['down', future]]);
  assert.equal((c.stored as any).state.devices[0].reachable, false);

  const again = create(ctx);
  c.t = T + 5_000;
  again.observe(snap([dev({ reachable: true })], T + 5_000), null);
  c.t = T + 10_000;
  again.observe(snap([dev({ reachable: false })], T + 10_000), snap([dev({ reachable: true })], T + 5_000));
  c.t = T + 70_000;
  again.observe(snap([dev({ reachable: false })], T + 70_000), snap([dev({ reachable: false })], T + 10_000));

  const ev = (c.stored as any).ev;
  assert.deepEqual(ev.map((x: any) => [x.k, x.t]), [['up', T + 5_000], ['down', T + 10_000]]);
  assert.deepEqual(again.view().lines, ['23:00  pixel stopped answering', '23:00  pixel answers again']);
});

test('odd snapshot fields are coerced or skipped, never a throw', () => {
  const odd = (o: Record<string, unknown> = {}) => dev({ id: 'p1', name: null, holds: 7, via: 5, ...o });
  const { b, c } = drive([
    snap([odd({ reachable: true })], at(0), work(), [{ id: 'j1', state: null }, { id: 42, state: 'running' }]),
    snap([odd({ reachable: false, holds: 8 })], at(5), work(), [{ id: 'j1', state: 'done' }, { id: 42, state: 'finished' }]),
    snap([odd({ reachable: false, holds: 8 })], at(65), work(), [{ id: 'j1', state: 'done' }, { id: 42, state: 'finished' }]),   // flush
    snap([dev({ id: 42, name: 'numbered' }), odd({ reachable: false, holds: 8 })], at(70), work(), [{ id: 'j1', state: 'done' }, { id: 42, state: 'finished' }]),
  ]);
  const ev = (c.stored as any).ev;
  assert.deepEqual(ev.map((x: any) => [x.k, x.d, x.n, x.x]), [
    ['down', 'p1', null, null],
    ['holds', 'p1', null, '8'],
  ]);
  assert.ok(!JSON.stringify(b.view()).includes('NaN'));
  // the missing state was skipped, not coerced; the later real state is what the notes remember
  assert.deepEqual((c.stored as any).state.projects.map((p: any) => [p.id, p.state]), [['j1', 'done']]);
  assert.doesNotMatch(JSON.stringify(c.stored), /\[object/);
});

test('the log keeps at most 2000 events, dropping the oldest', () => {
  const snaps = [snap([dev({ reachable: true })], at(0))];
  for (let i = 1; i <= 2050; i++) snaps.push(snap([dev({ reachable: i % 2 === 1 ? false : true })], at(i)));
  snaps.push(snap([dev({ reachable: true })], at(2111)));      // same state, 61 s later: flush the save
  const { b, c } = drive(snaps);

  const ev = (c.stored as any).ev;
  assert.equal(ev.length, MAX_EVENTS);
  assert.equal(ev[0].t, at(51));                               // events 1..2050, the last 2000 start at 51
  assert.equal(ev[ev.length - 1].t, at(2050));
  assert.equal(b.view().stat, '2000 events kept · 2000 today');
  assert.equal(b.view().gauge, 100);
});

test('a non-finite ctx.now() still keeps the log bounded in memory', () => {
  const { c, ctx } = fakeCtx();
  ctx.now = () => Number.NaN;
  const b = create(ctx);
  let before: any = null;
  const first = snap([dev({ reachable: true })], at(0));
  b.observe(first, null); before = first;
  for (let i = 1; i <= 2050; i++) {
    const s = snap([dev({ reachable: i % 2 === 1 ? false : true })], at(i));
    b.observe(s, before); before = s;
  }
  assert.equal(b.view().stat, '2000 events kept · 2000 today');
  assert.equal(b.view().gauge, 100);
  assert.equal(c.saves, 0, 'no usable clock: nothing written, but memory stays bounded');
});

test('events older than 90 days are dropped when the hour comes, even with no new change', () => {
  const later = at(5) + 91 * DAY;
  const { b } = drive([
    snap([], at(0)),
    snap([dev()], at(5)),                    // appeared
    snap([dev()], later),                    // one far look: recorded, the prune anchor waits for a second
    snap([dev()], later + 2 * 3_600_000),    // the next look agrees; the hour is due and the old event drops
  ]);
  const v = b.view();
  assert.equal(v.stat, '0 events kept · 0 today');
  assert.deepEqual(v.rows[0], ['kept since', 'nothing yet']);
  assert.equal(v.note, 'nothing yet.');
});

test('the notes remember only the first 100 devices; the rest are ignored, also after a restart', () => {
  const fleet = (n: number, reachable: (i: number) => boolean) =>
    Array.from({ length: n }, (_, i) => dev({ id: `d${i}`, name: `dev ${i}`, reachable: reachable(i) }));

  const { c, ctx } = fakeCtx();
  const b1 = create(ctx);
  c.t = T;
  const s0 = snap(fleet(105, () => true), T);
  b1.observe(s0, null);
  assert.equal((c.stored as any).state.devices.length, 100);

  c.t = T + 5_000;
  const s1 = snap(fleet(105, (i) => i !== 104), T + 5_000);                    // only a device past the cap changes
  b1.observe(s1, s0);

  c.t = T + 10_000;
  const s2 = snap(fleet(105, (i) => i !== 0 && i !== 104), T + 10_000);        // a device inside the cap changes
  b1.observe(s2, s1);

  c.t = T + 70_000;
  b1.observe(snap(fleet(105, (i) => i !== 0 && i !== 104), T + 70_000), s2);   // flush
  assert.deepEqual((c.stored as any).ev.map((x: any) => [x.k, x.d]), [['down', 'd0']]);
  assert.equal((c.stored as any).state.devices.length, 100);

  // a restart: the five not remembered must not come back as "appeared"
  const b2 = create(ctx);
  c.t = T + 75_000;
  const s3 = snap(fleet(105, (i) => i !== 0 && i !== 104), T + 75_000);
  b2.observe(s3, null);
  assert.equal(b2.view().stat, '1 events kept · 1 today');

  c.t = T + 80_000;
  b2.observe(snap(fleet(105, (i) => i !== 0 && i !== 5 && i !== 104), T + 80_000), s3);
  assert.match(b2.view().lines[0], /^23:01  dev 5 stopped answering$/);
  assert.equal(b2.view().stat, '2 events kept · 2 today');
});

test('the notes remember only the first 100 projects; changes past the cap are ignored', () => {
  const jobs = (n: number, state: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => proj({ id: `j${i}`, state: state(i) }));
  const { c } = drive([
    snap([], T, work(), jobs(105, () => 'running')),
    snap([], T + 5_000, work(), jobs(105, (i) => (i === 0 || i === 104 ? 'done' : 'running'))),
    snap([], T + 70_000, work(), jobs(105, (i) => (i === 0 || i === 104 ? 'done' : 'running'))),   // flush
  ]);
  assert.deepEqual((c.stored as any).ev.map((x: any) => [x.k, x.d, x.x]), [['project', 'j0', 'done']]);
  assert.equal((c.stored as any).state.projects.length, 100);
});

test('the view: stat, gauge, kept since, counts of today, and the newest 40 lines', () => {
  const snaps = [snap([dev({ reachable: true })], at(0))];
  for (let i = 1; i <= 45; i++) snaps.push(snap([dev({ reachable: i % 2 === 1 ? false : true })], at(i)));
  const { b } = drive(snaps);

  const v = b.view();
  assert.equal(v.stat, '45 events kept · 45 today');
  assert.equal(v.gauge, 2);                                     // 45 of 2000 is 2.25%, rounded down
  assert.deepEqual(v.rows[0], ['kept since', '2026-11-08']);
  assert.deepEqual(v.rows[1], ['today', '22 up · 23 down']);
  assert.equal(v.lines.length, 40);
  assert.equal(v.lines[0], '23:00  pixel stopped answering');   // event 45
  assert.equal(v.lines[39], '23:00  pixel answers again');      // event 6
  assert.equal(v.note, undefined);
});

test('today is the local calendar day of the last snapshot, not of the oldest event', () => {
  const late = new Date(2026, 10, 8, 23, 59, 50).getTime();
  const { b } = drive([
    snap([], late),                                            // first look, 8 Nov
    snap([dev({ reachable: true })], late + 5_000),            // appeared, 23:59:55 on 8 Nov
    snap([dev({ reachable: false })], late + 15_000),          // down, 00:00:05 on 9 Nov
  ]);
  const v = b.view();
  assert.equal(v.stat, '2 events kept · 1 today');
  assert.deepEqual(v.rows[0], ['kept since', '2026-11-08']);
  assert.deepEqual(v.rows[1], ['today', '1 down']);
  assert.equal(v.gauge, 0);                                    // 2 / 2000 rounds to 0
  assert.deepEqual(v.lines, ['00:00  pixel stopped answering', '23:59  pixel appeared']);
});

test('the notes are saved at most once a minute and only when something changed', () => {
  const { c } = drive([
    snap([dev({ reachable: true })], at(0)),          // first look: save 1
    snap([dev({ reachable: false })], at(5)),         // a change, but the minute is not up
    snap([dev({ reachable: false })], at(59)),        // still not up
    snap([dev({ reachable: false })], at(61)),        // a minute since the save: save 2
    snap([dev({ reachable: false })], at(125)),       // nothing changed: no save, though a minute passed
  ]);
  assert.equal(c.saves, 2);
});

test('the notes hold no address, reason or trust data, and cut every string to 200', () => {
  const trust = {
    at: 1, error: null, id: 'ab'.repeat(16), alg: 'ed25519', pub: 'SECRET PUB', store: 'keystore', cert: 'SECRET CERT',
    certPinned: true, v1: false, paired: 1, self: 'ok', count: 3, head: 'SECRET HEAD', lines: ['SECRET LEDGER LINE'],
    restartedAt: null, rejectsDay: {}, rejectsLast: [],
  };
  const longName = 'n'.repeat(300);
  const longFile = 'f'.repeat(300);
  const { b, c } = drive([
    snap([dev({ name: longName, reachable: true, where: '192.168.1.33:50551', reason: 'SECRET REASON', trust })], at(0)),
    snap([dev({ name: longName, reachable: false, where: '192.168.1.33:50551', reason: 'SECRET REASON', trust })], at(5)),
    snap([dev({ name: longName, reachable: false, holds: longFile, where: '192.168.1.33:50551', reason: 'SECRET REASON', trust })], at(10)),
    snap([dev({ name: longName, reachable: false, holds: longFile, where: '192.168.1.33:50551', reason: 'SECRET REASON', trust })], at(70)),
  ]);
  const out = leaked(b, c);
  assert.ok(!out.includes('192.168'), 'no address in the notes, the view or the feed');
  assert.ok(!out.includes('SECRET'), 'no reason, trust data or ledger line in the notes, the view or the feed');
  assert.deepEqual(c.feed, [], 'the branch emits nothing');
  const ev = (c.stored as any).ev;
  assert.deepEqual(ev.map((x: any) => x.k), ['down', 'holds']);
  assert.equal(ev[0].n.length, 200);
  assert.equal(ev[1].x.length, 200);
});

// ---- the high-water marks, the odd containers and the unusual ids

test('a far-future decision never silences the real ones, live and after a restart', () => {
  const far = T + 400 * DAY;
  const farD = decision(far, 'far');
  const five = decision(T + 5_000, 'five');
  const sixty = decision(T + 60_000, 'sixty');
  const later = decision(T + 130_000, 'one thirty');
  const dwork = (...ds: any[]) => work({ decisions: ds });
  const { c, ctx } = fakeCtx();

  const b = create(ctx);
  c.t = T;
  b.observe(snap([], T, dwork()), null);                                             // first look
  c.t = far;
  b.observe(snap([], far, dwork(farD)), snap([], T, dwork()));                        // one far-future decision
  c.t = T + 5_000;
  b.observe(snap([], T + 5_000, dwork(farD, five)), snap([], far, dwork(farD)));
  c.t = T + 60_000;
  b.observe(snap([], T + 60_000, dwork(farD, five, sixty)), snap([], T + 5_000, dwork(farD, five)));
  c.t = T + 120_000;
  b.observe(snap([], T + 120_000, dwork(farD, five, sixty)), snap([], T + 60_000, dwork(farD, five, sixty)));

  const again = create(ctx);
  c.t = T + 130_000;
  again.observe(snap([], T + 130_000, dwork(farD, five, sixty, later)), null);        // saved + new branch
  c.t = T + 190_000;
  again.observe(snap([], T + 190_000, dwork(farD, five, sixty, later)), snap([], T + 130_000, dwork(farD, five, sixty, later)));

  assert.deepEqual((c.stored as any).ev.map((x: any) => x.x), ['five', 'sixty', 'one thirty']);
  assert.equal((c.stored as any).lastDecisionAt, T + 130_000);
  assert.deepEqual(again.view().lines, [
    '23:02  one thirty',
    '23:01  sixty',
    '23:00  five',
  ]);
});

test('null containers and null entries are skipped, never a throw, in the look and in before', () => {
  const raw = (o: any) => ({ at: o.at, host: { name: 'mac', freeMb: 4000 }, devices: o.devices, work: o.work, models: [], projects: o.projects });
  const p = dev({ id: 'p1', reachable: true });
  const { c, ctx } = fakeCtx();
  const b = create(ctx);
  const steps = [
    raw({ at: at(0), devices: [p], work: work(), projects: [proj()] }),
    raw({ at: at(1), devices: null, work: null, projects: null }),
    raw({ at: at(2), devices: [null], work: { decisions: null }, projects: [null] }),
    raw({ at: at(3), devices: [null], work: { decisions: [null], loaded: null }, projects: [null] }),
    raw({ at: at(4), devices: [p], work: work({ decisions: [null] }), projects: [proj()] }),
    raw({ at: at(5), devices: [dev({ id: 'p1', reachable: false })], work: work(), projects: [proj({ state: 'done' })] }),
    raw({ at: at(65), devices: [dev({ id: 'p1', reachable: false })], work: work(), projects: [proj({ state: 'done' })] }),
  ];
  let before: any = null;
  for (const s of steps) {
    c.t = s.at;
    assert.doesNotThrow(() => b.observe(s, before));
    before = s;
  }
  assert.equal(b.view().stat, '4 events kept · 4 today');
  assert.deepEqual(b.view().lines, [
    '23:00  project j1 is now done',
    '23:00  pixel stopped answering',
    '23:00  pixel appeared',
    '23:00  pixel is gone',
  ]);
  assert.doesNotMatch(JSON.stringify(b.view()), /NaN|undefined|\[object/);
});

test('the ids __proto__ and constructor are ordinary ids, with no pollution', () => {
  const fleet = (reachable: boolean) => [
    dev({ id: '__proto__', name: 'proto', reachable }),
    dev({ id: 'constructor', name: 'ctor', reachable }),
  ];
  const { c, ctx } = drive([
    snap(fleet(true), at(0)),
    snap(fleet(false), at(5)),
    snap(fleet(false), at(65)),          // flush the save
  ]);
  assert.deepEqual((c.stored as any).ev.map((x: any) => [x.k, x.d, x.n]), [
    ['down', '__proto__', 'proto'],
    ['down', 'constructor', 'ctor'],
  ]);
  assert.deepEqual((c.stored as any).state.devices.map((d: any) => d.id), ['__proto__', 'constructor']);
  assert.equal(({} as any).name, undefined);
  assert.equal(({} as any).polluted, undefined);

  const again = create(ctx);
  again.observe(snap(fleet(true), at(70)), null);
  assert.deepEqual(again.view().lines.slice(0, 2), ['23:01  ctor answers again', '23:01  proto answers again']);
  assert.equal(({} as any).name, undefined);
});

test('an id over 200 chars is skipped, so a cut id is never compared with a full one', () => {
  const long = 'x'.repeat(201);
  const fleet = (reachable: boolean) => [dev({ id: long, name: 'long', reachable }), dev({ id: 'p1', reachable })];
  const jobs = (state: string) => [proj({ id: long, state }), proj({ id: 'j1', state })];
  const { c, ctx } = drive([
    snap(fleet(true), at(0), work(), jobs('running')),
    snap(fleet(false), at(5), work(), jobs('done')),
    snap(fleet(false), at(65), work(), jobs('done')),   // flush the save
  ]);
  assert.deepEqual((c.stored as any).ev.map((x: any) => [x.k, x.d, x.x]), [['down', 'p1', null], ['project', 'j1', 'done']]);
  assert.deepEqual((c.stored as any).state.devices.map((d: any) => d.id), ['p1']);
  assert.deepEqual((c.stored as any).state.projects.map((p: any) => p.id), ['j1']);

  const again = create(ctx);
  again.observe(snap(fleet(false), at(70), work(), jobs('done')), null);
  assert.equal(again.view().stat, '2 events kept · 2 today', 'no appeared or gone for the long id after a restart');
});

test('a duplicated device id keeps its first entry, so it is not logged on every look', () => {
  const withDup = () => [dev({ id: 'p1', name: 'first', reachable: true }), dev({ id: 'p1', name: 'second', reachable: false })];
  const snaps = [snap(withDup(), at(0))];
  for (let i = 1; i <= 10; i++) snaps.push(snap(withDup(), at(i)));
  const { b, c } = drive(snaps);
  assert.equal(b.view().stat, '0 events kept · 0 today');
  assert.deepEqual(b.view().lines, []);
  assert.equal((c.stored as any).state.devices.length, 1);
  assert.equal((c.stored as any).state.devices[0].name, 'first');
});

test('one far-future look does not let the hourly prune wipe the real history', () => {
  const real = [snap([dev({ reachable: true })], at(0))];
  for (let i = 1; i <= 50; i++) real.push(snap([dev({ reachable: i % 2 === 1 ? false : true })], at(i)));
  const far = snap([dev({ reachable: false })], T + 400 * DAY);

  // live: the far look is recorded, then the clock is right again
  const live = drive([...real, far, snap([dev({ reachable: true })], at(60)), snap([dev({ reachable: true })], at(120))]);
  const ev = (live.c.stored as any).ev;
  assert.equal(ev.length, 51);
  assert.deepEqual(ev.slice(0, 50).map((x: any) => x.t), Array.from({ length: 50 }, (_, i) => at(i + 1)));
  assert.ok(ev.every((x: any) => x.t <= at(60)), 'the far-future event is gone, the 50 real ones stayed');
  assert.equal(live.b.view().stat, '51 events kept · 51 today');

  // after a restart from notes written while the bad clock was up
  const { c, ctx } = drive([...real, far]);
  assert.equal((c.stored as any).ev.length, 51);        // the 50 real ones and the far down
  const again = create(ctx);
  again.observe(snap([dev({ reachable: true })], at(60)), null);
  const after = (c.stored as any).ev;
  assert.equal(after.length, 51);                       // 50 real + the up, the far one pruned away
  assert.ok(after.every((x: any) => x.t <= at(60)));
});

test('a non-string mode, state or file is missing, never [object Object]', () => {
  const badLoaded = { mode: { bad: true }, model: { id: 'q', name: 42, file: { bad: true }, size: 1 }, ctx: 1, since: 0, devices: [] };
  const { b, c } = drive([
    snap([], at(0)),
    snap([dev({ name: { bad: true } })], at(5), work({ loaded: badLoaded }), [proj({ state: { bad: true } })]),
    snap([dev({ name: { bad: true } })], at(65), work({ loaded: badLoaded }), [proj({ state: { bad: true } })]),   // flush
  ]);
  assert.doesNotMatch(JSON.stringify(b.view()), /NaN|undefined|\[object/);
  assert.doesNotMatch(JSON.stringify(c.stored), /NaN|undefined|\[object/);
  assert.equal(b.view().lines[0], '23:00  the model loaded: 42 · ');
  assert.equal((c.stored as any).state.projects.length, 0, 'a project with no state text is not kept');
});
