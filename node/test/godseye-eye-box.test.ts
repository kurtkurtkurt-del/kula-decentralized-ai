// god's eye wired into the black box: every look, feed line, verdict and act goes into the
// hash-chained record, the private facts of a look are the only thing kept, and the record can be
// read back into the facts of every look it holds. The tests drive the real eye with the real
// twelve branches; only the box is sometimes a stub, so that a failing disk can be tried.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-box-wire-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { GodsEye } = await import('../src/godseye/index.ts');
const { openBox } = await import('../src/godseye/box.ts');
const { clean } = await import('../src/godseye/branches/guard.ts');
const { facts, diff, scrub, makeScrubber, secretScan, replay, keyChunks, secretsOf, trimVerdicts, CACHE_TEXT_MAX, NEW_TEXT_MAX } = await import('../src/godseye/boxfacts.ts');

let made = 0;
const fresh = (name: string): string => path.join(ROOT, `${name}-${++made}`);

// ---- fixtures: a healthy look, built the way the engine hands it over (plain json)

const dev = (id: string, o: Record<string, unknown> = {}) => ({
  id, name: `device ${id}`, kind: 'phone', via: 'wifi', where: '10.0.0.1:50551',
  reachable: true, reachMs: 12, reason: null, checkedAt: 900, lastOk: null,
  ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, ...o,
});
const work = (o: Record<string, unknown> = {}) => ({ loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true, ...o });
const snapOf = (devices: unknown[], at: number, o: Record<string, unknown> = {}) => ({
  at, host: { name: 'mac', freeMb: 4000 }, devices, work: work(), models: [], projects: [], ...o,
});
const model = (id: string, o: Record<string, unknown> = {}) => ({ id, name: `model ${id}`, file: `${id}.gguf`, size: 4_000_000_000, quant: 'q4', params_b: 8, catalog: true, here: true, needMb: 5000, ...o });
const project = (id: string, o: Record<string, unknown> = {}) => ({ id, title: `project ${id}`, request: 'do the thing for the night', start: 1000, end: 2000, state: 'waiting', mode: 'apart', model: 'm1', peers: ['a'], ...o });

const recordsOf = (dir: string) => {
  const box = openBox({ dir });
  return box.read({ limit: 5000 });
};
const recordsKind = (dir: string, kind: string) => recordsOf(dir).filter((r) => r.k === kind);
const boxText = (dir: string): string => {
  const parts: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^box-\d{6}\.jsonl$/.test(f) && f !== 'head.json') continue;
    parts.push(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  return parts.join('\n');
};

/** a tiny seeded random, so a failed sample can be looked at again */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** the median of the samples: a timing test under a loaded suite must not fail on one slow run.
 *  every timing below is the median of 20 runs after 3 warm-ups. */
function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

/** run one timing sample 3 times to warm up, then 20 times, and give the median in ms */
function medianMs(once: () => number): { median: number; samples: number[] } {
  for (let i = 0; i < 3; i++) once();
  const samples = Array.from({ length: 20 }, once);
  return { median: medianOf(samples), samples };
}

// ---- the pure facts: what is kept, what a delta says, how text is scrubbed, how a record reads back

test('facts keeps the whitelist and drops where, reason, keys, lines, titles and requests', () => {
  const s = snapOf([dev('b'), dev('a')], 1000, {
    work: work({ plan: ['first', 'second'], decisions: [{ at: 900, text: 'a decision' }], chatting: 2 }),
    models: [model('m1')],
    projects: [project('n1')],
  });
  const f = facts(s as never);
  assert.deepEqual(f.devices.map((d) => d.id), ['a', 'b']);          // sorted by id
  assert.deepEqual(Object.keys(f.devices[0]), [
    'id', 'name', 'kind', 'via', 'reachable', 'reachMs', 'checkedAt', 'lastOk',
    'ramMb', 'bwGBs', 'gpu', 'tls', 'waitingPair', 'plugged', 'holds', 'down', 'trust', 'ring',
  ]);
  assert.equal(f.devices[0].down, false);
  assert.equal(f.devices[0].trust, null);
  assert.equal('where' in f.devices[0], false);
  assert.equal('reason' in f.devices[0], false);
  assert.equal(f.work.planN, 2);
  assert.equal(f.work.decisionsN, 1);
  assert.deepEqual(Object.keys(f.work.loaded ?? {}), []);
  assert.equal(f.work.llama, true);
  assert.deepEqual(Object.keys(f.models[0]), ['id', 'name', 'file', 'size', 'quant', 'params_b', 'catalog', 'here', 'needMb']);
  assert.deepEqual(Object.keys(f.projects[0]), ['id', 'start', 'end', 'state', 'mode', 'model', 'peers', 'parts', 'done']);
  assert.equal('title' in f.projects[0], false);
  assert.equal('request' in f.projects[0], false);
  // a device that says why it is down: down is true, the words themselves are not kept
  const down = facts(snapOf([dev('c', { reachable: false, reason: 'connect timeout' })], 1000) as never);
  assert.equal(down.devices[0].down, true);
  assert.equal('reason' in down.devices[0], false);
});

test('diff names only the changed fields, a new device whole, a gone device null', () => {
  const base = facts(snapOf([dev('a'), dev('b')], 1000) as never);
  const next = structuredClone(snapOf([dev('a', { reachMs: 99 }), dev('c')], 2000) as never);
  const d = diff(base, facts(next as never));
  assert.deepEqual(Object.keys(d).sort(), ['dev']);
  assert.deepEqual(d.dev, Object.assign(Object.create(null), {
    a: { reachMs: 99 },
    b: null,
    c: {
      id: 'c', name: 'device c', kind: 'phone', via: 'wifi', reachable: true, reachMs: 12, checkedAt: 900,
      lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, down: false, trust: null, ring: 'home',
    },
  }));
  // nothing changed: an empty delta, so the look is only its at
  assert.deepEqual(diff(base, facts(snapOf([dev('a'), dev('b')], 3000) as never)), {});
  // the hosts, work, models and projects are replaced whole when they change
  const withModel = facts(snapOf([dev('a'), dev('b')], 1000, { models: [model('m1')] }) as never);
  const dm = diff(base, withModel);
  assert.deepEqual(Object.keys(dm), ['models']);
  assert.deepEqual(dm.models, withModel.models);
});

test('the trust whitelist is kept with a device, and its keys, lines and peers are not', () => {
  const f = facts(snapOf([dev('a', {
    trust: {
      at: 900, error: 'no answer at 10.0.0.7', id: 'trust-id-here', alg: 'ed25519', pub: 'a-public-key-here',
      store: 'keystore', cert: 'a-certificate-here', certPinned: true, v1: false, paired: 1, self: 'ok',
      count: 5, head: 'a-head-hash', lines: ['a-ledger-line'], restartedAt: 800,
      rejectsDay: { badcode: 2 }, rejectsLast: [{ t: 900, why: 'bad code', peer: 'peer-device-id' }],
    },
  })], 1000) as never);
  assert.deepEqual(f.devices[0].trust, {
    at: 900, err: true, alg: 'ed25519', store: 'keystore', certPinned: true, v1: false, paired: 1,
    self: 'ok', count: 5, head: 'a-head-hash', restartedAt: 800, rejectsDay: { badcode: 2 },
  });
  const j = JSON.stringify(f);
  for (const x of ['a-public-key-here', 'a-certificate-here', 'a-ledger-line', 'peer-device-id', 'trust-id-here', 'no answer at']) {
    assert.ok(!j.includes(x), `the facts hold ${x}`);
  }
  // one device's rejectsDay stays bounded: twenty reasons, not a thousand
  const day: Record<string, number> = {};
  for (let i = 0; i < 100; i++) day[`reason-${i}`] = i;
  const capped = facts(snapOf([dev('b', { trust: { at: 900, rejectsDay: day } })], 1000) as never);
  assert.equal(Object.keys(capped.devices[0].trust!.rejectsDay).length, 20);
  assert.equal(Object.keys(capped.devices[0].trust!.rejectsDay)[0], 'reason-0');
  assert.equal(Object.keys(capped.devices[0].trust!.rejectsDay)[19], 'reason-19');
  // even twenty reasons of the longest guard-bounded word keep one device's key chunk under 12 000
  const longDay: Record<string, number> = {};
  for (let i = 0; i < 100; i++) longDay[`r${'x'.repeat(190)}${String(i).padStart(3, '0')}`] = i;
  const heavy = facts(snapOf([dev('c', { trust: { at: 900, rejectsDay: longDay } })], 1000) as never);
  const chunks = keyChunks(1000, heavy);
  for (const c of chunks) assert.ok(JSON.stringify(c).length <= 12_000, `trust key chunk ${JSON.stringify(c).length}`);
  console.log(`trust facts: one device with 20 long reasons -> key chunks ${chunks.map((c) => JSON.stringify(c).length).join(', ')} chars`);
});

