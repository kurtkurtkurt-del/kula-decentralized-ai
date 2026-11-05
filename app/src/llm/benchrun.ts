import { Platform } from 'react-native';
import { lastPassport } from '@/data/passport';
import { chatLocal, chatRemote, engine } from '@/llm/engine';
import { llama, native } from '@/llm/native';
import { peers as savedPeers, type Peer } from '@/llm/store';
import { BENCH_SCHEMA, rememberBench, stat, type BenchLocal, type BenchPeer, type BenchResult, type BenchSplit, type Skipped } from '@/llm/bench';
import { assertValid } from '@/llm/benchschema';
// a copy of tools/bench-schema.json (metro does not reach above the app); bench.test.ts keeps them equal
import schema from '@/llm/bench-schema.json';

// The bench on this phone (settings → bench): the same measurements kula-node bench makes
// on a computer, with what the phone has. Memory bandwidth from the native copy benchmark;
// generation tok/s and time to first token from `generate` (64 tokens × 3, one fixed
// prompt; the native side reports no prompt timings apart, so prompt_tps stays null);
// per saved peer the gate round trip (probePeer, timed here, so a little high), the api
// tunnel speed (GET /blob?mb=10) and, when the loaded model runs in apart mode on that
// peer, its tok/s over the tunnel. Split: the load time of the current split load and its
// token latency. Anything that needs a model that is not loaded is skipped and said.
export const TOOL = 'kula-app 1.0.0';
export const BENCH_PROMPT = 'You are a careful assistant. In plain words, explain how a bicycle pump pushes air into a tyre, '
  + 'why the pump gets warm after a while, and what the valve does when you pull the pump off. '
  + 'Then list three things that can go wrong and how to notice each one. Keep every sentence short.';

