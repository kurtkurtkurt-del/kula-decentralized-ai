// The relay end to end: a worker (the real worker api with a fake llama-server behind
// the real gate, protocol v2) registers; a master far away connects with the code; an
// apart mode chat goes through; the relay saw only tls records. Then the rules: a code
// dies after its time and a new one is issued, one master at a time, wrong codes are
// rate limited, a code-only peer learns the fingerprint through the pin proof and a
// wrong pin is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startApiServer } from '../src/api.ts';
import { startGateServer, GateRefused, type GateEvent } from '../src/gate.ts';
import { createIdentity, Paired } from '../src/tls.ts';
import { startRelay } from '../relay/src/server.ts';
import { startRelayWorker, RelayMaster, RelayTunnel, probeRelay, normalizeRelayUrl } from '../src/relay.ts';
import { apiChat, readSse } from '../src/apart.ts';
import { serveModel } from '../src/modelserve.ts';

const PIECES = ['Guten', ' Morgen', ' aus', ' Berlin'];
const SECRET_TEXT = 'the bread is fresh';

function fakeLlamaServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const t = setInterval(() => {
        if (i < PIECES.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: PIECES[i++] } }] })}\n\n`);
        else { res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: PIECES.length } })}\n\ndata: [DONE]\n\n`); res.end(); clearInterval(t); }
      }, 2);
      req.on('close', () => clearInterval(t));
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as any).port, close: () => s.close() }));
  });
}

// a worker like `kula-node share --tls`, without llama.cpp
async function fakeWorker(pin: string | null, events: GateEvent[] = []) {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-relay-w-'));
  const llama = await fakeLlamaServer();
  const api = await startApiServer({ models, llama: null, startBackend: async () => ({ port: llama.port, stop: async () => {} }) });
  const identity = createIdentity('worker-berlin');
  const tls = { identity, paired: new Paired(null), pin, onPinUsed: () => {} };
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: 'unused-v1-secret', targets: (ch) => (ch === 'api' ? api.port : null), tls, onEvent: (e) => events.push(e) });
  return {
    identity, tls, gate, api, events,
    close: async () => { await gate.close(); await api.close(); llama.close(); fs.rmSync(models, { recursive: true, force: true }); },
  };
}

// a 64 KB "model" the worker fetches from this computer's disk, as apart mode would serve it
const loadThrough = async (port: number) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-relay-m-'));
  const file = path.join(dir, 'tiny.gguf');
  const bytes = randomBytes(65536);
  fs.writeFileSync(file, bytes);
  const served = await serveModel(file, '127.0.0.1', '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: served.url, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, name: 'tiny.gguf', ctx: 512 }) });
    let last: any = null;
    await readSse(res, (o) => { last = o; });
    return last;
  } finally {
    await served.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('relay: an apart chat from far away goes through, and the relay saw only tls records', async () => {
  const seen: Buffer[] = [];
  const relay = await startRelay({ port: 0, host: '127.0.0.1', tap: (_d, b) => seen.push(b) });
  const w = await fakeWorker('0123456789abcdef');
  const codes: string[] = [];
  const worker = await startRelayWorker({ url: relay.url, id: 'worker-berlin', name: 'berlin phone', fp: w.identity.fp, gatePort: w.gate.port, onCode: (c) => codes.push(c) });
  let tunnel: RelayTunnel | null = null;
  try {
    assert.match(worker.code!, /^\d{6}$/);
    assert.equal(codes[0], worker.code);
    const master = createIdentity('master-istanbul');
    tunnel = new RelayTunnel({ url: relay.url, code: worker.code! }, 'api', { identity: master, fp: w.identity.fp, pin: '0123456789abcdef' });
    const port = await tunnel.listen();
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as any;
    assert.equal(status.busy, false);
    // the first connection paired us: the worker now knows our certificate, the pin is spent
    assert.ok(w.tls.paired.has(master.fp));
    assert.equal(w.tls.pin, null);
    assert.equal(w.events.filter((e) => e.type === 'pair').length, 1);
    // the api sees the relay's local leg, not a lan address
    assert.equal(w.events.find((e) => e.type === 'open')?.peer, '127.0.0.1');
    const dev = { id: 'w', name: 'berlin phone', local: false, apiPort: port, bw: 4, busy: false, tps: null, done: 0, close: async () => {} };
    const done = await loadThrough(port);
    assert.equal(done.done, true, JSON.stringify(done));
    const tokens: string[] = [];
    const reply = await apiChat(dev, [{ role: 'user', content: SECRET_TEXT }], (t) => tokens.push(t), { maxTokens: 32, temperature: 0.2 });
    assert.equal(reply.text, PIECES.join(''));
    assert.deepEqual(tokens, PIECES);
    assert.equal(reply.tokens, PIECES.length);
    // what crossed the relay: ciphertext only
    assert.ok(seen.length > 4, 'the relay carried frames');
    const all = Buffer.concat(seen).toString('latin1');
    for (const clear of [SECRET_TEXT, PIECES.join(''), 'KULA2', 'OK ', '/chat', 'HTTP/1.1', master.fp, w.identity.fp]) assert.ok(!all.includes(clear), `the relay saw "${clear}"`);
    for (const b of seen) assert.ok([0x14, 0x16, 0x17].includes(b[0]), `a frame that is not a tls record: 0x${b[0].toString(16)}`);
    assert.ok(relay.stats().bytes > 1000);
    assert.deepEqual(relay.stats().sessions, 1);
  } finally {
    await tunnel?.close();
    await worker.close();
    await w.close();
    await relay.close();
  }
});

test('relay: a code lives its time, then a new one is issued and the old one is unknown', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', codeTtlMs: 300 });
  const w = await fakeWorker(null);
  const codes: string[] = [];
  const worker = await startRelayWorker({ url: relay.url, id: 'w2', name: 'w2', fp: w.identity.fp, gatePort: w.gate.port, onCode: (c) => codes.push(c) });
  try {
    const first = worker.code!;
    const m = await RelayMaster.connect(relay.url, first);
    m.close();
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(codes.length >= 2, `a new code came: ${codes.join(',')}`);
    assert.notEqual(worker.code, first);
    await assert.rejects(RelayMaster.connect(relay.url, first), (e: Error) => e instanceof GateRefused && e.reason === 'unknown code');
    const m2 = await RelayMaster.connect(relay.url, worker.code!);
    assert.equal(m2.worker.id, 'w2');
    m2.close();
  } finally {
    await worker.close();
    await w.close();
    await relay.close();
  }
});

