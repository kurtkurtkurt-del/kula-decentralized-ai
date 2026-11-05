import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startApiServer } from '../src/api.ts';
import { startGateServer, Tunnel } from '../src/gate.ts';

// a file server that honours Range, standing in for a model host
function fileServer(body: Buffer): Promise<{ port: number; close: () => void; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      hits.push(req.headers.range ?? 'full');
      const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      if (m) {
        const from = Number(m[1]);
        res.writeHead(206, { 'content-length': body.length - from, 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` });
        res.end(body.subarray(from));
      } else {
        res.writeHead(200, { 'content-length': body.length });
        res.end(body);
      }
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as any).port, close: () => s.close(), hits }));
  });
}

// a stand in for llama-server's /v1/chat/completions stream
function fakeLlamaServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const pieces = ['Hel', 'lo', ' there', '!'];
      let i = 0;
      const t = setInterval(() => {
        if (i < pieces.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: 4 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(t);
        }
      }, 10);
      req.on('close', () => clearInterval(t));
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as any).port, close: () => s.close() }));
  });
}

async function sse(url: string, body: unknown): Promise<any[]> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}

test('status, load (download + sha256 + backend start) and chat through the gate', async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-models-'));
  const model = randomBytes(300_000);
  const sha = createHash('sha256').update(model).digest('hex');
  const files = await fileServer(model);
  const fake = await fakeLlamaServer();
  const started: string[] = [];
  const api = await startApiServer({
    models, llama: null, allowPrivateUrls: true,
    startBackend: async (file, ctx) => { started.push(`${path.basename(file)}:${ctx}`); return { port: fake.port, stop: async () => {} }; },
  });
  // reach it the way a phone would: through the gate on the api channel
  const SECRET = 'abc';
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: SECRET, targets: (ch) => (ch === 'api' ? api.port : null) });
  const tunnel = new Tunnel('127.0.0.1', gate.port, SECRET, 'api');
  const base = `http://127.0.0.1:${await tunnel.listen()}`;
  try {
    let st = await (await fetch(`${base}/status`)).json();
    assert.deepEqual(st, { loaded: false, model: null, sha256: null, tokensUsed: 0, ctx: 0, busy: false });

    // chat before a model is loaded
    assert.equal((await fetch(`${base}/chat`, { method: 'POST', body: '{"messages":[]}' })).status, 409);

    // a leftover partial download is resumed with a Range request
    fs.writeFileSync(path.join(models, 'tiny.gguf.part'), model.subarray(0, 100_000));
    const ev = await sse(`${base}/load`, { url: `http://127.0.0.1:${files.port}/tiny.gguf`, sha256: sha, size: model.length, name: 'tiny.gguf', ctx: 2048 });
    const states = [...new Set(ev.filter((e) => e.state).map((e) => e.state))];
    assert.deepEqual(states, ['running', 'checking', 'loading']);
    assert.deepEqual(ev.at(-1), { done: true, ctx: 2048, sha256: sha });
    assert.equal(files.hits[0], 'bytes=100000-');
    assert.ok(fs.readFileSync(path.join(models, 'tiny.gguf')).equals(model));
    assert.deepEqual(started, ['tiny.gguf:2048']);

    st = await (await fetch(`${base}/status`)).json();
    assert.equal(st.loaded, true);
    assert.equal(st.model, 'tiny.gguf');
    assert.equal(st.ctx, 2048);

    const chat = await sse(`${base}/chat`, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 });
    assert.equal(chat.filter((e) => e.t).map((e) => e.t).join(''), 'Hello there!');
    const done = chat.at(-1);
    assert.equal(done.done, true);
    assert.equal(done.tokens, 4);
    assert.ok(done.ms >= done.firstMs && done.firstMs > 0);
    assert.equal((await (await fetch(`${base}/status`)).json()).tokensUsed, 4);

    // a wrong sha256 is refused and the file removed
    const bad = await sse(`${base}/load`, { url: `http://127.0.0.1:${files.port}/x.gguf`, sha256: 'ff'.repeat(32), size: model.length, name: 'x.gguf' });
    assert.equal(bad.at(-1).error, 'checksum mismatch; file deleted, load again');
    assert.ok(!fs.existsSync(path.join(models, 'x.gguf')));

    // a second load of the same file reuses it (checking only, no download)
    const again = await sse(`${base}/load`, { url: `http://127.0.0.1:${files.port}/tiny.gguf`, sha256: sha, size: model.length, name: 'tiny.gguf' });
    assert.ok(!again.some((e) => e.state === 'running'));
    assert.equal(again.at(-1).done, true);
    assert.equal(again.at(-1).ctx, 4096);

    assert.equal((await (await fetch(`${base}/stop`, { method: 'POST' })).json()).ok, true);
  } finally {
    await tunnel.close();
    await gate.close();
    await api.close();
    files.close();
    fake.close();
    fs.rmSync(models, { recursive: true, force: true });
  }
});

test('a client that drops mid-chat frees busy and aborts the upstream request', async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-models-'));
  const fake = await fakeLlamaServer();
  const api = await startApiServer({ models, llama: null, allowPrivateUrls: true, startBackend: async () => ({ port: fake.port, stop: async () => {} }) });
  const base = `http://127.0.0.1:${api.port}`;
  try {
    // put a model in place without a download: a zero byte file with its own sha
    const empty = createHash('sha256').update('').digest('hex');
    fs.writeFileSync(path.join(models, 'e.gguf'), '');
    const ev = await sse(`${base}/load`, { url: 'http://127.0.0.1:1/none', sha256: empty, size: 0, name: 'e.gguf' });
    assert.equal(ev.at(-1).done, true);

    const ac = new AbortController();
    const res = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read(); // the first token
    assert.equal((await (await fetch(`${base}/status`)).json()).busy, true);
    ac.abort();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await (await fetch(`${base}/status`)).json()).busy, false, 'busy cleared after the client went away');
    // and the next chat goes through
    const chat = await sse(`${base}/chat`, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(chat.at(-1).done, true);
    // unload is refused while a chat runs
    const ac2 = new AbortController();
    const res2 = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }), signal: ac2.signal });
    await res2.body!.getReader().read();
    assert.equal((await fetch(`${base}/unload`, { method: 'POST' })).status, 409);
    ac2.abort();
  } finally {
    await api.close();
    fake.close();
    fs.rmSync(models, { recursive: true, force: true });
  }
});
