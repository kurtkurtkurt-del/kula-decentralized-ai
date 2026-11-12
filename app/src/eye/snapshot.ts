import type { EyeDevice, EyeModel, EyeProject, EyeWork, Snapshot } from '@godseye/core';
import type { CatalogModel } from '@/llm/catalog';
import type { EngineState } from '@/llm/engine';
import type { LocalModel, Peer } from '@/llm/store';
import { OLD_WORKER, type TrustNote } from '@/llm/trust';
import type { Task } from '@/tasks/types';

// The phone's look for god's eye (11.11.2026): the twin of kula-node's ui/godseye-feed.ts. What
// the phone knows about its cluster (the engine, the paired devices, what the security report
// and the cards' probes saw of them, the models here and in the catalog, the person's projects,
// this phone's memory, ledger, battery and heat) turned into the eye's own Snapshot shape, as
// plain data. Pure: run.ts gathers the input (some of it read natively in the background) and
// hands it here every look; nothing in here asks a device anything.
//
// This phone is the snapshot's host, as the computer is on kula-node: its model running alone is
// mode 'here', the devices are the paired ones. A device's trust is null here: the phone's
// security report verifies natively and keeps its own notes (llm/trust.ts), and the phone's trust
// branch reads those (trustBranch.ts), not the snapshot.

export type Reach = { ok: boolean; at: number; why: string | null; ms?: number | null };
export type Power = { battery: number | null; charging: boolean | null; hot: boolean | null };

export type PhoneInput = {
  at: number;
  name: string;                                   // this phone, as its passport names it
  freeMb: number | null;                          // free memory, from the native info
  ledger: { ok: boolean; count: number; problem: string | null } | null;
  power: Power | null;
  engine: Pick<EngineState, 'model' | 'mode' | 'loading' | 'plan' | 'split' | 'devices' | 'generating' | 'load' | 'loadedAt'>;
  since: { loaded: number | null; loading: number | null };
  peers: Peer[];
  reach: Record<string, Reach>;                   // what the cards' probes saw, by peer id
  trust: Record<string, TrustNote>;               // what the security report saw, by peer id
  models: LocalModel[];
  catalog: CatalogModel[];
  tasks: Task[];
  decisions: { at: number; text: string }[];
  llama: boolean;                                 // this phone runs llama.cpp itself
};

const MB = 1024 * 1024;
/** What a model takes run whole at 4k context: kula-node's needMb (ui/engine.ts), the same numbers. */
export const needMb = (size: number, kvMbPer1k: number, ctx = 4096) => Math.round((size / MB) * 1.05 + (kvMbPer1k * ctx) / 1024 + 300);

/** The freshest word on a device's reach: a card's probe, the security report's last look, the
 *  engine that is using it now. null: nobody looked yet. */
function reachOf(p: Peer, i: PhoneInput): Reach | null {
  const seen: Reach[] = [];
  const probe = i.reach[p.id];
  if (probe) seen.push(probe);
  const n = i.trust[p.id];
  // an older kula without /trust answered with a 404: it was there
  if (n && n.at > 0) seen.push(n.answered || n.error === OLD_WORKER ? { ok: true, at: n.at, why: null } : { ok: false, at: n.at, why: n.error ?? 'no answer' });
  const d = i.engine.devices.find((x) => x.id === p.id);
  // stamped when the engine last heard it (load, answer, drop), not the look's own time: a look
  // with nothing new heard is not a new probe
  if (d) seen.push(d.out ? { ok: false, at: d.heardAt, why: 'it dropped a request and sits out' } : { ok: true, at: d.heardAt, why: null });
  return seen.sort((a, b) => b.at - a.at)[0] ?? null;
}

/** The model a device holds now: apart, every device in the list; split, the ones the plan used. */
function holdsOf(p: Peer, i: PhoneInput): string | null {
  const m = i.engine.model;
  if (!m || i.engine.loading) return null;
  if (i.engine.mode === 'apart' && i.engine.devices.some((d) => d.id === p.id)) return m.file;
  if (i.engine.mode === 'split' && i.engine.plan?.used.some((u) => u.id === p.id)) return m.file;
  return null;
}

export function deviceOf(p: Peer, i: PhoneInput): EyeDevice {
  const r = reachOf(p, i);
  const relay = !!p.relay;
  const gpu = typeof p.passport?.gpu === 'string' ? p.passport.gpu : null;
  return {
    id: p.id, name: p.name, kind: p.kind, via: relay ? 'relay' : 'wifi',
    where: relay ? 'a relay' : `${p.host}:${p.port}`,
    reachable: r ? r.ok : null, reachMs: r?.ms ?? null, reason: r && !r.ok ? r.why : null, checkedAt: r?.at ?? null,
    lastOk: p.last_ok ?? null, ramMb: p.ram, bwGBs: p.bw, gpu,
    tls: !!p.fp, waitingPair: !!p.pin, plugged: null, holds: holdsOf(p, i),
    trust: null,
  };
}

const MODE: Record<string, string> = { alone: 'here', apart: 'apart', split: 'split' };

