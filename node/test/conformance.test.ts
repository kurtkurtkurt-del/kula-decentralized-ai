// The apart-mode api, byte for byte: what a phone sees on the wire when it
// talks to a kula-node worker. llama-server is a fake that speaks just enough
// of /v1/chat/completions and /health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startApiServer } from '../src/api.ts';
import { startGateServer, handshake, GateRefused, Tunnel } from '../src/gate.ts';
import { blobMb, BLOB_MAX_MB } from '../src/benchcore.ts';

type Srv = { port: number; close: () => void };
const listen = (s: http.Server): Promise<Srv> => new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as any).port, close: () => s.close() })));

function fileServer(body: Buffer): Promise<Srv> {
  return listen(http.createServer((_req, res) => { res.writeHead(200, { 'content-length': body.length }); res.end(body); }));
}

// pieces arrive every `everyMs`; with `forever` the stream never ends on its own
function fakeLlama(pieces: string[], everyMs = 5, forever = false): Promise<Srv & { aborted: () => boolean }> {
  let aborted = false;
  const s = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const t = setInterval(() => {
      if (i < pieces.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] })}\n\n`);
      else if (forever) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '.' } }] })}\n\n`);
      else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: pieces.length } })}\n\ndata: [DONE]\n\n`);
        res.end(); clearInterval(t);
      }
    }, everyMs);
    req.on('close', () => { clearInterval(t); if (forever) aborted = true; });
  });
  return listen(s).then((x) => Object.assign(x, { aborted: () => aborted }));
}

async function post(base: string, p: string, body?: unknown): Promise<{ status: number; type: string | null; text: string }> {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
}

test('/status, /load and /chat produce the exact sse lines', async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-conf-'));
  const model = randomBytes(1000);
  const sha = createHash('sha256').update(model).digest('hex');
  const files = await fileServer(model);
  const fake = await fakeLlama(['Hel', 'lo', ' there', '!']);
  const api = await startApiServer({ models, llama: null, allowPrivateUrls: true, startBackend: async () => ({ port: fake.port, stop: async () => {} }) });
  const base = `http://127.0.0.1:${api.port}`;
  try {
    assert.equal(await (await fetch(`${base}/status`)).text(), '{"loaded":false,"model":null,"sha256":null,"tokensUsed":0,"ctx":0,"busy":false}');

    const load = await post(base, '/load', { url: `http://127.0.0.1:${files.port}/m.gguf`, sha256: sha, size: 1000, name: 'm.gguf', ctx: 2048 });
    assert.equal(load.status, 200);
    assert.equal(load.type, 'text/event-stream');
    assert.equal(load.text, [
      'data: {"state":"running","got":0,"total":1000}',
      'data: {"state":"running","got":1000,"total":1000}',
      'data: {"state":"running","got":1000,"total":1000}',
      'data: {"state":"checking","got":0,"total":1000}',
      'data: {"state":"checking","got":1000,"total":1000}',
      'data: {"state":"loading","got":0,"total":0}',
      `data: {"done":true,"ctx":2048,"sha256":"${sha}"}`,
      ''].join('\n\n'));
    assert.equal(await (await fetch(`${base}/status`)).text(), `{"loaded":true,"model":"m.gguf","sha256":"${sha}","tokensUsed":0,"ctx":2048,"busy":false}`);

    const chat = await post(base, '/chat', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(chat.type, 'text/event-stream');
    const lines = chat.text.split('\n\n');
    assert.deepEqual(lines.slice(0, 4), ['data: {"t":"Hel"}', 'data: {"t":"lo"}', 'data: {"t":" there"}', 'data: {"t":"!"}']);
    assert.match(lines[4], /^data: \{"done":true,"tokens":4,"ms":\d+,"firstMs":\d+,"tps":\d+(\.\d)?\}$/);
    assert.equal(lines.length, 6);
    assert.equal(lines[5], '');
    const st = await (await fetch(`${base}/status`)).json();
    assert.deepEqual(Object.keys(st), ['loaded', 'model', 'sha256', 'tokensUsed', 'ctx', 'busy']);
    assert.equal(st.tokensUsed, 4);

    // the error shapes are plain json, not sse
    assert.deepEqual(await post(base, '/chat', {}), { status: 400, type: 'application/json', text: '{"error":"need messages"}' });
    assert.deepEqual(await post(base, '/load', {}), { status: 400, type: 'application/json', text: '{"error":"need url, sha256, size, name"}' });
    assert.equal((await post(base, '/nope')).status, 404);
  } finally {
    await api.close(); files.close(); fake.close();
    fs.rmSync(models, { recursive: true, force: true });
  }
});

