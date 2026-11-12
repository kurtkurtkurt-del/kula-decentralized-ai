// god's eye cards (11.11.2026): branches suggest, the eye gathers and checks, the person applies or
// dismisses. The eye never carries a card out itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-cards-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { GodsEye, cleanCard, cleanAction, dark } = await import('../src/godseye/index.ts');

const snap = (at = 1000) => ({
  at, host: { name: 'mac', freeMb: 4000 }, devices: [],
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true }, models: [], projects: [],
});
// a branch whose suggestions the test sets
function eyeWith(say: { planner?: unknown[]; models?: unknown[] }) {
  const maker = (id: 'planner' | 'models') => () => ({ id, observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: say[id] as any }) });
  const eye = new GodsEye({ snapshot: () => snap(), dir: path.join(HOME, String(Math.random())), makers: { planner: maker('planner'), models: maker('models') } });
  eye.tick();
  return eye;
}
const load = { do: 'load', model: 'qwen3-0.6b', mode: 'apart', devices: ['p1'] };

test('actions are kept only exactly as types.ts spells them', () => {
  assert.deepEqual(cleanAction(load), load);
  assert.deepEqual(cleanAction({ ...load, ctx: 8192 }), { ...load, ctx: 8192 });
  assert.equal(cleanAction({ ...load, mode: 'everywhere' }), null);
  assert.equal(cleanAction({ ...load, devices: 'p1' }), null);
  assert.equal(cleanAction({ do: 'rm', path: '/' }), null);
  assert.equal(cleanAction({ do: 'open', panel: 'branch' }), null, 'a branch page needs a branch');
  assert.deepEqual(cleanAction({ do: 'open', panel: 'branch', branch: 'trust' }), { do: 'open', panel: 'branch', branch: 'trust' });
  assert.deepEqual(cleanAction({ do: 'unload', extra: 1 }), { do: 'unload' });
});

test('a card needs an id of its own branch, a kind, words; a broken action drops the card, not just the action', () => {
  assert.ok(cleanCard({ id: 'planner:x', kind: 'suggest', title: 't', why: 'w', action: load }));
  assert.equal(cleanCard({ id: 'planner:x', kind: 'suggest', title: 't', why: 'w', action: { do: 'format-disk' } }), null);
  assert.equal(cleanCard({ id: 'Planner x', kind: 'suggest', title: 't', why: 'w', action: null }), null);
  assert.equal(cleanCard({ id: 'planner:x', kind: 'shout', title: 't', why: 'w', action: null }), null);
  assert.equal(cleanCard({ id: 'planner:x', kind: 'warn', title: '', why: 'w', action: null }), null);
  assert.equal(cleanCard({ id: 'planner:x', kind: 'warn', title: 't'.repeat(500), why: 'w', action: null })!.title.length, 140);
});

test('the eye gathers cards from every branch, most important first; a branch cannot speak for another', () => {
  const eye = eyeWith({
    planner: [
      { id: 'planner:a', kind: 'suggest', title: 'a', why: 'w', action: load, weight: 1 },
      { id: 'planner:b', kind: 'warn', title: 'b', why: 'w', action: null, weight: 3 },
      { id: 'models:spoof', kind: 'warn', title: 'spoof', why: 'w', action: null },
    ],
    models: [{ id: 'models:c', kind: 'suggest', title: 'c', why: 'w', action: { do: 'fetch', model: 'gemma3-1b' } }],
  });
  const v = eye.view();
  assert.deepEqual(v.cards.map((c) => c.id), ['planner:b', 'models:c', 'planner:a']);
  assert.equal(v.cards[0].branch, 'planner');
  assert.ok(v.cards.every((c) => typeof c.since === 'number'));
});

test('dismissed and applied cards stay hidden while their reason holds, and come back once it went and returned', () => {
  const say: { planner: unknown[] } = { planner: [{ id: 'planner:a', kind: 'suggest', title: 'a', why: 'w', action: load }] };
  const eye = eyeWith(say);
  assert.equal(eye.card('planner:a')?.id, 'planner:a');
  assert.equal(eye.dismiss('planner:a'), true);
  eye.tick();
  assert.equal(eye.view().cards.length, 0);
  assert.equal(eye.dismiss('planner:a'), false, 'a hidden card is not a card');
  say.planner = [];
  eye.tick(); eye.view();
  say.planner = [{ id: 'planner:a', kind: 'suggest', title: 'a', why: 'w', action: load }];
  eye.tick();
  assert.equal(eye.view().cards.length, 1, 'the reason went away and came back: a new card');
  eye.applied('planner:a', 'loading');
  assert.equal(eye.view().cards.length, 0);
});

