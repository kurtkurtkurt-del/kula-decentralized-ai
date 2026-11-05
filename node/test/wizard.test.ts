// The connect sheet's questions (src/ui/static/wizard.js, the same module the page imports):
// where it starts, the cable way driven by what GET cable says, the wi-fi way with its error
// branches (unreachable → "this network keeps devices apart" → cable or hotspot), the model
// order and the mode cards. Then the engine's discover (what GET discover answers) with a
// fake mdns browser: names and addresses, never a secret.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-wiz-home-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const wiz = await import('../src/ui/static/wizard.js');
const { Engine } = await import('../src/ui/engine.ts');
const { writePeers } = await import('../src/peers.ts');

const SERIAL = 'R3CY10FLZLB';
const dev = (o: Record<string, unknown> = {}) => ({ serial: SERIAL, name: 'SM S936B', model: 'SM S936B', state: 'device', help: null, installed: true, peer: null, job: null, ...o });
const view = (devices: unknown[], o: Record<string, unknown> = {}) => ({ adb: true, help: null, error: null, devices, ...o });
const job = (step: string, o: Record<string, unknown> = {}) => ({ step, lines: ['forwarding a port on this computer to the phone'], error: null, peerId: null, needCode: step === 'code', busy: !['code', 'paired', 'error'].includes(step), ...o });

// ---------- where it starts

test('start: a load running, a model loaded (by itself or opened), a phone that answers, else the first question', () => {
  const phone = { id: 'p', name: 'pixel', reach: { ok: true } };
  assert.equal(wiz.startStep({ peers: [], status: null }), 'how');
  assert.equal(wiz.startStep({ peers: [{ ...phone, reach: { ok: false, reason: 'connect timeout' } }], status: null }), 'how');
  assert.equal(wiz.startStep({ peers: [{ ...phone, reach: null }], status: null }), 'how');
  assert.equal(wiz.startStep({ peers: [phone], status: { loaded: null, loading: null } }), 'model');
  assert.equal(wiz.startStep({ peers: [phone], status: { loaded: { mode: 'phone' }, loading: null } }), 'done');
  assert.equal(wiz.startStep({ peers: [phone], status: { loaded: { mode: 'phone' }, loading: null }, explicit: true }), 'model');
  assert.equal(wiz.startStep({ peers: [], status: { loaded: null, loading: { model: 'x' } } }), 'load');
  // the last way is remembered and shown, the walk still starts at the question
  const w = wiz.initial('wifi');
  assert.equal(w.step, 'how');
  assert.equal(w.way, 'wifi');
});

test('dots: six stages, every step sits in one', () => {
  assert.equal(wiz.STAGES.length, 6);
  for (const [step, stage] of [['how', 0], ['cable-plug', 1], ['wifi-list', 1], ['cable-code', 2], ['wifi-apart', 2], ['connected', 2], ['model', 3], ['mode', 4], ['load', 5]] as const) assert.equal(wiz.stageOf(step), stage, step);
});

// ---------- the cable

test('cable: no adb, nothing plugged, unauthorized, not installed, offline: all on "plug the phone in" with the reason', () => {
  assert.deepEqual(wiz.cableState(null), { step: 'cable-plug', problem: 'looking' });
  assert.equal(wiz.cableState({ adb: false, help: 'get adb', devices: [] }).problem, 'no-adb');
  assert.equal(wiz.cableState(view([])).problem, 'none');
  assert.equal(wiz.cableState(view([], { error: 'adb devices: boom' })).problem, 'adb-error');
  const un = wiz.cableState(view([dev({ state: 'unauthorized', help: 'allow USB debugging' })]));
  assert.equal(un.step, 'cable-plug');
  assert.equal(un.problem, 'unauthorized');
  assert.equal(wiz.cableState(view([dev({ installed: false })])).problem, 'not-installed');
  assert.equal(wiz.cableState(view([dev({ state: 'offline' })])).problem, 'offline');
  // a paired phone that is unplugged is no phone on the cable
  assert.equal(wiz.cableState(view([dev({ state: 'unplugged', peer: { id: 'cable:x', name: 'x' } })])).problem, 'none');
});