/** A split part the engine named only (a state from before parts carried ids): the id of the one
 *  device the plan used under that name; none or two of them, or this phone's own name: unknown. */
function usedId(name: string, i: PhoneInput): string | null {
  if (name === i.name) return null;
  const hit = i.engine.plan?.used.filter((u) => u.name === name) ?? [];
  return hit.length === 1 ? hit[0].id : null;
}

function workOf(i: PhoneInput): EyeWork {
  const e = i.engine;
  const m = e.model;
  const loaded: EyeWork['loaded'] = m && !e.loading
    ? {
        mode: MODE[e.mode] ?? e.mode,
        model: { id: m.id, name: m.name, file: m.file, size: m.size },
        ctx: e.load?.ctx ?? 0,
        // the engine's own load time: a reload of the same model between two looks is a new load
        since: e.loadedAt ?? i.since.loaded ?? i.at,
        devices: e.devices.map((d) => ({ id: d.local ? 'me' : d.id, name: d.local ? i.name : d.name, local: d.local, busy: d.busy, tps: d.done > 0 && d.tps > 0 ? d.tps : null, done: d.done })),
        // the branches look parts up by device id: a peer's part carries its id, this phone's 'local'
        ...(e.mode === 'split' ? { parts: e.split.map((s) => ({ id: s.id ?? usedId(s.name, i) ?? s.name, name: s.name, local: s.local ?? s.name === i.name, mb: Math.round(s.gb * 1024), layers: 0 })) } : {}),
      }
    : null;
  const plan: string[] = [];
  if (e.plan) {
    if (e.plan.used.length) plan.push(`${e.plan.used.length} other device(s) hold a share: ${e.plan.used.map((u) => u.name).join(', ')}`);
    if (e.plan.aloneFaster) plan.push('this phone alone would be faster by the estimate');
    for (const s of e.plan.skipped) plan.push(`${s.peer.name} was left out: ${s.why}`);
  }
  return {
    loaded,
    loading: e.loading && m ? { mode: MODE[e.mode] ?? e.mode, model: m.name, since: i.since.loading ?? i.at, line: e.loading } : null,
    chatting: e.generating ? Math.max(1, e.devices.filter((d) => d.busy).length) : 0,
    plan,
    decisions: i.decisions,
    llama: i.llama,
  };
}

function modelsOf(i: PhoneInput): EyeModel[] {
  const here = new Map(i.models.map((m) => [m.id, m]));
  const out: EyeModel[] = i.catalog.map((c) => ({
    id: c.id, name: c.name, file: c.file, size: c.size, quant: c.quant, params_b: c.params_b,
    catalog: true, here: here.has(c.id), needMb: needMb(c.size + (c.mmproj?.size ?? 0), c.kv_mb_per_1k),
    // a mixture of experts reads only its active share per token (decide.ts readGb), as on kula-node
    active_b: c.active_b ?? null, vision: !!c.mmproj,
  }));
  for (const m of i.models) {
    if (i.catalog.some((c) => c.id === m.id)) continue;
    out.push({ id: m.id, name: m.name, file: m.file, size: m.size, quant: m.quant ?? null, params_b: m.params_b ?? null, catalog: false, here: true, needMb: needMb(m.size + (m.mmproj?.size ?? 0), m.kv_mb_per_1k || 64) });
  }
  return out;
}

/** today's (or the night's) window of a project's hours, as times */
function windowOf(t: Pick<Task, 'from' | 'to'>, at: number): { start: number; end: number } {
  const hm = (s: string) => { const [h, m] = s.split(':').map(Number); return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0); };
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  const from = hm(t.from), to = hm(t.to);
  const now = (at - d.getTime()) / 60_000;
  // a window over midnight that started yesterday is still the one we are in
  const day = to <= from && now < to ? d.getTime() - 86_400_000 : d.getTime();
  const start = day + from * 60_000;
  const end = (to <= from ? day + 86_400_000 : day) + to * 60_000;
  return { start, end };
}

export function projectOf(t: Task, at: number): EyeProject {
  const w = windowOf(t, at);
  const inWindow = at >= w.start && at < w.end;
  const state = !t.active ? 'off' : t.run && inWindow ? 'running' : t.run ? 'paused' : t.finished ? 'done' : 'waiting';
  return {
    id: t.id, title: t.title, request: t.prompt, start: w.start, end: w.end, state,
    mode: 'here', model: t.modelId ?? '', peers: [],
    ...(t.run ? { done: t.run.steps.length } : {}),
  };
}

/** One look for the eye. Plain data, nothing of the app's objects in it. */
export function phoneSnapshot(i: PhoneInput): Snapshot {
  return {
    at: i.at,
    host: { name: i.name, freeMb: i.freeMb, ledger: i.ledger, ...(i.power ? { power: { ...i.power } } : {}) },
    devices: i.peers.map((p) => deviceOf(p, i)),
    work: workOf(i),
    models: modelsOf(i),
    projects: i.tasks.map((t) => projectOf(t, i.at)),
  };
}

