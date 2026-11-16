import type { AddrVia, AnchorRoad, Peer, PeerAddr, PeerAnchor, Road } from '@/llm/store';

// Roads (docs/ANCHOR.md, 16.11.2026): the ways from this phone to a device's gate, and which one
// to keep. node/src/road.ts is the computer's twin; the order and the timing are the same:
//   1. host/port (the same wi-fi, which nsd keeps current),
//   2. the code's `addrs` (a global ipv6 address, a router's mapped port: over the internet),
//   3. the anchors (the ones the device's code names, then the ones this phone joined).
// The tries start ROAD_STAGGER_MS apart in that order, a failed try starts the next at once, and
// the earliest in order among the ones that answered wins. Every try is the full gate handshake
// with the pinned certificate, so a road is only a hint and never vouches for anyone: whoever
// answers with another certificate fails. An anchor is reached at its own address, never through
// another anchor, and a phone is never an anchor. A device far away through the hosted relay keeps
// its one way and stays out of split; a device reached through an anchor takes part in both modes.
// Nothing here imports the native module: the probe is handed in (cluster.ts probeAll).

export const ROAD_STAGGER_MS = 250;
export const MAX_ADDRS = 8;
export const MAX_ANCHORS = 4;
const VIAS: AddrVia[] = ['lan', 'ipv6', 'mapped'];
const FP = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An ip literal (v4 or v6, brackets taken off), lower case; '' for anything else (no name is ever looked up). */
export function ipOf(h: unknown): string {
  if (typeof h !== 'string') return '';
  const s = h.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s)) return s;
  if (s.includes(':') && s.length <= 45 && /^[0-9a-f:.]+$/.test(s) && (s.match(/::/g) ?? []).length <= 1) return s;
  return '';
}
const portOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0;
};

/** What kind of address a bare host is: a global ipv6 literal 'ipv6', a private or loopback ipv4 'lan', another ipv4 'mapped'. */
export function addrKind(host: string): AddrVia {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h.includes(':')) return /^[23][0-9a-f]{0,3}:/.test(h) ? 'ipv6' : 'lan';
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || !h) return 'lan';
  return 'mapped';
}

/** A code's `addrs`, kept only where each is an ip literal, a port and a known kind; a bad entry is dropped, not the peer. */
export function cleanAddrs(x: unknown): PeerAddr[] {
  if (!Array.isArray(x)) return [];
  const out: PeerAddr[] = [];
  for (const a of x.slice(0, MAX_ADDRS * 2)) {
    if (!isObj(a)) continue;
    const host = ipOf(a.host);
    const port = portOf(a.port);
    if (!host || !port || !VIAS.includes(a.via as AddrVia) || out.some((o) => o.host === host && o.port === port)) continue;
    out.push({ host, port, via: a.via as AddrVia });
    if (out.length >= MAX_ADDRS) break;
  }
  return out;
}

/** A code's `anchors`, kept only where each is a full fingerprint, an ip literal and a port. */
export function cleanAnchors(x: unknown): PeerAnchor[] {
  if (!Array.isArray(x)) return [];
  const out: PeerAnchor[] = [];
  for (const a of x.slice(0, MAX_ANCHORS * 2)) {
    if (!isObj(a)) continue;
    const fp = typeof a.fp === 'string' ? a.fp.toLowerCase() : '';
    const host = ipOf(a.host);
    const port = portOf(a.port);
    if (!FP.test(fp) || !host || !port || out.some((o) => o.fp === fp)) continue;
    const name = typeof a.name === 'string' ? a.name.replace(/[\u0000-\u001f]/g, '').slice(0, 40) : '';
    out.push({ fp, host, port, ...(name ? { name } : {}) });
    if (out.length >= MAX_ANCHORS) break;
  }
  return out;
}

export const isAnchorRoad = (r: Road | null | undefined): r is AnchorRoad => !!r && r.via === 'anchor';

/** A stored road, checked like everything stored (store.ts healPeers); null when it is not one. */
export function cleanRoad(x: unknown): Road | null {
  if (!isObj(x)) return null;
  const host = ipOf(x.host);
  const port = portOf(x.port);
  if (!host || !port) return null;
  if (x.via === 'anchor') {
    const fp = typeof x.anchor === 'string' ? x.anchor.toLowerCase() : '';
    if (!FP.test(fp)) return null;
    const name = typeof x.name === 'string' ? x.name.replace(/[\u0000-\u001f]/g, '').slice(0, 40) : '';
    return { via: 'anchor', anchor: fp, host, port, ...(name ? { name } : {}) };
  }
  return VIAS.includes(x.via as AddrVia) ? { host, port, via: x.via as AddrVia } : null;
}

export const sameRoad = (a: Road | null | undefined, b: Road | null | undefined): boolean => {
  if (!a || !b) return a === b;
  if (isAnchorRoad(a) || isAnchorRoad(b)) return isAnchorRoad(a) && isAnchorRoad(b) && a.anchor === b.anchor;
  return a.host === b.host && a.port === b.port;
};

