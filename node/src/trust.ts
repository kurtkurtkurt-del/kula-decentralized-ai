// GET /trust on the worker api: what a master (or anyone with the api channel) needs to
// judge this worker without taking its word for it. The device key and its id, the gate
// certificate, whether v1 is open, and the signed ledger itself, so the caller checks the
// chain and the signatures on its own. Nothing secret: no cluster secret, no pairing code,
// no private key, no prompts. The phone's ApiServer.kt writes the same bytes; the field
// order below is the contract.
import fs from 'node:fs';
import { chainFiles, readLines, sha256Hex, verifyLines, GENESIS } from './audit/ledger.js';
import { publicKeyDer, type DeviceKey } from './audit/key.js';

export const SINCE_RE = /^[0-9a-f]{64}$/;
// at most this many ledger lines per answer
export const TRUST_LINES = 200;
// the reject counts cover this long
export const TRUST_DAY_MS = 24 * 3600 * 1000;
export const TRUST_LAST_REJECTS = 5;

export interface TrustGate { v1: boolean; tls: boolean; paired: number }

export interface TrustSource {
  key: DeviceKey;
  ledgerFile: string;
  // the gate certificate's DER, null when the gate speaks no tls
  cert: () => Buffer | null;
  gate: () => TrustGate;
  now?: () => number;
}

interface Reject { t: number; why: string; peer: string }

// One chain file as last read: kept while its size and mtime stay the same (rotated files
// never change; the live one is read again after each append).
interface FileScan {
  size: number;
  mtimeMs: number;
  prevIn: string;
  hashes: string[];
  problems: number;
  last: string;
  rejects: Reject[];
}

const caches = new WeakMap<TrustSource, Map<string, FileScan>>();

function scan(src: TrustSource, file: string, prevIn: string): FileScan {
  let cache = caches.get(src);
  if (!cache) { cache = new Map(); caches.set(src, cache); }
  let st: fs.Stats | null = null;
  try { st = fs.statSync(file); } catch {}
  const size = st?.size ?? 0;
  const mtimeMs = st?.mtimeMs ?? 0;
  const hit = cache.get(file);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs && hit.prevIn === prevIn) return hit;
  const lines = st ? readLines(file) : [];
  const v = verifyLines(lines, src.key.publicKey, prevIn);
  const rejects: Reject[] = [];
  for (const l of lines) {
    if (!l.includes('"kind":"reject"')) continue;
    try {
      const o = JSON.parse(l);
      if (o.kind === 'reject') rejects.push({ t: Number(o.t) || 0, why: typeof o.reason === 'string' ? o.reason : '?', peer: typeof o.peer === 'string' ? o.peer : '?' });
    } catch {}
  }
  const s: FileScan = { size, mtimeMs, prevIn, hashes: lines.map(sha256Hex), problems: v.problems.length, last: v.last, rejects };
  cache.set(file, s);
  return s;
}

// The raw lines with global index from <= i < to, across the chain files oldest first.
function linesBetween(files: string[], scans: FileScan[], from: number, to: number): string[] {
  const out: string[] = [];
  let base = 0;
  for (const [i, f] of files.entries()) {
    const n = scans[i].hashes.length;
    if (base + n > from && base < to) {
      const lines = readLines(f);
      out.push(...lines.slice(Math.max(0, from - base), Math.max(0, to - base)));
    }
    base += n;
    if (base >= to) break;
  }
  return out;
}

// The /trust answer. `since`: null (not asked) or 64 lowercase hex, checked by the caller.
export function trustBody(src: TrustSource, since: string | null) {
  const files = chainFiles(src.ledgerFile);
  const scans: FileScan[] = [];
  let prev = GENESIS;
  for (const f of files) { const s = scan(src, f, prev); scans.push(s); prev = s.last; }
  const count = scans.reduce((n, s) => n + s.hashes.length, 0);
  const broken = scans.some((s) => s.problems > 0);

  let found: boolean | null = null;
  let from = Math.max(0, count - TRUST_LINES);
  let to = count;
  let more = false;
  if (since !== null) {
    let at = -1;
    let base = 0;
    for (const s of scans) {
      const i = s.hashes.indexOf(since);
      if (i >= 0) at = base + i;
      base += s.hashes.length;
    }
    found = at >= 0;
    if (found) {
      from = at + 1;
      to = Math.min(count, from + TRUST_LINES);
      more = to < count;
    }
  }

  const now = (src.now ?? Date.now)();
  // no prototype: a reason is text from the ledger
  const day: Record<string, number> = Object.create(null);
  const recent: Reject[] = [];
  for (const s of scans) for (const r of s.rejects) {
    if (r.t < now - TRUST_DAY_MS) continue;
    day[r.why] = (day[r.why] ?? 0) + 1;
    recent.push(r);
  }
  const cert = src.cert();
  const g = src.gate();
  return {
    v: 1,
    id: src.key.id,
    key: { alg: src.key.alg, pub: publicKeyDer(src.key.publicKey).toString('base64'), store: 'file' },
    cert: cert ? cert.toString('base64') : null,
    gate: { v1: g.v1, tls: g.tls, paired: g.paired },
    ledger: {
      count,
      head: prev,
      self: count === 0 ? 'empty' : broken ? 'broken' : 'ok',
      found,
      more,
      lines: linesBetween(files, scans, from, to),
    },
    rejects: { day, last: recent.slice(-TRUST_LAST_REJECTS).map((r) => ({ t: r.t, why: r.why, peer: r.peer })) },
  };
}