export type Step = 'memory' | 'local' | 'peers' | 'split' | 'done';
export type BenchOptions = { runs?: number; tokens?: number; blobMb?: number; peers?: Peer[]; onStep?: (step: Step, who?: string) => void; fetchImpl?: typeof fetch };

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Pulls GET /blob?mb= through an api tunnel to the peer and times it; null when the peer has no /blob. */
export async function tunnelSpeed(port: number, mb: number, fetchImpl: typeof fetch = fetch): Promise<{ bytes: number; ms: number; mb_per_s: number } | null> {
  const t0 = Date.now();
  const res = await fetchImpl(`http://127.0.0.1:${port}/blob?mb=${mb}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`blob: http ${res.status}`);
  const buf = await res.arrayBuffer();
  const ms = Math.max(1, Date.now() - t0);
  return { bytes: buf.byteLength, ms, mb_per_s: r2(buf.byteLength / 1e6 / (ms / 1000)) };
}

export async function runPhoneBench(opts: BenchOptions = {}): Promise<BenchResult> {
  const n = native();
  const runs = opts.runs ?? 3;
  const tokens = opts.tokens ?? 64;
  const blobMb = opts.blobMb ?? 10;
  const step = opts.onStep ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  const skipped: Skipped[] = [];
  const notes: string[] = [];
  const passport = lastPassport();
  const info = await n.info();
  const st = engine();
  const device: BenchResult['device'] = {
    id: passport?.device_id ?? info.workerId, name: passport?.device ?? 'this phone', kind: passport?.kind === 'tablet' ? 'tablet' : 'phone',
    os: `android ${passport?.android ?? Platform.Version}`, soc: passport?.soc ?? null, cores: Number(passport?.cpu_cores) || null, threads: info.fastCores || null,
    ram_total_mb: passport ? Math.round(Number(passport.ram_total_gb) * 1024) || null : null, ram_free_mb: info.ramFreeMb || null,
    passport_bw_gbs: Number(passport?.mem_bw_read_gbs) || Number(passport?.mem_bw_gbs) || null,
  };

  step('memory');
  let memory: BenchResult['memory'] = null;
  try {
    const bw = await n.memBandwidth(0);
    if (bw > 0) memory = { bandwidth_gbs: r2(bw), method: 'native memBandwidth (copy on the fast cores)', threads: info.fastCores || null };
    else skipped.push({ what: 'memory', who: null, why: 'memBandwidth returned 0' });
  } catch (e) { skipped.push({ what: 'memory', who: null, why: (e as Error).message }); }

  // the loaded model, if any, is what local, apart and split are measured with
  const model: BenchResult['model'] = st.model && st.load
    ? { name: st.model.file, size_bytes: st.model.size, ctx: st.load.ctx, sha256: st.model.sha256, params_b: st.model.params_b || null, quant: st.model.quant || null }
    : null;

  step('local');
  let local: BenchLocal | null = null;
  let split: BenchSplit | null = null;
  if (!model || !st.load) {
    skipped.push({ what: 'local', who: null, why: 'no model loaded: pick one under models and come back' });
  } else if (st.generating) {
    skipped.push({ what: 'local', who: null, why: 'a reply is being generated' });
  } else {
    try {
      const gen: number[] = []; const first: number[] = [];
      await chatLocal([{ role: 'user', content: BENCH_PROMPT }], () => {}, { maxTokens: 8, temperature: 0, reset: true });
      for (let i = 0; i < runs; i++) {
        const r = await chatLocal([{ role: 'user', content: BENCH_PROMPT }], () => {}, { maxTokens: tokens, temperature: 0, reset: true });
        gen.push(r.tps); first.push(r.firstMs);
      }
      local = { mode: st.mode, runs, tokens_per_run: tokens, gen_tps: stat(gen), first_token_ms: stat(first), prompt_tps: null, prompt_tokens: null, load_ms: st.load.loadMs };
      notes.push('prompt_tps null: the phone reports the first token time, not prompt evaluation apart');
      if (st.mode === 'split' && st.plan) {
        split = { peers: st.plan.used.map((u) => u.id), local_mb: st.plan.localMb, load_ms: st.load.loadMs, runs, tokens_per_run: tokens, gen_tps: local.gen_tps, first_token_ms: local.first_token_ms, token_ms: local.gen_tps.median > 0 ? Math.round((1000 / local.gen_tps.median) * 10) / 10 : 0 };
      }
    } catch (e) { skipped.push({ what: 'local', who: null, why: (e as Error).message }); }
  }
  if (!split && !(model && st.mode === 'split')) skipped.push({ what: 'split', who: null, why: model ? `the model runs in ${st.mode} mode; load it split to measure that` : 'no model loaded' });

  const peers: BenchPeer[] = [];
  for (const p of opts.peers ?? savedPeers()) {
    step('peers', p.name);
    const row: BenchPeer = { id: p.id, name: p.name, kind: p.kind, gate_rtt_ms: null, tunnel: null, apart: null, error: null };
    peers.push(row);
    const rtts: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = Date.now();
      const why = await n.probePeer(p.host, p.port, p.secret, 'api').catch((e: Error) => e.message);
      if (why) { row.error = why; break; }
      rtts.push(Date.now() - t0);
    }
    if (row.error) { skipped.push({ what: 'peer', who: p.name, why: row.error }); continue; }
    row.gate_rtt_ms = stat(rtts);
    try {
      const port = await n.apiTunnel(p.host, p.port, p.secret);
      row.tunnel = await tunnelSpeed(port, blobMb, fetchImpl);
      if (!row.tunnel) skipped.push({ what: 'tunnel', who: p.name, why: 'the peer has no GET /blob (older build)' });
    } catch (e) { skipped.push({ what: 'tunnel', who: p.name, why: (e as Error).message }); }
    // apart: only a peer that is a device of the current apart load has the model
    const dev = st.mode === 'apart' ? st.devices.find((d) => d.id === p.id && !d.local && d.apiPort) : null;
    if (!model) skipped.push({ what: 'apart', who: p.name, why: 'no model loaded' });
    else if (!dev) skipped.push({ what: 'apart', who: p.name, why: st.mode === 'apart' ? 'not a device of this load (it did not answer when the model was loaded)' : `the model runs in ${st.mode} mode; load it apart with this peer to measure that` });
    else {
      try {
        const gen: number[] = []; const first: number[] = [];
        await chatRemote(dev, [{ role: 'user', content: BENCH_PROMPT }], () => {}, { maxTokens: 8, temperature: 0, reset: true });
        for (let i = 0; i < runs; i++) {
          const r = await chatRemote(dev, [{ role: 'user', content: BENCH_PROMPT }], () => {}, { maxTokens: tokens, temperature: 0, reset: true });
          gen.push(r.tps); first.push(r.firstMs);
        }
        row.apart = { load_ms: null, runs, tokens_per_run: tokens, gen_tps: stat(gen), first_token_ms: stat(first) };
      } catch (e) { skipped.push({ what: 'apart', who: p.name, why: (e as Error).message }); }
    }
  }

  step('done');
  const result: BenchResult = { schema: BENCH_SCHEMA, measured_at: new Date().toISOString(), tool: TOOL, device, model, memory, local, peers, split, skipped, notes };
  assertValid(schema, result);
  rememberBench(result);
  return result;
}

export const canBench = () => !!llama;
