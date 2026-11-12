// A phone's live health in god's eye's snapshot (12.11.2026). The phone's worker writes a signed
// ledger health line every minute or when its warnings change (WorkerService.kt, Auditor.kt
// onHealth): {"t":..,"kind":"health","throttled":..,"batteryC":..,"batteryPct":..,"warn":[..]?,
// "prev":..,"sig":..}; batteryPct -1 when Android could not say it, batteryC 0.0 when unknown.
// The computer already receives those lines through /trust; healthOf reads the newest reading
// from them. Then the engine: a device in use in the cluster is asked for its /trust at most once
// a minute (healthMs here), through the api tunnel the cluster already holds, so a new health
// line reaches the snapshot while the device works.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-eye-health-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { healthOf, deviceOf } = await import('../src/ui/godseye-feed.ts');
const { Engine } = await import('../src/ui/engine.ts');
const { startApiServer } = await import('../src/api.ts');
const { startGateServer } = await import('../src/gate.ts');
const { createIdentity, Paired } = await import('../src/tls.ts');
const { serveModel } = await import('../src/modelserve.ts');
const { generate } = await import('../src/audit/key.ts');
const { Ledger } = await import('../src/audit/ledger.ts');

const T = 1_762_900_000_000;
const PREV = 'ab'.repeat(32);
const SIG = 'c2lnbmF0dXJl';
// a line exactly as the phone's Ledger.kt writes it: no peer for health, Kotlin's 0.0 for a double
const phoneLine = (t: number, fields: string) => `{"t":${t},"kind":"health",${fields},"prev":"${PREV}","sig":"${SIG}"}`;
const reading = (t: number, c = '36.5', pct = '72', thr = 'false') => phoneLine(t, `"throttled":${thr},"batteryC":${c},"batteryPct":${pct}`);
const connect = (t: number) => `{"t":${t},"kind":"connect","peer":"10.0.0.7","channel":"api","prev":"${PREV}","sig":"${SIG}"}`;

test('healthOf: a real-shaped phone line gives its time, heat, battery and throttle; charging is not said yet', () => {
  assert.deepEqual(healthOf([reading(T)]), { at: T, tempC: 36.5, battery: 72, charging: null, throttled: false });
  const hot = phoneLine(T, '"throttled":true,"batteryC":44.2,"batteryPct":12,"warn":["hot","low battery"]');
  assert.deepEqual(healthOf([hot]), { at: T, tempC: 44.2, battery: 12, charging: null, throttled: true });
  // a later producer that says charging: kept as it says
  assert.equal(healthOf([phoneLine(T, '"throttled":false,"batteryC":30.0,"batteryPct":50,"charging":true')])!.charging, true);
  // node's own ledger writes a peer; the reading is the same
  assert.deepEqual(healthOf([`{"t":${T},"kind":"health","peer":"self","throttled":false,"batteryC":31,"batteryPct":90,"prev":"${PREV}","sig":"${SIG}"}`]),
    { at: T, tempC: 31, battery: 90, charging: null, throttled: false });
});

test('healthOf: the newest reading wins; a torn, key or unpair health line newer than it is skipped, so are other kinds', () => {
  const lines = [
    reading(T, '30.0', '90'),
    reading(T + 60_000, '33.5', '80'),
    phoneLine(T + 61_000, '"torn":2'),
    phoneLine(T + 62_000, '"keyReplaced":true,"old":"xyz"'),
    phoneLine(T + 63_000, '"unpair":"a1b2"'),
    connect(T + 64_000),
  ];
  assert.deepEqual(healthOf(lines), { at: T + 60_000, tempC: 33.5, battery: 80, charging: null, throttled: false });
  assert.equal(healthOf([phoneLine(T, '"torn":1'), connect(T + 1)]), null, 'no reading at all');
  assert.equal(healthOf([]), null);
});

test('healthOf: the sentinels are unknown: batteryPct -1, batteryC 0.0; a percent outside 0..100 too', () => {
  assert.deepEqual(healthOf([reading(T, '0.0', '-1')]), { at: T, tempC: null, battery: null, charging: null, throttled: false });
  assert.equal(healthOf([reading(T, '0', '101')])!.battery, null);
  assert.equal(healthOf([reading(T, '0', '100')])!.battery, 100);
  assert.equal(healthOf([reading(T, '0', '0')])!.battery, 0);
  assert.equal(healthOf([reading(T, '-0.5', '50')])!.tempC, -0.5, 'only exactly 0 is the unknown sentinel');
});