test('cable: plugged in → use by itself → sharing → the code → connected; unplugged on the way goes back', () => {
  let w = wiz.next(wiz.initial(), { type: 'way', way: 'cable' });
  assert.equal(w.step, 'cable-plug');
  assert.equal(w.way, 'cable');
  w = wiz.next(w, { type: 'cable', view: view([]) });
  assert.equal(w.step, 'cable-plug');
  w = wiz.next(w, { type: 'cable', view: view([dev({ state: 'unauthorized' })]) });
  assert.equal(w.step, 'cable-plug');
  // allowed: a ready phone with no job yet → the page presses "use" itself
  const ready = view([dev()]);
  assert.equal(wiz.cableState(ready).use, true);
  w = wiz.next(w, { type: 'cable', view: ready });
  assert.equal(w.step, 'cable-share');
  assert.equal(w.serial, SERIAL);
  w = wiz.next(w, { type: 'used', serial: SERIAL });
  assert.deepEqual(w.used, [SERIAL]);
  w = wiz.next(w, { type: 'cable', view: view([dev({ job: job('waiting') })]) });
  assert.equal(w.step, 'cable-share');
  assert.equal(wiz.cableState(view([dev({ job: job('waiting') })]), SERIAL, w.used).busy, true);
  w = wiz.next(w, { type: 'cable', view: view([dev({ job: job('code') })]) });
  assert.equal(w.step, 'cable-code');
  // a wrong code: still the code step, with the error
  w = wiz.next(w, { type: 'cable', view: view([dev({ job: job('code', { error: 'the phone said no: bad proof' }) })]) });
  assert.equal(w.step, 'cable-code');
  assert.match(w.error, /bad proof/);
  // pairing, then paired
  assert.equal(wiz.cableState(view([dev({ job: job('pairing', { busy: true }) })]), SERIAL, w.used).step, 'cable-code');
  w = wiz.next(w, { type: 'cable', view: view([dev({ job: job('paired', { peerId: `cable:${SERIAL}` }) })]) });
  assert.equal(w.step, 'connected');
  assert.equal(w.peerId, `cable:${SERIAL}`);
  // once connected, adb's news no longer moves the walk
  assert.equal(wiz.next(w, { type: 'cable', view: view([]) }).step, 'connected');
  w = wiz.next(w, { type: 'continue' });
  assert.equal(w.step, 'model');
  assert.equal(wiz.back(w), 'connected');

  // unplugged while it was sharing: back to "plug the phone in"
  let u = wiz.next(wiz.initial(), { type: 'way', way: 'cable' });
  u = wiz.next(u, { type: 'cable', view: view([dev({ job: job('waiting') })]) });
  assert.equal(u.step, 'cable-share');
  u = wiz.next(u, { type: 'cable', view: view([]) });
  assert.equal(u.step, 'cable-plug');
});

test('cable: an old error is tried again once by itself; a new one waits for "try again"; a phone that knew us connects at once', () => {
  const failed = view([dev({ job: job('error', { error: 'the phone did not start sharing within a minute' }) })]);
  assert.equal(wiz.cableState(failed, SERIAL, []).use, true);
  const s = wiz.cableState(failed, SERIAL, [SERIAL]);
  assert.equal(s.step, 'cable-share');
  assert.equal(s.retry, true);
  assert.match(s.error, /within a minute/);
  const known = wiz.next(wiz.next(wiz.initial(), { type: 'way', way: 'cable' }), { type: 'cable', view: view([dev({ job: job('paired', { peerId: 'cable:R3' }) })]) });
  assert.equal(known.step, 'connected');
  // the phone this walk is about wins over another one plugged in later
  const two = view([dev({ serial: 'A1', state: 'unauthorized' }), dev({ serial: 'B2' })]);
  assert.equal(wiz.cableState(two).serial, 'B2');
  assert.equal(wiz.cableState(two, 'A1').problem, 'unauthorized');
  // back from any cable step is the first question
  for (const step of ['cable-plug', 'cable-share', 'cable-code']) assert.equal(wiz.back({ ...wiz.initial(), step }), 'how');
});

