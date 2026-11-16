// The split planner for the computer side: the same core as the phone's
// (src/sim.ts is a byte-for-byte copy of app/src/llm/sim/model.ts; the test
// checks that) behind the shape kula-node's master command uses. Kept a pure
// function over numbers so it can be tested without a network; `planWithProbe`
// below does the 2 s probe first, because llama.cpp's ggml_backend_rpc_add_server
// aborts the whole process on a worker that does not answer, so only peers that
// answered are handed to it.
import { REMOTE_NO_SPLIT, peerTls, dialOf, candidates, type Peer } from './peers.js';
import { probe as gateProbe, probeOver, type ProbeResult, type TlsClient } from './gate.js';
import type { GateIdentity } from './tls.js';
import { isAnchorRoad, openRoad, pickRoute, roadContext, roads, roadWords, type RoadContext } from './road.js';
import { DEFAULT_BW, DEFAULT_EFF, LOCAL_SHARE, MB, planShares, RPC_ROUND_TRIPS, withMeasured, WORKER_SHARE, type Estimate, type SimModel, type SimNet } from './sim.js';

export { LOCAL_SHARE, WORKER_SHARE, MB };
export type { Peer };


export interface Plan {
  mode: 'split';
  used: (Peer & { assignedMb: number; layers: number })[];
  skipped: { peer: Peer; why: string }[];
  // answered, but the planner found the answers faster without them
  notNeeded: Peer[];
  localMb: number;
  localLayers?: number;
  fitsAlone: boolean;
  aloneFaster: boolean;
  totalMb: number;
  needMb: number;
  est: Estimate;
  estAlone: Estimate | null;
  learned?: string[];      // devices whose speed came from their answers ('me': this computer)
  seenTps?: number | null; // this split's last real tok/s
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
  // efficiencies learned from answers (learn.ts): they replace the guessed ones, per device
  peerEff?: Record<string, number | undefined>;
  localLearned?: boolean;  // localEff came from answers, not a guess
  seenTps?: number | null; // what this very split (devices and model) last ran at
}

/**
 * A model's shape for the planner from what the catalog or a gguf header says. A mixture of
 * experts (read_share, else params_b and active_b, as in the catalog) reads that share of its
 * weights per token: the speed follows that share, the memory the whole file (sim.ts activeShare).
 */
export function simModel(m: { id: string; size: number; layers: number; hidden: number; vocab: number; quant: string; kv_mb_per_1k: number; params_b?: number; active_b?: number; read_share?: number }): SimModel {
  const bpp = /q8/i.test(m.quant) ? 1 : /q3/i.test(m.quant) ? 0.45 : /f16|bf16/i.test(m.quant) ? 2 : 0.55;
  // the catalog's measured bytes share first, as on the phone (fit.ts activeShare)
  const share = m.read_share && m.read_share > 0 && m.read_share < 1 ? m.read_share : m.params_b && m.active_b && m.active_b < m.params_b ? m.active_b / m.params_b : 1;
  return { id: m.id, fileMb: m.size / MB, layers: m.layers, hidden: m.hidden, vocab: m.vocab, bytesPerParam: bpp, kvMbPer1k: m.kv_mb_per_1k, ...(share < 1 ? { activeShare: share } : {}) };
}

// A worker's own link for the estimate (sim.ts SimDevice.net): what was measured to it along its
// road (link.ts: through an anchor that is both legs), the plan's net for what was not measured.
export function workerNet(p: Pick<Peer, 'link'>, net: SimNet): SimNet | undefined {
  const l = p.link;
  if (!l || (l.mbps == null && l.rttMs == null)) return undefined;
  return { mbps: l.mbps != null && l.mbps > 0 ? l.mbps : net.mbps, rttMs: l.rttMs ?? net.rttMs };
}

