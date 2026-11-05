// The api's error paths, one per endpoint (5.11.2026): what a phone gets back when it asks
// wrongly, too early, or twice. Status codes and bodies are what ApiServer.kt sends too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startApiServer, type ApiServer } from '../src/api.ts';

type Srv = { port: number; close: () => void };
const listen = (s: http.Server): Promise<Srv> => new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as any).port, close: () => s.close() })));
const fileServer = (body: Buffer, status = 200) => listen(http.createServer((_req, res) => { res.writeHead(status, { 'content-length': status === 200 ? body.length : 0 }); res.end(status === 200 ? body : undefined); }));
const fakeLlama = (status = 200, pieces = ['ok']) => listen(http.createServer((req, res) => {
  if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
  if (status !== 200) { res.writeHead(status); res.end('no slots'); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const p of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}));

async function call(base: string, method: string, p: string, body?: string) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type'), text, events: text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))) };
}

async function withApi(fn: (api: ApiServer, base: string, models: string) => Promise<void>, opts: Partial<Parameters<typeof startApiServer>[0]> = {}) {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-err-'));
  const api = await startApiServer({ models, llama: null, startBackend: async () => { throw new Error('must not start'); }, ...opts });
  try { await fn(api, `http://127.0.0.1:${api.port}`, models); } finally { await api.close(); fs.rmSync(models, { recursive: true, force: true }); }
}

test('an unknown path is 404, a wrong method on a known one too', async () => {
  await withApi(async (_api, base) => {
    assert.deepEqual(await call(base, 'GET', '/nope').then((r) => [r.status, r.text]), [404, '{"error":"not found"}']);
    assert.equal((await call(base, 'GET', '/chat')).status, 404);
    assert.equal((await call(base, 'POST', '/status')).status, 404);
    assert.equal((await call(base, 'GET', '/status?x=1')).status, 200); // a query string is ignored
  });
});

test('/load: a body that is not json, a body without the fields, a bad name', async () => {
  await withApi(async (_api, base) => {
    assert.deepEqual(await call(base, 'POST', '/load', '{nope').then((r) => [r.status, r.text]), [400, '{"error":"bad json"}']);
    assert.deepEqual(await call(base, 'POST', '/load', '').then((r) => [r.status, r.text]), [400, '{"error":"need url, sha256, size, name"}']);
    assert.equal((await call(base, 'POST', '/load', JSON.stringify({ url: 'http://x', sha256: 'ab', size: 1 }))).status, 400);
    assert.equal((await call(base, 'POST', '/load', JSON.stringify({ url: 1, sha256: 'ab', size: 1, name: 'm' }))).status, 400);
    for (const name of ['..', '.', '/', '']) {
      const r = await call(base, 'POST', '/load', JSON.stringify({ url: 'http://x', sha256: 'ab', size: 1, name }));
      assert.equal(r.status, 400, name);
      assert.equal(r.text, '{"error":"bad name"}', name);
    }
    assert.equal((await call(base, 'GET', '/status')).text, '{"loaded":false,"model":null,"sha256":null,"tokensUsed":0,"ctx":0,"busy":false}');
  });
});

