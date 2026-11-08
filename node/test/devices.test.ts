// One device, one row; found by itself on the wi-fi; paired by the phone scanning this computer
// (8.11.2026). The grouping and route rules (devices.ts) alone; then the engine with fake phones
// (the real gate with tls, a fake mdns browser, a fake adb): a cable record and a wi-fi record of
// one phone are one row whose way follows the cable; the background look adds a cable-paired
// phone's wi-fi by its certificate, pairs the phone that scanned this computer's qr (and only
// that one, once, before the code runs out); a night project says which way each device was
// reached; the page's routes hand out the qr as an image and never the code itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-devices-home-'));
process.env.KULA_NODE_HOME = HOME;

const { groupPeers, bestRoute, hostQr, parseHostQr, HOST_PIN_TTL_MS } = await import('../src/ui/devices.ts');
const { Engine } = await import('../src/ui/engine.ts');
const { startUi } = await import('../src/ui/server.ts');
const { ChatStore } = await import('../src/ui/store.ts');
const { ProjectRunner, ProjectStore } = await import('../src/ui/projects.ts');
const { startGateServer } = await import('../src/gate.ts');
const { createIdentity, Paired } = await import('../src/tls.ts');
const { writePeers, readPeers } = await import('../src/peers.ts');
type Peer = import('../src/peers.ts').Peer;

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const now = () => new Date().toISOString();
const FP_A = 'a1'.repeat(32);
const FP_B = 'b2'.repeat(32);
const rec = (o: Partial<Peer> & { id: string }): Peer => ({
  name: 'pixel', host: '192.168.1.20', port: 50551, secret: '', fp: FP_A, pin: null, relay: null, kind: 'phone', ram: null, bw: null, added_at: now(), ...o,
});

// the api channel's far end: the probe only needs the gate's handshake to pass
const sink = net.createServer((s) => { s.on('error', () => {}); s.resume(); });
await new Promise<void>((r) => sink.listen(0, '127.0.0.1', () => r()));
const sinkPort = (sink.address() as net.AddressInfo).port;
after(() => sink.close());

// a phone sharing: the real gate with tls; `trusts` are the computers it paired with before,
// `pin` a one-time code open on it (its own share screen's, or one it scanned from a qr)
async function phone(o: { pin?: string | null; trusts?: string[] } = {}) {
  const identity = createIdentity('phone');
  const paired = new Paired(null);
  for (const fp of o.trusts ?? []) paired.add(fp);
  const tls: { identity: typeof identity; paired: InstanceType<typeof Paired>; pin: string | null; pinExpiresAt?: number | null } = { identity, paired, pin: o.pin ?? null };
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: (ch) => (ch === 'api' ? sinkPort : null), tls });
  return { port: gate.port, fp: identity.fp, tls, close: () => gate.close() };
}

// a fake mdns browser that hears these announcements on every look
function mdns(list: () => { id?: string; name: string; port: number; kind?: string }[]) {
  return () => {
    const browser = Object.assign(new EventEmitter(), { services: [] as any[], stop() {}, start() {} });
    setTimeout(() => { for (const a of list()) browser.emit('up', { name: `kula ${a.name}`, port: a.port, addresses: ['127.0.0.1'], txt: { ...(a.id ? { id: a.id } : {}), name: a.name, kind: a.kind ?? 'phone', v: 'rpc7' } }); }, 5);
    return { find: () => browser as any, destroy: () => {} };
  };
}

// a fake adb: one phone, plugged in or not; its forward goes to `port`
function adb(serial: string, state: { plugged: boolean; port: number }) {
  return {
    present: true,
    devices: async () => (state.plugged ? [{ serial, state: 'device', model: 'Pixel_8', usb: true }] : []),
    installed: async () => true,
    forward: async () => ({ port: state.port, made: false }),
    openShare: async () => {},
    close: async () => {},
  } as any;
}

let n = 0;
function engine(extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(HOME, 'e-'));
  const peersFile = path.join(dir, 'peers.json');
  const identity = createIdentity('mac');
  const e = new Engine({ peersFile, identity, llama: null, probeMs: 1500, statusMs: 150, discoverMs: 60, peekMs: 1500, hostId: `host-${++n}`, ...extra });
  return { e, peersFile, identity };
}