export function planSplit(input: PlanInput): Plan {
  // the network of a worker that was never measured (the old guess); a measured one brings its own
  const net = input.net ?? { mbps: 30, rttMs: 3 };
  try {
    const sim = planShares({
      model: input.model, ctx: input.ctx, share: input.share, all: input.all, net,
      local: withMeasured({ id: 'me', capMb: input.localFreeMb * LOCAL_SHARE, bw: input.localBw || DEFAULT_BW, eff: input.localEff ?? DEFAULT_EFF }, input.model, input.localTps),
      workers: input.peers.map((p) => {
        const w = workerSide(p);
        const own = workerNet(p, net);
        return { ...withMeasured({ id: p.id, capMb: w.capMb, bw: w.bw, eff: input.peerEff?.[p.id] ?? w.eff }, input.model, input.peerTps?.[p.id]), ...(own ? { net: own } : {}) };
      }),
    });
    return {
      mode: 'split',
      used: sim.used.map((u) => ({ ...(input.peers.find((p) => p.id === u.id) as Peer), assignedMb: u.assignedMb, layers: u.layers })),
      skipped: input.skipped ?? [],
      notNeeded: input.peers.filter((p) => !sim.used.some((u) => u.id === p.id)),
      localMb: sim.localMb, localLayers: sim.localLayers, fitsAlone: sim.fitsAlone, aloneFaster: sim.aloneFaster, totalMb: sim.totalMb, needMb: sim.needMb, est: sim.est, estAlone: sim.estAlone,
      learned: [...(input.localLearned ? ['me'] : []), ...input.peers.filter((p) => input.peerEff?.[p.id] !== undefined).map((p) => p.id)], seenTps: input.seenTps ?? null,
    };
  } catch (e) {
    if ((e as Error).message === 'toobig' || (e as Error).message === 'local') {
      const need = Math.round(input.model.fileMb * 1.05 + (input.model.kvMbPer1k * input.ctx) / 1024 + 300);
      throw new TooBig(need, Math.round(input.localFreeMb * LOCAL_SHARE + input.peers.reduce((a, p) => a + workerSide(p).capMb, 0)));
    }
    throw e;
  }
}

export type ProbeFn = (host: string, port: number, secret: string, channel: 'rpc' | 'api', timeoutMs: number, tls?: TlsClient | null) => Promise<ProbeResult>;

