// `kula-node bench`: the repeatable measurements the planner is calibrated with. One
// run of one model on this computer and, when peers are given, through the gate to each
// of them. Writes tools/bench-schema.json (kula-bench/1) to ~/.kula-node/bench/<date>.json
// and prints a table. Every step that cannot run here is skipped with a reason, not an
// error, so a computer without llama.cpp still measures its memory and its peers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tunnel, probe } from './gate.js';
import { apiChat, apiLoad, openPeerDevice, type Device, type ModelRef } from './apart.js';
import { prepareSplit, startSplitServer, type SplitSetup } from './split.js';
import { TooBig } from './planner.js';
import { findLlama, sha256File, type LlamaBinaries } from './llama.js';
import { freePort, startChild } from './children.js';
import { serveModel } from './modelserve.js';
import { freeRamMB, lanIPv4, measureBandwidth, totalRamMB } from './sysinfo.js';
import { findPeer, peersFile, readPeers, type Peer, type PeerKind } from './peers.js';
import { expandHome, home } from './paths.js';
import { assertValid, type Schema } from './benchschema.js';

export const BENCH_SCHEMA = 'kula-bench/1';
export const TOOL = 'kula-node 0.1.0';
// The same prompt on every device, long enough that prompt evaluation is measurable.
export const BENCH_PROMPT = 'You are a careful assistant. In plain words, explain how a bicycle pump pushes air into a tyre, '
  + 'why the pump gets warm after a while, and what the valve does when you pull the pump off. '
  + 'Then list three things that can go wrong and how to notice each one. Keep every sentence short.';

export interface Stat { median: number; runs: number[] }
export interface BenchDevice { id: string; name: string; kind: PeerKind; os: string; soc: string | null; cores: number | null; threads: number | null; ram_total_mb: number | null; ram_free_mb: number | null; passport_bw_gbs: number | null }
export interface BenchModel { name: string; size_bytes: number; ctx: number; sha256: string | null; params_b: number | null; quant: string | null }
export interface BenchLocal { mode: 'alone' | 'apart' | 'split'; runs: number; tokens_per_run: number; gen_tps: Stat; first_token_ms: Stat; prompt_tps: Stat | null; prompt_tokens: number | null; load_ms: number | null }
export interface BenchPeer { id: string; name: string; kind: PeerKind; gate_rtt_ms: Stat | null; tunnel: { bytes: number; ms: number; mb_per_s: number } | null; apart: { load_ms: number | null; runs: number; tokens_per_run: number; gen_tps: Stat; first_token_ms: Stat } | null; error: string | null }
export interface BenchSplit { peers: string[]; local_mb: number | null; load_ms: number; runs: number; tokens_per_run: number; gen_tps: Stat; first_token_ms: Stat; token_ms: number }
export interface Skipped { what: 'memory' | 'local' | 'peer' | 'tunnel' | 'apart' | 'split'; who: string | null; why: string }
export interface BenchResult {
  schema: typeof BENCH_SCHEMA;
  measured_at: string;
  tool: string;
  device: BenchDevice;
  model: BenchModel | null;
  memory: { bandwidth_gbs: number; method: string; threads: number | null } | null;
  local: BenchLocal | null;
  peers: BenchPeer[];
  split: BenchSplit | null;
  skipped: Skipped[];
  notes: string[];
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const r1 = (x: number) => Math.round(x * 10) / 10;
export const stat = (runs: number[]): Stat => ({ median: r1(median(runs)), runs: runs.map(r1) });

export function loadSchema(): Schema {
  // tools/bench-schema.json at the repository root, from src/ under tsx and from dist/
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, 'tools', 'bench-schema.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    dir = path.dirname(dir);
  }
  throw new Error('tools/bench-schema.json not found above ' + import.meta.url);
}

export interface Backend { port: number; stop(): Promise<void> }
type Log = (s: string) => void;

export interface BenchOptions {
  modelFile: string | null;
  peers: Peer[];
  runs?: number;
  tokens?: number;
  ctx?: number;
  blobMb?: number;
  local?: boolean;
  apart?: boolean;
  split?: boolean;
  modelUrl?: string;
  probeMs?: number;
  llama?: LlamaBinaries | null;
  bandwidth?: number | (() => Promise<number>);
  log?: Log;
  // test seams: what stands in for llama-server here, and for the split server
  startBackend?: (file: string, ctx: number) => Promise<Backend>;
  startSplit?: (setup: SplitSetup, file: string, ctx: number) => Promise<Backend>;
  serve?: (file: string, host: string) => Promise<{ url: string; close(): Promise<void> }>;
}