test('scrub removes every run of eight chars or more that a secret shares, windows meeting as one run', () => {
  assert.equal(scrub('a long-secret title here', ['long-secret title']), 'a […] here');
  assert.equal(scrub('abc def', ['abc']), 'abc def');                 // under eight chars: not scrubbed
  assert.equal(scrub('abcdefgh', ['abcdefgh']), '[…]');
  assert.equal(scrub('abcdefgh-and-ijklmnop', ['abcdefgh', 'ijklmnop']), '[…]-and-[…]');   // two runs, both go
  // two eight-char windows meet in the middle: the whole run between them goes
  assert.equal(scrub('abcdefghij', ['abcdefgh', 'cdefghij']), '[…]');
  assert.equal(scrub('abcdefghijk', ['defghijk', 'abcdefghijk']), '[…]');
  assert.equal(scrub('nothing to see', ['unrelated words']), 'nothing to see');
  // a shortened or masked quote: the pieces that are shared are cut, the rest stays
  assert.equal(scrub('“a-very-long-title-here-abcdefgh” (waiting)', ['a-very-long-title-here-abcdefgh-abcdefgh']), '“[…]” (waiting)');
  assert.equal(scrub('the title … and the rest', ['the title secret-words and the rest of it']), '[…]…[…]');
});

test('a look over the new-work bound withholds its texts and windows the rest on the next look', () => {
  const a = `a-${'x'.repeat(NEW_TEXT_MAX - 10)}`;   // 200 KiB, say
  const b = `b-${'y'.repeat(200 * 1024)}`;
  const first = makeScrubber([a, b]);
  assert.equal(first.over, true);                    // more than NEW_TEXT_MAX of new text
  const quote = 'some quoted words';
  assert.deepEqual(first.scrub(quote), { scrubbed: true, len: quote.length });
  // a second look finds the first secret cached, windows the second, and scrubs normally
  const second = makeScrubber([a, b]);
  assert.equal(second.over, false);
  assert.equal(typeof second.scrub('some quoted words'), 'string');
  // a third look with the same secrets is complete again
  assert.equal(makeScrubber([a, b]).over, false);
});

test('a short secret of four to seven chars is cut whole; a three-char one is not', () => {
  assert.equal(scrub('the Taxes line', ['Taxes']), 'the […] line');
  assert.equal(scrub('the secret line', ['Taxes']), 'the secret line');
  // a three-char secret is too common to cut: every sentence holds one
  assert.equal(scrub('a Tax here', ['Tax']), 'a Tax here');
  assert.equal(scrub('a Tax and a Taxes', ['Tax', 'Taxes']), 'a Tax and a […]');
});

test('scrub redacts an e-mail or an address whatever its source', () => {
  assert.equal(scrub('write to a.b@example.com now', []), 'write to […] now');
  assert.equal(scrub('at 10.9.8.7:50551 or 10.9.8.7', []), 'at […] or […]');
  assert.equal(scrub('at [fe80::1]:50551 and 2001:db8:85a3::8a2e:370:7334 now', []), 'at […] and […] now');
  assert.equal(scrub('at fe80::1 now', []), 'at […] now');
  assert.equal(scrub('at 2001:0:0:0:0:0:0:1 now', []), 'at […] now');
  assert.equal(scrub('a plain 12 ms answer', []), 'a plain 12 ms answer');
  // a clock or a short colon run is not an ipv6 address
  assert.equal(scrub('at 12:30:45', []), 'at 12:30:45');
  assert.equal(scrub('at 1:2:3', []), 'at 1:2:3');
  assert.equal(scrub('at 3:1:2', []), 'at 3:1:2');
  assert.equal(scrub('at a:b:c', []), 'at a:b:c');
});

test('trimVerdicts keeps the current verdicts and drops the oldest gone ones', () => {
  const memory = new Map([
    ['old-1', 'ok'], ['old-2', 'ok'], ['old-3', 'ok'],
    ['new-1', 'bad'], ['new-2', 'bad'],
  ]);
  const kept = trimVerdicts(memory, ['new-1', 'new-2'], 3);
  assert.deepEqual([...kept.keys()], ['new-1', 'new-2', 'old-1']);
  assert.deepEqual([...trimVerdicts(memory, ['new-1', 'new-2'], 10).keys()], ['old-1', 'old-2', 'old-3', 'new-1', 'new-2']);
});

test('the scrub set is what a branch can quote: names, where, reasons, titles, requests, plans, decisions', () => {
  const s = snapOf([dev('a', {
    name: 'a device name', where: '10.0.0.7:50551', reason: 'connect timeout',
    trust: {
      at: 900, error: 'a trust error', id: 'trust-id-here', alg: 'ed25519', pub: 'a-public-key-here', store: 'keystore',
      cert: 'a-certificate-here', certPinned: true, v1: false, paired: 1, self: 'ok', count: 5,
      head: 'a-head-hash', lines: ['a-ledger-line'], restartedAt: null, rejectsDay: { badcode: 2 },
      rejectsLast: [{ t: 900, why: 'bad code', peer: 'peer-device-id' }],
    },
  })], 1000, {
    work: work({ loading: { mode: 'apart', model: 'm1', since: 900, line: 'a-loading-line' }, plan: ['a-plan-line'], decisions: [{ at: 900, text: 'a-decision-line' }] }),
    projects: [project('n1', { title: 'a project title', request: 'a project request', line: 'a project line', error: 'a project error' })],
  });
  const got = new Set(secretsOf(s as never));
  for (const x of [
    'a device name', '10.0.0.7:50551', 'connect timeout', 'a-loading-line', 'a-plan-line', 'a-decision-line',
    'a project title', 'a project request', 'a project line', 'a project error',
  ]) {
    assert.ok(got.has(x), `missing secret ${x}`);
  }
  // no branch quotes these, so they need no scrubbing (and stay out of the box facts as before)
  for (const x of ['a-public-key-here', 'a-certificate-here', 'a-ledger-line', 'peer-device-id', 'bad code', 'trust-id-here', 'a trust error', 'a-head-hash']) {
    assert.ok(!got.has(x), `not a quotable secret: ${x}`);
  }
});

test('keyChunks: chunk 0 holds host, work, models and projects; devices go ten a chunk', () => {
  const f = facts(snapOf(Array.from({ length: 12 }, (_, i) => dev(`d${String(i).padStart(2, '0')}`)), 1000, { models: [model('m1')], projects: [project('n1')] }) as never);
  const chunks = keyChunks(1000, f);
  assert.deepEqual(chunks.map((c) => [c.i, c.of]), [[0, 3], [1, 3], [2, 3]]);
  assert.deepEqual(Object.keys(chunks[0]), ['at', 'i', 'of', 'host', 'work', 'models', 'projects']);
  // a key look carries the views that changed, in its first chunk; the other chunks stay bare
  const withV = keyChunks(1000, f, { senses: [true, 'a view', 50, '0123456789abcdef'] });
  assert.deepEqual(withV[0].v, { senses: [true, 'a view', 50, '0123456789abcdef'] });
  assert.equal('v' in withV[1], false);
  assert.deepEqual(chunks[0].models, f.models);
  assert.deepEqual(chunks[0].projects, f.projects);
  assert.deepEqual(chunks[1].devices!.map((d) => d.id), ['d00', 'd01', 'd02', 'd03', 'd04', 'd05', 'd06', 'd07', 'd08', 'd09']);
  assert.deepEqual(chunks[2].devices!.map((d) => d.id), ['d10', 'd11']);
  for (const c of chunks) assert.ok(JSON.stringify(c).length <= 12_000, 'a key chunk is under the payload bound');
  // ten devices of quote-heavy strings would pass 12 000 in one group of ten: the group splits
  const heavy = Array.from({ length: 10 }, (_, i) => dev(`${'q'.repeat(190)}${i}`, { name: '"'.repeat(80), holds: '"'.repeat(300) }));
  const hf = facts(snapOf(heavy, 1000) as never);
  const hchunks = keyChunks(1000, hf);
  assert.ok(hchunks.length > 2, `the device group split (${hchunks.length} chunks)`);
  for (const c of hchunks) assert.ok(JSON.stringify(c).length <= 12_000, `a heavy key chunk is ${JSON.stringify(c).length} chars`);
});