/** The anchors that may carry a stream to this device: its own code's, then the ones this phone joined; never the device itself. */
export function anchorsOf(p: Pick<Peer, 'fp' | 'anchors'>, mine: PeerAnchor[] = []): PeerAnchor[] {
  const me = p.fp?.toLowerCase();
  const out: PeerAnchor[] = [];
  for (const a of [...(p.anchors ?? []), ...mine]) {
    const fp = a.fp.toLowerCase();
    if (fp === me || out.some((o) => o.fp === fp)) continue;
    out.push({ ...a, fp });
  }
  return out;
}

/**
 * Every road to try, in order: host/port, the code's addrs, then the anchors. A relayed peer has
 * its relay only (none here); a device without a pinned certificate has its addresses only (an
 * anchor dials by certificate).
 */
export function roadsOf(p: Pick<Peer, 'host' | 'port' | 'addrs' | 'anchors' | 'fp' | 'relay'>, mine: PeerAnchor[] = []): Road[] {
  if (p.relay) return [];
  const out: Road[] = [];
  const add = (a: PeerAddr) => { if (a.host && a.port && !out.some((o) => !isAnchorRoad(o) && o.host === a.host && o.port === a.port)) out.push(a); };
  if (p.host && p.port) add({ host: p.host, port: p.port, via: addrKind(p.host) });
  for (const a of p.addrs ?? []) add(a);
  if (!p.fp) return out;
  for (const a of anchorsOf(p, mine)) out.push({ via: 'anchor', anchor: a.fp, host: a.host, port: a.port, ...(a.name ? { name: a.name } : {}) });
  return out;
}

/** The road a connection takes now: the one the last probe kept, else host/port. */
export const roadOf = (p: Pick<Peer, 'host' | 'port' | 'route'>): Road => p.route ?? { host: p.host, port: p.port, via: addrKind(p.host) };

/** What the native side needs for a road: the address to dial, or the anchor ({host, port, fp}) to go through. */
export function roadArgs(p: Pick<Peer, 'host' | 'port' | 'route'>): { host: string; port: number; anchor: { host: string; port: number; fp: string } | null } {
  const r = roadOf(p);
  // through an anchor the device's own address is not dialed: its record's stays for the wi-fi
  if (isAnchorRoad(r)) return { host: p.host, port: p.port, anchor: { host: r.host, port: r.port, fp: r.anchor } };
  return { host: r.host, port: r.port, anchor: null };
}

/** null when the device answered on that road with its pinned certificate; otherwise why not. */
export type RoadProbe = (road: Road) => Promise<string | null>;

/**
 * The road to keep (node/src/road.ts pickRoute): the tries start `staggerMs` apart in order, a
 * failed one lets the next start at once, and the earliest in order among those that answered
 * wins. `why` is the first road's reason when none did. A device that still has an unspent
 * pairing code is tried one road at a time: two tries at once would race for the one code.
 */
export function pickRoad(list: Road[], probe: RoadProbe, opts: { staggerMs?: number; serial?: boolean } = {}): Promise<{ road: Road | null; why: string | null }> {
  if (!list.length) return Promise.resolve({ road: null, why: 'no road' });
  const stagger = opts.staggerMs ?? ROAD_STAGGER_MS;
  return new Promise((resolve) => {
    const state: ('wait' | 'run' | 'ok' | 'no')[] = list.map(() => 'wait');
    const whys: (string | null)[] = list.map(() => null);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let done = false;
    const finish = (road: Road | null, why: string | null) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      resolve({ road, why });
    };
    const start = (i: number) => {
      if (done || state[i] !== 'wait') return;
      state[i] = 'run';
      probe(list[i]).catch((e: Error) => e?.message ?? 'failed').then((why) => {
        state[i] = why ? 'no' : 'ok';
        whys[i] = why;
        if (done) return;
        // the earliest in order among the roads that answered by now (on the wi-fi the lan answers
        // long before the second try starts)
        const won = state.indexOf('ok');
        if (won >= 0) return finish(list[won], null);
        if (state.every((s) => s === 'no')) return finish(null, whys.find((w) => w) ?? 'unreachable');
        // a road that failed lets the next one start now instead of at its time
        const next = state.indexOf('wait');
        if (next >= 0) start(next);
      });
    };
    start(0);
    if (!opts.serial) for (let i = 1; i < list.length; i++) timers.push(setTimeout(() => start(i), i * stagger));
  });
}

/** How a device is reached now, as a key for the words: on this wi-fi, over the internet, through an anchor, through the relay. */
export type ReachedBy = 'wifi' | 'internet' | 'anchor' | 'relay';
export function reachedBy(p: Pick<Peer, 'host' | 'relay' | 'route'>): ReachedBy {
  if (p.relay) return 'relay';
  const r = roadOf({ host: p.host, port: 0, route: p.route });
  if (isAnchorRoad(r)) return 'anchor';
  return r.via === 'lan' ? 'wifi' : 'internet';
}
/** The anchor's name on an anchor road (its own name, else the first 8 hex of its certificate). */
export const anchorName = (r: Road | null | undefined): string | null => (isAnchorRoad(r) ? r.name || `${r.anchor.slice(0, 8)}…` : null);
