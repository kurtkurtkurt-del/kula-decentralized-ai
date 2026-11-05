// The cluster cost model and the split planner's core, in one file with no imports so the
// phone (app/src/llm/cluster.ts) and the computer (node/src/sim.ts) run the very same
// code: node/test/planner.test.ts checks the two files are byte for byte the same and
// that both give the plans in tools/planner-vectors.json. docs/PLANNER.md explains the
// model and where each number comes from.
//
// Units: MB = 1024² bytes for memory, GB/s for memory bandwidth, MB/s for the network,
// ms for time. Everything is deterministic and integer-rounded at the end only.

export const MB = 1024 * 1024;
export const OVERHEAD_MB = 300;      // the runtime, the compute buffer, the gate (fit.ts agrees)
export const FILE_FACTOR = 1.05;     // the mmap'd file plus its small per-tensor slack
export const LOCAL_SHARE = 0.7;      // of this device's free RAM a model may take
export const WORKER_SHARE = 0.75;    // of a worker's advertised free RAM
export const DEFAULT_BW = 4;         // GB/s for a device that never measured itself
export const DEFAULT_EFF = 0.6;      // tok/s = bw × eff / model_gb (passport COMBINE.efficiency)
export const RPC_ROUND_TRIPS = 3;    // per worker per token: set input, compute, get output
export const ACT_BYTES = 4;          // activations cross as f32
export const DISK_MBPS = 300;        // reading the local part of the file
export const LOAD_FIXED_S = 5;       // opening the file, building the graph
export const PROMPT_FACTOR = 8;      // prompt tokens go this many times faster than decoding
export const GAIN_TO_SHARE = 1.15;   // a split must be this much faster to be called faster

export type SimModel = {
  id: string;
  fileMb: number;
  layers: number;        // transformer blocks (the output layer is one more)
  hidden: number;        // the activation width that crosses the network per token
  vocab: number;
  bytesPerParam: number; // 0.5 for q4_k_m, 1 for q8_0
  kvMbPer1k: number;     // kv cache per 1 024 tokens of context
};
export type SimDevice = {
  id: string;
  capMb: number;         // what the planner may give this device (already × share)
  bw: number;            // GB/s memory bandwidth
  eff: number;           // fraction of bw a decode step really streams (measured: mac m1 0.3)
};
export type SimNet = {
  mbps: number;          // MB/s between the master and a worker
  rttMs: number;         // one round trip
};
export type Estimate = {
  perTokenMs: number;    // decoding, one token, every device and hop
  tps: number;
  loadS: number;         // from "start" to the first prompt
  hops: number;          // workers in the chain
  netMsPerToken: number; // the part of perTokenMs that is the network
};
export type Share = { id: string; assignedMb: number; layers: number };
export type SplitPlan = {
  localMb: number;
  used: Share[];
  needMb: number;
  totalMb: number;
  fitsAlone: boolean;
  aloneFaster: boolean;  // the split chosen is not GAIN_TO_SHARE × faster than alone
  est: Estimate;
  estAlone: Estimate | null;
  localLayers: number;
};
export type PlanInput = {
  model: SimModel;
  ctx: number;
  local: SimDevice;
  workers: SimDevice[];
  net: SimNet;
  share: boolean;        // when it fits alone: share anyway
  all?: boolean;         // use every worker given, not the fastest few (6.11.2026: the person picked them)
};

export const kvMb = (m: SimModel, ctx: number) => (m.kvMbPer1k * ctx) / 1024;
/** What a model takes at a context size (the same number as fit.ts needMb). */
export const needMb = (m: SimModel, ctx: number) => m.fileMb * FILE_FACTOR + kvMb(m, ctx) + OVERHEAD_MB;
/** The embedding and output matrices: they stay on the master (no logits over wi-fi). */
export const embedMb = (m: SimModel) => (m.vocab * m.hidden * m.bytesPerParam) / MB;
/** The bytes that are spread over the devices: the blocks' weights and the kv cache of their layers. */
export const spreadMb = (m: SimModel, ctx: number) => m.fileMb * FILE_FACTOR - embedMb(m) + kvMb(m, ctx);