test('replay reads a hand-built key and its looks back into the facts of each look', () => {
  const s0 = snapOf([dev('a'), dev('b')], 1000);
  const s1 = structuredClone(s0);
  s1.devices[0].reachMs = 44;
  delete (s1.devices as any)[1];
  s1.devices.push(dev('c'));
  s1.models.push(model('m1'));
  const f0 = facts(s0 as never);
  const f1 = facts(s1 as never);
  const recs: { n: number; t: number; k: string; b: string | null; x: unknown }[] = [];
  let n = 0;
  for (const c of keyChunks(1000, f0)) recs.push({ n: ++n, t: 1000, k: 'key', b: null, x: c });
  recs.push({ n: ++n, t: 2000, k: 'look', b: null, x: { at: 2000, d: diff(f0, f1) } });
  const states = replay(recs);
  assert.deepEqual(states.map((x) => [x.n, x.at]), [[2, 1000], [3, 2000]]);
  assert.deepEqual(states[0].facts, f0);
  assert.deepEqual(states[1].facts, f1);
});

test('a new key does not mix its chunks with an older key left incomplete', () => {
  const many = Array.from({ length: 12 }, (_, i) => dev(`d${String(i).padStart(2, '0')}`));   // a key of three chunks
  const few = [dev('x'), dev('y')];                                                          // a key of two
  const f0 = facts(snapOf(many, 1000) as never);
  const f1 = facts(snapOf(few, 2000) as never);
  const old = keyChunks(1000, f0);
  const fresh = keyChunks(2000, f1);
  assert.equal(old.length, 3);
  assert.equal(fresh.length, 2);
  const recs: { n: number; t: number; k: string; b: string | null; x: unknown }[] = [];
  let n = 0;
  recs.push({ n: ++n, t: 1000, k: 'key', b: null, x: old[0] });
  recs.push({ n: ++n, t: 1000, k: 'key', b: null, x: old[1] });   // its third chunk never came
  for (const c of fresh) recs.push({ n: ++n, t: 2000, k: 'key', b: null, x: c });
  const states = replay(recs);
  assert.equal(states.length, 1, 'only the whole new key reads back');
  assert.equal(states[0].at, 2000);
  assert.deepEqual(states[0].facts, f1);
});

// ---- the eye writes the box

test('a first look writes a key; a look with nothing new is only its at', () => {
  const dir = fresh('first');
  const s = snapOf([dev('a')], 1000);
  // the real forecast's view moves with every look it learns from; a steady one is put in its
  // place so that the "nothing new" case can be seen
  const steady = () => ({ built: true, stat: 'steady', gauge: 50, rows: [], lines: [] });
  const eye = new GodsEye({ snapshot: () => s, dir: fresh('notes'), box: { dir }, makers: { forecast: () => ({ id: 'forecast', observe() {}, view: steady }) } });
  eye.tick();
  const st = openBox({ dir }).status();
  assert.deepEqual(eye.view().box, { count: st.count, from: st.from, head: st.head, bytes: st.bytes, ok: st.ok, problem: st.problem });
  const rs = recordsOf(dir).filter((r) => r.k === 'key' || r.k === 'look');
  assert.deepEqual(rs.map((r) => r.k), ['key', 'key']);   // chunk 0 and the one device chunk
  assert.deepEqual([rs[0].x.i, rs[0].x.of], [0, 2]);
  assert.deepEqual(rs[0].x.host, { name: 'mac', freeMb: 4000, ledger: null });
  assert.equal('devices' in rs[0].x, false);
  assert.deepEqual(rs[1].x.devices, facts(s as never).devices);
  // the key look records every branch's first view in its first chunk, and saves their digests
  assert.equal((rs[0].x.v as Record<string, unknown[]>).forecast[1], 'steady');
  assert.equal((rs[0].x.v as Record<string, unknown[]>).senses.length, 4);
  eye.tick();   // nothing changed: the look says only when
  const rs2 = recordsOf(dir).filter((r) => r.k === 'key' || r.k === 'look');
  assert.deepEqual(rs2.map((r) => r.k), ['key', 'key', 'look']);
  assert.deepEqual(rs2[2].x, { at: 1000 });   // unchanged: the look says only when
});

test('sentinels in where, reason, keys, certificates, lines, peers, requests, titles, lines and decisions never reach the box', () => {
  const dir = fresh('private');
  const sentinels = [
    'sntl-where-10.9.8.7:4444', 'sntl-reason-timeout', 'sntl-trust-id', 'sntl-pub-key', 'sntl-cert-blob',
    'sntl-ledger-line', 'sntl-reject-why', 'sntl-reject-peer', 'sntl-loading-line', 'sntl-plan-text',
    'sntl-decision-text', 'sntl-project-title', 'sntl-project-request', 'sntl-project-line', 'sntl-project-error',
  ];
  const s = snapOf([dev('p1', {
    where: 'sntl-where-10.9.8.7:4444', reason: 'sntl-reason-timeout',
    trust: {
      at: 900, error: null, id: 'sntl-trust-id', alg: 'ed25519', pub: 'sntl-pub-key', store: 'keystore',
      cert: 'sntl-cert-blob', certPinned: true, v1: false, paired: 1, self: 'ok', count: 5, head: 'sntl-head-hash',
      lines: ['sntl-ledger-line'], restartedAt: null, rejectsDay: {},
      rejectsLast: [{ t: 900, why: 'sntl-reject-why', peer: 'sntl-reject-peer' }],
    },
  })], 1000, {
    work: work({ loading: { mode: 'apart', model: 'm1', since: 900, line: 'sntl-loading-line' }, plan: ['sntl-plan-text'], decisions: [{ at: 900, text: 'sntl-decision-text' }] }),
    projects: [project('n1', { title: 'sntl-project-title', request: 'sntl-project-request', line: 'sntl-project-line', error: 'sntl-project-error' })],
  });
  const eye = new GodsEye({ snapshot: () => s, dir: fresh('notes'), box: { dir } });
  for (let i = 0; i < 3; i++) eye.tick();
  const text = boxText(dir);
  for (const x of sentinels) assert.ok(!text.includes(x), `the box holds ${x}`);
  // the review branch does emit the title; the feed record is scrubbed, and says so
  const feed = recordsKind(dir, 'feed');
  assert.ok(feed.length >= 1, 'the review branch emitted a line');
  assert.ok(feed.some((r) => (r.x as { text: string }).text.includes('[…]')), 'the title was scrubbed out of the feed');
});

test('a shortened title, a masked title and a cut reason keep none of their pieces of eight chars or more', () => {
  const dir = fresh('private-pieces');
  const title1 = `sntlTitleOneA${'a'.repeat(30)}sntlTitleOneB${'b'.repeat(30)}`;          // over 60: review cuts it
  const title2 = `sntlTitleBefore sntl.mail.piece@example.com sntlTitleAfter`;            // masked around the e-mail
  const reason = `sntlReasonHead 10.9.8.7:50551 sntlReasonTail ${'r'.repeat(200)}`;       // senses cuts it at 120
  const s = { current: snapOf([dev('p1')], 1000, { projects: [project('n1', { title: title1 }), project('n2', { title: title2 })] }) };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box: { dir } });
  eye.tick();   // review quotes both titles, masked and cut
  s.current = snapOf([dev('p1', { reachable: false, reason })], 2000, {
    projects: [project('n1', { title: title1, start: 1100, end: 2100 }), project('n2', { title: title2, start: 1100, end: 2100 })],
  });
  eye.tick();   // senses quotes the reason when the device stops answering
  const text = boxText(dir);
  assert.ok(recordsKind(dir, 'feed').length >= 3, 'the branches quoted the title and the reason');
  for (const secret of [title1, title2, reason]) {
    for (let i = 0; i + 8 <= secret.length; i++) {
      const piece = secret.slice(i, i + 8);
      assert.ok(!text.includes(piece), `piece ${JSON.stringify(piece)} of ${JSON.stringify(secret.slice(0, 16))}… is in the box`);
    }
  }
  assert.ok(!text.includes('@'), 'no e-mail reaches the box');
});

test('a four-to-seven char project title never reaches the box', () => {
  const dir = fresh('short-title');
  const s = snapOf([dev('p1')], 1000, { projects: [project('n1', { title: 'Taxes', request: 'file the taxes for the night' })] });
  const eye = new GodsEye({ snapshot: () => s, dir: fresh('notes'), box: { dir } });
  eye.tick();
  const text = boxText(dir);
  assert.ok(!text.includes('Taxes'), 'the short title is not in the box');
  const feed = recordsKind(dir, 'feed');
  assert.ok(feed.length >= 1, 'the review branch quoted the title');
  assert.ok(feed.some((r) => (r.x as { text: string }).text.includes('[…]')), 'the title was cut out of the feed');
});

