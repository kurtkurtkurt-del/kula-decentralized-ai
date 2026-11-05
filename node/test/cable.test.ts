// Phones on a usb cable (src/ui/cable.ts, the engine's cable flow, the page's api): adb's
// output parsed, adb found or missing, then the whole thing against a fake adb on PATH and a
// fake phone (the real worker api behind the real tls gate with a one-time code) that only
// answers once its share screen was opened: use → waiting → code → paired; a model loaded on
// it in phone mode; use again without a code; unplugged; plugged in again on another port.
// No code and no secret ever comes back in a response.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-cable-home-'));
process.env.KULA_NODE_HOME = HOME;

const { parseDevices, parseForwards, parseForwardPort, findAdb, Adb, stateHelp, NO_ADB_HELP, UNAUTHORIZED_HELP, SHARE_LINK } = await import('../src/ui/cable.ts');
const { Engine } = await import('../src/ui/engine.ts');
const { startUi } = await import('../src/ui/server.ts');
const { ChatStore } = await import('../src/ui/store.ts');
const { startApiServer } = await import('../src/api.ts');
const { startGateServer, peekGate } = await import('../src/gate.ts');
const { createIdentity, Paired } = await import('../src/tls.ts');
const { serveModel } = await import('../src/modelserve.ts');
const { readPeers } = await import('../src/peers.ts');

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const PIN = '0123456789abcdef';
const SERIAL = 'R3CY10FLZLB';
const DEV_LINE = `${SERIAL}            device usb:1-1 product:e2sxxx model:SM_S936B device:e2s transport_id:3`;

// ---------- adb's words

test('adb devices -l: ready, unauthorized, offline, none, and the daemon lines', () => {
  const out = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    DEV_LINE,
    '0123456789ABCDEF       unauthorized usb:1-2 transport_id:4',
    'emulator-5554          offline transport_id:5',
    '192.168.1.30:5555      device product:x model:Pixel_8 device:shiba transport_id:6',
    'ZY22                   no permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html] usb:1-3 transport_id:7',
    '',
  ].join('\n');
  const list = parseDevices(out);
  assert.deepEqual(list.map((d) => [d.serial, d.state, d.model, d.usb]), [
    [SERIAL, 'device', 'SM S936B', true],
    ['0123456789ABCDEF', 'unauthorized', null, true],
    ['emulator-5554', 'offline', null, true],
    ['192.168.1.30:5555', 'device', 'Pixel 8', false],
    ['ZY22', 'no permissions', null, true],
  ]);
  assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
  assert.deepEqual(parseDevices(''), []);
  assert.equal(stateHelp('device'), null);
  assert.equal(stateHelp('unauthorized'), UNAUTHORIZED_HELP);
  assert.match(stateHelp('unauthorized')!, /allow USB debugging/);
  assert.match(stateHelp('offline')!, /unplug/);
  assert.match(stateHelp('no permissions')!, /udev/);
});

test('adb forward: the port it picked, and the list', () => {
  assert.equal(parseForwardPort('54321\n'), 54321);
  assert.equal(parseForwardPort('\n  50551  \n'), 50551);
  assert.throws(() => parseForwardPort('error: device offline\n'), /did not say which port/);
  assert.throws(() => parseForwardPort('99999\n'), /did not say/);
  assert.deepEqual(parseForwards(`${SERIAL} tcp:50551 tcp:50551\nemulator-5554 tcp:6100 localabstract:x\n\n`), [
    { serial: SERIAL, local: 50551, remote: 'tcp:50551' },
    { serial: 'emulator-5554', local: 6100, remote: 'localabstract:x' },
  ]);
});

