import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { parsePeerText, peerCode, readPeers, writePeers, upsertPeer, removePeer, findPeer, maskSecret, probePeers, discover, reachable } from '../src/peers.ts';
import { startGateServer, Tunnel } from '../src/gate.ts';

const QR = '{"k":"kula-peer","v":2,"id":"7f1c0a2e-1","name":"pixel","host":"192.168.1.33","port":50551,"secret":"0123456789ABCDEF0123456789abcdef","passport":{"ram_mb":7600}}';

test('parses the qr json, its base64url code and host:port:secret', () => {
  const p = parsePeerText(QR);
  assert.equal(p.id, '7f1c0a2e-1');
  assert.equal(p.name, 'pixel');
  assert.equal(p.port, 50551);
  assert.equal(p.secret, '0123456789abcdef0123456789abcdef', 'secret is lower cased');
  assert.equal(p.kind, 'phone');
  assert.equal(p.ram, null);
  assert.deepEqual(p.passport, { ram_mb: 7600 });
  const pc = parsePeerText('{"k":"kula-peer","v":2,"id":"i","name":"mac","host":"10.0.0.2","port":50551,"secret":"abcdefabcdefabcd","kind":"pc","ram":12000,"bw":45,"gpu":"Apple M1","vram":0}');
  assert.equal(pc.kind, 'pc');
  assert.equal(pc.ram, 12000);
  assert.equal(pc.bw, 45);
  const fromCode = parsePeerText(peerCode(pc));
  assert.equal(fromCode.id, 'i');
  assert.equal(fromCode.secret, pc.secret);
  const short = parsePeerText('10.0.0.9:50551:deadbeefdeadbeef');
  assert.equal(short.host, '10.0.0.9');
  assert.equal(short.id, '10.0.0.9:50551');
  assert.equal(short.kind, 'pc');
});

test('refuses what is not a peer', () => {
  for (const bad of ['', 'hello', '{"k":"other"}', '{"k":"kula-peer","v":1,"host":"h","port":1,"secret":"abcdefabcdefabcd"}', '{"k":"kula-peer","v":2,"host":"h","port":70000,"secret":"abcdefabcdefabcd"}', '{"k":"kula-peer","v":2,"host":"h","port":1,"secret":"xyz"}', '10.0.0.9:50551:nothex']) {
    assert.throws(() => parsePeerText(bad), `accepted: ${bad}`);
  }
});

test('peers.json is written with mode 600, upsert keeps added_at, rm by id prefix or name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-peers-'));
  const file = path.join(dir, 'peers.json');
  try {
    const a = parsePeerText(QR);
    let { list, added } = upsertPeer(readPeers(file), a);
    assert.equal(added, true);
    writePeers(list, file);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const again = { ...parsePeerText(QR), name: 'pixel 2', added_at: 'later' };
    ({ list, added } = upsertPeer(readPeers(file), again));
    assert.equal(added, false);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'pixel 2');
    assert.equal(list[0].added_at, a.added_at);
    writePeers(list, file);
    assert.equal(findPeer(readPeers(file), '7f1c')?.id, '7f1c0a2e-1');
    assert.equal(findPeer(readPeers(file), 'pixel 2')?.id, '7f1c0a2e-1');
    const { list: rest, removed } = removePeer(readPeers(file), '7f1c');
    assert.equal(removed?.id, '7f1c0a2e-1');
    assert.deepEqual(rest, []);
    assert.equal(removePeer(rest, 'nope').removed, null);
    assert.equal(maskSecret(a.secret), '0123…');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.pipe(c));
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

// a port that accepts and never answers: the probe must give up within its timeout
function silentServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const socks: net.Socket[] = [];
    const s = net.createServer((c) => socks.push(c));
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => { socks.forEach((c) => c.destroy()); s.close(); } }));
  });
}