test('no branch ever quotes a ledger line, a certificate, a public key or a refused peer', () => {
  const ledger = 'sntl-ledger-line-never-quoted';
  const cert = 'sntl-certificate-never-quoted';
  const pub = 'sntl-public-key-never-quoted';
  const peer = 'sntl-refused-peer-never-quoted';
  const s = snapOf([dev('p1', {
    trust: {
      at: 900, error: null, id: 'sntl-claimed-id', alg: 'ed25519', pub, store: 'keystore',
      cert, certPinned: true, v1: false, paired: 1, self: 'ok', count: 3, head: 'h',
      lines: [ledger], restartedAt: null, rejectsDay: { badcode: 1 },
      rejectsLast: [{ t: 900, why: 'bad code', peer }],
    },
  })], 1000);
  const eye = new GodsEye({ snapshot: () => s, dir: fresh('notes'), box: { dir: fresh('unquoted-box') } });
  eye.tick();
  eye.tick();
  const view = JSON.stringify(eye.view());                 // every branch's rows, lines, stat and report
  const feed = eye.view().events.map((e) => e.text).join('\n');
  for (const x of [ledger, cert, pub, peer]) {
    assert.ok(!view.includes(x), `a view text holds ${x}`);
    assert.ok(!feed.includes(x), `a feed line holds ${x}`);
  }
});

test('replay(read()) gives the facts of every kept look, across keys and small-segment retention', () => {
  const boxDir = fresh('replay-box');
  const box = openBox({ dir: boxDir, segmentBytes: 1024, keepBytes: 30_000 });
  const at0 = 1_000_000;
  const base = [dev('a'), dev('b'), dev('c')];
  const byAt = new Map<number, ReturnType<typeof facts>>();
  const s = { current: snapOf(structuredClone(base), at0) };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box });
  for (let i = 0; i < 120; i++) {
    const at = at0 + i * 1000;
    const devices: any[] = base.map((d, j) => structuredClone(d));
    devices[0].reachMs = 10 + (i % 7);
    devices[1].checkedAt = 900 + i;
    if (i >= 30 && i < 60) devices.push(dev('later'));
    const models = i % 7 === 0 ? [model('m1', { size: 1_000 + i })] : [];
    const projects = i % 11 === 0 ? [project('n1', { start: 1000 + i, end: 3000 + i })] : [];
    s.current = { ...snapOf(devices, at), models, projects };
    // a keyframe in the middle and one near the end, so the kept tail starts at a key
    if (i === 40 || i === 100) eye.forget();
    eye.tick();
    byAt.set(at, facts(clean(s.current) as never));
  }
  assert.equal(box.verify().ok, true);
  const states = replay(box.read({ limit: 5000 }));
  assert.ok(states.length >= 20, `only ${states.length} looks could be read back`);
  const r = rng(7);
  for (let i = 0; i < 20; i++) {
    const st = states[Math.floor(r() * states.length)];
    assert.deepEqual(st.facts, byAt.get(st.at), `look at ${st.at}`);
  }
  // the first kept state is a key: the record it completes is a key record
  const all = box.read({ limit: 5000 });
  assert.equal(all.find((x) => x.n === states[0].n)!.k, 'key');
});

test('trust fields change between looks and replay back into the facts', () => {
  const dir = fresh('trust-replay');
  const box = openBox({ dir });
  let at = 1_000_000;
  const trustAt = (i: number) => ({
    at, error: i % 2 ? 'timeout' : null, id: 'trust-id', alg: i % 3 ? 'ed25519' : 'p256', pub: 'pub',
    store: i % 2 ? 'file' : 'keystore', cert: 'cert', certPinned: i % 2 === 0, v1: i % 4 === 0,
    paired: i, self: i % 5 ? 'ok' : 'broken', count: i * 10, head: `head-${i}`, lines: ['line'],
    restartedAt: i % 2 ? null : 900, rejectsDay: { badcode: i }, rejectsLast: [],
  });
  const byAt = new Map<number, ReturnType<typeof facts>>();
  const s = { current: snapOf([dev('p1', { trust: trustAt(0) })], at) };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box });
  for (let i = 0; i < 8; i++) {
    at += 5000;
    s.current = snapOf([dev('p1', { trust: trustAt(i) })], at);
    eye.tick();
    byAt.set(at, facts(clean(s.current) as never));
  }
  const states = replay(box.read({ limit: 5000 }));
  assert.equal(states.length, 8);
  for (const st of states) assert.deepEqual(st.facts, byAt.get(st.at), `look at ${st.at}`);
  const looks = recordsKind(dir, 'look');
  const changes = looks.map((r) => (r.x as { d?: { dev?: Record<string, { trust?: unknown }> } }).d?.dev?.p1).filter((x) => x !== undefined);
  assert.ok(changes.length >= 1, 'a look names the trust fields that changed');
  for (const c of changes) assert.ok(c.trust !== undefined, 'the trust fields ride in the delta');
  assert.equal(openBox({ dir }).verify().ok, true);
});

test('40 devices, every reachMs changing: no record is cut and every key chunk stays under 12 000 chars', () => {
  const dir = fresh('forty');
  const devices = Array.from({ length: 40 }, (_, i) => dev(`dev-${String(i).padStart(2, '0')}`, { reachMs: 10 + i }));
  const s = { current: snapOf(structuredClone(devices), 1000) };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box: { dir } });
  for (let i = 0; i < 6; i++) {
    for (const d of devices) d.reachMs = 10 + ((i * 7) % 13);
    s.current = snapOf(structuredClone(devices), 1000 + i * 5000);
    eye.tick();
  }
  const rs = recordsOf(dir);
  for (const x of rs) {
    assert.notEqual((x.x as { cut?: boolean } | null)?.cut, true, `record n ${x.n} was cut`);
    assert.ok(JSON.stringify(x.x).length <= 12_000, `record n ${x.n} is ${JSON.stringify(x.x).length} chars`);
  }
  const looks = rs.filter((x) => x.k === 'look');
  assert.ok(looks.length >= 1);
  const keys = rs.filter((x) => x.k === 'key');
  const keySizes = keys.map((x) => JSON.stringify(x.x).length);
  console.log(`40 devices: ${rs.length} records, look payloads ${looks.map((x) => JSON.stringify(x.x).length).join(', ')} chars, key chunks ${keySizes.join(', ')} chars (${keySizes.reduce((a, b) => a + b, 0)} total)`);
});

test('a restart on the same box dir: n continues, a start record, the chain verifies', () => {
  const dir = fresh('restart');
  const notes = fresh('notes');
  const s = snapOf([dev('a')], 1000);
  const first = new GodsEye({ snapshot: () => s, dir: notes, box: { dir }, now: () => 5000 });
  first.start();
  first.stop();
  const before = recordsOf(dir);
  assert.ok(before.some((r) => r.k === 'start'));
  assert.ok(before.some((r) => r.k === 'key'));
  const lastN = before[before.length - 1].n;

  const second = new GodsEye({ snapshot: () => snapOf([dev('a')], 2000), dir: notes, box: { dir }, now: () => 6000 });
  second.tick();
  const all = recordsOf(dir);
  const after = all.filter((r) => r.n > lastN);
  assert.equal(after[0].n, lastN + 1, 'n continued from the record on disk');
  assert.deepEqual(after.slice(0, 2).map((r) => r.k), ['key', 'key']);   // a fresh create makes the first look a key
  assert.deepEqual(after[0].x.at, 2000);
  assert.ok(second.view().box!.count > before.length);
  second.tick();
  const look = recordsOf(dir).filter((r) => r.n > lastN).find((r) => r.k === 'look')!;
  assert.equal(look.x.at, 2000);
  assert.equal('d' in look.x, false, 'the restarted eye saw the same facts');
  assert.equal(openBox({ dir }).verify().ok, true);
});

test('a restarted eye writes its start record after the old chain and verifies', () => {
  const dir = fresh('restart-start');
  const notes = fresh('notes');
  const s = snapOf([dev('a')], 1000);
  const first = new GodsEye({ snapshot: () => s, dir: notes, box: { dir }, now: () => 5000 });
  first.start();
  first.stop();
  const n1 = recordsOf(dir).length;
  const second = new GodsEye({ snapshot: () => s, dir: notes, box: { dir }, now: () => 6000 });
  second.start();
  second.stop();
  const rs = recordsOf(dir);
  assert.equal(rs[n1].k, 'start');
  assert.deepEqual(rs[n1].x, { v: 1, everyMs: 5000 });
  assert.deepEqual(rs.slice(n1).find((r) => r.k === 'stop')!.x, {});
  assert.equal(openBox({ dir }).verify().ok, true);
});