// Probes every wanted peer on the rpc channel (2 s) along its road (road.ts: its lan address, an
// internet address, or through an anchor) and plans with the ones that answered. Unreachable
// peers are in `skipped` with the gate's reason. A peer behind the hosted relay is skipped before
// any probe: only the api channel crosses that relay. A far peer (internet, anchor) is planned
// like any other, with its own measured link: the planner says whether it is worth it.
export async function planWithProbe(opts: Omit<PlanInput, 'peers' | 'skipped'> & { wanted: Peer[]; timeoutMs?: number; probe?: ProbeFn; identity?: GateIdentity; roads?: RoadContext }): Promise<Plan> {
  const probe = opts.probe ?? gateProbe;
  const ctx = opts.roads ?? (opts.identity ? roadContext(opts.identity) : null);
  const results = await Promise.all(opts.wanted.map(async (peer0): Promise<{ peer: Peer; r: ProbeResult }> => {
    let peer = peer0;
    if (peer.relay) return { peer, r: { ok: false, reason: REMOTE_NO_SPLIT } };
    const tls = opts.identity ? peerTls(peer, opts.identity) : null;
    if (peer.fp && !tls) return { peer, r: { ok: false, reason: 'no identity for tls' } };
    const ms = opts.timeoutMs ?? 2000;
    // the road as it is now (the lan answers first when it is home again)
    if (ctx && peer.fp && !peer.cable && roads(peer, ctx).length > 1) {
      const a = await pickRoute(peer, ctx, ms);
      const first = candidates(peer)[0];
      if (a) peer = { ...peer, route: !isAnchorRoad(a) && a.host === first.host && a.port === first.port ? null : a };
    }
    const road = peer.route;
    if (isAnchorRoad(road)) {
      if (!ctx) return { peer, r: { ok: false, reason: 'no identity for an anchor' } };
      return { peer, r: await probeOver(() => openRoad(road, peer, ctx, ms), peer.secret, 'rpc', ms, tls) };
    }
    const d = dialOf(peer);
    return { peer, r: await probe(d.host, d.port, peer.secret, 'rpc', ms, tls) };
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

// ---- what each worker brings, and the plan in words (14.11.2026) ----------------------------
//
// A computer whose llama.cpp runs on an NVIDIA card (Linux and Windows download the CUDA build
// only when nvidia-smi answers) keeps its layers in the card's memory: VRAM is its room, not
// its RAM, and the card is its speed. The card's speed is not measured yet, so it is guessed low
// from its name. Apple silicon shares one memory (its vram is 0) and an AMD card gets the cpu
// build: both stay on RAM and the measured memory speed.
export const VRAM_SHARE = 0.85;
export const GPU_EFF = 0.5;
const NVIDIA = /nvidia|geforce|rtx|gtx|quadro|tesla|a100|h100|h200|l40/i;

export function gpuGuessGbs(name: string): number {
  if (/rtx\s*(50\d0|40[89]0)|a100|h100|h200|l40/i.test(name)) return 700;
  if (/rtx\s*(40|30)\d0|a6000/i.test(name)) return 400;
  if (/rtx\s*20\d0|gtx\s*16\d0/i.test(name)) return 250;
  return 150;
}

export interface WorkerSide { capMb: number; bw: number; eff: number; on: 'gpu' | 'cpu'; guessed: boolean }

export function workerSide(p: Pick<Peer, 'kind' | 'ram' | 'bw' | 'gpu' | 'vram'>): WorkerSide {
  if (p.kind === 'pc' && p.gpu && NVIDIA.test(p.gpu) && (p.vram ?? 0) >= 2048) {
    return { capMb: p.vram! * VRAM_SHARE, bw: gpuGuessGbs(p.gpu), eff: GPU_EFF, on: 'gpu', guessed: true };
  }
  return { capMb: (p.ram ?? 2000) * WORKER_SHARE, bw: p.bw ?? DEFAULT_BW, eff: p.kind === 'pc' ? 0.3 : DEFAULT_EFF, on: 'cpu', guessed: p.bw == null };
}

// an estimate is a model of the hardware and the network, not a measurement: say it as a range
export function tpsRange(tps: number): string {
  const r = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
  return `${r(tps * 0.6)}–${r(tps * 1.15)}`;
}

// The plan in plain words: who takes how much and on what, who is left out and why, the
// estimate as a range, and the honest advice when this computer alone would do better.
// localGpu false: this computer's llama.cpp has no gpu device, so its layers run on the processor
// and the output layer on the last worker (split.ts llamaSplit)
// anchorName: an anchor's name by its certificate (the peer book), for "through anchor <name>"
export function explainPlan(pl: Plan, model: string, nameOf: (p: Peer) => string = (p) => p.name, localGpu = true, anchorName?: (fp: string) => string | null | undefined): string[] {
  const out: string[] = [];
  const KIND: Record<string, string> = { pc: 'computer', phone: 'phone', tablet: 'tablet' };
  const label = (p: Peer) => `${nameOf(p)} (${KIND[p.kind] ?? p.kind})`;
  // how it is reached (same wi-fi, the internet, an anchor) and what its link costs each token
  const net = (p: Peer) => {
    const how = roadWords(p, anchorName);
    if (!p.link || p.link.mbps == null) return `${how}, network not measured`;
    const hop = p.link.rttMs != null ? `; about ${Math.round(RPC_ROUND_TRIPS * p.link.rttMs * 10) / 10} ms of each token on the way` : '';
    return `${how}, network ${p.link.mbps} MB/s, ${p.link.rttMs} ms${hop}`;
  };
  const gb = (mb: number) => Math.round(mb / 102.4) / 10;
  const brings = (p: Peer) => {
    const w = workerSide(p);
    const learned = pl.learned?.includes(p.id);
    return w.on === 'gpu'
      ? `its graphics card (${p.gpu}, ${gb(p.vram ?? 0)} GB; ${learned ? 'its speed learned from its answers' : 'its speed is guessed from the name'})`
      : `its memory (${p.bw != null ? `${Math.round(p.bw)} GB/s` : 'speed not known'}${learned ? ', speed learned from its answers' : ''})`;
  };
  const short = (p: Peer) => (workerSide(p).on === 'gpu' ? `${p.gpu}` : `memory ${p.bw != null ? `${Math.round(p.bw)} GB/s` : 'speed not known'}`);
  if (!pl.used.length) out.push(`${model} runs on this computer alone.`);
  else {
    out.push(`${model} is split over ${pl.used.length + 1} devices; the strongest takes the most:`);
    if (localGpu) out.push(pl.localLayers ? `this computer: ${pl.localLayers} layers and the input and output layers (${pl.localMb} MB).` : `this computer: the input and output layers (${pl.localMb} MB).`);
    else out.push(`this computer: ${pl.localLayers ? `${pl.localLayers} layers on its processor and ` : ''}the input layer (${pl.localMb} MB); the output layer runs on ${nameOf(pl.used[pl.used.length - 1])}, the last in the chain.`);
    for (const u of pl.used) out.push(`${label(u)}: ${u.layers} layers (${u.assignedMb} MB) on ${brings(u)}; ${net(u)}.`);
  }
  for (const p of pl.notNeeded) out.push(`${label(p)} left out: the answers come faster without it (${short(p)}; ${net(p)}).`);
  for (const s of pl.skipped) out.push(`${nameOf(s.peer)} left out: ${s.why}.`);
  if (pl.est && pl.used.length) {
    const how = pl.learned?.length ? 'worked out from memory speeds, what the devices showed in earlier answers, and the network' : 'worked out from memory speeds and the network, not measured yet';
    out.push(`estimate: about ${tpsRange(pl.est.tps)} tok/s (${how}).${pl.seenTps ? ` last time this split ran at ${pl.seenTps} tok/s.` : ''}`);
  }
  if (pl.fitsAlone && pl.aloneFaster && pl.estAlone) {
    out.push(`suggestion: it fits on this computer alone and runs faster here (about ${tpsRange(pl.estAlone.tps)} tok/s): pick “here”, or “apart” to answer several chats at once.`);
  } else if (pl.fitsAlone && pl.estAlone && pl.est) {
    out.push(`it would also fit here alone (about ${tpsRange(pl.estAlone.tps)} tok/s); split is faster.`);
  }
  return out;
}
