// god's eye guard (src/godseye/branches/guard.ts): the one gate every snapshot passes. Each
// helper gets hand-made cases, clean() gets hostile ones, and a healthy snapshot comes out
// exactly as it went in.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TIME_MAX, ID_MAX, NAME_MAX, isObj, isTime, num, idOf, nameOf, list, median, clean, dropped, safeId } from '../src/godseye/branches/guard.ts';

const hash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 16);
/** the stand-in the guard prescribes for an unsafe id: '~' + 16 hex of sha256(id) + '~' + its first
 *  40 chars with every char outside [A-Za-z0-9._:-] replaced by '_'. worked out here, not copied */
const stand = (id: string) => `~${hash(id)}~${id.slice(0, 40).replace(/[^A-Za-z0-9._:-]/g, '_')}`;

test('isObj: an object (an array too: typeof), nothing else', () => {
  assert.equal(isObj({}), true);
  assert.equal(isObj([]), true);
  assert.equal(isObj({ a: 1 }), true);
  assert.equal(isObj(null), false);
  assert.equal(isObj('x'), false);
  assert.equal(isObj(0), false);
  assert.equal(isObj(undefined), false);
});

test('isTime: finite, not negative, date-sized', () => {
  assert.equal(isTime(0), true);
  assert.equal(isTime(1000), true);
  assert.equal(isTime(TIME_MAX), true);
  assert.equal(isTime(TIME_MAX + 1), false);
  assert.equal(isTime(-1), false);
  assert.equal(isTime(NaN), false);
  assert.equal(isTime(Infinity), false);
  assert.equal(isTime('1000'), false);
  assert.equal(isTime(null), false);
});

test('num: a finite number within [lo, hi], else null', () => {
  assert.equal(num(5, 0, 10), 5);
  assert.equal(num(0, 0, 10), 0);
  assert.equal(num(10, 0, 10), 10);
  assert.equal(num(-1, 0, 10), null);
  assert.equal(num(11, 0, 10), null);
  assert.equal(num(NaN, 0, 10), null);
  assert.equal(num(Infinity, 0, 10), null);
  assert.equal(num('5', 0, 10), null);
  assert.equal(num(null, 0, 10), null);
});

test('idOf: a non-empty string of at most ID_MAX chars, nothing else', () => {
  assert.equal(idOf('p1'), 'p1');
  assert.equal(idOf('x'.repeat(ID_MAX)), 'x'.repeat(ID_MAX));
  assert.equal(idOf(''), null);
  assert.equal(idOf('x'.repeat(ID_MAX + 1)), null);
  assert.equal(idOf(42), null);
  assert.equal(idOf(null), null);
});

test('nameOf: a non-empty name cut to NAME_MAX, else the id cut to NAME_MAX', () => {
  assert.equal(nameOf('pixel', 'p1'), 'pixel');
  assert.equal(nameOf('x'.repeat(100), 'p1'), 'x'.repeat(NAME_MAX));
  assert.equal(nameOf('', 'p1'), 'p1');
  assert.equal(nameOf(42, 'p1'), 'p1');
  assert.equal(nameOf(null, 'p1'), 'p1');
  assert.equal(nameOf(42, 'i'.repeat(200)), 'i'.repeat(NAME_MAX));
});

test('list: the array, or [] when it is not one', () => {
  assert.deepEqual(list([1, 2]), [1, 2]);
  assert.deepEqual(list('x'), []);
  assert.deepEqual(list(null), []);
  assert.deepEqual(list(42), []);
  assert.deepEqual(list({}), []);
});

test('median: the middle value, or the mean of the two middle ones; non-finite entries are skipped', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([2, 4]), 3);
  assert.equal(median([3, 1, 2]), 2);          // sorted, not taken as given
  assert.equal(median([]), null);
  assert.equal(median([NaN, 1, 3]), 2);
  assert.equal(median([1, 3, 'x' as unknown as number]), 2);
});

test('clean returns null when the raw value is not an object or its at is not a usable time', () => {
  assert.equal(clean(null), null);
  assert.equal(clean('a look'), null);
  assert.equal(clean(42), null);
  assert.equal(clean({}), null);              // no at at all
  assert.equal(clean({ at: NaN }), null);
  assert.equal(clean({ at: -1 }), null);
  assert.equal(clean({ at: 1e300 }), null);
  assert.equal(clean({ at: TIME_MAX + 1 }), null);
  assert.equal(clean({ at: '1000' }), null);
  assert.equal(clean([]), null);
});

test('clean: a function is not a snapshot, even with a usable at hanging on it', () => {
  const f = () => 1;
  (f as unknown as { at: number }).at = 1000;
  assert.equal(clean(f), null);
});

test('clean fills an empty but usable look with the agreed empty shape', () => {
  assert.deepEqual(clean({ at: 1000 }), {
    at: 1000,
    host: { name: 'this computer', freeMb: null },
    devices: [],
    work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: false },
    models: [],
    projects: [],
  });
});

test('clean: containers that are not arrays count as empty, entries that are not objects are dropped', () => {
  const s = clean({ at: 1, devices: null, models: 'x', projects: 42, work: { plan: null, decisions: null } });
  assert.deepEqual(s!.devices, []);
  assert.deepEqual(s!.models, []);
  assert.deepEqual(s!.projects, []);
  assert.deepEqual(s!.work.plan, []);
  assert.deepEqual(s!.work.decisions, []);
  assert.deepEqual(clean({ at: 1, devices: [null, 'x', 42, []] })!.devices, []);
  assert.deepEqual(clean({ at: 1, models: [null] })!.models, []);
  assert.deepEqual(clean({ at: 1, projects: [null] })!.projects, []);
});

