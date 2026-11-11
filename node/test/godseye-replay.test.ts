// The night replay (src/godseye/replay.ts, the page's replay.js, `kula-node brain replay`): a
// stretch of the black box rebuilt from its keys and deltas into at most 600 frames, the chain
// checked over the stretch, nothing in a frame that is not one of the facts, guests kept out.
// The box is written here record by record the way the eye writes it (keys, looks as deltas,
// feed lines, verdicts, the eye's start and stop), so every number below can be worked out by hand.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-replay-'));
process.env.KULA_NODE_HOME = path.join(ROOT, 'home');
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const NODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { openBox } = await import('../src/godseye/box.ts');
const { facts, diff, keyChunks, lookPayload } = await import('../src/godseye/boxfacts.ts');
const { buildReplay, replayBox, replayText, lastNight, nightOf, FRAMES_MAX } = await import('../src/godseye/replay.ts');
const { GodsEye } = await import('../src/godseye/index.ts');
const { brainCommand, timeArg } = await import('../src/braincmd.ts');
const rp = await import('../src/ui/static/replay.js');
const { UI_STATIC, startUi } = await import('../src/ui/server.ts');
const { Engine } = await import('../src/ui/engine.ts');
const { ChatStore } = await import('../src/ui/store.ts');
const { createIdentity } = await import('../src/tls.ts');
const { writePeers } = await import('../src/peers.ts');

let made = 0;
const fresh = (name: string): string => path.join(ROOT, `${name}-${++made}`);
const MIN = 60_000;
const T0 = new Date(2026, 10, 10, 22, 0, 0, 0).getTime();   // 22:00 local, an evening

// ---- a look the way the engine hands it over, with the private parts the box must never keep

type Shape = { busy?: Record<string, number>; done?: Record<string, number>; loaded?: boolean; gone?: string[] };
const dev = (id: string, o: Record<string, unknown> = {}) => ({
  id, name: `device ${id}`, kind: 'phone', via: id === 'b' ? 'cable' : 'wifi', where: '10.0.0.1:50551',
  reachable: true, reachMs: 12, reason: null, checkedAt: 900, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null,
  tls: true, waitingPair: false, plugged: id === 'b' ? true : null, holds: null,
  trust: { at: 1, error: null, id: 'f'.repeat(32), alg: 'ed25519', pub: 'PUBKEYSECRET', store: 'keystore', cert: 'CERTSECRET', certPinned: true, v1: false, paired: 1, self: 'ok', count: 3, head: 'h', lines: ['LEDGERLINESECRET'], restartedAt: null, rejectsDay: {}, rejectsLast: [{ t: 1, why: 'x', peer: '10.9.9.9' }] },
  ...o,
});
function snap(t: number, s: Shape = {}) {
  const ids = ['local', 'a'];
  return {
    at: t, host: { name: 'mac', freeMb: 4000, ledger: { ok: true, count: 1, problem: 'LEDGERPROBLEMSECRET' } },
    devices: [dev('a'), dev('b'), ...(s.gone ?? []).map((id) => dev(id, { reachable: false, reason: 'refused at 10.0.0.7' }))],
    work: {
      loaded: s.loaded ? {
        mode: 'apart', model: { id: 'm1', name: 'model one', file: 'm1.gguf', size: 1e9 }, ctx: 4096, since: T0 + 5 * MIN,
        devices: ids.map((id) => ({ id, name: id, local: id === 'local', busy: id in (s.busy ?? {}), tps: s.busy?.[id] ?? null, done: s.done?.[id] ?? 0 })),
      } : null,
      loading: null, chatting: 0, plan: ['PLANSECRET'], decisions: [{ at: 1, text: 'DECISIONSECRET' }], llama: true,
    },
    models: [{ id: 'm1', name: 'model one', file: 'm1.gguf', size: 1e9, quant: 'q4', params_b: 1, catalog: true, here: true, needMb: 900 }],
    projects: [{ id: 'p1', title: 'TITLESECRET', request: 'REQUESTSECRET', start: T0, end: T0 + 60 * MIN, state: 'running', mode: 'apart', model: 'm1', peers: ['a'], line: 'LINESECRET', error: 'ERRORSECRET' }],
  };
}

