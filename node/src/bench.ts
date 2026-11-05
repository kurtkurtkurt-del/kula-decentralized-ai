// `kula-node bench`: what this computer and its peers really do, measured, so the planner
// can use numbers instead of bandwidth × 0.6. Writes one record (tools/bench-schema.json,
// docs/BENCH.md) to ~/.kula-node/bench/<date>.json and prints a table.
//
//   local      llama-server on 127.0.0.1: prompt tok/s and decoding tok/s from its own
//              timings, first token by the wall clock; RUNS runs, the median kept
//   mem_bw     the copy benchmark the worker advertises (sysinfo.measureBandwidth)
//   gate       tcp connect + handshake to each peer's gate (api channel), RUNS times
//   tunnel     GET /blob?mb=10 through the api channel, MB/s
//   apart      the model loaded on each peer (it fetches the file from here), /chat RUNS times
//   split      when llama.cpp is here and peers answered: the load over rpc and the token time
// Without a peer the gate and tunnel rows are measured against this computer's own gate
// (loopback: true), which is the floor the protocol itself costs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { probe as gateProbe, startGateServer, Tunnel, type ProbeResult } from './gate.js';
import { apiChat, apiLoad, openPeerDevice, type ModelRef } from './apart.js';
import { startApiServer } from './api.js';
import { freePort, startChild } from './children.js';
import { findLlama, sha256File, type LlamaBinaries } from './llama.js';
import { serveModel } from './modelserve.js';
import { prepareSplit, splitServerArgs } from './split.js';
import { freeRamMB, lanIPv4, measureBandwidth, totalRamMB } from './sysinfo.js';
import { ggufShape, simModelOf } from './gguf.js';
import { expandHome, home } from './paths.js';
import { deviceId } from './share.js';
import { findPeer, readPeers, type Peer } from './peers.js';
import { BENCH_PROMPT, BENCH_VERSION, GEN_TOKENS, mbPerS, r1, RUNS, series, TUNNEL_MB, type BenchPeer, type BenchRecord, type Series } from './benchcore.js';

type Log = (s: string) => void;
export interface Backend { port: number; stop(): Promise<void> }
/** Starts a llama-server with these args (given the port it should listen on); waits for /health. */
export type StartServer = (args: (port: number) => string[]) => Promise<Backend>;

export const PROMPT = BENCH_PROMPT;

export interface BenchOptions {
  modelFile: string | null;
  peers: Peer[];
  llama: LlamaBinaries | null;
  runs?: number;
  genTokens?: number;
  ctx?: number;
  tunnelMb?: number;
  split?: boolean;            // default: when llama.cpp is here and peers answered
  apart?: boolean;            // default: when a model and peers are given
  probeMs?: number;
  serveHost?: string | null;  // where peers fetch the model from (default: the lan address)
  log?: Log;
  // seams for the tests
  startServer?: StartServer;
  measureBw?: () => Promise<number>;
  probe?: (host: string, port: number, secret: string, channel: 'rpc' | 'api', timeoutMs: number) => Promise<ProbeResult>;
  now?: () => Date;
}

export function defaultStartServer(llama: LlamaBinaries, log: Log, loadMs = 900000): StartServer {
  return async (args) => {
    const port = await freePort();
    const child = await startChild('llama-server', llama.llamaServer, args(port), port, log, 180000);
    const t0 = Date.now();
    for (;;) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {}
      if (child.proc.exitCode !== null) throw new Error('llama-server exited while loading');
      if (Date.now() - t0 > loadMs) { await child.stop(); throw new Error('llama-server took too long to load'); }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { port, stop: () => child.stop() };
  };
}

export type Timed = { promptN: number; promptTps: number; genN: number; genTps: number; firstMs: number; tokenMs: number };

/**
 * One timed completion on a llama-server: streamed, so the first token is the wall clock;
 * prompt and decoding speeds from llama-server's own `timings` (the last chunk), or from
 * the wall clock when a server does not send them.
 */
