import { llama, native, type PeerArg, type PeerFound } from '@/llm/native';
import { DEFAULT_BW, DEFAULT_EFF, LOCAL_SHARE, planShares, withMeasured, type Estimate, type SimNet } from '@/llm/sim/model';
import { measuredFor } from '@/bench/store';
import { modelProfile, NETWORKS, workerFromPeer } from '@/llm/sim/profiles';
import { peers as savedPeers, touchPeer, type LocalModel, type Mode, type Peer } from '@/llm/store';

// The planner (after PrivateLM's cluster_service.dart, 31.10.2026): before a load, which
// peers answer, how the model is shared between them, and whether sharing is worth it.
// Every endpoint is probed through the gate first: llama.cpp aborts the whole app on an
// unreachable worker, so only peers that answered are handed to the native side.
export type Plan = {
  mode: Mode;
  used: (Peer & { assignedMb: number })[];
  skipped: { peer: Peer; why: string }[];
  localMb: number;
  fitsAlone: boolean;
  totalMb: number;
  needMb: number;
  aloneFaster?: boolean;      // the split is not worth it by the estimate; the user may still want it
  est?: Estimate;             // the chosen plan's expected load time and token time
  estAlone?: Estimate | null; // the same for this phone alone, when it fits
};

export { LOCAL_SHARE, WORKER_SHARE } from '@/llm/sim/model';

export async function probeAll(list: Peer[], channel: 'rpc' | 'api' = 'rpc'): Promise<{ ok: Peer[]; bad: { peer: Peer; why: string }[] }> {
  if (!llama) return { ok: [], bad: list.map((peer) => ({ peer, why: 'nonative' })) };
  const n = native();
  const ok: Peer[] = [];
  const bad: { peer: Peer; why: string }[] = [];
  await Promise.all(list.map(async (peer) => {
    const why = await n.probePeer(peer.host, peer.port, peer.secret, channel).catch((e: Error) => e.message);
    if (why) bad.push({ peer, why });
    else {
      ok.push(peer);
      touchPeer(peer.id, { last_ok: new Date().toISOString() });
    }
  }));
  return { ok, bad };
}

/** A peer whose ip changed: find it again by id on the network (a few seconds of NSD). */
export async function relocate(peer: Peer, ms = 4000): Promise<Peer | null> {
  if (!llama) return null;
  const n = native();
  return new Promise((resolve) => {
    let done = false;
    const sub = n.addListener('onPeerFound', (f: PeerFound) => {
      if (done || f.id !== peer.id || !f.host) return;
      done = true;
      sub.remove();
      n.discover(false).catch(() => {});
      const moved = { ...peer, host: f.host, port: f.port, ram: f.ram ?? peer.ram, bw: f.bw ?? peer.bw };
      touchPeer(peer.id, { host: f.host, port: f.port });
      resolve(moved);
    });
    n.discover(true).catch(() => {});
    setTimeout(() => {
      if (done) return;
      done = true;
      sub.remove();
      n.discover(false).catch(() => {});
      resolve(null);
    }, ms);
  });
}

/**
 * Plans a split load with the simulator's core (sim/model.ts planShares): capacities from
 * free RAM, the layer bytes spread by speed and water-filled into them, the embedding and
 * output matrices kept here, and the number of workers chosen by the estimated time per
 * token on this network (fewer on a slow one). If the model fits on this phone alone the
 * caller asks "keep it here (faster) or share"; `share` says what they chose. Throws
 * 'toobig' when even together it does not fit, 'local' when this phone cannot hold the
 * output layer.
 */
export async function planSplit(model: LocalModel, localFreeMb: number, localBw: number, wanted: Peer[], share: boolean, ctx = 2048, net: SimNet = NETWORKS.wifi5): Promise<Plan> {
  const probed = await probeAll(wanted, 'rpc');
  const skipped = [...probed.bad];
  // a peer that moved: one try to find it again
  for (const b of probed.bad) {
    const moved = await relocate(b.peer);
    if (moved) {
      const again = await probeAll([moved], 'rpc');
      if (again.ok.length) {
        probed.ok.push(moved);
        skipped.splice(skipped.indexOf(b), 1);
      }
    }
  }
  // a bench on this model (this phone, or a peer measured by kula-node bench) replaces bw × eff
  const sm = modelProfile(model);
  const key = modelKey(model);
  const sim = planShares({
    model: sm, ctx, share, net,
    local: withMeasured({ id: 'me', capMb: localFreeMb * LOCAL_SHARE, bw: localBw || DEFAULT_BW, eff: DEFAULT_EFF }, sm, measuredFor('self', key)),
    workers: probed.ok.map((p) => withMeasured(workerFromPeer(p), sm, measuredFor(p.id, key))),
  });
  const used = sim.used.map((u) => ({ ...(probed.ok.find((p) => p.id === u.id) as Peer), assignedMb: u.assignedMb }));
  return { mode: 'split', used, skipped, localMb: sim.localMb, fitsAlone: sim.fitsAlone, totalMb: sim.totalMb, needMb: sim.needMb, aloneFaster: sim.aloneFaster, est: sim.est, estAlone: sim.estAlone };
}

export const peerArgs = (plan: Plan): PeerArg[] => plan.used.map((p) => ({ host: p.host, port: p.port, secret: p.secret, weight: p.assignedMb }));

/** "this phone 1.2 gb · pixel 0.8 gb" from the native split report. */
export function splitSummary(split: { buffer: string; mb: number | null }[], names: Map<string, string>, thisName: string): { name: string; gb: number }[] {
  const by = new Map<string, number>();
  for (const s of split) {
    const m = s.buffer.match(/^RPC\d+\[([^\]]+)\]/);
    const key = m ? names.get(m[1]) ?? m[1] : thisName;
    by.set(key, (by.get(key) ?? 0) + (s.mb ?? 0));
  }
  return Array.from(by, ([name, mb]) => ({ name, gb: Math.round(mb / 102.4) / 10 })).sort((a, b) => b.gb - a.gb);
}

/** How the bench history names a model: its id, or its file and size (docs/BENCH.md). */
export const modelKey = (m: Pick<LocalModel, 'id' | 'file' | 'size'>) => ({ id: m.id, file: m.file, size: m.size });

/** Peers to try for a mode: all saved ones; the probe decides. */
export const candidates = () => savedPeers();
