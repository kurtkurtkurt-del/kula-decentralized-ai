import Storage from 'expo-sqlite/kv-store';
import { COMBINE } from '@/passport/contract';

// Bench results (kula-bench/1, tools/bench-schema.json, docs/BENCH.md): the types both
// sides write, the medians, the history this phone keeps in kv-store, and the lookup the
// planner uses: a measured tok/s for a device and a model beats the bandwidth formula.
// Nothing native here; the measuring itself is benchrun.ts.
export const BENCH_SCHEMA = 'kula-bench/1';
export type Stat = { median: number; runs: number[] };
export type BenchKind = 'phone' | 'tablet' | 'pc';
export type BenchDevice = { id: string; name: string; kind: BenchKind; os: string; soc: string | null; cores: number | null; threads: number | null; ram_total_mb: number | null; ram_free_mb: number | null; passport_bw_gbs: number | null };
export type BenchModel = { name: string; size_bytes: number; ctx: number; sha256: string | null; params_b: number | null; quant: string | null };
export type BenchLocal = { mode: 'alone' | 'apart' | 'split'; runs: number; tokens_per_run: number; gen_tps: Stat; first_token_ms: Stat; prompt_tps: Stat | null; prompt_tokens: number | null; load_ms: number | null };
export type BenchTunnel = { bytes: number; ms: number; mb_per_s: number };
export type BenchApart = { load_ms: number | null; runs: number; tokens_per_run: number; gen_tps: Stat; first_token_ms: Stat };
export type BenchPeer = { id: string; name: string; kind: BenchKind; gate_rtt_ms: Stat | null; tunnel: BenchTunnel | null; apart: BenchApart | null; error: string | null };
export type BenchSplit = { peers: string[]; local_mb: number | null; load_ms: number; runs: number; tokens_per_run: number; gen_tps: Stat; first_token_ms: Stat; token_ms: number };
export type Skipped = { what: 'memory' | 'local' | 'peer' | 'tunnel' | 'apart' | 'split'; who: string | null; why: string };
export type BenchResult = {
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
};

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const r1 = (x: number) => Math.round(x * 10) / 10;
export const stat = (runs: number[]): Stat => ({ median: r1(median(runs)), runs: runs.map(r1) });

// ---- history on this phone -------------------------------------------------------------
const KEY = 'llm.bench';
export const KEEP = 20;
const listeners = new Set<() => void>();
export const onBenchChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function benchHistory(): BenchResult[] {
  try {
    const v = JSON.parse(Storage.getItemSync(KEY) ?? '[]');
    return Array.isArray(v) ? (v as BenchResult[]) : [];
  } catch {
    return [];
  }
}
/** Newest first, at most KEEP kept. */
export function rememberBench(r: BenchResult) {
  try { Storage.setItemSync(KEY, JSON.stringify([r, ...benchHistory()].slice(0, KEEP))); } catch {}
  listeners.forEach((fn) => fn());
}
export function forgetBench(measuredAt: string) {
  try { Storage.setItemSync(KEY, JSON.stringify(benchHistory().filter((r) => r.measured_at !== measuredAt))); } catch {}
  listeners.forEach((fn) => fn());
}

// ---- what the planner reads ------------------------------------------------------------
export type Measured = { tps: number; first_token_ms: number; measured_at: string; mode: 'alone' | 'apart' | 'split' };

/**
 * The newest measured generation tok/s for a device running a model by itself: this phone's
 * `local` (device id = the passport's device_id) or a peer's `apart` (device id = the peer's
 * id), matched on the model file name. Split runs are not a device's own speed and are not
 * returned. Null when nothing was measured.
 */
export function measuredTps(deviceId: string | null | undefined, modelFile: string | null | undefined): Measured | null {
  if (!deviceId || !modelFile) return null;
  for (const r of benchHistory()) {
    if (!r.model || r.model.name !== modelFile) continue;
    if (r.local && r.device.id === deviceId && r.local.mode !== 'split' && r.local.gen_tps.median > 0) {
      return { tps: r.local.gen_tps.median, first_token_ms: r.local.first_token_ms.median, measured_at: r.measured_at, mode: r.local.mode };
    }
    const p = r.peers.find((x) => x.id === deviceId && x.apart && x.apart.gen_tps.median > 0);
    if (p?.apart) return { tps: p.apart.gen_tps.median, first_token_ms: p.apart.first_token_ms.median, measured_at: r.measured_at, mode: 'apart' };
  }
  return null;
}

/**
 * The bandwidth the planner should pretend a device has: the one that, through the formula
 * tok/s = bw × efficiency / size, gives the measured tok/s; `fallback` when nothing was
 * measured. So a measured device is ranked and given shares by what it really did.
 */
export function effectiveBw(deviceId: string | null | undefined, modelFile: string | null | undefined, sizeBytes: number, fallback: number): number {
  const m = measuredTps(deviceId, modelFile);
  if (!m || !(sizeBytes > 0)) return fallback;
  return Math.round(((m.tps * (sizeBytes / 1024 ** 3)) / COMBINE.efficiency) * 100) / 100;
}

/** The newest tunnel speed to a peer in MB/s, or null. */
export function measuredTunnel(peerId: string): BenchTunnel | null {
  for (const r of benchHistory()) {
    const p = r.peers.find((x) => x.id === peerId && x.tunnel);
    if (p?.tunnel) return p.tunnel;
  }
  return null;
}

// ---- the card --------------------------------------------------------------------------
const fmt = (s: Stat | null, unit: string) => (s ? `${s.median} ${unit}` : '?');

/** One line per measurement, for the result card and the share text. */
export function benchLines(r: BenchResult): string[] {
  const out: string[] = [];
  out.push(`${r.device.name} · ${r.device.os}${r.device.ram_total_mb ? ` · ${Math.round(r.device.ram_total_mb / 1024)} gb` : ''}`);
  if (r.model) out.push(`${r.model.name} · ${(r.model.size_bytes / 1e6).toFixed(0)} mb · ctx ${r.model.ctx}`);
  out.push(`memory bw · ${r.memory ? `${r.memory.bandwidth_gbs} gb/s` : '?'}${r.device.passport_bw_gbs ? ` (passport ${r.device.passport_bw_gbs})` : ''}`);
  if (r.local) out.push(`${r.local.mode} · gen ${fmt(r.local.gen_tps, 'tok/s')} · first token ${fmt(r.local.first_token_ms, 'ms')}${r.local.prompt_tps ? ` · prompt ${fmt(r.local.prompt_tps, 'tok/s')}` : ''} (${r.local.runs}×${r.local.tokens_per_run})`);
  for (const p of r.peers) {
    if (p.error) { out.push(`${p.name} · ${p.error}`); continue; }
    const parts = [`gate ${fmt(p.gate_rtt_ms, 'ms')}`, `tunnel ${p.tunnel ? `${p.tunnel.mb_per_s} mb/s` : '?'}`];
    if (p.apart) parts.push(`apart ${p.apart.gen_tps.median} tok/s · first ${p.apart.first_token_ms.median} ms`);
    out.push(`${p.name} · ${parts.join(' · ')}`);
  }
  if (r.split) out.push(`split · ${r.split.peers.length} peer · load ${(r.split.load_ms / 1000).toFixed(1)} s · ${r.split.gen_tps.median} tok/s · ${r.split.token_ms} ms/token`);
  for (const s of r.skipped) out.push(`skipped ${s.what}${s.who ? ` (${s.who})` : ''} · ${s.why}`);
  return out;
}
