import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { deviceId, lastPassport } from '@/data/passport';
import { native } from '@/llm/native';
import { chatLocal, engine, load, unload } from '@/llm/engine';
import { share, type LocalModel, type Peer } from '@/llm/store';
import { BENCH_PROMPT, BENCH_VERSION, GEN_TOKENS, mbPerS, RUNS, series, TUNNEL_MB, type BenchPeer, type BenchRecord } from '@/bench/core';

// The bench on this phone (docs/BENCH.md): the same record kula-node bench writes, from
// what a phone can measure itself. Memory bandwidth from the native copy test, decoding
// from GEN_TOKENS × RUNS on the model loaded alone, the gate's round trip and the tunnel
// (GET /blob through the api channel) to each paired peer; with no peer, against this
// phone's own gate when it is shared (loopback). Apart and split per peer are kula-node's.
export type Step = 'bw' | 'load' | 'gen' | 'gate' | 'tunnel' | 'done';
export type BenchOpts = { runs?: number; genTokens?: number; ctx?: number; tunnelMb?: number; onStep?: (s: Step, detail?: string) => void; now?: () => Date };

const MB = 1024 * 1024;

/** Pulls `mb` MB of /blob from a tunnel port; MB/s (MB = 1024²). */
export async function tunnelSpeed(port: number, mb: number): Promise<number> {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/blob?mb=${mb}`);
  if (!res.ok) throw new Error(`blob: http ${res.status}`);
  const got = (await res.blob()).size; // react native keeps the bytes native; only the size crosses
  if (got !== mb * MB) throw new Error(`blob: ${got} bytes of ${mb * MB}`);
  return mbPerS(got, Date.now() - t0);
}

async function gateRtt(host: string, port: number, secret: string, runs: number): Promise<{ ms: number[]; error: string | null }> {
  const n = native();
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    const why = await n.probePeer(host, port, secret, 'api').catch((e: Error) => e.message);
    if (why) return { ms, error: why };
    ms.push(Date.now() - t0);
  }
  return { ms, error: null };
}

export async function runPhoneBench(model: LocalModel | null, peers: Peer[], opts: BenchOpts = {}): Promise<BenchRecord> {
  const n = native();
  const runs = opts.runs ?? RUNS;
  const nGen = opts.genTokens ?? GEN_TOKENS;
  const tunnelMb = opts.tunnelMb ?? TUNNEL_MB;
  const step = opts.onStep ?? (() => {});
  const skipped: BenchRecord['skipped'] = [];
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const info = await n.info();
  const threads = info.fastCores || 4;

  step('bw');
  const bw = await n.memBandwidth(threads).catch(() => 0);
  if (!(bw > 0)) skipped.push({ what: 'mem_bw', why: 'the copy test failed' });
  const local: BenchRecord['local'] = { mem_bw_gbs: bw > 0 ? Math.round(bw * 10) / 10 : null, prompt: null, gen: null, first_token_ms: null };

  let layers: number | null = null;
  if (!model) skipped.push({ what: 'model', why: 'no model on this phone: only memory, gate and tunnel' });
  else {
    const e = engine();
    const reuse = e.model?.id === model.id && e.mode === 'alone' && !!e.load;
    if (e.model && !reuse) skipped.push({ what: 'gen', why: 'another model or mode is loaded: unload it first' });
    else {
      try {
        if (!reuse) {
          step('load', model.name);
          await load(model, 'alone', opts.ctx ?? 2048, []);
        }
        layers = engine().load?.layers ?? null;
        const gen: number[] = [];
        const prompt: number[] = [];
        const first: number[] = [];
        let tokens = 0;
        let promptN = 0;
        for (let i = 0; i < runs; i++) {
          step('gen', `${i + 1}/${runs}`);
          const r = await chatLocal([{ role: 'user', content: BENCH_PROMPT }], () => {}, { maxTokens: nGen, temperature: 0, reset: true });
          gen.push(r.tps);
          first.push(r.firstMs);
          tokens = r.tokens;
          // after a reset the context holds the prompt and the reply: the prompt is the rest
          const used = n.tokensUsed();
          promptN = Math.max(0, used - r.tokens);
          if (promptN > 0 && r.firstMs > 0) prompt.push((promptN / r.firstMs) * 1000);
        }
        local.gen = series('tok/s', gen, tokens);
        local.first_token_ms = series('ms', first);
        if (prompt.length) local.prompt = series('tok/s', prompt, promptN);
        else skipped.push({ what: 'prompt', why: 'the context did not tell the prompt size' });
        if (!reuse) await unload();
      } catch (err) {
        skipped.push({ what: 'gen', why: (err as Error).message });
        if (!reuse) await unload().catch(() => {});
      }
    }
  }

  // gate and tunnel: each paired peer; with none, this phone's own gate when it is shared
  const rows: BenchPeer[] = [];
  const mine = share();
  const shared = mine ? (await n.workerStatus().catch(() => null))?.state === 'running' : false;
  const targets = peers.length
    ? peers.map((p) => ({ id: p.id, name: p.name, host: p.host, port: p.port, secret: p.secret, loopback: false }))
    : shared && mine ? [{ id: 'loopback', name: 'this phone (loopback)', host: '127.0.0.1', port: mine.port, secret: mine.secret, loopback: true }] : [];
  if (!targets.length) {
    skipped.push({ what: 'gate', why: 'no paired peer and this phone is not shared' });
    skipped.push({ what: 'tunnel', why: 'no paired peer and this phone is not shared' });
  }
  for (const t of targets) {
    step('gate', t.name);
    const g = await gateRtt(t.host, t.port, t.secret, runs);
    const row: BenchPeer = { id: t.id, name: t.name, loopback: t.loopback, gate_rtt_ms: g.ms.length === runs ? series('ms', g.ms) : null, tunnel_mb_s: null, tunnel_mb: tunnelMb, apart: null, error: g.error };
    rows.push(row);
    if (g.error) continue;
    step('tunnel', t.name);
    try {
      const port = await n.apiTunnel(t.host, t.port, t.secret);
      row.tunnel_mb_s = await tunnelSpeed(port, tunnelMb);
    } catch (err) {
      row.error = `tunnel: ${(err as Error).message}`;
    }
  }
  // apart mode keeps its own tunnels open; otherwise ours go
  if (targets.length && !(engine().mode === 'apart' && engine().model)) await n.closeTunnels().catch(() => {});
  skipped.push({ what: 'apart', why: 'per peer: kula-node bench on a computer' });
  skipped.push({ what: 'split', why: 'kula-node bench on a computer' });

  step('done');
  const p = lastPassport();
  return {
    v: BENCH_VERSION, kind: 'kula-bench', at, source: 'app', app_version: Constants.expoConfig?.version ?? null,
    device: {
      id: deviceId(), name: p?.device ?? Device.modelName ?? 'this phone', kind: p?.kind === 'tablet' ? 'tablet' : 'phone',
      os: `${Platform.OS} ${Device.osVersion ?? Platform.Version}`, cpu: info.abi || null, threads,
      ram_total_mb: Device.totalMemory ? Math.round(Device.totalMemory / MB) : null, ram_free_mb: info.ramFreeMb ?? null,
    },
    model: model ? { id: model.id, file: model.file, size_bytes: model.size, quant: model.quant || null, layers } : null,
    local, peers: rows, split: null, skipped,
  };
}
