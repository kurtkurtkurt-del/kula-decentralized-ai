// The one place kula-node meets god's eye (src/godseye): kula's engine, peer book and night
// projects turned into god's eye's own snapshot shape. Plain data, copied; nothing of the engine
// leaks through, so the eye can later move into a program of its own and get the same snapshot
// over a pipe.
import fs from 'node:fs';
import path from 'node:path';
import type { Engine, PeerRow, TrustLook } from './engine.js';
import { hostLabel } from './engine.js';
import type { ProjectRunner } from './projects.js';
import type { EyeDevice, EyeTrust, Snapshot } from '../godseye/index.js';
import { freeRamMB } from '../sysinfo.js';
import { ledgerFile } from '../ledgercmd.js';
import { loadOrCreate } from '../audit/key.js';
import { chainFiles, verifyChain } from '../audit/ledger.js';

const trustOf = (t: TrustLook | null): EyeTrust | null => (t ? { ...t, lines: [...t.lines], rejectsDay: { ...t.rejectsDay }, rejectsLast: t.rejectsLast.map((r) => ({ ...r })) } : null);

// this computer's own ledger, checked again only when one of its files changed (it can be 5 MB)
let hostLedgerSeen: { stamp: string; v: Snapshot['host']['ledger'] } | null = null;
export function hostLedger(file = ledgerFile()): Snapshot['host']['ledger'] {
  if (!fs.existsSync(file)) return null;
  const stamp = chainFiles(file).map((f) => { try { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return f; } }).join('|');
  if (hostLedgerSeen?.stamp === stamp) return hostLedgerSeen.v;
  let v: Snapshot['host']['ledger'];
  try {
    const r = verifyChain(file, loadOrCreate().publicKey);
    const p = r.files.flatMap((f) => f.problems.map((x) => `line ${x.n} of ${path.basename(f.file)}: bad ${x.reason}`))[0] ?? null;
    v = { ok: r.ok, count: r.count, problem: p };
  } catch (e) { v = { ok: false, count: 0, problem: (e as Error).message }; }
  hostLedgerSeen = { stamp, v };
  return v;
}

// the way the device is reached now (one device is one row: engine.peers, devices.ts)
const via = (p: PeerRow): EyeDevice['via'] => p.via ?? (p.cable ? 'cable' : p.far ? 'relay' : 'wifi');

export function deviceOf(p: PeerRow, trust: TrustLook | null = null): EyeDevice {
  return {
    id: p.id, name: p.name, kind: p.kind, via: via(p), where: p.where,
    reachable: p.reach ? p.reach.ok : null, reachMs: p.reach?.ms ?? null, reason: p.reach?.ok ? null : p.reach?.reason ?? null,
    checkedAt: p.probedAt, lastOk: p.last_ok, ramMb: p.ram, bwGBs: p.bw, gpu: p.gpu,
    tls: p.tls, waitingPair: p.waitingPair, plugged: p.cable ? p.cable.plugged : null, holds: p.holds,
    trust: trustOf(trust),
    ring: p.ring ?? 'home',
  };
}

/** One look for god's eye. Reads only: the engine's status and cached peer rows, the model
 *  list, the projects; it never probes a device. */
export function kulaSnapshot(engine: Engine, projects: ProjectRunner, now = Date.now()): Snapshot {
  const st = engine.status();
  let freeMb: number | null = null;
  try { freeMb = freeRamMB(); } catch {}
  return structuredClone({
    at: now,
    host: { name: hostLabel(), freeMb, ledger: hostLedger() },
    devices: engine.peers().map((p) => deviceOf(p, engine.trustOf(p.id))),
    work: { loaded: st.loaded, loading: st.loading, chatting: st.chatting, plan: st.plan, decisions: st.decisions, llama: st.llama },
    models: engine.models().map((m) => ({ id: m.id, name: m.name, file: m.file, size: m.size, quant: m.quant, params_b: m.params_b, catalog: m.catalog, here: m.here, needMb: m.needMb })),
    projects: projects.list().map((p) => ({ id: p.id, title: p.title, request: p.request, start: p.start, end: p.end, state: p.state, mode: p.mode, model: p.model, peers: p.peers, parts: p.parts, done: p.done, line: p.line, error: p.error })),
  });
}
