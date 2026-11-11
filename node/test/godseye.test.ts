// god's eye (src/godseye): the twelve branches over a snapshot, a broken branch kept apart, the
// notes file, the adapter from kula's engine, and the rule that the eye imports nothing of kula.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-home-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { GodsEye, BRANCH_IDS, dark } = await import('../src/godseye/index.ts');
const { safeId } = await import('../src/godseye/branches/guard.ts');
const { Engine } = await import('../src/ui/engine.ts');
const { kulaSnapshot } = await import('../src/ui/godseye-feed.ts');
const { writePeers } = await import('../src/peers.ts');

const dev = (o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const snap = (devices: any[], at = 1000) => ({
  at, host: { name: 'mac', freeMb: 4000 }, devices,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [{ at: 900, text: 'added pixel' }], llama: true },
  models: [], projects: [],
});

test('the twelve branches in the map\'s order; seven lit, five dark; senses says who answers and when that changes', () => {
  let s: any = snap([dev()]);
  const eye = new GodsEye({ snapshot: () => s, dir: path.join(HOME, 'eye1') });
  eye.tick();
  const v = eye.view();
  assert.deepEqual(v.branches.map((b) => b.id), BRANCH_IDS);
  assert.deepEqual(v.branches.map((b) => b.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  for (const id of ['senses', 'memory', 'connections', 'planner', 'executor', 'trust', 'models']) assert.ok(v.branches.find((b) => b.id === id)!.built, id);
  const senses = v.branches.find((b) => b.id === 'senses')!;
  assert.equal(senses.stat, '1 of 1 devices active');
  assert.equal(senses.gauge, 100);
  assert.ok(v.branches.every((b) => b.what.length > 10));
  s = snap([dev({ reachable: false, reason: 'connect timeout' })], 2000);
  eye.tick();
  assert.match(eye.view().events[0].text, /pixel stopped answering: connect timeout/);
  assert.equal(eye.view().events[0].branch, 'senses');
});

test('a branch that throws is stopped and shown broken; the others and the next looks carry on; a failing snapshot is skipped', () => {
  let fail = false;
  const eye = new GodsEye({
    snapshot: () => { if (fail) throw new Error('no engine'); return snap([dev()]); },
    dir: path.join(HOME, 'eye2'),
    makers: { forecast: () => ({ id: 'forecast', observe() { throw new Error('bad maths'); }, view: () => dark() }) },
  });
  eye.tick();
  eye.tick();
  const v = eye.view();
  const f = v.branches.find((b) => b.id === 'forecast')!;
  assert.equal(f.stat, 'broken');
  assert.equal(f.error, 'bad maths');
  assert.equal(v.branches.find((b) => b.id === 'senses')!.built, true);
  fail = true;
  assert.doesNotThrow(() => eye.tick());
  assert.equal(eye.view().at, 1000);
});

test('a branch keeps its notes in its own file, mode 600, and reads them back', () => {
  const dir = path.join(HOME, 'eye3');
  let seen: any = null;
  const maker = (ctx: any) => ({ id: 'learning' as const, observe() { const n = ctx.load({ looks: 0 }); ctx.save({ looks: n.looks + 1 }); seen = ctx.load(null); }, view: () => dark() });
  const eye = new GodsEye({ snapshot: () => snap([]), dir, makers: { learning: maker } });
  eye.tick();
  eye.tick();
  assert.deepEqual(seen, { looks: 2 });
  assert.equal(fs.statSync(path.join(dir, 'learning.json')).mode & 0o777, 0o600);
});

test('the snapshot the eye gets is a copy: changing it inside a branch does not reach the source', () => {
  const source = snap([dev()]);
  const eye = new GodsEye({ snapshot: () => source, dir: path.join(HOME, 'eye4'), makers: { review: () => ({ id: 'review', observe(s: any) { s.devices[0].name = 'changed'; }, view: () => dark() }) } });
  eye.tick();
  assert.equal(source.devices[0].name, 'pixel');
});

test('the forecast\'s scored hours stay behind peek: not in the eye\'s view, still read by learning', () => {
  const dir = path.join(HOME, 'eye-pairs');
  const hour0 = new Date(2026, 10, 8, 22, 0, 0).getTime();
  const HOUR = 3600_000;
  let i = 0, checked = 0;
  const eye = new GodsEye({
    snapshot: () => snap([dev({ checkedAt: ++checked })], hour0 + Math.floor(i / 12) * HOUR + (i % 12) * 5000),
    dir,
    now: () => 0,
  });
  for (; i < 6 * 12; i++) eye.tick();                     // six hours of looks: the forecast folds five
  const v = eye.view();
  const forecast = v.branches.find((b) => b.id === 'forecast')!;
  assert.ok(!('pairs' in forecast), 'the pairs are not handed out in the eye\'s view');
  assert.doesNotMatch(JSON.stringify(v), /"pairs"/, 'nothing of the pairs rides in a view');
  const learning = v.branches.find((b) => b.id === 'learning')!;
  assert.equal(learning.rows.find((r) => r[0] === 'forecast scored')![1], '2 hours', 'learning still scores what peek hands it');
});

test('kula\'s engine turned into the eye\'s snapshot: devices, work, models, projects; no secret', () => {
  const file = path.join(HOME, 'peers.json');
  writePeers([{ id: 'cable:R3C', name: 'SM S936B', host: '127.0.0.1', port: 6000, secret: 'deadbeef'.repeat(4), fp: 'ab'.repeat(32), pin: null, relay: null, kind: 'phone', ram: 3421, bw: 65.9, cable: { serial: 'R3C' }, added_at: new Date().toISOString() } as any], file);
  const engine = new Engine({ peersFile: file, modelDirs: [path.join(HOME, 'models')], llama: null });
  const s = kulaSnapshot(engine, { list: () => [] } as any, 5000);
  assert.equal(s.at, 5000);
  assert.equal(s.devices.length, 1);
  assert.equal(s.devices[0].via, 'cable');
  assert.equal(s.devices[0].ramMb, 3421);
  assert.equal(s.devices[0].tls, true);
  assert.ok(s.models.length > 0);
  assert.equal(s.work.loaded, null);
  assert.deepEqual(s.work.photos, { n: 0, unseen: 0, at: null }, 'no photo came yet');
  assert.ok(s.models.some((m) => m.vision === true), 'the models that see photos are marked');
  assert.ok(!/deadbeef|abab/.test(JSON.stringify(s)));
});

test('god\'s eye imports nothing of kula: it can leave as a program of its own', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'godseye');
  const files = fs.readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 15);
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of text.matchAll(/from '([^']+)'/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec === '../types.js', `${f} imports ${spec}`);
    }
  }
});

