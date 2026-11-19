// An old chat and its model (src/ui/static/chatmodel.js, the module the page imports): every row
// of the state table in DECISIONS A4 with its exact words, what a loaded model leaves in the chat
// record, an old chat with only a name, and the load a tap sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const cm = await import('../src/ui/static/chatmodel.js');

const QWEN = { id: 'qwen3-0.6b', name: 'Qwen3 0.6B', here: true, size: 639447744 };
const COPY = { id: 'local:copy.gguf', name: 'copy', here: true, size: 639447744 };
const MODELS = [QWEN, COPY];
const loadedAs = (m: { id: string; name: string }, o: Record<string, unknown> = {}) => ({ mode: 'here', model: { id: m.id, name: m.name, file: 'x.gguf', size: 1 }, ctx: 4096, devices: [{ id: 'local', name: 'this computer', local: true, busy: false, tps: null, done: 0 }], since: 1, ...o });
const st = (o: Record<string, unknown> = {}) => ({ loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true, ...o });
const ranHere = { model: QWEN.id, name: QWEN.name, mode: 'here', peers: [], names: [], here: true, ctx: 4096, at: 1 };
const ranPhone = { model: QWEN.id, name: QWEN.name, mode: 'phone', peers: ['p1'], names: ['pixel'], here: false, ctx: 2048, at: 1 };
const peer = (id: string, name: string, reach: unknown = { ok: true, ms: 5 }, o: Record<string, unknown> = {}) => ({ id, name, reach, ...o });
const base = (o: Record<string, unknown> = {}) => ({ ran: ranHere, status: st(), models: MODELS, modelsKnown: true, peers: [], guest: false, locked: false, dismissed: false, loadError: null, ...o });
const view = (s: { text: string; buttons: { act: string; label: string; primary: boolean; title: string | null }[] } | null) =>
  s && { text: s.text, buttons: s.buttons.map((b) => `${b.label} → ${b.act}${b.primary ? ' *' : ''}${b.title ? ` (${b.title})` : ''}`) };

test('1 hidden: a guest, a locked chat, a chat with no ran', () => {
  assert.equal(cm.chatModelState(base({ guest: true })), null);
  assert.equal(cm.chatModelState(base({ locked: true })), null);
  assert.equal(cm.chatModelState(base({ ran: null })), null);
});

test('2 loading: the chat\'s own model with its line and stop; another model without buttons', () => {
  const mine = cm.chatModelState(base({ status: st({ loading: { mode: 'here', model: QWEN.name, since: 1, line: 'loading into memory' } }) }));
  assert.equal(mine.kind, 'loading');
  assert.equal(mine.red, false);
  assert.deepEqual(view(mine), { text: 'loading Qwen3 0.6B: loading into memory', buttons: ['stop → stop'] });
  const other = cm.chatModelState(base({ status: st({ loading: { mode: 'here', model: 'copy', since: 1, line: 'starting' } }) }));
  assert.deepEqual(view(other), { text: 'this chat used Qwen3 0.6B: copy is loading now.', buttons: [] });
});

test('3 loaded-silent: the chat\'s model is loaded but a device of it does not answer', () => {
  const loaded = loadedAs(QWEN, { mode: 'phone', devices: [{ id: 'p1', name: 'pixel', local: false, busy: false, tps: null, done: 0 }] });
  const s = cm.chatModelState(base({ ran: ranPhone, status: st({ loaded }), peers: [peer('p1', 'pixel', { ok: false, reason: 'unplugged' })] }));
  assert.equal(s.kind, 'loaded-silent');
  assert.equal(s.red, true);
  assert.deepEqual(view(s), { text: 'Qwen3 0.6B is loaded, but pixel does not answer (the cable is unplugged).', buttons: ['connect → devices *', 'check again → check'] });
  const two = loadedAs(QWEN, { mode: 'split', parts: [{ id: 'local', name: 'this computer', local: true, mb: 1, layers: 1 }, { id: 'p1', name: 'pixel', local: false, mb: 1, layers: 1 }, { id: 'p2', name: 'tab', local: false, mb: 1, layers: 1 }] });
  const s2 = cm.chatModelState(base({ status: st({ loaded: two }), peers: [peer('p1', 'pixel', { ok: false }), peer('p2', 'tab', { ok: false })] }));
  assert.equal(s2.text, 'Qwen3 0.6B is loaded, but pixel and tab do not answer.');
});

