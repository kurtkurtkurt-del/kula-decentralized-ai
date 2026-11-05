// The split planner for the computer side: the same core as the phone's
// (src/sim.ts is a byte-for-byte copy of app/src/llm/sim/model.ts; the test
// checks that) behind the shape kula-node's master command uses. Kept a pure
// function over numbers so it can be tested without a network; `planWithProbe`
// below does the 2 s probe first, because llama.cpp's ggml_backend_rpc_add_server
// aborts the whole process on a worker that does not answer, so only peers that
// answered are handed to it.
import type { Peer } from './peers.js';
import { probe as gateProbe, type ProbeResult } from './gate.js';
import { DEFAULT_BW, DEFAULT_EFF, LOCAL_SHARE, MB, planShares, WORKER_SHARE, type Estimate, type SimModel, type SimNet } from './sim.js';

export { LOCAL_SHARE, WORKER_SHARE, MB };
export type { Peer };


export interface Plan {
  mode: 'split';
  used: (Peer & { assignedMb: number; layers: number })[];
  skipped: { peer: Peer; why: string }[];
  localMb: number;
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
  net?: SimNet;
}

/** A model's shape for the planner from what the catalog or a gguf header says. */
export function simModel(m: { id: string; size: number; layers: number; hidden: number; vocab: number; quant: string; kv_mb_per_1k: number }): SimModel {
  const bpp = /q8/i.test(m.quant) ? 1 : /q3/i.test(m.quant) ? 0.45 : /f16|bf16/i.test(m.quant) ? 2 : 0.55;
  return { id: m.id, fileMb: m.size / MB, layers: m.layers, hidden: m.hidden, vocab: m.vocab, bytesPerParam: bpp, kvMbPer1k: m.kv_mb_per_1k };
}

export function planSplit(input: PlanInput): Plan {
  const net = input.net ?? { mbps: 30, rttMs: 3 };
  try {
    const sim = planShares({
      model: input.model, ctx: input.ctx, share: input.share, net,
      local: { id: 'me', capMb: input.localFreeMb * LOCAL_SHARE, bw: input.localBw || DEFAULT_BW, eff: input.localEff ?? DEFAULT_EFF },
      workers: input.peers.map((p) => ({ id: p.id, capMb: (p.ram ?? 2000) * WORKER_SHARE, bw: p.bw ?? DEFAULT_BW, eff: p.kind === 'pc' ? 0.3 : DEFAULT_EFF })),
    });
    return {
      mode: 'split',
      used: sim.used.map((u) => ({ ...(input.peers.find((p) => p.id === u.id) as Peer), assignedMb: u.assignedMb, layers: u.layers })),
      skipped: input.skipped ?? [],
      localMb: sim.localMb, fitsAlone: sim.fitsAlone, aloneFaster: sim.aloneFaster, totalMb: sim.totalMb, needMb: sim.needMb, est: sim.est, estAlone: sim.estAlone,
    };
  } catch (e) {
    if ((e as Error).message === 'toobig' || (e as Error).message === 'local') {
      const need = Math.round(input.model.fileMb * 1.05 + (input.model.kvMbPer1k * input.ctx) / 1024 + 300);
      throw new TooBig(need, Math.round(input.localFreeMb * LOCAL_SHARE + input.peers.reduce((a, p) => a + (p.ram ?? 2000) * WORKER_SHARE, 0)));
    }
    throw e;
  }
}

export type ProbeFn = (host: string, port: number, secret: string, channel: 'rpc' | 'api', timeoutMs: number) => Promise<ProbeResult>;

// Probes every wanted peer on the rpc channel (2 s) and plans with the ones
// that answered. Unreachable peers are in `skipped` with the gate's reason.
export async function planWithProbe(opts: Omit<PlanInput, 'peers' | 'skipped'> & { wanted: Peer[]; timeoutMs?: number; probe?: ProbeFn }): Promise<Plan> {
  const probe = opts.probe ?? gateProbe;
  const results = await Promise.all(opts.wanted.map(async (peer) => ({ peer, r: await probe(peer.host, peer.port, peer.secret, 'rpc', opts.timeoutMs ?? 2000) })));
  const peers = results.filter((x) => x.r.ok).map((x) => x.peer);
  const skipped = results.filter((x) => !x.r.ok).map((x) => ({ peer: x.peer, why: (x.r as { reason: string }).reason }));
  return planSplit({ ...opts, peers, skipped });
}

// The --rpc list and the tensor split llama.cpp wants: local first, then the
// workers in the order of the tunnels. Weights are the assigned MB.
export function tensorSplit(plan: Plan): number[] {
  return [plan.localMb, ...plan.used.map((u) => u.assignedMb)];
}