// ---- the guard at the eye's door: one hostile look after another, then two normal looks, through
// the real eye with the real branches. Nothing may throw out of tick, no branch may end up broken,
// nothing may reach the view as NaN, undefined, [object Object] or with an exponent, and nothing
// may leak onto Object.prototype.

/** one hostile look per row; `skip: true` rows are not a look at all, so nothing is taken in */
const hostileLooks: [string, () => any, boolean][] = [
  ['a null look', () => null, true],
  ['a string look', () => 'a look', true],
  ['an empty look', () => ({}), true],
  ['at NaN', () => ({ ...snap([dev()]), at: NaN }), true],
  ['devices null', () => ({ ...snap([dev()]), devices: null }), false],
  ['devices [null]', () => ({ ...snap([dev()]), devices: [null] }), false],
  ['device id __proto__', () => ({ ...snap([dev()]), devices: [dev({ id: '__proto__' })] }), false],
  ['device id constructor', () => ({ ...snap([dev()]), devices: [dev({ id: 'constructor' })] }), false],
  ['device id valueOf', () => ({ ...snap([dev()]), devices: [dev({ id: 'valueOf' })] }), false],
  ['device id toString', () => ({ ...snap([dev()]), devices: [dev({ id: 'toString' })] }), false],
  ['device id 300 chars', () => ({ ...snap([dev()]), devices: [dev({ id: 'x'.repeat(300) })] }), false],
  ['device id 42', () => ({ ...snap([dev()]), devices: [dev({ id: 42 })] }), false],
  ['device name null', () => ({ ...snap([dev()]), devices: [dev({ name: null })] }), false],
  ['reachMs NaN', () => ({ ...snap([dev()]), devices: [dev({ reachMs: NaN })] }), false],
  ['ramMb 1e300', () => ({ ...snap([dev()]), devices: [dev({ ramMb: 1e300 })], models: [{ id: 'm1', name: 'big', file: 'big.gguf', size: 1e9, quant: null, params_b: null, catalog: true, here: true, needMb: 2000 }] }), false],
  ['work null', () => ({ ...snap([dev()]), work: null }), false],
  ['work.loaded.model null', () => ({ ...snap([dev()]), work: { loaded: { mode: 'apart', model: null, ctx: 100, since: 900, devices: [{ id: 'p1', name: 'pixel', local: false, busy: true, tps: 3, done: 2 }] }, loading: null, chatting: 1, plan: [], decisions: [], llama: true } }), false],
  ['work.loaded.devices [null]', () => ({ ...snap([dev()]), work: { ...snap([dev()]).work, loaded: { mode: 'apart', model: { id: 'm1', name: 'model', file: 'f.gguf', size: 1e9 }, ctx: 100, since: 900, devices: [null] } } }), false],
  ['work.decisions [null]', () => ({ ...snap([dev()]), work: { ...snap([dev()]).work, decisions: [null] } }), false],
  ['models [null]', () => ({ ...snap([dev()]), models: [null] }), false],
  ['projects [null]', () => ({ ...snap([dev()]), projects: [null] }), false],
  ['project title {} and peers null', () => ({ ...snap([dev()]), projects: [{ id: 'n1', title: {}, request: 'x'.repeat(10), start: 500, end: 900, state: 'waiting', mode: 'apart', model: 'm1', peers: null }] }), false],
  ['trust rejectsLast [null] and lines null', () => ({ ...snap([dev()]), devices: [dev({ trust: { at: 900, error: null, id: 'abc', alg: 'ed25519', pub: 'pub', store: 'keystore', cert: 'cert', certPinned: true, v1: false, paired: 1, self: 'ok', count: 5, head: 'h', lines: null, restartedAt: null, rejectsDay: {}, rejectsLast: [null] } })] }), false],
];

