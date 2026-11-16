import { llama, native, type PeerArg, type PeerFound, type PeerRelay, type PeerTls } from '@/llm/native';
import { DEFAULT_BW, DEFAULT_EFF, LOCAL_SHARE, planShares, withMeasured, type Estimate, type SimNet } from '@/llm/sim/model';
import { measuredFor } from '@/bench/store';
import { modelProfile, NETWORKS, workerFromPeer } from '@/llm/sim/profiles';
import { isRemote, learnPeer, myAnchors } from '@/llm/peers';
import { pickRoad, roadArgs, roadsOf, sameRoad } from '@/llm/roads';
import { peers as savedPeers, touchPeer, type LocalModel, type Mode, type Peer, type PeerAnchor, type Road } from '@/llm/store';

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

/** Why a peer behind the hosted relay cannot take part in split mode: only the api channel is relayed. A peer reached through an anchor can (docs/ANCHOR.md). */
export const REMOTE_NO_SPLIT = 'remote';

/**
 * Asks every peer whether it can be used now, on `channel`. A peer behind the hosted relay is
 * asked on api through the relay, never on rpc. Every other peer is asked along its roads
 * (roads.ts: the wi-fi address, the code's direct internet addresses, then the anchors, 250 ms
 * apart, the pinned certificate decides) and comes back with the road that answered as its
 * `route` (null: host/port did), which the tunnels then follow, the split's rpc included.
 * `mine`: the anchors this phone joined (read from the native store when not given).
 */
