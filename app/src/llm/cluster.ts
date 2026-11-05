import { llama, native, type PeerArg, type PeerFound } from '@/llm/native';
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
};

const MB = 1024 * 1024;
export const LOCAL_SHARE = 0.7;   // of this phone's free RAM a model may take
export const WORKER_SHARE = 0.75; // of a worker's advertised free RAM
export const NEED_FACTOR = 1.1;   // file × this: buffers and the context

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
 * Plans a split load: capacities from free RAM, the fastest device first. If the model fits
 * on this phone alone the caller asks "keep it here (faster) or share"; `share` says what
 * they chose. Throws 'toobig' when even together it does not fit.
 */
export async function planSplit(model: LocalModel, localFreeMb: number, localBw: number, wanted: Peer[], share: boolean): Promise<Plan> {
  const needMb = Math.round((model.size / MB) * NEED_FACTOR);
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
  const local = { capMb: localFreeMb * LOCAL_SHARE, bw: localBw || 4 };
  const workers = probed.ok.map((p) => ({ peer: p, capMb: (p.ram ?? 2000) * WORKER_SHARE, bw: p.bw ?? 4 }));
  const totalMb = local.capMb + workers.reduce((a, w) => a + w.capMb, 0);
  if (needMb > totalMb) throw new Error('toobig');
  const fitsAlone = needMb <= local.capMb;
  type Row = { peer: Peer | null; capMb: number; bw: number; assignedMb: number };
  const rows: Row[] = [{ peer: null, ...local, assignedMb: 0 }, ...workers.map((w) => ({ ...w, assignedMb: 0 }))];
  if (fitsAlone && !share) {
    rows[0].assignedMb = needMb;
  } else if (fitsAlone && share) {
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
    // does not fit here: fill the fastest first, up to capacity; phones not needed stay out
    let left = needMb;
    for (const r of [...rows].sort((a, b) => b.bw - a.bw)) {
      const take = Math.min(r.capMb, left);
      r.assignedMb = take;
      left -= take;
      if (left <= 0) break;
    }
  }
  const used = rows.filter((r) => r.peer && r.assignedMb > 0).map((r) => ({ ...(r.peer as Peer), assignedMb: Math.round(r.assignedMb) }));
  return { mode: 'split', used, skipped, localMb: Math.round(rows.find((r) => !r.peer)!.assignedMb), fitsAlone, totalMb: Math.round(totalMb), needMb };
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

/** Peers to try for a mode: all saved ones; the probe decides. */
export const candidates = () => savedPeers();