test('one hostile look after another: no throw, no broken branch, no NaN, undefined, [object Object] or exponent, nothing on Object.prototype', () => {
  const protoNames = Object.getOwnPropertyNames(Object.prototype).sort();
  let i = 0;
  for (const [row, make, skip] of hostileLooks) {
    let s: any = make();
    const eye = new GodsEye({ snapshot: () => s, dir: path.join(HOME, `eye-hostile-${i++}`) });
    assert.doesNotThrow(() => eye.tick(), `${row}: tick threw`);
    const v = eye.view();                                 // the eye calls view() after every observe
    const broken = v.branches.filter((b) => b.error !== undefined).map((b) => `${b.id}: ${b.error}`);
    assert.deepEqual(broken, [], `${row}: a branch broke on the hostile look`);
    assert.doesNotMatch(JSON.stringify(v), /NaN|undefined|\[object Object\]|e\+\d/, `${row}: garbage reached the view`);
    assert.equal(({} as any).name, undefined, `${row}: Object.prototype was polluted`);
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), protoNames, `${row}: Object.prototype changed`);
    assert.equal(({} as any).valueOf, Object.prototype.valueOf, `${row}: valueOf was replaced`);
    if (skip) assert.equal(v.at, 0, `${row}: a skipped look was taken in`);
    for (const again of [1, 2]) {                        // two normal looks after the hostile one
      s = snap([dev()]);
      assert.doesNotThrow(() => eye.tick(), `${row}: a normal look threw`);
      assert.ok(eye.view().branches.every((b) => b.error === undefined), `${row}: a branch broke on normal look ${again}`);
      assert.equal(({} as any).name, undefined, row);
      assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), protoNames, row);
    }
  }
});

test('a run of unusable looks is one log line, the next run logs again, and the eye still ticks', () => {
  let s: any = null;
  const lines: string[] = [];
  const eye = new GodsEye({ snapshot: () => s, dir: path.join(HOME, 'eye-badlog'), log: (x) => lines.push(x) });
  const skip = () => lines.filter((l) => l === "god's eye: a look was not usable, skipped").length;
  eye.tick();
  eye.tick();
  assert.equal(skip(), 1);
  assert.equal(eye.view().at, 0);                        // nothing was taken in, nothing was invented
  s = snap([]);
  eye.tick();
  assert.equal(skip(), 1);                               // a good look does not log
  s = null;
  eye.tick();
  assert.equal(skip(), 2);                               // the next run logs once again
});