export async function timedCompletion(port: number, nPredict: number, prompt = PROMPT): Promise<Timed> {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/completion`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, n_predict: nPredict, stream: true, cache_prompt: false, temperature: 0, ignore_eos: true }),
  });
  if (!res.ok || !res.body) throw new Error(`llama-server: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let first = 0;
  let pieces = 0;
  let timings: any = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let o: any;
      try { o = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (typeof o.content === 'string' && o.content.length) { if (!first) first = performance.now() - t0; pieces++; }
      if (o.timings) timings = o.timings;
    }
  }
  const wall = performance.now() - t0;
  if (timings && timings.predicted_n > 0) {
    return {
      promptN: timings.prompt_n ?? 0,
      promptTps: timings.prompt_per_second ?? 0,
      genN: timings.predicted_n,
      genTps: timings.predicted_per_second ?? (timings.predicted_n / timings.predicted_ms) * 1000,
      firstMs: first || timings.prompt_ms || 0,
      tokenMs: timings.predicted_ms / timings.predicted_n,
    };
  }
  const gen = Math.max(1, wall - first);
  return { promptN: 0, promptTps: 0, genN: pieces, genTps: (pieces / gen) * 1000, firstMs: first, tokenMs: pieces ? gen / pieces : 0 };
}

/** RUNS timed completions, the series. The first is not a warm-up: the model is loaded and the prompt cache is off. */
async function timedRuns(port: number, runs: number, nPredict: number, log: Log, label: string): Promise<Timed[]> {
  const out: Timed[] = [];
  for (let i = 0; i < runs; i++) {
    const t = await timedCompletion(port, nPredict);
    log(`${label} run ${i + 1}: prompt ${r1(t.promptTps)} tok/s (${t.promptN} tok), gen ${r1(t.genTps)} tok/s (${t.genN} tok), first token ${Math.round(t.firstMs)} ms`);
    out.push(t);
  }
  return out;
}