test('3b hidden: the chat\'s model is loaded and its devices answer (any mode)', () => {
  assert.equal(cm.chatModelState(base({ status: st({ loaded: loadedAs(QWEN) }) })), null);
  const loaded = loadedAs(QWEN, { mode: 'apart', devices: [{ id: 'p1', name: 'pixel', local: false, busy: false, tps: null, done: 0 }] });
  assert.equal(cm.chatModelState(base({ status: st({ loaded }), peers: [peer('p1', 'pixel')] })), null);
});

test('4 hidden: the model list is not fetched yet', () => {
  assert.equal(cm.chatModelState(base({ modelsKnown: false, models: [] })), null);
});

test('5 failed: the last load from this line failed', () => {
  const s = cm.chatModelState(base({ loadError: 'not enough memory on this computer' }));
  assert.equal(s.kind, 'failed');
  assert.deepEqual(view(s), { text: 'Qwen3 0.6B did not load: not enough memory on this computer', buttons: ['try again → load *', 'start a chat → pick-model'] });
});

test('6 gone: a local file deleted, a catalog model no longer listed; stay with the loaded one', () => {
  const ranCopy = { ...ranHere, model: COPY.id, name: COPY.name };
  const s = cm.chatModelState(base({ ran: ranCopy, models: [QWEN], status: st({ loaded: loadedAs(QWEN) }) }));
  assert.equal(s.kind, 'gone');
  assert.deepEqual(view(s), { text: 'copy is no longer on this computer: the file was deleted or moved.', buttons: ['pick another model → pick-model *', 'stay with Qwen3 0.6B → stay'] });
  const s2 = cm.chatModelState(base({ models: [COPY] }));
  assert.deepEqual(view(s2), { text: 'Qwen3 0.6B is no longer in kula\'s model list.', buttons: ['pick another model → pick-model *'] });
});

test('7 no-llama: here or split without llama.cpp on this computer', () => {
  const s = cm.chatModelState(base({ status: st({ llama: false }) }));
  assert.equal(s.kind, 'no-llama');
  assert.deepEqual(view(s), { text: 'Qwen3 0.6B ran on this computer: that needs llama.cpp on this computer (run kula-node setup).', buttons: ['pick another way → pick-mode *'] });
  const split = { ...ranHere, mode: 'split', peers: ['p1'], names: ['pixel'] };
  assert.equal(cm.chatModelState(base({ ran: split, status: st({ llama: false }) })).text, 'Qwen3 0.6B ran split over this computer, pixel: that needs llama.cpp on this computer (run kula-node setup).');
});

test('8 refetch: here or split, the file is not on this computer any more', () => {
  const s = cm.chatModelState(base({ models: [{ ...QWEN, here: false }] }));
  assert.equal(s.kind, 'refetch');
  assert.deepEqual(view(s), { text: 'Qwen3 0.6B is no longer on this computer: it has to be downloaded again (639 MB).', buttons: ['download and load → load *', 'pick another model → pick-model'] });
});

test('9 unpaired: a stored device has no peer row (is / are)', () => {
  const ghost = { ...ranPhone, peers: ['ghost1'], names: ['ghost phone'] };
  const s = cm.chatModelState(base({ ran: ghost, peers: [] }));
  assert.equal(s.kind, 'unpaired');
  assert.deepEqual(view(s), { text: 'ghost phone is no longer paired with this computer.', buttons: ['add a device → devices *', 'pick another way → pick-mode'] });
  const two = { ...ranPhone, mode: 'apart', peers: ['g1', 'g2'], names: ['ghost phone', 'old tab'] };
  assert.equal(cm.chatModelState(base({ ran: two, peers: [peer('x', 'other')] })).text, 'ghost phone and old tab are no longer paired with this computer.');
});