test('a null snapshot does not throw out of the timer', () => {
  const eye = new GodsEye({ snapshot: () => null as any, dir: path.join(HOME, 'eye-null-timer'), everyMs: 10 });
  assert.doesNotThrow(() => eye.start());
  eye.stop();
});

test('a broken branch is not quoted through peek: its last view does not leak', () => {
  let n = 0;
  const eye = new GodsEye({
    snapshot: () => snap([dev()]),
    dir: path.join(HOME, 'eye-peek'),
    makers: {
      forecast: () => ({ id: 'forecast', observe() { n++; if (n > 1) throw new Error('bad maths'); }, view: () => ({ built: true, stat: 'a view', gauge: null, rows: [], lines: [] }) }),
      limits: (ctx) => ({ id: 'limits', observe() {}, view: () => ({ built: true, stat: ctx.peek('forecast') === null ? 'peek says null' : 'peek leaks', gauge: null, rows: [], lines: [] }) }),
    },
  });
  eye.tick();                                            // forecast has a view now
  eye.tick();                                            // forecast throws: broken, its view stays behind
  const v = eye.view();
  assert.equal(v.branches.find((b) => b.id === 'limits')!.stat, 'peek says null');
  assert.equal(v.branches.find((b) => b.id === 'forecast')!.stat, 'broken');
  assert.equal(v.branches.find((b) => b.id === 'forecast')!.error, 'bad maths');
  eye.tick();
  assert.equal(eye.view().branches.find((b) => b.id === 'limits')!.stat, 'peek says null');
});

test('a branch whose create throws is logged and shown broken, like one whose observe throws', () => {
  const lines: string[] = [];
  const eye = new GodsEye({
    snapshot: () => snap([]),
    dir: path.join(HOME, 'eye-create'),
    log: (s) => lines.push(s),
    makers: { review: () => { throw new Error('no desk'); } },
  });
  eye.tick();
  const v = eye.view();
  assert.equal(v.branches.find((b) => b.id === 'review')!.stat, 'broken');
  assert.equal(v.branches.find((b) => b.id === 'review')!.error, 'no desk');
  assert.ok(lines.includes("god's eye review: stopped: no desk"));
});

test('a view that throws marks the branch broken and the others carry on', () => {
  const eye = new GodsEye({
    snapshot: () => snap([dev()]),
    dir: path.join(HOME, 'eye-view'),
    makers: { review: () => ({ id: 'review', observe() {}, view() { throw new Error('bad page'); } }) },
  });
  eye.tick();
  const v = eye.view();
  assert.equal(v.branches.find((b) => b.id === 'review')!.stat, 'broken');
  assert.equal(v.branches.find((b) => b.id === 'review')!.error, 'bad page');
  assert.equal(v.branches.find((b) => b.id === 'senses')!.built, true);
  eye.tick();
  assert.equal(eye.view().branches.find((b) => b.id === 'senses')!.built, true);
});

test('ctx.load returns the fallback when the file holds JSON null', () => {
  const dir = path.join(HOME, 'eye-null-load');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'learning.json'), 'null');
  let loaded: any = 'unset';
  const eye = new GodsEye({
    snapshot: () => snap([]),
    dir,
    makers: { learning: (ctx) => ({ id: 'learning', observe() { loaded = ctx.load({ looks: 7 }); }, view: () => dark() }) },
  });
  eye.tick();
  assert.deepEqual(loaded, { looks: 7 });
});

test('the feed holds at most 60 events, newest first, each cut to 300 chars', () => {
  const eye = new GodsEye({
    snapshot: () => snap([]),
    dir: path.join(HOME, 'eye-events'),
    makers: { review: (ctx) => ({ id: 'review', observe() { for (let i = 0; i < 64; i++) ctx.emit(`event ${i}`); ctx.emit('x'.repeat(400)); }, view: () => dark() }) },
  });
  eye.tick();
  const events = eye.view().events;
  assert.equal(events.length, 60);
  assert.equal(events[0].branch, 'review');
  assert.equal(events[0].text, 'x'.repeat(300));
  assert.equal(events[1].text, 'event 63');
  assert.ok(!events.some((e) => e.text === 'event 4'));  // the cap cut the oldest
});

