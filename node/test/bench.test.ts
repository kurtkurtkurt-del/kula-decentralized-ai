// kula-node bench without llama.cpp: llama-server is a fake that streams /completion with
// llama.cpp's `timings`, the peers are real gates in front of real api servers (whose
// backend is a fake), the split's rpc channel is an echo. Every record must fit
// tools/bench-schema.json; the core is the very file the phone runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { benchTable, readBenches, runBench, saveBench, timedCompletion, type StartServer } from '../src/bench.ts';
import { measuredTps, measuredTunnel, median, series, validate, type BenchRecord } from '../src/benchcore.ts';
import { startGateServer } from '../src/gate.ts';
import { startApiServer } from '../src/api.ts';
import { planSplit, simModel } from '../src/planner.ts';
import { ggufShape } from '../src/gguf.ts';
import type { Peer } from '../src/peers.ts';

const schema = JSON.parse(readFileSync(new URL('../../tools/bench-schema.json', import.meta.url), 'utf8'));

test('the bench core is the very file the phone runs', () => {
  const here = readFileSync(new URL('../src/benchcore.ts', import.meta.url), 'utf8');
  const phone = readFileSync(new URL('../../app/src/bench/core.ts', import.meta.url), 'utf8');
  assert.equal(here, phone, 'node/src/benchcore.ts must be a copy of app/src/bench/core.ts (cp it)');
});

type Srv = { port: number; close: () => Promise<void> };
const listen = (s: http.Server | net.Server): Promise<Srv> => new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as net.AddressInfo).port, close: () => new Promise<void>((c) => s.close(() => c())) })));

// llama-server as far as the bench and the api use it: /health, /completion (stream, timings), /v1/chat/completions
function fakeLlama(genTps: number[]): Promise<Srv & { calls: () => number }> {
  let calls = 0;
  const s = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('{"status":"ok"}'); return; }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.url === '/completion') {
        const tps = genTps[calls++ % genTps.length];
        const n = JSON.parse(body).n_predict;
        res.write(`data: ${JSON.stringify({ content: 'a' })}\n\n`);
        res.write(`data: ${JSON.stringify({ content: 'b' })}\n\n`);
        res.end(`data: ${JSON.stringify({ content: '', stop: true, timings: { prompt_n: 120, prompt_ms: 100, prompt_per_second: 1200, predicted_n: n, predicted_ms: (n / tps) * 1000, predicted_per_second: tps } })}\n\n`);
      } else {
        for (const p of ['x', 'y', 'z']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
      }
    });
  });
  return listen(s).then((x) => Object.assign(x, { calls: () => calls }));
}

async function worker(name: string, secret: string) {
  const llama = await fakeLlama([50]);
  const models = fs.mkdtempSync(path.join(os.tmpdir(), `kula-bench-${name}-`));
  const api = await startApiServer({ models, llama: null, allowPrivateUrls: true, startBackend: async () => ({ port: llama.port, stop: async () => {} }) });
  const echo = await listen(net.createServer((c) => c.pipe(c)));
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret, targets: (ch) => (ch === 'api' ? api.port : echo.port) });
  const peer: Peer = { id: `id-${name}`, name, host: '127.0.0.1', port: gate.port, secret, kind: 'pc', ram: 6000, bw: 60, added_at: 't' };
  return { peer, close: async () => { await gate.close(); await api.close(); await echo.close(); await llama.close(); fs.rmSync(models, { recursive: true, force: true }); } };
}

// a real gguf header (v3, no tensors) padded to `size`: arch, blocks, width, heads, file type, a vocabulary
function tinyGguf(file: string, size: number) {
  const parts: Buffer[] = [];
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  const kvs: Buffer[] = [
    Buffer.concat([str('general.architecture'), u32(8), str('qwen3')]),
    Buffer.concat([str('qwen3.block_count'), u32(4), u32(4)]),
    Buffer.concat([str('qwen3.embedding_length'), u32(4), u32(64)]),
    Buffer.concat([str('qwen3.attention.head_count'), u32(4), u32(4)]),
    Buffer.concat([str('qwen3.attention.head_count_kv'), u32(4), u32(2)]),
    Buffer.concat([str('general.file_type'), u32(4), u32(7)]),
    Buffer.concat([str('tokenizer.ggml.tokens'), u32(9), u32(8), u64(100), ...Array.from({ length: 100 }, (_, i) => str(`t${i}`))]),
    Buffer.concat([str('tokenizer.ggml.scores'), u32(9), u32(6), u64(100), Buffer.alloc(400)]),
  ];
  parts.push(Buffer.from('GGUF'), u32(3), u64(0), u64(kvs.length), ...kvs);
  const head = Buffer.concat(parts);
  fs.writeFileSync(file, Buffer.concat([head, Buffer.alloc(size - head.length, 7)]));
}