// ---------- wi-fi

const FOUND = { name: 'pixel', host: '192.168.1.33', port: 50551, kind: 'phone', v: 'rpc7', paired: null };

test('wi-fi: share on → phones on this network → one picked → the code → connected', () => {
  let w = wiz.next(wiz.initial(), { type: 'way', way: 'wifi' });
  assert.equal(w.step, 'wifi-share');
  assert.equal(wiz.next(w, { type: 'pick', found: FOUND }).step, 'wifi-share'); // not before "it's on"
  w = wiz.next(w, { type: 'share-on' });
  assert.equal(w.step, 'wifi-list');
  w = wiz.next(w, { type: 'pick', found: FOUND });
  assert.equal(w.step, 'wifi-code');
  assert.deepEqual(w.found, FOUND);
  assert.equal(wiz.back(w), 'wifi-list');
  // a wrong code stays on the code step and says why
  w = wiz.next(w, { type: 'pair-failed', error: 'the phone said no: bad pin proof' });
  assert.equal(w.step, 'wifi-code');
  assert.match(w.error, /bad pin/);
  w = wiz.next(w, { type: 'paired', peerId: '192.168.1.33:50551' });
  assert.equal(w.step, 'connected');
  assert.equal(w.error, null);
  assert.equal(wiz.back(w), 'wifi-list');
  // not in the list: the address typed by hand
  const t = wiz.next({ ...wiz.initial('wifi'), step: 'wifi-list' }, { type: 'type-address' });
  assert.equal(t.step, 'wifi-code');
  assert.equal(t.found, null);
  assert.equal(t.typed, true);
});

test('wi-fi: unreachable → "this network keeps devices apart" → the cable, or the hotspot and back to the list', () => {
  for (const error of ['cannot reach 192.168.1.33:50551: connect EHOSTUNREACH 192.168.1.33:50551', 'cannot reach 10.0.0.5:50551: connect timeout', 'connect ETIMEDOUT', 'connect ENETUNREACH']) {
    assert.equal(wiz.pairError(error), 'isolated', error);
    const w = wiz.next({ ...wiz.initial('wifi'), step: 'wifi-code', found: FOUND }, { type: 'pair-failed', error });
    assert.equal(w.step, 'wifi-apart', error);
    assert.equal(wiz.back(w), 'wifi-code');
  }
  assert.equal(wiz.pairError('cannot reach 192.168.1.33:50551: connect ECONNREFUSED 192.168.1.33:50551'), 'closed');
  assert.equal(wiz.pairError('the code is the 16 letters and digits after "code" on the phone'), 'code');
  assert.equal(wiz.pairError('the certificate does not match what the phone shows: not pairing'), 'code');
  assert.equal(wiz.pairError('something else'), 'other');
  const apart = { ...wiz.initial('wifi'), step: 'wifi-apart', found: FOUND };
  const cable = wiz.next(apart, { type: 'use-cable' });
  assert.equal(cable.step, 'cable-plug');
  assert.equal(cable.way, 'cable');
  let h = wiz.next(apart, { type: 'hotspot' });
  assert.equal(h.step, 'hotspot');
  assert.equal(wiz.back(h), 'wifi-apart');
  h = wiz.next(h, { type: 'on-hotspot' });
  assert.equal(h.step, 'wifi-list');
});

test('wi-fi: a phone paired before is checked, not asked for a code; gone → apart, forgot us → a new code', () => {
  const paired = { ...FOUND, paired: 'w1' };
  let w = wiz.next({ ...wiz.initial('wifi'), step: 'wifi-list' }, { type: 'pick', found: paired });
  assert.equal(w.step, 'wifi-check');
  assert.equal(wiz.next(w, { type: 'reached', peerId: 'w1' }).step, 'connected');
  assert.equal(wiz.next(w, { type: 'pair-failed', error: 'connect EHOSTUNREACH' }).step, 'wifi-apart');
  const again = wiz.next(w, { type: 'pair-failed', error: 'not paired' });
  assert.equal(again.step, 'wifi-code');
  assert.equal(again.found.paired, null);
  assert.equal(wiz.back(w), 'wifi-list');
});

