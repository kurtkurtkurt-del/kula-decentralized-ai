// The split planner for the computer side: the same core as the phone's
// (src/sim.ts is a byte-for-byte copy of app/src/llm/sim/model.ts; the test
// checks that) behind the shape kula-node's master command uses. Kept a pure
// function over numbers so it can be tested without a network; `planWithProbe`
// below does the 2 s probe first, because llama.cpp's ggml_backend_rpc_add_server
// aborts the whole process on a worker that does not answer, so only peers that
// answered are handed to it.
import { REMOTE_NO_SPLIT, peerTls, type Peer } from './peers.js';
import { probe as gateProbe, type ProbeResult, type TlsClient } from './gate.js';
import type { GateIdentity } from './tls.js';
import { DEFAULT_BW, DEFAULT_EFF, LOCAL_SHARE, MB, planShares, withMeasured, WORKER_SHARE, type Estimate, type SimModel, type SimNet } from './sim.js';

export { LOCAL_SHARE, WORKER_SHARE, MB };
export type { Peer };


export interface Plan {
  mode: 'split';
  used: (Peer & { assignedMb: number; layers: number })[];
  skipped: { peer: Peer; why: string }[];
  localMb: number;
  localLayers?: number;
  fitsAlone: boolean;
  aloneFaster: boolean;
  totalMb: number;
  needMb: number;
  est: Estimate;
  estAlone: Estimate | null;
}

export class TooBig extends Error {
  constructor(readonly needMb: number, readonly totalMb: number) {
    super(`toobig: the model needs ${needMb} MB, the cluster offers ${totalMb} MB`);
  }
}


export interface PlanInput {
  model: SimModel;
  ctx: number;
  localFreeMb: number;
  localBw: number;      // GB/s; 0 → DEFAULT_BW
  localEff?: number;    // 0.3 for a mac m1 (measured); DEFAULT_EFF otherwise
  peers: Peer[];        // the ones that answered the probe
  skipped?: { peer: Peer; why: string }[];
  share: boolean;       // when it fits alone: share anyway?
  all?: boolean;        // every peer given gets a part (the person chose them)
  net?: SimNet;
  // measured decoding tok/s on this model (kula-node bench); they replace bw × eff
  localTps?: number | null;
  peerTps?: Record<string, number | null | undefined>;
}

/**
 * A model's shape for the planner from what the catalog or a gguf header says. A mixture of
 * experts (params_b and active_b, as in the catalog) reads active ÷ total of its weights per
 * token: the speed follows that share, the memory the whole file (sim.ts activeShare).
 */
export function simModel(m: { id: string; size: number; layers: number; hidden: number; vocab: number; quant: string; kv_mb_per_1k: number; params_b?: number; active_b?: number }): SimModel {
  const bpp = /q8/i.test(m.quant) ? 1 : /q3/i.test(m.quant) ? 0.45 : /f16|bf16/i.test(m.quant) ? 2 : 0.55;
  const share = m.params_b && m.active_b && m.active_b < m.params_b ? m.active_b / m.params_b : 1;
  return { id: m.id, fileMb: m.size / MB, layers: m.layers, hidden: m.hidden, vocab: m.vocab, bytesPerParam: bpp, kvMbPer1k: m.kv_mb_per_1k, ...(share < 1 ? { activeShare: share } : {}) };
}

export function planSplit(input: PlanInput): Plan {
  const net = input.net ?? { mbps: 30, rttMs: 3 };
  try {
    const sim = planShares({
      model: input.model, ctx: input.ctx, share: input.share, all: input.all, net,
      local: withMeasured({ id: 'me', capMb: input.localFreeMb * LOCAL_SHARE, bw: input.localBw || DEFAULT_BW, eff: input.localEff ?? DEFAULT_EFF }, input.model, input.localTps),
      workers: input.peers.map((p) => withMeasured({ id: p.id, capMb: (p.ram ?? 2000) * WORKER_SHARE, bw: p.bw ?? DEFAULT_BW, eff: p.kind === 'pc' ? 0.3 : DEFAULT_EFF }, input.model, input.peerTps?.[p.id])),
    });
    return {
      mode: 'split',
      used: sim.used.map((u) => ({ ...(input.peers.find((p) => p.id === u.id) as Peer), assignedMb: u.assignedMb, layers: u.layers })),
      skipped: input.skipped ?? [],
      localMb: sim.localMb, localLayers: sim.localLayers, fitsAlone: sim.fitsAlone, aloneFaster: sim.aloneFaster, totalMb: sim.totalMb, needMb: sim.needMb, est: sim.est, estAlone: sim.estAlone,
    };
  } catch (e) {
    if ((e as Error).message === 'toobig' || (e as Error).message === 'local') {
      const need = Math.round(input.model.fileMb * 1.05 + (input.model.kvMbPer1k * input.ctx) / 1024 + 300);
      throw new TooBig(need, Math.round(input.localFreeMb * LOCAL_SHARE + input.peers.reduce((a, p) => a + (p.ram ?? 2000) * WORKER_SHARE, 0)));
    }
    throw e;
  }
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
  return planSplit({ ...opts, peers, skipped });
}

// The --rpc list and the tensor split llama.cpp wants: local first, then the
// workers in the order of the tunnels. Weights are the assigned MB.
export function tensorSplit(plan: Plan): number[] {
  return [plan.localMb, ...plan.used.map((u) => u.assignedMb)];
}
