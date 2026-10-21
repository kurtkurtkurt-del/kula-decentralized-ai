// kula's side of the passport-core contract (../device-passport/passport-core/contract/
// CONTRACT.md). The native measurement is device-passport's own code, compiled into
// modules/passport-measure; this file decides what kula accepts from it, from a qr code or
// from pasted json, and keeps the JS fallback's estimate in step with the Kotlin rule.
// src/__tests__/passport-contract.test.ts holds both against contract/ — a change in
// device-passport that kula does not follow fails that test, not the phone.

/** PassportCore.API values this app understands. A newer one: the JS fallback runs. */
export const SUPPORTED_API = [1];
/** passport/<major>.<minor>: any minor of these majors (newer minors add fields only). */
export const SUPPORTED_MAJOR = [0];
export const SCHEMA = 'passport/0.2'; // what kula's JS fallback writes (it cannot measure 0.3's fields)

export type DeviceKind = 'phone' | 'tablet' | 'computer';
/** What a model may use here: available × 0.8 minus the context's KV and buffers, and the params it holds per quant. */
export type Budget = { ctx: number; reserve_gb: number; ram_gb: number; q4_k_m_b: number; q3_k_s_b: number; q8_0_b: number };
/** Tokens/s for the largest Q4_K_M step that fits: hot (low) to cool (high); source says how it was found. */
export type SpeedRange = { fit_b: number; tps_low: number; tps_high: number; source: string };
export type Passport = {
  schema: string; // 'passport/0.1' · 'passport/0.2' · a newer minor
  device: string;
  soc: string;
  android: string;
  ram_total_gb: number;
  ram_free_gb: number;
  app_mem_cap_mb: number;
  cpu_cores: number;
  cpu_max_ghz: number;
  mem_bw_gbs: number;
  gflops: number;
  storage_free_gb: number;
  battery_pct: number;
  charging: boolean;
  largest_model_q4: string;
  est_tps: number;
  measured_at: string;
  approx?: boolean; // the JS fallback, not the native measurement
  device_id?: string; // 0.2
  kind?: DeviceKind; // 0.2
  os?: string; // 0.2: "android 15", "ios 18.1", "macos 14 · chrome", …
  // 0.3 (phase 1, device-passport Probe.kt): only from the native measurement
  mem_bw_read_gbs?: number; // the best read bandwidth over bw_threads
  bw_threads?: Record<string, number>; // read bandwidth per thread count, GB/s
  best_threads?: number;
  clusters?: { count: number; max_ghz: number }[];
  cpu_features?: string[];
  thermal?: { status: number; headroom: number; battery_c: number }; // -1: unknown
  gpu?: { opencl: boolean; vulkan: string; model: string };
  wifi?: { band: string; link_mbps: number }; // band "" when not on Wi-Fi
  budget?: Budget;
  estimate?: SpeedRange;
  measure_ms?: number;
  [newer: string]: unknown; // fields of a newer minor: kept and sent on, not shown yet
};

const NUMBERS = ['ram_total_gb', 'ram_free_gb', 'app_mem_cap_mb', 'cpu_cores', 'cpu_max_ghz', 'mem_bw_gbs', 'gflops', 'storage_free_gb', 'battery_pct', 'est_tps'] as const;
const STRINGS = ['device', 'soc', 'android', 'largest_model_q4', 'measured_at'] as const;
const KINDS: DeviceKind[] = ['phone', 'tablet', 'computer'];
/** Every key this app knows by name; anything else in a passport came from a newer minor. */
export const KNOWN_KEYS = ['schema', ...NUMBERS, ...STRINGS, 'charging', 'approx', 'device_id', 'kind', 'os',
  'mem_bw_read_gbs', 'bw_threads', 'best_threads', 'clusters', 'cpu_features', 'thermal', 'gpu', 'wifi', 'budget', 'estimate', 'measure_ms'];

export type PassportError = 'notPassport' | 'incomplete' | 'newer';
const fail = (code: PassportError): never => {
  throw new Error(code);
};

