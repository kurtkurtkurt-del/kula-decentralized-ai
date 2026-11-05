import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGateServer, probe, MAX_HANDSHAKES, type TlsServer, type GateEvent } from '../src/gate.ts';
import { createIdentity, Paired, newPin } from '../src/tls.ts';
import { urlProblem, isPrivateAddress, overSize, sizeProblem } from '../src/policy.ts';
import { download } from '../src/download.ts';
import { startApiServer } from '../src/api.ts';

// What docs/SECURITY.md says the worker refuses: floods of half-open connections, v1 on
// a worker that handed out no secret, pairing codes older than their ttl, model urls into
// the lan, downloads that outgrow the size the master gave.

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.pipe(c));
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kula-sec-'));

function connectAndRead(port: number, send?: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    let out = '';
    s.on('data', (d) => { out += d.toString(); });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    if (send) s.once('connect', () => s.write(send));
    setTimeout(() => s.destroy(), 1500);
  });
}

test('more than MAX_HANDSHAKES idle connections: the next one is told NO overloaded at once, and a slot comes back when one leaves', async () => {
  const echo = await echoServer();
  const events: GateEvent[] = [];
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 's', targets: () => echo.port, onEvent: (e) => events.push(e) });
  const idle: net.Socket[] = [];
  try {
    for (let i = 0; i < MAX_HANDSHAKES; i++) {
      const s = net.connect({ port: gate.port, host: '127.0.0.1' });
      s.on('error', () => {});
      await new Promise((r) => s.once('connect', r));
      idle.push(s);
    }
    const t0 = Date.now();
    const answer = await connectAndRead(gate.port);
    assert.equal(answer, 'NO overloaded\n');
    assert.ok(Date.now() - t0 < 1000, 'refused without waiting for a hello');
    assert.ok(events.some((e) => e.type === 'reject' && e.reason === 'overloaded'));
    // one idle connection goes away: the next real client is served
    idle.pop()!.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await probe('127.0.0.1', gate.port, 's', 'rpc')).ok, true);
  } finally {
    for (const s of idle) s.destroy();
    await gate.close();
    echo.close();
  }
});

test('a gate with secret null speaks no v1: a plain hello is told NO no v1 before any nonce; tls still works', async () => {
  const echo = await echoServer();
  const worker = createIdentity('worker');
  const master = createIdentity('master');
  const t: TlsServer = { identity: worker, paired: new Paired(null), pin: newPin() };
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echo.port, tls: t });
  try {
    assert.equal(await connectAndRead(gate.port, 'KULA1 rpc ' + 'ab'.repeat(16) + '\n'), 'NO no v1\n');
    assert.deepEqual(await probe('127.0.0.1', gate.port, 'anything', 'rpc'), { ok: false, reason: 'no v1' });
    const r = await probe('127.0.0.1', gate.port, '', 'rpc', 2000, { identity: master, fp: worker.fp, pin: t.pin });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally {
    await gate.close();
    echo.close();
  }
});

test('a pairing code past its ttl is refused with NO pin expired and a new one is asked for; a paired client is unaffected', async () => {
  const echo = await echoServer();
  const worker = createIdentity('worker');
  const master = createIdentity('master');
  const other = createIdentity('other');
  const pin = newPin();
  let rotated = 0;
  const t: TlsServer = { identity: worker, paired: new Paired(null), pin, pinExpiresAt: Date.now() + 60_000, onPinUsed: () => { rotated++; t.pin = newPin(); t.pinExpiresAt = Date.now() + 60_000; } };
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: () => echo.port, tls: t });
  try {
    // within the ttl the code pairs
    assert.equal((await probe('127.0.0.1', gate.port, '', 'rpc', 2000, { identity: master, fp: worker.fp, pin })).ok, true);
    assert.equal(rotated, 1);
    // the next code, photographed and used late
    const late = t.pin!;
    t.pinExpiresAt = Date.now() - 1;
    assert.deepEqual(await probe('127.0.0.1', gate.port, '', 'rpc', 2000, { identity: other, fp: worker.fp, pin: late }), { ok: false, reason: 'pin expired' });
    assert.equal(rotated, 2);
    assert.notEqual(t.pin, late);
    // the old code is gone for good, the fresh one works, the paired master never needed one
    assert.deepEqual(await probe('127.0.0.1', gate.port, '', 'rpc', 2000, { identity: other, fp: worker.fp, pin: late }), { ok: false, reason: 'wrong pin' });
    assert.equal((await probe('127.0.0.1', gate.port, '', 'rpc', 2000, { identity: master, fp: worker.fp })).ok, true);
  } finally {
    await gate.close();
    echo.close();
  }
});