const tpsOf = (d: SimDevice, gb: number) => (d.bw * (d.eff || DEFAULT_EFF)) / gb;

/**
 * The efficiency that makes estimateAlone give back a measured tok/s on this model (bench:
 * docs/BENCH.md). It carries over to other models on the same device as well as anything
 * does: the decode step streams the weights either way.
 */
export function effFromTps(m: SimModel, bw: number, tps: number): number {
  const gb = (m.fileMb * FILE_FACTOR) / 1024;
  return (tps * gb) / (bw || DEFAULT_BW);
}

/** A device with a measured tok/s folded in (as its eff), or the device as it was without one. */
export function withMeasured(d: SimDevice, m: SimModel, tps: number | null | undefined): SimDevice {
  if (!tps || !(tps > 0)) return d;
  return { ...d, bw: d.bw || DEFAULT_BW, eff: effFromTps(m, d.bw, tps) };
}

/** Decoding on one device alone, and the time to open the file from disk. */
export function estimateAlone(m: SimModel, d: SimDevice): Estimate {
  const gb = (m.fileMb * FILE_FACTOR) / 1024;
  const perTokenMs = 1000 / tpsOf(d, gb);
  return fin({ perTokenMs, loadS: LOAD_FIXED_S + m.fileMb / DISK_MBPS, hops: 0, netMsPerToken: 0 });
}

/**
 * Decoding over a chain (rows[0] is the master; `mb` are the planner's shares, only their
 * proportions matter here): the master keeps the first layers and the output layer, each
 * worker a run of layers. Per token every device streams its own bytes once; every worker
 * costs RPC_ROUND_TRIPS round trips plus the activation there and back. The upload is the
 * workers' bytes over the network, the local part from disk.
 */
export function estimateSplit(m: SimModel, rows: { dev: SimDevice; mb: number }[], net: SimNet): Estimate {
  const total = rows.reduce((a, r) => a + r.mb, 0) || 1;
  const weightMb = m.fileMb - embedMb(m); // the bytes that really move: the file less the embedding
  let computeMs = 1000 / tpsOf(rows[0].dev, embedMb(m) / 1024); // the output layer, always here
  for (const r of rows) {
    const gb = (weightMb * (r.mb / total)) / 1024;
    if (gb > 0) computeMs += 1000 / tpsOf(r.dev, gb);
  }
  const workers = rows.slice(1).filter((r) => r.mb > 0);
  const actMs = ((2 * m.hidden * ACT_BYTES) / (net.mbps * 1e6)) * 1000;
  const netMsPerToken = workers.length * (RPC_ROUND_TRIPS * net.rttMs + actMs);
  const uploadS = workers.reduce((a, r) => a + (weightMb * (r.mb / total)) / net.mbps, 0);
  const localS = (embedMb(m) + weightMb * (rows[0].mb / total)) / DISK_MBPS;
  return fin({ perTokenMs: computeMs + netMsPerToken, loadS: LOAD_FIXED_S + uploadS + localS, hops: workers.length, netMsPerToken });
}

const fin = (e: Omit<Estimate, 'tps'>): Estimate => ({
  perTokenMs: r1(e.perTokenMs), tps: r1(1000 / e.perTokenMs), loadS: r1(e.loadS), hops: e.hops, netMsPerToken: r1(e.netMsPerToken),
});
const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Spreads `total` over rows in proportion to `want`, never past `cap`; the overflow of a
 * full row goes to the others in the same proportion (water filling). `min` is honoured
 * first. Returns null when caps and mins cannot hold the total.
 */
export function waterfill(rows: { want: number; cap: number; min?: number }[], total: number): number[] | null {
  const out = rows.map((r) => Math.min(r.min ?? 0, r.cap));
  let left = total - out.reduce((a, x) => a + x, 0);
  if (left < -1e-6) return null;
  const open = new Set(rows.map((_, i) => i));
  for (let guard = 0; left > 1e-6 && open.size && guard < 64; guard++) {
    const sumWant = [...open].reduce((a, i) => a + rows[i].want, 0);
    if (sumWant <= 0) return null;
    let placed = 0;
    for (const i of [...open]) {
      const room = rows[i].cap - out[i];
      const give = Math.min(room, (left * rows[i].want) / sumWant);
      out[i] += give;
      placed += give;
      if (rows[i].cap - out[i] <= 1e-6) open.delete(i);
    }
    left -= placed;
    if (placed <= 1e-9) break;
  }
  return left > 1e-6 ? null : out;
}