/**
 * Any passport json (native, a qr code, pasted) as one shape. Throws notPassport (not a
 * passport at all), incomplete (no device or speed: measure again there) or newer (a major
 * this app does not read: update kula). Missing numbers read 0, unknown fields stay.
 */
export function normalizePassport(raw: unknown): Passport {
  const o = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return fail('notPassport');
  const src = o as Record<string, unknown>;
  const m = typeof src.schema === 'string' ? /^passport\/(\d+)\.(\d+)$/.exec(src.schema) : null;
  if (!m) return fail('notPassport');
  if (!SUPPORTED_MAJOR.includes(Number(m[1]))) return fail('newer');
  const tps = Number(src.est_tps);
  if (typeof src.device !== 'string' || !src.device || src.est_tps === null || src.est_tps === '' || !(tps >= 0)) return fail('incomplete');
  const p: Passport = { ...(src as Passport) };
  for (const k of NUMBERS) {
    const n = Number(src[k]);
    p[k] = Number.isFinite(n) ? n : 0;
  }
  for (const k of STRINGS) p[k] = typeof src[k] === 'string' ? (src[k] as string) : '';
  p.charging = src.charging === true || src.charging === 'true';
  if (src.kind !== undefined) p.kind = KINDS.includes(src.kind as DeviceKind) ? (src.kind as DeviceKind) : 'phone';
  // 0.3's objects: a wrong shape is dropped rather than shown wrong
  for (const k of ['bw_threads', 'thermal', 'gpu', 'wifi', 'budget', 'estimate'] as const) {
    if (src[k] !== undefined && (typeof src[k] !== 'object' || src[k] === null || Array.isArray(src[k]))) delete p[k];
  }
  for (const k of ['clusters', 'cpu_features'] as const) if (src[k] !== undefined && !Array.isArray(src[k])) delete p[k];
  return p;
}
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

/** Keys of a passport this app does not know yet (a newer minor's fields). */
export const unknownKeys = (p: Record<string, unknown>) => Object.keys(p).filter((k) => !KNOWN_KEYS.includes(k));

// The estimate rule, the same as estimateModel in Measure.kt (passport-core); only the JS
// fallback uses it here. contract/estimate-cases.json is the judge of "the same".
export const STEPS = [1, 3, 4, 7, 8, 12, 14];
const r1 = (x: number) => Math.round(x * 10) / 10; // half up, as Kotlin's floor(x * 10 + 0.5) / 10
export function estimateModel(ramFreeGb: number, memBwGbs: number): { label: string; tps: number; fit: number | null } {
  const usable = ramFreeGb * 0.8;
  const fit = [...STEPS].reverse().find((b) => b * 0.6 <= usable) ?? null;
  const sizeGb = (fit ?? 1) * 0.6;
  const tps = sizeGb > 0 && memBwGbs > 0 ? r1((memBwGbs / sizeGb) * 0.5) : 0;
  return { label: fit === null ? '<1B' : `~${fit}B`, tps, fit };
}

// What the screens show for a passport's speed (together, the device rows): the 0.3 range
// when it was measured, else est_tps at both ends. Same rule as device-passport's Together.kt.
export function rangeOf(p: Passport): { low: number; high: number } {
  const e = p.estimate;
  return e && e.tps_high > 0 ? { low: Number(e.tps_low), high: Number(e.tps_high) } : { low: Number(p.est_tps) || 0, high: Number(p.est_tps) || 0 };
}
/** The best model a passport runs: the 0.3 budget's step when measured, else the old label. */
export const fitLabelOf = (p: Passport) => (p.estimate && p.estimate.tps_high > 0 ? (p.estimate.fit_b ? `~${p.estimate.fit_b}B` : '<1B') : p.largest_model_q4);
/** "28.6–57.3", or one number when both ends agree. */
export const rangeText = (low: number, high: number) => (low === high ? String(low) : `${low}–${high}`);

