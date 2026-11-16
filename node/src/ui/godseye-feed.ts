// The one place kula-node meets god's eye (src/godseye): kula's engine, peer book and night
// projects turned into god's eye's own snapshot shape. Plain data, copied; nothing of the engine
// leaks through, so the eye can later move into a program of its own and get the same snapshot
// over a pipe.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Engine, PeerRow, TrustLook } from './engine.js';
import { hostLabel } from './engine.js';
import type { ProjectRunner } from './projects.js';
import type { EyeDevice, EyeGate, EyeHealth, EyeTrust, Snapshot } from '../godseye/index.js';
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

// this computer's own gate refusals for host.gate (16.11.2026), read from the same pass. Its gate
// writes every refused handshake as a signed reject line, {"t":<ms>,"kind":"reject","peer":<plain
// ip>,"reason":<word>,…} (gate.ts, share.ts, audit/auditor.ts reject); a line of the auditor's
// limiter carries "n", the refusals it stands for, and counts as that many. Sound: only lines this
// pass verified (chain and signature) are counted. Cheap: in checkFile's prefix fold (never the
// torn tail, which is verified each time and counted once it is whole), each newly verified line
// gets one regexp, and a JSON.parse only when it is a reject in the last 26 UTC hours; an
// unchanged ledger costs hostGate's 26-entry copy. Exactly once: an incremental fold counts every
// new line; a fold from byte 0 (the first look, a rewritten file, a broken prefix) counts only the
// lines newer than the newest reject counted before this pass. The buckets live in memory, one
// per UTC hour, and start again when the ledger key changes (the lines are then verified again
// under the new key). An address never leaves here: a refusal from an address that is not private
// (PRIVATE below) counts as far, and its network (ipv4 /24, ipv6 /48) is kept only as a short
// sha256 so that hostGate can say how many distinct networks knocked. At most NETS_HOUR networks
// are kept per hour (a scan wider than that reads as at least that many); at most GATE_BY_MAX
// reasons per hour (a reason past them still counts as far).
const HOUR = 3_600_000;
const GATE_HOURS = 26;               // host.gate's hours, the last one running
const GATE_BY_MAX = 40;              // reasons kept per hour (guard.ts looks at no more)
const GATE_GUARD = 5;                // rpc guard refusals kept, the newest
const NETS_HOUR = 10_000;            // network hashes kept per hour
const REASON_MAX = 200;              // a reason or a guard's why is cut here (guard.ts REASON)
const N_MAX = 1_000_000_000;         // a reject line's `n` (the refusals it stands for) is cut here
const REJECT_LINE = /^\{"t":(\d{1,16}),"kind":"reject",/;
type GateHour = { by: Map<string, number>; far: number; nets: Set<string> };
const gateHours = new Map<number, GateHour>();
let gateGuard: { t: number; why: string }[] = [];
let gateNewest = -1;                 // the newest reject t counted
const PRIVATE = new net.BlockList();
for (const [a, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10], ['127.0.0.0', 8]] as const) PRIVATE.addSubnet(a, bits, 'ipv4');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
const hourOf = (t: number): number => Math.floor(t / HOUR) * HOUR;
const shapeKey = (k: string): boolean => k === '__proto__' || k === 'constructor' || k === 'prototype';

// an ipv6 address's eight groups (an embedded ipv4 tail as its two), or null
function v6groups(ip: string): string[] | null {
  let s = ip.toLowerCase();
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    s = `${s.slice(0, m.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? null : tail ? tail.split(':') : [];
  const groups = t === null ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16).toString(16)) : null;
}

// a refusal's source network as a short hash when its address is not private; null for a private
// address or anything that is not an address
function farNet(peer: unknown): string | null {
  if (typeof peer !== 'string') return null;
  let ip = peer.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  let block: string;
  const fam = net.isIP(ip);
  if (fam === 4) {
    if (PRIVATE.check(ip, 'ipv4')) return null;
    block = `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  } else if (fam === 6) {
    if (PRIVATE.check(ip, 'ipv6')) return null;
    const g = v6groups(ip);
    if (!g) return null;
    block = `${g.slice(0, 3).join(':')}::/48`;
  } else return null;
  return createHash('sha256').update(block).digest('hex').slice(0, 16);
}