// ---------- the rules

test('records with one certificate (or one worker id) are one device; the cable is used while plugged in, else the wi-fi', () => {
  const cable = rec({ id: 'cable:R3C', host: '127.0.0.1', port: 41000, cable: { serial: 'R3C' } });
  const wifi = rec({ id: 'w-1', wid: 'w-1' });
  const other = rec({ id: '192.168.1.30:50551', host: '192.168.1.30', fp: FP_B, name: 'tab' });
  const old = rec({ id: 'old', fp: '', secret: 'cd'.repeat(16), name: 'old' });
  const viaWid = rec({ id: 'relay:123456', fp: null, wid: 'w-1', relay: { url: 'wss://r.example', code: '123456' } });
  const groups = groupPeers([cable, other, wifi, old, viaWid]);
  assert.deepEqual(groups.map((g) => g.map((p) => p.id)), [['cable:R3C', 'w-1', 'relay:123456'], ['192.168.1.30:50551'], ['old']]);

  const g = groups[0];
  const st = (m: Record<string, { plugged?: boolean | null; ok?: boolean | null }>) => (p: Peer) => ({ plugged: m[p.id]?.plugged ?? null, ok: m[p.id]?.ok ?? null, at: null });
  assert.equal(bestRoute(g, st({ 'cable:R3C': { plugged: true } })).id, 'cable:R3C');
  assert.equal(bestRoute(g, st({ 'cable:R3C': { plugged: false }, 'w-1': { ok: false } })).id, 'w-1', 'unplugged: the wi-fi, even before it answered');
  assert.equal(bestRoute(g, st({ 'cable:R3C': { plugged: true, ok: false }, 'w-1': { ok: true } })).id, 'w-1', 'plugged but the cable failed while the wi-fi answers');
  assert.equal(bestRoute([cable, viaWid], st({ 'cable:R3C': { plugged: false } })).id, 'relay:123456');
  assert.equal(bestRoute([cable], st({ 'cable:R3C': { plugged: false } })).id, 'cable:R3C', 'only a cable: it, unplugged');
});

test('the host qr: kula-host v1 with this computer\'s certificate and a 16 hex one-time code; the phone\'s reading refuses an expired or odd one', () => {
  const at = Date.UTC(2026, 10, 8, 21, 0);
  const q = hostQr({ id: 'h1', name: 'studio mac', fp: FP_A.toUpperCase(), pin: '0123456789abcdef', exp: at + HOST_PIN_TTL_MS });
  assert.deepEqual(Object.keys(q), ['k', 'v', 'id', 'name', 'fp', 'pin', 'exp']);
  assert.equal(q.fp, FP_A);
  const back = parseHostQr(JSON.stringify(q), at);
  assert.deepEqual(back, q);
  assert.throws(() => parseHostQr(JSON.stringify(q), at + HOST_PIN_TTL_MS), /expired/);
  assert.throws(() => parseHostQr(JSON.stringify({ ...q, k: 'kula-peer' }), at), /kula-host/);
  assert.throws(() => parseHostQr(JSON.stringify({ ...q, pin: '0123' }), at), /pin/);
  assert.throws(() => parseHostQr(JSON.stringify({ ...q, v: 2 }), at), /version/);
});

// ---------- one device, one row