test('act reaches a branch; a throwing act returns null and is logged', () => {
  let got: [string, string] | null = null;
  const lines: string[] = [];
  const eye = new GodsEye({
    snapshot: () => snap([]),
    dir: path.join(HOME, 'eye-act'),
    log: (s) => lines.push(s),
    makers: {
      review: () => ({ id: 'review', observe() {}, view: () => dark(), act(a, s) { got = [a, s]; return 'noted'; } }),
      limits: () => ({ id: 'limits', observe() {}, view: () => dark(), act() { throw new Error('no handle'); } }),
    },
  });
  assert.equal(eye.act('review', 'accept', 'p1'), 'noted');
  assert.deepEqual(got, ['accept', 'p1']);
  assert.equal(eye.act('limits', 'x', 'y'), null);
  assert.ok(lines.includes("god's eye limits: no handle"));
  assert.equal(eye.act('nonsense' as any, 'x', 'y'), null);   // no such branch
});

test('a save that cannot write is logged and does not throw', () => {
  const block = path.join(HOME, 'eye-save-block');
  fs.writeFileSync(block, 'x');                          // the dir's parent is a file: writes must fail
  const lines: string[] = [];
  const eye = new GodsEye({
    snapshot: () => snap([]),
    dir: path.join(block, 'sub'),
    log: (s) => lines.push(s),
    makers: { learning: (ctx) => ({ id: 'learning', observe() { ctx.save({ v: 1 }); }, view: () => dark() }) },
  });
  assert.doesNotThrow(() => eye.tick());
  assert.ok(lines.some((l) => l.includes("god's eye learning: could not save")));
});

test('a log that throws does not stop the eye', () => {
  let s: any = null;
  const eye = new GodsEye({ snapshot: () => s, dir: path.join(HOME, 'eye-log-throw'), log: () => { throw new Error('no log'); } });
  assert.doesNotThrow(() => eye.tick());                 // the skip line goes to a log that throws
  s = snap([dev()]);
  assert.doesNotThrow(() => eye.tick());                 // branches run, their logs throw too
  assert.equal(eye.view().branches.find((b) => b.id === 'senses')!.built, true);
});

test('start looks at once and then on the timer; stop ends it', async () => {
  let looks = 0;
  const eye = new GodsEye({ snapshot: () => { looks++; return snap([]); }, dir: path.join(HOME, 'eye-timer'), everyMs: 10 });
  eye.start();
  assert.equal(looks, 1);                                // the first look is immediate
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(looks >= 2, 'the timer kept looking');
  eye.stop();
  const n = looks;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(looks, n);                                // stopped: no more looks
  eye.stop();                                            // twice is fine
});

test('a skipped look does not touch before: the third look is handed the first look', () => {
  const befores: any[] = [];
  let s: any = snap([dev({ name: 'first' })], 1000);
  const eye = new GodsEye({
    snapshot: () => s,
    dir: path.join(HOME, 'eye-before'),
    makers: { review: () => ({ id: 'review', observe(_now: any, before: any) { befores.push(before); }, view: () => dark() }) },
  });
  eye.tick();                                            // the first good look
  s = null;
  eye.tick();                                            // skipped: no branch sees it
  eye.tick();                                            // skipped again
  s = snap([dev({ name: 'third' })], 2000);
  eye.tick();                                            // the second good look
  assert.equal(befores.length, 2);
  assert.equal(befores[0], null);                        // the first look has nothing before it
  assert.equal(befores[1].at, 1000);                     // not null: the skipped looks left `before` alone
  assert.equal(befores[1].devices[0].name, 'first');
});

test('a thrown null, undefined or text from the snapshot is a skipped look, never a throw out of tick', () => {
  const bads = [null, undefined, 'text'];
  for (let i = 0; i < bads.length; i++) {
    const bad = bads[i];
    const lines: string[] = [];
    const eye = new GodsEye({ snapshot: () => { throw bad; }, dir: path.join(HOME, `eye-throw-snap-${i}`), log: (x) => lines.push(x) });
    assert.doesNotThrow(() => eye.tick());
    assert.equal(lines[0], `god's eye: no look: ${String(bad)}`);
    assert.equal(eye.view().at, 0);
  }
});