test('/load with a wrong sha256 ends with the checksum error and leaves no file', async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-conf-'));
  const files = await fileServer(randomBytes(1000));
  const api = await startApiServer({ models, llama: null, allowPrivateUrls: true, startBackend: async () => { throw new Error('must not start'); } });
  try {
    const r = await post(`http://127.0.0.1:${api.port}`, '/load', { url: `http://127.0.0.1:${files.port}/m.gguf`, sha256: 'ab'.repeat(32), size: 1000, name: 'm.gguf' });
    assert.equal(r.text.split('\n\n').at(-2), 'data: {"error":"checksum mismatch; file deleted, load again"}');
    assert.deepEqual(fs.readdirSync(models), []);
    assert.equal((await (await fetch(`http://127.0.0.1:${api.port}/status`)).json()).busy, false);
  } finally {
    await api.close(); files.close();
    fs.rmSync(models, { recursive: true, force: true });
  }
});

test('/stop cancels a chat in flight', async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-conf-'));
  const model = randomBytes(10);
  const files = await fileServer(model);
  const fake = await fakeLlama(['a', 'b'], 5, true);
  const api = await startApiServer({ models, llama: null, allowPrivateUrls: true, startBackend: async () => ({ port: fake.port, stop: async () => {} }) });
  const base = `http://127.0.0.1:${api.port}`;
  try {
    await post(base, '/load', { url: `http://127.0.0.1:${files.port}/m`, sha256: createHash('sha256').update(model).digest('hex'), size: 10, name: 'm' });
    const res = await fetch(`${base}/chat`, { method: 'POST', body: '{"messages":[{"role":"user","content":"go"}]}' });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    // on a loaded machine the second token can arrive in the same read: the first one leads
    assert.ok(first.startsWith('data: {"t":"a"}\n\n'), first);
    assert.equal((await (await fetch(`${base}/status`)).json()).busy, true);
    assert.equal(await (await fetch(`${base}/stop`, { method: 'POST' })).text(), '{"ok":true,"wasBusy":true}');
    let rest = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    const last = rest.split('\n\n').at(-2)!;
    assert.match(last, /^data: \{"done":true,"tokens":\d+,"ms":\d+,"firstMs":\d+,"tps":0,"stopped":true\}$/);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fake.aborted(), true, 'the upstream request was torn down');
    assert.equal((await (await fetch(`${base}/status`)).json()).busy, false);
    assert.equal(await (await fetch(`${base}/stop`, { method: 'POST' })).text(), '{"ok":true,"wasBusy":false}');
  } finally {
    await api.close(); files.close(); fake.close();
    fs.rmSync(models, { recursive: true, force: true });
  }
});