test('probePeers: ok with the right secret, NO wrong secret otherwise, a silent port times out, a closed port is refused', async () => {
  const echo = await echoServer();
  const silent = await silentServer();
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 'right', targets: (ch) => (ch === 'rpc' ? echo.port : null) });
  const closed = await echoServer(); closed.close();
  const base = { kind: 'pc' as const, ram: 1000, bw: 5, added_at: 't' };
  const peers = [
    { ...base, id: 'good', name: 'good', host: '127.0.0.1', port: gate.port, secret: 'right' },
    { ...base, id: 'bad', name: 'bad', host: '127.0.0.1', port: gate.port, secret: 'wrong' },
    { ...base, id: 'silent', name: 'silent', host: '127.0.0.1', port: silent.port, secret: 'right' },
    { ...base, id: 'gone', name: 'gone', host: '127.0.0.1', port: closed.port, secret: 'right' },
  ];
  try {
    const t0 = Date.now();
    const r = await probePeers(peers, 700);
    assert.ok(Date.now() - t0 < 2500, 'the silent peer must not hold the others');
    const by = Object.fromEntries(r.map((x) => [x.peer.id, x]));
    assert.equal(by.good.rpc.ok, true);
    assert.equal(by.good.api.ok, false);
    assert.equal((by.good.api as any).reason, 'channel closed');
    assert.ok(reachable(by.good.api), 'channel closed still means the worker is up');
    assert.ok(by.good.peer.last_ok, 'a live peer gets last_ok');
    assert.equal((by.bad.rpc as any).reason, 'wrong secret');
    assert.equal((by.bad.api as any).reason, 'wrong secret');
    assert.equal(by.bad.peer.last_ok, undefined);
    assert.equal((by.silent.rpc as any).reason, 'timeout');
    assert.match((by.gone.rpc as any).reason, /ECONNREFUSED/);
  } finally {
    await gate.close(); echo.close(); silent.close();
  }
});

test('a tunnel with the wrong secret is refused: the local connection is closed without a byte', async () => {
  const echo = await echoServer();
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 'right', targets: () => echo.port });
  const tunnel = new Tunnel('127.0.0.1', gate.port, 'wrong', 'api');
  const port = await tunnel.listen();
  try {
    const got = await new Promise<{ bytes: number; closed: boolean }>((resolve) => {
      const c = net.connect({ host: '127.0.0.1', port });
      let bytes = 0;
      c.on('connect', () => c.write('GET /status HTTP/1.1\r\n\r\n'));
      c.on('data', (d) => { bytes += d.length; });
      c.on('close', () => resolve({ bytes, closed: true }));
      c.on('error', () => {});
    });
    assert.deepEqual(got, { bytes: 0, closed: true });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/status`));
  } finally {
    await tunnel.close(); await gate.close(); echo.close();
  }
});

test('discover collects _kula._tcp answers from a (fake) bonjour browser, without secrets', async () => {
  const browser = Object.assign(new EventEmitter(), { services: [] as any[], stop() {}, start() {} });
  let destroyed = 0;
  const fake = {
    find: (opts: any) => { assert.deepEqual(opts, { type: 'kula', protocol: 'tcp' }); return browser as any; },
    destroy: () => { destroyed++; },
  };
  const p = discover(150, fake as any);
  browser.emit('up', { name: 'kula pixel 7f1c0a2e', port: 50551, addresses: ['fe80::1', '192.168.1.33'], txt: { id: '7f1c0a2e-1', name: 'pixel', ram: '7600', bw: '12.5', kind: 'phone', v: 'rpc7' } });
  browser.emit('up', { name: 'kula pixel 7f1c0a2e', port: 50551, addresses: ['192.168.1.33'], txt: { id: '7f1c0a2e-1', name: 'pixel' } }); // the same one again
  browser.emit('up', { name: 'kula mac', port: 50552, addresses: ['192.168.1.20'], txt: { id: 'm', name: 'mac', kind: 'pc', ram: '12000', bw: '45' } });
  const found = await p;
  assert.equal(destroyed, 1);
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], { id: '7f1c0a2e-1', name: 'pixel', host: '192.168.1.33', port: 50551, kind: 'phone', ram: 7600, bw: 12.5, v: 'rpc7' });
  assert.ok(!JSON.stringify(found).includes('secret'));
});
