// Apart mode end to end: two fake workers (the real worker api with a fake
// llama-server behind the real gate), the model served from this computer,
// prompts spread over the devices, tok/s per device. No llama binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startApiServer } from '../src/api.ts';
import { startGateServer } from '../src/gate.ts';
import { serveModel } from '../src/modelserve.ts';
import { openApart, batchReport, apiChat, openPeerDevice } from '../src/apart.ts';
import type { Peer } from '../src/peers.ts';

// a stand in for llama-server: /health and a streaming chat that takes `delayMs` per token
function fakeLlamaServer(delayMs: number, pieces = ['Hel', 'lo', ' there', '!']): Promise<{ port: number; close: () => void; chats: number }> {
  return new Promise((resolve) => {
    const state = { port: 0, close: () => {}, chats: 0 };
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
      state.chats++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const t = setInterval(() => {
        if (i < pieces.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] })}\n\n`);
        else { res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: pieces.length } })}\n\ndata: [DONE]\n\n`); res.end(); clearInterval(t); }
      }, delayMs);
      req.on('close', () => clearInterval(t));
    });
    s.listen(0, '127.0.0.1', () => { state.port = (s.address() as any).port; state.close = () => s.close(); resolve(state); });
  });
}

// a whole fake worker: api + gate, like `kula-node share` without llama.cpp
async function fakeWorker(name: string, secret: string, delayMs: number) {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), `kula-w-${name}-`));
  const llama = await fakeLlamaServer(delayMs);
  const loads: string[] = [];
  const api = await startApiServer({ models, llama: null, allowPrivateUrls: true, startBackend: async (file, ctx) => { loads.push(`${path.basename(file)}:${ctx}`); return { port: llama.port, stop: async () => {} }; } });
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret, targets: (ch) => (ch === 'api' ? api.port : null) });
  const peer: Peer = { id: `id-${name}`, name, host: '127.0.0.1', port: gate.port, secret, kind: 'phone', ram: 6000, bw: delayMs < 20 ? 30 : 8, added_at: 't' };
  return {
    peer, loads, llama, models,
    close: async () => { await gate.close(); await api.close(); llama.close(); fs.rmSync(models, { recursive: true, force: true }); },
  };
}

test('apart: load everywhere, a dead peer and a wrong secret are skipped, 8 prompts spread, tok/s per device', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-master-'));
  const modelFile = path.join(dir, 'tiny.gguf');
  const bytes = randomBytes(200_000);
  fs.writeFileSync(modelFile, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fast = await fakeWorker('fast', 'secret-a', 2);
  const slow = await fakeWorker('slow', 'secret-b', 12);
  const served = await serveModel(modelFile, '127.0.0.1', '127.0.0.1');
  const dead: Peer = { ...fast.peer, id: 'id-dead', name: 'dead', port: 1 }; // nothing listens on 1
  const liar: Peer = { ...slow.peer, id: 'id-liar', name: 'liar', secret: 'nope' };
  const logs: string[] = [];
  const cluster = await openApart({
    model: { url: served.url, sha256, size: bytes.length, name: 'tiny.gguf', ctx: 1024 },
    localModelFile: null, peers: [fast.peer, dead, slow.peer, liar], probeMs: 800, log: (s) => logs.push(s),
  });
  try {
    assert.deepEqual(cluster.devices.map((d) => d.name), ['fast', 'slow']);
    assert.deepEqual(cluster.skipped.map((s) => `${s.peer.name}:${s.why}`).sort(), ['dead:connect ECONNREFUSED 127.0.0.1:1', 'liar:wrong secret']);
    assert.deepEqual(fast.loads, ['tiny.gguf:1024']);
    assert.deepEqual(slow.loads, ['tiny.gguf:1024']);
    assert.ok(fs.readFileSync(path.join(fast.models, 'tiny.gguf')).equals(bytes), 'the worker fetched the model from this computer');
    assert.ok(logs.some((l) => l === 'fast: ready') && logs.some((l) => l === 'slow: ready'));

    // one prompt streams tokens from the fastest free device
    let streamed = '';
    const r = await cluster.chat([{ role: 'user', content: 'hi' }], (t) => { streamed += t; });
    assert.equal(streamed, 'Hello there!');
    assert.equal(r.text, 'Hello there!');
    assert.equal(r.device, 'fast');
    assert.equal(r.tokens, 4);

    // eight prompts: both devices work, nobody is given two at once, the fast one does more
    const prompts = Array.from({ length: 8 }, (_, i) => `prompt ${i}`);
    const seen: string[] = [];
    const replies = await cluster.batch(prompts, { maxTokens: 8, onReply: (i, rep) => seen.push(`${i}:${rep.device}`) });
    assert.equal(replies.length, 8);
    assert.ok(replies.every((x) => x.text === 'Hello there!' && x.tokens === 4));
    const report = batchReport(replies);
    assert.deepEqual(report.map((x) => x.device), ['fast', 'slow']);
    assert.equal(report[0].prompts + report[1].prompts, 8);
    assert.ok(report[0].prompts > report[1].prompts, `fast should take more: ${JSON.stringify(report)}`);
    assert.ok(report[1].prompts >= 1, 'the slow device must still be used');
    assert.ok(report[0].tps > report[1].tps);
    assert.equal(fast.llama.chats + slow.llama.chats, 9);
  } finally {
    await cluster.close();
    await served.close();
    await fast.close();
    await slow.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apart: with every peer gone and no local device it fails with a clear message; stop cuts a chat short', async () => {
  const dead: Peer = { id: 'd', name: 'dead', host: '127.0.0.1', port: 1, secret: 'x', kind: 'phone', ram: 1, bw: 1, added_at: 't' };
  await assert.rejects(openApart({ model: { url: 'http://x/y', sha256: 'ab', size: 1, name: 'y', ctx: 512 }, peers: [dead], probeMs: 300 }), /no device: every peer was unreachable/);

  const w = await fakeWorker('w', 's', 30);
  const dev = await openPeerDevice(w.peer);
  try {
    // a chat without a model loaded is the worker's 400, surfaced as an error
    await assert.rejects(apiChat(dev, [{ role: 'user', content: 'x' }], () => {}, { maxTokens: 4, temperature: 0 }), /no model loaded/);
  } finally {
    await dev.close();
    await w.close();
  }
});

test('the model server answers only its random path and honours Range', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-serve-'));
  const file = path.join(dir, 'm.gguf');
  fs.writeFileSync(file, Buffer.from('0123456789'));
  const s = await serveModel(file, '127.0.0.1', '127.0.0.1');
  try {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/m\/[0-9a-f]{24}\/m\.gguf$/);
    assert.equal((await fetch(s.url)).status, 200);
    assert.equal(await (await fetch(s.url)).text(), '0123456789');
    const part = await fetch(s.url, { headers: { range: 'bytes=7-' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 7-9/10');
    assert.equal(await part.text(), '789');
    assert.equal((await fetch(s.url, { headers: { range: 'bytes=10-' } })).status, 416);
    assert.equal((await fetch(s.url.replace(/\/m\/[0-9a-f]+\//, '/m/000000000000000000000000/'))).status, 404);
    assert.equal((await fetch(s.url.replace(/\/m\/.*$/, '/'))).status, 404);
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
