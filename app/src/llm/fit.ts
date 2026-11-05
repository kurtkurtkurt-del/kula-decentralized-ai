import { COMBINE, type Passport } from '@/passport/contract';

// Does this model fit this phone, and how fast would it go? Pure functions over the
// passport (src/data/passport.ts) and a model's size, so the catalog can be sorted before
// anything is downloaded. Numbers follow PrivateLM's pre-load check (file + KV + overhead)
// and the passport's own budget rule (app_mem_cap, ram_free × 0.8). Once a file is on the
// phone its GGUF header gives the true layer and KV figures (kvFromMeta); they win over
// the catalog's or the name-based guess.
export type FitInput = { size: number; kv_mb_per_1k: number; ctx: number };
export type Fit = {
  needMb: number;          // file + kv + overhead at this ctx
  haveMb: number;          // what this device can give a model
  verdict: 'fits' | 'tight' | 'no';
  maxCtx: number;          // the largest ctx (power of two ≥ 512) that fits, 0 when none
  tps: { low: number; high: number } | null; // from the passport's bandwidth
};

export const OVERHEAD_MB = 300;
const MB = 1024 * 1024;

/** Memory a model takes at a context size, in MB. */
export function needMb(m: FitInput, ctx = m.ctx): number {
  const file = m.size / MB;
  return Math.round(file + (m.kv_mb_per_1k * ctx) / 1024 + OVERHEAD_MB + file * 0.05);
}

/** What a device can give one model: the passport's budget when measured, else free RAM × 0.8. */
export function haveMb(p: Passport | null): number {
  if (!p) return 0;
  if (p.budget && Number(p.budget.ram_gb) > 0) return Math.round(Number(p.budget.ram_gb) * 1024);
  const cap = Number(p.app_mem_cap_mb) || 0;
  const free = (Number(p.ram_free_gb) || 0) * 1024 * 0.8;
  // app_mem_cap_mb is the Java heap cap: native allocations go past it, so it is a floor, not a ceiling
  return Math.round(Math.max(free, cap));
}

export function fitOn(p: Passport | null, m: FitInput): Fit {
  const have = haveMb(p);
  const need = needMb(m);
  let maxCtx = 0;
  for (let c = 512; c <= m.ctx * 4 && c <= 32768; c *= 2) if (needMb(m, c) <= have) maxCtx = c;
  const verdict: Fit['verdict'] = need <= have * 0.85 ? 'fits' : need <= have ? 'tight' : 'no';
  const bw = p ? Number(p.mem_bw_read_gbs) || Number(p.mem_bw_gbs) || 0 : 0;
  const gb = m.size / 1024 ** 3;
  // a token streams the weights once: tok/s ≈ bandwidth × efficiency / size; hot phones at half
  const high = bw > 0 ? r1((bw * COMBINE.efficiency) / gb) : 0;
  const tps = high > 0 ? { low: r1(high * COMBINE.hot), high } : null;
  return { needMb: need, haveMb: have, verdict, maxCtx, tps };
}

/** Across devices (split mode): budgets add up; speed is the slowest link plus the hops. */
export function fitTogether(ps: Passport[], m: FitInput): Fit & { shares: { name: string; mb: number }[] } {
  const have = ps.reduce((a, p) => a + haveMb(p), 0);
  const need = needMb(m);
  let maxCtx = 0;
  for (let c = 512; c <= m.ctx * 4 && c <= 32768; c *= 2) if (needMb(m, c) <= have) maxCtx = c;
  const verdict: Fit['verdict'] = need <= have * 0.85 ? 'fits' : need <= have ? 'tight' : 'no';
  // fill the fastest device first, up to what it can hold (PrivateLM's _fillFastestFirst)
  const sorted = [...ps].sort((a, b) => bwOf(b) - bwOf(a));
  let left = m.size / MB;
  const shares: { name: string; mb: number; bw: number }[] = [];
  for (const p of sorted) {
    const mb = Math.min(haveMb(p) * 0.9, left);
    if (mb <= 0) continue;
    shares.push({ name: p.device, mb: Math.round(mb), bw: bwOf(p) });
    left -= mb;
    if (left <= 0) break;
  }
  let tps: Fit['tps'] = null;
  if (shares.length && shares.every((s) => s.bw > 0)) {
    const cool = shares.reduce((a, s) => a + s.mb / 1024 / (s.bw * COMBINE.efficiency), 0) + Math.max(0, shares.length - 1) * COMBINE.hopS;
    tps = { low: r1(COMBINE.hot / cool), high: r1(1 / cool) };
  }
  return { needMb: need, haveMb: have, verdict, maxCtx, tps, shares: shares.map(({ name, mb }) => ({ name, mb })) };
}

const bwOf = (p: Passport) => Number(p.mem_bw_read_gbs) || Number(p.mem_bw_gbs) || 0;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** A sensible default context for a model on a device: the largest that fits, at most 4 096. */
export const defaultCtx = (f: Fit) => Math.min(4096, Math.max(512, f.maxCtx || 512));

// ---- from the file's own header ----------------------------------------------------------
/** What ggufMeta (native) hands back, as strings: layers, heads_kv, key_len … */
export type GgufMeta = Record<string, string>;
export type MetaFacts = { layers: number; kv_mb_per_1k: number; ctx_max: number; arch: string | null; name: string | null; license: string | null };

/**
 * KV cache per 1 024 tokens from the header: layers × heads_kv × (k + v dims) × 2 bytes (f16).
 * key/value dims fall back to embd / heads when the header does not name them. Null when
 * the header lacks the layer or head counts (then the catalog or the guess stays).
 */
export function kvFromMeta(meta: GgufMeta | null | undefined): number | null {
  if (!meta) return null;
  const n = (k: string) => Number(meta[k]) || 0;
  const layers = n('layers');
  const heads = n('heads');
  const headsKv = n('heads_kv') || heads;
  if (!layers || !headsKv) return null;
  const dim = n('embd') && heads ? Math.round(n('embd') / heads) : 0;
  const k = n('key_len') || dim;
  const v = n('value_len') || dim;
  if (!k || !v) return null;
  return Math.round((layers * headsKv * (k + v) * 2 * 1024) / MB * 10) / 10;
}

/** The facts the fit needs, when the header gives them. */
export function factsFromMeta(meta: GgufMeta | null | undefined): MetaFacts | null {
  const kv = kvFromMeta(meta);
  if (!meta || kv === null) return null;
  return {
    layers: Number(meta.layers) || 0,
    kv_mb_per_1k: kv,
    ctx_max: Number(meta.ctx) || 0,
    arch: meta.arch || null,
    name: meta.name || null,
    license: meta.license || null,
  };
}

/** A model's fit input with the header's figures over the stored ones, when there is a header. */
export function fitInput(m: { size: number; kv_mb_per_1k: number }, ctx: number, meta?: GgufMeta | null): FitInput {
  const kv = kvFromMeta(meta);
  return { size: m.size, kv_mb_per_1k: kv ?? m.kv_mb_per_1k, ctx };
}

/**
 * The context to suggest: the largest power of two that fits, no more than the model was
 * trained for and no more than 8 192 (longer costs speed on a phone); 1 024 when nothing fits,
 * so the user can still try.
 */
export function suggestCtx(f: Fit, ctxMax: number): number {
  const cap = Math.min(ctxMax > 0 ? ctxMax : 8192, 8192);
  if (f.maxCtx <= 0) return Math.min(1024, cap);
  let c = 512;
  while (c * 2 <= Math.min(f.maxCtx, cap)) c *= 2;
  return c;
}
