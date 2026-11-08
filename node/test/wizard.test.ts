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
import net from 'node:net';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-wiz-home-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const wiz = await import('../src/ui/static/wizard.js');
const { Engine } = await import('../src/ui/engine.ts');
const { writePeers, readPeers } = await import('../src/peers.ts');
const { startGateServer } = await import('../src/gate.ts');

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

test('dots: seven stages, every step sits in one', () => {
  assert.equal(wiz.STAGES.length, 7);
  for (const [step, stage] of [['how', 0], ['cable-plug', 1], ['wifi-list', 1], ['cable-code', 2], ['wifi-apart', 2], ['connected', 2], ['model', 3], ['mode', 4], ['pick', 5], ['load', 6]] as const) assert.equal(wiz.stageOf(step), stage, step);
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
  assert.equal(w.step, 'pick');
  assert.equal(w.mode, 'phone');
  assert.equal(wiz.back(w), 'mode');
  // phone takes exactly one device
  assert.equal(wiz.next(w, { type: 'picked', ids: [] }).step, 'pick');
  assert.equal(wiz.next(w, { type: 'picked', ids: ['p', 'q'] }).step, 'pick');
  w = wiz.next(w, { type: 'picked', ids: ['p'] });
  assert.equal(w.step, 'load');
  assert.deepEqual(w.picked, ['p']);
  assert.equal(wiz.back(w), 'pick');
  // "this computer" asks for no devices
  const here = wiz.next({ ...w, step: 'mode' }, { type: 'mode', mode: 'here' });
  assert.equal(here.step, 'load');
  assert.equal(wiz.back(here), 'mode');
  for (const m of ['apart', 'split']) assert.equal(wiz.next({ ...w, step: 'mode' }, { type: 'mode', mode: m }).step, 'pick', m);
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

// ---------- the devices step

const READY = (ms = 40) => ({ ok: true, ms });
const P = {
  pixel: { id: 'p1', name: 'pixel 8', far: false, cable: null, ram: 3000, reach: READY(30), holds: null },
  tabW: { id: 't-wifi', name: 'Galaxy Tab S9', far: false, cable: null, ram: 6000, reach: { ok: false, reason: 'connect timeout' }, holds: null },
  tabC: { id: 't-cable', name: 'SAMSUNG Galaxy Tab S9', far: false, cable: { serial: 'X', plugged: true }, ram: 6000, reach: READY(8), holds: 'a.gguf' },
  old: { id: 'o1', name: 'old phone', far: false, cable: null, ram: 500, reach: READY(90), holds: null },
  far: { id: 'f1', name: 'far phone', far: true, cable: null, ram: 8000, reach: READY(200), holds: null },
  busy: { id: 'b1', name: 'busy phone', far: false, cable: null, ram: 8000, reach: { ok: false, reason: 'busy: in use by another computer' }, holds: null },
  never: { id: 'n1', name: 'never checked', far: false, cable: null, ram: null, reach: null, holds: null },
};
const ALL = Object.values(P);

test('devices: one entry per physical device; the cable and wi-fi rows of one tablet are one, sent by the route that answers', () => {
  const e = wiz.deviceEntries(ALL);
  assert.equal(e.length, 6);
  const tab = e.find((x: any) => x.ids.includes('t-wifi'));
  assert.deepEqual(tab.ids.sort(), ['t-cable', 't-wifi']);
  assert.equal(tab.id, 't-cable');                        // the cable answers: the load uses it
  assert.deepEqual(tab.via, ['cable', 'wi-fi']);
  assert.equal(tab.state, 'ready');
  assert.equal(tab.holds, 'a.gguf');
  assert.equal(tab.ms, 8);
  // the cable unplugged, the wi-fi answers: the wi-fi id
  const t2 = wiz.deviceEntries([{ ...P.tabC, reach: { ok: false, reason: 'unplugged: plug the cable in' } }, { ...P.tabW, reach: READY(50) }])[0];
  assert.equal(t2.id, 't-wifi');
  assert.equal(t2.state, 'ready');
  // neither answers: not answering, with the reason
  const t3 = wiz.deviceEntries([{ ...P.tabC, reach: { ok: false, reason: 'unplugged: plug the cable in' } }, P.tabW])[0];
  assert.equal(t3.state, 'off');
  assert.equal(t3.reason, 'the cable is unplugged');
  assert.equal(wiz.reasonWords('connect ECONNREFUSED 127.0.0.1:9'), 'nothing answers: is share this phone on?');
  assert.match(wiz.reasonWords('connect timeout'), /cannot be reached/);
  // two wi-fi rows of the same name stay two devices
  assert.equal(wiz.deviceEntries([P.pixel, { ...P.pixel, id: 'p2' }]).length, 2);
  // a row that already carries its routes (one row per device) is one entry as it is
  const routed = wiz.deviceEntries([{ id: 'd1', name: 'pixel 9', far: false, cable: null, ram: 4000, reach: READY(9), routes: [{ via: 'wifi', reach: { ok: false, reason: 'timeout' } }, { via: 'cable', reach: READY(9) }] }]);
  assert.equal(routed.length, 1);
  assert.deepEqual(routed[0].via, ['cable', 'wi-fi']);
  assert.equal(routed[0].id, 'd1');
  // states
  const by = Object.fromEntries(e.map((x: any) => [x.name, x.state]));
  assert.equal(by['busy phone'], 'busy');
  assert.equal(by['never checked'], 'unknown');
  assert.equal(by['pixel 8'], 'ready');
});

test('devices: this computer first (never for "phone"), ready ones first; split cannot use a relay; apart needs the file here', () => {
  const rows = wiz.pickRows({ mode: 'split', peers: ALL, model: MODELS[1], llama: true, freeMb: 8000 });
  assert.equal(rows[0].id, 'here');
  assert.equal(rows[0].fixed, true);
  assert.equal(rows[0].state, 'ready');
  const far = rows.find((r: any) => r.id === 'f1');
  assert.equal(far.state, 'off');
  assert.equal(far.blocked, true);
  assert.match(far.reason, /relay/);
  assert.deepEqual(rows.slice(1).map((r: any) => r.state), ['ready', 'ready', 'ready', 'busy', 'unknown', 'off']);
  assert.ok(!wiz.pickRows({ mode: 'phone', peers: ALL }).some((r: any) => r.local));
  const ap = wiz.pickRows({ mode: 'apart', peers: [], model: MODELS[0], llama: true });   // a.gguf is not here
  assert.equal(ap[0].state, 'off');
  assert.match(ap[0].reason, /not on this computer/);
  assert.equal(wiz.pickRows({ mode: 'apart', peers: [], model: MODELS[1], llama: true })[0].state, 'ready');
  assert.match(wiz.pickRows({ mode: 'apart', peers: [], model: MODELS[1], llama: false })[0].reason, /llama/);
});

test('devices: the ready ones come ticked, the rest not; apart leaves out what does not fit; the last unticks are kept', () => {
  const ids = (mode: string, model: any, last = {}, prefer: string[] = [], llama = true) => wiz.preselect(mode, wiz.pickRows({ mode, peers: ALL, model, llama, freeMb: 8000 }), model, last, prefer).sort();
  // split: this computer and every ready nearby device; not the busy, the unchecked, the relay
  assert.deepEqual(ids('split', MODELS[1]), ['here', 'o1', 'p1', 't-cable']);
  // apart with B (2.6 GB): the old phone (0.5 GB free) does not fit, so it starts unticked; the relay one may answer
  assert.deepEqual(ids('apart', MODELS[1]), ['f1', 'here', 'p1', 't-cable']);
  // apart, this computer cannot (llama.cpp missing): not ticked
  assert.deepEqual(ids('apart', MODELS[1], {}, [], false), ['f1', 'p1', 't-cable']);
  // remembered: the pixel unticked last time stays unticked while it answers; this computer left out
  assert.deepEqual(ids('apart', MODELS[1], { skip: ['p1'], here: false }), ['f1', 't-cable']);
  // a remembered untick of the tablet's wi-fi id covers the whole tablet
  assert.deepEqual(ids('split', MODELS[1], { skip: ['t-wifi'] }), ['here', 'o1', 'p1']);
  // phone: exactly one; the one just connected, else the last, else the first ready that fits
  assert.deepEqual(ids('phone', MODELS[1], {}, ['p1']), ['p1']);
  assert.deepEqual(ids('phone', MODELS[1], { id: 't-wifi' }), ['t-cable']);
  assert.deepEqual(ids('phone', MODELS[1], { id: 'b1' }).length, 1);         // the last one is busy: another ready one
  assert.deepEqual(wiz.preselect('phone', wiz.pickRows({ mode: 'phone', peers: [P.old, P.pixel], model: MODELS[1] }), MODELS[1], {}), ['p1']);
  // nothing remembered: where it fits best (the tablet's 6 GB over the pixel's tight 3 GB)
  assert.deepEqual(wiz.preselect('phone', wiz.pickRows({ mode: 'phone', peers: [P.pixel, P.old, P.tabC] }), MODELS[1], {}), ['t-cable']);
  assert.deepEqual(wiz.preselect('phone', wiz.pickRows({ mode: 'phone', peers: [P.tabW, P.never] }), MODELS[1], {}), []);
  // remember: ready rows left unticked (all their ids), this computer for apart, the phone
  const rows = wiz.pickRows({ mode: 'apart', peers: ALL, model: MODELS[1], llama: true });
  assert.deepEqual(wiz.remember('apart', rows, ['p1']), { skip: ['t-wifi', 't-cable', 'o1', 'f1'], here: false });
  assert.deepEqual(wiz.remember('phone', rows, ['p1']), { id: 'p1' });
});

test('devices: phone keeps exactly one tick, this computer stays in a split, a relay cannot be ticked for split', () => {
  const rows = wiz.pickRows({ mode: 'split', peers: ALL, model: MODELS[1], llama: true });
  const r = (id: string) => rows.find((x: any) => x.id === id);
  assert.deepEqual(wiz.toggle('phone', ['p1'], r('o1')), ['o1']);
  assert.deepEqual(wiz.toggle('phone', ['p1'], r('p1')), ['p1']);
  assert.deepEqual(wiz.toggle('split', ['here', 'p1'], r('here')), ['here', 'p1']);
  assert.deepEqual(wiz.toggle('split', ['here', 'p1'], r('f1')), ['here', 'p1']);
  assert.deepEqual(wiz.toggle('split', ['here', 'p1'], r('p1')), ['here']);
  assert.deepEqual(wiz.toggle('apart', ['p1'], r('n1')), ['p1', 'n1']);   // not checked yet: can still be ticked
});

test('devices: plain words before the load when a ticked device does not fit or does not answer; what the load sends', () => {
  const rows = wiz.pickRows({ mode: 'apart', peers: ALL, model: MODELS[1], llama: true, freeMb: 8000 });
  let c = wiz.pickCheck({ mode: 'apart', model: MODELS[1], rows, picked: ['o1', 't-cable', 'n1', 'b1'] });
  assert.equal(c.ok, true);
  assert.ok(c.warn.some((t: string) => /B is too big for old phone: it has about 0\.5 GB free, the model needs about 2\.5 GB/.test(t)), c.warn.join('\n'));
  assert.ok(c.warn.some((t: string) => /never checked has not been checked yet/.test(t)));
  assert.ok(c.warn.some((t: string) => /busy phone is busy/.test(t)));
  const offRows = wiz.pickRows({ mode: 'apart', peers: [P.tabW], model: MODELS[1], llama: true });
  c = wiz.pickCheck({ mode: 'apart', model: MODELS[1], rows: offRows, picked: ['t-wifi'] });
  assert.match(c.warn[0], /Galaxy Tab S9 does not answer \(cannot be reached from here: is it on this network\?\): it will be left out/);
  assert.deepEqual(wiz.pickCheck({ mode: 'apart', model: MODELS[1], rows, picked: [] }), { ok: false, block: 'pick at least one device', warn: [] });
  // the tablet with 6 GB and B (2.6 GB): fits, no words; with 3 GB: tight
  assert.deepEqual(wiz.pickCheck({ mode: 'apart', model: MODELS[1], rows, picked: ['t-cable'] }).warn, []);
  assert.match(wiz.pickCheck({ mode: 'phone', model: MODELS[1], rows: wiz.pickRows({ mode: 'phone', peers: [P.pixel] }), picked: ['p1'] }).warn[0], /tight on pixel 8/);
  // phone: exactly one
  const ph = wiz.pickRows({ mode: 'phone', peers: ALL });
  assert.equal(wiz.pickCheck({ mode: 'phone', model: MODELS[0], rows: ph, picked: [] }).ok, false);
  assert.equal(wiz.pickCheck({ mode: 'phone', model: MODELS[0], rows: ph, picked: ['p1'] }).ok, true);
  // split: this computer alone is not a split; too little memory together is said
  const sp = wiz.pickRows({ mode: 'split', peers: ALL, model: MODELS[3], llama: true, freeMb: 4000 });
  assert.equal(wiz.pickCheck({ mode: 'split', model: MODELS[3], rows: sp, picked: ['here'] }).ok, false);
  c = wiz.pickCheck({ mode: 'split', model: MODELS[3], rows: sp, picked: ['here', 'p1'], hereFreeMb: 4000 });
  assert.equal(c.ok, true);
  assert.ok(c.warn.some((t: string) => /D needs about 9\.6 GB; the ticked devices offer about 4\.9 GB together/.test(t)), c.warn.join('\n'));
  // the body: exactly these, nothing guessed
  assert.deepEqual(wiz.pickBody('split', ['here', 'p1', 't-cable']), { peers: ['p1', 't-cable'], all: true });
  assert.deepEqual(wiz.pickBody('apart', ['p1']), { peers: ['p1'], all: true, here: false });
  assert.deepEqual(wiz.pickBody('apart', ['here']), { peers: [], all: true, here: true });
  assert.deepEqual(wiz.pickBody('phone', ['t-cable']), { peers: ['t-cable'], all: true });
  assert.equal(wiz.pickGo('split', ['here', 'p1']), 'split over 2 devices');
  assert.equal(wiz.pickGo('apart', ['p1']), 'load on 1 device');
  assert.equal(wiz.pickGo('phone', []), 'pick one');
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

// ---------- a paired phone on a new address

test('probe: a paired wi-fi phone mdns heard at a new address is kept there once its handshake passes; an impostor at the heard address is not', async () => {
  const sink = net.createServer((s) => s.on('error', () => {}));
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', () => r()));
  const sinkPort = (sink.address() as net.AddressInfo).port;
  const gate = (secret: string) => startGateServer({ port: 0, host: '127.0.0.1', secret, targets: (ch) => (ch === 'api' ? sinkPort : null) });
  const phone = await gate('aa'.repeat(16));
  const impostor = await gate('bb'.repeat(16));
  const gone = net.createServer();
  await new Promise<void>((r) => gone.listen(0, '127.0.0.1', () => r()));
  const oldPort = (gone.address() as net.AddressInfo).port;
  await new Promise<void>((r) => gone.close(() => r()));

  const run = async (heardPort: number) => {
    const file = path.join(HOME, `moved-${heardPort}.json`);
    writePeers([{ id: 'phone-1', name: 'pixel', host: '127.0.0.1', port: oldPort, secret: 'aa'.repeat(16), fp: '', pin: null, relay: null, kind: 'phone', ram: null, bw: null, added_at: new Date().toISOString() }], file);
    const fake = () => {
      const browser = Object.assign(new EventEmitter(), { services: [] as any[], stop() {}, start() {} });
      setTimeout(() => browser.emit('up', { name: 'kula pixel', port: heardPort, addresses: ['127.0.0.1'], txt: { id: 'phone-1', name: 'pixel', kind: 'phone', v: 'rpc7' } }), 10);
      return { find: () => browser as any, destroy: () => {} };
    };
    const engine = new Engine({ peersFile: file, bonjour: fake as any, discoverMs: 80, probeMs: 1500 });
    const found = await engine.discover();
    assert.equal(found[0].paired, 'phone-1');
    const [row] = await engine.probe(['phone-1']);
    const saved = readPeers(file)[0];
    await engine.close();
    return { row, saved };
  };

  const good = await run(phone.port);
  assert.equal(good.row.reach?.ok, true);
  assert.equal(good.saved.port, phone.port);
  assert.ok(good.saved.last_ok);

  const bad = await run(impostor.port);
  assert.equal(bad.row.reach?.ok, false);
  assert.equal(bad.saved.port, oldPort);

  await phone.close();
  await impostor.close();
  sink.close();
});
