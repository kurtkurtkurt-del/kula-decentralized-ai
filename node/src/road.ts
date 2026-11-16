// Roads (docs/ANCHOR.md, stage 3): the ways from this computer to a device's gate. A road is an
// address (its lan address, a global ipv6 address, the port its router mapped: peers.ts PeerAddr)
// or a stream through an anchor of the circle, `{via:'anchor', anchor:<fp>}`, or through this
// computer's own anchor, `{via:'anchor', anchor:'self'}` (a device registered here is one hop
// away, in-process). Whatever the road, the gate handshake inside is the same: TLS between the two
// devices' certificates, pinned, so a road is only a hint and never vouches for anyone.
//
// Order of tries: host/port, then the record's addrs, then the anchors (this computer's own first,
// then the ones the record names, then the ones this computer is registered with). They start
// ROAD_STAGGER_MS apart and the first that shows the pinned certificate wins; a try that fails
// lets the next start at once. On the lan the lan address answers long before the next try
// starts, so a device back home is reached by its lan address again. An anchor is reached at its
// own address, never through another anchor.
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { connectRemote, peekOver, GateRefused, HANDSHAKE_MS, TOO_MANY_DIALS, type Dialer, type GatePeek } from './gate.js';
import { dialAnchor, FP_RE } from './anchor.js';
import { addrKind, candidates, type Peer, type PeerAddr } from './peers.js';
import type { GateIdentity } from './tls.js';

export interface AnchorRoad { via: 'anchor'; anchor: string }   // a 64-hex fingerprint, or 'self'
export type Road = PeerAddr | AnchorRoad;

// An anchor a device registers with (or this computer does): its certificate and its address.
export interface PeerAnchor { fp: string; host: string; port: number; name?: string }
export const MAX_ANCHORS = 4;

// This computer's own anchor, when share runs with it on (AnchorHub fits).
export interface LocalAnchor {
  members(): { fp: string }[];
  dialLocal(to: string): Promise<Duplex>;
}

export interface RoadContext {
  identity: GateIdentity;
  hub?: LocalAnchor | null;          // this computer's anchor: 'self' roads
  anchors?: PeerAnchor[];            // the anchors this computer is registered with
  // tests: replaces the tcp connect to an address (a delay proxy, a counter)
  connect?: (host: string, port: number, timeoutMs: number) => Promise<Duplex>;
}

export const ROAD_STAGGER_MS = 250;

export const isAnchorRoad = (r: Road | null | undefined): r is AnchorRoad => !!r && r.via === 'anchor';
export const sameRoad = (a: Road | null | undefined, b: Road | null | undefined): boolean => {
  if (!a || !b) return a === b;
  if (isAnchorRoad(a) || isAnchorRoad(b)) return isAnchorRoad(a) && isAnchorRoad(b) && a.anchor === b.anchor;
  return a.host === b.host && a.port === b.port;
};
// a context from a bare identity (the callers from before roads)
export const roadContext = (x: GateIdentity | RoadContext): RoadContext => ('keyPem' in x ? { identity: x } : x);

