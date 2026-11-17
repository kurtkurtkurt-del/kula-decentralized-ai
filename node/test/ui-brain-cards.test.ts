// The brain's change cards through the page's server (17.11.2026, DECISIONS 5, E3): accept is
// brain/apply, reject is brain/reject, and the last accept's undo is brain/undo. All three are the
// owner's, from this very origin. anchor and cancel take a second tap (confirm), cap and an undo
// run only while the state is what the card (or the accept) saw. RISK 1: a friend's device the
// anchor cut today dials again once the cap is raised; RISK 2: an anchor that fails to start is a
// 500, the switch goes back off and the card stays.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-brain-cards-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { startUi } = await import('../src/ui/server.ts');
const { Engine } = await import('../src/ui/engine.ts');
const { ChatStore } = await import('../src/ui/store.ts');
const { ShareHere, readAnchorSetting } = await import('../src/ui/sharehere.ts');
const { GodsEye, dark } = await import('../src/godseye/index.ts');
const { createIdentity, newPin, Paired } = await import('../src/tls.ts');
const { startGateServer, handshake } = await import('../src/gate.ts');
const { AnchorHub, circleMembers, joinAnchor, dialAnchor } = await import('../src/anchor.ts');
type ShareHandle = import('../src/share.ts').ShareHandle;
type ShareOptions = import('../src/share.ts').ShareOptions;
type BranchId = import('../src/godseye/types.ts').BranchId;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(HOME, 'x-'));

const origin = (port: number) => ({ origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
const post = (url: string, port: number, body: unknown, headers: Record<string, string> = origin(port)) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function newEngine() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'models'));
  return new Engine({ peersFile: path.join(dir, 'peers.json'), modelDirs: [path.join(dir, 'models')], identity: createIdentity('mac'), llama: null, probeMs: 1500 });
}

const SNAP = () => ({ at: 1000, host: { name: 'mac', freeMb: 4000 }, devices: [], work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true }, models: [], projects: [] }) as any;

/** an eye whose branches say exactly `say[branch]` */
function eyeSaying(say: Partial<Record<BranchId, unknown[]>>) {
  const makers: Record<string, unknown> = {};
  for (const id of Object.keys(say)) makers[id] = () => ({ id, observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: say[id as BranchId] as any }) });
  const eye = new GodsEye({ snapshot: SNAP, dir: tmp(), makers: makers as any });
  eye.tick();
  return eye;
}

/** a share whose anchor is `hub` (a fake one, or a real AnchorHub); `fail` throws on the next start */
function shareWith(hub: () => unknown, settingFile: string, fail: { next: string | null } = { next: null }) {
  const start = async (opts: ShareOptions): Promise<ShareHandle> => {
    if (fail.next) { const m = fail.next; fail.next = null; throw new Error(m); }
    return Object.assign(async () => {}, {
      gatePort: opts.port, dashboard: null, deviceName: 'test-pc', host: '192.168.1.5',
      qr: () => '{"k":"kula-peer","v":3}', code: () => null, paired: () => 0,
      anchor: opts.anchor ? hub() as any : null,
      portMap: () => ({ asked: !!opts.mapPort, mapping: null, why: null }),
      addrs: () => [{ host: '192.168.1.5', port: opts.port, via: 'lan' as const }],
      links: () => [],
    }) as unknown as ShareHandle;
  };
  return new ShareHere({ port: 50997, settingFile, start, awake: () => ({ how: 'test', stop() {} }), netCategories: async () => null });
}

/** a hub with the counters the engine reads and caps the share sets */
function fakeHub(bytesPerDay = 5e9) {
  const caps = { bytesPerDay };
  return { on: () => () => {}, members: () => [], stats: () => ({ members: 0, streams: 0, bytesToday: {}, refusedToday: {}, removedToday: 0, since: 0 }), caps, capped: () => true, setCaps: (c: { bytesPerDay?: number }) => { if (c.bytesPerDay) caps.bytesPerDay = Math.floor(c.bytesPerDay); }, dialLocal: async () => { throw new Error('none'); }, close() {} };
}