test('/load: a path in the name is flattened to its base name', async () => {
  const model = randomBytes(100);
  const files = await fileServer(model);
  const started: string[] = [];
  await withApi(async (_api, base, models) => {
    const r = await call(base, 'POST', '/load', JSON.stringify({ url: `http://127.0.0.1:${files.port}/m`, sha256: createHash('sha256').update(model).digest('hex'), size: 100, name: '../../etc/pass wd.gguf' }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.events.at(-1), { done: true, ctx: 4096, sha256: createHash('sha256').update(model).digest('hex') });
    assert.deepEqual(fs.readdirSync(models), ['pass_wd.gguf']);
    assert.deepEqual(started, [path.join(models, 'pass_wd.gguf')]);
  }, { startBackend: async (file) => { started.push(file); return { port: 1, stop: async () => {} }; } });
  files.close();
});

test('/load: a host that answers 404 ends the stream with an error, leaves no file, frees busy', async () => {
  const files = await fileServer(Buffer.alloc(0), 404);
  await withApi(async (api, base, models) => {
    const r = await call(base, 'POST', '/load', JSON.stringify({ url: `http://127.0.0.1:${files.port}/m`, sha256: 'ab'.repeat(32), size: 10, name: 'm.gguf' }));
    assert.equal(r.status, 200);
    assert.equal(r.type, 'text/event-stream');
    assert.deepEqual(r.events[0], { state: 'running', got: 0, total: 10 });
    assert.ok('error' in r.events.at(-1), JSON.stringify(r.events));
    assert.deepEqual(fs.readdirSync(models).filter((f) => !f.endsWith('.part')), []);
    assert.equal(api.status().busy, false);
    assert.equal(api.status().loaded, false);
  });
  files.close();
});

test('/load: a host nobody listens on is an error, not a hang', async () => {
  const dead = await fileServer(Buffer.alloc(0));
  dead.close();
  await withApi(async (api, base) => {
    const r = await call(base, 'POST', '/load', JSON.stringify({ url: `http://127.0.0.1:${dead.port}/m`, sha256: 'ab'.repeat(32), size: 10, name: 'm.gguf' }));
    assert.ok('error' in r.events.at(-1));
    assert.equal(api.status().busy, false);
  });
});

test('/load: a backend that will not start is reported and nothing is marked loaded', async () => {
  const model = randomBytes(50);
  const files = await fileServer(model);
  await withApi(async (api, base) => {
    const r = await call(base, 'POST', '/load', JSON.stringify({ url: `http://127.0.0.1:${files.port}/m`, sha256: createHash('sha256').update(model).digest('hex'), size: 50, name: 'm.gguf' }));
    assert.deepEqual(r.events.at(-2), { state: 'loading', got: 0, total: 0 });
    assert.deepEqual(r.events.at(-1), { error: 'llama-server exited' });
    assert.equal(api.status().loaded, false);
    assert.equal(api.status().busy, false);
    // without llama.cpp set up and without a test backend: a clear sentence
  }, { startBackend: async () => { throw new Error('llama-server exited'); } });
  await withApi(async (_api, base) => {
    const r = await call(base, 'POST', '/load', JSON.stringify({ url: `http://127.0.0.1:${files.port}/m`, sha256: createHash('sha256').update(model).digest('hex'), size: 50, name: 'm.gguf' }));
    assert.match(r.events.at(-1).error, /kula-node setup/);
  }, { startBackend: undefined });
  files.close();
});

test('/chat before a model: 409 no model loaded; without messages: 400', async () => {
  await withApi(async (_api, base) => {
    assert.deepEqual(await call(base, 'POST', '/chat', '{"messages":[]}').then((r) => [r.status, r.text]), [409, '{"error":"no model loaded"}']);
  });
  const fake = await fakeLlama();
  const model = randomBytes(10);
  const files = await fileServer(model);
  await withApi(async (_api, base) => {
    await call(base, 'POST', '/load', JSON.stringify({ url: `http://127.0.0.1:${files.port}/m`, sha256: createHash('sha256').update(model).digest('hex'), size: 10, name: 'm' }));
    assert.deepEqual(await call(base, 'POST', '/chat', '{}').then((r) => [r.status, r.text]), [400, '{"error":"need messages"}']);
    assert.deepEqual(await call(base, 'POST', '/chat', '{"messages":"hi"}').then((r) => [r.status, r.text]), [400, '{"error":"need messages"}']);
    assert.deepEqual(await call(base, 'POST', '/chat', 'nope').then((r) => [r.status, r.text]), [400, '{"error":"bad json"}']);
    // a sound one still works after the refusals
    const ok = await call(base, 'POST', '/chat', '{"messages":[{"role":"user","content":"hi"}]}');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.events[0], { t: 'ok' });
    assert.equal(ok.events.at(-1).done, true);
  }, { startBackend: async () => ({ port: fake.port, stop: async () => {} }) });
  fake.close(); files.close();
});