test('10 silent: a stored device does not answer, or is busy; found by id or else by name', () => {
  const off = cm.chatModelState(base({ ran: ranPhone, peers: [peer('p1', 'pixel', { ok: false, reason: 'unplugged' })] }));
  assert.equal(off.kind, 'silent');
  assert.deepEqual(view(off), { text: 'pixel does not answer (the cable is unplugged).', buttons: ['connect → devices *', 'check again → check'] });
  // paired again under a new id, same name
  const byName = cm.chatModelState(base({ ran: ranPhone, peers: [peer('p9', 'pixel', { ok: false })] }));
  assert.equal(byName.text, 'pixel does not answer.');
  const busy = cm.chatModelState(base({ ran: ranPhone, peers: [peer('p1', 'pixel', { ok: false, reason: 'in use by another computer' })] }));
  assert.deepEqual(view(busy), { text: 'pixel is busy (in use by another computer).', buttons: ['connect → devices *', 'check again → check'] });
});

// The engine's rows (src/ui/engine.ts): routes as plain ids, ways, via 'wifi', the reach on the row.
const REFUSED = 'connect ECONNREFUSED 127.0.0.1:59314';
const enginePeer = (id: string, name: string, reach: unknown, o: Record<string, unknown> = {}) =>
  ({ id, name, reach, via: 'wifi', ways: { cable: null, wifi: null, relay: null }, routes: [id], ...o });

test('engine rows: 10 off and busy, 3 loaded-silent, each with the row\'s reason', () => {
  const off = cm.chatModelState(base({ ran: ranPhone, peers: [enginePeer('p1', 'pixel', { ok: false, reason: REFUSED })] }));
  assert.equal(off.kind, 'silent');
  assert.equal(off.text, 'pixel does not answer (nothing answers: is share this phone on?).');
  const busy = cm.chatModelState(base({ ran: ranPhone, peers: [enginePeer('p1', 'pixel', { ok: false, reason: 'in use by another computer' })] }));
  assert.equal(busy.kind, 'silent');
  assert.equal(busy.text, 'pixel is busy (in use by another computer).');
  const loaded = loadedAs(QWEN, { mode: 'phone', devices: [{ id: 'p1', name: 'pixel', local: false, busy: false, tps: null, done: 0 }] });
  const s = cm.chatModelState(base({ ran: ranPhone, status: st({ loaded }), peers: [enginePeer('p1', 'pixel', { ok: false, reason: REFUSED })] }));
  assert.equal(s.kind, 'loaded-silent');
  assert.equal(s.text, 'Qwen3 0.6B is loaded, but pixel does not answer (nothing answers: is share this phone on?).');
});

test('engine rows: a stored id among a row\'s routes resolves by id; the load sends the row\'s id', () => {
  const row = enginePeer('a', 'pixel', { ok: false, reason: REFUSED }, { routes: ['a', 'b'] });
  const [e] = cm.entriesOf([row]);
  assert.equal(e.id, 'a');
  assert.deepEqual(e.ids, ['a', 'b']);
  assert.equal(e.state, 'off');
  const ranB = { ...ranPhone, peers: ['b'], names: ['old name'] };
  const s = cm.chatModelState(base({ ran: ranB, peers: [row] }));
  assert.equal(s.kind, 'silent');
  assert.equal(s.text, 'pixel does not answer (nothing answers: is share this phone on?).');
  assert.deepEqual(cm.loadBody(ranB, [row], 4096), { model: QWEN.id, mode: 'phone', ctx: 2048, peers: ['a'], all: true });
});

test('11 no-way: an old chat with only a model name (ranFromChat), loaded or not', () => {
  const ran = cm.ranFromChat({ model: 'Qwen3 0.6B' }, MODELS);
  assert.deepEqual(ran, { model: QWEN.id, name: QWEN.name, mode: null, peers: [], names: [], here: false, ctx: null });
  assert.equal(cm.ranFromChat({ model: 'a model nobody has' }, MODELS), null);
  assert.equal(cm.ranFromChat({}, MODELS), null);
  assert.equal(cm.ranFromChat({ ran: ranPhone, model: 'copy' }, MODELS), ranPhone);
  const idle = cm.chatModelState(base({ ran }));
  assert.equal(idle.kind, 'no-way');
  assert.deepEqual(view(idle), { text: 'this chat used Qwen3 0.6B: it is not loaded.', buttons: ['load Qwen3 0.6B → pick-mode *'] });
  const other = cm.chatModelState(base({ ran, status: st({ loaded: loadedAs(COPY) }) }));
  assert.deepEqual(view(other), { text: 'this chat used Qwen3 0.6B: copy is loaded now.', buttons: ['load Qwen3 0.6B → pick-mode *', 'stay with copy → stay'] });
});