const capA = (gb: number, from: number) => ({ do: 'cap', gb, from });
const card = (id: string, action: unknown, kind = 'suggest') => ({ id, kind, title: id, why: 'w', action });

test('brain/reject and brain/undo are the owner\'s: a guest gets 403, another origin gets 403, nothing changes', async () => {
  const cap = card('trust:anchor-cap', capA(10, 5));
  const eye = eyeSaying({ trust: [cap] });
  const engine = newEngine();
  const ui = await startUi({ port: 0, engine, eye, share: shareWith(() => fakeHub(), path.join(tmp(), 'anchor.json')), store: new ChatStore(path.join(tmp(), 'chats')), token: 'kula-' + 'cd'.repeat(20), lanHost: '::1' } as any);
  try {
    const { url } = await ui.invite.set(true);
    const j = await fetch(url!, { redirect: 'manual' });
    await j.text();
    const cookie = j.headers.get('set-cookie')!.split(';')[0];
    for (const r of ['brain/reject', 'brain/undo']) {
      const guest = await fetch(`http://[::1]:${ui.port}/${ui.prefix}/api/${r}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: `http://[::1]:${ui.port}`, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ id: cap.id, action: cap.action }) });
      assert.equal(guest.status, 403, `${r}: a guest`);
      const evil = await post(`${ui.url}api/${r}`, ui.port, { id: cap.id, action: cap.action }, { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' });
      assert.equal(evil.status, 403, `${r}: another origin`);
      const none = await post(`${ui.url}api/${r}`, ui.port, { id: cap.id, action: cap.action }, {});
      assert.equal(none.status, 403, `${r}: no origin`);
    }
    assert.ok(eye.view().cards.some((c) => c.id === cap.id), 'the card is still there: nothing was rejected');
  } finally { await ui.close(); eye.stop(); await engine.close(); }
});

test('brain/reject: a change card is turned down and stays hidden; a look card is 400, a changed one 409, a gone one 404', async () => {
  const load = { do: 'load', model: 'tiny', mode: 'apart', devices: ['p1'] };
  const say = { planner: [card('planner:split:tiny', load), card('planner:look', { do: 'probe', devices: ['p1'] })] };
  const eye = eyeSaying(say);
  const engine = newEngine();
  const ui = await startUi({ port: 0, engine, eye, share: shareWith(() => fakeHub(), path.join(tmp(), 'anchor.json')), store: new ChatStore(path.join(tmp(), 'chats')), token: 'kula-' + 'cd'.repeat(20) } as any);
  const reject = (body: unknown) => post(`${ui.url}api/brain/reject`, ui.port, body);
  try {
    const look = await reject({ id: 'planner:look', action: { do: 'probe', devices: ['p1'] } });
    assert.equal(look.status, 400, 'a card that only looks has no reject: × hides it');
    const other = await reject({ id: 'planner:split:tiny', action: { ...load, model: 'other' } });
    assert.equal(other.status, 409, 'another model is another card');
    assert.ok((await other.json()).view, 'the fresh view to draw again');
    assert.equal((await reject({ id: 'planner:split:tiny' })).status, 409, 'without the action seen: nothing rejected');
    const ok = await reject({ id: 'planner:split:tiny', action: load });
    assert.equal(ok.status, 200);
    const v = (await ok.json()).view;
    assert.ok(!v.cards.some((c: any) => c.id === 'planner:split:tiny'), 'hidden');
    assert.ok(v.events.some((e: any) => /you rejected/.test(e.text)), 'said in the feed');
    // its reason goes and comes back: still rejected (× would show it again)
    say.planner.splice(0, 1); eye.tick();
    say.planner.unshift(card('planner:split:tiny', load)); eye.tick();
    assert.ok(!eye.view().cards.some((c) => c.id === 'planner:split:tiny'), 'a rejection sticks');
    assert.equal((await reject({ id: 'planner:split:tiny', action: load })).status, 404, 'a rejected card is gone');
    assert.equal((await reject({ id: 'planner:nothing', action: load })).status, 404);
  } finally { await ui.close(); eye.stop(); await engine.close(); }
});

test('cap: a stale from is 409 and writes nothing; accept raises it, a second apply is 404; undo restores it; an undo after the cap moved is 409', async () => {
  const settingFile = path.join(tmp(), 'anchor.json');
  const hub = fakeHub(5e9);
  const share = shareWith(() => hub, settingFile);
  await share.setAnchor(true);
  const say = { trust: [card('trust:anchor-cap', capA(10, 4), 'warn')] };
  const eye = eyeSaying(say);
  const engine = newEngine();
  const ui = await startUi({ port: 0, engine, eye, share, store: new ChatStore(path.join(tmp(), 'chats')), token: 'kula-' + 'cd'.repeat(20) } as any);
  const apply = (body: unknown) => post(`${ui.url}api/brain/apply`, ui.port, body);
  const undo = (body: unknown) => post(`${ui.url}api/brain/undo`, ui.port, body);
  try {
    assert.equal(engine.anchor().capDay, 5e9);
    // the card saw 4 GB, the anchor holds 5: refused, nothing written
    const stale = await apply({ id: 'trust:anchor-cap', action: capA(10, 4) });
    assert.equal(stale.status, 409);
    assert.ok((await stale.json()).view);
    assert.equal(hub.caps.bytesPerDay, 5e9, 'the running anchor untouched');
    assert.equal(readAnchorSetting(settingFile).caps?.bytesPerDay, undefined, 'the setting untouched');
    assert.ok(eye.view().cards.some((c) => c.id === 'trust:anchor-cap'), 'the card stays');
    assert.equal((await undo({ id: 'trust:anchor-cap' })).status, 404, 'nothing to undo yet');

    // what the anchor holds: raised, kept, an undo for ten minutes
    say.trust[0] = card('trust:anchor-cap', capA(10, 5), 'warn'); eye.tick();
    const ok = await apply({ id: 'trust:anchor-cap', action: capA(10, 5) });
    assert.equal(ok.status, 200);
    const okv = await ok.json();
    assert.match(okv.word, /10 GB/);
    assert.equal(hub.caps.bytesPerDay, 10e9);
    assert.equal(readAnchorSetting(settingFile).caps?.bytesPerDay, 10e9);
    assert.equal(okv.view.undo?.id, 'trust:anchor-cap', 'the undo bar');
    assert.ok(!okv.view.cards.some((c: any) => c.id === 'trust:anchor-cap'), 'hidden once applied');
    assert.ok(okv.view.events.some((e: any) => /you accepted/.test(e.text)));
    assert.equal((await apply({ id: 'trust:anchor-cap', action: capA(10, 5) })).status, 404, 'a second apply finds no card');

    // undo: back to 5 GB, and it counts as a reject
    assert.equal((await undo({ id: 'trust:other' })).status, 409, 'an undo of another card than the bar\'s');
    const back = await undo({ id: 'trust:anchor-cap' });
    assert.equal(back.status, 200);
    const bv = await back.json();
    assert.equal(hub.caps.bytesPerDay, 5e9);
    assert.equal(readAnchorSetting(settingFile).caps?.bytesPerDay, 5e9);
    assert.equal(bv.view.undo, null);
    assert.ok(!bv.view.cards.some((c: any) => c.id === 'trust:anchor-cap'), 'an undone card does not bounce back');
    assert.equal((await undo({ id: 'trust:anchor-cap' })).status, 404, 'one undo only');

    // accepted, then the person set another cap by hand: the undo would undo theirs, so 409
    say.trust.push(card('trust:anchor-near-cap', capA(8, 5))); eye.tick();
    assert.equal((await apply({ id: 'trust:anchor-near-cap', action: capA(8, 5) })).status, 200);
    assert.equal(hub.caps.bytesPerDay, 8e9);
    assert.equal((await post(`${ui.url}api/share/anchor`, ui.port, { capGb: 7 })).status, 200);
    const moved = await undo({ id: 'trust:anchor-near-cap' });
    assert.equal(moved.status, 409);
    assert.equal(hub.caps.bytesPerDay, 7e9, 'the person\'s own cap stays');
    assert.equal(readAnchorSetting(settingFile).caps?.bytesPerDay, 7e9);

    // a cap card the anchor already holds: "already", nothing written, no undo
    say.trust.push(card('trust:same', capA(7, 7))); eye.tick();
    const same = await apply({ id: 'trust:same', action: capA(7, 7) });
    assert.equal(same.status, 200);
    const sv = await same.json();
    assert.match(sv.word, /already/);
    assert.equal(sv.view.undo, null);
  } finally { await ui.close(); eye.stop(); await engine.close(); }
});

test('anchor: no confirm is 400; a start that fails is 500, the switch goes back off and the card stays (RISK 2); then on, and undo turns it off', async () => {
  const settingFile = path.join(tmp(), 'anchor.json');
  const fail = { next: null as string | null };
  const share = shareWith(() => fakeHub(), settingFile, fail);
  const on = { do: 'anchor', on: true };
  const say = { connections: [card('connections:one-anchor', on)] };
  const eye = eyeSaying(say);
  const engine = newEngine();
  const ui = await startUi({ port: 0, engine, eye, share, store: new ChatStore(path.join(tmp(), 'chats')), token: 'kula-' + 'cd'.repeat(20) } as any);
  const apply = (body: unknown) => post(`${ui.url}api/brain/apply`, ui.port, body);
  try {
    const bare = await apply({ id: 'connections:one-anchor', action: on });
    assert.equal(bare.status, 400, 'confirm first');
    assert.equal((await apply({ id: 'connections:one-anchor', action: on, confirm: 'cap' })).status, 400, 'the confirm names the kind');
    assert.equal(share.view().anchor.on, false, 'nothing turned on');
    assert.equal(readAnchorSetting(settingFile).on, false);

    // the share cannot start (the port is taken): 500, the setting back off, the card still there
    fail.next = 'listen EADDRINUSE: address already in use';
    const broke = await apply({ id: 'connections:one-anchor', action: on, confirm: 'anchor' });
    assert.equal(broke.status, 500);
    assert.match((await broke.json()).error, /another program already uses the port/);
    assert.equal(readAnchorSetting(settingFile).on, false, 'a failed accept turns nothing on');
    assert.ok(eye.view().cards.some((c) => c.id === 'connections:one-anchor'), 'the card shows again');
    assert.equal(eye.view().undo, null);

    const ok = await apply({ id: 'connections:one-anchor', action: on, confirm: 'anchor' });
    assert.equal(ok.status, 200);
    const okv = await ok.json();
    assert.equal(share.view().anchor.live, true);
    assert.equal(readAnchorSetting(settingFile).on, true);
    assert.equal(okv.view.undo?.id, 'connections:one-anchor');

    // an anchor already on: a card that says "turn it on" is stale
    say.connections.push(card('connections:again', on)); eye.tick();
    assert.equal((await apply({ id: 'connections:again', action: on, confirm: 'anchor' })).status, 409);

    const back = await post(`${ui.url}api/brain/undo`, ui.port, { id: 'connections:one-anchor' });
    assert.equal(back.status, 200);
    assert.equal(share.view().anchor.on, false);
    assert.equal(readAnchorSetting(settingFile).on, false);
    assert.equal(share.view().on, false, 'sharing was off before the accept: undo puts it back off (verdict B1)');
  } finally { await ui.close(); eye.stop(); await engine.close(); }
});

test('anchor (verdict B1): a share that ran before stays running after a failed accept, and after the undo', async () => {
  const settingFile = path.join(tmp(), 'anchor.json');
  const fail = { next: null as string | null };
  const share = shareWith(() => fakeHub(), settingFile, fail);
  const on = { do: 'anchor', on: true };
  const say = { connections: [card('connections:one-anchor', on)] };
  const eye = eyeSaying(say);
  const engine = newEngine();
  const ui = await startUi({ port: 0, engine, eye, share, store: new ChatStore(path.join(tmp(), 'chats')), token: 'kula-' + 'cd'.repeat(20) } as any);
  const apply = (body: unknown) => post(`${ui.url}api/brain/apply`, ui.port, body);
  try {
    await share.start();
    assert.equal(share.view().on, true, 'sharing without the anchor');
    assert.equal(share.view().anchor.on, false);

    // the restart with the anchor cannot start: 500, the switch back off, and the share runs again
    fail.next = 'listen EADDRINUSE: address already in use';
    const broke = await apply({ id: 'connections:one-anchor', action: on, confirm: 'anchor' });
    assert.equal(broke.status, 500);
    assert.equal(readAnchorSetting(settingFile).on, false);
    assert.equal(share.view().anchor.on, false);
    assert.equal(share.view().on, true, 'a share that ran before the accept runs after it');

    // on, then undo: the anchor off, sharing still on as it was
    assert.equal((await apply({ id: 'connections:one-anchor', action: on, confirm: 'anchor' })).status, 200);
    assert.equal(share.view().anchor.live, true);
    const back = await post(`${ui.url}api/brain/undo`, ui.port, { id: 'connections:one-anchor' });
    assert.equal(back.status, 200);
    assert.equal(share.view().anchor.on, false);
    assert.equal(share.view().on, true, 'sharing was on before the accept: it stays on');
  } finally { await ui.close(); eye.stop(); await share.stop(); await engine.close(); }
});

test('cancel: confirm first; a waiting night project is cancelled, one that is not waiting is 409; no undo', async () => {
  const say: { review: unknown[] } = { review: [] };
  const eye = eyeSaying(say);
  const engine = newEngine();
  const ui = await startUi({ port: 0, engine, eye, share: shareWith(() => fakeHub(), path.join(tmp(), 'anchor.json')), store: new ChatStore(path.join(tmp(), 'chats')), token: 'kula-' + 'cd'.repeat(20) } as any);
  const apply = (body: unknown) => post(`${ui.url}api/brain/apply`, ui.port, body);
  try {
    const now = Date.now();
    const mk = async () => (await (await post(`${ui.url}api/projects/new`, ui.port, { request: 'sum up my notes', start: now + 3600_000, end: now + 7200_000, model: 'tiny', mode: 'here' })).json()).id as string;
    const p1 = await mk(), p2 = await mk();
    const c1 = card('review:send-private:' + p1, { do: 'cancel', project: p1 });
    const c2 = card('review:send-circle:' + p2, { do: 'cancel', project: p2 });
    say.review.push(c1, c2); eye.tick();
    assert.equal((await apply({ id: c1.id, action: c1.action })).status, 400, 'confirm first');
    assert.equal((await (await fetch(`${ui.url}api/projects`)).json()).filter((p: any) => p.state === 'waiting').length, 2, 'nothing cancelled');
    // the person cancelled p2 by hand: the card is stale
    assert.equal((await post(`${ui.url}api/projects/cancel`, ui.port, { id: p2 })).status, 200);
    assert.equal((await apply({ id: c2.id, action: c2.action, confirm: 'cancel' })).status, 409);
    const ok = await apply({ id: c1.id, action: c1.action, confirm: 'cancel' });
    assert.equal(ok.status, 200);
    const v = await ok.json();
    assert.equal(v.view.undo, null, 'a cancel has no undo');
    const ps = await (await fetch(`${ui.url}api/projects`)).json();
    assert.equal(ps.find((p: any) => p.id === p1).state, 'cancelled');
    assert.equal((await post(`${ui.url}api/brain/undo`, ui.port, { id: c1.id })).status, 404, 'nothing to undo');
  } finally { await ui.close(); eye.stop(); await engine.close(); }
});

test('load: undo puts back what was loaded; an undo after another model came is 409; a fetch has no undo', async () => {
  const engine = newEngine();
  const e = engine as any;
  const loads: any[] = [];
  let unloads = 0;
  const loadedAs = (model: string, mode: string) => ({ mode, model: { id: model, name: model, file: `${model}.gguf`, size: 1e9 }, ctx: 8192, devices: [{ id: 'local', name: 'mac', local: true, busy: false, tps: null, done: 0 }], since: 1 });
  e.load = async (req: any) => { loads.push(req); e.loaded = loadedAs(req.model, req.mode); return engine.status(); };
  e.unload = async () => { unloads++; e.loaded = null; };
  e.loaded = loadedAs('small', 'here');
  const big = { do: 'load', model: 'big', mode: 'here', devices: [] };
  const say = { models: [card('models:bigger:big', big)] };
  const eye = eyeSaying(say);
  const ui = await startUi({ port: 0, engine, eye, share: shareWith(() => fakeHub(), path.join(tmp(), 'anchor.json')), store: new ChatStore(path.join(tmp(), 'chats')), token: 'kula-' + 'cd'.repeat(20) } as any);
  const apply = (body: unknown) => post(`${ui.url}api/brain/apply`, ui.port, body);
  const undo = (body: unknown) => post(`${ui.url}api/brain/undo`, ui.port, body);
  try {
    assert.equal((await apply({ id: 'models:bigger:big', action: big })).status, 200);
    await sleep(20);
    assert.equal(engine.status().loaded?.model.id, 'big');
    const back = await undo({ id: 'models:bigger:big' });
    assert.equal(back.status, 200);
    await sleep(20);
    assert.equal(loads.length, 2);
    assert.deepEqual({ model: loads[1].model, mode: loads[1].mode, ctx: loads[1].ctx, peers: loads[1].peers, all: loads[1].all }, { model: 'small', mode: 'here', ctx: 8192, peers: [], all: true }, 'what was loaded before, as it was');
    assert.equal(engine.status().loaded?.model.id, 'small');

    // nothing loaded before: undo unloads
    e.loaded = null;
    say.models.push(card('models:pick:big', big)); eye.tick();
    assert.equal((await apply({ id: 'models:pick:big', action: big })).status, 200);
    await sleep(20);
    assert.equal((await undo({ id: 'models:pick:big' })).status, 200);
    assert.equal(unloads, 1);
    assert.equal(engine.status().loaded, null);

    // accepted, then the person loaded another model: the undo is 409, nothing runs
    say.models.push(card('models:tight:big', big)); eye.tick();
    assert.equal((await apply({ id: 'models:tight:big', action: big })).status, 200);
    await sleep(20);
    e.loaded = loadedAs('other', 'here');
    const n = loads.length;
    assert.equal((await undo({ id: 'models:tight:big' })).status, 409);
    assert.equal(loads.length, n);
    assert.equal(unloads, 1);
    assert.equal(engine.status().loaded?.model.id, 'other');

    // a fetch has no undo: the bar is gone with the next accept
    e.fetchModel = () => ({ started: true });
    const fetchA = { do: 'fetch', model: 'big' };
    say.models.push(card('models:fetch:big', fetchA)); eye.tick();
    const f = await apply({ id: 'models:fetch:big', action: fetchA });
    assert.equal(f.status, 200);
    assert.equal((await f.json()).view.undo, null);
  } finally { await ui.close(); eye.stop(); await engine.close(); }
});

// ---- RISK 1, on a real anchor: a friend's device cut today for its bytes dials again once a cap card is accepted

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

test('RISK 1: a friend\'s device cut today for its bytes is taken again on its next stream after a cap card is accepted', async () => {
  const echo = await echoServer();
  const gateOf = async (name: string, hub: InstanceType<typeof AnchorHub> | null, paired: InstanceType<typeof Paired>) => {
    const identity = hub ? anchorId : createIdentity(name);
    return { identity, gate: await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echo.port, tls: { identity, paired, pin: newPin(), onPinUsed: () => {} }, anchor: hub ?? undefined }) };
  };
  const dirA = tmp();
  const anchorId = createIdentity('anchor');
  const pairedA = new Paired(path.join(dirA, 'paired'));
  const hub = new AnchorHub({ self: anchorId.fp, isMember: circleMembers(pairedA, path.join(dirA, 'peers.json')), caps: { bytesPerDay: 100_000 } });
  const A = await gateOf('anchor', hub, pairedA);
  const pairedB = new Paired(path.join(tmp(), 'paired'));
  const B = await gateOf('mac-home', null, pairedB);
  const C = await gateOf('phone-far', null, new Paired(path.join(tmp(), 'paired')));
  pairedA.add(B.identity.fp);
  pairedA.add(C.identity.fp);
  pairedB.add(C.identity.fp);
  const ref = { host: '127.0.0.1', port: A.gate.port, fp: anchorId.fp };
  const mB = await joinAnchor({ anchor: ref, identity: B.identity, name: 'mac-home', kind: 'pc', gatePort: B.gate.port });
  const mC = await joinAnchor({ anchor: ref, identity: C.identity, name: 'phone-far', kind: 'phone', gatePort: C.gate.port });

  const settingFile = path.join(tmp(), 'anchor.json');
  const share = shareWith(() => hub, settingFile);
  await share.setAnchor(true);
  const raise = capA(0.01, 0.0001);   // 100 kB a day to 10 MB
  const eye = eyeSaying({ trust: [card('trust:anchor-cap', raise, 'warn')] });
  const engine = newEngine();
  const ui = await startUi({ port: 0, engine, eye, share, store: new ChatStore(path.join(tmp(), 'chats')), token: 'kula-' + 'cd'.repeat(20) } as any);
  try {
    // C passes its day's bytes: its stream is cut, its next one refused
    const d = await dialAnchor(ref, C.identity, B.identity.fp);
    const h = await handshake(d, '', 'api', 3000, undefined, { identity: C.identity, fp: B.identity.fp });
    h.socket.on('error', () => {});
    h.socket.on('data', () => {});
    const cut = new Promise<void>((r) => h.socket.once('close', () => r()));
    for (let i = 0; i < 40; i++) h.socket.write(randomBytes(10_000));
    await Promise.race([cut, sleep(3000).then(() => { throw new Error('the stream was not cut'); })]);
    await assert.rejects(dialAnchor(ref, C.identity, B.identity.fp), /byte limit/);
    assert.equal(engine.anchor().capDay, 100_000, 'the cap the card saw');

    // the person accepts the cap card: the very next stream is taken, no restart
    const ok = await post(`${ui.url}api/brain/apply`, ui.port, { id: 'trust:anchor-cap', action: raise });
    assert.equal(ok.status, 200);
    assert.equal(hub.caps.bytesPerDay, 10_000_000);
    const again = await dialAnchor(ref, C.identity, B.identity.fp);
    const h2 = await handshake(again, '', 'api', 3000, undefined, { identity: C.identity, fp: B.identity.fp });
    h2.socket.write('back');
    h2.socket.destroy();
  } finally {
    await ui.close(); eye.stop(); await engine.close();
    await mB.close(); await mC.close();
    for (const g of [A, B, C]) await g.gate.close();
    hub.close(); echo.close();
  }
});