test('back and "connect another device" from the model, mode and load steps', () => {
  const returning = { ...wiz.initial('cable'), step: 'model' };
  assert.equal(wiz.back(returning), 'how');
  let w = wiz.next(returning, { type: 'model', id: 'qwen3-0.6b' });
  assert.equal(w.step, 'mode');
  assert.equal(w.model, 'qwen3-0.6b');
  assert.equal(wiz.back(w), 'model');
  w = wiz.next(w, { type: 'mode', mode: 'phone' });
  assert.equal(w.step, 'load');
  assert.equal(w.mode, 'phone');
  assert.equal(wiz.back(w), 'mode');
  assert.equal(wiz.next(w, { type: 'load-failed', error: 'too big' }).step, 'load');
  assert.equal(wiz.next(w, { type: 'loaded' }).step, 'done');
  const again = wiz.next(w, { type: 'another' });
  assert.equal(again.step, 'how');
  assert.equal(again.way, 'cable');
  assert.equal(again.model, null);
  assert.equal(wiz.back({ ...wiz.initial(), step: 'how' }), null);
  assert.equal(wiz.next({ ...wiz.initial(), step: 'how' }, { type: 'back' }).step, 'how');
});

// ---------- model and mode

const MODELS = [
  { id: 'a', name: 'A', file: 'a.gguf', size: 4e8, catalog: true, here: false, needMb: 900 },
  { id: 'b', name: 'B', file: 'b.gguf', size: 2e9, catalog: true, here: true, needMb: 2600 },
  { id: 'local:c.gguf', name: 'c', file: 'c.gguf', size: 1e9, catalog: false, here: true, needMb: 1400 },
  { id: 'd', name: 'D', file: 'd.gguf', size: 9e9, catalog: true, here: false, needMb: 9800 },
];

test('models: what the phone has loaded first, then the catalog, then files only here; fits on the phone', () => {
  const phone = { id: 'p', name: 'pixel', ram: 3000, holds: 'b.gguf', reach: { ok: true } };
  const rows = wiz.modelRows(MODELS, phone);
  assert.deepEqual(rows.map((m: any) => m.id), ['b', 'a', 'd', 'local:c.gguf']);
  assert.equal(rows[0].onPhone, true);
  assert.deepEqual(rows[0].fit, ['tight', 'tight on pixel']);
  assert.deepEqual(rows[1].fit, ['yes', 'fits on pixel']);
  assert.deepEqual(rows[2].fit, ['no', 'too big for pixel']);
  assert.ok(!('i' in rows[0]));
  // a phone that said nothing: no fit, the catalog order
  assert.deepEqual(wiz.modelRows(MODELS, { id: 'p', name: 'p', ram: null, holds: null }).map((m: any) => [m.id, m.fit, m.onPhone]), [['a', null, false], ['b', null, false], ['d', null, false], ['local:c.gguf', null, false]]);
});

