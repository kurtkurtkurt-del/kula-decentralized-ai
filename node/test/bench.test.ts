// `kula-node bench` without llama.cpp: a fake llama-server answers /completion with
// timings, two fake workers (the real api behind the real gate) answer the gate round
// trip, the 10 MB blob and apart mode, and a fake split server stands in for
// --rpc. The result must match tools/bench-schema.json; what cannot run is in `skipped`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { startApiServer } from '../src/api.ts';
import { startGateServer } from '../src/gate.ts';
import { BENCH_PROMPT, benchTable, loadSchema, median, runBench, saveBench, stat, type BenchResult } from '../src/bench.ts';
import { validate } from '../src/benchschema.ts';
import type { Peer } from '../src/peers.ts';

type Srv = { port: number; close: () => void };
const listen = (s: http.Server): Promise<Srv> => new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as any).port, close: () => s.close() })));

// llama-server: /health, /completion with timings (fixed speeds so medians are checkable),
// and the OAI chat stream the worker api turns into {t}/{done}
function fakeLlama(genTps: number, promptTps: number, firstMs: number): Promise<Srv & { completions: any[] }> {
  const completions: any[] = [];
  const s = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
    let body = ''; for await (const c of req) body += c;
    const o = JSON.parse(body);
    if (req.url === '/completion') {
      completions.push(o);
      const n = o.n_predict;
      const pn = Math.round(o.prompt.length / 4);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: 'x'.repeat(n), tokens_predicted: n, timings: { prompt_n: pn, prompt_ms: (pn / promptTps) * 1000, predicted_n: n, predicted_ms: (n / genTps) * 1000 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    setTimeout(() => {
      for (let i = 0; i < o.max_tokens; i++) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: o.max_tokens } })}\n\ndata: [DONE]\n\n`);
      res.end();
    }, firstMs);
  });
  return listen(s).then((x) => Object.assign(x, { completions }));
}

async function worker(name: string, secret: string, fake: Srv) {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-bench-w-'));
  const api = await startApiServer({ models, llama: null, startBackend: async () => ({ port: fake.port, stop: async () => {} }) });
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret, targets: (ch) => (ch === 'api' ? api.port : ch === 'rpc' ? api.port : null) });
  const peer: Peer = { id: `id-${name}`, name, host: '127.0.0.1', port: gate.port, secret, kind: 'phone', ram: 4000, bw: 20, added_at: 't' };
  return { peer, close: async () => { await gate.close(); await api.close(); fs.rmSync(models, { recursive: true, force: true }); } };
}

test('median and stat', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
  assert.deepEqual(stat([10.26, 9.94, 10.04]), { median: 10, runs: [10.3, 9.9, 10] });
});

test('a full run: memory, local, two peers (gate, tunnel, apart), split; json matches the schema', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-bench-home-'));
  process.env.KULA_NODE_HOME = home;
  const modelFile = path.join(home, 'tiny-Q8_0.gguf');
  // 30 MB: big enough that the planner hands every device a share (a tiny file rounds to 0 MB)
  fs.writeFileSync(modelFile, randomBytes(30 << 20));
  const local = await fakeLlama(30, 300, 0);
  const fast = await fakeLlama(0, 0, 20);
  const slow = await fakeLlama(0, 0, 60);
  const a = await worker('s25', 'aa', fast);
  const b = await worker('pixel', 'bb', slow);
  const dead: Peer = { ...a.peer, id: 'dead', name: 'dead', port: 1 };
  const splitFake = await fakeLlama(12, 100, 0);
  const logs: string[] = [];
  let splitArgs: { rpc: string; split: string } | null = null;
  let localStops = 0;
  try {
    const r = await runBench({
      modelFile, peers: [a.peer, dead, b.peer], runs: 3, tokens: 32, ctx: 1024, blobMb: 1, probeMs: 500, llama: null, bandwidth: 25.5, log: (s) => logs.push(s),
      startBackend: async () => ({ port: local.port, stop: async () => { localStops++; } }),
      startSplit: async (setup) => { splitArgs = { rpc: setup.rpcArg, split: setup.tensorSplitArg }; return { port: splitFake.port, stop: async () => {} }; },
      serve: async (file) => ({ url: `http://127.0.0.1:${(await staticFile(file)).port}/m.gguf`, close: async () => {} }),
    });
    assert.deepEqual(validate(loadSchema(), r), []);
    assert.equal(r.schema, 'kula-bench/1');
    assert.equal(r.device.kind, 'pc');
    assert.deepEqual(r.memory, { bandwidth_gbs: 25.5, method: 'copy 64 MB ×4 on a worker thread (sysinfo.measureBandwidth)', threads: 1 });
    assert.equal(r.model!.name, 'tiny-Q8_0.gguf');
    assert.equal(r.model!.quant, 'Q8_0');
    assert.equal(r.model!.size_bytes, 30 << 20);
    assert.match(r.model!.sha256!, /^[0-9a-f]{64}$/);

    // local: warm up + 3 counted runs on /completion, all with the same prompt; medians from the timings
    assert.equal(local.completions.length, 4);
    assert.ok(local.completions.every((c) => c.prompt === BENCH_PROMPT && c.cache_prompt === false && c.stream === false));
    assert.deepEqual(local.completions.map((c) => c.n_predict), [8, 32, 32, 32]);
    assert.equal(r.local!.gen_tps.median, 30);
    assert.equal(r.local!.prompt_tps!.median, 300);
    assert.equal(r.local!.runs, 3);
    assert.equal(r.local!.tokens_per_run, 32);
    assert.ok(r.local!.prompt_tokens! > 50);
    assert.equal(localStops, 1);

    // peers: the dead one has an error and nothing else; the live ones have all three
    const by = Object.fromEntries(r.peers.map((p) => [p.name, p]));
    assert.deepEqual(Object.keys(by).sort(), ['dead', 'pixel', 's25']);
    assert.equal(by.dead.error, 'connect ECONNREFUSED 127.0.0.1:1');
    assert.equal(by.dead.gate_rtt_ms, null);
    for (const name of ['s25', 'pixel']) {
      const p = by[name];
      assert.equal(p.error, null);
      assert.equal(p.gate_rtt_ms!.runs.length, 3);
      assert.equal(p.tunnel!.bytes, 1024 * 1024);
      assert.ok(p.tunnel!.mb_per_s > 0);
      assert.equal(p.apart!.runs, 3);
      assert.equal(p.apart!.tokens_per_run, 32);
      assert.ok(p.apart!.load_ms! >= 0);
      assert.ok(p.apart!.gen_tps.median > 0);
    }
    // the slower worker shows its longer time to first token
    assert.ok(by.pixel.apart!.first_token_ms.median > by.s25.apart!.first_token_ms.median, `${by.pixel.apart!.first_token_ms.median} vs ${by.s25.apart!.first_token_ms.median}`);

    // split: planned over the two live peers, the fake server timed
    assert.ok(splitArgs, 'split ran');
    assert.match(splitArgs!.rpc, /^127\.0\.0\.1:\d+,127\.0\.0\.1:\d+$/);
    assert.deepEqual(r.split!.peers.sort(), ['id-pixel', 'id-s25']);
    assert.equal(r.split!.gen_tps.median, 12);
    assert.equal(r.split!.token_ms, 83.3);
    assert.ok(r.split!.load_ms >= 0);

    assert.deepEqual(r.skipped, [{ what: 'peer', who: 'dead', why: 'connect ECONNREFUSED 127.0.0.1:1' }]);

    // saved under ~/.kula-node/bench with the time in the name, mode 600, same json back
    const file = saveBench(r);
    assert.equal(path.dirname(file), path.join(home, 'bench'));
    assert.match(path.basename(file), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.json$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(JSON.stringify(r)));

    const table = benchTable(r);
    assert.ok(table.some((l) => l.startsWith('memory bw     25.5 GB/s')));
    assert.ok(table.some((l) => l.startsWith('local         prompt 300 tok/s · gen 30 tok/s')));
    assert.ok(table.some((l) => l.startsWith('peer dead     NO connect')));
    assert.ok(table.some((l) => /^peer s25 +gate \d+(\.\d)? ms · tunnel [\d.]+ MB\/s · apart [\d.]+ tok\/s/.test(l)));
    assert.ok(table.some((l) => l.startsWith('split         2 peer(s)')));
  } finally {
    await a.close(); await b.close(); local.close(); fast.close(); slow.close(); splitFake.close();
    for (const s of statics) s.close();
    delete process.env.KULA_NODE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const statics: Srv[] = [];
async function staticFile(file: string): Promise<Srv> {
  const body = fs.readFileSync(file);
  const s = await listen(http.createServer((_req, res) => { res.writeHead(200, { 'content-length': body.length }); res.end(body); }));
  statics.push(s);
  return s;
}

test('without a model and without llama.cpp: memory and the peers are measured, the rest is skipped and said', async () => {
  const fake = await fakeLlama(0, 0, 5);
  const w = await worker('mac', 'cc', fake);
  try {
    const r = await runBench({ modelFile: null, peers: [w.peer], runs: 2, blobMb: 1, llama: null, bandwidth: 10 });
    assert.deepEqual(validate(loadSchema(), r), []);
    assert.equal(r.model, null);
    assert.equal(r.local, null);
    assert.equal(r.split, null);
    assert.equal(r.peers[0].gate_rtt_ms!.runs.length, 2);
    assert.equal(r.peers[0].tunnel!.bytes, 1024 * 1024);
    assert.equal(r.peers[0].apart, null);
    assert.deepEqual(r.skipped.map((s) => `${s.what}:${s.why}`), ['local:no --model', 'apart:no --model', 'split:no --model']);
    const table = benchTable(r);
    assert.ok(table.some((l) => l === 'skipped       local: no --model'));
  } finally { await w.close(); fake.close(); }
});

test('split without the binary is skipped with the setup hint; a model but no peers skips apart and split', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-bench-home-'));
  const modelFile = path.join(home, 'm.gguf');
  fs.writeFileSync(modelFile, randomBytes(1000));
  const local = await fakeLlama(20, 200, 0);
  const fake = await fakeLlama(0, 0, 5);
  const w = await worker('mac', 'dd', fake);
  try {
    const r = await runBench({ modelFile, peers: [w.peer], runs: 1, blobMb: 1, llama: null, bandwidth: 10, apart: false, startBackend: async () => ({ port: local.port, stop: async () => {} }) });
    assert.deepEqual(validate(loadSchema(), r), []);
    assert.equal(r.local!.gen_tps.median, 20);
    assert.deepEqual(r.skipped, [
      { what: 'apart', who: 'mac', why: '--no-apart' },
      { what: 'split', who: null, why: 'llama.cpp is not set up here (run kula-node setup); split mode needs a local llama-server' },
    ]);
    const alone = await runBench({ modelFile, peers: [], runs: 1, llama: null, bandwidth: 10, startBackend: async () => ({ port: local.port, stop: async () => {} }) });
    assert.deepEqual(alone.skipped, [{ what: 'split', who: null, why: 'no peers' }]);
    assert.equal(alone.peers.length, 0);
  } finally { await w.close(); fake.close(); local.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('the schema rejects what the planner must never read', () => {
  const schema = loadSchema();
  const good: BenchResult = {
    schema: 'kula-bench/1', measured_at: '2026-11-05T22:00:00.000Z', tool: 'test',
    device: { id: 'x', name: 'x', kind: 'phone', os: 'android 15', soc: null, cores: 8, threads: 4, ram_total_mb: 12000, ram_free_mb: 6000, passport_bw_gbs: 65.9 },
    model: { name: 'm.gguf', size_bytes: 10, ctx: 2048, sha256: null, params_b: 1, quant: 'Q4_K_M' },
    memory: { bandwidth_gbs: 60, method: 'native memBandwidth', threads: 4 },
    local: { mode: 'alone', runs: 3, tokens_per_run: 64, gen_tps: { median: 20, runs: [19, 20, 21] }, first_token_ms: { median: 300, runs: [300] }, prompt_tps: null, prompt_tokens: null, load_ms: 1200 },
    peers: [], split: null, skipped: [], notes: [],
  };
  assert.deepEqual(validate(schema, good), []);
  const broken = (patch: (r: any) => void) => { const r = JSON.parse(JSON.stringify(good)); patch(r); return validate(schema, r); };
  assert.match(broken((r) => { r.schema = 'kula-bench/0'; })[0], /^\$\.schema: must be "kula-bench\/1"/);
  assert.match(broken((r) => { r.local.gen_tps.runs = []; })[0], /gen_tps\.runs: needs at least 1 items/);
  assert.match(broken((r) => { r.local.gen_tps.median = -1; })[0], /median: must be ≥ 0/);
  assert.match(broken((r) => { r.device.kind = 'watch'; })[0], /kind: must be one of/);
  assert.match(broken((r) => { delete r.peers; })[0], /\$: missing peers/);
  assert.match(broken((r) => { r.extra = 1; })[0], /unknown field extra/);
  assert.match(broken((r) => { r.local.prompt_tps = { median: 1 }; })[0], /prompt_tps: must match exactly one alternative/);
  assert.match(broken((r) => { r.local.tokens_per_run = 1.5; })[0], /tokens_per_run: must be integer/);
  assert.match(broken((r) => { r.model.sha256 = 'zz'; })[0], /sha256: must match/);
});
