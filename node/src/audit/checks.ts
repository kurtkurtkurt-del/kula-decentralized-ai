// The checks the auditor runs. Each is a plain function over numbers and
// strings so the thresholds can be tested on their own. Reasons are the five
// words the phone's auditor uses: replay, clock, claim, model, bounds.
export type Reason = 'replay' | 'clock' | 'claim' | 'model' | 'bounds';

export const NONCE_RING = 1000;
export const CLOCK_SKEW_MS = 120_000;
export const CLAIM_WARN = 2;
export const CLAIM_REJECT = 4;
// Faster than any link a phone cluster runs on: a byte count that implies
// more than this over a connection is a lie or a broken counter.
export const MAX_BYTES_PER_SEC = 2_000_000_000;
export const HOT_C = 42;
export const LOW_BATTERY = 15;

// Remembers the last NONCE_RING nonces per peer; the same one twice is a replay.
export class ReplayCheck {
  private rings = new Map<string, { list: string[]; set: Set<string> }>();

  constructor(readonly size = NONCE_RING) {}

  // Returns 'replay' when the nonce was seen before, null otherwise (and records it).
  check(peer: string, nonce: string): Reason | null {
    let ring = this.rings.get(peer);
    if (!ring) { ring = { list: [], set: new Set() }; this.rings.set(peer, ring); }
    if (ring.set.has(nonce)) return 'replay';
    ring.list.push(nonce);
    ring.set.add(nonce);
    if (ring.list.length > this.size) ring.set.delete(ring.list.shift()!);
    return null;
  }

  forget(peer: string) { this.rings.delete(peer); }
}

export function clockCheck(claimedMs: number, nowMs: number, maxSkewMs = CLOCK_SKEW_MS): Reason | null {
  if (!Number.isFinite(claimedMs)) return 'clock';
  return Math.abs(claimedMs - nowMs) > maxSkewMs ? 'clock' : null;
}

// A claimed figure (ram, bandwidth, tokens per second) against what was measured.
export function claimCheck(claimed: number, measured: number): { level: 'ok' | 'warn' | 'reject'; ratio: number; reason: Reason | null } {
  if (!(measured > 0) || !(claimed >= 0)) return { level: 'ok', ratio: 1, reason: null };
  const ratio = claimed / measured;
  if (ratio > CLAIM_REJECT) return { level: 'reject', ratio, reason: 'claim' };
  if (ratio > CLAIM_WARN) return { level: 'warn', ratio, reason: 'claim' };
  return { level: 'ok', ratio, reason: null };
}

export function modelCheck(wantSha256: string, gotSha256: string): Reason | null {
  return wantSha256.toLowerCase() === gotSha256.toLowerCase() ? null : 'model';
}

// Byte counts against the time they took. Negative counts, or counts that
// imply an impossible rate, fail. Very short connections are not judged.
export function boundsCheck(bytes: number, ms: number, maxBytesPerSec = MAX_BYTES_PER_SEC): Reason | null {
  if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(ms) || ms < 0) return 'bounds';
  if (ms < 1000) return null;
  return bytes / (ms / 1000) > maxBytesPerSec ? 'bounds' : null;
}

export interface Health { throttled?: boolean; tempC?: number | null; batteryPct?: number | null; }

export function healthWarnings(h: Health): string[] {
  const out: string[] = [];
  if (h.throttled) out.push('throttled');
  if (typeof h.tempC === 'number' && h.tempC > HOT_C) out.push(`hot ${h.tempC} C`);
  if (typeof h.batteryPct === 'number' && h.batteryPct < LOW_BATTERY) out.push(`battery ${h.batteryPct}%`);
  return out;
}