test('a branch that throws null, undefined or text is marked broken; the branches after it still run', () => {
  const bads = [null, undefined, 'text'];
  for (let i = 0; i < bads.length; i++) {
    const bad = bads[i];
    const eye = new GodsEye({
      snapshot: () => snap([dev()]),
      dir: path.join(HOME, `eye-throw-observe-${i}`),
      makers: { forecast: () => ({ id: 'forecast', observe() { throw bad; }, view: () => dark() }) },
    });
    assert.doesNotThrow(() => eye.tick());
    const v = eye.view();
    assert.equal(v.branches.find((b) => b.id === 'forecast')!.error, String(bad));
    assert.equal(v.branches.find((b) => b.id === 'forecast')!.stat, 'broken');
    assert.equal(v.branches.find((b) => b.id === 'senses')!.built, true);
    assert.equal(v.branches.find((b) => b.id === 'advisor')!.built, true);   // after forecast: still ran
    eye.tick();
    assert.equal(eye.view().branches.find((b) => b.id === 'advisor')!.built, true);
    assert.equal(eye.view().branches.find((b) => b.id === 'forecast')!.error, String(bad));
  }
});

test('a branch whose create throws null, undefined or text does not throw out of the constructor', () => {
  const bads = [null, undefined, 'text'];
  for (let i = 0; i < bads.length; i++) {
    const bad = bads[i];
    const lines: string[] = [];
    let eye!: any;
    assert.doesNotThrow(() => {
      eye = new GodsEye({ snapshot: () => snap([]), dir: path.join(HOME, `eye-throw-create-${i}`), log: (x) => lines.push(x), makers: { review: () => { throw bad; } } });
    });
    eye.tick();
    const b = eye.view().branches.find((x: any) => x.id === 'review')!;
    assert.equal(b.stat, 'broken');
    assert.equal(b.error, String(bad));
    assert.ok(lines.includes(`god's eye review: stopped: ${String(bad)}`));
    assert.equal(eye.view().branches.find((x: any) => x.id === 'senses')!.built, true);
  }
});

test('an uncloneable look or a throwing getter logs once per run of bad looks', () => {
  const lines: string[] = [];
  let s: any = { ...snap([dev()]), extra: () => 1 };     // a function cannot be cloned
  const eye = new GodsEye({ snapshot: () => s, dir: path.join(HOME, 'eye-clone'), log: (x) => lines.push(x) });
  const noLook = () => lines.filter((l) => l.startsWith("god's eye: no look:")).length;
  eye.tick();
  eye.tick();
  assert.equal(noLook(), 1);                             // one run of bad looks: one line
  s = { ...snap([dev()]), get oops() { throw new Error('getter'); } };
  eye.tick();
  assert.equal(noLook(), 1);                             // the same run, still silent
  s = snap([dev()]);
  eye.tick();                                            // a good look ends the run
  s = { ...snap([dev()]), extra: () => 1 };
  eye.tick();
  assert.equal(noLook(), 2);                             // the next run logs once again
});

test('a refusal count past the cap is capped, never dropped: the trust alarm stays red through the real eye', () => {
  const trust = (at: number, rejectsDay: Record<string, number>) => ({
    at, error: null, id: null, alg: 'ed25519', pub: null, store: 'keystore', cert: null, certPinned: false,
    v1: false, paired: 1, self: 'ok', count: 0, head: null, lines: [], restartedAt: null, rejectsDay, rejectsLast: [],
  });
  let s: any = snap([dev({ tls: true, trust: trust(900, {}) })], 1000);
  const eye = new GodsEye({ snapshot: () => s, dir: path.join(HOME, 'eye-trust-cap') });
  eye.tick();                                            // quiet: the device is unknown, not red
  s = snap([dev({ tls: true, trust: trust(1900, { 'wrong pin': 1_000_000_001 }) })], 2000);
  eye.tick();
  const tv: any = eye.view().branches.find((b) => b.id === 'trust')!;
  assert.equal(tv.report.verdict, 'bad');                // the count was kept, at the cap: not silence
  assert.equal(tv.report.devices[0].refused, '10000 refused today');
  const ev = eye.view().events.find((e) => e.branch === 'trust');
  assert.ok(ev);
  assert.equal(ev!.text, 'pixel: 10000 wrong codes today: someone may be guessing. all were refused');
});

