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
const { sameAction } = await import('../src/godseye/eye.ts');

const snap = (at = 1000) => ({
  at, host: { name: 'mac', freeMb: 4000 }, devices: [],
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true }, models: [], projects: [],
});
// a branch whose suggestions the test sets
function eyeWith(say: { planner?: unknown[]; models?: unknown[]; trust?: unknown[]; limits?: unknown[] }) {
  const maker = (id: 'planner' | 'models' | 'trust' | 'limits') => () => ({ id, observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: say[id] as any }) });
  const eye = new GodsEye({ snapshot: () => snap(), dir: path.join(HOME, String(Math.random())), makers: { planner: maker('planner'), models: maker('models'), trust: maker('trust'), limits: maker('limits') } });
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

test('a load action keeps here:false only for apart; here:true or another mode gives no here key', () => {
  assert.deepEqual(cleanAction({ ...load, here: false }), { ...load, here: false });
  assert.ok(!('here' in cleanAction({ ...load, here: true })!));
  assert.ok(!('here' in cleanAction({ ...load, mode: 'phone', here: false })!));
  assert.ok(!('here' in cleanAction({ ...load, mode: 'split', here: false })!));
  assert.ok(!('here' in cleanAction({ ...load, here: 'false' })!));
  assert.ok(!sameAction({ ...load, here: false }, load), 'here:false is another action than a plain apart load');
  assert.ok(sameAction({ ...load, here: false }, cleanAction({ ...load, here: false })));
});

test('the panel puts privacy first, then health, then speed: weight comes second (C5)', () => {
  const eye = eyeWith({
    planner: [{ id: 'planner:alone:m', kind: 'warn', title: 'faster alone', why: 'w', action: null, weight: 2 }],
    limits: [{ id: 'limits:hot:p1', kind: 'warn', title: 'hot', why: 'w', action: null, weight: 3 }],
    trust: [{ id: 'trust:owner-blind:p1', kind: 'warn', title: 'could read', why: 'w', action: null, weight: 1 }],
  });
  assert.deepEqual(eye.view().cards.map((c) => c.id), ['trust:owner-blind:p1', 'limits:hot:p1', 'planner:alone:m']);
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

// finding D2 (12.11.2026): a tapped card was hidden by its id alone, so the same id carrying a
// different action (a worse problem, another fix) stayed hidden for as long as the reason held
test('a tapped card that now says another action shows again (D2)', () => {
  let card: any = { id: 'models:tight:local', kind: 'warn', weight: 3, title: 'M no longer fits the Mac: 3.0 GB free now', why: 'answers may crawl', action: { do: 'load', model: 's', mode: 'here', devices: [] }, label: 'load S' };
  let at = 1_000_000;
  const eye = new GodsEye({ snapshot: () => snap(at), dir: path.join(HOME, 'd2'), now: () => at,
    makers: { models: () => ({ id: 'models', observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: [card] }) }) } });
  eye.tick();
  eye.applied('models:tight:local', 'loading s (here)');
  for (let i = 0; i < 3; i++) { at += 5000; eye.tick(); }
  assert.deepEqual(eye.view().cards.map((c) => c.id), [], 'the same action: still hidden');
  card = { ...card, title: 'M no longer fits the Mac: 0.9 GB free now', action: { do: 'unload' }, label: 'unload' };
  for (let i = 0; i < 20; i++) { at += 5000; eye.tick(); }
  const shown = eye.view().cards;
  assert.deepEqual(shown.map((c) => c.id), ['models:tight:local'], 'it says unload now: shown');
  assert.equal(shown[0].action?.do, 'unload');
  assert.equal(eye.dismiss('models:tight:local'), true, 'and it can be dismissed again');
  eye.tick();
  assert.deepEqual(eye.view().cards.map((c) => c.id), []);
});