test('modes: on the phone first and recommended; each card that cannot work says why', () => {
  const phone = { id: 'p', name: 'pixel', reach: { ok: true }, far: false };
  const by = (cards: any[]) => Object.fromEntries(cards.map((c) => [c.mode, c]));
  let c = by(wiz.modeCards({ model: MODELS[0], phone, peers: [phone], llama: true }));
  assert.deepEqual(wiz.modeCards({ model: MODELS[0], phone, peers: [phone], llama: true }).map((x: any) => x.mode), ['phone', 'here', 'apart', 'split']);
  assert.ok(c.phone.recommended && !c.phone.disabled && !c.here.disabled && !c.apart.disabled && !c.split.disabled);
  c = by(wiz.modeCards({ model: MODELS[0], phone, peers: [phone], llama: false }));
  assert.match(c.here.why, /kula-node setup/);
  assert.match(c.split.why, /kula-node setup/);
  assert.match(c.apart.why, /second phone/);
  assert.equal(c.phone.disabled, false);
  c = by(wiz.modeCards({ model: MODELS[2], phone, peers: [phone], llama: true }));
  assert.match(c.phone.why, /only on this computer/);
  assert.match(c.apart.why, /only on this computer/);
  assert.equal(c.here.disabled, false);
  c = by(wiz.modeCards({ model: MODELS[0], phone: null, peers: [], llama: true }));
  assert.match(c.phone.why, /connect a phone/);
  assert.match(c.split.why, /connect a phone/);
  c = by(wiz.modeCards({ model: MODELS[0], phone: { ...phone, far: true }, peers: [phone], llama: true }));
  assert.match(c.split.why, /relay/);
  // which devices a load asks for
  const other = { id: 'q', name: 'tab', reach: { ok: true }, far: true };
  const off = { id: 'r', name: 'old', reach: { ok: false } };
  assert.deepEqual(wiz.loadPeers('phone', phone, [phone, other, off]), ['p']);
  assert.deepEqual(wiz.loadPeers('here', phone, [phone]), []);
  assert.deepEqual(wiz.loadPeers('apart', phone, [phone, other, off]), ['p', 'q']);
  assert.deepEqual(wiz.loadPeers('split', phone, [other, off, phone]), ['p']);
  // the phone: the one just connected, the one from last time, else the first that answers
  assert.equal(wiz.choosePhone([off, other, phone], ['p']).id, 'p');
  assert.equal(wiz.choosePhone([off, other, phone], ['r']).id, 'q');
  assert.equal(wiz.choosePhone([off], []), null);
});

// ---------- GET discover

test('discover: kula devices on this network from a (fake) mdns browser: name, host, port, kind, the peer it already is; no secret', async () => {
  writePeers([{ id: '192.168.1.40:50551', name: 'old pixel', host: '192.168.1.40', port: 50551, secret: '', fp: 'ab'.repeat(32), pin: null, relay: null, kind: 'phone', ram: null, bw: null, added_at: new Date().toISOString() }], path.join(HOME, 'peers.json'));
  let finds = 0;
  let destroyed = 0;
  const fake = () => {
    const browser = Object.assign(new EventEmitter(), { services: [] as any[], stop() {}, start() {} });
    setTimeout(() => {
      browser.emit('up', { name: 'kula pixel 7f1c0a2e', port: 50551, addresses: ['fe80::1', '192.168.1.33'], txt: { id: '7f1c0a2e-1', name: 'pixel', ram: '7600', kind: 'phone', v: 'rpc7', secret: 'deadbeefdeadbeefdeadbeefdeadbeef', pin: '0123456789abcdef' } });
      browser.emit('up', { name: 'kula old', port: 50551, addresses: ['192.168.1.40'], txt: { name: 'old pixel', kind: 'phone' } });
    }, 10);
    return { find: (o: any) => { finds++; assert.deepEqual(o, { type: 'kula', protocol: 'tcp' }); return browser as any; }, destroy: () => { destroyed++; } };
  };
  const engine = new Engine({ peersFile: path.join(HOME, 'peers.json'), bonjour: fake as any, discoverMs: 120 });
  // two asking at once share one look
  const [a, b] = await Promise.all([engine.discover(), engine.discover()]);
  assert.equal(finds, 1);
  assert.equal(destroyed, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [
    { name: 'pixel', host: '192.168.1.33', port: 50551, kind: 'phone', v: 'rpc7', paired: null },
    { name: 'old pixel', host: '192.168.1.40', port: 50551, kind: 'phone', v: null, paired: '192.168.1.40:50551' },
  ]);
  const text = JSON.stringify(a);
  assert.ok(!/secret|pin|deadbeef|0123456789abcdef|abab/.test(text), text);
  // and once more: a new look
  await engine.discover();
  assert.equal(finds, 2);
  // peers carry `holds` (null until a probe asked the phone) and no secret either
  const rows = engine.peers();
  assert.equal(rows[0].holds, null);
  assert.ok(!/secret|"pin"|abab/.test(JSON.stringify(rows)));
  await engine.close();
});
