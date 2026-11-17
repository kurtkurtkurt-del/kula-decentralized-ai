// accept / reject cards (17.11.2026, DECISIONS 5, E1): a card that can name a change carries it;
// accept applies it, reject turns it down and sticks (7 days, 30 from the second, 24 hours for a
// warning), × stays the quiet hide. The eye only keeps the books: kula's engine does the work.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-accept-reject-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { GodsEye, cleanCard, cleanAction, dark, memoryNotes, BRANCH_IDS } = await import('../src/godseye/index.ts');
const { isChange, needsConfirm, changeWords } = await import('../src/godseye/change.ts');
const { openBox } = await import('../src/godseye/box.ts');

const HOUR = 3_600_000, DAY = 24 * HOUR, MIN = 60_000;

const snap = (at = 1000): any => ({
  at, host: { name: 'mac', freeMb: 4000, anchor: { on: false, reachable: null, links: 0, bytesDay: 0, capDay: 2e9 } },
  devices: [
    { id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: 'lan', reachable: true, reachMs: 5, reason: null, checkedAt: at, lastOk: null, ramMb: 6000, bwGBs: null, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null },
    { id: 'p2', name: 'galaxy', kind: 'phone', via: 'wifi', where: 'lan', reachable: true, reachMs: 5, reason: null, checkedAt: at, lastOk: null, ramMb: 6000, bwGBs: null, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null },
  ],
  work: {
    loaded: { mode: 'here', model: { id: 'tiny', name: 'Tiny 1B', file: 'tiny.gguf', size: 1e9 }, ctx: 4096, since: 0, devices: [] },
    loading: null, chatting: 0, plan: [], decisions: [], llama: true,
  },
  models: [
    { id: 'tiny', name: 'Tiny 1B', file: 'tiny.gguf', size: 1e9, quant: null, params_b: 1, catalog: true, here: true, needMb: 1500 },
    { id: 'qwen3-4b', name: 'Qwen3 4B', file: 'q.gguf', size: 2.5e9, quant: null, params_b: 4, catalog: true, here: false, needMb: 3500 },
  ],
  projects: [{ id: 'n1', title: 'night essay', request: 'r', start: 0, end: 1, state: 'waiting', mode: 'apart', model: 'tiny', peers: [] }],
});

const load = { do: 'load', model: 'qwen3-4b', mode: 'apart', devices: ['p1', 'p2'] };
const cap = { do: 'cap', gb: 4, from: 2 };
const anchor = { do: 'anchor', on: true };
const cancel = { do: 'cancel', project: 'n1' };

/** an eye whose planner says what `say.list` holds and every other branch keeps quiet; the clock is `clock.at` */
function eyeOf(say: { list: unknown[] }, clock: { at: number }, extra: Record<string, unknown> = {}) {
  const quiet = Object.fromEntries(BRANCH_IDS.map((id: string) => [id, () => ({ id, observe() {}, view: () => ({ ...dark(), built: true, stat: 'x' }) })]));
  const eye = new GodsEye({
    snapshot: () => snap(clock.at), dir: path.join(HOME, String(Math.random())), now: () => clock.at,
    makers: { ...quiet, planner: () => ({ id: 'planner', observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: say.list as any }) }) },
    ...extra,
  } as any);
  eye.tick();
  return eye;
}
const ids = (eye: any) => eye.view().cards.map((c: any) => c.id);