test('url policy: only public http(s) without credentials; private, loopback, link-local and .local hosts are refused', () => {
  assert.equal(urlProblem('https://huggingface.co/x/y/resolve/main/m.gguf'), null);
  assert.equal(urlProblem('http://cdn.example.com/m.gguf'), null);
  assert.equal(urlProblem('file:///etc/passwd'), 'url must be http(s)');
  assert.equal(urlProblem('ftp://example.com/m'), 'url must be http(s)');
  assert.equal(urlProblem('not a url'), 'bad url');
  assert.equal(urlProblem('https://user:pw@example.com/m'), 'url must not carry credentials');
  assert.equal(urlProblem('http://127.0.0.1:8080/m'), 'url points at a private address');
  assert.equal(urlProblem('http://localhost/m'), 'url points at a local host');
  assert.equal(urlProblem('http://router.local/m'), 'url points at a local host');
  assert.equal(urlProblem('http://192.168.1.1/m'), 'url points at a private address');
  assert.equal(urlProblem('http://10.0.0.5/m'), 'url points at a private address');
  assert.equal(urlProblem('http://172.20.0.1/m'), 'url points at a private address');
  assert.equal(urlProblem('http://169.254.169.254/latest/meta-data'), 'url points at a private address');
  assert.equal(urlProblem('http://[::1]/m'), 'url points at a private address');
  assert.equal(urlProblem('http://[fe80::1]/m'), 'url points at a private address');
  assert.equal(urlProblem('http://[::ffff:10.0.0.1]/m'), 'url points at a private address');
  assert.equal(urlProblem('http://127.0.0.1/m', true), null);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('100.64.1.1'), true);
  assert.equal(isPrivateAddress('2001:db8::1'), false);
  assert.equal(sizeProblem(-1), 'need size (bytes)');
  assert.equal(sizeProblem(1.5), 'need size (bytes)');
  assert.equal(sizeProblem('x'), 'need size (bytes)');
  assert.equal(sizeProblem(0), null);
  assert.equal(sizeProblem(1000), null);
  assert.equal(overSize(1000, 1000), false);
  assert.equal(overSize(1000 + 1024 + 21, 1000), true);
  assert.equal(overSize(10 ** 9, 0), false);
});

// a server whose body runs on past its content-length, or redirects into the lan
function trickServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/to-lan') { res.writeHead(302, { location: 'http://192.168.0.1/m.gguf' }); res.end(); return; }
      if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
      if (req.url === '/endless') {
        // chunked, no length: streams until the client gives up
        res.writeHead(200);
        const chunk = Buffer.alloc(64 * 1024, 1);
        const t = setInterval(() => { if (!res.write(chunk)) {} }, 1);
        res.on('close', () => clearInterval(t));
        return;
      }
      if (req.url === '/big') { res.writeHead(200, { 'content-length': 5_000_000 }); res.end(Buffer.alloc(5_000_000)); return; }
      res.writeHead(404); res.end();
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

test('download: a redirect into the lan, a redirect loop, a body past the given size and a content-length past it are all refused and leave no file', async () => {
  const srv = await trickServer();
  const dir = tmp();
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    await assert.rejects(download(`${base}/to-lan`, path.join(dir, 'a'), undefined, undefined, { allowPrivate: false }), /private address|too many|url/);
    await assert.rejects(download(`${base}/loop`, path.join(dir, 'b'), undefined, undefined, { allowPrivate: true }), /too many redirects/);
    await assert.rejects(download(`${base}/endless`, path.join(dir, 'c'), undefined, undefined, { allowPrivate: true, size: 200_000 }), /ran past/);
    await assert.rejects(download(`${base}/big`, path.join(dir, 'd'), undefined, undefined, { allowPrivate: true, size: 1000 }), /size mismatch/);
    assert.ok(!fs.existsSync(path.join(dir, 'a')) && !fs.existsSync(path.join(dir, 'b')) && !fs.existsSync(path.join(dir, 'c')) && !fs.existsSync(path.join(dir, 'd')));
    // what a private-address check without the test switch does to a 127.0.0.1 url
    await assert.rejects(download(`${base}/big`, path.join(dir, 'e'), undefined, undefined, {}), /private address/);
  } finally {
    srv.close();
  }
});

test('/load refuses a bad sha256, a negative size and a lan url with 400 before anything is fetched', async () => {
  const models = tmp();
  const api = await startApiServer({ models, llama: null, startBackend: async () => ({ port: 1, stop: async () => {} }) });
  const base = `http://127.0.0.1:${api.port}`;
  const post = async (body: unknown) => { const r = await fetch(`${base}/load`, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    assert.deepEqual(await post({ url: 'https://example.com/m', sha256: 'zz', size: 10, name: 'm' }), { status: 400, body: { error: 'sha256 must be 64 hex characters' } });
    assert.deepEqual(await post({ url: 'https://example.com/m', sha256: 'ab'.repeat(32), size: -5, name: 'm' }), { status: 400, body: { error: 'need size (bytes)' } });
    assert.deepEqual(await post({ url: 'http://192.168.1.10/m', sha256: 'ab'.repeat(32), size: 10, name: 'm' }), { status: 400, body: { error: 'url points at a private address' } });
    assert.deepEqual(await post({ url: 'file:///etc/passwd', sha256: 'ab'.repeat(32), size: 10, name: 'm' }), { status: 400, body: { error: 'url must be http(s)' } });
    assert.equal(fs.readdirSync(models).length, 0);
    assert.equal(api.status().busy, false);
  } finally {
    await api.close();
  }
});