test('healthOf: garbage is skipped, never thrown on; an older good reading behind it still counts', () => {
  const good = reading(T, '35.0', '60');
  const junk = [
    'not json',
    '{"t":1,"kind":"health"',                                     // cut
    `{"t":"${T + 1}","kind":"health","throttled":true}`,            // t not a number
    `{"kind":"health","t":${T + 2},"throttled":true}`,              // not the producer's order
    phoneLine(T + 3, '"throttled":"yes","batteryC":40,"batteryPct":40'),   // throttled not a boolean
    `{"t":${T + 4},"kind":"healthy","throttled":true}`,             // another kind
    phoneLine(T + 5, '"throttled":true,"batteryC":"hot","batteryPct":"low"').replace(/}$/, ',}'),   // broken json
    '',
    42 as unknown as string,
    null as unknown as string,
  ];
  assert.deepEqual(healthOf([good, ...junk]), { at: T, tempC: 35, battery: 60, charging: null, throttled: false });
  // wrong-typed numbers in a reading are unknown, the reading still counts
  assert.deepEqual(healthOf([phoneLine(T, '"throttled":true,"batteryC":"hot","batteryPct":"12"')]), { at: T, tempC: null, battery: null, charging: null, throttled: true });
  assert.equal(healthOf('lines' as unknown as string[]), null);
});

test('healthOf: a 64 KiB line is read (or skipped) without trouble', () => {
  const big = phoneLine(T + 1, `"throttled":true,"batteryC":41.0,"batteryPct":30,"warn":["${'w'.repeat(64 * 1024 - 200)}"]`);
  assert.ok(big.length <= 64 * 1024 && big.length > 60_000);
  assert.deepEqual(healthOf([reading(T), big]), { at: T + 1, tempC: 41, battery: 30, charging: null, throttled: true });
  const bigJunk = `{"t":${T + 2},"kind":"health",` + 'x'.repeat(64 * 1024 - 40);
  const t0 = Date.now();
  const many = Array.from({ length: 500 }, () => bigJunk);
  assert.deepEqual(healthOf([reading(T), ...many]), { at: T, tempC: 36.5, battery: 72, charging: null, throttled: false });
  assert.ok(Date.now() - t0 < 2000, 'a window of 500 big lines stays quick');
});

test('deviceOf: health from the trust lines; null without lines or without a reading', () => {
  const row = { id: 'p1', name: 'pixel', kind: 'phone', where: 'x', far: false, tls: true, waitingPair: false, ram: null, bw: null, gpu: null, last_ok: null, reach: null, probedAt: null, cable: null, holds: null, via: 'wifi', ways: { cable: null, wifi: null, relay: null }, routes: ['p1'], heardAt: null, usesThisComputer: false, reachedBy: null, ring: 'home' } as any;
  const look = (lines: string[]) => ({ at: T, error: null, id: null, alg: null, pub: null, store: null, cert: null, certPinned: null, v1: null, paired: null, self: null, count: null, head: null, upTo: null, lines, restartedAt: null, rejectsDay: {}, rejectsLast: [], attest: null });
  assert.equal(deviceOf(row).health, null);
  assert.equal(deviceOf(row, look([])).health, null);
  assert.equal(deviceOf(row, look([connect(T)])).health, null);
  assert.deepEqual(deviceOf(row, look([reading(T, '40.5', '18', 'true')])).health, { at: T, tempC: 40.5, battery: 18, charging: null, throttled: true });
});

// ---------- the engine: a device in the cluster is asked for its health at most once per healthMs

const PIN = '0123456789abcdef';

function fakeLlamaServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as any).port, close: () => s.close() }));
  });
}