test('12 other: another model is loaded; stay dismisses while a model is loaded', () => {
  const s = cm.chatModelState(base({ status: st({ loaded: loadedAs(COPY) }) }));
  assert.equal(s.kind, 'other');
  assert.equal(s.red, true);
  assert.deepEqual(view(s), { text: 'this chat used Qwen3 0.6B on this computer: copy is loaded now.', buttons: ['load Qwen3 0.6B → load * (unloads copy first)', 'stay with copy → stay'] });
  assert.equal(cm.chatModelState(base({ status: st({ loaded: loadedAs(COPY) }), dismissed: true })), null);
  // with nothing loaded, dismissed does not hide it
  assert.equal(cm.chatModelState(base({ dismissed: true })).kind, 'idle');
});

test('13 idle: nothing is loaded; where it ran, in words', () => {
  const s = cm.chatModelState(base());
  assert.equal(s.kind, 'idle');
  assert.deepEqual(view(s), { text: 'this chat used Qwen3 0.6B on this computer: it is not loaded.', buttons: ['load it → load *'] });
  assert.equal(cm.chatModelState(base({ ran: ranPhone, peers: [peer('p1', 'pixel')] })).text, 'this chat used Qwen3 0.6B on pixel: it is not loaded.');
  assert.equal(cm.whereWords({ ...ranHere, mode: 'apart', here: true, names: ['pixel', 'tab'] }), 'apart on this computer, pixel, tab');
  assert.equal(cm.whereWords({ ...ranHere, mode: 'apart', here: false, names: ['pixel'] }), 'apart on pixel');
  assert.equal(cm.whereWords({ ...ranHere, mode: null }), '');
});

test('ranOf: what a loaded model leaves in the chat record (parts first, else devices)', () => {
  assert.equal(cm.ranOf(null), null);
  assert.deepEqual(cm.ranOf(loadedAs(QWEN), 7), { model: QWEN.id, name: QWEN.name, mode: 'here', peers: [], names: [], here: true, ctx: 4096, at: 7 });
  const split = loadedAs(QWEN, { mode: 'split', ctx: 2048, devices: [{ id: 'zz', name: 'not used', local: false }], parts: [{ id: 'local', name: 'this computer', local: true, mb: 1, layers: 1 }, { id: 'p1', name: 'pixel', local: false, mb: 1, layers: 1 }] });
  assert.deepEqual(cm.ranOf(split, 7), { model: QWEN.id, name: QWEN.name, mode: 'split', peers: ['p1'], names: ['pixel'], here: true, ctx: 2048, at: 7 });
  const phone = loadedAs(QWEN, { mode: 'phone', devices: [{ id: 'p1', name: 'pixel', local: false }] });
  assert.deepEqual(cm.ranOf(phone, 7), { model: QWEN.id, name: QWEN.name, mode: 'phone', peers: ['p1'], names: ['pixel'], here: false, ctx: 4096, at: 7 });
});

test('loadBody: the chat\'s model, mode and devices by the route that answers today', () => {
  assert.deepEqual(cm.loadBody(ranHere, [], 8192), { model: QWEN.id, mode: 'here', ctx: 4096, peers: [] });
  // paired again under a new id: found by name, sent by the new id; ctx falls back to the setting
  assert.deepEqual(cm.loadBody({ ...ranPhone, ctx: null }, [peer('p9', 'pixel')], 8192), { model: QWEN.id, mode: 'phone', ctx: 8192, peers: ['p9'], all: true });
  const apart = { ...ranPhone, mode: 'apart', peers: ['p1', 'p2'], names: ['pixel', 'tab'], here: true };
  assert.deepEqual(cm.loadBody(apart, [peer('p1', 'pixel'), peer('p2', 'tab')], 4096), { model: QWEN.id, mode: 'apart', ctx: 2048, peers: ['p1', 'p2'], all: true, here: true });
  const split = { ...apart, mode: 'split' };
  assert.deepEqual(cm.loadBody(split, [peer('p1', 'pixel')], 4096), { model: QWEN.id, mode: 'split', ctx: 2048, peers: ['p1', 'p2'], all: true });
});
