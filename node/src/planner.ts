// The split planner, a copy of app/src/llm/cluster.ts (planSplit) for the
// computer side. Kept a pure function over numbers so it can be tested
// without a network; `planWithProbe` below does the 2 s probe first, because
// llama.cpp's ggml_backend_rpc_add_server aborts the whole process on a
// worker that does not answer, so only peers that answered are handed to it.
// The output layer always stays local; workers get weights by free RAM
// (capacity) in order of memory bandwidth (speed).
import { REMOTE_NO_SPLIT, peerTls, type Peer } from './peers.js';
import { probe as gateProbe, type ProbeResult, type TlsClient } from './gate.js';
import type { GateIdentity } from './tls.js';

export const MB = 1024 * 1024;
export const LOCAL_SHARE = 0.7;   // of this computer's free RAM a model may take
export const WORKER_SHARE = 0.75; // of a worker's advertised free RAM
export const NEED_FACTOR = 1.1;   // file × this: buffers and the context

export type Mode = 'apart' | 'split';

export interface Plan {
  mode: 'split';
  used: (Peer & { assignedMb: number })[];
  skipped: { peer: Peer; why: string }[];
  localMb: number;
  fitsAlone: boolean;
  totalMb: number;
  needMb: number;
}

export class TooBig extends Error {
  constructor(readonly needMb: number, readonly totalMb: number) {
    super(`toobig: the model needs ${needMb} MB, the cluster offers ${totalMb} MB`);
  }
}

export interface PlanInput {
  modelBytes: number;
  localFreeMb: number;
  localBw: number;      // GB/s; 0 → a default of 4
  peers: Peer[];        // the ones that answered the probe
  skipped?: { peer: Peer; why: string }[];
  share: boolean;       // when it fits alone: share anyway?
}

export function planSplit(input: PlanInput): Plan {
  const needMb = Math.round((input.modelBytes / MB) * NEED_FACTOR);
  const local = { capMb: input.localFreeMb * LOCAL_SHARE, bw: input.localBw || 4 };
  const workers = input.peers.map((p) => ({ peer: p, capMb: (p.ram ?? 2000) * WORKER_SHARE, bw: p.bw ?? 4 }));
  const totalMb = local.capMb + workers.reduce((a, w) => a + w.capMb, 0);
  if (needMb > totalMb) throw new TooBig(needMb, Math.round(totalMb));
  const fitsAlone = needMb <= local.capMb;
  type Row = { peer: Peer | null; capMb: number; bw: number; assignedMb: number };
  const rows: Row[] = [{ peer: null, ...local, assignedMb: 0 }, ...workers.map((w) => ({ ...w, assignedMb: 0 }))];
  if (fitsAlone && !input.share) {
    rows[0].assignedMb = needMb;
  } else if (fitsAlone && input.share) {
    // split by speed, capped by capacity, overflow redistributed
    const sumBw = rows.reduce((a, r) => a + r.bw, 0);
    let left = needMb;
    for (const r of rows) r.assignedMb = Math.min(r.capMb, (needMb * r.bw) / sumBw);
    left -= rows.reduce((a, r) => a + r.assignedMb, 0);
    for (const r of rows.sort((a, b) => b.bw - a.bw)) {
      if (left <= 0) break;
      const extra = Math.min(r.capMb - r.assignedMb, left);
      r.assignedMb += extra;
      left -= extra;
    }
  } else {
    // does not fit here: fill the fastest first, up to capacity; devices not needed stay out
    let left = needMb;
    for (const r of [...rows].sort((a, b) => b.bw - a.bw)) {
      const take = Math.min(r.capMb, left);
      r.assignedMb = take;
      left -= take;
      if (left <= 0) break;
    }
  }
  const used = rows.filter((r) => r.peer && r.assignedMb > 0).map((r) => ({ ...(r.peer as Peer), assignedMb: Math.round(r.assignedMb) }));
  return {
    mode: 'split',
    used,
    skipped: input.skipped ?? [],
    localMb: Math.round(rows.find((r) => !r.peer)!.assignedMb),
    fitsAlone,
    totalMb: Math.round(totalMb),
    needMb,
  };
}

export type ProbeFn = (host: string, port: number, secret: string, channel: 'rpc' | 'api', timeoutMs: number, tls?: TlsClient | null) => Promise<ProbeResult>;

// Probes every wanted peer on the rpc channel (2 s) and plans with the ones
// that answered. Unreachable peers are in `skipped` with the gate's reason. A
// peer far away (relay) is skipped before any probe: every token of a split
// would cross the internet, and only the api channel is relayed anyway.
export async function planWithProbe(opts: Omit<PlanInput, 'peers' | 'skipped'> & { wanted: Peer[]; timeoutMs?: number; probe?: ProbeFn; identity?: GateIdentity }): Promise<Plan> {
  const probe = opts.probe ?? gateProbe;
  const results = await Promise.all(opts.wanted.map(async (peer): Promise<{ peer: Peer; r: ProbeResult }> => {
    if (peer.relay) return { peer, r: { ok: false, reason: REMOTE_NO_SPLIT } };
    const tls = opts.identity ? peerTls(peer, opts.identity) : null;
    if (peer.fp && !tls) return { peer, r: { ok: false, reason: 'no identity for tls' } };
    return { peer, r: await probe(peer.host, peer.port, peer.secret, 'rpc', opts.timeoutMs ?? 2000, tls) };
  }));
  const peers = results.filter((x) => x.r.ok).map((x) => x.peer);
  const skipped = results.filter((x) => !x.r.ok).map((x) => ({ peer: x.peer, why: (x.r as { reason: string }).reason }));
  return planSplit({ modelBytes: opts.modelBytes, localFreeMb: opts.localFreeMb, localBw: opts.localBw, share: opts.share, peers, skipped });
}

// The --rpc list and the tensor split llama.cpp wants: local first, then the
// workers in the order of the tunnels. Weights are the assigned MB.
export function tensorSplit(plan: Plan): number[] {
  return [plan.localMb, ...plan.used.map((u) => u.assignedMb)];
}