/** Pulls `mb` MB of /blob through an api port; MB/s. */
export async function tunnelSpeed(apiPort: number, mb: number): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${apiPort}/blob?mb=${mb}`);
  if (!res.ok || !res.body) throw new Error(`blob: http ${res.status}`);
  let got = 0;
  const reader = res.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; }
  if (got !== mb * 1024 * 1024) throw new Error(`blob: ${got} bytes of ${mb * 1024 * 1024}`);
  return mbPerS(got, performance.now() - t0);
}

async function gateSeries(probe: NonNullable<BenchOptions['probe']>, p: { host: string; port: number; secret: string }, runs: number, timeoutMs: number): Promise<{ s: Series | null; error: string | null }> {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await probe(p.host, p.port, p.secret, 'api', timeoutMs);
    if (!r.ok) return { s: null, error: r.reason };
    ms.push(r.ms);
  }
  return { s: series('ms', ms), error: null };
}

export async function runBench(opts: BenchOptions): Promise<BenchRecord> {
  const log = opts.log ?? (() => {});
  const runs = opts.runs ?? RUNS;
  const nGen = opts.genTokens ?? GEN_TOKENS;
  const ctx = opts.ctx ?? 2048;
  const tunnelMb = opts.tunnelMb ?? TUNNEL_MB;
  const probe = opts.probe ?? gateProbe;
  const probeMs = opts.probeMs ?? 2000;
  const startServer = opts.startServer ?? (opts.llama ? defaultStartServer(opts.llama, log) : null);
  const skipped: BenchRecord['skipped'] = [];
  const at = (opts.now ?? (() => new Date()))().toISOString();

  const size = opts.modelFile ? fs.statSync(opts.modelFile).size : 0;
  const shape = opts.modelFile ? ggufShape(opts.modelFile) : null;
  const model = opts.modelFile && shape ? {
    id: simModelOf(opts.modelFile).id, file: path.basename(opts.modelFile), size_bytes: size,
    quant: shape.quant === '?' ? null : shape.quant, layers: shape.guessed ? null : shape.layers,
  } : null;
  if (!model) skipped.push({ what: 'model', why: 'no --model given: only memory, gate and tunnel' });

  // memory bandwidth first, while nothing else runs
  log('memory bandwidth');
  const bw = await (opts.measureBw ?? (() => measureBandwidth()))().catch(() => 0);
  if (!bw) skipped.push({ what: 'mem_bw', why: 'the copy benchmark failed' });

  // local llama-server
  const local: BenchRecord['local'] = { mem_bw_gbs: bw || null, prompt: null, gen: null, first_token_ms: null };
  if (opts.modelFile && startServer) {
    log(`local: llama-server with ${path.basename(opts.modelFile)}`);
    let srv: Backend | null = null;
    try {
      srv = await startServer((port) => splitServerArgs(opts.modelFile!, port, ctx, { rpcArg: '', tensorSplitArg: '' }));
      const t = await timedRuns(srv.port, runs, nGen, log, 'local');
      local.prompt = t.some((x) => x.promptTps > 0) ? series('tok/s', t.map((x) => x.promptTps), t[0].promptN || null) : null;
      if (!local.prompt) skipped.push({ what: 'prompt', why: 'llama-server sent no timings' });
      local.gen = series('tok/s', t.map((x) => x.genTps), t[0].genN);
      local.first_token_ms = series('ms', t.map((x) => x.firstMs));
    } catch (e) {
      skipped.push({ what: 'gen', why: `local llama-server: ${(e as Error).message.split('\n')[0]}` });
    } finally {
      await srv?.stop().catch(() => {});
    }
  } else if (opts.modelFile) {
    skipped.push({ what: 'gen', why: 'no llama.cpp here (run: kula-node setup)' });
  }

  // gate, tunnel and apart per peer; loopback when there is none
  const peers: BenchPeer[] = [];
  if (!opts.peers.length) {
    log('no peers: gate and tunnel against this computer (loopback)');
    const secret = randomBytes(16).toString('hex');
    const api = await startApiServer({ models: fs.mkdtempSync(path.join(os.tmpdir(), 'kula-bench-')), llama: null });
    const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret, targets: (ch) => (ch === 'api' ? api.port : null) });
    const tunnel = new Tunnel('127.0.0.1', gate.port, secret, 'api');
    try {
      const g = await gateSeries(gateProbe, { host: '127.0.0.1', port: gate.port, secret }, runs, probeMs);
      const port = await tunnel.listen();
      const speed = await tunnelSpeed(port, tunnelMb).catch(() => null);
      peers.push({ id: 'loopback', name: 'this computer (loopback)', loopback: true, gate_rtt_ms: g.s, tunnel_mb_s: speed, tunnel_mb: tunnelMb, apart: null, error: g.error });
    } finally {
      await tunnel.close(); await gate.close(); await api.close();
    }
    skipped.push({ what: 'apart', why: 'no peers (kula-node peers add …, then --peer)' });
  } else {
    let modelRef: ModelRef | null = null;
    let served: { close(): Promise<void> } | null = null;
    const wantApart = (opts.apart ?? true) && !!opts.modelFile;
    try {
      for (const p of opts.peers) {
        const row: BenchPeer = { id: p.id, name: p.name, loopback: false, gate_rtt_ms: null, tunnel_mb_s: null, tunnel_mb: tunnelMb, apart: null, error: null };
        peers.push(row);
        log(`${p.name}: gate`);
        const g = await gateSeries(probe, p, runs, probeMs);
        row.gate_rtt_ms = g.s;
        if (g.error) { row.error = g.error; log(`${p.name}: ${g.error}`); continue; }
        let dev: Awaited<ReturnType<typeof openPeerDevice>> | null = null;
        try {
          dev = await openPeerDevice(p);
          log(`${p.name}: tunnel ${tunnelMb} MB`);
          row.tunnel_mb_s = await tunnelSpeed(dev.apiPort, tunnelMb).catch((e: Error) => { row.error = `tunnel: ${e.message}`; return null; });
          if (wantApart) {
            if (!modelRef) {
              const host = opts.serveHost ?? lanIPv4();
              if (!host) throw new Error('no lan address to serve the model from');
              log('hashing the model for the peers');
              const sha256 = await sha256File(opts.modelFile!);
              const srv = await serveModel(opts.modelFile!, host, host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0');
              served = srv;
              modelRef = { url: srv.url, sha256, size, name: path.basename(opts.modelFile!), ctx };
            }
            log(`${p.name}: loading the model (it fetches it from here when missing)`);
            await apiLoad(dev.apiPort, modelRef);
            const tps: number[] = [];
            const first: number[] = [];
            let tokens = 0;
            for (let i = 0; i < runs; i++) {
              const r = await apiChat(dev, [{ role: 'user', content: PROMPT }], () => {}, { maxTokens: nGen, temperature: 0, reset: true });
              log(`${p.name} run ${i + 1}: ${r.tokens} tok, ${r.tps} tok/s, first token ${r.firstMs} ms`);
              tps.push(r.tps); first.push(r.firstMs); tokens = r.tokens;
            }
            row.apart = { gen: series('tok/s', tps, tokens), first_token_ms: series('ms', first) };
          }
        } catch (e) {
          row.error = (e as Error).message;
          log(`${p.name}: ${row.error}`);
        } finally {
          await dev?.close().catch(() => {});
        }
      }
    } finally {
      await served?.close().catch(() => {});
    }
    if (!wantApart) skipped.push({ what: 'apart', why: opts.modelFile ? 'turned off (--no-apart)' : 'no model' });
  }

  // split over the peers that answered
  let split: BenchRecord['split'] = null;
  const live = opts.peers.filter((p) => peers.find((r) => r.id === p.id && r.gate_rtt_ms));
  const wantSplit = opts.split ?? true;
  if (!wantSplit) skipped.push({ what: 'split', why: 'turned off (--no-split)' });
  else if (!opts.modelFile) skipped.push({ what: 'split', why: 'no model' });
  else if (!startServer) skipped.push({ what: 'split', why: 'no llama.cpp here (run: kula-node setup)' });
  else if (!live.length) skipped.push({ what: 'split', why: opts.peers.length ? 'no peer answered' : 'no peers' });
  else {
    let setup: Awaited<ReturnType<typeof prepareSplit>> | null = null;
    let srv: Backend | null = null;
    try {
      setup = await prepareSplit({ model: simModelOf(opts.modelFile), ctx, localFreeMb: freeRamMB(), localBw: bw || 4, peers: live, share: true, probeMs, probe, log });
      if (!setup.plan.used.length) throw new Error('the planner kept everything here');
      log(`split: loading over rpc (${setup.plan.used.map((u) => `${u.name} ${u.assignedMb} MB`).join(', ')})`);
      const t0 = performance.now();
      const s = setup;
      srv = await startServer((port) => splitServerArgs(opts.modelFile!, port, ctx, s));
      const loadS = r1((performance.now() - t0) / 1000);
      const t = await timedRuns(srv.port, runs, nGen, log, 'split');
      const tok = series('ms', t.map((x) => x.tokenMs), t[0].genN);
      split = { peers: setup.plan.used.map((u) => u.id), load_s: loadS, token_ms: tok, tps: tok.median > 0 ? r1(1000 / tok.median) : 0 };
    } catch (e) {
      skipped.push({ what: 'split', why: (e as Error).message.split('\n')[0] });
    } finally {
      await srv?.stop().catch(() => {});
      await setup?.close().catch(() => {});
    }
  }

  return {
    v: BENCH_VERSION, kind: 'kula-bench', at, source: 'node', app_version: '0.1.0',
    device: { id: deviceId(), name: os.hostname().replace(/\.local$/, ''), kind: 'pc', os: `${process.platform} ${os.release()}`, cpu: os.cpus()[0]?.model ?? null, threads: os.cpus().length, ram_total_mb: totalRamMB(), ram_free_mb: freeRamMB() },
    model, local, peers, split, skipped,
  };
}

export const benchDir = () => path.join(home(), 'bench');

/** ~/.kula-node/bench/<yyyy-mm-dd>.json; a second run that day gets -2, -3, … */
export function saveBench(r: BenchRecord, dir = benchDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  const day = r.at.slice(0, 10);
  let file = path.join(dir, `${day}.json`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${day}-${i}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + '\n');
  return file;
}

/** Every saved record (unreadable files skipped), oldest first. */
export function readBenches(dir = benchDir()): BenchRecord[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out: BenchRecord[] = [];
  for (const n of names) {
    try { const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (r?.kind === 'kula-bench') out.push(r); } catch {}
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

type Flags = Record<string, string | boolean>;

export async function benchCommand(flags: Flags): Promise<number> {
  const num = (v: string | boolean | undefined, d: number) => { if (v === undefined || v === true) return d; const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`not a positive number: ${v}`); return n; };
  const modelArg = typeof flags.model === 'string' ? flags.model : null;
  const modelFile = modelArg ? path.resolve(expandHome(modelArg)) : null;
  if (modelFile && !fs.existsSync(modelFile)) { console.error(`no such model file: ${modelFile}`); return 2; }
  const all = readPeers(typeof flags.file === 'string' ? flags.file : undefined);
  const refs = typeof flags.peer === 'string' ? flags.peer.split(',').filter(Boolean) : [];
  const peers: Peer[] = [];
  for (const ref of refs) { const p = findPeer(all, ref); if (!p) { console.error(`no such peer: ${ref}`); return 2; } peers.push(p); }
  const stamp = () => new Date().toISOString().slice(11, 19);
  const record = await runBench({
    modelFile, peers, llama: findLlama(),
    runs: Math.min(16, Math.round(num(flags.runs, RUNS))), genTokens: Math.round(num(flags.tokens, GEN_TOKENS)), ctx: Math.round(num(flags.ctx, 2048)),
    tunnelMb: Math.min(64, Math.round(num(flags['tunnel-mb'], TUNNEL_MB))),
    split: flags['no-split'] === true ? false : undefined, apart: flags['no-apart'] === true ? false : undefined,
    probeMs: num(flags['probe-ms'], 2000),
    log: (s) => console.error(`${stamp()}  ${s}`),
  });
  const file = saveBench(record, typeof flags.out === 'string' ? path.resolve(expandHome(flags.out)) : undefined);
  if (flags.json === true) console.log(JSON.stringify(record, null, 2));
  else console.log(`\n${benchTable(record)}\n\nsaved: ${file}`);
  return 0;
}

const cell = (s: Series | null, digits = 1) => (s ? `${s.median.toFixed(digits)} ${s.unit}  (${s.runs.map((x) => x.toFixed(digits)).join(' / ')})` : '-');

export function benchTable(r: BenchRecord): string {
  const rows: [string, string][] = [];
  rows.push(['device', `${r.device.name} (${r.device.os}, ${r.device.ram_free_mb ?? '?'} of ${r.device.ram_total_mb ?? '?'} MB free)`]);
  rows.push(['model', r.model ? `${r.model.file} (${(r.model.size_bytes / 1024 ** 2).toFixed(0)} MB, ${r.model.quant ?? '?'})` : '-']);
  rows.push(['memory bandwidth', r.local.mem_bw_gbs != null ? `${r.local.mem_bw_gbs} GB/s` : '-']);
  rows.push(['prompt', cell(r.local.prompt)]);
  rows.push(['generation', cell(r.local.gen)]);
  rows.push(['first token', cell(r.local.first_token_ms, 0)]);
  for (const p of r.peers) {
    const tag = p.loopback ? 'loopback' : p.name;
    rows.push([`${tag}: gate rtt`, cell(p.gate_rtt_ms, 0)]);
    rows.push([`${tag}: tunnel`, p.tunnel_mb_s != null ? `${p.tunnel_mb_s} MB/s (${p.tunnel_mb} MB)` : '-']);
    if (!p.loopback) rows.push([`${tag}: apart`, p.apart ? `${cell(p.apart.gen)}, first token ${p.apart.first_token_ms?.median ?? '?'} ms` : '-']);
    if (p.error) rows.push([`${tag}: error`, p.error]);
  }
  rows.push(['split', r.split ? `load ${r.split.load_s} s, ${r.split.tps} tok/s, ${cell(r.split.token_ms)} per token over ${r.split.peers.length} peer(s)` : '-']);
  for (const s of r.skipped) rows.push([`skipped ${s.what}`, s.why]);
  const w = Math.max(...rows.map((x) => x[0].length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n');
}