/** the eye's writing, by hand: a key the first time and when asked, a delta after it */
function writer(dir: string) {
  const box = openBox({ dir });
  let last: ReturnType<typeof facts> | null = null;
  return {
    box,
    look(t: number, s: Shape, key = false) {
      const f = facts(snap(t, s) as never);
      if (last === null || key) for (const c of keyChunks(t, f)) assert.ok(box.append(t, 'key', null, c));
      else assert.ok(box.append(t, 'look', null, lookPayload(t, diff(last, f), null, null)));
      last = f;
    },
    feed: (t: number, branch: string, text: unknown) => assert.ok(box.append(t, 'feed', branch, { text })),
    verdict: (t: number, who: string, from: string | null, to: string) => assert.ok(box.append(t, 'verdict', 'trust', { who, from, to })),
    mark: (t: number, k: string, x: unknown = {}) => assert.ok(box.append(t, k, null, x)),
    forget() { last = null; },
  };
}

/** an hour from 22:00: looks every 10 s, a key again at 22:30, the model from 22:05, device a
 *  answering at 10 tok/s from 22:10 to 22:20 (one answer), a rest line, two verdicts */
function hour(dir: string, o: { stop?: [number, number] } = {}) {
  const w = writer(dir);
  w.mark(T0, 'start', { v: 1, everyMs: 10_000 });
  for (let t = T0; t <= T0 + 60 * MIN; t += 10_000) {
    if (o.stop && t >= T0 + o.stop[0] * MIN && t < T0 + o.stop[1] * MIN) {
      if (t === T0 + o.stop[0] * MIN) w.mark(t, 'stop');
      continue;
    }
    const m = (t - T0) / MIN;
    const restart = o.stop && t === T0 + o.stop[1] * MIN;
    if (restart) { w.mark(t, 'start', { v: 1, everyMs: 10_000 }); w.forget(); }
    const busy = m >= 10 && m < 20 ? { a: 10 } : {};
    w.look(t, { loaded: m >= 5, busy, done: { a: m >= 20 ? 1 : 0 } }, t === T0 + 30 * MIN);
    if (t === T0 + 2 * MIN) w.verdict(t, '*', null, 'ok');
    if (t === T0 + 15 * MIN) w.feed(t, 'limits', 'limits: device a should rest: answering for 20 min without a break');
    if (t === T0 + 40 * MIN) w.verdict(t, 'a', 'ok', 'bad');
  }
  return w;
}

const near = (x: number, want: number, slack: number, what: string) => assert.ok(Math.abs(x - want) <= slack, `${what}: ${x}, want ${want} ± ${slack}`);
const frameAt = (r: { from: number; step: number; frames: unknown[] }, t: number) => Math.floor((t - r.from) / r.step);