test('relay: one master at a time; the next one gets in once the first is gone', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  const w = await fakeWorker(null);
  const states: string[] = [];
  const worker = await startRelayWorker({ url: relay.url, id: 'w3', name: 'w3', fp: null, gatePort: w.gate.port, onMaster: (s) => states.push(s) });
  try {
    const a = await RelayMaster.connect(relay.url, worker.code!);
    assert.deepEqual(a.worker, { id: 'w3', name: 'w3', fp: null });
    await assert.rejects(RelayMaster.connect(relay.url, worker.code!), (e: Error) => e instanceof GateRefused && e.reason === 'busy');
    a.close();
    await new Promise((r) => setTimeout(r, 100));
    const b = await RelayMaster.connect(relay.url, worker.code!);
    b.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(states, ['connected', 'gone', 'connected', 'gone']);
  } finally {
    await worker.close();
    await w.close();
    await relay.close();
  }
});

test('relay: wrong codes are rate limited per ip, a six digit code is the only shape', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', badCodesPerMinute: 3 });
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(RelayMaster.connect(relay.url, '000000'), (e: Error) => e instanceof GateRefused && e.reason === 'unknown code');
    await assert.rejects(RelayMaster.connect(relay.url, '000000'), (e: Error) => e instanceof GateRefused && e.reason === 'rate limited');
    await assert.rejects(RelayMaster.connect(relay.url, '12345'), /six digits/);
    assert.equal(normalizeRelayUrl('https://relay.example/ws'), 'wss://relay.example/ws');
    assert.throws(() => normalizeRelayUrl('relay.example'), /wss/);
  } finally {
    await relay.close();
  }
});

test('relay: a code-only peer learns the fingerprint through the pin proof; a wrong pin or no pin is refused', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  const w = await fakeWorker('feedfacefeedface');
  const worker = await startRelayWorker({ url: relay.url, id: 'w5', name: 'w5', fp: w.identity.fp, gatePort: w.gate.port });
  try {
    const master = createIdentity('master-code-only');
    const ref = { url: relay.url, code: worker.code! };
    // no fingerprint and no pin: nothing to trust by
    const none = await probeRelay(ref, 'api', { identity: master, fp: '', pin: null });
    assert.deepEqual(none, { ok: false, reason: 'not paired' });
    const bad = await probeRelay(ref, 'api', { identity: master, fp: '', pin: 'ffffffffffffffff' });
    assert.deepEqual(bad, { ok: false, reason: 'wrong pin' });
    assert.equal(w.tls.pin, 'feedfacefeedface', 'a wrong pin does not spend the code');
    const good = await probeRelay(ref, 'api', { identity: master, fp: '', pin: 'feedfacefeedface' });
    assert.ok(good.ok, JSON.stringify(good));
    assert.equal(good.ok && good.fp, w.identity.fp, 'the fingerprint learned is the worker\'s');
    assert.equal(good.ok && good.worker.name, 'w5');
    // from now on the learned fingerprint is pinned and no pin is needed
    const again = await probeRelay(ref, 'api', { identity: master, fp: w.identity.fp, pin: null });
    assert.ok(again.ok);
    const other = await probeRelay(ref, 'api', { identity: master, fp: 'ab'.repeat(32), pin: null });
    assert.deepEqual(other, { ok: false, reason: 'fingerprint mismatch' });
  } finally {
    await worker.close();
    await w.close();
    await relay.close();
  }
});
