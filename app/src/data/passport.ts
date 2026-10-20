import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Storage from 'expo-sqlite/kv-store';
import { supabase } from '@/lib/supabase';
import { invalidate, must, newId, outbox, pendingJobs, remember, send, useShelf } from '@/lib/offline';
import { measureNative, nativeAvailable } from '@/passport/measure';

// The device passport (passport/0.1): what this phone can carry at night. Measured by
// modules/passport-measure on Android (Kotlin: RAM, SoC, cpufreq, a 256 MB arraycopy
// bandwidth test, a 512×512 matrix multiply on every core, StatFs, BatteryManager); on
// iOS and in Expo Go a JS fallback marked "approx" (expo-device + a Float32Array copy).
// The result goes to the shelf first, then through the outbox to passport_save (07).
export type Passport = {
  schema: 'passport/0.1';
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
};

const LAST = 'passport.last';
export const STEPS = [1, 3, 4, 7, 8, 12, 14];

// Largest Q4 model that fits: usable = min(free RAM, app cap) × 0.8, ~0.6 GB per 1B;
// rough tokens/s = bandwidth / model size × 0.5. The same rule as Measure.kt.
export function estimateModel(ramFreeGb: number, appMemCapMb: number, memBwGbs: number): { label: string; tps: number; fit: number | null } {
  const usable = Math.min(ramFreeGb, appMemCapMb / 1024) * 0.8;
  const fit = [...STEPS].reverse().find((b) => b * 0.6 <= usable) ?? null;
  const sizeGb = (fit ?? 1) * 0.6;
  const tps = sizeGb > 0 && memBwGbs > 0 ? Math.round((memBwGbs / sizeGb) * 0.5 * 10) / 10 : 0;
  return { label: fit === null ? '<1B' : `~${fit}B`, tps, fit };
}

// The JS fallback: a 64 MB Float32Array copied three times after a warm-up. It measures
// the JS engine more than the memory bus, hence "approx".
async function measureJs(): Promise<Passport> {
  const ramTotal = (Device.totalMemory ?? 0) / 1024 ** 3;
  const ramFree = ramTotal * 0.45;
  const cap = Platform.OS === 'ios' ? Math.round(ramTotal * 1024 * 0.5) : 512;
  const n = 16 * 1024 * 1024;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  b.set(a);
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) b.set(a);
  const sec = Math.max(0.001, (Date.now() - t0) / 1000);
  const bw = Math.round(((2 * n * 4 * 3) / sec / 1e9) * 100) / 100;
  // a 256×256 multiply, three times, on one core
  const m = 256;
  const x = new Float32Array(m * m).map((_, i) => (i % 7) * 0.5);
  const y = new Float32Array(m * m).map((_, i) => (i % 5) * 0.25);
  const z = new Float32Array(m * m);
  const t1 = Date.now();
  for (let r = 0; r < 3; r++) for (let i = 0; i < m; i++) for (let k = 0; k < m; k++) { const aik = x[i * m + k]; for (let j = 0; j < m; j++) z[i * m + j] += aik * y[k * m + j]; }
  const gf = Math.round(((3 * 2 * m * m * m) / Math.max(0.001, (Date.now() - t1) / 1000) / 1e9) * 100) / 100;
  const est = estimateModel(ramFree, cap, bw);
  return {
    schema: 'passport/0.1', device: `${Device.manufacturer ?? ''} ${Device.modelName ?? ''}`.trim() || 'unknown', soc: Device.modelId ?? 'unknown',
    android: Platform.OS === 'android' ? String(Device.osVersion ?? '') : `${Platform.OS} ${Device.osVersion ?? ''}`,
    ram_total_gb: Math.round(ramTotal * 10) / 10, ram_free_gb: Math.round(ramFree * 10) / 10, app_mem_cap_mb: cap,
    cpu_cores: 0, cpu_max_ghz: 0, mem_bw_gbs: bw, gflops: gf, storage_free_gb: 0, battery_pct: 0, charging: false,
    largest_model_q4: est.label, est_tps: est.tps, measured_at: new Date().toISOString(), approx: true,
  };
}

// Measure: native where it exists, the JS fallback elsewhere. The result is kept on the
// phone and sent to the account (a retry with the same id changes nothing).
export async function measure(): Promise<Passport> {
  const p = nativeAvailable() ? await measureNative() : await measureJs();
  try {
    Storage.setItemSync(LAST, JSON.stringify(p));
  } catch {}
  listeners.forEach((fn) => fn());
  await send({ kind: 'passport', data: p, clientId: newId() }).catch(() => {});
  return p;
}
outbox(
  'passport',
  async (j) => {
    const { error } = await supabase.rpc('passport_save', { p_data: j.data, p_client_id: j.clientId });
    if (error) throw error;
  },
  ['passports', 'network'],
);

// The last passport on this phone, at once.
export function lastPassport(): Passport | null {
  try {
    const raw = Storage.getItemSync(LAST);
    return raw ? (JSON.parse(raw) as Passport) : null;
  } catch {
    return null;
  }
}
const listeners = new Set<() => void>();
export function usePassport() {
  const [p, setP] = useState<Passport | null>(lastPassport);
  useEffect(() => {
    const fn = () => setP(lastPassport());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return p;
}

// Your measurements on the account (passport_mine), newest first; the ones still in
// the outbox come first.
export type PassportRow = { id: string; data: Passport; measured_at: string; waiting?: boolean };
export async function passportsMine(): Promise<PassportRow[]> {
  const waiting: PassportRow[] = pendingJobs('passport').map((j) => ({ id: j.id, data: j.data as Passport, measured_at: new Date(j.at).toISOString(), waiting: true })).reverse();
  const rows = await remember('passports', '', async () => ((await must(supabase.rpc('passport_mine', { p_limit: 10 }))) ?? []) as PassportRow[]).catch(() => [] as PassportRow[]);
  return [...waiting, ...rows];
}
export const usePassportsShelf = () => useShelf('passports');
export const forgetPassports = () => invalidate('passports');
export const passportJson = (p: Passport) => JSON.stringify({ ...p, approx: undefined }, null, 2);
