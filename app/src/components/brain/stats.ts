// The brain tab's counts (5.11.2026): events in the last hours as sparkline buckets, where
// tonight's window stands, what state a device's node shows, the one speed to put big.
// Pure: no clock is read here, every function takes now.
import { clamp01 } from './geometry';

export const HOUR = 3600_000;

/** Times in the last `hours` before now as n counts, oldest first. Later than now or older: left out. */
export function buckets(times: number[], now: number, hours = 24, n = 12): number[] {
  const out = new Array<number>(n).fill(0);
  const span = hours * HOUR;
  const from = now - span;
  for (const t of times) {
    if (!(t > from && t <= now)) continue;
    const i = Math.min(n - 1, Math.floor(((t - from) / span) * n));
    out[i]++;
  }
  return out;
}

const mins = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return ((h || 0) * 60 + (m || 0)) % 1440;
};

export type WindowView = {
  open: boolean;
  frac: number;    // how far through the window (0 when closed)
  length: number;  // the window's minutes
  left: number;    // open: minutes until it closes · closed: minutes until it opens
};

/** Where now stands in the night window "23:00" → "07:30" (it may cross midnight). */
export function windowProgress(from: string, to: string, now: Date): WindowView {
  const a = mins(from);
  const b = mins(to);
  const t = now.getHours() * 60 + now.getMinutes();
  const length = (b - a + 1440) % 1440 || 1440;
  const since = (t - a + 1440) % 1440; // minutes since the window last opened
  const open = since < length;
  if (open) return { open, frac: clamp01(since / length), length, left: length - since };
  return { open, frac: 0, length, left: 1440 - since };
}

export type NodeState = 'idle' | 'busy' | 'out' | 'refused' | 'saved';

/**
 * What a device's node shows. refused wins (the checker said no), then out (sitting out after
 * a drop), busy, idle; saved is a paired device that is not part of the model now.
 */
export function nodeState(d: { busy?: boolean; out?: boolean } | undefined, badge: string, working = false): NodeState {
  if (badge === 'rejected') return 'refused';
  if (!d) return 'saved';
  if (d.out) return 'out';
  if (d.busy || working) return 'busy';
  return 'idle';
}

const one = (n: number) => Math.round(n * 10) / 10;

/**
 * The one speed to put big: split and alone the model's own speed (the plan's estimate in a
 * split, else this phone's); apart every device answers its own prompts, so they add up
 * (devices sitting out left aside). null when there is nothing to say.
 */
export function speedOf(mode: 'alone' | 'apart' | 'split', devices: { local: boolean; tps: number; out?: boolean }[], planTps?: number | null): number | null {
  if (mode === 'apart') {
    const sum = devices.filter((d) => !d.out).reduce((a, d) => a + (Number.isFinite(d.tps) ? d.tps : 0), 0);
    return sum > 0 ? one(sum) : null;
  }
  if (mode === 'split' && planTps && planTps > 0) return one(planTps);
  const me = devices.find((d) => d.local);
  return me && me.tps > 0 ? one(me.tps) : null;
}

/** Big numbers short: 950 · 12K · 1.4M. */
export const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));
