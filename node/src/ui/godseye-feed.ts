// The one place kula-node meets god's eye (src/godseye): kula's engine, peer book and night
// projects turned into god's eye's own snapshot shape. Plain data, copied; nothing of the engine
// leaks through, so the eye can later move into a program of its own and get the same snapshot
// over a pipe.
import fs from 'node:fs';
import path from 'node:path';
import type { Engine, PeerRow, TrustLook } from './engine.js';
import { hostLabel } from './engine.js';
import type { ProjectRunner } from './projects.js';
import type { EyeDevice, EyeHealth, EyeTrust, Snapshot } from '../godseye/index.js';
import { freeRamMB } from '../sysinfo.js';
import { ledgerFile } from '../ledgercmd.js';
import { loadOrCreate } from '../audit/key.js';
import { GENESIS, chainFiles, isLegacy, verifyLines, type Problem } from '../audit/ledger.js';
import { createHash, type KeyObject } from 'node:crypto';

const trustOf = (t: TrustLook | null): EyeTrust | null => (t ? { ...t, lines: [...t.lines], rejectsDay: { ...t.rejectsDay }, rejectsLast: t.rejectsLast.map((r) => ({ ...r })), attest: t.attest ? { ...t.attest } : null } : null);

// this computer's own ledger, checked again only when one of its files changed (it can be 5 MB).
// A look only reads: a ledger still starting with the old unsigned gate lines is reported, and
// setting them aside is left to an explicit `kula-node ledger --verify` (review A2, 12 Nov).
// The look runs inside the brain's tick and the ledger changes often (every refused handshake is
// a line), so it is verified the way verifyChain does it but only where it changed (scan A7,
// 12 Nov): a rotated file's verdict is kept by name, size, mtime and the hash it chains from; for
// the live file the verified whole-line prefix is kept by its byte length and sha256, and when
// those bytes are still exactly there only the lines after it are verified, from the prefix's last
// hash. verifyLines is a fold over (prev, line number), so this gives the full walk's answer.
let hostLedgerSeen: { stamp: string; v: Snapshot['host']['ledger'] } | null = null;
let verifiedLines = 0;
// lines verified by hostLedger since start (for tests: an append costs one line, not the chain)
export const hostLedgerVerifiedLines = (): number => verifiedLines;
type Fold = { count: number; problems: Problem[]; last: string };
// one file's verdict: `pre` covers its first `offset` bytes (whole lines, sha256 `prefixHash`),
// `all` the whole file (a torn last line without its "\n" is verified each time, never kept)
type FileSeen = { size: number; mtimeMs: number; prevIn: string; offset: number; prefixHash: string; pre: Fold; all: Fold };
let ledgerKeyId = '';
const rotatedSeen = new Map<string, FileSeen>();
let liveSeen: { file: string; seen: FileSeen } | null = null;

function foldLines(text: string, publicKey: KeyObject, from: Fold): Fold {
  const r = verifyLines(text.split('\n').filter((l) => l.length > 0), publicKey, from.last);
  verifiedLines += r.count;
  if (r.count === 0) return from;
  return { count: from.count + r.count, problems: [...from.problems, ...r.problems.map((p) => ({ n: p.n + from.count, reason: p.reason }))], last: r.last };
}

function checkFile(f: string, mtimeMs: number, prevIn: string, publicKey: KeyObject, before: FileSeen | null): FileSeen {
  const buf = fs.readFileSync(f);
  const end = buf.lastIndexOf(10) + 1; // whole lines end here (a "\n" is always a utf-8 boundary)
  let h = createHash('sha256');
  let offset = 0;
  let pre: Fold = { count: 0, problems: [], last: prevIn };
  if (before && before.prevIn === prevIn && before.offset > 0 && before.offset <= end) {
    h.update(buf.subarray(0, before.offset));
    if (h.copy().digest('hex') === before.prefixHash) { offset = before.offset; pre = before.pre; }
    else h = createHash('sha256');
  }
  h.update(buf.subarray(offset, end));
  pre = foldLines(buf.subarray(offset, end).toString('utf8'), publicKey, pre);
  const all = end < buf.length ? foldLines(buf.subarray(end).toString('utf8'), publicKey, pre) : pre;
  return { size: buf.length, mtimeMs, prevIn, offset: end, prefixHash: h.digest('hex'), pre, all };
}