test('the gguf reader takes the shape from the header and guesses from the size without one', (t) => {
  const dir = tmpHome(t);
  tinyGguf(path.join(dir, 'x.gguf'), 4096);
  assert.deepEqual(ggufShape(path.join(dir, 'x.gguf')), { arch: 'qwen3', layers: 4, hidden: 64, vocab: 100, kvMbPer1k: 1, quant: 'Q8_0', bytesPerParam: 1, guessed: false });
  fs.writeFileSync(path.join(dir, 'y-Q4_K_M.gguf'), Buffer.alloc(4096));
  const g = ggufShape(path.join(dir, 'y-Q4_K_M.gguf'));
  assert.equal(g.guessed, true);
  assert.equal(g.quant, 'Q4_K_M');
});

function tmpHome(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-bench-home-'));
  const before = process.env.KULA_NODE_HOME;
  process.env.KULA_NODE_HOME = dir;
  t.after(() => { if (before === undefined) delete process.env.KULA_NODE_HOME; else process.env.KULA_NODE_HOME = before; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('timedCompletion reads prompt and decoding speeds from llama-server timings', async () => {
  const llama = await fakeLlama([42]);
  try {
    const t = await timedCompletion(llama.port, 16);
    assert.equal(t.promptN, 120);
    assert.equal(t.promptTps, 1200);
    assert.equal(t.genN, 16);
    assert.equal(t.genTps, 42);
    assert.ok(Math.abs(t.tokenMs - 1000 / 42) < 0.01);
    assert.ok(t.firstMs > 0);
  } finally { await llama.close(); }
});

test('bench with a model and two peers: local, gate, tunnel, apart and split, a valid record, a table', async (t) => {
  const home = tmpHome(t);
  const model = path.join(home, 'tiny-Q8_0.gguf');
  tinyGguf(model, 2 * 1024 * 1024);
  const a = await worker('a', 'sa');
  const b = await worker('b', 'sb');
  const local = await fakeLlama([100, 90, 110]);
  const started: string[][] = [];
  const startServer: StartServer = async (args) => { started.push(args(9)); return { port: local.port, stop: async () => {} }; };
  const logs: string[] = [];
  try {
    const r = await runBench({
      modelFile: model, peers: [a.peer, b.peer], llama: null, startServer, measureBw: async () => 61.5,
      genTokens: 8, tunnelMb: 2, serveHost: '127.0.0.1', log: (s) => logs.push(s), now: () => new Date('2026-11-05T09:00:00Z'),
    });
    assert.deepEqual(validate(schema, r), []);
    assert.equal(r.source, 'node');
    assert.equal(r.model?.file, 'tiny-Q8_0.gguf');
    assert.equal(r.model?.quant, 'Q8_0');
    assert.equal(r.model?.layers, 4);
    assert.equal(r.local.mem_bw_gbs, 61.5);
    assert.deepEqual(r.local.gen, { unit: 'tok/s', runs: [100, 90, 110], median: 100, tokens: 8 });
    assert.equal(r.local.prompt?.median, 1200);
    assert.equal(r.local.prompt?.tokens, 120);
    assert.equal(r.local.first_token_ms?.runs.length, 3);
    assert.deepEqual(r.peers.map((p) => [p.id, p.loopback, p.error]), [['id-a', false, null], ['id-b', false, null]]);
    for (const p of r.peers) {
      assert.equal(p.gate_rtt_ms?.runs.length, 3);
      assert.ok((p.tunnel_mb_s ?? 0) > 0);
      assert.equal(p.tunnel_mb, 2);
      assert.equal(p.apart?.gen.runs.length, 3);
      assert.equal(p.apart?.gen.tokens, 3);
    }
    // the split ran over both peers' rpc channels with --rpc and --tensor-split
    assert.ok(r.split, JSON.stringify(r.skipped));
    assert.ok(r.split!.peers.length >= 1);
    assert.equal(r.split!.token_ms.runs.length, 3);
    assert.ok(r.split!.tps > 0);
    const splitArgs = started.find((x) => x.includes('--rpc'))!;
    assert.match(splitArgs[splitArgs.indexOf('--rpc') + 1], /^127\.0\.0\.1:\d+/);
    assert.ok(!started[0].includes('--rpc'), 'the local run is alone');
    assert.ok(started.every((x) => x[x.indexOf('--host') + 1] === '127.0.0.1'));
    // the peers fetched the model from here and verified it
    assert.ok(logs.some((l) => l.includes('hashing the model')));
    const table = benchTable(r);
    for (const k of ['memory bandwidth', 'generation', 'a: gate rtt', 'b: tunnel', 'a: apart', 'split']) assert.match(table, new RegExp(k));
    // saved per day, a second run that day gets -2; read back oldest first
    const f1 = saveBench(r);
    const f2 = saveBench({ ...r, at: '2026-11-05T10:00:00.000Z' });
    assert.equal(path.basename(f1), '2026-11-05.json');
    assert.equal(path.basename(f2), '2026-11-05-2.json');
    assert.equal(path.dirname(f1), path.join(home, 'bench'));
    const back = readBenches();
    assert.equal(back.length, 2);
    assert.equal(measuredTps(back, 'self', { id: r.model!.id }), 100);
    assert.equal(measuredTps(back, 'id-a', { id: 'other', file: 'tiny-Q8_0.gguf', size: 2 * 1024 * 1024 }), r.peers[0].apart!.gen.median);
    assert.equal(measuredTunnel(back, 'id-b'), r.peers[1].tunnel_mb_s);
  } finally {
    await a.close(); await b.close(); await local.close();
  }
});

test('bench without llama.cpp and without peers: loopback gate and tunnel, the rest skipped with a reason', async (t) => {
  const home = tmpHome(t);
  const model = path.join(home, 'm.gguf');
  fs.writeFileSync(model, Buffer.alloc(1024));
  const r = await runBench({ modelFile: model, peers: [], llama: null, measureBw: async () => 0, tunnelMb: 1 });
  assert.deepEqual(validate(schema, r), []);
  assert.equal(r.local.gen, null);
  assert.equal(r.local.mem_bw_gbs, null);
  assert.equal(r.peers.length, 1);
  assert.equal(r.peers[0].loopback, true);
  assert.equal(r.peers[0].gate_rtt_ms?.runs.length, 3);
  assert.ok((r.peers[0].tunnel_mb_s ?? 0) > 0);
  const why = Object.fromEntries(r.skipped.map((s) => [s.what, s.why]));
  assert.match(why.gen, /kula-node setup/);
  assert.match(why.split, /kula-node setup/);
  assert.match(why.apart, /no peers/);
  assert.match(why.mem_bw, /failed/);
  assert.equal(r.split, null);
  // the loopback row is never a peer's measurement
  assert.equal(measuredTunnel([r], 'loopback'), null);
});

test('a dead peer is reported with the reason and does not stop the bench', async (t) => {
  tmpHome(t);
  const dead: Peer = { id: 'dead', name: 'dead', host: '127.0.0.1', port: 1, secret: 'x', kind: 'phone', ram: 3000, bw: 20, added_at: 't' };
  const r = await runBench({ modelFile: null, peers: [dead], llama: null, measureBw: async () => 10, probeMs: 500 });
  assert.deepEqual(validate(schema, r), []);
  assert.equal(r.model, null);
  assert.match(r.peers[0].error ?? '', /ECONNREFUSED/);
  assert.equal(r.peers[0].gate_rtt_ms, null);
  assert.equal(r.split, null);
});

test('the schema check catches what a broken record looks like', () => {
  const ok: BenchRecord = {
    v: 1, kind: 'kula-bench', at: '2026-11-05T09:00:00.000Z', source: 'app', app_version: null,
    device: { id: 'd', name: 'S25+', kind: 'phone', os: 'android 15', ram_total_mb: 12000, ram_free_mb: 5000 },
    model: { id: 'gemma3-1b-q4', file: 'g.gguf', size_bytes: 806058144, quant: 'Q4_K_M' },
    local: { mem_bw_gbs: 65.9, prompt: null, gen: series('tok/s', [30, 31, 29], 64), first_token_ms: series('ms', [300, 280, 310]) },
    peers: [], split: null, skipped: [],
  };
  assert.deepEqual(validate(schema, ok), []);
  const errs = (x: unknown) => validate(schema, x).join('\n');
  assert.match(errs({ ...ok, v: 2 }), /\$\.v: must be 1/);
  assert.match(errs({ ...ok, extra: 1 }), /unexpected extra/);
  assert.match(errs({ ...ok, local: { ...ok.local, gen: { unit: 'ms', runs: [1], median: 1 } } }), /\$\.local\.gen\.unit/);
  assert.match(errs({ ...ok, device: { ...ok.device, kind: 'watch' } }), /\$\.device\.kind: must be one of/);
  assert.match(errs({ ...ok, peers: [{ id: 'p' }] }), /\$\.peers\[0\]: missing name/);
  assert.match(errs({ ...ok, local: { ...ok.local, mem_bw_gbs: -1 } }), /below 0/);
  assert.match(errs({ ...ok, at: 'yesterday' }), /\$\.at: does not match/);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
});

test('the planner uses a measured tok/s for that device and model, else the estimate', () => {
  const q06 = simModel({ id: 'qwen3-0.6b-q8', size: 639446688, layers: 28, hidden: 1024, vocab: 151936, quant: 'Q8_0', kv_mb_per_1k: 56 });
  const peer: Peer = { id: 's25', name: 's25', host: 'h', port: 1, secret: 's', kind: 'phone', ram: 6500, bw: 65.9, added_at: 't' };
  const base = { model: q06, ctx: 2048, localFreeMb: 4000, localBw: 68, peers: [peer], share: true };
  const est = planSplit(base);
  const measured = planSplit({ ...base, localTps: 34.2 });
  assert.notEqual(est.estAlone!.tps, 34.2);
  assert.equal(measured.estAlone!.tps, 34.2);
  // a slow measured peer is worth less in the chain than its bandwidth says
  const slowPeer = planSplit({ ...base, localTps: 34.2, peerTps: { s25: 3 } });
  assert.ok(slowPeer.est.perTokenMs >= measured.est.perTokenMs);
});
