import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startGateServer, probe, Tunnel, MAX_HANDSHAKES, type TlsServer, type GateEvent } from '../src/gate.ts';
import { createIdentity, Paired, newPin } from '../src/tls.ts';
import { urlProblem, isPrivateAddress, overSize, sizeProblem } from '../src/policy.ts';
import { download, pinnedMaster } from '../src/download.ts';
import { lanIPv4, sourceAddressTo } from '../src/sysinfo.ts';
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
  assert.equal(urlProblem('http://127.0.0.1:8080/m'), "url must be public or the master's own address");
  assert.equal(urlProblem('http://localhost/m'), 'url points at a local host');
  assert.equal(urlProblem('http://router.local/m'), 'url points at a local host');
  assert.equal(urlProblem('http://192.168.1.1/m'), "url must be public or the master's own address");
  assert.equal(urlProblem('http://10.0.0.5/m'), "url must be public or the master's own address");
  assert.equal(urlProblem('http://172.20.0.1/m'), "url must be public or the master's own address");
  assert.equal(urlProblem('http://169.254.169.254/latest/meta-data'), "url must be public or the master's own address");
  assert.equal(urlProblem('http://[::1]/m'), "url must be public or the master's own address");
  assert.equal(urlProblem('http://[fe80::1]/m'), "url must be public or the master's own address");
  assert.equal(urlProblem('http://[::ffff:10.0.0.1]/m'), "url must be public or the master's own address");
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
    await assert.rejects(download(`${base}/big`, path.join(dir, 'e'), undefined, undefined, {}), /master's own address/);
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
    assert.deepEqual(await post({ url: 'http://192.168.1.10/m', sha256: 'ab'.repeat(32), size: 10, name: 'm' }), { status: 400, body: { error: "url must be public or the master's own address" } });
    assert.deepEqual(await post({ url: 'file:///etc/passwd', sha256: 'ab'.repeat(32), size: 10, name: 'm' }), { status: 400, body: { error: 'url must be http(s)' } });
    assert.equal(fs.readdirSync(models).length, 0);
    assert.equal(api.status().busy, false);
  } finally {
    await api.close();
  }
});

test('url policy: the one exception is the private address of the master that sent the /load, as an ip literal, never loopback', () => {
  assert.equal(urlProblem('http://192.168.1.5:8000/m/x/a.gguf', false, '192.168.1.5'), null);
  assert.equal(urlProblem('http://192.168.1.5:8000/m', false, '::ffff:192.168.1.5'), null, 'the gate may see a mapped address');
  assert.equal(urlProblem('http://[fe80::5]/m', false, 'FE80::5'), null);
  assert.equal(urlProblem('http://192.168.1.6/m', false, '192.168.1.5'), "url must be public or the master's own address");
  assert.equal(urlProblem('http://10.0.0.1/m', false, '192.168.1.5'), "url must be public or the master's own address");
  assert.equal(urlProblem('http://169.254.169.254/latest/meta-data', false, '192.168.1.5'), "url must be public or the master's own address");
  // a relayed connection reaches the gate from 127.0.0.1: no exception for it
  assert.equal(urlProblem('http://127.0.0.1:8000/m', false, '127.0.0.1'), "url must be public or the master's own address");
  assert.equal(urlProblem('http://[::1]:8000/m', false, '::1'), "url must be public or the master's own address");
  // a name is never the exception, even one that would resolve to the master
  assert.equal(urlProblem('http://masters-mac.local/m', false, '192.168.1.5'), 'url points at a local host');
  assert.equal(urlProblem('http://localhost/m', false, '192.168.1.5'), 'url points at a local host');
  // public stays public
  assert.equal(urlProblem('https://huggingface.co/m', false, '192.168.1.5'), null);
  assert.equal(pinnedMaster('http://192.168.1.5/m', '192.168.1.5'), '192.168.1.5');
  assert.equal(pinnedMaster('http://192.168.1.5/m', null), null);
  assert.equal(pinnedMaster('http://127.0.0.1/m', '127.0.0.1'), null);
  assert.equal(pinnedMaster('https://huggingface.co/m', '192.168.1.5'), null);
  assert.equal(pinnedMaster('http://8.8.8.8/m', '8.8.8.8'), null, 'a public master needs no exception');
});