test('adb is looked for on PATH, then in the sdk of each system', () => {
  const has = (want: string) => (f: string) => f === want;
  assert.equal(findAdb({ PATH: '/opt/a:/opt/b' }, 'linux', has('/opt/b/adb')), '/opt/b/adb');
  assert.equal(findAdb({ PATH: '', ANDROID_HOME: '/sdk' }, 'linux', has('/sdk/platform-tools/adb')), '/sdk/platform-tools/adb');
  assert.equal(findAdb({ PATH: '', HOME: '/Users/me' }, 'darwin', has('/Users/me/Library/Android/sdk/platform-tools/adb')), '/Users/me/Library/Android/sdk/platform-tools/adb');
  assert.equal(findAdb({ PATH: '', HOME: '/home/me' }, 'linux', has('/home/me/Android/Sdk/platform-tools/adb')), '/home/me/Android/Sdk/platform-tools/adb');
  const win = path.join('C:\\Users\\me\\AppData\\Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
  assert.equal(findAdb({ Path: '', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', has(win)), win);
  assert.equal(findAdb({ PATH: '/x', HOME: '/nowhere' }, 'darwin', () => false), null);
});

test('no adb: the cable section says where platform-tools come from and that usb debugging must be on', async () => {
  const empty = fs.mkdtempSync(path.join(HOME, 'noadb-'));
  const adb = new Adb({ env: { PATH: empty, HOME: empty } });
  assert.equal(adb.present, false);
  await assert.rejects(adb.devices(), /platform-tools/);
  const engine = new Engine({ peersFile: path.join(empty, 'peers.json'), identity: createIdentity('mac'), llama: null, adb });
  const view = await engine.cable();
  assert.equal(view.adb, false);
  assert.equal(view.help, NO_ADB_HELP);
  assert.match(view.help!, /developer\.android\.com\/tools\/releases\/platform-tools/);
  assert.match(view.help!, /USB debugging/);
  assert.deepEqual(view.devices, []);
  assert.throws(() => engine.useCable('bad serial; rm -rf /'), /bad serial/);
});

// ---------- a fake adb on PATH

interface AdbState { devices: string[]; forwards: { serial: string; local: number; remote: string }[]; nextPort: number; installed: boolean; sharing: boolean; opened: string[]; calls: string[] }

function fakeAdb(init: Partial<AdbState>) {
  const dir = fs.mkdtempSync(path.join(HOME, 'adb-'));
  const stateFile = path.join(dir, 'state.json');
  const st: AdbState = { devices: [], forwards: [], nextPort: 0, installed: true, sharing: false, opened: [], calls: [], ...init };
  fs.writeFileSync(stateFile, JSON.stringify(st));
  const script = `#!${process.execPath}
const fs = require('fs');
const f = process.env.FAKE_ADB_STATE;
const st = JSON.parse(fs.readFileSync(f, 'utf8'));
const a = process.argv.slice(2);
st.calls.push(a.join(' '));
let serial = null;
if (a[0] === '-s') { serial = a[1]; a.splice(0, 2); }
const out = (s) => { fs.writeFileSync(f, JSON.stringify(st)); process.stdout.write(s); process.exit(0); };
if (a[0] === 'devices') out('List of devices attached\\n' + st.devices.map((d) => d + '\\n').join('') + '\\n');
if (a[0] === 'forward' && a[1] === '--list') out(st.forwards.map((x) => x.serial + ' tcp:' + x.local + ' ' + x.remote + '\\n').join(''));
if (a[0] === 'forward' && a[1] === '--remove') { st.forwards = st.forwards.filter((x) => !(x.serial === serial && 'tcp:' + x.local === a[2])); out(''); }
if (a[0] === 'forward' && a[1] === 'tcp:0') { st.forwards.push({ serial, local: st.nextPort, remote: a[2] }); out(st.nextPort + '\\n'); }
if (a[0] === 'shell' && a[1] === 'pm') out(st.installed ? 'package:app.pasaport.android.beta\\npackage:app.pasaport.android\\n' : 'package:app.pasaport.android.beta\\n');
if (a[0] === 'shell' && a[1] === 'am') { st.opened.push(a.slice(2).join(' ')); st.sharing = true; out('Starting: Intent { act=android.intent.action.VIEW }\\n'); }
fs.writeFileSync(f, JSON.stringify(st));
process.stderr.write('error: what is ' + a.join(' ') + '\\n');
process.exit(1);
`;
  fs.writeFileSync(path.join(dir, 'adb'), script, { mode: 0o755 });
  const env = { PATH: dir, HOME: dir, FAKE_ADB_STATE: stateFile };
  return {
    adb: new Adb({ env }),
    read: (): AdbState => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    set: (p: Partial<AdbState>) => { const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8')); fs.writeFileSync(stateFile, JSON.stringify({ ...cur, ...p })); },
  };
}

// what adb's forward does: a port on 127.0.0.1 that pipes to the phone, and closes at once
// when nothing listens there (here: until the share screen was opened)
async function forwardPort(target: () => number | null) {
  const server = net.createServer((sock) => {
    const port = target();
    if (!port) { sock.destroy(); return; }
    const up = net.connect(port, '127.0.0.1');
    sock.pipe(up); up.pipe(sock);
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => { server.close(() => r()); }) };
}

function fakeLlama(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi from the cable' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`);
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

async function fakePhone() {
  const models = fs.mkdtempSync(path.join(HOME, 'phone-'));
  const llama = await fakeLlama();
  const api = await startApiServer({ models, llama: null, allowPrivateUrls: true, startBackend: async () => ({ port: llama.port, stop: async () => {} }) });
  const identity = createIdentity('phone');
  const tls = { identity, paired: new Paired(null), pin: PIN as string | null, onPinUsed: () => { tls.pin = 'fedcba9876543210'; } };
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: (ch) => (ch === 'api' ? api.port : null), tls });
  return { port: gate.port, fp: identity.fp, tls, close: async () => { await gate.close(); await api.close(); llama.close(); } };
}

async function tinyModel() {
  const dir = fs.mkdtempSync(path.join(HOME, 'model-'));
  const file = path.join(dir, 'tiny-q8_0.gguf');
  const bytes = randomBytes(120_000);
  fs.writeFileSync(file, bytes);
  const served = await serveModel(file, '127.0.0.1', '127.0.0.1');
  const entry = {
    id: 'tiny', name: 'Tiny 0.1B', family: 'tiny', params_b: 0.1, quant: 'Q8_0', repo: 'x/y', file: 'tiny-q8_0.gguf', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), license: 'mit', ctx_max: 8192, kv_mb_per_1k: 8, blurb: 'a test model', good: '', url: served.url,
  };
  return { entry, close: () => served.close() };
}

const origin = (port: number) => ({ origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
async function post(ui: { url: string; port: number }, route: string, body: unknown) {
  const r = await fetch(`${ui.url}api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...origin(ui.port) }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}
async function get(ui: { url: string }, route: string) {
  return (await fetch(`${ui.url}api/${route}`)).text();
}
// every body the page got: the code and the gate's secret are in none of them
const bodies: string[] = [];
const seen = (t: string) => { bodies.push(t); return JSON.parse(t); };

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    assert.ok(Date.now() - t0 < ms, `timed out: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

test('a phone on the cable: use, the share screen opened, the code, paired, loaded; again without a code; unplugged; plugged in again', async () => {
  const phone = await fakePhone();
  const model = await tinyModel();
  let fake!: ReturnType<typeof fakeAdb>;
  const fwd = await forwardPort(() => (fake.read().sharing ? phone.port : null));
  fake = fakeAdb({ devices: [DEV_LINE, '0123456789ABCDEF       unauthorized usb:1-2 transport_id:4'], nextPort: fwd.port });
  const dir = fs.mkdtempSync(path.join(HOME, 'engine-'));
  const peersFile = path.join(dir, 'peers.json');
  const engine = new Engine({ peersFile, modelDirs: [path.join(dir, 'models')], identity: createIdentity('mac'), llama: null, probeMs: 1500, catalog: [model.entry], adb: fake.adb, cablePollMs: 50, cableWaitMs: 5000 });
  const ui = await startUi({ port: 0, engine, store: new ChatStore(path.join(dir, 'chats')), token: 'kula-' + 'ab'.repeat(20) });
  try {
    // the list: the ready phone with its model name and kula on it, the other one asking to allow
    let view = seen(await get(ui, 'cable'));
    assert.equal(view.adb, true);
    assert.equal(view.devices.length, 2);
    const s25 = view.devices.find((d: any) => d.serial === SERIAL);
    assert.equal(s25.name, 'SM S936B');
    assert.equal(s25.state, 'device');
    assert.equal(s25.installed, true);
    assert.equal(s25.peer, null);
    const other = view.devices.find((d: any) => d.serial === '0123456789ABCDEF');
    assert.equal(other.state, 'unauthorized');
    assert.match(other.help, /allow USB debugging/);
    // the unauthorized one cannot be used
    assert.equal(seen((await post(ui, 'cable/use', { serial: '0123456789ABCDEF' })).text).busy, true);
    const no = await engine.cableSettled('0123456789ABCDEF');
    assert.equal(no!.step, 'error');
    assert.match(no!.error!, /allow USB debugging/);

    // use: forwarded, nothing answers, the share screen opened with start=1, then the code
    const started = await post(ui, 'cable/use', { serial: SERIAL });
    assert.equal(started.status, 200, started.text);
    view = await until(async () => seen(await get(ui, 'cable')), (v: any) => v.devices.find((d: any) => d.serial === SERIAL).job?.step === 'code');
    const job = view.devices.find((d: any) => d.serial === SERIAL).job;
    assert.equal(job.needCode, true);
    assert.ok(job.lines.some((l: string) => /forwarding/.test(l)), JSON.stringify(job.lines));
    assert.ok(job.lines.some((l: string) => /waiting for the phone to share/.test(l)), JSON.stringify(job.lines));
    const st = fake.read();
    assert.deepEqual(st.opened, [`start -a android.intent.action.VIEW -d '${SHARE_LINK}' app.pasaport.android`]);
    assert.ok(st.calls.includes(`-s ${SERIAL} forward tcp:0 tcp:50551`), st.calls.join('\n'));

    // a wrong code: refused, still waiting for the right one
    const wrong = await post(ui, 'cable/pair', { serial: SERIAL, code: 'ffffffffffffffff' });
    assert.equal(wrong.status, 400);
    assert.match(JSON.parse(wrong.text).error, /wrong pin/);
    // the code from the share screen: paired, kept as a cable peer
    const paired = await post(ui, 'cable/pair', { serial: SERIAL, code: PIN.toUpperCase().replace(/(.{4})/g, '$1 ') });
    assert.equal(paired.status, 200, paired.text);
    const pr = seen(paired.text);
    assert.equal(pr.job.step, 'paired');
    assert.equal(pr.peer.id, `cable:${SERIAL}`);
    assert.equal(pr.peer.name, 'SM S936B');
    assert.equal(pr.peer.where, 'usb cable');
    assert.equal(pr.peer.tls, true);
    assert.equal(pr.peer.cable.serial, SERIAL);
    const book = readPeers(peersFile);
    assert.equal(book.length, 1);
    assert.equal(book[0].fp, phone.fp);
    assert.equal(book[0].pin, null);
    assert.equal(book[0].host, '127.0.0.1');
    assert.equal(book[0].port, fwd.port);
    assert.deepEqual(book[0].cable, { serial: SERIAL });
    view = seen(await get(ui, 'cable'));
    assert.deepEqual(view.devices.find((d: any) => d.serial === SERIAL).peer, { id: `cable:${SERIAL}`, name: 'SM S936B' });

    // "load" in phone mode works as for any phone
    const load = await fetch(`${ui.url}api/load`, { method: 'POST', headers: { 'content-type': 'application/json', ...origin(ui.port) }, body: JSON.stringify({ model: 'tiny', mode: 'phone', peers: [`cable:${SERIAL}`] }) });
    const events = (await load.text()).split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
    assert.equal(events.at(-1).done, true, JSON.stringify(events.at(-1)));
    assert.equal(events.at(-1).status.loaded.devices[0].name, 'SM S936B');
    let answer = '';
    await engine.chat([{ role: 'user', content: 'hello' }], (t) => { answer += t; });
    assert.equal(answer, 'hi from the cable');
    await engine.unload();

    // use again: the phone knows this computer, no code
    fake.set({ opened: [] });
    seen((await post(ui, 'cable/use', { serial: SERIAL })).text);
    const again = await engine.cableSettled(SERIAL);
    assert.equal(again!.step, 'paired', JSON.stringify(again));
    assert.equal(again!.needCode, false);
    assert.deepEqual(fake.read().opened, [], 'already sharing: the share screen is not opened again');

    // unplugged: adb no longer lists it and drops its forwards
    fake.set({ devices: [], forwards: [] });
    await new Promise((r) => setTimeout(r, 1600));
    view = seen(await get(ui, 'cable'));
    assert.deepEqual(view.devices.map((d: any) => [d.serial, d.state]), [[SERIAL, 'unplugged']]);
    const peers = seen(await get(ui, 'peers'));
    assert.equal(peers[0].cable.plugged, false);
    const failed = await fetch(`${ui.url}api/load`, { method: 'POST', headers: { 'content-type': 'application/json', ...origin(ui.port) }, body: JSON.stringify({ model: 'tiny', mode: 'phone' }) });
    assert.match(await failed.text(), /unplugged: plug the cable in/);

    // plugged in again: adb picks another port; the next connect makes the forward again
    const fwd2 = await forwardPort(() => phone.port);
    fake.set({ devices: [DEV_LINE], nextPort: fwd2.port });
    const probed = seen(JSON.stringify(await engine.probe()));
    assert.equal(probed[0].reach.ok, true, JSON.stringify(probed[0]));
    assert.equal(probed[0].cable.plugged, true);
    assert.equal(readPeers(peersFile)[0].port, fwd2.port);
    await fwd2.close();

    // nothing the page got carries the code or the secret
    for (const b of bodies) {
      assert.ok(!b.includes(PIN), `the code leaked: ${b.slice(0, 200)}`);
      assert.ok(!b.includes('fedcba9876543210'), 'the next code leaked');
      assert.ok(!b.includes(phone.fp), 'the certificate fingerprint is not handed out');
    }
  } finally {
    await ui.close();
    await engine.close();
    await fwd.close();
    await model.close();
    await phone.close();
  }
  // the forwards this process made are removed when it closes
  assert.deepEqual(fake.read().forwards.filter((f) => f.local !== 50551), []);
});

test('a phone already paired through a forward made by hand is found again, its forward reused and left alone', async () => {
  const phone = await fakePhone();
  const fwd = await forwardPort(() => phone.port);
  const fake = fakeAdb({ devices: [DEV_LINE], forwards: [{ serial: SERIAL, local: fwd.port, remote: 'tcp:50551' }], nextPort: 1, sharing: true });
  const dir = fs.mkdtempSync(path.join(HOME, 'engine-'));
  const peersFile = path.join(dir, 'peers.json');
  const engine = new Engine({ peersFile, identity: createIdentity('mac'), llama: null, probeMs: 1500, adb: fake.adb, cablePollMs: 50, cableWaitMs: 2000 });
  try {
    // paired by hand at 127.0.0.1:<the forward> ("type it"), as before this cable page
    await engine.pairByHand({ address: `127.0.0.1:${fwd.port}`, pin: PIN, name: 'my phone' });
    // the gate says "paired" to a peek, and the certificate is the one it showed
    const peek = await peekGate('127.0.0.1', fwd.port, (engine as any).identity(), 2000);
    assert.deepEqual(peek, { up: true, fp: phone.fp, state: 'paired' });
    engine.useCable(SERIAL);
    const job = await engine.cableSettled(SERIAL);
    assert.equal(job!.step, 'paired', JSON.stringify(job));
    const book = readPeers(peersFile);
    assert.equal(book.length, 1, 'the same phone, not a second one');
    assert.equal(book[0].id, `127.0.0.1:${fwd.port}`);
    assert.equal(book[0].name, 'my phone');
    assert.deepEqual(book[0].cable, { serial: SERIAL });
    assert.ok(!fake.read().calls.some((c) => c.includes('forward tcp:0')), 'the existing forward was reused');
  } finally {
    await engine.close();
    await fwd.close();
    await phone.close();
  }
  assert.deepEqual(fake.read().forwards, [{ serial: SERIAL, local: fwd.port, remote: 'tcp:50551' }], 'a forward made by hand stays');
});

test('kula not on the phone, or the phone never shares: said plainly', async () => {
  const fwd = await forwardPort(() => null);
  const fake = fakeAdb({ devices: [DEV_LINE], nextPort: fwd.port, installed: false });
  const dir = fs.mkdtempSync(path.join(HOME, 'engine-'));
  const engine = new Engine({ peersFile: path.join(dir, 'peers.json'), identity: createIdentity('mac'), llama: null, adb: fake.adb, cablePollMs: 50, cableWaitMs: 400 });
  try {
    const view = await engine.cable();
    assert.equal(view.devices[0].installed, false);
    assert.match(view.devices[0].help!, /not installed/);
    engine.useCable(SERIAL);
    assert.match((await engine.cableSettled(SERIAL))!.error!, /not installed/);
    // installed, but nobody presses start (an old app without start=1)
    fake.set({ installed: true });
    (engine as any).installedBy.clear();
    await engine.cable();
    engine.useCable(SERIAL);
    const j = await engine.cableSettled(SERIAL);
    assert.equal(j!.step, 'error');
    assert.match(j!.error!, /did not start sharing/);
    assert.equal(fake.read().opened.length, 1);
    await assert.rejects(engine.pairCable(SERIAL, PIN), /press "use"/);
  } finally {
    await engine.close();
    await fwd.close();
  }
});