test('replay: an hour rebuilt from keys and deltas: the work, the tokens, the answers, the feed and the verdicts in their frames', () => {
  const dir = fresh('hour');
  const w = hour(dir);
  const r = buildReplay(w.box, { from: T0, to: T0 + 60 * MIN });
  assert.equal(r.frames.length, FRAMES_MAX, '3600 s at one look per 5 s is 720: capped at 600');
  assert.equal(r.step, 6000);
  assert.equal(r.summary.looks, 361);
  near(r.summary.workMs, 10 * MIN, 0, 'work');
  near(r.summary.tokens, 6000, 0, 'tokens: 10 tok/s for 600 s');
  assert.equal(r.summary.answers, 1);
  assert.equal(r.summary.devices, 1);
  assert.deepEqual(r.summary.byDevice.map((d) => [d.id, d.name, d.workMs, d.tokens, d.answers]), [['a', 'device a', 10 * MIN, 6000, 1]]);
  assert.deepEqual(r.summary.models, ['model one']);
  assert.equal(r.summary.rests, 1);
  assert.equal(r.summary.badVerdicts, 1);
  assert.equal(r.summary.offMs, 0);
  // 22:15: a is answering at 10 tok/s, the model is there, the rest line is in this frame
  const f = r.frames[frameAt(r, T0 + 15 * MIN)];
  const a = f.devices.find((d) => d.id === 'a')!;
  assert.deepEqual([a.busy, a.tps, a.loaded, a.present, a.via], [true, 10, true, true, 'wifi']);
  assert.equal(f.devices.find((d) => d.id === 'b')!.plugged, true);
  assert.equal(f.devices.find((d) => d.id === 'local')!.name, 'mac');
  assert.deepEqual([f.model, f.mode, f.off], ['model one', 'apart', false]);
  assert.deepEqual(f.feed.map((l) => [l.branch, l.text]), [['limits', 'limits: device a should rest: answering for 20 min without a break']]);
  // before the model, nothing loaded; the counters only grow; the verdicts as of each frame
  assert.equal(r.frames[0].model, null);
  for (let i = 1; i < r.frames.length; i++) assert.ok(r.frames[i].tokens >= r.frames[i - 1].tokens && r.frames[i].workMs >= r.frames[i - 1].workMs);
  assert.equal(r.frames[r.frames.length - 1].tokens, 6000);
  assert.deepEqual(r.frames[frameAt(r, T0 + 10 * MIN)].verdicts, { '*': 'ok' });
  assert.deepEqual(r.frames[r.frames.length - 1].verdicts, { '*': 'ok', a: 'bad' });
  assert.ok(r.frames[0].marks.includes('start'));
  assert.deepEqual([r.chain.ok, r.chain.whole, r.records.from], [true, true, 1]);
  assert.deepEqual(r.devices.map((d) => d.id).sort(), ['a', 'b', 'local']);
});

test('replay: the frame count is capped at 600 and at what is asked, and never finer than one look', () => {
  const dir = fresh('cap');
  const w = hour(dir);
  assert.equal(buildReplay(w.box, { from: T0, to: T0 + 60 * MIN, frames: 50 }).frames.length, 50);
  assert.equal(buildReplay(w.box, { from: T0, to: T0 + 60 * MIN, frames: 100_000 }).frames.length, 600);
  assert.equal(buildReplay(w.box, { from: T0, to: T0 + 60_000 }).frames.length, 12);
  // a week asked: still 600, and the totals do not change with the frame count
  const week = buildReplay(w.box, { from: T0 - 3 * 86_400_000, to: T0 + 4 * 86_400_000 });
  assert.equal(week.frames.length, 600);
  assert.equal(week.summary.tokens, 6000);
  assert.equal(buildReplay(w.box, { from: T0, to: T0 + 60 * MIN, frames: 7 }).summary.tokens, 6000);
});

test('replay: a stretch that starts mid-way is built on the key before it; by record numbers too', () => {
  const dir = fresh('mid');
  const w = hour(dir);
  // from 22:12: no key there, the one at 22:00 and its deltas give the state: a is answering
  const r = buildReplay(w.box, { from: T0 + 12 * MIN, to: T0 + 18 * MIN });
  assert.equal(r.frames[0].model, 'model one');
  assert.equal(r.frames[0].devices.find((d) => d.id === 'a')!.busy, true);
  near(r.summary.workMs, 6 * MIN, 10_000, 'work in six minutes');
  assert.equal(r.summary.answers, 0);
  // after the second key
  const late = buildReplay(w.box, { from: T0 + 45 * MIN, to: T0 + 50 * MIN });
  assert.equal(late.frames[0].model, 'model one');
  assert.deepEqual(late.frames[0].verdicts, { '*': 'ok', a: 'bad' }, 'the verdicts before the stretch carry into it');
  assert.equal(late.summary.workMs, 0);
  // records 100..200
  const byN = buildReplay(w.box, { fromN: 100, toN: 200 });
  assert.deepEqual([byN.records.from, byN.records.to, byN.records.count], [100, 200, 101]);
  assert.ok(byN.from < byN.to && byN.frames.length >= 1 && byN.frames.length <= 600);
  assert.equal(byN.frames[0].model, 'model one');
});