test('forget keeps the box, records the files it removed, and the next look is a key', () => {
  const dir = fresh('forget-box');
  const notes = fresh('notes');
  const s = snapOf([dev('a')], 1000);
  const eye = new GodsEye({ snapshot: () => s, dir: notes, box: { dir } });
  eye.tick();
  const nBefore = recordsOf(dir).length;
  const files = fs.readdirSync(notes).filter((f) => f.endsWith('.json')).length;
  eye.forget();
  assert.ok(fs.existsSync(dir), 'the box dir survives forget');
  const rs = recordsOf(dir);
  const forget = rs[rs.length - 1];
  assert.equal(forget.k, 'forget');
  assert.deepEqual(forget.x, { files });
  assert.ok(files > 0);
  eye.tick();
  const after = recordsOf(dir).slice(rs.length);
  assert.equal(after[0].k, 'key');
  assert.ok(recordsOf(dir).length > nBefore + 1);
});

test('acts are recorded, refused ones too, and an arg that is no device id is nulled with its length', () => {
  const dir = fresh('act');
  const s = snapOf([dev('p1')], 1000);
  const eye = new GodsEye({ snapshot: () => s, dir: fresh('notes'), box: { dir } });
  eye.tick();
  assert.equal(eye.act('trust', 'accept', 'p1'), null);            // the device has no fault: refused
  assert.equal(eye.act('trust', 'accept', 'not-a-device'), null);  // unknown arg
  const acts = recordsKind(dir, 'act');
  assert.equal(acts.length, 2);
  assert.equal(acts[0].b, 'trust');
  assert.deepEqual(acts[0].x, { action: 'accept', arg: 'p1', word: null });
  assert.deepEqual(acts[1].x, { action: 'accept', arg: null, argLen: 12, word: null });
});

test("an act's action and word are scrubbed too", () => {
  const dir = fresh('act-scrub');
  const title = 'sntl-act-title-words';
  const s = snapOf([dev('p1')], 1000, { projects: [project('n1', { title })] });
  const eye = new GodsEye({
    snapshot: () => s, dir: fresh('notes'), box: { dir },
    makers: { review: () => ({ id: 'review', observe() {}, view: () => ({ built: false, stat: '', gauge: null, rows: [], lines: [] }), act: () => `done ${title}` }) },
  });
  eye.tick();
  assert.equal(eye.act('review', `accept ${title}`, title), `done ${title}`);   // the branch still gets the words
  const acts = recordsKind(dir, 'act');
  assert.equal(acts.length, 1);
  assert.deepEqual(acts[0].x, { action: 'accept […]', arg: null, argLen: title.length, word: 'done […]' });
  assert.ok(!boxText(dir).includes(title));
});

test('a box that fails and then throws never stops the eye; recovery writes a gap and then a key', () => {
  const records: { t: number; k: string; b: string | null; x: unknown }[] = [];
  let mode: 'false' | 'throw' | 'ok' = 'ok';
  const stub = {
    append(t: number, k: string, b: string | null, x: unknown): boolean {
      if (mode === 'false') return false;
      if (mode === 'throw') throw null;
      records.push({ t, k, b, x });
      return true;
    },
    verify: () => ({ ok: true, from: 0, count: records.length, head: null, problem: null }),
    read: () => [],
    status: () => {
      if (mode === 'throw') throw null;
      return { count: records.length, from: records.length ? 1 : 0, head: null, bytes: 0, segments: records.length ? 1 : 0, ok: mode !== 'false', problem: mode === 'false' ? 'the disk is full' : null };
    },
    accept: () => {},
  };
  let observed = 0;
  const s = { current: snapOf([dev('a')], 1000) };
  const eye = new GodsEye({
    snapshot: () => s.current, dir: fresh('notes'), box: stub as never,
    makers: { senses: (ctx) => ({ id: 'senses', observe(now) { observed++; ctx.emit('a line'); }, view: () => ({ built: true, stat: 'senses sees', gauge: null, rows: [], lines: [] }) }) },
  });
  assert.doesNotThrow(() => eye.tick());     // a whole key is on the box: the delta base exists
  assert.equal(observed, 1);
  assert.ok(records.some((r) => r.k === 'key'));
  const base = records.length;

  mode = 'false';
  s.current = snapOf([dev('a', { reachMs: 20 })], 2000);   // a look that would be a delta
  assert.doesNotThrow(() => eye.tick());
  assert.equal(observed, 2, 'the branches still observed while the box failed');
  assert.equal(eye.view().box!.ok, false);
  assert.equal(eye.view().branches.find((b) => b.id === 'senses')!.stat, 'senses sees');
  mode = 'throw';
  s.current = snapOf([dev('a', { reachMs: 30 })], 3000);
  assert.doesNotThrow(() => eye.tick());
  assert.equal(observed, 3);
  assert.equal(eye.view().box!.ok, false, 'a throwing status is not a healthy chain');

  mode = 'ok';
  s.current = snapOf([dev('a', { reachMs: 40 })], 4000);
  assert.doesNotThrow(() => eye.tick());
  assert.equal(observed, 4);
  const after = records.slice(base);
  assert.equal(after[0].k, 'gap');
  assert.ok((after[0].x as { missed: number }).missed > 0);
  assert.equal(after[1].k, 'key');            // the first record after a failure is a full key
  assert.ok(after.some((r) => r.k === 'feed'));
  assert.equal(eye.view().box!.ok, true);
});

test('an append that throws is a missed append: a gap and then a key, never a delta on the lost base', () => {
  const records: { t: number; k: string; b: string | null; x: unknown }[] = [];
  let mode: 'ok' | 'throw' = 'ok';
  const stub = {
    append(t: number, k: string, b: string | null, x: unknown): boolean {
      if (mode === 'throw') throw null;
      records.push({ t, k, b, x });
      return true;
    },
    verify: () => ({ ok: true, from: 0, count: records.length, head: null, problem: null }),
    read: () => [],
    status: () => ({ count: records.length, from: records.length ? 1 : 0, head: null, bytes: 0, segments: records.length ? 1 : 0, ok: true, problem: null }),
    accept: () => {},
  };
  const s = { current: snapOf([dev('a')], 1000) };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box: stub as never });
  eye.tick();                                        // a whole key: the delta base exists
  const base = records.length;
  mode = 'throw';
  s.current = snapOf([dev('a', { reachMs: 20 })], 2000);
  assert.doesNotThrow(() => eye.tick());             // the throw never reaches the caller
  mode = 'ok';
  s.current = snapOf([dev('a', { reachMs: 30 })], 3000);
  eye.tick();
  const after = records.slice(base);
  assert.equal(after[0].k, 'gap');
  assert.ok((after[0].x as { missed: number }).missed >= 1, 'the throw was counted');
  assert.ok(after.some((r) => r.k === 'key'));
  assert.ok(!after.some((r) => r.k === 'look'), 'no delta is written on a base whose record was lost');
});

test('a key whose second chunk fails is not the base: the next look is a full key, after a gap', () => {
  const records: { t: number; k: string; b: string | null; x: unknown }[] = [];
  let failSecond = true;
  const stub = {
    append(t: number, k: string, b: string | null, x: unknown): boolean {
      if (k === 'key' && (x as { i?: number }).i === 1 && failSecond) { failSecond = false; return false; }
      records.push({ t, k, b, x });
      return true;
    },
    verify: () => ({ ok: true, from: 0, count: records.length, head: null, problem: null }),
    read: () => [],
    status: () => ({ count: records.length, from: records.length ? 1 : 0, head: null, bytes: 0, segments: records.length ? 1 : 0, ok: true, problem: null }),
    accept: () => {},
  };
  const s = { current: snapOf([dev('a')], 1000) };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box: stub as never });
  eye.tick();                                        // chunk 0 lands, chunk 1 fails
  const first = records.map((r) => r.k);
  assert.equal(first.filter((k) => k === 'key').length, 1, 'the second chunk never landed');
  assert.ok(!first.includes('look'));
  const at = records.length;
  s.current = snapOf([dev('a', { reachMs: 20 })], 2000);
  eye.tick();
  const after = records.slice(at).map((r) => r.k);
  assert.deepEqual(after, ['key', 'key']);           // the whole key again, not a delta
  assert.ok(!records.map((r) => r.k).includes('look'), 'the half-written key is no base for a delta');
});