// llama-server's own /completion gives prompt evaluation and generation apart, which the
// chat api does not: prompt_ms is the time to the first token, predicted_per_second the
// generation speed once it is running.
export interface CompletionTimings { prompt_n: number; prompt_ms: number; predicted_n: number; predicted_ms: number }
export async function completion(port: number, prompt: string, tokens: number): Promise<CompletionTimings> {
  const res = await fetch(`http://127.0.0.1:${port}/completion`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, n_predict: tokens, temperature: 0, cache_prompt: false, stream: false }),
  });
  if (!res.ok) throw new Error(`llama-server /completion: ${res.status} ${await res.text().catch(() => '')}`);
  const o = (await res.json()) as { timings?: Partial<CompletionTimings> };
  const t = o.timings;
  if (!t || !(Number(t.predicted_ms) > 0) || !(Number(t.predicted_n) > 0)) throw new Error('llama-server answered without timings');
  return { prompt_n: Number(t.prompt_n) || 0, prompt_ms: Number(t.prompt_ms) || 0, predicted_n: Number(t.predicted_n), predicted_ms: Number(t.predicted_ms) };
}

async function completionRuns(port: number, tokens: number, runs: number): Promise<{ gen: number[]; first: number[]; prompt: number[]; promptTokens: number }> {
  const gen: number[] = []; const first: number[] = []; const prompt: number[] = [];
  let promptTokens = 0;
  // one warm up (page cache, first kernel launch), then the counted runs
  await completion(port, BENCH_PROMPT, 8);
  for (let i = 0; i < runs; i++) {
    const t = await completion(port, BENCH_PROMPT, tokens);
    gen.push((t.predicted_n / t.predicted_ms) * 1000);
    first.push(t.prompt_ms);
    if (t.prompt_n > 0 && t.prompt_ms > 0) { prompt.push((t.prompt_n / t.prompt_ms) * 1000); promptTokens = t.prompt_n; }
  }
  return { gen, first, prompt, promptTokens };
}

async function waitHealthy(port: number, exited: () => boolean, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return; } catch {}
    if (exited()) throw new Error('llama-server exited while loading');
    if (Date.now() - t0 > timeoutMs) throw new Error('llama-server took too long to load the model');
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function defaultBackend(llama: LlamaBinaries | null, file: string, ctx: number, log: Log): Promise<Backend> {
  if (!llama) throw new Error('llama.cpp is not set up here: run kula-node setup');
  const port = await freePort();
  const child = await startChild('llama-server', llama.llamaServer, ['--host', '127.0.0.1', '--port', String(port), '-m', file, '-c', String(ctx), '-ngl', '99', '--no-webui'], port, log, 180000);
  try { await waitHealthy(port, () => child.proc.exitCode !== null, 600000); } catch (e) { await child.stop(); throw e; }
  return child;
}

