import { useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { supabase } from '@/lib/supabase';
import { invalidate, must, outbox, remember, send, useShelf, type Job } from '@/lib/offline';
import { deviceId } from '@/data/passport';
import type { NightReport } from '@/night/report';

// 18_night.sql: night_report, night_reports, night_mine_summary, night_leaderboard,
// ledger_head_set. The morning report (night/report.ts) goes to the server as NUMBERS
// ONLY: counts, seconds, tok/s, wh, the model's name, the app's version. No prompt, no
// answer, no sample ever leaves the phone (docs/BACKEND.md). It goes through the outbox:
// offline it waits, a lost connection retries with growing pauses, and the job's own id
// is the client id, so a retry finds the first row. The same device + project + night
// sent twice (a reinstall, a second outbox) also finds the first row.

/** The report stripped to what the server stores. Anything else stays on the phone. */
export type NightPayload = {
  id: string; // the night: "2026-11-05"
  slug: string;
  device_id: string; // the passport's device id, one per install
  units: number;
  checked: number;
  wrong: number;
  tokens: number;
  seconds: number;
  segments: number;
  tps: number;
  wh: number;
  model: string | null;
  real: boolean;
  app_version: string | null;
  devices: { id: string; tokens: number; units: number; tps: number }[];
};
const whole = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
const dec = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : 0);
export function toPayload(r: NightReport, device = deviceId(), version: string | null = Constants.expoConfig?.version ?? null): NightPayload {
  return {
    id: r.id,
    slug: r.slug,
    device_id: device,
    units: whole(r.units),
    checked: whole(r.checked),
    wrong: whole(r.wrong),
    tokens: whole(r.tokens),
    seconds: whole(r.seconds),
    segments: Math.max(1, whole(r.segments)),
    tps: dec(r.tps),
    wh: dec(r.wh),
    model: r.model ? String(r.model).slice(0, 120) : null,
    real: !!r.real,
    app_version: version ? String(version).slice(0, 32) : null,
    devices: (r.devices ?? []).slice(0, 64).map((d) => ({ id: String(d.id).slice(0, 64), tokens: whole(d.tokens), units: whole(d.units), tps: dec(d.tps) })),
  };
}

const SHELVES = ['nightSummary', 'reports', 'projectPage'];
outbox(
  'nightReport',
  async (j: Job) => {
    const r = await supabase.rpc('night_report', { p_report: j.report, p_client_id: j.id });
    if (r.error) throw r.error;
    return String(r.data);
  },
  SHELVES,
);

/** Send the morning report (queued when offline). True when it went out or waits in the
 * outbox; false when the server refused it (an old server without the rpc, a bad report). */
export async function sendNightReport(report: NightReport): Promise<boolean> {
  try {
    await send({ kind: 'nightReport', report: toPayload(report) });
    return true;
  } catch {
    return false;
  }
}

// ---- what the cards show: "this project, this month: X nights"
export type NightSummaryRow = { slug: string; title: string; nights_month: number; nights_total: number; units_month: number; wh_month: number; last_night: string | null; streak: number };
export async function nightSummary(): Promise<NightSummaryRow[]> {
  return remember('nightSummary', '', async () => ((await must(supabase.rpc('night_mine_summary', { p_device_id: deviceId() }))) ?? []) as NightSummaryRow[]);
}
export const forgetNightSummary = () => invalidate('nightSummary');
export const monthNights = (rows: NightSummaryRow[], slug: string) => rows.find((r) => r.slug === slug)?.nights_month ?? 0;
export const monthTotal = (rows: NightSummaryRow[]) => rows.reduce((a, r) => a + (r.nights_month ?? 0), 0);
export const bestStreak = (rows: NightSummaryRow[]) => rows.reduce((a, r) => Math.max(a, r.streak ?? 0), 0);

/** The summary rows for a signed-in account; [] signed out or before the first answer. */
export function useNightSummary(uid: string | undefined, tick = 0): NightSummaryRow[] {
  const [rows, setRows] = useState<NightSummaryRow[]>([]);
  const fresh = useShelf('nightSummary');
  useEffect(() => {
    if (!uid) return;
    let live = true;
    nightSummary()
      .then((r) => live && setRows(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [uid, tick, fresh]);
  return uid ? rows : [];
}

// ---- the ledger head (the brain's auditor, v1): the hash and signature of the last entry
export async function sendLedgerHead(head: { seq: number; hash: string; signature: string; alg?: 'ed25519' | 'hmac-sha256' }) {
  await send({ kind: 'ledgerHead', ...head });
}
outbox('ledgerHead', async (j: Job) => {
  const r = await supabase.rpc('ledger_head_set', { p_device_id: deviceId(), p_seq: j.seq, p_hash: j.hash, p_signature: j.signature, p_alg: j.alg ?? 'ed25519' });
  if (r.error) throw r.error;
});

export type LeaderRow = { handle: string; nights: number; units: number; tokens: number; me: boolean };
export async function leaderboard(): Promise<LeaderRow[]> {
  return remember('leaderboard', '', async () => ((await must(supabase.rpc('night_leaderboard', { p_limit: 20 }))) ?? []) as LeaderRow[]);
}