test('a status that throws after a healthy one is not a healthy chain', () => {
  const records: { k: string }[] = [];
  let throwStatus = false;
  const stub = {
    append(_t: number, k: string): boolean { records.push({ k }); return true; },
    verify: () => ({ ok: true, from: 0, count: records.length, head: null, problem: null }),
    read: () => [],
    status: () => {
      if (throwStatus) throw null;
      return { count: records.length, from: records.length ? 1 : 0, head: null, bytes: 0, segments: records.length ? 1 : 0, ok: true, problem: null };
    },
    accept: () => {},
  };
  const s = { current: snapOf([dev('a')], 1000) };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box: stub as never });
  eye.tick();
  assert.equal(eye.view().box!.ok, true);
  throwStatus = true;
  s.current = snapOf([dev('a', { reachMs: 20 })], 2000);
  eye.tick();                                        // appends work; the status cannot be read
  assert.equal(eye.view().box!.ok, false);
  assert.match(eye.view().box!.problem ?? '', /could not be read/);
  throwStatus = false;
  s.current = snapOf([dev('a', { reachMs: 30 })], 3000);
  eye.tick();
  assert.equal(eye.view().box!.ok, true);
});

test('a look too big for one record is written as a key, never cut', () => {
  const dir = fresh('too-big');
  const devices = Array.from({ length: 40 }, (_, i) => dev(`big-${String(i).padStart(2, '0')}`));
  const s = { current: snapOf(structuredClone(devices), 1000) };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box: { dir } });
  eye.tick();
  for (let i = 0; i < 3; i++) {
    // every string of every device changes: the delta is far past one record's payload bound
    for (const d of devices) {
      d.name = `name ${i} ${'n'.repeat(70)}`;
      d.holds = `holds ${i} ${'h'.repeat(280)}`;
      d.gpu = `gpu ${i} ${'g'.repeat(70)}`;
      d.lastOk = `ok ${i} ${'o'.repeat(70)}`;
      d.reachMs = 10 + i;
    }
    s.current = snapOf(structuredClone(devices), 1000 + (i + 1) * 5000);
    eye.tick();
  }
  const rs = recordsOf(dir);
  for (const r of rs) {
    assert.notEqual((r.x as { cut?: boolean } | null)?.cut, true, `record n ${r.n} was cut`);
    assert.ok(JSON.stringify(r.x).length <= 12_000, `record n ${r.n} is ${JSON.stringify(r.x).length} chars`);
  }
  // the second and third looks were keys, not one oversized delta
  const looks = rs.filter((r) => r.k === 'look');
  assert.deepEqual(looks, []);
  console.log(`too big: ${rs.length} key records, largest ${Math.max(...rs.map((r) => JSON.stringify(r.x).length))} chars`);
});

test('a secret in a branch stat or a broken why is scrubbed out of the box', () => {
  const dir = fresh('scrub-text');
  const s = snapOf([dev('p1')], 1000, { projects: [project('n1', { title: 'sntl-title-two' })] });
  const eye = new GodsEye({
    snapshot: () => s, dir: fresh('notes'), box: { dir },
    makers: {
      advisor: () => ({ id: 'advisor', observe() {}, view: () => ({ built: true, stat: 'about sntl-title-two', gauge: null, rows: [], lines: [] }) }),
      limits: () => ({ id: 'limits', observe() { throw new Error('it broke on sntl-title-two'); }, view: () => ({ built: false, stat: '', gauge: null, rows: [], lines: [] }) }),
    },
  });
  eye.tick();   // the key carries each changed branch's view (the advisor's stat) and the broken why
  const text = boxText(dir);
  assert.ok(!text.includes('sntl-title-two'), 'the title is not in the box');
  const v = recordsKind(dir, 'key').map((r) => (r.x as { v?: Record<string, unknown[]> }).v).find((x) => x !== undefined);
  assert.ok(v !== undefined);
  assert.equal((v.advisor as unknown[])[1], 'about […]');
  const broken = recordsKind(dir, 'broken');
  assert.equal(broken.length, 1);
  assert.equal((broken[0].x as { why: string }).why, 'it broke on […]');
});

test('verdict records follow the trust report: the first one says where it came from', () => {
  const dir = fresh('verdict');
  const s = snapOf([dev('p1')], 1000, { host: { name: 'mac', freeMb: 4000, ledger: { ok: false, count: 5, problem: 'a broken chain' } } });
  const eye = new GodsEye({ snapshot: () => s, dir: fresh('notes'), box: { dir } });
  eye.tick();
  const vs = recordsKind(dir, 'verdict');
  assert.ok(vs.length >= 2);
  for (const r of vs) assert.equal(r.b, 'trust');
  const x = vs.map((r) => r.x as { who: string; from: string | null; to: string });
  assert.deepEqual(x.find((v) => v.who === '*'), { who: '*', from: null, to: 'bad' });
  assert.deepEqual(x.find((v) => v.who === 'host'), { who: 'host', from: null, to: 'bad' });
  assert.ok(x.some((v) => v.who === 'p1'));
  // nothing changed: no verdict is written again
  eye.tick();
  assert.equal(recordsKind(dir, 'verdict').length, vs.length);
  // the host's ledger holds again: the change names what it was
  s.host.ledger = { ok: true, count: 5, problem: null };
  s.at = 2000;
  eye.tick();
  const after = recordsKind(dir, 'verdict').map((r) => r.x as { who: string; from: string | null; to: string });
  assert.deepEqual(after.filter((v) => v.who === 'host').at(-1), { who: 'host', from: 'bad', to: 'ok' });
  assert.deepEqual(after.filter((v) => v.who === '*').at(-1), { who: '*', from: 'bad', to: 'unknown' });
});

test('what the guard left out is counted in the look', () => {
  const dir = fresh('left');
  const s = { current: snapOf([dev('a'), null, dev('a', { reachMs: 5 })], 1000) as never };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box: { dir } });
  eye.tick();                                   // the key holds the one usable device
  eye.tick();                                   // the same facts: the views are named the first time
  eye.tick();                                   // now only the at and the left-out count
  const looks = recordsKind(dir, 'look');
  assert.ok(looks.length >= 2);
  const last = looks[looks.length - 1];
  assert.equal(last.x.at, 1000);
  assert.deepEqual(last.x.left, { devices: 2, models: 0, projects: 0 });
});

test('a far-forward look and a far-back look are both recorded; nothing is dropped for being ahead', () => {
  const dir = fresh('clock');
  const s = { current: snapOf([dev('a')], 8_000_000_000_000_000) };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box: { dir } });
  eye.tick();
  s.current = snapOf([dev('a', { reachMs: 20 })], 8_000_000_000_000_001);
  eye.tick();
  s.current = snapOf([dev('a', { reachMs: 30 })], 1000);          // the clock jumped back years
  eye.tick();
  const rs = recordsOf(dir).filter((r) => r.k === 'key' || r.k === 'look');
  assert.deepEqual(rs.map((r) => r.k), ['key', 'key', 'look', 'look']);
  assert.deepEqual(rs.map((r) => r.t), [8_000_000_000_000_000, 8_000_000_000_000_000, 8_000_000_000_000_001, 1000]);
  const states = replay(rs);
  assert.deepEqual(states[states.length - 1].facts, facts(clean(s.current) as never));
  assert.equal(openBox({ dir }).verify().ok, true);
});

// ---- the budget: how big a look is and how long a tick's box work takes

