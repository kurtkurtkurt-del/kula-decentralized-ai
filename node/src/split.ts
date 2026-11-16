// Split mode from the computer: tunnels to each peer's rpc channel on
// 127.0.0.1, then this computer's llama-server with --rpc <tunnels> and a
// tensor split from the planner. The output layer stays local because the
// local device is the first entry of the split and llama.cpp keeps the last
// layers on the main device. Before any of that a 2 s probe drops the peers
// that do not answer: ggml_backend_rpc_add_server aborts on a dead address.
import { Tunnel } from './gate.js';
import { planWithProbe, MB, type Plan, type ProbeFn } from './planner.js';
import { guessShape } from './gguf.js';
import { peerTls, type Peer } from './peers.js';
import type { GateIdentity } from './tls.js';
import { roadDialer, roadWords, type RoadContext } from './road.js';
import { freePort, startChild, type Child, exited } from './children.js';
import type { LlamaBinaries } from './llama.js';
import { spawnSync } from 'node:child_process';
import type { SimModel, SimNet } from './sim.js';

type Log = (s: string) => void;

export interface SplitSetup {
  plan: Plan;
  tunnels: { peer: Peer; port: number; close(): Promise<void> }[];
  rpcArg: string;        // "127.0.0.1:p1,127.0.0.1:p2"
  tensorSplitArg: string; // "11,17" (layers per device, in llama.cpp's device order)
  ngl: number;            // -ngl: 99, or fewer to keep the first layers on this computer's processor
  localGpu: boolean;      // this computer is one of llama.cpp's devices (Metal, CUDA, …)
  close(): Promise<void>;
}

export interface SplitOptions {
  // the model's shape: from the gguf header (gguf.ts simModelOf) when the caller read it,
  // else guessed from the size alone
  model?: SimModel;
  modelBytes?: number;
  ctx?: number;
  localFreeMb: number;
  localBw: number;
  localEff?: number;
  net?: SimNet;
  localTps?: number | null;
  peerTps?: Record<string, number | null | undefined>;
  peers: Peer[];
  share?: boolean;
  all?: boolean;   // every peer that answers gets a part
  probeMs?: number;
  probe?: ProbeFn;
  log?: Log;
  identity?: GateIdentity;
  // with the identity: this computer's anchor and the anchors it is registered with (road.ts)
  roads?: RoadContext;
  // this computer's llama.cpp has a gpu device (hasLocalGpu); default true (a Mac)
  localGpu?: boolean;
  peerEff?: Record<string, number | undefined>;
  localLearned?: boolean;
  seenTps?: number | null;
  // the compute scale this split's answers showed (learn.ts splitScale; planner.ts PlanInput)
  computeScale?: number | null;
}

// ---- the plan in llama.cpp's terms (15.11.2026) -------------------------------------------
//
// llama.cpp b11157 (src/llama.cpp, src/llama-model.cpp): the rpc servers come FIRST in its
// device list ("to minimize network transfers"), this computer's gpus after them; the repeating
// layers and the output layer are n+1 slots, slot s going to the first device whose running
// share of --tensor-split exceeds s/(n+1); the output layer is the last slot, so the last device.
// Layers before i_gpu_start = n+1-ngl stay on the processor. So with a local gpu the weights are
// [workers…, this computer + the output slot]; without one this computer is not a device at all
// and keeps its first layers through -ngl, the output going to the last worker.
export interface LlamaSplit { tensorSplit: number[]; ngl: number; outputOn: 'local' | string }

export function llamaSplit(plan: Pick<Plan, 'used' | 'localLayers'>, nLayers: number, localGpu: boolean): LlamaSplit {
  const workers = plan.used.map((u) => Math.max(0, u.layers));
  const local = Math.max(0, plan.localLayers ?? nLayers - workers.reduce((a, b) => a + b, 0));
  // every slot offloaded: -ngl 99 kept the first layers of a model with more than 98 on the processor
  if (!workers.length) return { tensorSplit: [], ngl: nLayers + 1, outputOn: 'local' };
  if (localGpu) return { tensorSplit: [...workers, local + 1], ngl: nLayers + 1, outputOn: 'local' };
  const w = [...workers];
  w[w.length - 1] += 1;
  return { tensorSplit: w, ngl: nLayers + 1 - local, outputOn: plan.used[plan.used.length - 1].id };
}

// llama.cpp's own assignment, written out (for the tests and for honesty in the plan): how many
// of the n+1 slots each device gets, and how many stay on the processor
export function llamaLayers(tensorSplit: number[], nLayers: number, ngl: number): { cpu: number; devices: number[] } {
  const sum = tensorSplit.reduce((a, b) => a + b, 0);
  let run = 0;
  const cut = tensorSplit.map((x) => Math.fround((run += x) / sum));
  const start = Math.max(nLayers + 1 - ngl, 0);
  const act = Math.min(ngl, nLayers + 1);
  const devices = tensorSplit.map(() => 0);
  let cpu = 0;
  for (let il = 0; il <= nLayers; il++) {
    if (il < start || il - start >= act) { cpu++; continue; }
    const f = Math.fround((il - start) / act);
    let d = cut.findIndex((c) => c > f);
    if (d < 0) d = cut.length - 1;
    devices[d]++;
  }
  return { cpu, devices };
}

