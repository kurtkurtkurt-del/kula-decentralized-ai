import { useEffect, useState } from 'react';
import Storage from 'expo-sqlite/kv-store';
import type { NightDevice, NightStatus } from './NightWorker';

// The morning report (night-2, 5.11.2026). A night is one or more segments: the worker
// runs from the moment the conditions are met to the moment one breaks (plug out, battery
// under the threshold, window closed); each stop leaves a Segment, the report adds them up.
// Pure functions here, the kv-store under night.reports (newest last, REPORT_KEEP kept);
// the screen is app/night/report.tsx, the server end is night_report (demo server) through
// the outbox (nightReport job, data/contribution.ts).
export type Segment = {
  startedAt: number;
  endedAt: number;
  tokens: number;
  kwh: number; // the card's figure (4 W + 2 W per extra device), as the workers count it
  units: number;
  checked: number;
  wrong: number;
  devices: NightDevice[];
  model: string | null;
  real: boolean;
};
export type DeviceLine = { id: string; name: string; tokens: number; units: number; tps: number };
export type NightReport = {
  id: string; // the window key: the date the window opened on, "2026-11-05"
  slug: string;
  startedAt: number; // first segment
  endedAt: number; // last segment
  seconds: number; // worked, pauses left out
  segments: number;
  tokens: number;
  units: number;
  checked: number;
  wrong: number;
  kwh: number; // the card's figure, the segments added up
  tps: number; // tokens / seconds over the whole night
  devices: DeviceLine[];
  watts: number; // what the Wh used: measured, else DEFAULT_WATTS
  measured: boolean; // was the wattage measured on this phone?
  wh: number;
  model: string | null;
  real: boolean;
  sent: boolean; // reached the server (or is in the outbox on its way)
};
export const DEFAULT_WATTS = 3;
export const REPORT_KEEP = 60;
const REPORTS = 'night.reports';
const SEGMENTS = 'night.segments';

/** A finished worker status as a segment of the night. */
export function segmentOf(s: NightStatus, endedAt: number): Segment {
  return { startedAt: s.startedAt ?? endedAt, endedAt, tokens: s.tokens, kwh: s.kwh, units: s.units ?? 0, checked: s.checked ?? 0, wrong: s.wrong ?? 0, devices: s.devices ?? [], model: s.model ?? null, real: !!s.real };
}

/** The night's report from its segments. watts: measured (W) or null → DEFAULT_WATTS. */
export function buildReport(id: string, slug: string, segs: Segment[], watts: number | null = null): NightReport {
  const seconds = segs.reduce((a, s) => a + Math.max(0, Math.round((s.endedAt - s.startedAt) / 1000)), 0);
  const tokens = segs.reduce((a, s) => a + s.tokens, 0);
  const byDev = new Map<string, DeviceLine>();
  for (const s of segs) {
    for (const d of s.devices) {
      const line = byDev.get(d.id) ?? { id: d.id, name: d.name, tokens: 0, units: 0, tps: 0 };
      line.tokens += d.tokens;
      line.units += d.units;
      byDev.set(d.id, line);
    }
  }
  // the devices run side by side, so each one's rate is its tokens over the night's seconds
  const devices = [...byDev.values()].map((d) => ({ ...d, tps: rate(d.tokens, seconds) }));
  const w = watts && watts > 0 ? watts : DEFAULT_WATTS;
  return {
    id, slug,
    startedAt: segs[0]?.startedAt ?? 0,
    endedAt: segs[segs.length - 1]?.endedAt ?? 0,
    seconds, segments: segs.length, tokens,
    kwh: segs.reduce((a, s) => a + s.kwh, 0),
    units: segs.reduce((a, s) => a + s.units, 0),
    checked: segs.reduce((a, s) => a + s.checked, 0),
    wrong: segs.reduce((a, s) => a + s.wrong, 0),
    tps: rate(tokens, seconds),
    devices,
    watts: w, measured: !!watts && watts > 0,
    wh: Math.round(((seconds / 3600) * w) * 100) / 100,
    model: segs.find((s) => s.model)?.model ?? null,
    real: segs.some((s) => s.real),
    sent: false,
  };
}
const rate = (tokens: number, seconds: number) => (seconds > 0 ? Math.round((tokens / seconds) * 10) / 10 : 0);

/** The share of known-answer units that came out right, 0–1; null when none was checked. */
export const accuracy = (r: Pick<NightReport, 'checked' | 'wrong'>) => (r.checked > 0 ? (r.checked - r.wrong) / r.checked : null);

export type Compared = { nights: number; units: number; tps: number; wh: number; seconds: number; best: boolean };
/** This night against the nights before it: the difference to their average, and whether
 * it is the best night in units so far. */
export function compare(r: NightReport, previous: NightReport[]): Compared | null {
  const past = previous.filter((p) => p.id !== r.id);
  if (!past.length) return null;
  const avg = (f: (p: NightReport) => number) => past.reduce((a, p) => a + f(p), 0) / past.length;
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    nights: past.length,
    units: round(r.units - avg((p) => p.units)),
    tps: round(r.tps - avg((p) => p.tps)),
    wh: round(r.wh - avg((p) => p.wh)),
    seconds: Math.round(r.seconds - avg((p) => p.seconds)),
    best: past.every((p) => p.units < r.units),
  };
}

// ---- the segments of the night in progress
export function segments(): Segment[] {
  try {
    return JSON.parse(Storage.getItemSync(SEGMENTS) ?? '[]') as Segment[];
  } catch {
    return [];
  }
}
export function addSegment(s: Segment) {
  const all = [...segments(), s];
  Storage.setItemSync(SEGMENTS, JSON.stringify(all));
  return all;
}
export const clearSegments = () => Storage.removeItemSync(SEGMENTS);

// ---- the reports kept
export function reports(): NightReport[] {
  try {
    return JSON.parse(Storage.getItemSync(REPORTS) ?? '[]') as NightReport[];
  } catch {
    return [];
  }
}
export const lastReport = (): NightReport | null => reports().at(-1) ?? null;
const listeners = new Set<() => void>();
export function saveReport(r: NightReport) {
  const all = reports().filter((x) => x.id !== r.id);
  all.push(r);
  Storage.setItemSync(REPORTS, JSON.stringify(all.slice(-REPORT_KEEP)));
  listeners.forEach((fn) => fn());
}
export function markSent(id: string) {
  const r = reports().find((x) => x.id === id);
  if (r && !r.sent) saveReport({ ...r, sent: true });
}
export function useReports(): NightReport[] {
  const [list, setList] = useState(reports);
  useEffect(() => {
    const fn = () => setList(reports());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return list;
}

/** The key of the window `now` falls in: the date it opened on. Before midnight that is
 * today; after midnight, inside a window that crosses it, yesterday. */
export function windowKey(from: string, to: string, now: Date): string {
  const mins = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };
  const d = new Date(now);
  const t = now.getHours() * 60 + now.getMinutes();
  if (mins(from) > mins(to) && t < mins(to)) d.setDate(d.getDate() - 1);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