// a phone sharing with a signed ledger behind its /trust: the real worker api and gate with tls
async function fakePhone() {
  const dir = fs.mkdtempSync(path.join(HOME, 'phone-'));
  const llama = await fakeLlamaServer();
  const identity = createIdentity('phone');
  const tls = { identity, paired: new Paired(null), pin: PIN as string | null };
  const key = generate();
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(ledgerFile, key);
  ledger.append('health', 'self', { throttled: false, batteryC: 30.5, batteryPct: 90 });
  let asked = 0;
  const trust = { key, ledgerFile, cert: () => identity.certDer, gate: () => { asked++; return { v1: false, tls: true, paired: tls.paired.size }; } };
  const api = await startApiServer({ models: dir, llama: null, allowPrivateUrls: true, trust, startBackend: async () => ({ port: llama.port, stop: async () => {} }) });
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: (ch) => (ch === 'api' ? api.port : null), tls });
  return {
    port: gate.port, ledger, asked: () => asked,
    close: async () => { await gate.close(); await api.close(); llama.close(); },
  };
}

async function tinyModel() {
  const dir = fs.mkdtempSync(path.join(HOME, 'model-'));
  const file = path.join(dir, 'tiny-q8_0.gguf');
  const bytes = randomBytes(150_000);
  fs.writeFileSync(file, bytes);
  const served = await serveModel(file, '127.0.0.1', '127.0.0.1');
  const entry = {
    id: 'tiny', name: 'Tiny 0.1B', family: 'tiny', params_b: 0.1, quant: 'Q8_0', repo: 'x/y', file: 'tiny-q8_0.gguf', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), license: 'mit', ctx_max: 8192, kv_mb_per_1k: 8, blurb: 'a test model', good: '', url: served.url,
  };
  return { entry, close: () => served.close() };
}

// a quiet network: the look hears nobody, so its own probe never runs
const quiet = () => {
  const browser = Object.assign(new EventEmitter(), { services: [] as any[], stop() {}, start() {} });
  return { find: () => browser as any, destroy: () => {} };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a device in the cluster: the look asks its /trust at most once per healthMs, and its new health line reaches the snapshot', async () => {
  const phone = await fakePhone();
  const model = await tinyModel();
  const dir = fs.mkdtempSync(path.join(HOME, 'e-'));
  fs.mkdirSync(path.join(dir, 'models'));
  const HEALTH_MS = 400;
  const e = new Engine({
    peersFile: path.join(dir, 'peers.json'), modelDirs: [path.join(dir, 'models')], identity: createIdentity('mac'), llama: null,
    catalog: [model.entry], probeMs: 1500, statusMs: 1500, discoverMs: 30, bonjour: quiet, healthMs: HEALTH_MS,
  } as any);
  try {
    const p = await e.pairByHand({ address: `127.0.0.1:${phone.port}`, pin: PIN, name: 'pixel' });
    const st = await e.load({ model: 'tiny', mode: 'phone', peers: [p.id], all: true }, () => {});
    assert.deepEqual(st.loaded?.devices.map((d) => d.name), ['pixel']);
    const health = () => deviceOf(e.peers().find((r) => r.id === p.id)!, e.trustOf(p.id)).health;

    // the phone gets warm and low while it works: a new signed line in its ledger
    phone.ledger.append('health', 'self', { throttled: true, batteryC: 44.5, batteryPct: 12 });
    await sleep(HEALTH_MS + 100);
    await e.look();
    assert.deepEqual(health(), { at: health()!.at, tempC: 44.5, battery: 12, charging: null, throttled: true });

    // asked again at once: not yet, the minute (healthMs) has not passed
    const before = phone.asked();
    phone.ledger.append('health', 'self', { throttled: false, batteryC: 35, batteryPct: 55 });
    await e.look();
    assert.equal(phone.asked(), before, 'no second /trust inside healthMs');
    assert.equal(health()!.battery, 12);

    // once it passed, the next look brings the new line
    await sleep(HEALTH_MS + 100);
    await e.look();
    assert.equal(phone.asked(), before + 1);
    assert.deepEqual({ ...health(), at: 0 }, { at: 0, tempC: 35, battery: 55, charging: null, throttled: false });

    // unloaded: nothing is in use, the look asks nobody
    await e.unload();
    await sleep(HEALTH_MS + 100);
    const after = phone.asked();
    await e.look();
    assert.equal(phone.asked(), after, 'a device no longer in use is not asked by the look');
  } finally {
    await e.close();
    await phone.close();
    await model.close();
  }
});