// The anchors of a record, kept only where each is a full fingerprint, an ip literal and a port;
// a bad entry is dropped, not the peer. Names are not looked up.
export function cleanAnchors(x: unknown): PeerAnchor[] {
  if (!Array.isArray(x)) return [];
  const out: PeerAnchor[] = [];
  for (const a of x.slice(0, MAX_ANCHORS * 2)) {
    if (!a || typeof a !== 'object') continue;
    const fp = typeof a.fp === 'string' ? a.fp.toLowerCase() : '';
    const host = typeof a.host === 'string' ? a.host.replace(/^\[|\]$/g, '').toLowerCase() : '';
    const port = Number(a.port);
    if (!FP_RE.test(fp) || !net.isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (out.some((o) => o.fp === fp)) continue;
    const name = typeof a.name === 'string' ? a.name.replace(/[\u0000-\u001f]/g, '').slice(0, 40) : '';
    out.push({ fp, host, port, ...(name ? { name } : {}) });
    if (out.length >= MAX_ANCHORS) break;
  }
  return out;
}

// The anchors that may carry a stream to this device: the ones its record names, then the ones
// this computer is registered with; never the device itself, never this computer (that is 'self').
export function anchorsOf(p: Pick<Peer, 'fp' | 'anchors'>, ctx?: RoadContext | null): PeerAnchor[] {
  const own = ctx?.identity.fp.toLowerCase();
  const me = p.fp?.toLowerCase();
  const out: PeerAnchor[] = [];
  for (const a of [...(p.anchors ?? []), ...(ctx?.anchors ?? [])]) {
    const fp = a.fp.toLowerCase();
    if (fp === me || fp === own || out.some((o) => o.fp === fp)) continue;
    out.push({ ...a, fp });
  }
  return out;
}

// Every road to try, in order. A cable or a relay has its one way; a device without a pinned
// certificate has its addresses only (an anchor dials by certificate).
export function roads(p: Peer, ctx?: RoadContext | null): Road[] {
  const out: Road[] = [...candidates(p)];
  if (!ctx || !p.fp || p.cable || p.relay) return out;
  const fp = p.fp.toLowerCase();
  if (ctx.hub?.members().some((m) => m.fp === fp)) out.push({ via: 'anchor', anchor: 'self' });
  for (const a of anchorsOf(p, ctx)) out.push({ via: 'anchor', anchor: a.fp });
  return out;
}

// A connected duplex to the device's gate along the road, ready for the gate handshake: a tcp
// socket for an address, a stream through a remote anchor (dialAnchor; the anchor is reached at
// its own address), or the in-process hop through this computer's anchor (dialLocal).
export async function openRoad(road: Road, p: Pick<Peer, 'fp' | 'anchors'>, ctx: RoadContext, timeoutMs = HANDSHAKE_MS): Promise<Duplex> {
  if (!isAnchorRoad(road)) {
    const s = await (ctx.connect ?? connectRemote)(road.host, road.port, timeoutMs);
    if (s instanceof net.Socket) s.setNoDelay(true);
    return s;
  }
  if (!p.fp) throw new GateRefused('an anchor dials by certificate: this device has none pinned');
  if (road.anchor === 'self') {
    if (!ctx.hub) throw new GateRefused('this computer is not an anchor now');
    return ctx.hub.dialLocal(p.fp);
  }
  const ref = anchorsOf(p, ctx).find((a) => a.fp === road.anchor);
  if (!ref) throw new GateRefused('anchor not known');
  const connect = ctx.connect;
  return dialAnchor({ host: ref.host, port: ref.port, fp: ref.fp, ...(connect ? { connect: () => connect(ref.host, ref.port, timeoutMs) } : {}) }, ctx.identity, p.fp, timeoutMs);
}

export type PeekFn = (road: Road, p: Peer, ctx: RoadContext, timeoutMs: number) => Promise<GatePeek>;

// What the gate at the end of the road shows (peekGate over the road): its certificate and
// whether it knows us. Nothing is proven or spent.
export const peekRoad: PeekFn = (road, p, ctx, timeoutMs) => peekOver(() => openRoad(road, p, ctx, timeoutMs), ctx.identity, timeoutMs);

// The road to keep: tries start `staggerMs` apart in order (a failed one starts the next at once),
// and the first whose gate shows the pinned certificate wins. null: none did. Only for a device
// with a pinned fingerprint: without one there is nothing to tell this device from another.
export async function pickRoute(p: Peer, who: GateIdentity | RoadContext, timeoutMs = 2000, peek: PeekFn = peekRoad, staggerMs = ROAD_STAGGER_MS): Promise<Road | null> {
  if (!p.fp) return null;
  const ctx = roadContext(who);
  const list = roads(p, ctx);
  if (!list.length) return null;
  const want = p.fp.toLowerCase();
  return new Promise<Road | null>((resolve) => {
    const state: ('wait' | 'run' | 'ok' | 'no')[] = list.map(() => 'wait');
    const timers: NodeJS.Timeout[] = [];
    let done = false;
    const finish = (r: Road | null) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      resolve(r);
    };
    const start = (i: number) => {
      if (done || state[i] !== 'wait') return;
      state[i] = 'run';
      peek(list[i], p, ctx, timeoutMs).catch((): GatePeek => ({ up: false, reason: 'failed' })).then((r) => {
        state[i] = r.up && r.fp.toLowerCase() === want ? 'ok' : 'no';
        if (done) return;
        // the earliest in order among the ways that answered by now
        const won = state.indexOf('ok');
        if (won >= 0) return finish(list[won]);
        if (state.every((s) => s === 'no')) return finish(null);
        // a way that failed lets the next one start now instead of at its time
        const next = state.indexOf('wait');
        if (next >= 0) start(next);
      });
    };
    start(0);
    for (let i = 1; i < list.length; i++) timers.push(setTimeout(() => start(i), i * staggerMs));
  });
}

// How a device is reached, in the plan's words: the same wi-fi, the internet, or an anchor.
export function roadWords(p: Pick<Peer, 'cable' | 'relay' | 'route' | 'host' | 'anchors'>, anchorName?: (fp: string) => string | null | undefined): string {
  if (p.cable) return 'on the usb cable';
  if (p.relay) return 'through the relay';
  const r = p.route;
  if (isAnchorRoad(r)) {
    if (r.anchor === 'self') return 'through this computer (its anchor)';
    const name = anchorName?.(r.anchor) ?? p.anchors?.find((a) => a.fp === r.anchor)?.name;
    return `through anchor ${name || `${r.anchor.slice(0, 8)}…`}`;
  }
  return (r?.via ?? addrKind(p.host)) === 'lan' ? 'same wi-fi' : 'over the internet';
}

export interface RoadDialer extends Dialer { road(): Road }

// The dialer a tunnel to this device uses (Tunnel.over): along its road (the route the last pick
// kept, else host/port). A road that does not open, or a connection on it that did not get
// through (Tunnel calls `failed`), makes it pick again (pickRoute) before the next one; the new
// road is told to `onRoute`. A device without a pinned certificate is never re-picked.
export function roadDialer(p: Peer, who: GateIdentity | RoadContext, opts: { timeoutMs?: number; pickMs?: number; onRoute?: (r: Road) => void; peek?: PeekFn } = {}): RoadDialer {
  const ctx = roadContext(who);
  let road: Road = p.route ?? candidates(p)[0];
  let stale = false;
  const timeoutMs = opts.timeoutMs ?? HANDSHAKE_MS;
  const repick = async (): Promise<boolean> => {
    const r = await pickRoute(p, ctx, opts.pickMs ?? 2000, opts.peek);
    if (!r) return false;
    const changed = !sameRoad(r, road);
    road = r;
    if (changed) opts.onRoute?.(r);
    return changed;
  };
  const open = async (): Promise<Duplex> => {
    if (stale && p.fp) { stale = false; await repick().catch(() => false); }
    try {
      return await openRoad(road, p, ctx, timeoutMs);
    } catch (e) {
      // the anchor's "too many dials" is a wait, not a broken road (Tunnel waits); a pick would
      // only spend more dials on the same anchor
      if (e instanceof GateRefused && e.reason === TOO_MANY_DIALS) throw e;
      if (!p.fp || !(await repick().catch(() => false))) throw e;
      return openRoad(road, p, ctx, timeoutMs);
    }
  };
  return Object.assign(open, { failed: () => { stale = true; }, road: () => road });
}
