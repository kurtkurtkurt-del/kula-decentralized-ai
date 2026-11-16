import { deviceId, lastPassport, linkPassport } from '@/data/passport';
import type { Passport } from '@/passport/contract';
import { GATE_PORT, llama, type AnchorWhose } from '@/llm/native';
import { cleanName } from '@/llm/peerName';
import { randomHex } from '@/llm/random';
import { addrKind, cleanAddrs, cleanAnchors, ipOf } from '@/llm/roads';
import { forgetPeer, rememberPeer, saveShare, settings, share, touchPeer, type Peer, type PeerAddr, type PeerAnchor } from '@/llm/store';

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
  // anchors (docs/ANCHOR.md, 16.11.2026), v3 only: more ways to the same gate (a global ipv6
  // address, a router's mapped port), the anchors it registers with, and for an anchor's invite
  // `anchor: true` with a second one-time code `hpin` (the anchor pairs back with it)
  addrs?: PeerAddr[];
  anchors?: PeerAnchor[];
  anchor?: boolean;
  hpin?: string;
  kind: 'phone' | 'tablet' | 'pc';
  ram?: number | null;
  bw?: number | null;
  passport?: Passport | null;
};

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`, 'i');
const PIN = /^[0-9a-f]{8,64}$/i;
const CODE = /^(\d{6})(?:[\s-]+([0-9a-fA-F]{8,64}))?$/;
const isRelayRef = (r: unknown): r is { url: string; code: string } =>
  !!r && typeof r === 'object' && /^(wss?|https?):\/\//i.test(String((r as { url?: unknown }).url ?? '')) && /^\d{6}$/.test(String((r as { code?: unknown }).code ?? ''));
/** "https://relay.example" pasted for a relay becomes "wss://relay.example". */
export const relayUrlOf = (url: string) => url.trim().replace(/^http(s?):\/\//i, 'ws$1://');

// kula-node prints a code as one pasteable line: the qr's json as base64url (node/src/peers.ts
// peerCode), an anchor's invite included. Decoded here by hand: no Buffer in the app.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function fromBase64Url(s: string): string | null {
  const t = s.trim().replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!/^[A-Za-z0-9_-]+$/.test(t) || t.length % 4 === 1) return null;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of t) {
    acc = (acc << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  // utf-8 by hand (names may carry any letter)
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    const n = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
    if (!n || i + n > bytes.length) return null;
    let cp = n === 1 ? b : b & (0xff >> (n + 1));
    for (let k = 1; k < n; k++) cp = (cp << 6) | (bytes[i + k] & 0x3f);
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

/** The json of a code: the qr's text itself, or a base64url line of it (kula-node, an anchor's invite). */
function codeJson(text: string): unknown {
  const raw = text.trim();
  if (raw.startsWith('{')) return JSON.parse(raw);
  if (raw.length > 40 && /^[A-Za-z0-9_-]+=*$/.test(raw)) {
    const s = fromBase64Url(raw);
    if (s?.startsWith('{')) return JSON.parse(s);
  }
  throw new Error('notPeer');
}

export function isPeerQr(text: string): boolean {
  try {
    const o = codeJson(text) as Record<string, unknown> | null;
    const addrs = cleanAddrs(o?.addrs);
    return !!o && o.k === 'kula-peer' && (typeof o.host === 'string' || isRelayRef(o.relay) || (o.v === 3 && addrs.length > 0)) && (typeof o.secret === 'string' || typeof o.fp === 'string');
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

// cleanName and peerName live in peerName.ts (store.ts heals names with them); still read from here
export { cleanName, peerName } from '@/llm/peerName';

/** Parses a peer qr into a Peer (nothing stored). Throws 'notPeer' | 'self' | 'old'. An anchor's invite comes back with `anchor: true` and its `hpin` (isInvite). */
export function parsePeerQr(text: string): Peer & { hpin?: string } {
  let o: PeerQr;
  try {
    o = codeJson(text) as PeerQr;
  } catch {
    throw new Error('notPeer');
  }
  if (!o || o.k !== 'kula-peer') throw new Error('notPeer');
  if (o.v !== 2 && o.v !== 3) throw new Error('old');
  const relay = isRelayRef(o.relay) ? { url: relayUrlOf(o.relay.url), code: o.relay.code } : null;
  // a code is only json: id and host are strings or the code is refused, and the name is read
  // only when it is a string (the brain tab lower-cases it on every draw)
  if (typeof o.id !== 'string' || o.id.length < 1 || o.id.length > 200) throw new Error('notPeer');
  // more ways and the anchors it registers with: v3 only (a stream through an anchor needs a pinned certificate)
  const addrs = o.v === 3 ? cleanAddrs(o.addrs) : [];
  const anchors = o.v === 3 ? cleanAnchors(o.anchors) : [];
  // a code with addrs only: the first one is host/port
  let host = typeof o.host === 'string' ? o.host : '';
  let port = Number(o.port) || 0;
  if (!host && addrs.length) { host = addrs[0].host; port = addrs[0].port; }
  if (!relay && (!host || !port)) throw new Error('notPeer');
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
  const anchor = o.v === 3 && o.anchor === true;
  const hpin = anchor && typeof o.hpin === 'string' && PIN.test(o.hpin) ? o.hpin.toLowerCase() : null;
  return {
    id: o.id, name: cleanName(typeof o.name === 'string' ? o.name : '').slice(0, 80) || host || `code ${relay?.code}`, host, port, secret, fp, pin, paired_at: null, relay,
    ...(addrs.length ? { addrs } : {}),
    ...(anchors.length ? { anchors } : {}),
    ...(anchor ? { anchor: true } : {}),
    ...(hpin ? { hpin } : {}),
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

/** Parses and remembers a peer qr; links its passport too. Throws 'notPeer' | 'self' | 'old', and 'invite' for an anchor's invite (joinInvite takes those). */
export function takePeerQr(text: string): Peer {
  const { hpin: _hpin, ...peer } = parsePeerQr(text);
  // an invite spent as a plain pairing would pair without joining (no registration, no pair-back)
  if (peer.anchor && peer.pin) throw new Error('invite');
  rememberPeer(peer);
  if (peer.passport) {
    try {
      linkPassport(JSON.stringify(peer.passport));
    } catch {}
  }
  return peer;
}

// ---- an anchor's invite (docs/ANCHOR.md "join") -------------------------------------------
//
// The anchor's kula-peer v3 code with `anchor: true`, a one-time code `pin` and a second one
// `hpin`; or typed: its address, the code and the first 16 hex (or more) of its certificate,
// "203.0.113.5:50551 0123456789abcdef 9f86d081884c7d65". The phone pairs with the anchor's gate
// with `pin` (natively, KulaLlamaModule joinAnchor), keeps it in the store of joined anchors and
// as a peer, and while "share this phone" runs it registers there; the anchor then pairs back
// with `hpin` (derived from `pin` for a typed invite), for this phone's gate only.

export type Invite = { fp: string; fpPrefix: string | null; pin: string; hpin: string | null; name: string; ways: PeerAddr[]; peer: Peer };
const TYPED = /^(\[[^\]]+\]|[^\s:[\]]+):(\d{1,5})[\s,]+([0-9a-f]{8,64})[\s,]+([0-9a-f]{16,64})$/i;

/** Is this text an anchor's invite (a code with anchor and pin, or the typed form)? */
export function isInvite(text: string): boolean {
  try {
    return !!parseInvite(text);
  } catch {
    return false;
  }
}

/** Reads an anchor's invite; null when the text is not one. Throws 'notPeer' for a typed one with a bad address. */
export function parseInvite(text: string): Invite | null {
  const raw = text.trim();
  const m = TYPED.exec(raw);
  if (m) {
    const host = ipOf(m[1]);
    const port = Number(m[2]);
    if (!host || port < 1 || port > 65535) throw new Error('notPeer');
    const way: PeerAddr = { host, port, via: addrKind(host) };
    const pin = m[3].toLowerCase();
    const prefix = m[4].toLowerCase();
    return {
      fp: '', fpPrefix: prefix, pin, hpin: null, name: `anchor ${prefix.slice(0, 8)}`, ways: [way],
      peer: { id: `anchor:${prefix.slice(0, 16)}`, name: `anchor ${prefix.slice(0, 8)}`, host, port, secret: '', fp: null, pin: null, paired_at: null, relay: null, anchor: true, kind: 'pc', ram: null, bw: null, passport: null, added_at: new Date().toISOString(), last_ok: null },
    };
  }
  if (!isPeerQr(raw)) return null;
  const { hpin, ...peer } = parsePeerQr(raw);
  if (!peer.anchor || !peer.pin || !peer.fp) return null;
  const ways: PeerAddr[] = [];
  for (const w of [{ host: peer.host, port: peer.port, via: addrKind(peer.host) }, ...(peer.addrs ?? [])]) {
    if (w.host && w.port && !ways.some((o) => o.host === w.host && o.port === w.port)) ways.push(w);
  }
  return { fp: peer.fp, fpPrefix: null, pin: peer.pin, hpin: hpin ?? null, name: peer.name, ways, peer: { ...peer, pin: null } };
}

export type Joined = { name: string; again: boolean; sharing: boolean; peer: Peer };

/**
 * Joins the anchor of an invite: pairs with it (native), keeps it in the store of joined anchors
 * and as a peer (pinned, paired, an anchor, reached at the address that answered). Throws the
 * anchor's refusal in plain words, or 'nonative' | 'notPeer'. [whose]: the person's answer before
 * joining, their own computer or a friend's; kept with the anchor, it decides whether that computer
 * may lose an idle rpc seat to the person's own devices (security review D4 #10).
 */
export async function joinInvite(text: string, whose: AnchorWhose): Promise<Joined> {
  const inv = parseInvite(text);
  if (!inv) throw new Error('notPeer');
  if (!llama?.joinAnchor) throw new Error('nonative');
  const r = await llama.joinAnchor({ fp: inv.fp, fpPrefix: inv.fpPrefix, pin: inv.pin, hpin: inv.hpin, name: inv.name, ways: inv.ways, whose });
  const first = inv.ways[0];
  const at: PeerAddr = { host: r.host, port: r.port, via: (r.via as PeerAddr['via']) ?? addrKind(r.host) };
  const now = new Date().toISOString();
  const peer: Peer = {
    ...inv.peer, fp: r.fp, pin: null, paired_at: now, last_ok: now, anchor: true, kind: 'pc',
    name: inv.peer.name || r.name,
    route: at.host === first.host && at.port === first.port ? null : at,
  };
  rememberPeer(peer);
  return { name: r.name, again: r.again, sharing: r.sharing, peer };
}

/**
 * Forgets a device row (× in connected devices). An anchor's row also leaves the anchor natively,
 * and that takes away the access its pair-back gave the anchor's computer to this phone (security
 * review D4 #16): its next connection hears "not paired". The row stays when leaving fails.
 */
export async function forgetPeerRow(p: Peer): Promise<void> {
  if (p.anchor && p.fp && llama?.forgetAnchor) await llama.forgetAnchor(p.fp);
  forgetPeer(p.id);
}

/** The anchors this phone joined, as roads for every device (none without the native module). */
export async function myAnchors(): Promise<PeerAnchor[]> {
  if (!llama?.joinedAnchors) return [];
  const list = await llama.joinedAnchors().catch(() => []);
  return cleanAnchors((list ?? []).map((a) => ({ fp: a.fp, host: a.host, port: a.port, name: a.name })));
}

let myWorkerId: string | null = null;
export const setMyWorkerId = (id: string) => (myWorkerId = id);

/** The qr text for this device: v3 when it has a certificate fingerprint, else v2 with the secret (and never a relay: that needs tls). */
export function makePeerQr(p: Omit<PeerQr, 'k' | 'v'>): string {
  const q: PeerQr = p.fp
    ? { k: 'kula-peer', v: 3, ...p, secret: undefined, relay: p.relay ?? undefined }
    : { k: 'kula-peer', v: 2, ...p, fp: undefined, pin: undefined, relay: undefined, addrs: undefined, anchors: undefined, anchor: undefined, hpin: undefined };
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
  // the anchors this phone registers with: a device that pairs with it here can reach it through
  // them later, away from this wi-fi (docs/ANCHOR.md); only with tls (v3)
  const anchors = live ? await myAnchors() : [];
  const qr = makePeerQr({
    id: info.workerId, name: s.name, host: info.wifiIp ?? '0.0.0.0', port: s.port,
    secret: s.secret, fp: live?.fp ?? undefined, pin: live?.pin ?? null,
    // the relay code, once the worker has registered (worker status carries it)
    relay: live?.relay ?? null,
    ...(anchors.length ? { anchors } : {}),
    kind: p?.kind === 'tablet' ? 'tablet' : 'phone', ram: info.ramFreeMb, bw: p ? Number(p.mem_bw_read_gbs) || Number(p.mem_bw_gbs) || null : null,
    passport: p ? ({ ...p, device_id: p.device_id ?? deviceId() } as Passport) : null,
  });
  return { qr, share: s };
}
