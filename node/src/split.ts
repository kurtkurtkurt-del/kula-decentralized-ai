// Split mode from the computer: tunnels to each peer's rpc channel on
// 127.0.0.1, then this computer's llama-server with --rpc <tunnels> and a
// tensor split from the planner. The output layer stays local because the
// local device is the first entry of the split and llama.cpp keeps the last
// layers on the main device. Before any of that a 2 s probe drops the peers
// that do not answer: ggml_backend_rpc_add_server aborts on a dead address.
import { Tunnel } from './gate.js';
import { planWithProbe, tensorSplit, type Plan, type ProbeFn } from './planner.js';
import type { Peer } from './peers.js';
import { freePort, startChild, type Child } from './children.js';
import type { LlamaBinaries } from './llama.js';
import type { SimModel, SimNet } from './sim.js';

type Log = (s: string) => void;

export interface SplitSetup {
  plan: Plan;
  tunnels: { peer: Peer; port: number; close(): Promise<void> }[];
  rpcArg: string;        // "127.0.0.1:p1,127.0.0.1:p2"
  tensorSplitArg: string; // "1200,800,..."
  close(): Promise<void>;
}

export interface SplitOptions {
  model: SimModel;
  ctx: number;
  localFreeMb: number;
  localBw: number;
  localEff?: number;
  net?: SimNet;
  localTps?: number | null;
  peerTps?: Record<string, number | null | undefined>;
  peers: Peer[];
  share?: boolean;
  probeMs?: number;
  probe?: ProbeFn;
  log?: Log;
}

// Plans and opens the tunnels. Throws TooBig when even together it does not fit.
export async function prepareSplit(opts: SplitOptions): Promise<SplitSetup> {
  const log = opts.log ?? (() => {});
  const plan = await planWithProbe({ model: opts.model, ctx: opts.ctx, localFreeMb: opts.localFreeMb, localBw: opts.localBw, localEff: opts.localEff, net: opts.net, localTps: opts.localTps, peerTps: opts.peerTps, wanted: opts.peers, share: opts.share ?? true, timeoutMs: opts.probeMs ?? 2000, probe: opts.probe });
  for (const s of plan.skipped) log(`${s.peer.name}: skipped, ${s.why}`);
  const tunnels: SplitSetup['tunnels'] = [];
  for (const u of plan.used) {
    const t = new Tunnel(u.host, u.port, u.secret, 'rpc');
    const port = await t.listen();
    tunnels.push({ peer: u, port, close: () => t.close() });
    log(`${u.name}: rpc tunnel 127.0.0.1:${port}, ${u.assignedMb} MB`);
  }
  log(`this computer: ${plan.localMb} MB${plan.fitsAlone ? ' (the model would fit here alone)' : ''}`);
  return {
    plan,
    tunnels,
    rpcArg: tunnels.map((t) => `127.0.0.1:${t.port}`).join(','),
    tensorSplitArg: tensorSplit(plan).join(','),
    close: async () => { for (const t of tunnels) await t.close(); },
  };
}

// The llama-server arguments for a split: the same as apart plus --rpc and
// the tensor split. Pure, so the test can check it without a binary.
export function splitServerArgs(modelFile: string, port: number, ctx: number, setup: Pick<SplitSetup, 'rpcArg' | 'tensorSplitArg'>): string[] {
  const args = ['--host', '127.0.0.1', '--port', String(port), '-m', modelFile, '-c', String(ctx), '-ngl', '99', '--no-webui'];
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
    if (child.proc.exitCode !== null) throw new Error('llama-server exited while loading (a worker dropped?)');
    if (Date.now() - t0 > 900000) { await child.stop(); throw new Error('llama-server took too long to load over rpc'); }
    await new Promise((r) => setTimeout(r, 300));
  }
  return child;
}
