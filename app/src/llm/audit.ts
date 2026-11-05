// beyin's ledger as the phone reads it: a few JSON lines from the native module, parsed,
// chained and summarised here in plain TypeScript so the audit page and the peer badges
// need no native code (and the tests need no phone). The line format is Ledger.kt's:
//   {"t":<ms>,"kind":"...","peer":"...",...,"prev":"<sha256 of the previous line>","sig":"..."}
// The signature is the worker's; the phone checks only the chain (each prev matches the
// line before it), which is what tampering with the file breaks.

export const AUDIT_KINDS = ['pair', 'connect', 'reject', 'load', 'claim', 'health', 'end'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export type AuditLine = {
  t: number;
  kind: string;
  peer: string | null;
  prev: string;
  sig: string;
  reject: string | null;     // the check's reason when the line records a refusal
  warn: string[];            // the checks' warnings (claim vs measured, health, bounds)
  fields: Record<string, unknown>; // the rest, for the detail line
};

export type AuditEntry = { raw: string; line: AuditLine | null }; // line null = not a ledger line

/** verified: nothing wrong · warn: passed with warnings · rejected: refused (a reject line or a reject field). */
export type Verdict = 'verified' | 'warn' | 'rejected';
export type PeerBadge = Verdict | 'none';

export const GENESIS = '0'.repeat(64);

export function parseLine(raw: string): AuditLine | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.t !== 'number' || typeof r.kind !== 'string' || typeof r.prev !== 'string' || typeof r.sig !== 'string') return null;
  const { t, kind, peer, prev, sig, reject, warn, ...fields } = r;
  return {
    t, kind, prev, sig,
    peer: typeof peer === 'string' ? peer : null,
    reject: typeof reject === 'string' ? reject : null,
    warn: Array.isArray(warn) ? warn.filter((w): w is string => typeof w === 'string') : [],
    fields,
  };
}

export const parseLedger = (lines: string[]): AuditEntry[] => lines.filter((l) => l.length > 0).map((raw) => ({ raw, line: parseLine(raw) }));

export function verdictOf(line: AuditLine): Verdict {
  if (line.kind === 'reject' || line.reject) return 'rejected';
  if (line.warn.length) return 'warn';
  return 'verified';
}

export type ChainResult = {
  ok: boolean;
  /** index (into the given lines) of the first line whose prev does not match, or that is not a ledger line */
  broken: number | null;
  /** true when the first line is the ledger's first (prev = genesis) */
  fromGenesis: boolean;
};

/**
 * Walks a window of the ledger (the native tail), oldest first. The first line's prev is not
 * checked against anything but itself: a tail starts mid-chain, and the line it points at is
 * out of the window. Every later line must carry the sha256 of the line before it.
 */
export function verifyChain(lines: string[]): ChainResult {
  const rows = lines.filter((l) => l.length > 0);
  if (!rows.length) return { ok: true, broken: null, fromGenesis: true };
  let expected: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const line = parseLine(rows[i]);
    if (!line || !/^[0-9a-f]{64}$/.test(line.prev)) return { ok: false, broken: i, fromGenesis: false };
    if (expected !== null && line.prev !== expected) return { ok: false, broken: i, fromGenesis: parseLine(rows[0])?.prev === GENESIS };
    expected = sha256Hex(rows[i]);
  }
  return { ok: true, broken: null, fromGenesis: parseLine(rows[0])?.prev === GENESIS };
}

export type AuditSummary = { total: number; rejects: number; warns: number; malformed: number; byKind: Record<string, number>; last: number | null };

export function summarize(entries: AuditEntry[]): AuditSummary {
  const s: AuditSummary = { total: 0, rejects: 0, warns: 0, malformed: 0, byKind: {}, last: null };
  for (const e of entries) {
    if (!e.line) { s.malformed++; continue; }
    s.total++;
    s.byKind[e.line.kind] = (s.byKind[e.line.kind] ?? 0) + 1;
    const v = verdictOf(e.line);
    if (v === 'rejected') s.rejects++;
    else if (v === 'warn') s.warns++;
    if (s.last === null || e.line.t > s.last) s.last = e.line.t;
  }
  return s;
}

export const filterKind = (entries: AuditEntry[], kind: string | null): AuditEntry[] =>
  kind ? entries.filter((e) => e.line?.kind === kind) : entries;

/** The badge for one peer: its newest line's verdict, none when the ledger never saw it. */
export function peerBadge(entries: AuditEntry[], host: string): PeerBadge {
  let best: AuditLine | null = null;
  for (const e of entries) if (e.line && e.line.peer === host && (!best || e.line.t >= best.t)) best = e.line;
  return best ? verdictOf(best) : 'none';
}

/** One short line of the fields that matter per kind, for the list. */
export function detailOf(line: AuditLine): string {
  const f = line.fields;
  const parts: string[] = [];
  if (typeof f.channel === 'string') parts.push(f.channel);
  if (typeof f.why === 'string') parts.push(f.why);
  if (line.kind === 'load' && typeof f.sha === 'string') parts.push(`sha ${f.sha.slice(0, 12)}`);
  if (line.kind === 'load' && Array.isArray(f.split)) parts.push(`${f.split.length} parts`);
  if (line.kind === 'claim') parts.push(`${f.ramMb ?? '?'} / ${f.heldMb ?? '?'} mb`, `${f.bw ?? '?'} gb/s`, `${f.tps ?? '?'} tps`);
  if (line.kind === 'health') parts.push(`${f.batteryPct ?? '?'}%`, `${f.batteryC ?? '?'}°c`, f.throttled ? 'throttled' : '');
  if (line.kind === 'end') parts.push(`${f.bytes ?? 0} b`, `${f.seconds ?? 0} s`);
  if (line.reject) parts.push(line.reject);
  parts.push(...line.warn);
  return parts.filter(Boolean).join(' · ');
}

// --- sha-256, plain ts (no native, no dependency); the ledger lines are short -----------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8(s: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export function sha256Hex(text: string): string {
  const msg = utf8(text);
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}