// finding D3: the advisor ranked the cards as the branches said them, dismissed ones too, so its
// "first:" pointed at a hidden card and was hidden with it while two cards stayed on the panel
test('after the top card is dismissed, the advisor names the most important card still shown (D3)', () => {
  const card = (id: string, weight: number, title: string) => ({ id, kind: 'warn', weight, title, why: 'w', action: { do: 'open', panel: 'devices' } });
  const stub = (id: string, list: unknown[]) => () => ({ id, observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: list as any }) });
  let at = 1_000_000;
  const eye = new GodsEye({ snapshot: () => snap(at), dir: path.join(HOME, 'd3'), now: () => at, makers: {
    models: stub('models', [card('models:tight:local', 3, 'M no longer fits the Mac')]),
    planner: stub('planner', [card('planner:alone:m', 2, 'split is slower than the Mac alone')]),
    executor: stub('executor', [card('executor:slow:p1', 2, 'pixel answers slowly')]),
  } as any });
  for (let i = 0; i < 4; i++) { at += 5000; eye.tick(); }
  assert.ok(eye.view().cards.some((c) => c.id === 'advisor:first:models:tight:local'));
  eye.dismiss('models:tight:local');
  for (let i = 0; i < 8; i++) { at += 5000; eye.tick(); }
  const v = eye.view();
  const ids = v.cards.map((c) => c.id);
  const adv = v.branches.find((b) => b.id === 'advisor')!;
  assert.ok(ids.some((id) => id.startsWith('advisor:first:') && id !== 'advisor:first:models:tight:local'), `a "first:" for a card still shown: ${JSON.stringify(ids)}`);
  assert.doesNotMatch(String(adv.stat), /no longer fits/, 'the advisor no longer quotes the dismissed card');
  assert.ok(!v.cards.some((c) => /no longer fits/.test(c.why)), '"then:" names no dismissed card');
});

// finding D4 (the proof is scratch d5): the reason-gone reset ran only inside cards(), which on
// kula-node runs only while the brain page asks; the eye ticks every 5 s regardless
test('a dismissed warning that went and came back while nobody looked at the cards shows again (D4)', () => {
  let on = true;
  const drop = { id: 'executor:drops:p1', kind: 'warn', weight: 3, title: 'pixel keeps dropping out', why: '3 of the last 12 looks', action: { do: 'probe', devices: ['p1'] } };
  let at = 1_000_000;
  const eye = new GodsEye({ snapshot: () => snap(at), dir: path.join(HOME, 'd4'), now: () => at,
    makers: { executor: () => ({ id: 'executor', observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: (on ? [drop] : []) as any }) }) } });
  eye.tick();
  eye.dismiss('executor:drops:p1');
  on = false; for (let i = 0; i < 100; i++) { at += 5000; eye.tick(); }
  on = true; const back = at + 5000; for (let i = 0; i < 10; i++) { at += 5000; eye.tick(); }
  const c = eye.view().cards.find((x) => x.id === 'executor:drops:p1');
  assert.ok(c, 'the returning warning shows');
  assert.equal(c!.since, back, 'since: when it came back, not the morning');
});

test('cards() and view() only read: looking at the cards twice changes nothing', () => {
  let at = 1_000_000;
  const say: unknown[] = [{ id: 'planner:a', kind: 'suggest', title: 'a', why: 'w', action: load }];
  const eye = new GodsEye({ snapshot: () => snap(at), dir: path.join(HOME, 'ro'), now: () => at,
    makers: { planner: () => ({ id: 'planner', observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: say as any }) }) } });
  eye.tick();
  eye.dismiss('planner:a');
  say.length = 0;
  assert.deepEqual(eye.cards(), []);
  say.push({ id: 'planner:a', kind: 'suggest', title: 'a', why: 'w', action: load });
  assert.deepEqual(eye.cards(), [], 'no look between: the dismissal stands');
});

// a dismissal survives device flaps: for a dismissed card only do, model and mode count, so a load
// card whose device list follows who is reachable stays closed; another model or mode opens it again
test('a dismissed load card stays hidden while only its devices change, and shows again for another model', () => {
  let at = 1_000_000;
  const card = (devices: string[], model = 'tiny') => ({ id: 'planner:split:m', kind: 'suggest', title: 'split it', why: 'w', action: { do: 'load', model, mode: 'apart', devices } });
  let say: unknown[] = [card(['p1', 'p2'])];
  const eye = new GodsEye({ snapshot: () => snap(at), dir: path.join(HOME, 'flap'), now: () => at,
    makers: { planner: () => ({ id: 'planner', observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: say as any }) }) } });
  eye.tick();
  assert.equal(eye.dismiss('planner:split:m'), true);
  for (const devices of [['p1'], ['p1'], ['p1', 'p2'], ['p2'], ['p1', 'p2']]) {
    say = [card(devices)];
    at += 5000; eye.tick();
    assert.deepEqual(eye.view().cards.map((c) => c.id), [], `devices ${devices.join(',')}: still dismissed`);
  }
  say = [card(['p1', 'p2'], 'bigger')];
  at += 5000; eye.tick();
  assert.deepEqual(eye.view().cards.map((c) => c.id), ['planner:split:m'], 'another model: shown again');
});