test('the gate answers NO busy to a second rpc peer and OK to the same ip again', async (t) => {
  // a second source address: 127.0.0.2 is bound on linux without setup; elsewhere this is skipped
  const other = await new Promise<boolean>((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(0, '127.0.0.2', () => s.close(() => r(true))); });
  if (!other) { t.skip('no 127.0.0.2 on this machine'); return; }
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  const echoPort = (echo.address() as net.AddressInfo).port;
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 's', targets: () => echoPort });
  const dial = (localAddress: string) => new Promise<net.Socket>((res, rej) => { const s = net.connect({ host: '127.0.0.1', port: gate.port, localAddress }); s.once('connect', () => res(s)); s.once('error', rej); });
  const a = await dial('127.0.0.1');
  const a2 = await dial('127.0.0.1');
  const b = await dial('127.0.0.2');
  const b2 = await dial('127.0.0.2');
  try {
    await handshake(a, 's', 'rpc');
    await handshake(a2, 's', 'rpc');
    await assert.rejects(handshake(b, 's', 'rpc'), (e: Error) => e instanceof GateRefused && e.reason === 'busy');
    await handshake(b2, 's', 'api');
    a.destroy(); a2.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const c = await dial('127.0.0.2');
    await handshake(c, 's', 'rpc');
    c.destroy();
  } finally {
    for (const s of [a, a2, b, b2]) s.destroy();
    await gate.close();
    echo.close();
  }
});

// GET /blob?mb=N: the bench's tunnel speed test. ApiServer.kt writes the same status line
// fields, headers and bytes (its blobMb follows these cases); the raw http is read here so
// the headers are what is on the wire, not what fetch() makes of them.
function rawGet(port: number, p: string): Promise<{ head: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    const parts: Buffer[] = [];
    s.on('data', (d) => parts.push(d));
    s.on('end', () => {
      const all = Buffer.concat(parts);
      const cut = all.indexOf('\r\n\r\n');
      resolve({ head: all.subarray(0, cut).toString('latin1'), body: all.subarray(cut + 4) });
    });
    s.on('error', reject);
  });
}

test('/blob?mb=N sends N MB of zeros with a fixed length; bad N is a json 400; N is capped at 64', async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-conf-'));
  const api = await startApiServer({ models, llama: null, startBackend: async () => { throw new Error('must not start'); } });
  try {
    const r = await rawGet(api.port, '/blob?mb=2');
    assert.match(r.head, /^HTTP\/1\.1 200 OK\r\n/);
    assert.match(r.head, /\r\ncontent-type: application\/octet-stream\r\n/i);
    assert.match(r.head, /\r\ncontent-length: 2097152\r\n/i);
    assert.match(r.head, /\r\ncache-control: no-store\r\n/i);
    assert.equal(r.body.length, 2 * 1024 * 1024);
    assert.ok(r.body.every((b) => b === 0));
    for (const bad of ['/blob', '/blob?mb=', '/blob?mb=0', '/blob?mb=-1', '/blob?mb=1.5', '/blob?mb=x']) {
      const res = await fetch(`http://127.0.0.1:${api.port}${bad}`);
      assert.deepEqual({ status: res.status, type: res.headers.get('content-type'), text: await res.text() }, { status: 400, type: 'application/json', text: '{"error":"need mb"}' }, bad);
    }
    const ac = new AbortController();
    const capped = await fetch(`http://127.0.0.1:${api.port}/blob?mb=9999999999`, { signal: ac.signal });
    assert.equal(capped.headers.get('content-length'), String(BLOB_MAX_MB * 1024 * 1024));
    ac.abort();
    assert.equal((await fetch(`http://127.0.0.1:${api.port}/blob?mb=1`, { method: 'POST' })).status, 404);
    // the cases ApiServer.kt's blobMb copies
    assert.deepEqual(['1', '007', '64', '65', '1000000000', '0', '', 'x', '-3', '2.0', null].map(blobMb), [1, 7, 64, 64, 64, null, null, null, null, null, null]);
  } finally {
    await api.close();
    fs.rmSync(models, { recursive: true, force: true });
  }
});

test("/blob through the gate's api channel arrives whole (what the bench times)", async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-conf-'));
  const api = await startApiServer({ models, llama: null });
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 'sb', targets: (ch) => (ch === 'api' ? api.port : null) });
  const tunnel = new Tunnel('127.0.0.1', gate.port, 'sb', 'api');
  const port = await tunnel.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/blob?mb=10`);
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, 10 * 1024 * 1024);
  } finally {
    await tunnel.close(); await gate.close(); await api.close();
    fs.rmSync(models, { recursive: true, force: true });
  }
});