export function hostLedger(file = ledgerFile()): Snapshot['host']['ledger'] {
  if (!fs.existsSync(file)) return null;
  const files = chainFiles(file);
  const stats = files.map((f) => { try { return fs.statSync(f); } catch { return null; } });
  const stamp = files.map((f, i) => { const s = stats[i]; return s ? `${f}:${s.size}:${s.mtimeMs}` : f; }).join('|');
  if (hostLedgerSeen?.stamp === stamp) return hostLedgerSeen.v;
  let v: Snapshot['host']['ledger'];
  try {
    const key = loadOrCreate();
    const keyId = createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    if (keyId !== ledgerKeyId) { rotatedSeen.clear(); liveSeen = null; ledgerKeyId = keyId; }
    let prev = GENESIS;
    let count = 0;
    let problem: string | null = null;
    const kept = new Set<string>();
    const lastLive = liveSeen?.file === file ? liveSeen.seen : null;
    files.forEach((f, i) => {
      const s = stats[i];
      const live = i === files.length - 1;
      let all: Fold;
      if (!s) all = { count: 0, problems: [], last: prev }; // gone between the listing and now: no lines, as verifyChain
      else {
        const cached = live ? lastLive : (rotatedSeen.get(f) ?? null);
        let seen = cached && cached.size === s.size && cached.mtimeMs === s.mtimeMs && cached.prevIn === prev ? cached : null;
        // a rotated file new here was the live file a moment ago (a rotation renames it)
        if (!seen) seen = checkFile(f, s.mtimeMs, prev, key.publicKey, cached ?? (live ? null : lastLive));
        if (live) liveSeen = { file, seen }; else { rotatedSeen.set(f, seen); kept.add(f); }
        all = seen.all;
      }
      if (problem === null && all.problems.length) problem = `line ${all.problems[0].n} of ${path.basename(f)}: bad ${all.problems[0].reason}`;
      count += all.count;
      prev = all.last;
    });
    for (const f of rotatedSeen.keys()) if (!kept.has(f)) rotatedSeen.delete(f);
    if (files.length === 1 && isLegacy(file, key.publicKey)) v = { ok: false, count, problem: 'the ledger still starts with the old unsigned lines from before the signed ledger; `kula-node ledger --verify` sets them aside' };
    else v = { ok: problem === null, count, problem };
  } catch (e) { v = { ok: false, count: 0, problem: (e as Error).message }; }
  hostLedgerSeen = { stamp, v };
  return v;
}

// the way the device is reached now (one device is one row: engine.peers, devices.ts)
// a wi-fi record whose gate answered only at a global ipv6 address or its router's port is
// reached over the internet (peers.ts pickRoute)
const via = (p: PeerRow): EyeDevice['via'] => {
  const v = p.via ?? (p.cable ? 'cable' : p.far ? 'relay' : 'wifi');
  return v === 'wifi' && (p.reachedBy === 'ipv6' || p.reachedBy === 'mapped') ? 'internet' : v;
};