test('the budget: mean look size, box time per tick, and one append on a quiet tick', () => {
  // five devices, two fields moving every look
  const fiveDir = fresh('budget-five');
  const five = Array.from({ length: 5 }, (_, i) => dev(`p${i}`));
  const s5 = { current: snapOf(structuredClone(five), 1_700_000_000_000) };
  const eye5 = new GodsEye({ snapshot: () => s5.current, dir: fresh('notes'), box: { dir: fiveDir }, now: () => 1_700_000_000_000 });
  for (let i = 0; i < 200; i++) {
    for (const d of five) { d.reachMs = 10 + (i % 9); d.ramMb = 3000 + (i % 400); }
    s5.current = snapOf(structuredClone(five), 1_700_000_000_000 + i * 5000);
    eye5.tick();
  }
  const fiveLooks = recordsKind(fiveDir, 'look');
  const fiveMean = fiveLooks.reduce((a, r) => a + JSON.stringify(r.x).length, 0) / fiveLooks.length;
  assert.ok(fiveMean <= 1200, `mean look ${fiveMean.toFixed(1)} chars at 5 devices`);

  // forty devices, every reachMs changing every look
  const fortyDir = fresh('budget-forty');
  const forty = Array.from({ length: 40 }, (_, i) => dev(`d${String(i).padStart(2, '0')}`));
  const s40 = { current: snapOf(structuredClone(forty), 1_700_000_000_000) };
  const eye40 = new GodsEye({ snapshot: () => s40.current, dir: fresh('notes'), box: { dir: fortyDir }, now: () => 1_700_000_000_000 });
  for (let i = 0; i < 100; i++) {
    for (const d of forty) d.reachMs = 10 + ((i * 3) % 40);
    s40.current = snapOf(structuredClone(forty), 1_700_000_000_000 + i * 5000);
    eye40.tick();
  }
  const fortyLooks = recordsKind(fortyDir, 'look');
  const fortyMean = fortyLooks.reduce((a, r) => a + JSON.stringify(r.x).length, 0) / fortyLooks.length;
  assert.ok(fortyMean <= 5000, `mean look ${fortyMean.toFixed(1)} chars at 40 devices`);

  // the box's own time per tick over 500 ticks, and an unchanged look is one record
  const timeDir = fresh('budget-time');
  const real = openBox({ dir: timeDir });
  const times: number[] = [];
  let spent = 0;
  const timed = {
    append(t: number, k: string, b: string | null, x: unknown): boolean {
      const t0 = performance.now();
      try { return real.append(t, k, b, x); } finally { spent += performance.now() - t0; }
    },
    status() { const t0 = performance.now(); try { return real.status(); } finally { spent += performance.now() - t0; } },
    verify: () => real.verify(), read: (q?: never) => real.read(q), accept: () => real.accept(),
  };
  const still = snapOf(structuredClone(five), 1_700_000_000_000);
  const eye = new GodsEye({ snapshot: () => still, dir: fresh('notes'), box: timed as never, now: () => 1_700_000_000_000 });
  for (let i = 0; i < 30; i++) eye.tick();   // warm up the branches' first views
  const baseCount = real.status().count;
  for (let i = 0; i < 500; i++) {
    spent = 0;
    eye.tick();
    times.push(spent);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p99 = times[Math.min(times.length - 1, Math.floor(times.length * 0.99))];
  console.log(`box time: median ${median.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms over ${times.length} ticks`);
  console.log(`mean look: ${fiveMean.toFixed(1)} chars at 5 devices, ${fortyMean.toFixed(1)} chars at 40`);
  // the 10th percentile, not the median: a loaded full suite (the bench runs beside it) slows most
  // ticks, while a box doing too much work is slow on every tick
  assert.ok(times[Math.floor(times.length * 0.1)] <= 2, `p10 box time ${times[Math.floor(times.length * 0.1)]} ms (median ${median})`);
  assert.ok(p99 <= 20, `p99 box time ${p99} ms`);
  assert.equal(real.status().count - baseCount, 500, 'exactly one record per quiet tick');
});

test('256 KiB of brand-new random secrets is windowed in under 20 ms', () => {
  const bytes = 4 * 64 * 1024;
  assert.ok(bytes <= NEW_TEXT_MAX, `${bytes} chars of new text`);
  // each run needs brand-new secrets, so it is the look's windowing that is measured, not a cache hit
  const once = (): number => {
    const secrets = Array.from({ length: 4 }, () => crypto.randomBytes(32 * 1024).toString('hex'));   // 64 KiB each
    const t0 = performance.now();
    const red = makeScrubber(secrets);
    const ms = performance.now() - t0;
    assert.equal(red.over, false);
    return ms;
  };
  const { median, samples } = medianMs(once);
  console.log(`256 KiB new random secrets: median ${median.toFixed(2)} ms of ${samples.length} samples`);
  assert.ok(Math.min(...samples) < 100, `windowed ${bytes} chars in ${Math.min(...samples)} ms at best (median ${median}, ${samples.length} samples)`);
});

test('secrets whose window hashes share their low bits are spread by the high-bit slot', () => {
  // the characters follow c[i+8] = 31^8 * c[i] - 30 (mod 2^15) from seven random starts, so every
  // eight-char window hash is ≡ 1 (mod 2^15). a slot taken from the low bits of the hash then
  // leaves only a handful of slots for the whole look and linear probing takes seconds; the slot
  // must come from the high bits
  const MOD = 1 << 15;
  const POW = [1];
  for (let k = 1; k <= 8; k++) POW[k] = (POW[k - 1] * 31) % MOD;
  const A = POW[8];
  const crafted = (seed: number): string => {
    const n = 64 * 1024;
    const codes = new Array<number>(n);
    let x = seed >>> 0 || 1;
    const next = (): number => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % MOD; };
    let sum = 0;
    for (let j = 0; j < 7; j++) { codes[j] = next(); sum = (sum + codes[j] * POW[7 - j]) % MOD; }
    codes[7] = (((1 - sum) % MOD) + MOD) % MOD;      // the first window hash ≡ 1 (mod 2^15)
    for (let i = 8; i < n; i++) codes[i] = ((A * codes[i - 8] - 30) % MOD + MOD) % MOD;
    let s = '';
    for (let i = 0; i < n; i += 4096) s += String.fromCharCode(...codes.slice(i, i + 4096));
    return s;
  };
  let seed = 1;
  const once = (): number => {
    const secrets = [crafted(seed++), crafted(seed++), crafted(seed++), crafted(seed++)];
    const t0 = performance.now();
    const red = makeScrubber(secrets);
    const ms = performance.now() - t0;
    assert.equal(red.over, false);
    return ms;
  };
  const { median, samples } = medianMs(once);
  console.log(`low-bit-sharing secrets, 256 KiB: median ${median.toFixed(2)} ms of ${samples.length} samples`);
  // the fastest sample: a loaded machine (five fixers' tests at once) slows the median, never the
  // cost of the work itself; a quadratic windowing would make every sample slow
  assert.ok(Math.min(...samples) < 100, `windowed 256 KiB of low-bit-sharing secrets in ${Math.min(...samples)} ms at best (median ${median}, ${samples.length} samples)`);
});

test('a changed secret each look is inserted, not re-windowed: 7.5 MiB cached, one reason a look', () => {
  // five devices' ledger lines of 3000 chars: 7.5 MiB, all cached; every look brings one new
  // 200-char reason and drops the last. a full re-insert per look would cost about a second
  const lines: string[] = [];
  for (let i = 0; i < 2500; i++) lines.push(crypto.randomBytes(1500).toString('hex'));   // 3000 chars each
  const chars = lines.reduce((a, s) => a + s.length, 0);
  assert.ok(chars > 7 * 1024 * 1024 && chars < CACHE_TEXT_MAX, `${chars} chars`);
  let red = makeScrubber(lines);
  let fills = 0;
  for (; fills < 60 && red.over; fills++) red = makeScrubber(lines);
  assert.equal(red.over, false, `${fills} looks to cache 7.5 MiB`);
  const samples: number[] = [];
  for (let i = 0; i < 100; i++) {
    const reason = crypto.randomBytes(100).toString('hex');   // 200 chars, new every look
    const t0 = performance.now();
    const now = makeScrubber([...lines, reason]);
    now.scrub(`a line quoting ${reason} here`);
    samples.push(performance.now() - t0);
    assert.equal(now.over, false, `look ${i} was withheld`);
    assert.equal(typeof now.scrub('a plain quoted line'), 'string');
  }
  const median = medianOf(samples);
  console.log(`7.5 MiB cached + one changed reason, 100 looks: median ${median.toFixed(2)} ms`);
  assert.ok(median < 5, `the median look took ${median} ms`);
});

test('cached ledger lines make a normal look cheap and its text is not withheld', () => {
  // five devices, five hundred 300-char ledger lines each: 750 KiB, under the 8 MiB cache, but
  // more than one look's 256 KiB of new text. the first looks fill the cache; then a look is free
  const lines: string[] = [];
  for (let i = 0; i < 2500; i++) lines.push(crypto.randomBytes(150).toString('hex'));   // 300 chars
  const chars = lines.reduce((a, s) => a + s.length, 0);
  assert.ok(chars > NEW_TEXT_MAX && chars < CACHE_TEXT_MAX, `${chars} chars`);
  let red = makeScrubber(lines);
  assert.equal(red.over, true);                    // more than one look windows
  for (let i = 0; i < 20 && red.over; i++) red = makeScrubber(lines);
  assert.equal(red.over, false);                   // the rest is windowed; the table is built
  const quote = `line quotes ${lines[0]} now`;
  assert.equal(typeof red.scrub(quote), 'string', 'cached secrets do not withhold honest text');
  const once = (): number => {
    const t0 = performance.now();
    const now = makeScrubber(lines);
    for (let i = 0; i < 50; i++) now.scrub(`line ${i} quotes ${lines[0]} here`);
    return performance.now() - t0;
  };
  const { median, samples } = medianMs(once);
  console.log(`750 KiB cached, one look + 50 quoted lines: median ${median.toFixed(2)} ms of ${samples.length} samples`);
  const check = makeScrubber(lines);
  assert.equal(check.over, false);
  assert.equal(typeof check.scrub(quote), 'string', 'cached secrets do not withhold honest text');
  assert.ok(median < 5, `a cached look took ${median} ms (median of ${samples.length})`);
});