// unhide: a tap whose work failed (the load's rejection on kula-node) shows its card again; the eye
// only records it, nothing is retried
test('unhide shows an applied card again at once and runs nothing', () => {
  const say: unknown[] = [{ id: 'planner:a', kind: 'suggest', title: 'a', why: 'w', action: load }];
  const eye = eyeWith({ planner: say });
  eye.applied('planner:a', 'loading');
  assert.deepEqual(eye.view().cards.map((c) => c.id), []);
  assert.equal(eye.unhide('planner:a', 'the load failed'), true);
  assert.deepEqual(eye.view().cards.map((c) => c.id), ['planner:a']);
  assert.equal(eye.unhide('nobody:x', 'x'), false, 'no branch: nothing recorded');
});

// finding F1 (12.11.2026): a load card goes away while its load runs (the planner says nothing during
// work.loading), so the look forgets its hidden entry before the rejection arrives. The failure is
// still written in the box; unhide only records and shows again, it never retries or touches a dismissal
function spyActs(eye: object): [string, string, string, string | null][] {
  const acts: [string, string, string, string | null][] = [];
  const e = eye as any, real = e.recordAct.bind(eye);
  e.recordAct = (id: string, action: string, arg: string, word: string | null) => { acts.push([id, action, arg, word]); real(id, action, arg, word); };
  return acts;
}

test('unhide records apply-failed even after the look forgot the card during its load (F1)', () => {
  let at = 1_000_000;
  const say: unknown[] = [{ id: 'planner:a', kind: 'suggest', title: 'a', why: 'w', action: load }];
  const eye = new GodsEye({ snapshot: () => snap(at), dir: path.join(HOME, 'f1'), now: () => at,
    makers: { planner: () => ({ id: 'planner', observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: say as any }) }) } });
  eye.tick();
  const acts = spyActs(eye);
  eye.applied('planner:a', 'loading');
  say.length = 0; at += 5000; eye.tick();          // loading: the planner says nothing, the look forgets it
  assert.equal(eye.unhide('planner:a', 'the load failed', load), true);
  assert.deepEqual(acts.filter((a) => a[1] === 'apply-failed').map((a) => [a[0], a[2], a[3]]), [['planner', 'planner:a', 'the load failed']]);
  say.push({ id: 'planner:a', kind: 'suggest', title: 'a', why: 'w', action: load });
  at += 5000; eye.tick();
  assert.deepEqual(eye.view().cards.map((c) => c.id), ['planner:a'], 'back after the failed load');
});

test('unhide never ends a dismissal or an applied card with another action, but writes the failure (F1)', () => {
  const other = { ...load, devices: ['p1', 'p2'] };
  const say: unknown[] = [
    { id: 'planner:a', kind: 'suggest', title: 'a', why: 'w', action: load },
    { id: 'planner:b', kind: 'suggest', title: 'b', why: 'w', action: load },
  ];
  const eye = eyeWith({ planner: say });
  const acts = spyActs(eye);
  eye.dismiss('planner:a');
  eye.applied('planner:b', 'loading');
  assert.equal(eye.unhide('planner:a', 'the load failed', load), true);
  assert.equal(eye.unhide('planner:b', 'the load failed', other), true);
  assert.deepEqual(eye.view().cards.map((c) => c.id), [], 'the dismissal and the other action stay hidden');
  assert.equal(acts.filter((a) => a[1] === 'apply-failed').length, 2);
  assert.equal(eye.unhide('planner:b', 'the load failed', load), true);
  assert.deepEqual(eye.view().cards.map((c) => c.id), ['planner:b']);
});
