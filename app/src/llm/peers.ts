import { deviceId, lastPassport, linkPassport } from '@/data/passport';
import type { Passport } from '@/passport/contract';
import { GATE_PORT, llama } from '@/llm/native';
import { randomHex } from '@/llm/random';
import { rememberPeer, saveShare, settings, share, touchPeer, type Peer } from '@/llm/store';

// The peer qr: what a shared phone or a computer shows, and what the master scans. It
// carries the gate address and what the first connection needs, and the device's passport
// when it has one, so the together page knows the device too. Two versions read:
//   v2 (4.11.2026): `secret`, the shared key of the plain handshake (gate protocol v1).
//   v3 (5.11.2026): `fp`, the worker's certificate fingerprint the master pins, and `pin`,
//   a one-time pairing code; the connection is tls (gate protocol v2, docs/GATE.md).
//   v3 may also carry `relay: {url, code}` (5.11.2026): the worker is reachable through that
//   relay with that six digit code, from anywhere (docs/RELAY.md); host/port may be useless then.
// A v3 worker still answers v1 clients, so an old master can keep a v2 qr of the same
// device. The old passport-only qr still reads too (data/passport.ts linkPassport).
export type PeerQr = {
  k: 'kula-peer';
  v: 2 | 3;
  id: string;
  name: string;
  host: string;
  port: number;
  secret?: string;
  fp?: string;
  pin?: string | null;
  relay?: { url: string; code: string } | null;
  kind: 'phone' | 'tablet' | 'pc';
  ram?: number | null;
  bw?: number | null;
  passport?: Passport | null;
};

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`, 'i');
const CODE = /^(\d{6})(?:[\s-]+([0-9a-fA-F]{8,64}))?$/;
const isRelayRef = (r: unknown): r is { url: string; code: string } =>
  !!r && typeof r === 'object' && /^(wss?|https?):\/\//i.test(String((r as { url?: unknown }).url ?? '')) && /^\d{6}$/.test(String((r as { code?: unknown }).code ?? ''));
/** "https://relay.example" pasted for a relay becomes "wss://relay.example". */
export const relayUrlOf = (url: string) => url.trim().replace(/^http(s?):\/\//i, 'ws$1://');

export function isPeerQr(text: string): boolean {
  try {
    const o = JSON.parse(text);
    return !!o && o.k === 'kula-peer' && (typeof o.host === 'string' || isRelayRef(o.relay)) && (typeof o.secret === 'string' || typeof o.fp === 'string');
  } catch {
    return false;
  }
}

/** Is this a relay code typed by hand: six digits, maybe followed by the pairing code? */
export const isRelayCode = (text: string): boolean => CODE.test(text.trim());

/** A peer far away is reached through a relay; only apart mode can use it (docs/RELAY.md). */
export const isRemote = (p: Pick<Peer, 'relay'>): boolean => !!p.relay;

/**
 * A relay code read out over the phone ("123456", or "123456 0123456789abcdef" with the
 * worker's pairing code): a peer with no address and no certificate yet. The relay comes from
 * the settings. The first connection learns the certificate; without the pairing code the
 * worker refuses unless it already paired this phone. Throws 'noRelay' | 'notPeer'.
 */
export function parseRelayCode(text: string, relayUrl = settings().relayUrl): Peer {
  const m = CODE.exec(text.trim());
  if (!m) throw new Error('notPeer');
  if (!relayUrl) throw new Error('noRelay');
  return {
    id: `relay:${m[1]}`, name: `code ${m[1]}`, host: '', port: 0, secret: '', fp: '', pin: m[2]?.toLowerCase() ?? null, paired_at: null,
    relay: { url: relayUrlOf(relayUrl), code: m[1] }, kind: 'phone', ram: null, bw: null, passport: null,
    added_at: new Date().toISOString(), last_ok: null,
  };
}

/** Parses a peer qr into a Peer (nothing stored). Throws 'notPeer' | 'self' | 'old'. */
export function parsePeerQr(text: string): Peer {
  let o: PeerQr;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('notPeer');
  }
  if (!o || o.k !== 'kula-peer') throw new Error('notPeer');
  if (o.v !== 2 && o.v !== 3) throw new Error('old');
  const relay = isRelayRef(o.relay) ? { url: relayUrlOf(o.relay.url), code: o.relay.code } : null;
  if (!o.id || (!relay && (!o.host || !o.port))) throw new Error('notPeer');
  // a relayed connection must be tls end to end: a v2 code (shared secret) is never relayed
  if (relay && o.v !== 3) throw new Error('notPeer');
  let secret = '';
  let fp: string | null = null;
  let pin: string | null = null;
  if (o.v === 3) {
    if (typeof o.fp !== 'string' || !HEX(64).test(o.fp)) throw new Error('notPeer');
    fp = o.fp.toLowerCase();
    pin = typeof o.pin === 'string' && o.pin.length >= 4 ? o.pin : null;
    secret = typeof o.secret === 'string' ? o.secret : '';
  } else {
    if (typeof o.secret !== 'string' || !/^[0-9a-f]{32,}$/i.test(o.secret)) throw new Error('notPeer');
    secret = o.secret;
  }
  if (o.id === myWorkerId) throw new Error('self');
  return {
    id: o.id, name: o.name || o.host || `code ${relay?.code}`, host: o.host ?? '', port: Number(o.port) || 0, secret, fp, pin, paired_at: null, relay,
    kind: o.kind === 'pc' || o.kind === 'tablet' ? o.kind : 'phone',
    ram: o.ram ?? null, bw: o.bw ?? null, passport: (o.passport as Record<string, unknown>) ?? null,
    added_at: new Date().toISOString(), last_ok: null,
  };
}

/**
 * What a successful v2 handshake teaches about a peer: its certificate (a code-only peer had
 * none) and that the pin is spent. Stored, so the next connection pins it and needs no pin.
 */
export function learnPeer(peer: Peer, fp: string | null): void {
  if (!fp && !peer.pin) return;
  touchPeer(peer.id, { ...(fp ? { fp } : {}), pin: null, paired_at: peer.paired_at ?? new Date().toISOString() });
}

/** Parses and remembers a peer qr; links its passport too. Throws 'notPeer' | 'self' | 'old'. */
export function takePeerQr(text: string): Peer {
  const peer = parsePeerQr(text);
  rememberPeer(peer);
  if (peer.passport) {
    try {
      linkPassport(JSON.stringify(peer.passport));
    } catch {}
  }
  return peer;
}

let myWorkerId: string | null = null;
export const setMyWorkerId = (id: string) => (myWorkerId = id);

/** The qr text for this device: v3 when it has a certificate fingerprint, else v2 with the secret (and never a relay: that needs tls). */
export function makePeerQr(p: Omit<PeerQr, 'k' | 'v'>): string {
  const q: PeerQr = p.fp
    ? { k: 'kula-peer', v: 3, ...p, secret: undefined, relay: p.relay ?? undefined }
    : { k: 'kula-peer', v: 2, ...p, fp: undefined, pin: undefined, relay: undefined };
  return JSON.stringify(q);
}

/**
 * This phone's own qr as a worker: a new secret the first time, kept until "stop sharing".
 * Once the worker runs it reports its certificate fingerprint and the open pairing code
 * (worker status), and the qr becomes v3; before that it is v2 with the secret.
 */
export async function myPeerQr(opts: { relay?: string | null } = {}): Promise<{ qr: string; share: { secret: string; name: string; port: number; relay?: string | null } }> {
  if (!llama) throw new Error('nonative');
  const info = await llama.info();
  myWorkerId = info.workerId;
  let s = share();
  if (!s) {
    s = { secret: randomHex(32), name: lastPassport()?.device ?? 'phone', port: GATE_PORT };
    saveShare(s);
  }
  if (opts.relay !== undefined && (s.relay ?? null) !== opts.relay) {
    s = { ...s, relay: opts.relay };
    saveShare(s);
  }
  const p = lastPassport();
  const status = await llama.workerStatus().catch(() => null);
  const live = status && (status.state === 'running' || status.state === 'starting') && status.fp ? status : null;
  const qr = makePeerQr({
    id: info.workerId, name: s.name, host: info.wifiIp ?? '0.0.0.0', port: s.port,
    secret: s.secret, fp: live?.fp ?? undefined, pin: live?.pin ?? null,
    // the relay code, once the worker has registered (worker status carries it)
    relay: live?.relay ?? null,
    kind: p?.kind === 'tablet' ? 'tablet' : 'phone', ram: info.ramFreeMb, bw: p ? Number(p.mem_bw_read_gbs) || Number(p.mem_bw_gbs) || null : null,
    passport: p ? ({ ...p, device_id: p.device_id ?? deviceId() } as Passport) : null,
  });
  return { qr, share: s };
}