// Pulls GET /blob?mb= through a fresh api tunnel and times it. Resolves null when the
// worker does not know the route (an older build).
export async function tunnelSpeed(peer: Peer, mb: number): Promise<{ bytes: number; ms: number; mb_per_s: number } | null> {
  const tunnel = new Tunnel(peer.host, peer.port, peer.secret, 'api');
  const port = await tunnel.listen();
  try {
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/blob?mb=${mb}`);
    if (res.status === 404) return null;
    if (!res.ok || !res.body) throw new Error(`blob: http ${res.status}`);
    const reader = res.body.getReader();
    let bytes = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; }
    const ms = Math.max(1, Date.now() - t0);
    return { bytes, ms, mb_per_s: Math.round((bytes / 1e6 / (ms / 1000)) * 100) / 100 };
  } finally {
    await tunnel.close();
  }
}

export async function runBench(opts: BenchOptions): Promise<BenchResult> {
  const log = opts.log ?? (() => {});
  const runs = opts.runs ?? 3;
  const tokens = opts.tokens ?? 64;
  const ctx = opts.ctx ?? 2048;
  const probeMs = opts.probeMs ?? 2000;
  const llama = opts.llama === undefined ? findLlama() : opts.llama;
  const skipped: Skipped[] = [];
  const notes: string[] = [];
  const host = os.hostname();
  const device: BenchDevice = {
    id: host, name: host, kind: 'pc', os: `${process.platform} ${os.release()} ${os.arch()}`, soc: os.cpus()[0]?.model ?? null,
    cores: os.cpus().length || null, threads: null, ram_total_mb: totalRamMB(), ram_free_mb: freeRamMB(), passport_bw_gbs: null,
  };

  // memory bandwidth: the same copy benchmark the worker advertises
  log('memory bandwidth');
  let bw = 0;
  try {
    bw = typeof opts.bandwidth === 'number' ? opts.bandwidth : await (opts.bandwidth ?? measureBandwidth)();
  } catch (e) { skipped.push({ what: 'memory', who: null, why: (e as Error).message }); }
  const memory = bw > 0 ? { bandwidth_gbs: bw, method: 'copy 64 MB ×4 on a worker thread (sysinfo.measureBandwidth)', threads: 1 } : null;
  if (!memory && !skipped.some((s) => s.what === 'memory')) skipped.push({ what: 'memory', who: null, why: 'the copy benchmark returned 0' });

  // the model
  let model: BenchModel | null = null;
  let modelRef: ModelRef | null = null;
  if (opts.modelFile) {
    const size = fs.statSync(opts.modelFile).size;
    log('hashing the model (once)');
    const sha256 = await sha256File(opts.modelFile);
    model = { name: path.basename(opts.modelFile), size_bytes: size, ctx, sha256, params_b: null, quant: quantOf(opts.modelFile) };
    modelRef = { url: 'file://' + opts.modelFile, sha256, size, name: model.name, ctx };
  }

  // local tok/s: llama-server here, /completion ×runs
  let local: BenchLocal | null = null;
  if (!opts.modelFile) skipped.push({ what: 'local', who: null, why: 'no --model' });
  else if (opts.local === false) skipped.push({ what: 'local', who: null, why: '--no-local' });
  else {
    try {
      log('local: starting llama-server');
      const t0 = Date.now();
      const be = await (opts.startBackend ? opts.startBackend(opts.modelFile, ctx) : defaultBackend(llama, opts.modelFile, ctx, log));
      const loadMs = Date.now() - t0;
      try {
        const r = await completionRuns(be.port, tokens, runs);
        local = { mode: 'alone', runs, tokens_per_run: tokens, gen_tps: stat(r.gen), first_token_ms: stat(r.first), prompt_tps: r.prompt.length ? stat(r.prompt) : null, prompt_tokens: r.promptTokens || null, load_ms: loadMs };
        log(`local: ${local.gen_tps.median} tok/s generation, ${local.prompt_tps?.median ?? '?'} tok/s prompt, first token ${local.first_token_ms.median} ms`);
      } finally { await be.stop().catch(() => {}); }
    } catch (e) { skipped.push({ what: 'local', who: null, why: (e as Error).message }); log(`local: skipped, ${(e as Error).message}`); }
  }

  // peers: gate round trip, tunnel speed, apart mode tok/s
  const peers: BenchPeer[] = [];
  let served: { url: string; close(): Promise<void> } | null = null;
  let apartUrl = opts.modelUrl ?? null;
  try {
    for (const p of opts.peers) {
      const row: BenchPeer = { id: p.id, name: p.name, kind: p.kind, gate_rtt_ms: null, tunnel: null, apart: null, error: null };
      peers.push(row);
      log(`${p.name}: gate round trip`);
      const rtts: number[] = [];
      for (let i = 0; i < runs; i++) {
        const r = await probe(p.host, p.port, p.secret, 'api', probeMs);
        if (!r.ok) { row.error = r.reason; break; }
        rtts.push(r.ms);
      }
      if (row.error) { skipped.push({ what: 'peer', who: p.name, why: row.error }); log(`${p.name}: ${row.error}`); continue; }
      row.gate_rtt_ms = stat(rtts);
      log(`${p.name}: tunnel speed (${opts.blobMb ?? 10} MB)`);
      try {
        row.tunnel = await tunnelSpeed(p, opts.blobMb ?? 10);
        if (!row.tunnel) skipped.push({ what: 'tunnel', who: p.name, why: 'the worker has no GET /blob (older build)' });
      } catch (e) { skipped.push({ what: 'tunnel', who: p.name, why: (e as Error).message }); }

      if (!modelRef || !model) { skipped.push({ what: 'apart', who: p.name, why: 'no --model' }); continue; }
      if (opts.apart === false) { skipped.push({ what: 'apart', who: p.name, why: '--no-apart' }); continue; }
      if (!apartUrl) {
        const ip = lanIPv4();
        if (!ip) { skipped.push({ what: 'apart', who: p.name, why: 'no lan ipv4 address to serve the model from; pass --model-url' }); continue; }
        served = await (opts.serve ?? ((f, h) => serveModel(f, h, '0.0.0.0', 0)))(opts.modelFile!, ip);
        apartUrl = served.url;
      }
      let dev: Device | null = null;
      try {
        dev = await openPeerDevice(p);
        log(`${p.name}: loading the model (apart)`);
        const t0 = Date.now();
        await apiLoad(dev.apiPort, { ...modelRef, url: apartUrl });
        const loadMs = Date.now() - t0;
        const gen: number[] = []; const first: number[] = [];
        await apiChat(dev, [{ role: 'user', content: BENCH_PROMPT }], () => {}, { maxTokens: 8, temperature: 0, reset: true });
        for (let i = 0; i < runs; i++) {
          const r = await apiChat(dev, [{ role: 'user', content: BENCH_PROMPT }], () => {}, { maxTokens: tokens, temperature: 0, reset: true });
          gen.push(r.tps); first.push(r.firstMs);
        }
        row.apart = { load_ms: loadMs, runs, tokens_per_run: tokens, gen_tps: stat(gen), first_token_ms: stat(first) };
        log(`${p.name}: apart ${row.apart.gen_tps.median} tok/s, first token ${row.apart.first_token_ms.median} ms, load ${(loadMs / 1000).toFixed(1)} s`);
      } catch (e) {
        skipped.push({ what: 'apart', who: p.name, why: (e as Error).message });
        log(`${p.name}: apart skipped, ${(e as Error).message}`);
      } finally { await dev?.close().catch(() => {}); }
    }
  } finally { await served?.close().catch(() => {}); }

  // split: tunnels to the rpc channel, llama-server with --rpc, load time and token latency
  let split: BenchSplit | null = null;
  const live = opts.peers.filter((p) => peers.find((r) => r.id === p.id)?.error === null);
  if (!opts.modelFile) skipped.push({ what: 'split', who: null, why: 'no --model' });
  else if (opts.split === false) skipped.push({ what: 'split', who: null, why: '--no-split' });
  else if (!live.length) skipped.push({ what: 'split', who: null, why: opts.peers.length ? 'no peer answered' : 'no peers' });
  else if (!llama && !opts.startSplit) skipped.push({ what: 'split', who: null, why: 'llama.cpp is not set up here (run kula-node setup); split mode needs a local llama-server' });
  else {
    let setup: SplitSetup | null = null;
    try {
      setup = await prepareSplit({ modelBytes: model!.size_bytes, localFreeMb: freeRamMB(), localBw: bw || 4, peers: live, share: true, probeMs, log });
      if (!setup.plan.used.length) throw new Error('no worker answered on the rpc channel');
      log('split: starting llama-server over the tunnels');
      const t0 = Date.now();
      const be = await (opts.startSplit ? opts.startSplit(setup, opts.modelFile, ctx) : startSplitServer(llama, opts.modelFile, ctx, setup, log));
      const loadMs = Date.now() - t0;
      try {
        const r = await completionRuns(be.port, tokens, runs);
        const gen = stat(r.gen);
        split = { peers: setup.plan.used.map((u) => u.id), local_mb: setup.plan.localMb, load_ms: loadMs, runs, tokens_per_run: tokens, gen_tps: gen, first_token_ms: stat(r.first), token_ms: gen.median > 0 ? Math.round((1000 / gen.median) * 10) / 10 : 0 };
        log(`split: load ${(loadMs / 1000).toFixed(1)} s, ${gen.median} tok/s (${split.token_ms} ms per token)`);
      } finally { await be.stop().catch(() => {}); }
    } catch (e) {
      const why = e instanceof TooBig ? e.message : (e as Error).message;
      skipped.push({ what: 'split', who: null, why });
      log(`split: skipped, ${why}`);
    } finally { await setup?.close().catch(() => {}); }
  }

  if (local && local.prompt_tps === null) notes.push('prompt_tps missing: llama-server reported no prompt timings');
  const result: BenchResult = { schema: BENCH_SCHEMA, measured_at: new Date().toISOString(), tool: TOOL, device, model, memory, local, peers, split, skipped, notes };
  assertValid(loadSchema(), result);
  return result;
}

function quantOf(file: string): string | null {
  const m = /[-_.](I?Q\d(?:_[A-Z0-9]+)*|F16|BF16|F32)\b/i.exec(path.basename(file));
  return m ? m[1].toUpperCase() : null;
}

export const benchDir = () => path.join(home(), 'bench');

/** Writes the result as <measured_at>.json under ~/.kula-node/bench (or `file`), mode 600 like the peer book. */
export function saveBench(r: BenchResult, file?: string): string {
  const out = file ?? path.join(benchDir(), `${r.measured_at.replace(/[:.]/g, '-').replace(/Z$/, '')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
  return out;
}

const fmtStat = (s: Stat | null, unit: string) => (s ? `${s.median} ${unit}` : '?');

/** The table printed after a run: one line per measurement, skips with their reason. */
export function benchTable(r: BenchResult): string[] {
  const lines: string[] = [];
  const row = (k: string, v: string) => lines.push(`${k.padEnd(14)}${v}`);
  row('device', `${r.device.name} (${r.device.os}${r.device.ram_total_mb ? `, ${Math.round(r.device.ram_total_mb / 1024)} GB` : ''})`);
  if (r.model) row('model', `${r.model.name}  ${(r.model.size_bytes / 1e6).toFixed(0)} MB  ctx ${r.model.ctx}`);
  row('memory bw', r.memory ? `${r.memory.bandwidth_gbs} GB/s` : 'skipped');
  if (r.local) row('local', `prompt ${fmtStat(r.local.prompt_tps, 'tok/s')} · gen ${fmtStat(r.local.gen_tps, 'tok/s')} · first token ${fmtStat(r.local.first_token_ms, 'ms')}${r.local.load_ms != null ? ` · load ${(r.local.load_ms / 1000).toFixed(1)} s` : ''}  (${r.local.runs} runs, median)`);
  for (const p of r.peers) {
    if (p.error) { row(`peer ${p.name}`, `NO ${p.error}`); continue; }
    const parts = [`gate ${fmtStat(p.gate_rtt_ms, 'ms')}`, `tunnel ${p.tunnel ? `${p.tunnel.mb_per_s} MB/s` : '?'}`];
    if (p.apart) parts.push(`apart ${p.apart.gen_tps.median} tok/s (first ${p.apart.first_token_ms.median} ms${p.apart.load_ms != null ? `, load ${(p.apart.load_ms / 1000).toFixed(1)} s` : ''})`);
    row(`peer ${p.name}`, parts.join(' · '));
  }
  if (r.split) row('split', `${r.split.peers.length} peer(s) · load ${(r.split.load_ms / 1000).toFixed(1)} s · ${r.split.gen_tps.median} tok/s · ${r.split.token_ms} ms per token · first token ${r.split.first_token_ms.median} ms`);
  for (const s of r.skipped) row(`skipped`, `${s.what}${s.who ? ` (${s.who})` : ''}: ${s.why}`);
  for (const n of r.notes) row('note', n);
  return lines;
}

type Flags = Record<string, string | boolean>;
const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: string | boolean | undefined, d: number): number => { if (v === undefined || v === true) return d; const n = Number(v); if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`); return n; };

export async function benchCommand(flags: Flags): Promise<number> {
  const log = (s: string) => console.error(`${new Date().toISOString().slice(11, 19)}  ${s}`);
  let modelFile: string | null = null;
  if (str(flags.model)) {
    modelFile = path.resolve(expandHome(str(flags.model)!));
    if (!fs.existsSync(modelFile)) { console.error(`no such model file: ${modelFile}`); return 2; }
  }
  const all = readPeers(str(flags.file) ?? peersFile());
  const refs = typeof flags.peer === 'string' ? flags.peer.split(',').filter(Boolean) : [];
  const peers = refs.length ? refs.map((r) => { const p = findPeer(all, r); if (!p) throw new Error(`no such peer: ${r}`); return p; }) : all;
  const result = await runBench({
    modelFile, peers, log,
    runs: num(flags.runs, 3), tokens: num(flags.tokens, 64), ctx: num(flags.ctx, 2048), blobMb: num(flags.mb, 10), probeMs: num(flags['probe-ms'], 2000),
    local: flags['no-local'] !== true, apart: flags['no-apart'] !== true, split: flags['no-split'] !== true,
    modelUrl: str(flags['model-url']), bandwidth: flags.bw !== undefined ? num(flags.bw, 0) : undefined,
  });
  const file = saveBench(result, str(flags.out));
  if (flags.json === true) console.log(JSON.stringify(result, null, 2));
  else for (const l of benchTable(result)) console.log(l);
  console.log(`${'saved'.padEnd(14)}${file}`);
  return 0;
}