// A phone's health from the ledger lines it sent (12.11.2026). Its worker writes a signed health
// line every 60 s or when its warnings change (WorkerService.kt, Auditor.kt onHealth), keys in this
// order: {"t":<ms>,"kind":"health","throttled":bool,"batteryC":num,"batteryPct":int,"warn":[..]?,
// "prev":..,"sig":..}. batteryPct is -1 when Android could not say it, batteryC 0.0 when unknown.
// The ledger's other health lines (torn, a key replaced, an unpair) carry none of these fields and
// are passed over. Nothing here is trusted beyond its shape: the trust branch checks the chain
// and signatures of the same lines.
const HEALTH_LINE = /^\{"t":\d{1,16},"kind":"health"/;
export function healthOf(lines: string[]): EyeHealth | null {
  if (!Array.isArray(lines)) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (typeof l !== 'string' || !HEALTH_LINE.test(l)) continue;   // cheap: no parse for other kinds
    let o: Record<string, unknown>;
    try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o !== 'object' || typeof o.throttled !== 'boolean') continue;   // not a reading
    const t = o.t, c = o.batteryC, b = o.batteryPct;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0) continue;
    return {
      at: t,
      tempC: typeof c === 'number' && Number.isFinite(c) && c !== 0 ? c : null,
      battery: typeof b === 'number' && Number.isFinite(b) && b >= 0 && b <= 100 ? b : null,
      charging: typeof o.charging === 'boolean' ? o.charging : null,
      throttled: o.throttled,
    };
  }
  return null;
}

export function deviceOf(p: PeerRow, trust: TrustLook | null = null): EyeDevice {
  return {
    id: p.id, name: p.name, kind: p.kind, via: via(p), where: p.where, reachedBy: p.reachedBy ?? null,
    reachable: p.reach ? p.reach.ok : null, reachMs: p.reach?.ms ?? null, reason: p.reach?.ok ? null : p.reach?.reason ?? null,
    checkedAt: p.probedAt, lastOk: p.last_ok, ramMb: p.ram, bwGBs: p.bw, gpu: p.gpu,
    tls: p.tls, waitingPair: p.waitingPair, plugged: p.cable ? p.cable.plugged : null, holds: p.holds,
    trust: trustOf(trust),
    ring: p.ring ?? 'home',
    health: trust ? healthOf(trust.lines) : null,
  };
}

/** One look for god's eye. Reads only: the engine's status and cached peer rows, the model
 *  list, the projects; it never probes a device. */
export function kulaSnapshot(engine: Engine, projects: ProjectRunner, now = Date.now()): Snapshot {
  const st = engine.status();
  let freeMb: number | null = null;
  try { freeMb = freeRamMB(); } catch {}
  // one id per device (G1, 12 Nov): status().loaded and a project's peers name a device by the
  // record of the route it went over, a row by its group's first record. A phone with a cable and
  // a wi-fi record loaded over wi-fi is the same device; every id the eye gets is the row's id.
  // An id no row knows ('local', a forgotten device) passes through unchanged.
  const rows = engine.peers();
  const rowOf = new Map<string, string>();
  for (const r of rows) for (const id of [r.id, ...(r.routes ?? [])]) if (!rowOf.has(id)) rowOf.set(id, r.id);
  const idOf = (id: string) => rowOf.get(id) ?? id;
  const loaded = st.loaded ? {
    ...st.loaded,
    devices: st.loaded.devices.map((d) => ({ ...d, id: idOf(d.id) })),
    ...(st.loaded.parts ? { parts: st.loaded.parts.map((p) => ({ ...p, id: idOf(p.id) })) } : {}),
  } : null;
  return structuredClone({
    at: now,
    host: { name: hostLabel(), freeMb, ledger: hostLedger() },
    devices: rows.map((p) => deviceOf(p, engine.trustOf(p.id))),
    work: { loaded, loading: st.loading, chatting: st.chatting, plan: st.plan, decisions: st.decisions, llama: st.llama, photos: engine.photos() },
    models: engine.models().map((m) => ({ id: m.id, name: m.name, file: m.file, size: m.size, quant: m.quant, params_b: m.params_b, catalog: m.catalog, here: m.here, needMb: m.needMb, active_b: m.active_b, vision: m.vision })),
    projects: projects.list().map((p) => ({ id: p.id, title: p.title, request: p.request, start: p.start, end: p.end, state: p.state, mode: p.mode, model: p.model, peers: p.peers.map(idOf), parts: p.parts, done: p.done, line: p.line, error: p.error })),
  });
}