/**
 * The split planner. Candidates are the fastest k workers for every k. The block bytes
 * (weights and kv) go to the fastest device first, each up to its capacity, the way a
 * token is computed: one device after the other, so bytes on a faster device are time
 * saved and every worker in the chain costs a hop. The embedding and output matrices
 * and the runtime stay on the master. The candidate with the shortest token wins, so a
 * slow network (dear hops) ends with fewer devices than a fast one. When the model fits
 * alone: without `share` only the alone plan; with it the bytes go out by speed in
 * proportion (the phone keeps RAM free, which is why one shares what fits), and
 * `aloneFaster` says whether the split beats alone by GAIN_TO_SHARE. Throws 'toobig'
 * when no candidate holds the model, 'local' when this device cannot hold the output
 * layer and the runtime.
 */
export function planShares(input: PlanInput): SplitPlan {
  const { model, ctx, local, net } = input;
  const need = needMb(model, ctx);
  const spread = spreadMb(model, ctx);
  const fixedLocal = embedMb(model) + OVERHEAD_MB;
  const speed = (d: SimDevice) => d.bw * (d.eff || DEFAULT_EFF);
  const workers = [...input.workers].sort((a, b) => speed(b) - speed(a) || a.id.localeCompare(b.id));
  const totalMb = local.capMb + workers.reduce((a, w) => a + w.capMb, 0);
  if (local.capMb < fixedLocal) throw new Error('local');
  if (need > totalMb) throw new Error('toobig');
  const fitsAlone = need <= local.capMb;
  const estAlone = fitsAlone ? estimateAlone(model, local) : null;
  const alonePlan = (): SplitPlan => ({
    localMb: Math.round(need), used: [], needMb: Math.round(need), totalMb: Math.round(totalMb), fitsAlone, aloneFaster: true,
    est: estAlone!, estAlone, localLayers: model.layers,
  });
  if (fitsAlone && !input.share && !input.all) return alonePlan();

  let best: { rows: { dev: SimDevice; mb: number }[]; est: Estimate } | null = null;
  for (let k = input.all ? workers.length : 1; k <= workers.length; k++) {
    const devs = [local, ...workers.slice(0, k)];
    const caps = devs.map((d, i) => (i === 0 ? d.capMb - fixedLocal : d.capMb));
    let filled: number[] | null;
    // all: every picked device takes a part, so the bytes go out by speed in proportion
    if (fitsAlone || input.all) {
      filled = waterfill(devs.map((d, i) => ({ want: speed(d), cap: caps[i] })), spread);
    } else {
      // the fastest first, up to its capacity
      filled = devs.map(() => 0);
      let left = spread;
      for (const i of devs.map((_, i) => i).sort((a, b) => speed(devs[b]) - speed(devs[a]) || a - b)) {
        filled[i] = Math.min(caps[i], left);
        left -= filled[i];
      }
      if (left > 1e-6) filled = null;
    }
    if (!filled) continue;
    const rows = devs.map((dev, i) => ({ dev, mb: filled![i] }));
    const est = estimateSplit(model, rows, net);
    if (!best || est.perTokenMs < best.est.perTokenMs) best = { rows, est };
  }
  if (!best) {
    if (fitsAlone) return alonePlan();
    throw new Error('toobig');
  }
  // the split must beat alone by the margin, else the honest word is "alone is faster"
  const aloneFaster = !!estAlone && !(best.est.perTokenMs * GAIN_TO_SHARE <= estAlone.perTokenMs);
  const sum = best.rows.reduce((a, r) => a + r.mb, 0);
  const layersOf = (mb: number) => Math.round((model.layers * mb) / sum);
  const used = best.rows.slice(1).filter((r) => r.mb > 0).map((r) => ({ id: r.dev.id, assignedMb: Math.round(r.mb), layers: layersOf(r.mb) }));
  return {
    localMb: Math.round(best.rows[0].mb + fixedLocal), used, needMb: Math.round(need), totalMb: Math.round(totalMb), fitsAlone, aloneFaster,
    est: best.est, estAlone, localLayers: model.layers - used.reduce((a, u) => a + u.layers, 0),
  };
}