test('a phone on the cable and on the wi-fi is one row with both ways; unplugged it talks over the wi-fi; rename and forget take both', async () => {
  const mac = createIdentity('mac');
  const p = await phone({ trusts: [mac.fp] });
  const cable = { plugged: true, port: p.port };
  const { e, peersFile } = engine({ identity: mac, adb: adb('R3C', cable) });
  writePeers([
    rec({ id: 'cable:R3C', name: 'Pixel_8', host: '127.0.0.1', port: p.port, fp: p.fp, cable: { serial: 'R3C' } }),
    rec({ id: '127.0.0.1:1', name: 'my phone', host: '127.0.0.1', port: p.port, fp: p.fp }),
    rec({ id: 'tab', name: 'tab', host: '127.0.0.1', port: 9, fp: FP_B }),
  ], peersFile);

  let rows = await e.probe(['cable:R3C']);
  assert.equal(rows.length, 2, 'one row per device');
  const row = rows.find((r) => r.id === 'cable:R3C')!;
  assert.deepEqual(row.routes, ['cable:R3C', '127.0.0.1:1']);
  assert.equal(row.via, 'cable');
  assert.equal(row.ways.cable?.ok, true);
  assert.equal(row.ways.cable?.plugged, true);
  assert.equal(row.ways.wifi?.ok, true);
  assert.equal(row.reach?.ok, true);
  assert.equal(row.where, 'usb cable');

  // the cable pulled: the same row, over the wi-fi
  cable.plugged = false;
  rows = await e.probe();
  const off = rows.find((r) => r.id === 'cable:R3C')!;
  assert.equal(off.via, 'wifi');
  assert.equal(off.ways.cable?.plugged, false);
  assert.equal(off.reach?.ok, true);
  assert.equal(off.where, `127.0.0.1:${p.port}`);

  // a night project reaches it over the wi-fi and says so
  const woke = await e.wake(['cable:R3C']);
  assert.deepEqual(woke, [{ id: 'cable:R3C', name: off.name, via: 'wifi', where: `127.0.0.1:${p.port}`, why: null }]);

  // rename names both records; forget forgets both (and not the tab)
  assert.equal(e.renamePeer('127.0.0.1:1', 'kitchen phone'), true);
  assert.deepEqual(readPeers(peersFile).filter((x) => x.fp === p.fp).map((x) => [x.name, x.named]), [['kitchen phone', true], ['kitchen phone', true]]);
  assert.equal(e.peers().find((r) => r.id === 'cable:R3C')!.name, 'kitchen phone');
  assert.equal(e.removePeer('cable:R3C'), true);
  assert.deepEqual(readPeers(peersFile).map((x) => x.id), ['tab']);
  await e.close();
  await p.close();
});

test('the background look: a cable-paired phone heard on the wi-fi gets its wi-fi way by its certificate, and shows ready with no click', async () => {
  const mac = createIdentity('mac');
  const p = await phone({ trusts: [mac.fp] });
  const stranger = await phone({ trusts: [] });
  const { e, peersFile } = engine({ identity: mac, adb: adb('R3C', { plugged: false, port: 1 }), bonjour: mdns(() => [{ id: 'w-77', name: 'pixel', port: p.port }, { id: 'w-99', name: 'someone', port: stranger.port }]) });
  writePeers([rec({ id: 'cable:R3C', name: 'Pixel_8', host: '127.0.0.1', port: 1, fp: p.fp, cable: { serial: 'R3C' } })], peersFile);

  const v = await e.look();
  const saved = readPeers(peersFile);
  assert.equal(saved.length, 2);
  assert.ok(saved.every((x) => x.wid === 'w-77'), 'the worker id is noted on both records');
  assert.deepEqual([saved[1].id, saved[1].host, saved[1].port, saved[1].fp, saved[1].cable ?? null, saved[1].name], ['w-77', '127.0.0.1', p.port, p.fp, null, 'Pixel_8']);
  const rows = e.peers();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].routes, ['cable:R3C', 'w-77']);
  assert.equal(rows[0].via, 'wifi');
  assert.equal(rows[0].ways.wifi?.ok, true);
  assert.ok(rows[0].heardAt);
  const mine = v.list.find((r) => r.port === p.port)!;
  assert.deepEqual([mine.state, mine.peer], ['ready', 'cable:R3C']);
  const other = v.list.find((r) => r.port === stranger.port)!;
  assert.deepEqual([other.state, other.peer], ['new', null], 'a kula phone that does not know this computer: nearby, not paired');
  assert.ok(e.status().decisions.some((d) => /reachable both ways/.test(d.text)));
  await e.close();
  await p.close();
  await stranger.close();
});

// ---------- the phone scans this computer