export async function probeAll(list: Peer[], channel: 'rpc' | 'api' = 'rpc', mine?: PeerAnchor[]): Promise<{ ok: Peer[]; bad: { peer: Peer; why: string }[] }> {
  // a relayed peer is never probed for split: it is skipped before the native side, with its own reason
  const far = channel === 'rpc' ? list.filter(isRemote) : [];
  const near = channel === 'rpc' ? list.filter((p) => !isRemote(p)) : list;
  if (!llama) return { ok: [], bad: [...far.map((peer) => ({ peer, why: REMOTE_NO_SPLIT })), ...near.map((peer) => ({ peer, why: 'nonative' }))] };
  const n = native();
  const ok: Peer[] = [];
  const bad: { peer: Peer; why: string }[] = far.map((peer) => ({ peer, why: REMOTE_NO_SPLIT }));
  const anchors = mine ?? (near.some((p) => !isRemote(p) && p.fp) ? await myAnchors() : []);
  await Promise.all(near.map(async (peer) => {
    let answer: string | null;
    let route: Road | null = null;
    if (isRemote(peer)) {
      answer = await n.probePeer(peer.host, peer.port, peer.secret, channel, peerTls(peer), peerRelay(peer)).catch((e: Error) => e.message);
    } else {
      const roads = roadsOf(peer, anchors);
      const probe = (road: Road) => {
        const a = roadArgs({ host: peer.host, port: peer.port, route: road });
        return n.probePeer(a.host, a.port, peer.secret, channel, peerTls(peer), null, a.anchor);
      };
      // one road: asked as before; more: the staggered pick (one at a time while a pairing code is unspent)
      const r = roads.length > 1 ? await pickRoad(roads, probe, { serial: !!peer.pin }) : roads.length ? await probe(roads[0]).then((why) => ({ road: why ? null : roads[0], why }), (e: Error) => ({ road: null, why: e.message })) : { road: null, why: 'no road' };
      answer = r.road ? null : r.why ?? 'unreachable';
      route = r.road && !sameRoad(r.road, roads[0]) ? r.road : null;
    }
    // "ok <fp>": a relayed, code-only peer answered and this is its certificate
    const learned = answer?.startsWith('ok ') ? answer.slice(3) : null;
    if (answer && !learned) bad.push({ peer, why: answer });
    else {
      const taught = learned ? { ...peer, fp: learned, pin: null } : peer.pin ? { ...peer, pin: null } : peer;
      ok.push(isRemote(peer) ? taught : { ...taught, route });
      touchPeer(peer.id, { last_ok: new Date().toISOString(), ...(isRemote(peer) ? {} : { route }) });
      learnPeer(peer, learned);
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
  // a peer that moved: one try to find it again (not one far away: it is not on this wi-fi)
  for (const b of probed.bad) {
    if (isRemote(b.peer)) continue;
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

/** Protocol v2 for a v3 peer (its fingerprint, and the pairing code until the first connection spent it), v1 for a v2 peer. A relayed peer is always v2; an empty fp is learned on the first connection. */
export const peerTls = (p: Pick<Peer, 'fp' | 'pin' | 'relay'>): PeerTls => (p.fp || p.relay ? { fp: p.fp ?? '', pin: p.pin ?? null } : null);
/** The road to a peer far away, or null on the lan. */
export const peerRelay = (p: Pick<Peer, 'relay'>): PeerRelay => p.relay ?? null;

/** The native side's view of a peer's road: the address to dial, or the anchor to go through (roads.ts). */
export const peerRoad = (p: Pick<Peer, 'host' | 'port' | 'route'>) => roadArgs(p);

/** One tunnel per used peer, along the road its probe kept: through an anchor the split's rpc goes through it too. */
export const peerArgs = (plan: Plan): PeerArg[] => plan.used.map((p) => {
  const r = roadArgs(p);
  return { host: r.host, port: r.port, secret: p.secret, weight: p.assignedMb, fp: p.fp ?? null, pin: p.pin ?? null, ...(r.anchor ? { anchor: r.anchor } : {}) };
});

/** One device's share of a split. `id` and `local` come when the endpoints were named with peer ids:
 *  the peer's id, or 'local' for this phone (kula-node's id for its own part). */
export type SplitPart = { id?: string; name: string; gb: number; local?: boolean };

/** "this phone 1.2 gb · pixel 0.8 gb" from the native split report. Endpoints named by peer
 *  ({id, name}) are kept apart by id, so two devices with the same name stay two parts and only
 *  this phone's own buffers are local (12.11.2026, P13); named by a plain string, by that name.
 *  `byId` asks for the id shape even when no peer holds a share (an empty map). */
export function splitSummary(split: { buffer: string; mb: number | null }[], names: Map<string, string>, thisName: string): { name: string; gb: number }[];
export function splitSummary(split: { buffer: string; mb: number | null }[], names: Map<string, { id: string; name: string }>, thisName: string, byId?: true): Required<SplitPart>[];
export function splitSummary(split: { buffer: string; mb: number | null }[], names: Map<string, string | { id: string; name: string }>, thisName: string, ids?: true): SplitPart[] {
  const byId = !!ids || Array.from(names.values()).some((v) => typeof v !== 'string');
  const by = new Map<string, SplitPart & { mb: number }>();
  for (const s of split) {
    const m = s.buffer.match(/^RPC\d+\[([^\]]+)\]/);
    const n = m ? names.get(m[1]) ?? m[1] : null;
    const part: Omit<SplitPart, 'gb'> = !byId
      ? { name: n === null ? thisName : (n as string) }
      : n === null ? { id: 'local', name: thisName, local: true }
      : typeof n === 'string' ? { id: n, name: n, local: false }
      : { id: n.id, name: n.name, local: false };
    const key = byId ? part.id! : part.name;
    const had = by.get(key);
    by.set(key, { ...part, gb: 0, mb: (had?.mb ?? 0) + (s.mb ?? 0) });
  }
  return Array.from(by.values(), ({ mb, ...p }) => ({ ...p, gb: Math.round(mb / 102.4) / 10 })).sort((a, b) => b.gb - a.gb);
}

/** How the bench history names a model: its id, or its file and size (docs/BENCH.md). */
export const modelKey = (m: Pick<LocalModel, 'id' | 'file' | 'size'>) => ({ id: m.id, file: m.file, size: m.size });

/** Peers to try for a mode: all saved ones; the probe decides. */
export const candidates = () => savedPeers();