// one fold's new whole lines: each verified reject in the window, newer than `floor` when the fold
// started from byte 0 (null: an incremental fold, every new line counts)
function gateFold(lines: string[], problems: Problem[], floor: number | null): void {
  const bad = new Set(problems.map((p) => p.n));   // verifyLines numbers the lines from 1
  const first = hourOf(Date.now()) - (GATE_HOURS - 1) * HOUR;
  for (let i = 0; i < lines.length; i++) {
    const m = REJECT_LINE.exec(lines[i]);
    if (!m || bad.has(i + 1)) continue;
    const t = Number(m[1]);
    if (t < first || (floor !== null && t <= floor)) continue;
    let o: unknown;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const { reason, peer, n: nRaw } = o as { reason?: unknown; peer?: unknown; n?: unknown };
    if (typeof reason !== 'string') continue;   // not a refusal's shape
    // a line written by the auditor's limiter stands for `n` refusals (D4 #1); without it, one
    const n = typeof nRaw === 'number' && Number.isSafeInteger(nRaw) && nRaw >= 1 ? Math.min(nRaw, N_MAX) : 1;
    const start = hourOf(t);
    let h = gateHours.get(start);
    if (!h) gateHours.set(start, (h = { by: new Map(), far: 0, nets: new Set() }));
    const rpc = reason.startsWith('rpc guard');
    const key = rpc ? 'rpc guard' : reason.slice(0, REASON_MAX);
    if (!shapeKey(key) && (h.by.has(key) || h.by.size < GATE_BY_MAX)) h.by.set(key, (h.by.get(key) ?? 0) + n);
    const far = farNet(peer);
    if (far !== null) { h.far += n; if (h.nets.size < NETS_HOUR) h.nets.add(far); }
    if (rpc) { gateGuard.push({ t, why: reason.slice(0, REASON_MAX) }); if (gateGuard.length > GATE_GUARD) gateGuard = gateGuard.slice(-GATE_GUARD); }
    if (t > gateNewest) gateNewest = t;
  }
  for (const s of gateHours.keys()) if (s < first) gateHours.delete(s);
}

/** This computer's gate over the last 26 UTC hours (the last one running), from the reject lines
 *  hostLedger verified; null until hostLedger has read a ledger. Counts only, no address. Its own
 *  export, because hostLedger returns early when nothing changed. */
export function hostGate(now = Date.now()): EyeGate | null {
  if (!ledgerKeyId) return null;
  const last = hourOf(now);
  const first = last - (GATE_HOURS - 1) * HOUR;
  for (const s of gateHours.keys()) if (s < first) gateHours.delete(s);
  const hours: EyeGate['hours'] = [];
  const nets = new Set<string>();
  for (let s = first; s <= last; s += HOUR) {
    const h = gateHours.get(s);
    hours.push({ start: s, by: h ? Object.fromEntries(h.by) : {}, far: h ? h.far : 0 });
    if (h) for (const n of h.nets) nets.add(n);
  }
  return { hours, nets: nets.size, guard: gateGuard.filter((g) => g.t >= first && g.t < last + HOUR).map((g) => ({ ...g })) };
}

// `gate`: count the rejects among the newly verified lines (the prefix fold only); its value is
// the floor for a fold from byte 0, null for an incremental one
function foldLines(text: string, publicKey: KeyObject, from: Fold, gate?: { floor: number | null }): Fold {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const r = verifyLines(lines, publicKey, from.last);
  verifiedLines += r.count;
  if (gate) gateFold(lines, r.problems, gate.floor);
  if (r.count === 0) return from;
  return { count: from.count + r.count, problems: [...from.problems, ...r.problems.map((p) => ({ n: p.n + from.count, reason: p.reason }))], last: r.last };
}