test('replay: a stretch the eye did not watch is off, and nothing is counted across it', () => {
  const dir = fresh('gap');
  // the eye stops at 22:15 while a is answering and starts again at 22:35
  const w = hour(dir, { stop: [15, 35] });
  const r = buildReplay(w.box, { from: T0, to: T0 + 60 * MIN });
  const off = r.frames.filter((f) => f.off);
  near(off.length * r.step, 20 * MIN, 2 * MIN, 'off');
  near(r.summary.offMs, 20 * MIN, 2 * MIN, 'offMs');
  assert.ok(r.frames[frameAt(r, T0 + 25 * MIN)].off);
  assert.deepEqual(r.frames[frameAt(r, T0 + 25 * MIN)].devices, []);
  assert.equal(r.frames[frameAt(r, T0 + 40 * MIN)].off, false);
  assert.ok(r.frames.some((f) => f.marks.includes('stop')));
  // 22:10:00 to the last look before the stop, 22:14:50: the last one is not followed by a watched look
  near(r.summary.workMs, 5 * MIN - 10_000, 0, 'only 22:10 to 22:15 is work');
  assert.equal(r.chain.ok, true);
  // the cli says it
  assert.match(replayText(r), /the eye was off for (19|20|21) min/);
});

test('replay: a broken chain is named, in the stretch or only elsewhere in the box', () => {
  const dir = fresh('broken');
  hour(dir);
  // one look in the middle of 22:10–22:20 rewritten: 10 tok/s becomes 99
  const file = path.join(dir, 'box-000001.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const i = lines.findIndex((l) => l.includes('"k":"look"') && l.includes('"tps":10'));
  assert.ok(i > 0);
  const n = JSON.parse(lines[i]).n;
  lines[i] = lines[i].replace('"tps":10', '"tps":99');
  fs.writeFileSync(file, lines.join('\n'));
  const box = openBox({ dir, readOnly: true });
  const r = buildReplay(box, { from: T0, to: T0 + 60 * MIN });
  assert.equal(r.chain.ok, false);
  assert.equal(r.chain.n, n);
  assert.match(r.chain.problem!, new RegExp(`record n ${n}: h does not match its line`));
  assert.match(replayText(r), /the chain does not hold: record n \d+/);
  // after the key at 22:30 the stretch is built on records that hold; the box as a whole does not
  const late = buildReplay(box, { from: T0 + 40 * MIN, to: T0 + 50 * MIN });
  assert.deepEqual([late.chain.ok, late.chain.whole], [true, false]);
  assert.match(late.chain.wholeProblem!, /h does not match/);
  assert.match(replayText(late), /elsewhere in the box: record n/);
  // a removed line breaks the link of the next one
  const dir2 = fresh('cut');
  hour(dir2);
  const f2 = path.join(dir2, 'box-000001.jsonl');
  const l2 = fs.readFileSync(f2, 'utf8').split('\n');
  l2.splice(50, 1);
  fs.writeFileSync(f2, l2.join('\n'));
  const cut = buildReplay(openBox({ dir: dir2, readOnly: true }), { from: T0, to: T0 + 60 * MIN });
  assert.equal(cut.chain.ok, false);
  assert.match(cut.chain.problem!, /record n 52: expected n 51/);
});

test('replay: a frame holds the facts only, field by field: no address, key, title, request, plan or smuggled field', () => {
  const dir = fresh('private');
  const w = hour(dir);
  // a key written with fields the facts do not have (a box changed by hand, chain and all)
  const t = T0 + 61 * MIN;
  const bad = { at: t, i: 0, of: 1, host: { name: 'mac', freeMb: 1, ledger: null, smuggled: 'SMUGGLEDSECRET' },
    work: { loaded: { mode: 'apart', model: { id: 'm1', file: 'm1.gguf', size: 1, where: 'SMUGGLEDSECRET' }, ctx: 1, since: 1, devices: [{ id: 'a', busy: true, tps: 3, done: 0, where: 'SMUGGLEDSECRET' }], parts: [] }, loading: null, chatting: 0, llama: true, planN: 0, decisionsN: 0, prompt: 'SMUGGLEDSECRET' },
    models: [], projects: [{ id: 'p', title: 'SMUGGLEDSECRET' }],
    devices: [{ ...facts(snap(t) as never).devices[0], where: '10.0.0.1:50551', secret: 'SMUGGLEDSECRET' }] };
  assert.ok(w.box.append(t, 'key', null, bad));
  w.feed(t, 'trust', { scrubbed: true, len: 40 });
  w.mark(t + 1, 'act', { action: 'accept', arg: 'SMUGGLEDSECRET' });
  const r = buildReplay(w.box, { from: T0, to: T0 + 62 * MIN });
  const text = JSON.stringify(r);
  for (const s of ['10.0.0.1', '10.0.0.7', '10.9.9.9', 'SECRET', 'refused at', 'm1.gguf']) assert.ok(!text.includes(s), s);
  const FRAME = ['answers', 'devices', 'feed', 'loading', 'marks', 'mode', 'model', 'off', 't', 'tokens', 'verdicts', 'workMs'];
  const DEVICE = ['answers', 'busy', 'id', 'kind', 'loaded', 'name', 'plugged', 'present', 'tps', 'via'];
  for (const f of r.frames) {
    assert.deepEqual(Object.keys(f).sort(), FRAME);
    for (const d of f.devices) assert.deepEqual(Object.keys(d).sort(), DEVICE);
    for (const l of f.feed) assert.deepEqual(Object.keys(l).sort(), ['branch', 't', 'text']);
  }
  assert.deepEqual(Object.keys(r).sort(), ['box', 'chain', 'devices', 'frames', 'from', 'range', 'records', 'step', 'summary', 'to']);
  assert.ok(r.frames.some((f) => f.feed.some((l) => l.text === '(a line with private words, kept out)')));
  // a model the key does not name by its list is called by its id, never by its file
  assert.equal(r.frames[r.frames.length - 1].model, 'm1');
});

test('replay: the real eye\'s box plays back, read by a reader that writes nothing', () => {
  const dir = fresh('eye');
  let now = T0;
  let busy = false;
  const eye = new GodsEye({ snapshot: () => snap(now, { loaded: true, busy: busy ? { a: 12 } : {}, done: { a: now > T0 + 2 * MIN ? 1 : 0 } }) as never, dir: path.join(dir, 'notes'), now: () => now, everyMs: 1e9, box: { dir: path.join(dir, 'box') }, log: () => {} });
  eye.start();
  for (let k = 1; k <= 40; k++) { now = T0 + k * 5000; busy = k >= 6 && k < 24; eye.tick(); }
  eye.stop();
  const boxDir = path.join(dir, 'box');
  const before = fs.readdirSync(boxDir).map((f) => `${f}:${fs.statSync(path.join(boxDir, f)).size}`).sort();
  const reader = openBox({ dir: boxDir, readOnly: true });
  assert.equal(reader.append(now, 'feed', null, {}), false, 'a reader never appends');
  const r = replayBox(reader, { from: T0, to: now });
  assert.equal(r.summary.looks, 41);
  near(r.summary.workMs, 18 * 5000, 0, 'eighteen looks answering');
  near(r.summary.tokens, 12 * 90, 0, 'tokens');
  assert.equal(r.chain.ok, true);
  assert.deepEqual(fs.readdirSync(boxDir).map((f) => `${f}:${fs.statSync(path.join(boxDir, f)).size}`).sort(), before, 'nothing on disk changed');
  assert.equal(openBox({ dir: path.join(dir, 'nowhere'), readOnly: true }).walk!(() => {}).count, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'nowhere')), 'a reader makes no dir');
});