test('/chat: a backend that answers 503 ends the stream with its status and frees busy', async () => {
  const fake = await fakeLlama(503);
  const model = randomBytes(10);
  const files = await fileServer(model);
  await withApi(async (api, base) => {
    await call(base, 'POST', '/load', JSON.stringify({ url: `http://127.0.0.1:${files.port}/m`, sha256: createHash('sha256').update(model).digest('hex'), size: 10, name: 'm' }));
    const r = await call(base, 'POST', '/chat', '{"messages":[{"role":"user","content":"hi"}]}');
    assert.equal(r.status, 200);
    assert.deepEqual(r.events, [{ error: 'llama-server: 503 no slots' }]);
    assert.equal(api.status().busy, false);
    assert.equal(api.status().loaded, true);
  }, { startBackend: async () => ({ port: fake.port, stop: async () => {} }) });
  fake.close(); files.close();
});

test('busy: a /load or /unload during a chat is 409 busy; /stop says wasBusy; the second /unload is fine', async () => {
  // a backend that holds the stream open until told
  let release: () => void = () => {};
  const held = await listen(http.createServer((req, res) => {
    if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`);
    release = () => { res.write('data: [DONE]\n\n'); res.end(); };
  }));
  const model = randomBytes(10);
  const files = await fileServer(model);
  let stops = 0;
  await withApi(async (api, base) => {
    await call(base, 'POST', '/load', JSON.stringify({ url: `http://127.0.0.1:${files.port}/m`, sha256: createHash('sha256').update(model).digest('hex'), size: 10, name: 'm' }));
    const chat = fetch(`${base}/chat`, { method: 'POST', body: '{"messages":[{"role":"user","content":"go"}]}' });
    const res = await chat;
    const reader = res.body!.getReader();
    await reader.read(); // the first token: the chat is in flight
    assert.equal(api.status().busy, true);
    assert.deepEqual(await call(base, 'POST', '/load', '{"url":"http://x","sha256":"ab","size":1,"name":"m"}').then((r) => [r.status, r.text]), [409, '{"error":"busy"}']);
    assert.deepEqual(await call(base, 'POST', '/unload').then((r) => [r.status, r.text]), [409, '{"error":"busy"}']);
    assert.deepEqual(await call(base, 'POST', '/chat', '{"messages":[]}').then((r) => [r.status, r.text]), [409, '{"error":"busy"}']);
    release();
    for (;;) { const { done } = await reader.read(); if (done) break; }
    assert.equal(api.status().busy, false);
    assert.equal(api.status().tokensUsed, 1);
    assert.deepEqual(await call(base, 'POST', '/stop').then((r) => [r.status, r.text]), [200, '{"ok":true,"wasBusy":false}']);
    assert.deepEqual(await call(base, 'POST', '/unload').then((r) => [r.status, r.text]), [200, '{"ok":true}']);
    assert.equal(stops, 1);
    assert.equal(api.status().loaded, false);
    assert.deepEqual(await call(base, 'POST', '/unload').then((r) => [r.status, r.text]), [200, '{"ok":true}']);
    assert.equal(stops, 1);
    assert.deepEqual(await call(base, 'POST', '/chat', '{"messages":[]}').then((r) => [r.status, r.text]), [409, '{"error":"no model loaded"}']);
  }, { startBackend: async () => ({ port: held.port, stop: async () => { stops++; } }) });
  held.close(); files.close();
});

test('a body over a megabyte is refused', async () => {
  await withApi(async (api, base) => {
    const r = await call(base, 'POST', '/chat', JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(1_100_000) }] })).catch((e) => ({ status: 0, text: String(e), type: null, events: [] }));
    // either a 400 "body too large" or the socket torn down under the client: never a 200
    assert.notEqual(r.status, 200);
    assert.equal(api.status().busy, false);
  });
});
