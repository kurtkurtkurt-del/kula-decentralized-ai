// A worker's own /status in god's eye's snapshot (13.11.2026, scan D M2 M1 M3, node side). The
// probe already asks every reachable phone's GET /status (engine.ts holds) and used to keep only
// loaded/model. Now its busy, tokensUsed, ctx and (a worker from the next apk on) ramFreeMb reach
// the device's row as `worker`, with the time they came; and this computer's free disk reaches
// host.diskFreeMb. Observations only: numbers and flags, never a prompt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-feed-worker-'));
process.env.KULA_NODE_HOME = HOME;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { deviceOf, kulaSnapshot } = await import('../src/ui/godseye-feed.ts');
const { Engine } = await import('../src/ui/engine.ts');
const { startGateServer } = await import('../src/gate.ts');
const { createIdentity, Paired } = await import('../src/tls.ts');

const PIN = '0123456789abcdef';

// a phone's api channel that answers /status with what the test says; every other route is 404
async function fakePhone(status: () => unknown) {
  const api = await new Promise<http.Server>((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(status())); return; }
      res.writeHead(404); res.end('{"error":"no such route"}');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const apiPort = (api.address() as any).port as number;
  const tls = { identity: createIdentity('phone'), paired: new Paired(null), pin: PIN as string | null };
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: (ch) => (ch === 'api' ? apiPort : null), tls });
  return { port: gate.port, close: async () => { await gate.close(); api.close(); } };
}

function engineIn(dir: string) {
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  return new Engine({
    peersFile: path.join(dir, 'peers.json'), modelDirs: [path.join(dir, 'models')], identity: createIdentity('mac'), llama: null,
    catalog: [], probeMs: 1500, statusMs: 1500,
  } as any);
}

test('a probe keeps the worker\'s busy, tokensUsed, ctx and ramFreeMb with their time; the snapshot carries them', async () => {
  let st: any = { loaded: true, model: 'tiny-q8_0.gguf', sha256: null, tokensUsed: 3700, ctx: 4096, busy: true, threads: 4, ramFreeMb: 2100, prompt: 'never kept' };
  const phone = await fakePhone(() => st);
  const e = engineIn(fs.mkdtempSync(path.join(HOME, 'e-')));
  try {
    const p = await e.pairByHand({ address: `127.0.0.1:${phone.port}`, pin: PIN, name: 'pixel' });
    assert.equal('worker' in p, false, 'never asked: no worker key (the row keeps its old shape)');
    const t0 = Date.now();
    const rows = await e.probe([p.id]);
    const row = rows.find((r) => r.id === p.id)!;
    assert.equal(row.holds, 'tiny-q8_0.gguf');
    const w = row.worker!;
    assert.ok(w.at >= t0 && w.at <= Date.now(), 'the time it came');
    assert.deepEqual({ ...w, at: 0 }, { at: 0, busy: true, tokensUsed: 3700, ctx: 4096, ramFreeMb: 2100 });
    const d = deviceOf(row);
    assert.deepEqual(d.worker, w);
    assert.ok(!JSON.stringify(d).includes('never kept'), 'no prompt text');

    // a worker before the next apk says no ramFreeMb: null, not a guess
    st = { loaded: false, model: null, sha256: null, tokensUsed: 0, ctx: 0, busy: false };
    const again = (await e.probe([p.id])).find((r) => r.id === p.id)!.worker!;
    assert.deepEqual({ ...again, at: 0 }, { at: 0, busy: false, tokensUsed: 0, ctx: 0, ramFreeMb: null });

    // through kulaSnapshot: the device carries the worker, the host its free disk
    const s = kulaSnapshot(e, { list: () => [] } as any, 5000);
    assert.deepEqual(s.devices[0].worker, again);
    assert.equal(typeof s.host.diskFreeMb, 'number');
    assert.ok(s.host.diskFreeMb! > 0);
  } finally {
    await e.close();
    await phone.close();
  }
});

test('a /status that is not json or not an object keeps no worker; forgetting the device drops it', async () => {
  let st: any = 'nonsense';
  const phone = await fakePhone(() => st);
  const e = engineIn(fs.mkdtempSync(path.join(HOME, 'e-')));
  try {
    const p = await e.pairByHand({ address: `127.0.0.1:${phone.port}`, pin: PIN, name: 'pixel' });
    let row = (await e.probe([p.id])).find((r) => r.id === p.id)!;
    assert.equal('worker' in row, false);
    st = null;
    row = (await e.probe([p.id])).find((r) => r.id === p.id)!;
    assert.equal('worker' in row, false);
    st = { busy: 'yes', tokensUsed: -1, ctx: 'big', ramFreeMb: NaN };
    row = (await e.probe([p.id])).find((r) => r.id === p.id)!;
    assert.deepEqual({ ...row.worker!, at: 0 }, { at: 0, busy: null, tokensUsed: null, ctx: null, ramFreeMb: null });
    assert.equal(e.removePeer(p.id), true);
    // paired again at the same address: the old reading is gone
    const p2 = await e.pairByHand({ address: `127.0.0.1:${phone.port}`, pin: PIN, name: 'pixel' });
    assert.equal('worker' in p2, false);
  } finally {
    await e.close();
    await phone.close();
  }
});

test('the feed: diskFreeMb is null when the engine cannot say it, a row without worker gives none', () => {
  const row = {
    id: 'c1', name: 'pixel', kind: 'phone', where: 'usb R3C', far: false, tls: true, waitingPair: false,
    ram: 3400, bw: 60, gpu: null, last_ok: null, reach: { ok: true, ms: 9 }, probedAt: 1,
    cable: { serial: 'R3C', plugged: true }, holds: null, via: 'cable',
    ways: { cable: null, wifi: null, relay: null }, routes: ['c1'], heardAt: null,
    usesThisComputer: false, reachedBy: null, ring: 'home',
  };
  assert.equal('worker' in deviceOf(row as any), false);
  const engine = {
    status: () => ({ loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: false }),
    peers: () => [row], trustOf: () => null, models: () => [], photos: () => ({ n: 0, unseen: 0, at: null }),
    diskFreeMb: () => { throw new Error('no statfs'); },
  };
  assert.equal(kulaSnapshot(engine as any, { list: () => [] } as any, 5000).host.diskFreeMb, null);
});