// whether this computer's llama.cpp lists a gpu (MTL0, CUDA0, Vulkan0, …; BLAS and CPU are not
// devices in its list), asked once per binary
const gpuCache = new Map<string, boolean>();
export function hasLocalGpu(llama: LlamaBinaries | null): boolean {
  if (!llama) return true;
  const known = gpuCache.get(llama.llamaServer);
  if (known !== undefined) return known;
  let yes = true;
  try {
    const r = spawnSync(llama.llamaServer, ['--list-devices'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const i = text.indexOf('Available devices:');
    if (i >= 0) yes = text.slice(i).split('\n').slice(1).some((l) => /^\s+(?!BLAS|CPU)[A-Za-z]+\d*:/.test(l));
  } catch {}
  gpuCache.set(llama.llamaServer, yes);
  return yes;
}

// Plans and opens the tunnels. Throws TooBig when even together it does not fit.
export async function prepareSplit(opts: SplitOptions): Promise<SplitSetup> {
  const log = opts.log ?? (() => {});
  if (!opts.model && !opts.modelBytes) throw new Error('prepareSplit: need model or modelBytes');
  const model = opts.model ?? (() => { const g = guessShape(opts.modelBytes!); return { id: 'model', fileMb: opts.modelBytes! / MB, layers: g.layers, hidden: g.hidden, vocab: g.vocab, bytesPerParam: g.bytesPerParam, kvMbPer1k: g.kvMbPer1k }; })();
  const plan = await planWithProbe({ model, ctx: opts.ctx ?? 2048, localFreeMb: opts.localFreeMb, localBw: opts.localBw, localEff: opts.localEff, net: opts.net, localTps: opts.localTps, peerTps: opts.peerTps, peerEff: opts.peerEff, localLearned: opts.localLearned, seenTps: opts.seenTps, computeScale: opts.computeScale, wanted: opts.peers, share: opts.share ?? true, all: opts.all, timeoutMs: opts.probeMs ?? 2000, probe: opts.probe, identity: opts.identity, roads: opts.roads });
  for (const s of plan.skipped) log(`${s.peer.name}: skipped, ${s.why}`);
  log(`split plan: asked ${opts.peers.map((p) => p.name).join(', ') || 'none'}${opts.all ? ' (all of them)' : ''}; parts for ${plan.used.map((u) => `${u.name} ${u.assignedMb} MB`).join(', ') || 'nobody'}`);
  const tunnels: SplitSetup['tunnels'] = [];
  const who = opts.roads ?? opts.identity;
  for (const u of plan.used) {
    // the rpc channel follows the device's road (lan, internet or an anchor), as the api one does
    const tls = opts.identity ? peerTls(u, opts.identity) : null;
    const t = who ? Tunnel.over(roadDialer(u, who), u.secret, 'rpc', tls) : new Tunnel(u.host, u.port, u.secret, 'rpc', tls);
    const port = await t.listen();
    tunnels.push({ peer: u, port, close: () => t.close() });
    log(`${u.name}: rpc tunnel 127.0.0.1:${port}, ${u.assignedMb} MB, ${roadWords(u)}`);
  }
  log(`this computer: ${plan.localMb} MB${plan.fitsAlone ? ' (the model would fit here alone)' : ''}`);
  return {
    plan,
    tunnels,
    rpcArg: tunnels.map((t) => `127.0.0.1:${t.port}`).join(','),
    ...(() => {
      const ls = llamaSplit(plan, model.layers, opts.localGpu ?? true);
      return { tensorSplitArg: ls.tensorSplit.join(','), ngl: ls.ngl, localGpu: opts.localGpu ?? true };
    })(),
    close: async () => { for (const t of tunnels) await t.close(); },
  };
}

// The llama-server arguments for a split: the same as apart plus --rpc and
// the tensor split. Pure, so the test can check it without a binary.
export function splitServerArgs(modelFile: string, port: number, ctx: number, setup: Pick<SplitSetup, 'rpcArg' | 'tensorSplitArg'> & { ngl?: number }): string[] {
  const args = ['--host', '127.0.0.1', '--port', String(port), '-m', modelFile, '-c', String(ctx), '-ngl', String(setup.ngl ?? 99), '--no-webui'];
  if (setup.rpcArg) args.push('--rpc', setup.rpcArg, '--tensor-split', setup.tensorSplitArg);
  return args;
}

// Starts llama-server over the tunnels and waits for /health. Returned as a
// backend for the local api, so split mode chats through the same client.
export async function startSplitServer(llama: LlamaBinaries | null, modelFile: string, ctx: number, setup: SplitSetup, log: Log): Promise<Child> {
  if (!llama) throw new Error('llama.cpp is not set up here (run: kula-node setup); split mode needs a local llama-server');
  const port = await freePort();
  const child = await startChild('llama-server', llama.llamaServer, splitServerArgs(modelFile, port, ctx, setup), port, log, 180000);
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {}
    if (exited(child.proc)) throw new Error('llama-server exited while loading (a worker dropped?)');
    if (Date.now() - t0 > 900000) { await child.stop(); throw new Error('llama-server took too long to load over rpc'); }
    await new Promise((r) => setTimeout(r, 300));
  }
  return child;
}