// ---- "what if they join?" (the together page, 22.10.2026) ----------------------------
// Two ways devices can work together, estimated from their passports:
//  apart — every device runs its own copy of a model on its own jobs: the speeds add up,
//          the model is the best device's (memory is not pooled);
//  split — one model cut across the devices (llama.cpp rpc): the budgets add up, so a
//          bigger model fits, but every token passes each device in turn and crosses the
//          network between them. Shares go to the fastest device first. A hop costs what the
//          wifi split test measured (11.10.2026, ~100 ms); a leaner protocol would need
//          a few ms, shown for comparison. None of the factors is calibrated yet.
export const COMBINE = { hopS: 0.1, leanHopS: 0.005, efficiency: 0.6, hot: 0.5, gbPerB: 0.61, steps: [1, 3, 4, 7, 8, 12, 14, 24, 32, 70], nightHours: 8.5 };
export type CombineDevice = { name: string; kind: string; budgetGb: number; bwGbs: number; low: number; high: number; fitB: number };
export type Share = { name: string; gb: number; msCool: number };
export type Combined = {
  devices: CombineDevice[];
  apart: { low: number; high: number; fitB: number; tokensLow: number; tokensHigh: number };
  split: { budgetGb: number; fitB: number; sizeGb: number; shares: Share[]; hops: number; low: number; high: number; leanHigh: number } | null;
};
const r1c = (x: number) => Math.round(x * 10) / 10;
const fitNumber = (label: string) => (label.startsWith('<') ? 0 : Number(label.replace(/[^0-9.]/g, '')) || 0);

export function deviceOf(p: Passport): CombineDevice {
  const r = rangeOf(p);
  return {
    name: p.device,
    kind: p.kind ?? 'phone',
    budgetGb: p.budget ? Number(p.budget.ram_gb) || 0 : Math.max(0, (Number(p.ram_free_gb) || 0) * 0.8 - 0.5),
    bwGbs: Number(p.mem_bw_read_gbs) || Number(p.mem_bw_gbs) || 0,
    low: r.low,
    high: r.high,
    fitB: fitNumber(fitLabelOf(p)),
  };
}

export function combine(passports: Passport[]): Combined {
  const devices = passports.map(deviceOf);
  const low = devices.reduce((a, d) => a + d.low, 0);
  const high = devices.reduce((a, d) => a + d.high, 0);
  const apart = {
    low: r1c(low), high: r1c(high), fitB: Math.max(0, ...devices.map((d) => d.fitB)),
    tokensLow: Math.round(low * 3600 * COMBINE.nightHours), tokensHigh: Math.round(high * 3600 * COMBINE.nightHours),
  };
  if (devices.length < 2) return { devices, apart, split: null };
  const budgetGb = Math.round(devices.reduce((a, d) => a + d.budgetGb, 0) * 100) / 100;
  const fitB = [...COMBINE.steps].reverse().find((b) => b * COMBINE.gbPerB <= budgetGb) ?? 0;
  if (!fitB) return { devices, apart, split: null };
  const sizeGb = fitB * COMBINE.gbPerB;
  let left = sizeGb;
  const shares: (Share & { bw: number })[] = [];
  for (const d of [...devices].sort((a, b) => b.bwGbs - a.bwGbs)) {
    const gb = Math.min(d.budgetGb, left);
    if (gb <= 0) continue;
    if (!(d.bwGbs > 0)) return { devices, apart, split: null }; // a device with no bandwidth: no estimate
    shares.push({ name: d.name, gb: Math.round(gb * 100) / 100, msCool: Math.round((gb / (d.bwGbs * COMBINE.efficiency)) * 1000), bw: d.bwGbs });
    left -= gb;
    if (left <= 1e-9) break;
  }
  const hops = Math.max(0, shares.length - 1);
  const cool = shares.reduce((a, s) => a + s.gb / (s.bw * COMBINE.efficiency), 0);
  const hot = cool / COMBINE.hot;
  return {
    devices, apart,
    split: {
      budgetGb, fitB, sizeGb: Math.round(sizeGb * 100) / 100, hops,
      shares: shares.map(({ name, gb, msCool }) => ({ name, gb, msCool })),
      high: r1c(1 / (cool + hops * COMBINE.hopS)), low: r1c(1 / (hot + hops * COMBINE.hopS)), leanHigh: r1c(1 / (cool + hops * COMBINE.leanHopS)),
    },
  };
}