test('the 64 MiB hostile look is withheld and a repeat look stays at 1 ms or less', () => {
  // a device can send a thousand 64 KiB ledger lines; the cache can hold only 8 MiB of text, so
  // most lines are new every look and the look withholds its text, windowing 256 KiB a look
  const repeated = 'a'.repeat(64 * 1024);
  const lines: string[] = [];
  for (let i = 0; i < 500; i++) lines.push(repeated);
  for (let i = 0; i < 500; i++) lines.push(crypto.randomBytes(32 * 1024).toString('hex'));   // 64 KiB each
  const name = 'a'.repeat(80);
  const quoted = (i: number): string => `line ${i} quotes ${name} here`;
  const first = makeScrubber(lines);                 // cold: the 64 MiB is hashed once
  assert.equal(first.over, true);
  assert.deepEqual(first.scrub(quoted(0)), { scrubbed: true, len: quoted(0).length });
  const once = (): number => {
    const t0 = performance.now();
    const again = makeScrubber(lines);
    for (let i = 0; i < 50; i++) again.scrub(quoted(i));
    return performance.now() - t0;
  };
  const { median, samples } = medianMs(once);
  console.log(`64 MiB hostile, repeat look + 50 quoted lines: median ${median.toFixed(2)} ms of ${samples.length} samples`);
  const again = makeScrubber(lines);
  assert.equal(again.over, true);
  for (let i = 0; i < 50; i++) assert.deepEqual(again.scrub(quoted(i)), { scrubbed: true, len: quoted(i).length });
  assert.ok(median < 1, `the repeat look took ${median} ms (median of ${samples.length})`);
});

test('a look whose quotable text passes the cache withholds quoted lines through the eye', () => {
  // a snapshot can carry more quotable text than the cache holds (the plan is not bounded in
  // count); such a look is withheld, and the quoted lines are recorded as markers, not as words
  const plan = Array.from({ length: 9000 }, (_, i) => `${String(i).padStart(5, '0')} ${crypto.randomBytes(500).toString('hex')}`);
  assert.ok(plan.reduce((a, s) => a + s.length, 0) > CACHE_TEXT_MAX);
  const name = 'a'.repeat(80);
  const quoted = (i: number): string => `line ${i} quotes ${name} here`;
  const dir = fresh('huge-secrets');
  const s = snapOf([dev('p1', { name })], 1000, { work: work({ plan }) });
  const eye = new GodsEye({
    snapshot: () => s, dir: fresh('notes'), box: { dir },
    makers: { senses: (ctx) => ({ id: 'senses', observe() { for (let i = 0; i < 50; i++) ctx.emit(quoted(i)); }, view: () => ({ built: true, stat: 'senses sees', gauge: null, rows: [], lines: [] }) }) },
  });
  eye.tick();
  const feed = recordsKind(dir, 'feed');
  assert.ok(feed.length >= 50, `${feed.length} feed records`);
  for (const r of feed) {
    const text = (r.x as { text: Record<string, unknown> }).text;
    assert.deepEqual(Object.keys(text).sort(), ['len', 'scrubbed']);
    assert.equal(text.scrubbed, true);
  }
  assert.ok(!boxText(dir).includes('quotes '), 'no quoted line reaches the box');
});

test('a key is written every 720 looks without one', () => {
  const dir = fresh('keyframe');
  const s = snapOf([dev('a')], 1000);
  const eye = new GodsEye({ snapshot: () => s, dir: fresh('notes'), box: { dir } });
  eye.tick();                                   // key 1
  for (let i = 0; i < 720; i++) eye.tick();     // 720 looks since the key
  assert.equal(recordsOf(dir).filter((r) => r.k === 'look' || r.k === 'key').at(-1)!.k, 'look');
  eye.tick();                                   // the look after 720 since the key is a new key
  const kinds = recordsOf(dir).map((r) => r.k);
  assert.equal(kinds[kinds.length - 1], 'key');
});

test('a key is written after 512 KiB appended, before the 720-look mark', () => {
  const dir = fresh('keybytes');
  const devices = Array.from({ length: 40 }, (_, i) => dev(`b${String(i).padStart(2, '0')}`, { name: 'x'.repeat(70) }));
  const s = { current: snapOf(structuredClone(devices), 1000) };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box: { dir } });
  eye.tick();                                          // key 1: five chunks
  for (let i = 0; i < 400; i++) {
    for (const d of devices) d.name = `${String(i).padStart(4, '0')} ${'x'.repeat(70)}`.slice(0, 80);
    s.current = snapOf(structuredClone(devices), 1000 + (i + 1) * 5000);
    eye.tick();
  }
  const kinds = recordsOf(dir).map((r) => r.k);
  const firstKey = kinds.indexOf('key');
  const nextLook = kinds.indexOf('look', firstKey);
  const nextKey = kinds.indexOf('key', nextLook);
  assert.ok(nextKey > nextLook, 'a second key was written');
  const looks = kinds.slice(nextLook, nextKey).filter((k) => k === 'look').length;
  assert.ok(looks > 0 && looks < 720, `${looks} looks between the keys: the bytes, not the look count, drew the key`);
  assert.ok(looks < 250, `${looks} looks is about the 512 KiB mark for these payloads`);
  console.log(`512 KiB keyframe after ${looks} looks of about ${Math.round(JSON.stringify(recordsOf(dir)[nextLook].x).length)} chars`);
});

test('one hostile look after another: the box record never throws, never holds a bad number, and replay still works', () => {
  const dir = fresh('hostile');
  const rows: unknown[] = [
    null, 'a look', {}, { ...snapOf([dev('a')], 1000), devices: null },
    { ...snapOf([dev('a')], 1000), devices: [null] },
    { ...snapOf([dev('a')], 1000), devices: [dev('__proto__')] },
    { ...snapOf([dev('a')], 1000), devices: [dev('constructor')] },
    { ...snapOf([dev('a')], 1000), work: null },
    { ...snapOf([dev('a')], 1000), host: null },
    { ...snapOf([dev('a', { trust: null })], 1000) },
    { ...snapOf([dev('a')], 1000), work: { loaded: { mode: 'apart', model: null, ctx: 100, since: 900, devices: [null], parts: [null] }, loading: null, chatting: 1, plan: [null], decisions: [null], llama: true } },
    { ...snapOf([dev('a')], 1000), models: [null], projects: [null] },
    { ...snapOf([dev('a')], 1000), at: NaN },
  ];
  const s = { current: rows[0] as never };
  const eye = new GodsEye({ snapshot: () => s.current, dir: fresh('notes'), box: { dir } });
  for (const row of rows) {
    s.current = row as never;
    assert.doesNotThrow(() => eye.tick());
    const v = eye.view();
    assert.doesNotMatch(JSON.stringify(v), /NaN|undefined|\[object Object\]|e\+\d/);
  }
  s.current = snapOf([dev('a')], 2000) as never;
  eye.tick();
  s.current = snapOf([dev('__proto__'), dev('constructor')], 3000) as never;
  eye.tick();
  assert.equal(({} as { name?: unknown }).name, undefined, 'nothing reached Object.prototype');
  const rs = recordsOf(dir);
  for (const r of rs) assert.doesNotMatch(JSON.stringify(r.x), /NaN|\[object Object\]/);
  assert.equal(openBox({ dir }).verify().ok, true);
  const states = replay(rs);
  assert.ok(states.length >= 1);
  assert.deepEqual(states[states.length - 1].facts, facts(clean(s.current) as never));
  // the box records the skipped looks, with only the two words
  const skips = recordsKind(dir, 'skip');
  assert.ok(skips.length >= 3);
  for (const r of skips) assert.ok(['threw', 'unusable'].includes((r.x as { why: string }).why));
});

test('the eye imports nothing of kula: the import rule still holds with boxfacts and the box', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'godseye');
  const files = fs.readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of text.matchAll(/from '([^']+)'/g)) {
      const spec = m[1];
      const inside = (spec.startsWith('./') || spec.startsWith('../')) && path.resolve(root, path.dirname(f), spec).startsWith(root + path.sep);
      assert.ok(spec.startsWith('node:') || inside, `${f} imports ${spec}`);
    }
  }
});