test('at most five cards per branch, and a broken branch has none', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `planner:n${i}`, kind: 'suggest', title: 't', why: 'w', action: null }));
  assert.equal(eyeWith({ planner: many }).view().cards.length, 5);
  const eye = new GodsEye({ snapshot: () => snap(), dir: path.join(HOME, 'broken'), makers: { planner: () => ({ id: 'planner', observe() { throw new Error('x'); }, view: () => ({ ...dark(), suggestions: many as any }) }) } });
  eye.tick();
  assert.equal(eye.view().cards.length, 0);
});

test('the page applies and dismisses cards through the server; a gone card is a 404; the engine does the work', async () => {
  process.env.KULA_NODE_HOME = HOME;
  const { Engine } = await import('../src/ui/engine.ts');
  const { startUi } = await import('../src/ui/server.ts');
  const dir = fs.mkdtempSync(path.join(HOME, 'ui-'));
  const engine = new Engine({ peersFile: path.join(dir, 'peers.json'), modelDirs: [dir], llama: null });
  const say = [
    { id: 'planner:unload', kind: 'suggest', title: 'unload', why: 'nothing uses it', action: { do: 'unload' } },
    { id: 'planner:look', kind: 'warn', title: 'look', why: 'w', action: null },
    { id: 'planner:fetch', kind: 'suggest', title: 'fetch', why: 'w', action: { do: 'fetch', model: 'no-such-model' } },
  ];
  const eye = new GodsEye({ snapshot: () => snap(), dir: path.join(dir, 'eye'), makers: { planner: () => ({ id: 'planner', observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: say as any }) }) } });
  eye.tick();
  const ui = await startUi({ engine, eye, port: 0, prefix: 'ab'.repeat(12), token: 'cd'.repeat(16) } as any);
  const post = (route: string, body: unknown) => fetch(`${ui.url}api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${ui.port}`, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) });
  try {
    const a = await post('brain/apply', { id: 'planner:unload', action: { do: 'unload' } });
    assert.equal(a.status, 200);
    assert.equal((await a.json()).word, 'unloaded');
    assert.equal((await post('brain/apply', { id: 'planner:unload' })).status, 404, 'applied: hidden, gone');
    assert.equal((await post('brain/apply', { id: 'planner:look' })).status, 400, 'a warning has nothing to apply');
    const f = await post('brain/apply', { id: 'planner:fetch', action: { do: 'fetch', model: 'no-such-model' } });
    assert.equal(f.status, 400);
    assert.match((await f.json()).error, /unknown model/);
    assert.equal((await post('brain/dismiss', { id: 'planner:look' })).status, 200);
    assert.equal((await post('brain/dismiss', { id: 'planner:look' })).status, 404);
    assert.equal((await post('brain/apply', { id: 'models:nothing' })).status, 404);
    const cross = await fetch(`${ui.url}api/brain/apply`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ id: 'planner:fetch' }) });
    assert.equal(cross.status, 403, 'another site cannot press a card');
  } finally { await ui.close(); eye.stop(); }
});

test('the advisor\'s "first: <card>" hides with the card it points at', () => {
  const eye = new GodsEye({ snapshot: () => snap(), dir: path.join(HOME, 'adv'), makers: {
    planner: () => ({ id: 'planner', observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: [{ id: 'planner:split:m', kind: 'suggest', title: 't', why: 'w', action: null }] as any }) }),
    advisor: () => ({ id: 'advisor', observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: [{ id: 'advisor:first:planner:split:m', kind: 'suggest', title: 'first', why: 'w', action: null }] as any }) }),
  } });
  eye.tick();
  assert.equal(eye.view().cards.length, 2);
  eye.dismiss('planner:split:m');
  assert.deepEqual(eye.view().cards.map((c) => c.id), []);
});