test('clean: only an entry with no usable id, or a second entry with the same id, is dropped', () => {
  const cut = stand('x'.repeat(201));                  // an id over 200 chars is kept under its stand-in
  assert.deepEqual(clean({ at: 1, devices: [{ id: 42 }, { id: '' }, { id: 'x'.repeat(201) }, { id: 'a', name: 'one' }, { id: 'a', name: 'two' }, { id: 'b' }] })!.devices, [
    { id: cut, name: cut.slice(0, NAME_MAX), kind: '', via: '', where: '', reachable: null, reachMs: null, reason: null, checkedAt: null, lastOk: null, ramMb: null, bwGBs: null, gpu: null, tls: false, waitingPair: false, plugged: null, holds: null, trust: null },
    { id: 'a', name: 'one', kind: '', via: '', where: '', reachable: null, reachMs: null, reason: null, checkedAt: null, lastOk: null, ramMb: null, bwGBs: null, gpu: null, tls: false, waitingPair: false, plugged: null, holds: null, trust: null },
    { id: 'b', name: 'b', kind: '', via: '', where: '', reachable: null, reachMs: null, reason: null, checkedAt: null, lastOk: null, ramMb: null, bwGBs: null, gpu: null, tls: false, waitingPair: false, plugged: null, holds: null, trust: null },
  ]);
});

test('safeId: a real id passes; a prototype key, an overlong id or a leading "~" gets a stand-in', () => {
  assert.equal(safeId('p1'), 'p1');
  assert.equal(safeId('cable:R3C'), 'cable:R3C');
  assert.equal(safeId('a.b_c-d:e'), 'a.b_c-d:e');
  assert.equal(safeId('x'.repeat(ID_MAX)), 'x'.repeat(ID_MAX));   // 200 chars is still a real id
  assert.equal(safeId('valueOf'), stand('valueOf'));
  assert.equal(safeId('__proto__'), stand('__proto__'));
  assert.equal(safeId('~valueOf'), stand('~valueOf'));            // a real id starting with '~' is escaped
  assert.equal(safeId(''), stand(''));                            // an empty id is no id; entryId drops it first
  const long = 'x'.repeat(300);
  assert.equal(safeId(long), `~${hash(long)}~${'x'.repeat(40)}`);
  const odd = 'a b~c/d' + 'e'.repeat(300);                        // over 200: a stand-in, its first 40 masked
  assert.equal(safeId(odd), `~${hash(odd)}~a_b_c_d${'e'.repeat(33)}`);
  assert.equal(safeId(odd).length, 58);                           // 1 + 16 + 1 + 40
  // stable: the same id gives the same stand-in, whatever else is in the list
  for (const id of ['valueOf', '~valueOf', long]) assert.equal(safeId(id), safeId(id));
  // a stand-in is never a key of Object.prototype
  for (const k of Object.getOwnPropertyNames(Object.prototype)) {
    assert.equal(safeId(k) in {}, false, k);
    assert.notEqual(safeId(k), k, k);
  }
});

test('clean: a prototype-key id is kept under a stand-in, though idOf itself keeps it', () => {
  assert.equal(idOf('__proto__'), '__proto__');        // the helper's own definition
  assert.equal(idOf('constructor'), 'constructor');
  const s = clean({ at: 1, devices: [{ id: '__proto__', name: 'x' }, { id: 'constructor' }, { id: 'toString' }, { id: 'p1' }] });
  const [proto, ctor, str] = ['__proto__', 'constructor', 'toString'].map(stand);
  assert.deepEqual(s!.devices.map((d) => d.id), [proto, ctor, str, 'p1']);
  assert.deepEqual(s!.devices.map((d) => d.name), ['x', ctor, str, 'p1']);
  assert.deepEqual(clean({ at: 1, models: [{ id: '__proto__' }] })!.models.map((m) => m.id), [proto]);
  assert.deepEqual(clean({ at: 1, projects: [{ id: 'constructor' }] })!.projects.map((p) => p.id), [ctor]);
  // the same stand-in everywhere an id is read, so a loaded row and a peer point at the same device
  const w = clean({ at: 1, work: { loaded: { model: { id: 'valueOf' }, devices: [{ id: 'valueOf', name: 'v' }], parts: [{ id: 'constructor' }] } } })!.work.loaded!;
  assert.equal(w.model.id, stand('valueOf'));
  assert.deepEqual(w.devices.map((d) => d.id), [stand('valueOf')]);
  assert.deepEqual(w.parts!.map((p) => p.id), [stand('constructor')]);
  assert.equal(({} as any).valueOf, Object.prototype.valueOf);           // nothing leaked onto Object.prototype
  assert.equal(({} as any).constructor, Object.prototype.constructor);
  assert.equal(({} as any).toString, Object.prototype.toString);
  assert.equal(({} as any).__proto__, Object.prototype);
  assert.equal(stand('valueOf') in Object.prototype, false);             // a stand-in is never a prototype key
});

test('clean: a device, a loaded row and a project peer with the same unsafe id get the same stand-in', () => {
  const id = 'valueOf';
  const s = clean({ at: 1, devices: [{ id }], work: { loaded: { devices: [{ id }] } }, projects: [{ id: 'n1', peers: [id] }] })!;
  assert.equal(s.devices[0].id, stand(id));
  assert.equal(s.work.loaded!.devices[0].id, s.devices[0].id);
  assert.deepEqual(s.projects[0].peers, [s.devices[0].id]);
  const long = 'y'.repeat(300);
  const l = clean({ at: 1, devices: [{ id: long }], projects: [{ id: 'n2', peers: [long] }] })!;
  assert.equal(l.projects[0].peers[0], l.devices[0].id);
});