test('the phone that scanned this computer\'s qr pairs by itself on the next look; another phone with its own code is left alone; the code works once', async () => {
  const mac = createIdentity('mac');
  const scanner = await phone();
  const own = await phone({ pin: 'fedcba9876543210' });   // a phone showing its own share code
  const late = await phone();
  let heard = [{ id: 'w-own', name: 'other', port: own.port }, { id: 'w-1', name: 'pixel', port: scanner.port }];
  const { e, peersFile } = engine({ identity: mac, bonjour: mdns(() => heard) });

  // nothing is tried while no qr is up
  let v = await e.look();
  assert.deepEqual(v.list.map((r) => r.state), ['code', 'new']);
  assert.equal(readPeers(peersFile).length, 0);

  const view = e.openHostPair();
  assert.equal(view.open, true);
  assert.ok(view.left > HOST_PIN_TTL_MS - 5000 && view.left <= HOST_PIN_TTL_MS);
  const q = parseHostQr(e.hostPairPayload()!);
  assert.equal(q.fp, mac.fp);
  assert.equal(q.id, `host-${n}`);
  assert.ok(!JSON.stringify(e.hostPair()).includes(q.pin), 'the view never carries the code');

  // the phone scans: the qr's code becomes its gate's one-time code until the qr's expiry
  scanner.tls.pin = q.pin;
  scanner.tls.pinExpiresAt = Date.now() + HOST_PIN_TTL_MS;
  v = await e.look();
  const saved = readPeers(peersFile);
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].id, saved[0].wid, saved[0].fp, saved[0].pin, saved[0].port], ['w-1', 'w-1', scanner.fp, null, scanner.port]);
  assert.ok(scanner.tls.paired.has(mac.fp), 'the phone keeps this computer');
  assert.equal(scanner.tls.pin, null, 'its code is spent');
  assert.equal(own.tls.pin, 'fedcba9876543210', 'the other phone\'s own code is untouched');
  assert.ok(!own.tls.paired.has(mac.fp));
  assert.deepEqual(v.list.map((r) => [r.port, r.state]), [[own.port, 'code'], [scanner.port, 'ready']]);
  assert.deepEqual(e.hostPair().paired, { id: 'w-1', name: 'pixel' });
  assert.equal(e.hostPair().open, false);
  assert.equal(e.hostPairPayload(), null);

  // single use: another phone that read the same qr (a photo of it) does not pair
  late.tls.pin = q.pin;
  heard = [...heard, { id: 'w-late', name: 'late', port: late.port }];
  v = await e.look();
  assert.equal(readPeers(peersFile).length, 1);
  assert.equal(v.list.find((r) => r.port === late.port)!.state, 'code');
  await assert.rejects(e.pairNearby({ address: `127.0.0.1:${late.port}` }), /qr first/);
  await e.close();
  await Promise.all([scanner.close(), own.close(), late.close()]);
});

test('a qr\'s code runs out after ten minutes; a new qr is a new code and the old one is dead', async () => {
  const mac = createIdentity('mac');
  let clock = Date.UTC(2026, 10, 8, 22, 0);
  const p = await phone();
  const { e, peersFile } = engine({ identity: mac, now: () => clock, bonjour: mdns(() => [{ id: 'w-2', name: 'pixel', port: p.port }]) });
  e.openHostPair();
  const first = parseHostQr(e.hostPairPayload()!, clock);
  assert.equal(first.exp, clock + HOST_PIN_TTL_MS);
  e.openHostPair();
  const second = parseHostQr(e.hostPairPayload()!, clock);
  assert.notEqual(second.pin, first.pin);

  // the phone scanned the first one: the computer only holds the second code now
  p.tls.pin = first.pin;
  await e.look();
  assert.equal(readPeers(peersFile).length, 0);

  // ten minutes on: nothing is tried, the view says so
  p.tls.pin = second.pin;
  clock += HOST_PIN_TTL_MS;
  assert.equal(e.hostPairPayload(), null);
  assert.deepEqual([e.hostPair().open, e.hostPair().expired], [false, true]);
  await e.look();
  assert.equal(readPeers(peersFile).length, 0);
  assert.equal(p.tls.pin, second.pin, 'no attempt reached the phone');

  // typed address, open qr: pairs at once (a wi-fi where mdns does not carry)
  e.openHostPair();
  p.tls.pin = parseHostQr(e.hostPairPayload()!, clock).pin;
  const row = await e.pairNearby({ address: `127.0.0.1:${p.port}` });
  assert.equal(row.ways.wifi?.ok, true);
  assert.equal(readPeers(peersFile)[0].fp, p.fp);
  await e.close();
  await p.close();
});

