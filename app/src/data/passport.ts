import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Storage from 'expo-sqlite/kv-store';
import { supabase } from '@/lib/supabase';
import { invalidate, must, newId, outbox, pendingJobs, remember, send, useShelf } from '@/lib/offline';
import { measureNative, nativeAvailable } from '@/passport/measure';
import { estimateModel, normalizePassport, SCHEMA, type DeviceKind, type Passport } from '@/passport/contract';

export { estimateModel, STEPS, type DeviceKind, type Passport } from '@/passport/contract';

// The device passport (passport/0.2): what this device can carry at night. Measured on
// Android by device-passport's own code (../device-passport/passport-core, compiled into
// modules/passport-measure: RAM, SoC, cpufreq, a 256 MB arraycopy bandwidth test, a
// 512×512 matrix multiply on every core, StatFs, BatteryManager); on iOS and in Expo Go a
// JS fallback marked "approx" (expo-device + a Float32Array copy). What kula accepts from
// it, and the estimate rule both share: passport/contract.ts.
// The result goes to the shelf first, then through the outbox to passport_save (07).
// 0.2 (21.10.2026) adds who the device is: device_id (a uuid made once on this install),
// kind (phone · tablet · computer) and os. Other devices' passports arrive as qr codes
// (or pasted json) and are kept on this phone only: linkedPassports / fleet below.

const LAST = 'passport.last';
const HISTORY = 'passport.history'; // every measurement on this phone, newest last
export const MAX_HISTORY = 200;
const DEVICE = 'passport.device';
const LINKED = 'passport.linked';
export const MAX_LINKED = 8;
export const NIGHT_HOURS = 8.5;

// This install's id, made once; it tells one phone's passport from another's.
export function deviceId(): string {
  try {
    const have = Storage.getItemSync(DEVICE);
    if (have) return have;
    const id = newId();
    Storage.setItemSync(DEVICE, id);
    return id;
  } catch {
    return 'unknown';
  }
}
const kindHere = (): DeviceKind => (Device.deviceType === Device.DeviceType.TABLET ? 'tablet' : Device.deviceType === Device.DeviceType.DESKTOP ? 'computer' : 'phone');
const osHere = () => `${Platform.OS} ${Device.osVersion ?? ''}`.trim();


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
  const est = estimateModel(ramFree, bw);
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
  const raw = nativeAvailable() ? await measureNative() : await measureJs();
  // The native passport already carries kind and os (PassportCore.measure); the id is this
  // install's, the same one the qr code and the server see.
  const p: Passport = { ...raw, schema: raw.approx ? SCHEMA : raw.schema, device_id: deviceId(), kind: raw.kind ?? kindHere(), os: raw.os || osHere() };
  try {
    Storage.setItemSync(LAST, JSON.stringify(p));
    Storage.setItemSync(HISTORY, JSON.stringify([...passportHistory(), p].slice(-MAX_HISTORY)));
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

// Every passport measured on this phone (the server keeps them too, passport_mine).
export function passportHistory(): Passport[] {
  try {
    const v = JSON.parse(Storage.getItemSync(HISTORY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

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
// What the qr code carries: the same passport, compact (~450 characters, a version-15 code).
export const passportQr = (p: Passport) => JSON.stringify(p);

// ---- other devices, connected by qr ------------------------------------------------
// Kept on this phone (kv-store), never sent: a list of passports read from other devices'
// qr codes or pasted as json. Same device again (device_id, or device + soc for 0.1
// passports) replaces the old one. At most MAX_LINKED.
export type Linked = { id: string; data: Passport; added_at: string };
export function linkedPassports(): Linked[] {
  try {
    const raw = Storage.getItemSync(LINKED);
    return raw ? (JSON.parse(raw) as Linked[]) : [];
  } catch {
    return [];
  }
}
function saveLinked(list: Linked[]) {
  try {
    Storage.setItemSync(LINKED, JSON.stringify(list));
  } catch {}
  listeners.forEach((fn) => fn());
}
const sameDevice = (a: Passport, b: Passport) => (a.device_id && b.device_id ? a.device_id === b.device_id : a.device === b.device && a.soc === b.soc);

// Reads a passport from scanned or pasted text. Throws a code (devices.err.* in i18n)
// when it is not one, when it lacks the field the night relies on, or when it is this
// phone's own.
export function parsePassport(text: string): Passport {
  return normalizePassport(text); // notPassport · incomplete · newer (passport/contract.ts)
}
export function linkPassport(text: string): Passport {
  const p = parsePassport(text);
  const mine = lastPassport();
  if (p.device_id === deviceId() || (mine && sameDevice(p, mine))) throw new Error('self');
  const list = linkedPassports().filter((l) => !sameDevice(l.data, p));
  const next: Linked = { id: newId(), data: p, added_at: new Date().toISOString() };
  saveLinked([next, ...list].slice(0, MAX_LINKED));
  return p;
}
export function unlinkPassport(id: string) {
  saveLinked(linkedPassports().filter((l) => l.id !== id));
}
export function useLinked() {
  const [list, setList] = useState<Linked[]>(linkedPassports);
  useEffect(() => {
    const fn = () => setList(linkedPassports());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return list;
}

// The fleet: this device and the connected ones, as one number each where it adds up.
// Speed, compute, bandwidth and disk add; the largest model does not (memory is not
// pooled across devices), so that one is the best device's. tokens_night is what the
// fleet would make in one night window (NIGHT_HOURS) at the summed rough speed.
export type Fleet = { count: number; tps: number; gflops: number; bw: number; storage: number; largest: string; tokens_night: number };
const fitOf = (label: string) => (label.startsWith('<') ? 0 : Number(label.replace(/[^0-9.]/g, '')) || 0);
const r1 = (n: number) => Math.round(n * 10) / 10;
export function fleet(own: Passport | null, linked: Linked[]): Fleet {
  const all = [...(own ? [own] : []), ...linked.map((l) => l.data)];
  const sum = (f: (p: Passport) => number) => all.reduce((a, p) => a + (Number(f(p)) || 0), 0);
  const best = all.reduce<Passport | null>((b, p) => (!b || fitOf(p.largest_model_q4) > fitOf(b.largest_model_q4) ? p : b), null);
  const tps = r1(sum((p) => p.est_tps));
  return { count: all.length, tps, gflops: r1(sum((p) => p.gflops)), bw: r1(sum((p) => p.mem_bw_gbs)), storage: r1(sum((p) => p.storage_free_gb)), largest: best?.largest_model_q4 ?? '—', tokens_night: Math.round(tps * NIGHT_HOURS * 3600) };
}
