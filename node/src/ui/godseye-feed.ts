// The one place kula-node meets god's eye (src/godseye): kula's engine, peer book and night
// projects turned into god's eye's own snapshot shape. Plain data, copied; nothing of the engine
// leaks through, so the eye can later move into a program of its own and get the same snapshot
// over a pipe.
import type { Engine, PeerRow } from './engine.js';
import { hostLabel } from './engine.js';
import type { ProjectRunner } from './projects.js';
import type { EyeDevice, Snapshot } from '../godseye/index.js';
import { freeRamMB } from '../sysinfo.js';

const via = (p: PeerRow): EyeDevice['via'] => (p.cable ? 'cable' : p.far ? 'relay' : 'wifi');

export function deviceOf(p: PeerRow): EyeDevice {
  return {
    id: p.id, name: p.name, kind: p.kind, via: via(p), where: p.where,
    reachable: p.reach ? p.reach.ok : null, reachMs: p.reach?.ms ?? null, reason: p.reach?.ok ? null : p.reach?.reason ?? null,
    checkedAt: p.probedAt, lastOk: p.last_ok, ramMb: p.ram, bwGBs: p.bw, gpu: p.gpu,
    tls: p.tls, waitingPair: p.waitingPair, plugged: p.cable ? p.cable.plugged : null, holds: p.holds,
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
    host: { name: hostLabel(), freeMb },
    devices: engine.peers().map(deviceOf),
    work: { loaded: st.loaded, loading: st.loading, chatting: st.chatting, plan: st.plan, decisions: st.decisions, llama: st.llama },
    models: engine.models().map((m) => ({ id: m.id, name: m.name, file: m.file, size: m.size, quant: m.quant, params_b: m.params_b, catalog: m.catalog, here: m.here, needMb: m.needMb })),
    projects: projects.list().map((p) => ({ id: p.id, title: p.title, request: p.request, start: p.start, end: p.end, state: p.state, mode: p.mode, model: p.model, peers: p.peers, parts: p.parts, done: p.done, line: p.line, error: p.error })),
  });
}