test('clean: an id longer than 200 chars is kept under its stand-in, for devices, models and projects', () => {
  const id = 'y'.repeat(300);
  const expected = stand(id);
  assert.equal(clean({ at: 1, devices: [{ id }] })!.devices[0].id, expected);
  assert.equal(clean({ at: 1, models: [{ id }] })!.models[0].id, expected);
  assert.equal(clean({ at: 1, projects: [{ id }] })!.projects[0].id, expected);
  assert.equal(expected.length, 58);
  assert.ok(expected.startsWith('~'));
});

test('clean: a stand-in depends on the id alone, never on the rest of the list or its order', () => {
  const a = 'z'.repeat(290) + 'a' + 'q'.repeat(9);   // two 300-char ids differing at the end
  const b = 'z'.repeat(290) + 'b' + 'q'.repeat(9);
  assert.notEqual(stand(a), stand(b));                // same first 40 chars, different sha256
  const ab = clean({ at: 1, devices: [{ id: a, name: 'one' }, { id: b, name: 'two' }] })!.devices;
  const ba = clean({ at: 1, devices: [{ id: b, name: 'two' }, { id: a, name: 'one' }] })!.devices;
  assert.deepEqual(ab.map((d) => d.id), [stand(a), stand(b)]);
  assert.deepEqual(ba.map((d) => d.id), [stand(b), stand(a)]);
  assert.deepEqual(clean({ at: 1, devices: [{ id: b }] })!.devices.map((d) => d.id), [stand(b)]);   // alone: the same
  // a real id that starts with '~' is escaped, so it can never be taken by a stand-in
  const three = ['valueOf', '~valueOf', '~valueOf~2'];
  const ds = clean({ at: 1, devices: three.map((id) => ({ id, name: id })) })!.devices;
  assert.deepEqual(ds.map((d) => d.id), three.map(stand));
  assert.equal(new Set(ds.map((d) => d.id)).size, 3);
  // the same id twice is one device: the first wins, as before
  const dup = clean({ at: 1, devices: [{ id: a, name: 'one' }, { id: a, name: 'two' }] })!.devices;
  assert.deepEqual(dup.map((d) => d.name), ['one']);
});

test('dropped: counts every entry clean leaves out, including a repeated id', () => {
  const raw = {
    at: 1,
    devices: [{ id: 42 }, { id: '' }, { id: {} }, null, 'x', { id: 'a' }, { id: 'a' }, { id: 'valueOf' }, { id: 'x'.repeat(300) }],
    models: [{ id: null }, { id: 'm' }],
    projects: [null, { id: 'n' }],
  };
  assert.deepEqual(dropped(raw), { devices: 6, models: 1, projects: 1 });   // the second 'a' is left out too
  // the count matches the snapshot: every entry that is not left out is there
  assert.deepEqual(clean(raw)!.devices.map((d) => d.id), ['a', stand('valueOf'), stand('x'.repeat(300))]);
  assert.deepEqual(clean(raw)!.models.map((m) => m.id), ['m']);
  assert.deepEqual(clean(raw)!.projects.map((p) => p.id), ['n']);
  // nothing to count: not an object, no such lists, a list that is not an array
  assert.deepEqual(dropped(null), { devices: 0, models: 0, projects: 0 });
  assert.deepEqual(dropped('a look'), { devices: 0, models: 0, projects: 0 });
  assert.deepEqual(dropped({ at: 1, devices: 'x', models: null, projects: 42 }), { devices: 0, models: 0, projects: 0 });
});