test('a device whose id is a prototype key cannot hide: the trust view is red and names it', () => {
  const trust = (at: number) => ({
    at, error: null, id: null, alg: 'ed25519', pub: null, store: 'keystore', cert: null, certPinned: false,
    v1: false, paired: 1, self: 'ok', count: 0, head: null, lines: [], restartedAt: null,
    rejectsDay: { 'wrong pin': 6 }, rejectsLast: [],   // six wrong codes: the real trust branch reads this as bad
  });
  for (const id of ['valueOf', 'constructor', '__proto__', 'toString']) {
    const eye = new GodsEye({ snapshot: () => snap([dev({ id, name: id, trust: trust(900) })], 1000), dir: path.join(HOME, `eye-protokey-${id}`) });
    eye.tick();
    const tv: any = eye.view().branches.find((b) => b.id === 'trust')!;
    assert.equal(tv.report.verdict, 'bad', id);
    assert.equal(tv.stat, '1 thing to look at', id);
    assert.deepEqual(tv.lines, [`${id} · 6 wrong codes today: someone may be guessing. all were refused`], id);
    assert.equal(({} as any).valueOf, Object.prototype.valueOf, id);
  }
});

test('a device with no usable id is left out and the eye says so once per run of such looks', () => {
  const lines: string[] = [];
  const line = "god's eye: 1 device(s) in the look had no usable id and were left out";
  let s: any = snap([dev({ id: 42 })]);
  const eye = new GodsEye({ snapshot: () => s, dir: path.join(HOME, 'eye-no-id'), log: (x) => lines.push(x) });
  const said = () => lines.filter((l) => l === line).length;
  eye.tick();
  eye.tick();
  assert.equal(said(), 1);                               // one run of such looks: one line
  assert.equal(eye.view().branches.find((b) => b.id === 'trust')!.stat, 'nothing to check');
  s = snap([dev()]);
  eye.tick();                                            // a good look ends the run
  assert.equal(said(), 1);
  s = snap([dev({ id: 42 }), dev({ id: '' })]);
  eye.tick();
  assert.equal(lines.filter((l) => l === "god's eye: 2 device(s) in the look had no usable id and were left out").length, 1);
  assert.equal(said(), 1);                               // the second run says its own number once
});

/** a device's trust answer: tls, nothing refused, its ledger reporting `count` lines */
const trustAt = (at: number, count: number) => ({
  at, error: null, id: null, alg: 'ed25519', pub: null, store: 'keystore', cert: null, certPinned: false,
  v1: false, paired: 1, self: 'ok', count, head: null, lines: [], restartedAt: null, rejectsDay: {}, rejectsLast: [],
});
const ledgerOf = (d: any) => d.checks.find((c: any) => c.k === 'ledger');
/** the trust report's devices by their cleaned id */
const trustById = (eye: any): Map<string, any> => {
  const r: any = eye.view().branches.find((b: any) => b.id === 'trust').report;
  return new Map(r.devices.map((d: any) => [d.id, d] as [string, any]));
};

/** one device's ledger shrinks from 5 lines to 3, beside a healthy one, in both list orders and with
 *  either one leaving: the shortened-ledger fault must stay with its own id and never move. */