test('a master offers its model at the address it sends from towards the peer', async () => {
  assert.equal(await sourceAddressTo('127.0.0.1'), '127.0.0.1');
  const lan = lanIPv4();
  if (lan) assert.equal(await sourceAddressTo(lan), lan);
});

// A master on this lan: the gate sees its address, the api lets it hand out the model from
// that address and from nowhere else in the lan. Needs a lan address on this machine.
test('/load through the gate: the master\'s own lan address is fetched; another private ip, a private name, a redirect off it and a loopback (relay) peer are refused', { skip: !lanIPv4() && 'no lan address' }, async () => {
  const lan = lanIPv4()!;
  const other = lan === '10.255.255.1' ? '10.255.255.2' : '10.255.255.1';
  const model = Buffer.from('a tiny model');
  const sha = createHash('sha256').update(model).digest('hex');
  const lo = await new Promise<http.Server>((r) => { const s = http.createServer((_q, res) => res.end(model)); s.listen(0, '127.0.0.1', () => r(s)); });
  const loPort = (lo.address() as net.AddressInfo).port;
  const files = await new Promise<http.Server>((r) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/m.gguf') { res.writeHead(200, { 'content-length': model.length }); res.end(model); return; }
      if (req.url === '/to-loopback') { res.writeHead(302, { location: `http://127.0.0.1:${loPort}/m.gguf` }); res.end(); return; }
      if (req.url === '/to-public') { res.writeHead(302, { location: 'http://93.184.216.34/m.gguf' }); res.end(); return; }
      if (req.url === '/to-self') { res.writeHead(302, { location: '/m.gguf' }); res.end(); return; }
      res.writeHead(404); res.end();
    });
    s.listen(0, lan, () => r(s));
  });
  const fport = (files.address() as net.AddressInfo).port;
  const models = tmp();
  const api = await startApiServer({ models, llama: null, startBackend: async () => ({ port: 1, stop: async () => {} }) });
  const gate = await startGateServer({ port: 0, host: lan, secret: 'lan-secret', targets: (ch) => (ch === 'api' ? api.port : null) });
  const loGate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 'lan-secret', targets: (ch) => (ch === 'api' ? api.port : null) });
  const tunnel = new Tunnel(lan, gate.port, 'lan-secret', 'api');
  const loTunnel = new Tunnel('127.0.0.1', loGate.port, 'lan-secret', 'api');
  const tport = await tunnel.listen();
  const loTport = await loTunnel.listen();
  const load = async (port: number, url: string, name: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/load`, { method: 'POST', body: JSON.stringify({ url, sha256: sha, size: model.length, name }) });
    return { status: r.status, text: await r.text() };
  };
  try {
    const same = await load(tport, `http://${lan}:${fport}/m.gguf`, 'a.gguf');
    assert.equal(same.status, 200);
    assert.match(same.text, /"done":true/, same.text);
    assert.ok(fs.existsSync(path.join(models, 'a.gguf')));
    const hop = await load(tport, `http://${lan}:${fport}/to-self`, 'b.gguf');
    assert.match(hop.text, /"done":true/, 'a redirect that stays on the same address is followed');
    assert.deepEqual(await load(tport, `http://${other}:${fport}/m.gguf`, 'c.gguf'), { status: 400, text: '{"error":"url must be public or the master\'s own address"}' });
    const named = await load(tport, `http://localhost.:${loPort}/m.gguf`, 'd.gguf');
    assert.match(named.text, /resolves to a private address/, named.text);
    const offLo = await load(tport, `http://${lan}:${fport}/to-loopback`, 'e.gguf');
    assert.match(offLo.text, /redirect left the master's address/, offLo.text);
    const offPub = await load(tport, `http://${lan}:${fport}/to-public`, 'f.gguf');
    assert.match(offPub.text, /redirect left the master's address/, offPub.text);
    // the same master through 127.0.0.1 (what a relayed stream looks like): no exception
    assert.deepEqual(await load(loTport, `http://${lan}:${fport}/m.gguf`, 'g.gguf'), { status: 400, text: '{"error":"url must be public or the master\'s own address"}' });
    assert.deepEqual(fs.readdirSync(models).sort(), ['a.gguf', 'b.gguf']);
  } finally {
    await tunnel.close(); await loTunnel.close(); await gate.close(); await loGate.close(); await api.close();
    files.close(); lo.close();
    fs.rmSync(models, { recursive: true, force: true });
  }
});
