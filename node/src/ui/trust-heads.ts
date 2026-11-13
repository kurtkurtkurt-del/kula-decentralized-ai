// Where each device's ledger window starts after kula-node restarts (L9 P51). The engine keeps its
// /trust looks in memory only; without this a restarted engine asks with no `since`, gets the last
// 200 lines, and a device that wrote more meanwhile reads "could not be joined". Kept on disk: one
// sha256 per device (the `upTo` of the look before the last, so god's eye has already seen it),
// never a ledger line and never a key. `~/.kula-node/trust-heads.json`, `{ v: 1, heads: { id: upTo } }`.
import fs from 'node:fs';
import path from 'node:path';
import type { TrustLook } from './engine.js';

export const HEADS_MAX = 500;
export const HEX64 = /^[0-9a-f]{64}$/;

/** The heads in [raw] that can be read: ids of 1..200 chars, hashes of 64 lowercase hex, the
 *  first HEADS_MAX. Anything else is an empty map; never throws. */
export function saneHeads(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  try {
    if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return out;
    const h = (raw as { heads?: unknown }).heads;
    if (!h || typeof h !== 'object' || Array.isArray(h)) return out;
    for (const [id, upTo] of Object.entries(h as Record<string, unknown>)) {
      if (out.size >= HEADS_MAX) break;
      if (id.length < 1 || id.length > 200 || typeof upTo !== 'string' || !HEX64.test(upTo)) continue;
      out.set(id, upTo);
    }
  } catch { return new Map(); }
  return out;
}

/** The heads kept in [file]; empty when it is missing or cannot be read. */
export function readHeads(file: string): Map<string, string> {
  try { return saneHeads(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return new Map(); }
}

/** Writes [heads] to [file] (tmp then rename, mode 600); false instead of throwing. */
export function writeHeads(file: string, heads: Map<string, string>): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, heads: Object.fromEntries([...heads].slice(0, HEADS_MAX)) }), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

/** The look a /trust look folds onto: [look] when it has no error; else, with a kept [upTo], an
 *  empty look starting there (the fields foldTrust(null, {}, 0) gives, written out here so this
 *  file does not load engine.ts) that keeps the owner-blind proof; else null. */
export function startOf(look: TrustLook | null, upTo: string | null): TrustLook | null {
  if (look && !look.error) return look;
  if (!upTo) return null;
  return {
    at: 0, error: null,
    id: null, alg: null, pub: null, store: null, cert: null, certPinned: null,
    v1: null, paired: null,
    self: null, count: null, head: null,
    upTo,
    lines: [], restartedAt: null,
    rejectsDay: {}, rejectsLast: [],
    attest: look?.attest ?? null,
  };
}

/** The hash to keep after a look from [start] to [end]: undefined leaves what is kept (the look
 *  failed), null forgets it (nothing before, or the ledger started over during the look), else
 *  [start]'s upTo: one look behind, so the eye has already seen it. */
export function nextHead(start: TrustLook | null, end: TrustLook): string | null | undefined {
  if (end.error) return undefined;
  if (!start || start.restartedAt !== end.restartedAt) return null;
  return start.upTo;
}