test('replay: last night by default, the last 12 hours when the night is empty', () => {
  const night = lastNight(new Date(2026, 10, 11, 14, 0).getTime());
  assert.equal(night.from, new Date(2026, 10, 10, 18, 0).getTime());
  assert.equal(night.to, new Date(2026, 10, 11, 9, 0).getTime());
  const early = new Date(2026, 10, 11, 3, 0).getTime();
  assert.deepEqual(lastNight(early), { from: new Date(2026, 10, 10, 18, 0).getTime(), to: early });
  assert.deepEqual(nightOf('2026-11-10'), { from: new Date(2026, 10, 10, 18, 0).getTime(), to: new Date(2026, 10, 11, 9, 0).getTime() });
  assert.equal(nightOf('10.11.2026'), null);
  const dir = fresh('default');
  const w = hour(dir);
  // the hour is inside last night as seen at 14:00 the next day
  assert.equal(replayBox(w.box, {}, new Date(2026, 10, 11, 14, 0).getTime()).range, 'night');
  // two days later the night is empty: the last 12 hours, also empty, say so
  const r = replayBox(w.box, {}, new Date(2026, 10, 13, 14, 0).getTime());
  assert.equal(r.range, '12h');
  assert.equal(r.summary.looks, 0);
  assert.ok(r.frames.every((f) => f.off));
  assert.match(replayText(r), /no look in this stretch/);
  assert.deepEqual([r.box.first, r.box.records > 0], [T0, true]);
});