// ---- apart mode: one copy per device, prompts handed out by expected finish ------------
export type ApartDevice = {
  id: string;
  tps: number;            // decoding, measured or estimated
  promptTps?: number;     // prompt processing; PROMPT_FACTOR × tps when unknown
  busyUntil: number;      // ms clock: when the work already handed to it ends
  out?: boolean;          // dropped: never picked
};
export type Request = { promptTokens: number; maxTokens: number };

/** 'long' prompts are worth waiting for a fast device; 'short' ones go wherever is free. */
export const kindOf = (r: Request): 'long' | 'short' => (r.promptTokens + r.maxTokens > 512 ? 'long' : 'short');

export function expectedMs(d: ApartDevice, r: Request): number {
  const tps = d.tps > 0 ? d.tps : 1;
  return (r.promptTokens / (d.promptTps ?? tps * PROMPT_FACTOR)) * 1000 + (r.maxTokens / tps) * 1000;
}
export const expectedFinish = (d: ApartDevice, r: Request, now: number) => Math.max(now, d.busyUntil) + expectedMs(d, r);

/**
 * The device that would finish this request first; a short request on a busy fast device
 * loses to a free slow one when the wait is longer than the work. Null when every device
 * is out.
 */
export function pickDevice<D extends ApartDevice>(devs: D[], r: Request, now: number): D | null {
  let best: D | null = null;
  let bestT = Infinity;
  for (const d of devs) {
    if (d.out) continue;
    const t = expectedFinish(d, r, now);
    if (t < bestT - 1e-9 || (Math.abs(t - bestT) < 1e-9 && best && d.busyUntil < best.busyUntil)) {
      best = d;
      bestT = t;
    }
  }
  return best;
}

/** Hands a request to a device: its queue grows by the expected time. */
export function assign(d: ApartDevice, r: Request, now: number): number {
  d.busyUntil = expectedFinish(d, r, now);
  return d.busyUntil;
}

/**
 * Simulates a batch in apart mode: every request to the device that finishes it first,
 * in order; returns the makespan and per-device counts. `drops` lets a test take a device
 * away at a clock time: its queue goes back on the pile.
 */
export function simulateApart(devs: ApartDevice[], reqs: Request[], opts: { now?: number; dropAt?: { id: string; atMs: number }[] } = {}): { makespanMs: number; perDevice: Record<string, number>; reassigned: number } {
  const now = opts.now ?? 0;
  const pool = devs.map((d) => ({ ...d }));
  const perDevice: Record<string, number> = Object.fromEntries(pool.map((d) => [d.id, 0]));
  const queue: { r: Request; dev: ApartDevice; end: number }[] = [];
  let reassigned = 0;
  const pile = [...reqs];
  const place = (r: Request, at: number) => {
    const d = pickDevice(pool, r, at);
    if (!d) throw new Error('nodevice');
    const end = assign(d, r, at);
    queue.push({ r, dev: d, end });
  };
  for (const r of pile) place(r, now);
  for (const drop of opts.dropAt ?? []) {
    const d = pool.find((x) => x.id === drop.id);
    if (!d) continue;
    d.out = true;
    const lost = queue.filter((q) => q.dev === d && q.end > drop.atMs);
    for (const q of lost) {
      queue.splice(queue.indexOf(q), 1);
      reassigned++;
    }
    for (const q of lost) place(q.r, drop.atMs);
  }
  for (const q of queue) perDevice[q.dev.id]++;
  return { makespanMs: Math.round(Math.max(now, ...queue.map((q) => q.end)) - now), perDevice, reassigned };
}