test('dropped never throws: a getter that throws is no look, so nothing is counted', () => {
  const hostile: Record<string, unknown> = { at: 1 };
  Object.defineProperty(hostile, 'devices', { get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => dropped(hostile));
  assert.deepEqual(dropped(hostile), { devices: 0, models: 0, projects: 0 });
  const entry: Record<string, unknown> = {};
  Object.defineProperty(entry, 'id', { get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => dropped({ at: 1, devices: [entry] }));
});

test('clean: a device field by field', () => {
  const [d] = clean({
    at: 1,
    devices: [{ id: 'p1', name: 42, kind: 42, via: 42, where: 42, reachable: 'yes', reachMs: NaN, reason: 42,
      checkedAt: NaN, lastOk: 42, ramMb: 1e300, bwGBs: NaN, gpu: 42, tls: 'yes', waitingPair: 'yes', plugged: 'yes', holds: 42, trust: 'x' }],
  })!.devices;
  assert.deepEqual(d, {
    id: 'p1', name: 'p1', kind: '', via: '', where: '', reachable: null, reachMs: null, reason: null,
    checkedAt: null, lastOk: null, ramMb: 4 * 1024 * 1024, bwGBs: null, gpu: null, tls: false, waitingPair: false, plugged: null, holds: null, trust: null,
  });
});

test('clean: a null work is the empty work; a null loaded or loading is null; a null loaded model is the empty model', () => {
  assert.deepEqual(clean({ at: 1, work: null })!.work, { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: false });
  const w = clean({ at: 1, work: { loaded: 'x', loading: 'x', chatting: 'x', plan: 'x', decisions: 'x', llama: 'yes' } })!.work;
  assert.deepEqual(w, { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: false });
  const l = clean({ at: 1, work: { loaded: { mode: 42, model: null, ctx: 'x', since: NaN, devices: [null] } } })!.work.loaded;
  assert.deepEqual(l, { mode: '', model: { id: '', name: '', file: '', size: 0 }, ctx: 0, since: 0, devices: [] });
  const loading = clean({ at: 1, work: { loading: { mode: 42, model: 42, since: NaN, line: 42 } } })!.work.loading;
  assert.deepEqual(loading, { mode: '', model: '', since: 0, line: '' });
});

test('clean: decisions need a usable at; a non-string text is empty', () => {
  const w = clean({ at: 1, work: { decisions: [null, 'x', { at: NaN, text: 'a' }, { at: 2, text: 42 }, { at: 3, text: 'kept' }] } })!.work;
  assert.deepEqual(w.decisions, [{ at: 2, text: '' }, { at: 3, text: 'kept' }]);
});

test('clean: a device\'s trust, field by field', () => {
  const [d] = clean({
    at: 1,
    devices: [{ id: 'p1', trust: { at: NaN, error: 42, id: 42, alg: 42, pub: 42, store: 42, cert: 42, certPinned: 'yes',
      v1: 'yes', paired: NaN, self: 42, count: 1e300, head: 42, lines: null, restartedAt: NaN, rejectsDay: 'x', rejectsLast: null } }],
  })!.devices;
  assert.deepEqual(d.trust, {
    at: 0, error: null, id: null, alg: null, pub: null, store: null, cert: null, certPinned: null,
    v1: null, paired: null, self: null, count: 1e9, head: null, lines: [], restartedAt: null,
    rejectsDay: {},                    // a plain object, as the notes and the view already use
    rejectsLast: [],
  });
  assert.equal(Object.getPrototypeOf(d.trust!.rejectsDay), Object.prototype);
  assert.deepEqual(clean({ at: 1, devices: [{ id: 'p1', trust: null }] })!.devices[0].trust, null);
});

test('clean: trust lines and refusals are bounded and checked; a refusal count is capped, never dropped', () => {
  const day = JSON.parse('{"ok": 2, "bad": -1, "nan": null, "str": "x", "__proto__": 7, "constructor": 8, "prototype": 9}');
  day.nan = NaN;
  day.inf = Infinity;
  day['wrong pin'] = 1_000_000_001;
  const [d] = clean({
    at: 1,
    devices: [{ id: 'p1', trust: { lines: ['a'.repeat(5000), 'b', 42, null], rejectsLast: [null, 'x', { t: NaN, why: 1, peer: 2 }, { t: 2, why: 'w', peer: 'p' }], rejectsDay: day } }],
  })!.devices;
  assert.deepEqual(d.trust!.lines, ['a'.repeat(5000), 'b']);   // under 64 KiB: kept as it is
  assert.deepEqual(d.trust!.rejectsLast, [{ t: 2, why: 'w', peer: 'p' }]);
  // a count past the cap is kept at the cap; a non-number is unknown (dropped); prototype keys are skipped
  assert.deepEqual(d.trust!.rejectsDay, { ok: 2, bad: 0, 'wrong pin': 1e9 });
  assert.equal(Object.getPrototypeOf(d.trust!.rejectsDay), Object.prototype);
  assert.equal(({} as any).ok, undefined);                     // nothing leaked onto Object.prototype
});

test('clean: strings are cut to their documented bound', () => {
  const s = clean({
    at: 1,
    host: { name: 'n'.repeat(300), freeMb: 1, ledger: { ok: 'x', count: 'x', problem: 'p'.repeat(600) } },
    devices: [{ id: 'd', name: 'n'.repeat(100), kind: 'k'.repeat(100), via: 'v'.repeat(100), where: 'w'.repeat(500),
      reason: 'r'.repeat(300), lastOk: 'l'.repeat(100), gpu: 'g'.repeat(100), holds: 'h'.repeat(400),
      trust: { alg: 'a'.repeat(100), pub: 'u'.repeat(5000), store: 's'.repeat(100), self: 'f'.repeat(100), cert: 'c'.repeat(9000), error: 'e'.repeat(2000), head: 'd'.repeat(300) } }],
    work: { loaded: { mode: 'm'.repeat(100), model: { id: 'i', name: 'n'.repeat(400), file: 'f'.repeat(400), size: 1 }, devices: [{ id: 'd2', name: 'n'.repeat(100) }], parts: [{ id: 'p', name: 'n'.repeat(100) }] }, loading: { mode: 'm'.repeat(100), model: 'm'.repeat(400), line: 'l'.repeat(2000) }, plan: ['p'.repeat(2000)], decisions: [{ at: 1, text: 't'.repeat(400) }] },
    models: [{ id: 'm', name: 'n'.repeat(400), file: 'f'.repeat(400), quant: 'q'.repeat(100) }],
    projects: [{ id: 'n', title: 't'.repeat(400), request: 'r'.repeat(5000), state: 's'.repeat(100), mode: 'm'.repeat(100), model: 'm'.repeat(400), peers: ['p'.repeat(250)], line: 'l'.repeat(2000), error: 'e'.repeat(2000) }],
  })!;
  assert.equal(s.host.name, 'n'.repeat(253));          // a hostname may be that long: never cut shorter
  assert.equal(s.host.ledger!.problem, 'p'.repeat(500));
  assert.equal(s.host.ledger!.ok, false);
  assert.equal(s.host.ledger!.count, 0);
  const [d] = s.devices;
  assert.equal(d.name, 'n'.repeat(NAME_MAX));
  assert.equal(d.kind, 'k'.repeat(80));
  assert.equal(d.via, 'v'.repeat(80));
  assert.equal(d.where, 'w'.repeat(400));
  assert.equal(d.reason, 'r'.repeat(200));
  assert.equal(d.lastOk, 'l'.repeat(80));
  assert.equal(d.gpu, 'g'.repeat(80));
  assert.equal(d.holds, 'h'.repeat(300));
  assert.equal(d.trust!.alg, 'a'.repeat(80));
  assert.equal(d.trust!.pub, 'u'.repeat(4096));         // the engine admits a key up to 4096: never cut shorter
  assert.equal(d.trust!.store, 's'.repeat(80));
  assert.equal(d.trust!.self, 'f'.repeat(80));
  assert.equal(d.trust!.cert, 'c'.repeat(8192));        // the engine admits a certificate up to 8192
  assert.equal(d.trust!.error, 'e'.repeat(1000));
  assert.equal(d.trust!.head, 'd'.repeat(200));
  assert.equal(s.work.loaded!.mode, 'm'.repeat(80));
  assert.equal(s.work.loaded!.model.name, 'n'.repeat(300));
  assert.equal(s.work.loaded!.model.file, 'f'.repeat(300));
  assert.equal(s.work.loaded!.devices[0].name, 'n'.repeat(NAME_MAX));
  assert.equal(s.work.loaded!.parts![0].name, 'n'.repeat(NAME_MAX));
  assert.equal(s.work.loading!.mode, 'm'.repeat(80));
  assert.equal(s.work.loading!.model, 'm'.repeat(300));
  assert.equal(s.work.loading!.line, 'l'.repeat(1000));
  assert.deepEqual(s.work.plan, ['p'.repeat(1000)]);
  assert.deepEqual(s.work.decisions, [{ at: 1, text: 't'.repeat(300) }]);
  const [m] = s.models;
  assert.equal(m.name, 'n'.repeat(300));
  assert.equal(m.file, 'f'.repeat(300));
  assert.equal(m.quant, 'q'.repeat(80));
  const [p] = s.projects;
  assert.equal(p.title, 't'.repeat(300));
  assert.equal(p.request, 'r'.repeat(4000));
  assert.equal(p.state, 's'.repeat(80));
  assert.equal(p.mode, 'm'.repeat(80));
  assert.equal(p.model, 'm'.repeat(300));
  assert.deepEqual(p.peers, [stand('p'.repeat(250))]);  // a peer gets the same stand-in as its device
  assert.equal(p.line, 'l'.repeat(1000));
  assert.equal(p.error, 'e'.repeat(1000));
});

test('clean: ledger lines are kept as they are, the newest 1000, each at most 65536 chars', () => {
  const lines = Array.from({ length: 1500 }, (_, i) => `line ${i}`.repeat(60));
  const [d] = clean({ at: 1, devices: [{ id: 'p1', trust: { lines } }] })!.devices;
  assert.equal(d.trust!.lines.length, 1000);
  assert.equal(d.trust!.lines[0], `line ${500}`.repeat(60));    // the newest window, oldest first
  assert.equal(d.trust!.lines[999], `line ${1499}`.repeat(60));
  const [long] = clean({ at: 1, devices: [{ id: 'p1', trust: { lines: ['x'.repeat(70_000)] } }] })!.devices;
  assert.equal(long.trust!.lines[0].length, 65_536);            // the engine admits a line up to 64 KiB
});

test('clean: a project field by field; a title that is not a string is empty', () => {
  const [p] = clean({
    at: 1,
    projects: [{ id: 'n1', title: {}, request: 42, start: NaN, end: 'x', state: 42, mode: 42, model: 42, peers: null, parts: 'x', done: 'x', line: 42, error: 42 }],
  })!.projects;
  assert.deepEqual(p, { id: 'n1', title: '', request: '', start: 0, end: 0, state: '', mode: '', model: '', peers: [], parts: 0, done: 0, line: '', error: '' });
});

test('counts and sizes past their cap are kept at the cap, never dropped; only a non-number is unknown', () => {
  const s = clean({
    at: 1,
    host: { freeMb: 1e300, ledger: { ok: true, count: 2e9, problem: null } },
    devices: [{ id: 'p1', ramMb: 1e300, trust: { count: 2e9, paired: 2e6, rejectsDay: { 'wrong pin': 1_000_000_001 } } }],
    work: { chatting: 2e9, loaded: { model: { size: 1e300 }, ctx: 2e9, devices: [{ id: 'd1', done: 2e9 }], parts: [{ id: 'q', mb: 1e300, layers: 20_000 }] } },
    models: [{ id: 'm1', size: 1e300, needMb: 1e300, params_b: 1e300 }],
    projects: [{ id: 'n1', parts: 200_000, done: 2e9 }],
  })!;
  assert.equal(s.host.freeMb, 4 * 1024 * 1024);           // 4 TB
  assert.equal(s.host.ledger!.count, 1e9);
  const [d] = s.devices;
  assert.equal(d.ramMb, 4 * 1024 * 1024);
  assert.equal(d.trust!.count, 1e9);
  assert.equal(d.trust!.paired, 1e6);
  assert.equal(d.trust!.rejectsDay['wrong pin'], 1e9);    // the alarm's count stays, at the cap
  assert.equal(s.work.chatting, 1e6);
  assert.equal(s.work.loaded!.model.size, 1e13);          // 10 TB
  assert.equal(s.work.loaded!.ctx, 1e9);
  assert.equal(s.work.loaded!.devices[0].done, 1e9);
  assert.equal(s.work.loaded!.parts![0].mb, 4 * 1024 * 1024);
  assert.equal(s.work.loaded!.parts![0].layers, 10_000);
  assert.equal(s.models[0].size, 1e13);
  assert.equal(s.models[0].needMb, 4 * 1024 * 1024);
  assert.equal(s.models[0].params_b, 10_000);
  assert.equal(s.projects[0].parts, 100_000);
  assert.equal(s.projects[0].done, 1e9);

  const t = clean({ at: 1, host: { freeMb: NaN, ledger: { ok: true, count: NaN } }, devices: [{ id: 'p2', ramMb: NaN, trust: { count: NaN, paired: Infinity } }], work: { chatting: NaN, loaded: { ctx: NaN, devices: [{ id: 'd2', done: NaN }] } } })!;
  assert.equal(t.host.freeMb, null);
  assert.equal(t.host.ledger!.count, 0);                  // not a number: unknown, the type has no null
  assert.equal(t.devices[0].ramMb, null);
  assert.equal(t.devices[0].trust!.count, null);
  assert.equal(t.devices[0].trust!.paired, null);
  assert.equal(t.work.chatting, 0);
  assert.equal(t.work.loaded!.ctx, 0);
  assert.equal(t.work.loaded!.devices[0].done, 0);
});

test('measurements and times outside their range are unknown, not guessed', () => {
  const [d] = clean({ at: 1, devices: [{ id: 'p1', reachMs: 600_001, checkedAt: TIME_MAX + 1, bwGBs: 1e300 }] })!.devices;
  assert.equal(d.reachMs, null);
  assert.equal(d.checkedAt, null);
  assert.equal(d.bwGBs, null);
  const w = clean({ at: 1, work: { loaded: { since: -1, devices: [{ id: 'd', tps: 1e300 }] } } })!.work;
  assert.equal(w.loaded!.since, 0);
  assert.equal(w.loaded!.devices[0].tps, null);
  const [m] = clean({ at: 1, models: [{ id: 'm', params_b: NaN }] })!.models;
  assert.equal(m.params_b, null);
});

test('clean never throws, even when a getter does: such a look cannot be trusted and is null', () => {
  const hostile: Record<string, unknown> = { at: 1000 };
  Object.defineProperty(hostile, 'devices', { get() { throw new Error('boom'); } });
  assert.equal(clean(hostile), null);
  const hostileAt: Record<string, unknown> = {};
  Object.defineProperty(hostileAt, 'at', { get() { throw new Error('boom'); } });
  assert.equal(clean(hostileAt), null);
  const hostileEntry: Record<string, unknown> = {};
  Object.defineProperty(hostileEntry, 'id', { get() { throw new Error('boom'); } });
  assert.equal(clean({ at: 1, devices: [hostileEntry] }), null);
});

/** a full, valid snapshot: every field set. clean must return it deep-equal, unchanged. */
const healthy = (): Record<string, unknown> => ({
  at: 1000,
  host: { name: 'mac', freeMb: 4000, ledger: { ok: true, count: 12, problem: null } },
  devices: [{
    id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true,
    reachMs: 12, reason: null, checkedAt: 900, lastOk: '2026-11-10T08:00:00Z', ramMb: 3400, bwGBs: 60,
    gpu: null, tls: true, waitingPair: false, plugged: null, holds: null,
    trust: {
      at: 900, error: null, id: 'abc123', alg: 'ed25519', pub: 'cHVibGlj', store: 'keystore', cert: 'Y2VydA==',
      certPinned: true, v1: false, paired: 1, self: 'ok', count: 5, head: 'deadbeef'.repeat(8),
      lines: ['a ledger line'], restartedAt: null, rejectsDay: { 'wrong pin': 2 },
      rejectsLast: [{ t: 850, why: 'wrong pin', peer: 'p2' }],
    },
  }],
  work: {
    loaded: {
      mode: 'apart', model: { id: 'm1', name: 'model', file: 'm.gguf', size: 1e9 }, ctx: 100, since: 800,
      devices: [{ id: 'p1', name: 'pixel', local: false, busy: true, tps: 3, done: 2 }],
      parts: [{ id: 'p1', name: 'pixel', local: false, mb: 500, layers: 10 }],
    },
    loading: null, chatting: 1, plan: ['a plan'], decisions: [{ at: 700, text: 'a decision' }], llama: true,
  },
  models: [{ id: 'm1', name: 'model', file: 'm.gguf', size: 1e9, quant: 'q4', params_b: 8, catalog: true, here: true, needMb: 2000 }],
  projects: [{ id: 'n1', title: 'a night', request: 'a request', start: 500, end: 900, state: 'waiting', mode: 'apart', model: 'm1', peers: ['p1'], parts: 2, done: 1, line: 'a line', error: 'an error' }],
});

test('clean leaves a healthy snapshot exactly as it is, and does not change it on the way', () => {
  // built the way the eye receives it: plain JSON, cloned, never shaped to match clean's output
  const s = structuredClone(healthy());
  assert.deepStrictEqual(clean(s), s);
  assert.deepStrictEqual(s, structuredClone(healthy()));
});

test('clean: a project\'s peers get a stand-in too; models and projects keep the first of a duplicated id', () => {
  const [p] = clean({ at: 1, projects: [{ id: 'n1', peers: ['p1', '', 42, null, 'x'.repeat(250), 'p2'] }] })!.projects;
  assert.deepEqual(p.peers, ['p1', stand('x'.repeat(250)), 'p2']);
  assert.equal(idOf('x'.repeat(250)), null);            // idOf itself still calls it not one of ours
  const models = clean({ at: 1, models: [{ id: 'm1', name: 'one' }, { id: 'm1', name: 'two' }, { id: 'm2', name: 'three' }] })!.models;
  assert.deepEqual(models.map((m) => m.id), ['m1', 'm2']);
  assert.equal(models[0].name, 'one');
  const projects = clean({ at: 1, projects: [{ id: 'n1', title: 'one' }, { id: 'n1', title: 'two' }, { id: 'n2', title: 'three' }] })!.projects;
  assert.deepEqual(projects.map((x) => [x.id, x.title]), [['n1', 'one'], ['n2', 'three']]);
});

// a phone's health (12.11.2026): the newest reading of its signed ledger health lines
const healthOfClean = (health: unknown) => clean({ at: 1, devices: [{ id: 'p1', health }] })!.devices[0].health;

test('clean: a device\'s health absent stays absent; not an object, or without a usable at, is null', () => {
  const [d] = clean({ at: 1, devices: [{ id: 'p1' }] })!.devices;
  assert.equal('health' in d, false, 'an older snapshot has no health and gets none');
  assert.equal(healthOfClean(null), null);
  assert.equal(healthOfClean(undefined), null);
  assert.equal(healthOfClean('hot'), null);
  assert.equal(healthOfClean([1, 2]), null);
  assert.equal(healthOfClean({ tempC: 40 }), null);
  assert.equal(healthOfClean({ at: '1000', tempC: 40 }), null);
  assert.equal(healthOfClean({ at: -1, tempC: 40 }), null);
  assert.equal(healthOfClean({ at: TIME_MAX + 1, tempC: 40 }), null);
});

test('clean: a device\'s health, field by field: wrong types are unknown', () => {
  assert.deepEqual(healthOfClean({ at: 5, tempC: '40', battery: true, charging: 1, throttled: 'yes' }),
    { at: 5, tempC: null, battery: null, charging: null, throttled: null });
  assert.deepEqual(healthOfClean({ at: 5 }), { at: 5, tempC: null, battery: null, charging: null, throttled: null });
  assert.deepEqual(healthOfClean({ at: 5, tempC: NaN, battery: Infinity, charging: false, throttled: true }),
    { at: 5, tempC: null, battery: null, charging: false, throttled: true });
});

test('clean: a device\'s health out of range is unknown, never clamped: heat -30..120 °C, battery 0..100 %', () => {
  const h = (tempC: unknown, battery: unknown) => { const x = healthOfClean({ at: 5, tempC, battery, charging: null, throttled: false })!; return [x.tempC, x.battery]; };
  assert.deepEqual(h(-30, 0), [-30, 0]);
  assert.deepEqual(h(120, 100), [120, 100]);
  assert.deepEqual(h(-30.1, -1), [null, null]);
  assert.deepEqual(h(120.5, 100.5), [null, null]);
  assert.deepEqual(h(1e300, -1e300), [null, null]);
  assert.deepEqual(h(36.6, 57.5), [36.6, 57.5]);
});

test('clean leaves a healthy snapshot with health exactly as it is', () => {
  const withHealth = healthy();
  (withHealth.devices as any[])[0].health = { at: 950, tempC: 38.5, battery: 64, charging: null, throttled: false };
  (withHealth.devices as any[]).push({ ...(withHealth.devices as any[])[0], id: 'p2', name: 'tab', health: null });
  const s = structuredClone(withHealth);
  assert.deepStrictEqual(clean(s), s);
});

// a worker's own /status (13.11.2026, scan D M2 M1): numbers and flags only, an observation
const workerOfClean = (worker: unknown) => clean({ at: 1, devices: [{ id: 'p1', worker }] })!.devices[0].worker;

test('clean: a device\'s worker absent stays absent; not an object, or without a usable at, is null', () => {
  const [d] = clean({ at: 1, devices: [{ id: 'p1' }] })!.devices;
  assert.equal('worker' in d, false, 'an older snapshot has no worker and gets none');
  assert.equal(workerOfClean(null), null);
  assert.equal(workerOfClean('busy'), null);
  assert.equal(workerOfClean({ busy: true }), null);
  assert.equal(workerOfClean({ at: -1, busy: true }), null);
  assert.equal(workerOfClean({ at: TIME_MAX + 1, busy: true }), null);
});

test('clean: a device\'s worker keeps its numbers and flags, wrong types unknown, counts clamped, nothing else', () => {
  assert.deepEqual(workerOfClean({ at: 5, busy: true, tokensUsed: 3700, ctx: 4096, ramFreeMb: 2100 }),
    { at: 5, busy: true, tokensUsed: 3700, ctx: 4096, ramFreeMb: 2100 });
  assert.deepEqual(workerOfClean({ at: 5 }), { at: 5, busy: null, tokensUsed: null, ctx: null, ramFreeMb: null });
  assert.deepEqual(workerOfClean({ at: 5, busy: 'yes', tokensUsed: '9', ctx: NaN, ramFreeMb: Infinity }),
    { at: 5, busy: null, tokensUsed: null, ctx: null, ramFreeMb: null });
  assert.deepEqual(workerOfClean({ at: 5, busy: false, tokensUsed: -3, ctx: 1e12, ramFreeMb: 1e12 }),
    { at: 5, busy: false, tokensUsed: 0, ctx: 1e9, ramFreeMb: 4 * 1024 * 1024 });
  // a prompt or any other field never passes the guard
  assert.equal('prompt' in (workerOfClean({ at: 5, busy: true, prompt: 'secret words' }) as object), false);
});

test('clean: the host\'s diskFreeMb absent stays absent; a number is clamped, anything else null', () => {
  assert.equal('diskFreeMb' in clean({ at: 1, host: { name: 'mac', freeMb: 1 } })!.host, false);
  assert.equal(clean({ at: 1, host: { name: 'mac', freeMb: 1, diskFreeMb: 52_000 } })!.host.diskFreeMb, 52_000);
  assert.equal(clean({ at: 1, host: { name: 'mac', freeMb: 1, diskFreeMb: null } })!.host.diskFreeMb, null);
  assert.equal(clean({ at: 1, host: { name: 'mac', freeMb: 1, diskFreeMb: '5' } })!.host.diskFreeMb, null);
  assert.equal(clean({ at: 1, host: { name: 'mac', freeMb: 1, diskFreeMb: -5 } })!.host.diskFreeMb, 0);
  // free disk may be far past the 4 TB memory cap: a big drive's number is kept
  assert.equal(clean({ at: 1, host: { name: 'mac', freeMb: 1, diskFreeMb: 9_000_000 } })!.host.diskFreeMb, 9_000_000);
});

test('clean leaves a healthy snapshot with worker and diskFreeMb exactly as it is', () => {
  const s0 = healthy();
  (s0.host as any).diskFreeMb = 120_000;
  (s0.devices as any[])[0].worker = { at: 950, busy: false, tokensUsed: 12, ctx: 4096, ramFreeMb: null };
  (s0.devices as any[]).push({ ...(s0.devices as any[])[0], id: 'p2', name: 'tab', worker: null });
  const s = structuredClone(s0);
  assert.deepStrictEqual(clean(s), s);
});

// owner-blind (12.11.2026): the engine's last proof (engine.ts foldAttest, attest.ts ownerBlind)
const attestOfClean = (attest: unknown) => (clean({ at: 1, devices: [{ id: 'p1', trust: { at: 1, attest } }] })!.devices[0].trust as any).attest;
const PROOF = { at: 1_000, ok: false, why: 'unlocked', text: 'its bootloader is unlocked: its owner can change the system and read jobs' };

test('clean: a trust\'s attest absent stays absent; null stays null; out of shape is null', () => {
  const t = clean({ at: 1, devices: [{ id: 'p1', trust: { at: 1 } }] })!.devices[0].trust!;
  assert.equal('attest' in t, false, 'an older snapshot has no attest and gets none');
  assert.equal(attestOfClean(null), null);
  assert.equal(attestOfClean(undefined), null);
  for (const bad of ['proof', 42, [PROOF], { ...PROOF, at: '1000' }, { ...PROOF, at: -1 }, { ...PROOF, at: TIME_MAX + 1 }, { ...PROOF, at: NaN },
    { ...PROOF, ok: 'yes' }, { ...PROOF, ok: 0 }, { ...PROOF, ok: undefined }, { ...PROOF, text: '' }, { ...PROOF, text: 42 }, { ...PROOF, text: undefined }]) {
    assert.equal(attestOfClean(bad), null, JSON.stringify(bad));
  }
});

test('clean: a trust\'s attest keeps ok true, false and null; why is a short word, text cut to 300 so a red proof stays red', () => {
  assert.deepEqual(attestOfClean(PROOF), PROOF);
  assert.deepEqual(attestOfClean({ ...PROOF, ok: true, why: 'ok' }), { ...PROOF, ok: true, why: 'ok' });
  assert.deepEqual(attestOfClean({ at: 0, ok: null, why: 'computer', text: 'a computer cannot prove this' }), { at: 0, ok: null, why: 'computer', text: 'a computer cannot prove this' });
  assert.equal(attestOfClean({ ...PROOF, why: null }).why, '');
  assert.equal(attestOfClean({ ...PROOF, why: 7 }).why, '');
  assert.equal(attestOfClean({ ...PROOF, why: 'w'.repeat(41) }).why, 'w'.repeat(40));
  assert.equal(attestOfClean({ ...PROOF, text: 'x'.repeat(300) }).text, 'x'.repeat(300));
  const long = attestOfClean({ ...PROOF, text: `its proof was made for another app (${'com.example.app, '.repeat(30)}), not kula` });
  assert.deepEqual([long.ok, long.text.length], [false, 300]);
  assert.deepEqual(Object.keys(attestOfClean({ ...PROOF, extra: 'x', facts: {} })).sort(), ['at', 'ok', 'text', 'why']);
});

test('clean leaves a healthy snapshot with attest exactly as it is', () => {
  const withAttest = healthy();
  ((withAttest.devices as any[])[0].trust as any).attest = PROOF;
  (withAttest.devices as any[]).push({ ...(withAttest.devices as any[])[0], id: 'p2', name: 'tab', trust: { ...(withAttest.devices as any[])[0].trust, attest: null } });
  const s = structuredClone(withAttest);
  assert.deepStrictEqual(clean(s), s);
});

const EYE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-guard-'));
after(() => fs.rmSync(EYE_HOME, { recursive: true, force: true }));

test('through the eye: a loaded, non-local phone whose proof says its owner can read jobs gets the trust:owner-blind card', async () => {
  const { GodsEye } = await import('../src/godseye/index.ts');
  const NOW = 2_000_000;
  const trust = { at: NOW - 1_000, error: null, id: null, alg: null, pub: null, store: 'keystore', cert: null, certPinned: null, v1: false, paired: 1,
    self: 'ok', count: 0, head: null, lines: [], restartedAt: null, rejectsDay: {}, rejectsLast: [], attest: { ...PROOF, at: NOW - 5_000 } };
  const snap = (attest: unknown) => ({
    at: NOW, host: { name: 'mac', freeMb: 4000 },
    devices: [{ id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
      checkedAt: NOW, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: { ...trust, attest } }],
    work: { loaded: { mode: 'apart', model: { id: 'm', name: 'm', file: 'm.gguf', size: 1 }, ctx: 4096, since: 1,
      devices: [{ id: 'p1', name: 'pixel', local: false, busy: false, tps: null, done: 0 }, { id: 'mac', name: 'mac', local: true, busy: false, tps: null, done: 0 }] },
      loading: null, chatting: 0, plan: [], decisions: [], llama: true },
    models: [], projects: [],
  });
  let s: any = snap(trust.attest);
  const eye = new GodsEye({ snapshot: () => s, dir: path.join(EYE_HOME, 'eye'), now: () => NOW });
  eye.tick();
  const card = eye.view().cards.find((c) => c.id === 'trust:owner-blind:p1');
  assert.ok(card, JSON.stringify(eye.view().cards.map((c) => c.id)));
  assert.equal(card!.kind, 'warn');
  assert.match(card!.why, /bootloader is unlocked/);
  s = snap({ ...PROOF, at: NOW - 5_000, ok: true, why: 'ok', text: 'hardware key, locked, verified boot, official kula build: its owner cannot read jobs' });
  eye.tick();
  assert.equal(eye.view().cards.some((c) => c.id === 'trust:owner-blind:p1'), false, 'a passing proof: no card');
});