test('kula-node brain replay: a short summary of the stretch, the chain, and its exit code', () => {
  const dir = path.join(process.env.KULA_NODE_HOME!, 'godseye', 'box');
  const lines: string[] = [];
  const out = (s: string) => lines.push(s);
  assert.equal(brainCommand('replay', {}, out), 1, 'no box yet');
  assert.match(lines.join('\n'), /no black box yet/);
  hour(dir);
  lines.length = 0;
  assert.equal(brainCommand('replay', { night: '2026-11-10' }, out), 0);
  const text = lines.join('\n');
  assert.match(text, /^last night: |^Tue 10 Nov 18:00/m);
  assert.match(text, /1 device, 10 min of work, about 6 000 tokens \(from tok\/s\), 1 answer/);
  assert.match(text, /device a: 10 min, about 6 000 tokens, 1 answer/);
  assert.match(text, /model: model one/);
  assert.match(text, /1 rest warning · 1 trust warning/);
  assert.match(text, /records 1–\d+ \([\d ]+ records\): the chain holds/);
  lines.length = 0;
  assert.equal(brainCommand('replay', { from: String(T0), to: '2026-11-10T22:30', json: true }, out), 0);
  const j = JSON.parse(lines.join('\n'));
  assert.equal(j.summary.tokens, 6000);
  assert.equal(j.frames, undefined, 'the frames are for the page');
  assert.equal(brainCommand('replay', { night: 'yesterday' }, out), 2);
  assert.equal(brainCommand('replay', { from: 'soon' }, out), 2);
  assert.equal(brainCommand('nope', {}, out), 2);
  assert.equal(timeArg('2026-11-10'), new Date(2026, 10, 10).getTime());
  assert.equal(timeArg('2026-11-10 18:30'), new Date(2026, 10, 10, 18, 30).getTime());
  assert.equal(timeArg('1794330000000'), 1794330000000);
  assert.match(fs.readFileSync(path.join(NODE_DIR, 'src/cli.ts'), 'utf8'), /kula-node brain replay/);
});