function faultStaysWith(faultyId: string, healthyId: string, dir: string): void {
  const faulty = (at: number, count: number) => dev({ id: faultyId, name: 'faulty', trust: trustAt(at, count) });
  const healthy = (at: number) => dev({ id: healthyId, name: 'real', trust: trustAt(at, 5) });
  const FAULT = safeId(faultyId);
  const REAL = safeId(healthyId);
  for (const order of [0, 1]) {
    let s: any = null;
    const eye = new GodsEye({ snapshot: () => s, dir: `${dir}-${order}` });
    const both = (f: any, h: any) => (order === 0 ? [f, h] : [h, f]);
    s = snap(both(faulty(900, 5), healthy(900)), 1000); eye.tick();
    s = snap(both(faulty(1900, 3), healthy(1900)), 2000); eye.tick();    // the fault is raised
    let byId = trustById(eye);
    assert.ok(byId.get(FAULT) && byId.get(REAL), `${dir} ${order}: both devices are in the report`);
    assert.equal(byId.get(FAULT)!.verdict, 'bad');
    assert.equal(byId.get(FAULT)!.accept, true);
    assert.equal(ledgerOf(byId.get(FAULT)!).text, 'its ledger got shorter: 5 lines before, 3 now (lines were removed)');
    assert.notEqual(byId.get(REAL)!.verdict, 'bad');
    assert.equal(byId.get(REAL)!.accept, false);
    assert.doesNotMatch(JSON.stringify(byId.get(REAL)!), /got shorter/);
    s = snap([healthy(2900)], 3000); eye.tick();                         // the faulty one leaves
    byId = trustById(eye);
    assert.equal(byId.size, 1);
    assert.notEqual(byId.get(REAL)!.verdict, 'bad', `${dir} ${order}: healthy after the faulty leaves`);
    assert.equal(byId.get(REAL)!.accept, false);
    assert.doesNotMatch(JSON.stringify(byId.get(REAL)!), /got shorter/);
    s = snap(both(faulty(3900, 3), healthy(3900)), 4000); eye.tick();    // it comes back
    byId = trustById(eye);
    assert.equal(byId.get(FAULT)!.verdict, 'bad');
    assert.equal(byId.get(FAULT)!.accept, true);
    assert.notEqual(byId.get(REAL)!.verdict, 'bad');
    s = snap([faulty(4900, 3)], 5000); eye.tick();                       // the healthy one leaves
    byId = trustById(eye);
    assert.equal(byId.size, 1);
    assert.equal(byId.get(FAULT)!.verdict, 'bad');
    assert.equal(byId.get(FAULT)!.accept, true);
    assert.equal(ledgerOf(byId.get(FAULT)!).text, 'its ledger got shorter: 5 lines before, 3 now (lines were removed)');
  }
}

test('a shortened-ledger fault stays with "valueOf" beside "~valueOf", in either order and after one leaves', () => {
  faultStaysWith('valueOf', '~valueOf', path.join(HOME, 'eye-fault-short'));
});

test('the same for two 300-char ids that differ only at the end', () => {
  const a = 'z'.repeat(290) + 'a' + 'q'.repeat(9);
  const b = 'z'.repeat(290) + 'b' + 'q'.repeat(9);
  faultStaysWith(a, b, path.join(HOME, 'eye-fault-long'));
});

test('ids "valueOf", "~valueOf" and "~valueOf~2" are three distinct devices through the eye', () => {
  const ids = ['valueOf', '~valueOf', '~valueOf~2'];
  const s: any = snap(ids.map((id) => dev({ id, name: id, trust: trustAt(900, 5) })), 1000);
  const eye = new GodsEye({ snapshot: () => s, dir: path.join(HOME, 'eye-three-ids') });
  eye.tick();
  const tv: any = eye.view().branches.find((b) => b.id === 'trust')!;
  assert.equal(tv.report.devices.length, 3);
  assert.deepEqual(tv.report.devices.map((d: any) => d.id), ids.map(safeId));
  assert.equal(new Set(tv.report.devices.map((d: any) => d.id)).size, 3);
});

test('a look that leaves out models or projects says so once per run, like devices do', () => {
  const lines: string[] = [];
  const model = "god's eye: 1 model(s) in the look had no usable id and were left out";
  const project = "god's eye: 1 project(s) in the look had no usable id and were left out";
  const said = (l: string) => lines.filter((x) => x === l).length;
  let s: any = { ...snap([dev()]), models: [{ id: 42 }, { id: 'm1' }], projects: [{ id: '' }] };
  const eye = new GodsEye({ snapshot: () => s, dir: path.join(HOME, 'eye-dropped-others'), log: (x) => lines.push(x) });
  eye.tick();
  eye.tick();
  assert.equal(said(model), 1);                          // one run of such looks: one line each
  assert.equal(said(project), 1);
  s = snap([dev()]);
  eye.tick();                                            // a good look ends both runs
  assert.equal(said(model), 1);
  s = { ...snap([dev()]), models: [{ id: 42 }, { id: 'm1' }] };
  eye.tick();
  assert.equal(said(model), 2);                          // a new run says it once again
  assert.equal(said(project), 1);                        // projects were not left out this time
});