test('cap, anchor and cancel cards survive cleanCard; malformed ones are dropped', () => {
  assert.deepEqual(cleanAction(cap), cap);
  assert.deepEqual(cleanAction({ ...cap, extra: 1 }), cap);
  assert.deepEqual(cleanAction(anchor), anchor);
  assert.deepEqual(cleanAction(cancel), cancel);
  for (const bad of [
    { do: 'cap', gb: 0, from: 2 }, { do: 'cap', gb: -1, from: 2 }, { do: 'cap', gb: NaN, from: 2 }, { do: 'cap', gb: Infinity, from: 2 },
    { do: 'cap', gb: 100001, from: 2 }, { do: 'cap', gb: '4', from: 2 }, { do: 'cap', gb: 4 }, { do: 'cap', gb: 4, from: 0 },
    { do: 'anchor', on: false }, { do: 'anchor', on: 'true' }, { do: 'anchor' },
    { do: 'cancel', project: '' }, { do: 'cancel', project: 'x'.repeat(201) }, { do: 'cancel', project: 7 }, { do: 'cancel' },
  ]) {
    assert.equal(cleanAction(bad), null, JSON.stringify(bad));
    assert.equal(cleanCard({ id: 'trust:anchor-cap', kind: 'suggest', title: 't', why: 'w', action: bad }), null, `card with ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(cleanAction({ do: 'cancel', project: 'x'.repeat(200) }), { do: 'cancel', project: 'x'.repeat(200) });
  for (const a of [cap, anchor, cancel]) assert.deepEqual(cleanCard({ id: 'trust:anchor-cap', kind: 'suggest', title: 't', why: 'w', action: a })?.action, a);
});

test('isChange, needsConfirm and changeWords name what accept changes, from the action alone', () => {
  for (const a of [load, { do: 'unload' }, { do: 'fetch', model: 'qwen3-4b' }, cap, anchor, cancel]) assert.equal(isChange(a as any), true, a.do);
  for (const a of [{ do: 'probe', devices: ['p1'] }, { do: 'open', panel: 'devices' }, null]) assert.equal(isChange(a as any), false, JSON.stringify(a));
  assert.deepEqual([load, { do: 'unload' }, { do: 'fetch', model: 'x' }, cap, anchor, cancel].map((a) => needsConfirm(a as any)), [false, false, false, false, true, true]);
  const s = snap(1);
  assert.match(changeWords(load as any, s)!, /Qwen3 4B.*pixel.*galaxy/);
  assert.match(changeWords({ do: 'load', model: 'qwen3-4b', mode: 'here', devices: [] } as any, s)!, /this computer/);
  assert.match(changeWords({ do: 'unload' } as any, s)!, /Tiny 1B/);
  assert.match(changeWords({ do: 'fetch', model: 'qwen3-4b' } as any, s)!, /Qwen3 4B.*no undo/);
  assert.match(changeWords(cap as any, s)!, /2 GB.*4 GB/);
  assert.match(changeWords(anchor as any, s)!, /internet.*starts sharing.*open streams/);
  assert.match(changeWords(anchor as any, s)!, /undo turns the anchor off and puts sharing back as it was/, 'verdict B1: undo restores sharing');
  assert.match(changeWords(cancel as any, s)!, /night project.*no undo/);
  assert.doesNotMatch(changeWords(cancel as any, s)!, /night essay/);  // the title is private text
  assert.match(changeWords(load as any, null)!, /qwen3-4b/, 'without a look it still says the change');
  assert.equal(changeWords({ do: 'probe', devices: ['p1'] } as any, s), null);
  assert.equal(changeWords(null, s), null);
});

test('a view card carries change, confirm and does; a look card carries no change', () => {
  const clock = { at: 10 * DAY };
  const eye = eyeOf({ list: [
    { id: 'planner:split:m', kind: 'suggest', title: 'split', why: 'w', action: load },
    { id: 'planner:anchor', kind: 'suggest', title: 'anchor', why: 'w', action: anchor },
    { id: 'planner:look', kind: 'warn', title: 'look', why: 'w', action: { do: 'probe', devices: ['p1'] } },
    { id: 'planner:know', kind: 'warn', title: 'know', why: 'w', action: null },
  ] }, clock);
  const by = Object.fromEntries(eye.view().cards.map((c: any) => [c.id, c]));
  assert.equal(by['planner:split:m'].change, true);
  assert.equal(by['planner:split:m'].confirm, false);
  assert.match(by['planner:split:m'].does, /Qwen3 4B/);
  assert.equal(by['planner:anchor'].change, true);
  assert.equal(by['planner:anchor'].confirm, true);
  assert.equal(by['planner:look'].change, false);
  assert.equal(by['planner:look'].confirm, false);
  assert.equal(by['planner:look'].does, undefined);
  assert.equal(by['planner:know'].change, false);
});

test('reject on a probe, open or knowledge card returns false; an unknown id too', () => {
  const clock = { at: 10 * DAY };
  const eye = eyeOf({ list: [
    { id: 'planner:look', kind: 'warn', title: 'look', why: 'w', action: { do: 'probe', devices: ['p1'] } },
    { id: 'planner:open', kind: 'warn', title: 'open', why: 'w', action: { do: 'open', panel: 'devices' } },
    { id: 'planner:know', kind: 'warn', title: 'know', why: 'w', action: null },
  ] }, clock);
  for (const id of ['planner:look', 'planner:open', 'planner:know', 'planner:none']) assert.equal(eye.reject(id), false, id);
  assert.deepEqual(ids(eye).sort(), ['planner:know', 'planner:look', 'planner:open']);
});

test('a rejected suggestion sticks when its reason goes and comes back (× does not), shows after 7 days, hides 30 from the second reject, then comes back lighter', () => {
  const T0 = 100 * DAY;
  const clock = { at: T0 };
  const split = { id: 'planner:split:m', kind: 'suggest', title: 'split', why: 'w', action: load, weight: 2 };
  const alone = { id: 'planner:alone:m', kind: 'suggest', title: 'alone', why: 'w', action: { do: 'unload' } };
  const say = { list: [split, alone] as unknown[] };
  const eye = eyeOf(say, clock);
  assert.equal(eye.reject('planner:split:m'), true);
  assert.equal(eye.dismiss('planner:alone:m'), true);
  assert.equal(eye.reject('planner:split:m'), false, 'a hidden card is not a card');
  clock.at += 5000; eye.tick();
  assert.deepEqual(ids(eye), []);
  say.list = []; clock.at += 5000; eye.tick();
  say.list = [split, alone]; clock.at += 5000; eye.tick();
  assert.deepEqual(ids(eye), ['planner:alone:m'], 'the reason went and came back: × shows again, reject does not');
  clock.at = T0 + 7 * DAY - MIN; eye.tick();
  assert.ok(!ids(eye).includes('planner:split:m'), 'inside 7 days: hidden');
  clock.at = T0 + 7 * DAY + MIN; eye.tick();
  assert.ok(ids(eye).includes('planner:split:m'), 'after 7 days: back');
  assert.equal(eye.card('planner:split:m')!.weight, 2, 'one reject: its weight stands');
  const T1 = clock.at;
  assert.equal(eye.reject('planner:split:m'), true);
  clock.at = T1 + 29 * DAY; eye.tick();
  assert.ok(!ids(eye).includes('planner:split:m'), 'the second reject: 30 days');
  clock.at = T1 + 30 * DAY + MIN; eye.tick();
  assert.ok(ids(eye).includes('planner:split:m'), 'after 30 days: back');
  assert.equal(eye.card('planner:split:m')!.weight, 1, 'rejected twice: it comes back at weight 1');
});

test('a rejection ends when the card says another kind of action: that is a new card', () => {
  const clock = { at: 10 * DAY };
  const say = { list: [{ id: 'planner:split:m', kind: 'suggest', title: 'split', why: 'w', action: load }] as unknown[] };
  const eye = eyeOf(say, clock);
  eye.reject('planner:split:m');
  say.list = [{ id: 'planner:split:m', kind: 'suggest', title: 'split', why: 'w', action: { ...load, devices: ['p1'] } }];
  clock.at += 5000; eye.tick();
  assert.deepEqual(ids(eye), [], 'only its devices changed: still rejected');
  say.list = [{ id: 'planner:split:m', kind: 'suggest', title: 'split', why: 'w', action: { do: 'unload' } }];
  clock.at += 5000; eye.tick();
  assert.deepEqual(ids(eye), ['planner:split:m'], 'unload is another change');
});

test('a rejected warning hides 24 hours, also the second time', () => {
  const T0 = 10 * DAY;
  const clock = { at: T0 };
  const warn = { id: 'planner:barred:p1', kind: 'warn', title: 'barred', why: 'w', action: { do: 'unload' }, weight: 3 };
  const eye = eyeOf({ list: [warn] }, clock);
  assert.equal(eye.reject('planner:barred:p1'), true);
  clock.at = T0 + 23 * HOUR; eye.tick();
  assert.deepEqual(ids(eye), []);
  clock.at = T0 + 24 * HOUR + MIN; eye.tick();
  assert.deepEqual(ids(eye), ['planner:barred:p1']);
  const T1 = clock.at;
  assert.equal(eye.reject('planner:barred:p1'), true);
  clock.at = T1 + 24 * HOUR + MIN; eye.tick();
  assert.deepEqual(ids(eye), ['planner:barred:p1'], 'a warning never hides longer than a day');
  assert.equal(eye.card('planner:barred:p1')!.weight, 3, 'a warning keeps its weight');
});

test('a rejection survives a new eye on the same notes, and forget() clears it', () => {
  const clock = { at: 10 * DAY };
  const notes = memoryNotes();
  const say = { list: [{ id: 'planner:split:m', kind: 'suggest', title: 'split', why: 'w', action: load }] };
  const eye = eyeOf(say, clock, { notes });
  assert.equal(eye.reject('planner:split:m'), true);
  const again = eyeOf(say, clock, { notes });
  assert.deepEqual(ids(again), [], 'a restart keeps the rejection');
  assert.ok(again.forget() >= 1, 'the cards notes went');
  again.tick();
  assert.deepEqual(ids(again), ['planner:split:m']);
  assert.deepEqual(ids(eyeOf(say, clock, { notes })), ['planner:split:m'], 'and stays gone after a restart');
});

test('the box holds a reject act, the feed says what was accepted and rejected, and the card says its branch record', () => {
  const clock = { at: 10 * DAY };
  const dir = path.join(HOME, 'box');
  const say = { list: [
    { id: 'planner:split:m', kind: 'suggest', title: 'split it', why: 'w', action: load },
    { id: 'planner:alone:m', kind: 'suggest', title: 'alone', why: 'w', action: { do: 'unload' } },
    { id: 'planner:fetch:q', kind: 'suggest', title: 'fetch qwen', why: 'w', action: { do: 'fetch', model: 'qwen3-4b' } },
  ] };
  const eye = eyeOf(say, clock, { box: { dir } });
  eye.applied('planner:split:m', 'loading qwen3-4b (apart)');
  assert.equal(eye.reject('planner:alone:m'), true);
  clock.at += 5000; eye.tick();
  const feed = eye.view().events.map((e: any) => `${e.branch} ${e.text}`);
  assert.ok(feed.some((t: string) => /^planner you accepted: split it: loading qwen3-4b/.test(t)), feed.join('\n'));
  assert.ok(feed.some((t: string) => /^planner you rejected: alone/.test(t)), feed.join('\n'));
  const acts = openBox({ dir }).read({ kind: 'act', limit: 100 }).map((r: any) => [r.b, r.x.action]);
  assert.deepEqual(acts, [['planner', 'apply'], ['planner', 'reject']]);
  assert.deepEqual(eye.card('planner:fetch:q')!.record, { accepted: 1, rejected: 1 }, 'its branch: one of each in 30 days');
  clock.at += 31 * DAY; eye.tick();
  assert.equal(eye.card('planner:fetch:q')!.record, undefined, 'older than 30 days: no record');
});

test('undo is one deep and lives 10 minutes; undone counts as a reject; the next accept clears it; fetch has none', () => {
  const clock = { at: 10 * DAY };
  const before = { do: 'load', model: 'tiny', mode: 'here', devices: [] };
  const say = { list: [
    { id: 'planner:split:m', kind: 'suggest', title: 'split it', why: 'w', action: load },
    { id: 'planner:cap', kind: 'suggest', title: 'raise', why: 'w', action: cap },
    { id: 'planner:fetch:q', kind: 'suggest', title: 'fetch', why: 'w', action: { do: 'fetch', model: 'qwen3-4b' } },
  ] };
  const eye = eyeOf(say, clock);
  assert.equal(eye.view().undo, null);
  eye.applied('planner:split:m', 'loading', before);
  const u = eye.view().undo!;
  assert.equal(u.id, 'planner:split:m');
  assert.equal(u.until, clock.at + 10 * MIN);
  assert.deepEqual(eye.pendingUndo()!.action, before);
  clock.at += 10 * MIN + 1; eye.tick();
  assert.equal(eye.view().undo, null, 'ten minutes: gone');
  assert.equal(eye.undone('x'), false);

  eye.applied('planner:cap', 'the cap is 4 GB', { do: 'cap', gb: 2, from: 4 });
  assert.equal(eye.view().undo!.id, 'planner:cap');
  eye.applied('planner:fetch:q', 'fetching', { do: 'unload' });
  assert.equal(eye.view().undo, null, 'the next accept clears it, and a fetch has no undo');

  say.list.push({ id: 'planner:alone:m', kind: 'suggest', title: 'alone', why: 'w', action: { do: 'unload' } });
  clock.at += 5000; eye.tick();
  eye.applied('planner:alone:m', 'unloaded', before);
  assert.equal(eye.undone('loaded tiny again'), true);
  assert.equal(eye.view().undo, null);
  assert.equal(eye.undone('again'), false, 'one deep');
  assert.ok(eye.view().events.some((e: any) => /^you undid: alone: loaded tiny again/.test(e.text)));
  say.list = say.list.filter((c) => c.id !== 'planner:alone:m');
  clock.at += 5000; eye.tick();
  say.list.push({ id: 'planner:alone:m', kind: 'suggest', title: 'alone', why: 'w', action: { do: 'unload' } });
  clock.at += 5000; eye.tick();
  assert.ok(!ids(eye).includes('planner:alone:m'), 'undone: rejected, it does not bounce back');
});

test('an accept whose card went while its change ran (verdict B2) is still recorded, in the feed and the box, with its undo', () => {
  const clock = { at: 10 * DAY };
  const dir = path.join(HOME, 'gone-box');
  const before = { do: 'load', model: 'tiny', mode: 'here', devices: [] };
  const say = { list: [
    { id: 'planner:alone:m', kind: 'suggest', title: 'alone', why: 'w', action: { do: 'unload' } },
    { id: 'planner:fetch:q', kind: 'suggest', title: 'fetch qwen', why: 'w', action: { do: 'fetch', model: 'qwen3-4b' } },
  ] };
  const eye = eyeOf(say, clock, { box: { dir } });
  const c = eye.card('planner:alone:m')!;
  assert.ok(c, 'the card the person tapped');
  // the unload ran, and the next look no longer says the card (its reason went with the model)
  say.list = say.list.filter((x) => x.id !== 'planner:alone:m');
  clock.at += 5000; eye.tick();
  assert.equal(eye.card('planner:alone:m'), null, 'gone before applied is called');
  eye.applied('planner:alone:m', 'unloaded', before, c);
  const acts = openBox({ dir }).read({ kind: 'act', limit: 100 }).map((r: any) => [r.b, r.x.action, r.x.word]);
  assert.deepEqual(acts, [['planner', 'apply', 'unloaded']], 'the box holds the accept');
  assert.ok(eye.view().events.some((e: any) => /^you accepted: alone: unloaded/.test(e.text)), 'the feed says it');
  assert.equal(eye.view().undo?.id, 'planner:alone:m', 'and it can be undone');
  assert.deepEqual(eye.pendingUndo()!.action, before);
  assert.deepEqual(eye.card('planner:fetch:q')!.record, { accepted: 1, rejected: 0 }, 'its branch: one accept');
  // a card held under another id is not taken for this one
  eye.applied('planner:other', 'x', before, c);
  assert.equal(openBox({ dir }).read({ kind: 'act', limit: 100 }).length, 1, 'nothing more written');
});