// ---------- the page's routes

test('the page: GET hostpair says how long, the qr comes only as an svg image, a new one on POST; GET nearby and peers carry no code', async () => {
  const { e } = engine();
  const ui = await startUi({ port: 0, engine: e, store: new ChatStore(path.join(HOME, 'chats-dev')), token: 'kula-' + 'cd'.repeat(20), eye: false });
  const api = (p: string) => `${ui.url}api/${p}`;
  const post = (p: string, body: unknown = {}) => fetch(api(p), { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${ui.port}`, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) });
  assert.equal((await fetch(api('hostpair.svg'))).status, 404, 'no qr before one is asked for');
  const opened = await (await post('hostpair/new')).json();
  assert.equal(opened.open, true);
  const pin = JSON.parse(e.hostPairPayload()!).pin;
  const svg = await fetch(api('hostpair.svg'));
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(await svg.text(), /^<svg /);
  for (const r of ['hostpair', 'nearby', 'peers']) assert.ok(!(await (await fetch(api(r))).text()).includes(pin), r);
  // a post from elsewhere cannot open one
  assert.equal((await fetch(api('hostpair/new'), { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await (await post('hostpair/close')).json()).open, false);
  assert.equal((await fetch(api('hostpair.svg'))).status, 404);
  await ui.close();
  await e.close();
});

// ---------- night projects

test('a night project says in its chat which way each device was reached', async () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'pj-'));
  let clock = Date.UTC(2026, 10, 8, 22, 0);
  const chats = new ChatStore(path.join(dir, 'chats'));
  const woke: string[][] = [];
  const eng = {
    async load() { return {}; },
    async chat(_m: unknown, onToken: (t: string) => void) { onToken('1. a\n2. b'); return { text: '1. a\n2. b', device: 'pixel', tokens: 3, tps: 9, ms: 10, firstMs: 1 }; },
    async unload() {},
    peers: () => [],
    status: () => ({ loading: null }),
    async wake(ids: string[]) {
      woke.push(ids);
      return [
        { id: 'w-1', name: 'pixel', via: 'wifi' as const, where: '192.168.1.20:50551', why: null },
        { id: 'cable:R3C', name: 'tab', via: 'cable' as const, where: null, why: null },
        { id: 'old', name: 'old phone', via: null, where: null, why: 'wi-fi: no answer' },
      ];
    },
  };
  const r = new ProjectRunner(eng, chats, new ProjectStore(path.join(dir, 'projects.json')), { now: () => clock, awake: false });
  const p = r.create({ request: 'tides', start: clock + 60_000, end: clock + 3 * 3600_000, model: 'm', mode: 'apart', peers: ['w-1', 'cable:R3C', 'old'] });
  clock += 61_000;
  await r.tick();
  assert.deepEqual(woke, [['w-1', 'cable:R3C', 'old']]);
  const msgs = chats.get(p.chatId)!.messages.map((m) => m.content);
  assert.ok(msgs.includes('reached pixel over wi-fi (192.168.1.20:50551), tab on the usb cable, old phone not reached (wi-fi: no answer).'), msgs.join('\n'));
  assert.equal(r.get(p.id)!.state, 'done');
});

test('while the page is open the engine looks by itself; when the page goes quiet it stops', async () => {
  let looks = 0;
  const hear = mdns(() => []);
  const { e } = engine({ watch: true, lookMs: 40, watchIdleMs: 300, bonjour: () => { looks++; return hear(); } });
  assert.equal(e.nearby().at, null);
  // the page asks something every 50 ms (it polls status and nearby)
  const until = Date.now() + 3000;
  while (looks < 3 && Date.now() < until) { e.touch(); await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(looks >= 3, `looked ${looks} times`);
  assert.ok(e.nearby().at);
  await new Promise((r) => setTimeout(r, 600));
  const settled = looks;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(looks, settled, 'no page, no looking');
  await e.close();
  // tests and other callers: off unless asked for
  const quiet = engine({ bonjour: () => { looks++; return hear(); } });
  quiet.e.touch();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(looks, settled);
  await quiet.e.close();
});