function checkFile(f: string, mtimeMs: number, prevIn: string, publicKey: KeyObject, before: FileSeen | null, floor: number): FileSeen {
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
  pre = foldLines(buf.subarray(offset, end).toString('utf8'), publicKey, pre, { floor: offset > 0 ? null : floor });
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
    if (keyId !== ledgerKeyId) { rotatedSeen.clear(); liveSeen = null; ledgerKeyId = keyId; gateHours.clear(); gateGuard = []; gateNewest = -1; }
    const floor = gateNewest;   // a fold from byte 0 in this pass counts only rejects newer than this
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
        if (!seen) seen = checkFile(f, s.mtimeMs, prev, key.publicKey, cached ?? (live ? null : lastLive), floor);
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
// reached over the internet (peers.ts pickRoute). The anchor network (16.11.2026) is read through
// a widened row (AnchorRow), so this compiles before the engine has it: a row whose via is
// 'anchor' (reached through an anchor of the circle) passes as it is, its `through` names the
// anchor's row ('self' when this computer is the anchor, null when the anchor is not in the peer
// book), its `throughName` the anchor's name, and `anchor: true` marks a row that offers the role.
type AnchorRow = Omit<PeerRow, 'via'> & { via?: PeerRow['via'] | 'anchor'; through?: string | null; throughName?: string | null; anchor?: boolean };
type AnchorLook = { on?: unknown; reachable?: unknown; links?: unknown; bytesDay?: unknown; capDay?: unknown; memberMaxDay?: unknown };
const via = (p: PeerRow): EyeDevice['via'] => {
  if ((p as AnchorRow).via === 'anchor') return 'anchor';
  const v = p.via ?? (p.cable ? 'cable' : p.far ? 'relay' : 'wifi');
  return v === 'anchor' || (v === 'wifi' && (p.reachedBy === 'ipv6' || p.reachedBy === 'mapped')) ? 'internet' : v;
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
  const a = p as AnchorRow;
  return {
    id: p.id, name: p.name, kind: p.kind, via: via(p), where: p.where, reachedBy: p.reachedBy ?? null,
    reachable: p.reach ? p.reach.ok : null, reachMs: p.reach?.ms ?? null, reason: p.reach?.ok ? null : p.reach?.reason ?? null,
    checkedAt: p.probedAt, lastOk: p.last_ok, ramMb: p.ram, bwGBs: p.bw, gpu: p.gpu,
    tls: p.tls, waitingPair: p.waitingPair, plugged: p.cable ? p.cable.plugged : null, holds: p.holds,
    trust: trustOf(trust),
    ring: p.ring ?? 'home',
    health: trust ? healthOf(trust.lines) : null,
    // its worker's own /status at the last probe (scan D M2 M1): numbers and flags only; absent
    // until one answered here
    ...(p.worker ? { worker: { at: p.worker.at, busy: p.worker.busy, tokensUsed: p.worker.tokensUsed, ctx: p.worker.ctx, ramFreeMb: p.worker.ramFreeMb } } : {}),
    // the anchor network: only when the row says it (an engine without anchors leaves them out)
    ...(a.through !== undefined ? { through: a.through } : {}),
    ...(a.throughName !== undefined ? { throughName: a.throughName } : {}),
    ...(a.anchor !== undefined ? { anchor: a.anchor } : {}),
  };
}

// this computer's anchor counters from engine.anchor(), when the engine has one: absent without
// it, null when it throws or says nothing; plain fields only (guard.ts cleans them). memberMaxDay
// (the most any single member passed today) only when the engine says it
function anchorOf(engine: Engine): Pick<Snapshot['host'], 'anchor'> {
  const e = engine as Engine & { anchor?: () => AnchorLook | null | undefined };
  if (typeof e.anchor !== 'function') return {};
  let r: AnchorLook | null | undefined = null;
  try { r = e.anchor(); } catch { r = null; }
  if (!r || typeof r !== 'object') return { anchor: null };
  return { anchor: {
    on: r.on, reachable: r.reachable, links: r.links, bytesDay: r.bytesDay, capDay: r.capDay,
    ...(r.memberMaxDay !== undefined ? { memberMaxDay: r.memberMaxDay } : {}),
  } as NonNullable<Snapshot['host']['anchor']> };
}

/** One look for god's eye. Reads only: the engine's status and cached peer rows, the model
 *  list, the projects; it never probes a device. */
export function kulaSnapshot(engine: Engine, projects: ProjectRunner, now = Date.now()): Snapshot {
  const st = engine.status();
  let freeMb: number | null = null;
  try { freeMb = freeRamMB(); } catch {}
  // free disk where a fetched model goes (scan D M3); an engine that cannot say it gives null
  let diskFreeMb: number | null = null;
  try { diskFreeMb = engine.diskFreeMb(); } catch {}
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
    // hostGate after hostLedger: the gate's counts come from the pass hostLedger just made
    host: { name: hostLabel(), freeMb, diskFreeMb, ledger: hostLedger(), gate: hostGate(now), ...anchorOf(engine) },
    devices: rows.map((p) => deviceOf(p, engine.trustOf(p.id))),
    work: { loaded, loading: st.loading, chatting: st.chatting, plan: st.plan, decisions: st.decisions, llama: st.llama, photos: engine.photos() },
    models: engine.models().map((m) => ({ id: m.id, name: m.name, file: m.file, size: m.size, quant: m.quant, params_b: m.params_b, catalog: m.catalog, here: m.here, needMb: m.needMb, active_b: m.active_b, vision: m.vision })),
    projects: projects.list().map((p) => ({ id: p.id, title: p.title, request: p.request, start: p.start, end: p.end, state: p.state, mode: p.mode, model: p.model, peers: p.peers.map(idOf), parts: p.parts, done: p.done, line: p.line, error: p.error })),
  });
}