test('replay page: the speeds, the night, the card sentence, the ring and the feed', () => {
  assert.equal(rp.frameMs('30s', 90_000, 600), 50);
  assert.equal(rp.frameMs('600', 90_000, 600), 150);
  assert.equal(rp.frameMs('3600', 6000, 600), 16, 'never faster than a screen frame');
  const n = rp.nightRange(new Date(2026, 10, 11, 14, 0).getTime());
  assert.deepEqual([n.from, n.to], [new Date(2026, 10, 10, 18, 0).getTime(), new Date(2026, 10, 11, 9, 0).getTime()]);
  assert.equal(rp.nightRange(Date.now(), '2026-11-01').from, new Date(2026, 10, 1, 18, 0).getTime());
  assert.equal(rp.dayOf(new Date(2026, 0, 5, 23, 0).getTime()), '2026-01-05');
  assert.equal(rp.duration(5 * 3_600_000 + 12 * 60_000), '5 h 12 min');
  assert.equal(rp.count(41230), '41 230');
  const r = { range: 'night', from: T0, summary: { looks: 9, devices: 3, seen: 3, workMs: 5 * 3_600_000 + 12 * 60_000, tokens: 41230, rests: 1, badVerdicts: 0 } };
  assert.equal(rp.summaryLine(r), 'last night: 3 devices, 5 h 12 min of work, about 41 230 tokens, 1 rest warning');
  assert.match(rp.summaryLine({ ...r, summary: { ...r.summary, looks: 0 } }), /saw nothing/);
  for (let k = 0; k < 7; k++) {
    const p = rp.ringAt(k, 7);
    assert.ok(p.x > 0 && p.x < rp.STAGE.w && p.y > 0 && p.y < rp.STAGE.h && p.ly > 0 && p.ty < rp.STAGE.h, `device ${k} inside the drawing`);
  }
  assert.deepEqual(rp.ringAt(0, 3), { x: 180, y: 50, ly: 14, ty: 26 });
  const frames = [{ t: 1, feed: [{ t: 1, branch: 'x', text: 'one' }], marks: ['start'] }, { t: 2, feed: [], marks: [] }, { t: 3, feed: [{ t: 3, branch: 'y', text: 'two' }, { t: 3, branch: 'y', text: 'three' }], marks: ['stop'] }];
  assert.deepEqual(rp.feedUpTo(frames, 2).map((l) => l.text), ['three', 'two', 'the brain stopped watching', 'one', 'the brain started watching']);
  assert.deepEqual(rp.feedUpTo(frames, 1).map((l) => l.text), ['one', 'the brain started watching']);
  assert.equal(rp.feedUpTo(frames, 2, 2).length, 2);
  // served, packed, and only a hook in app.js and index.html
  assert.ok(UI_STATIC.includes('replay.js') && UI_STATIC.includes('replay.css'));
  const app = fs.readFileSync(path.join(NODE_DIR, 'src/ui/static/app.js'), 'utf8');
  assert.match(app, /import \{ mountReplay \} from '\.\/replay\.js'/);
  assert.match(app, /mountReplay\(\{ button: \$\('brain-replay'\), getJson \}\)/);
  const html = fs.readFileSync(path.join(NODE_DIR, 'src/ui/static/index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="replay\.css">/);
  assert.match(html, /id="brain-replay"[^>]*class|class="[^"]*owner-only[^"]*" id="brain-replay"/);
  // text from the box reaches the page through textContent only
  const js = fs.readFileSync(path.join(NODE_DIR, 'src/ui/static/replay.js'), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(js), 'no html strings in replay.js');
});

test('GET brain/replay: the owner reads it, a guest gets 403', async () => {
  const home = process.env.KULA_NODE_HOME!;
  const dir = fs.mkdtempSync(path.join(home, 'u-'));
  const peersFile = path.join(dir, 'peers.json');
  writePeers([{ id: 'id-phone', name: 'phone', host: '10.0.0.9', port: 50551, secret: 'deadbeefcafef00d0123456789abcdef', kind: 'phone', ram: 6000, bw: 30, added_at: 't' }], peersFile);
  const engine = new Engine({ peersFile, modelDirs: [path.join(dir, 'models')], identity: createIdentity('mac'), llama: null, probeMs: 500 });
  const ui = await startUi({ port: 0, engine, store: new ChatStore(path.join(dir, 'chats')), token: 'kula-' + '34'.repeat(20), lanHost: '::1', eye: false });
  try {
    const own = await fetch(`${ui.url}api/brain/replay?from=${T0}&to=${T0 + 60 * MIN}&frames=30`);
    assert.equal(own.status, 200);
    const r = await own.json();
    assert.equal(r.frames.length, 30);
    assert.equal(r.summary.tokens, 6000, 'the box the cli test wrote');
    assert.equal(r.chain.ok, true);
    const { url } = await ui.invite.set(true);
    const j = await fetch(url!, { redirect: 'manual' });
    await j.text();
    const cookie = j.headers.get('set-cookie')!.split(';')[0];
    const guest = await fetch(`http://[::1]:${ui.port}/${ui.prefix}/api/brain/replay`, { headers: { cookie } });
    assert.equal(guest.status, 403);
    assert.ok(!(await guest.text()).includes('device a'));
  } finally {
    await ui.close();
    await engine.close();
  }
});
