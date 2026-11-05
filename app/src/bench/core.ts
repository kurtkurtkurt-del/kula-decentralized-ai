// A bench result (tools/bench-schema.json, docs/BENCH.md) and the few pure functions both
// sides need: the median, a schema check, and "what did this device measure on this model".
// No imports, so the phone (app/src/bench/core.ts) and the computer (node/src/benchcore.ts)
// run the very same file; node/test/bench.test.ts checks the two are byte for byte equal.
//
// Units: tok/s, ms, MB/s with MB = 1024² bytes (as in the planner), GB/s = 1e9 bytes/s for
// memory bandwidth (as in the passport).

export const BENCH_VERSION = 1;
export const BLOB_MAX_MB = 64;    // GET /blob?mb=N: N is capped here on both workers
export const TUNNEL_MB = 10;      // the tunnel speed test pulls this much
export const RUNS = 3;            // every timed thing runs this often; the median is kept
export const GEN_TOKENS = 64;     // tokens generated per timed run

/** The one prompt both sides time (about 130 tokens with the chat template). */
export const BENCH_PROMPT = 'You are timing a language model. Read this passage and answer in one long paragraph. '
  + 'A cluster of phones on one wi-fi shares a model: each holds a part of the layers, the activations travel '
  + 'between them for every token, and the slowest link sets the pace. Memory bandwidth decides how fast one '
  + 'device streams its weights; the network decides how much the hops cost; the gate in front of every device '
  + 'checks a shared secret before any byte reaches llama.cpp. Explain, step by step, what limits the speed of '
  + 'such a cluster, which device should hold the output layer, and when running alone beats sharing.';

export type Unit = 'tok/s' | 'ms' | 'MB/s';
export type Series = { unit: Unit; runs: number[]; median: number; tokens?: number | null };
export type BenchDevice = { id: string; name: string; kind: 'phone' | 'tablet' | 'pc'; os: string; cpu?: string | null; threads?: number | null; ram_total_mb: number | null; ram_free_mb: number | null };
export type BenchModel = { id: string; file: string; size_bytes: number; quant: string | null; layers?: number | null };
export type BenchLocal = {
  mem_bw_gbs: number | null;
  prompt: Series | null;          // prompt processing, tok/s
  gen: Series | null;             // decoding, tok/s
  first_token_ms: Series | null;  // from the request to the first token
};
export type BenchPeer = {
  id: string;
  name: string;
  loopback: boolean;              // this device's own gate (no peer to measure against)
  gate_rtt_ms: Series | null;     // tcp connect + the gate's handshake
  tunnel_mb_s: number | null;     // GET /blob through the api channel
  tunnel_mb: number;
  apart: { gen: Series; first_token_ms: Series | null } | null;
  error: string | null;
};
export type BenchSplit = { peers: string[]; load_s: number; token_ms: Series; tps: number };
export type BenchRecord = {
  v: 1;
  kind: 'kula-bench';
  at: string;                     // ISO 8601
  source: 'node' | 'app';
  app_version?: string | null;
  device: BenchDevice;
  model: BenchModel | null;
  local: BenchLocal;
  peers: BenchPeer[];
  split: BenchSplit | null;
  skipped: { what: string; why: string }[];
};

export const r1 = (x: number) => Math.round(x * 10) / 10;

export function median(xs: number[]): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function series(unit: Unit, runs: number[], tokens?: number | null): Series {
  const rs = runs.map(r1);
  const out: Series = { unit, runs: rs, median: r1(median(rs)) };
  if (tokens !== undefined) out.tokens = tokens;
  return out;
}

/** MB/s for `bytes` in `ms` (MB = 1024²). */
export const mbPerS = (bytes: number, ms: number) => r1(bytes / (1024 * 1024) / Math.max(ms, 1) * 1000);

/** The blob size a worker serves for ?mb=…: null when it is not a positive number, capped at BLOB_MAX_MB. */
export function blobMb(q: string | null | undefined): number | null {
  if (q == null || !/^\d+$/.test(q)) return null;
  const n = Number(q);
  if (n < 1) return null;
  return Math.min(n, BLOB_MAX_MB);
}

// ---- a json schema check, the subset tools/bench-schema.json uses ----------------------
type Schema = { [k: string]: unknown };

/** Errors as "path: what"; empty when the value fits the schema. */
export function validate(schema: Schema, value: unknown, root: Schema = schema, at = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace(/^#\/\$defs\//, '');
    const defs = (root.$defs ?? {}) as Record<string, Schema>;
    if (!defs[name]) return [`${at}: unknown $ref ${schema.$ref}`];
    return validate(defs[name], value, root, at);
  }
  const errs: string[] = [];
  const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if ('const' in schema && value !== schema.const) errs.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) errs.push(`${at}: must be one of ${schema.enum.join(', ')}`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === 'integer' && t === 'number' && Number.isInteger(value)) || (x === 'number' && t === 'number' && Number.isFinite(value)));
    if (!ok) return [...errs, `${at}: must be ${types.join(' or ')}, is ${t}`];
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errs.push(`${at}: above ${schema.maximum}`);
  }
  if (typeof value === 'string' && typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: does not match ${schema.pattern}`);
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items as Schema, v, root, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const k of (schema.required ?? []) as string[]) if (!(k in o)) errs.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(o)) {
      if (props[k]) errs.push(...validate(props[k], v, root, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected ${k}`);
    }
  }
  return errs;
}

// ---- what was measured -----------------------------------------------------------------
export type ModelKey = { id: string; file?: string | null; size?: number | null };

const sameModel = (m: BenchModel | null, k: ModelKey) =>
  !!m && (m.id === k.id || (!!k.file && m.file === k.file && !!k.size && m.size_bytes === k.size));

/**
 * The newest measured decoding tok/s of a device on a model, or null. `device` is 'self'
 * for the device that ran the bench, else a peer's id (measured in apart mode).
 */
export function measuredTps(records: BenchRecord[], device: string, model: ModelKey): number | null {
  const newest = [...records].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const r of newest) {
    if (!sameModel(r.model, model)) continue;
    if (device === 'self' || device === r.device.id) {
      if (r.local.gen && r.local.gen.median > 0) return r.local.gen.median;
      continue;
    }
    const p = r.peers.find((x) => x.id === device && !x.loopback);
    if (p?.apart && p.apart.gen.median > 0) return p.apart.gen.median;
  }
  return null;
}

/** The newest measured tunnel speed to a peer (MB/s), any model. */
export function measuredTunnel(records: BenchRecord[], device: string): number | null {
  const newest = [...records].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const r of newest) {
    const p = r.peers.find((x) => x.id === device && !x.loopback);
    if (p && p.tunnel_mb_s && p.tunnel_mb_s > 0) return p.tunnel_mb_s;
  }
  return null;
}
