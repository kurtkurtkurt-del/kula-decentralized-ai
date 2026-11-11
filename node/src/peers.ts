// The peer book of a computer that runs a cluster: who the workers are, how to
// reach them and the secret each gate wants. Kept in ~/.kula-node/peers.json
// with mode 600, because the secrets are in it. Also: finding workers that
// announce themselves over mdns (_kula._tcp) and a short tcp + handshake probe.
import fs from 'node:fs';
import path from 'node:path';
import { Bonjour } from 'bonjour-service';
import { probe, type Channel, type ProbeResult, type TlsClient } from './gate.js';
import { probeRelay, CODE_RE, normalizeRelayUrl, type RelayRef } from './relay.js';
import type { GateIdentity } from './tls.js';
import { home } from './paths.js';
import { groupOf, groupPeers } from './ui/devices.js';

export type PeerKind = 'phone' | 'tablet' | 'pc';

// How far the person trusts a device (11.11.2026): home is their own (everything may go there,
// a private chat included), circle a friend's (work they trust them with), world a stranger's
// (only pieces with nothing private: a stranger's phone sees the prompt in plain text while it
// runs). Every device paired so far is home; the person says otherwise (`peers ring`).
export type Ring = 'home' | 'circle' | 'world';
export const RINGS: Ring[] = ['home', 'circle', 'world'];
export const isRing = (v: unknown): v is Ring => v === 'home' || v === 'circle' || v === 'world';
export const ringOf = (p: Pick<Peer, 'ring'>): Ring => (isRing(p.ring) ? p.ring : 'home');
/** a device's ring over all its records: the widest one, so a record added later cannot narrow it */
export const widestRing = (list: Pick<Peer, 'ring'>[]): Ring => list.map(ringOf).reduce((a, b) => (RINGS.indexOf(b) > RINGS.indexOf(a) ? b : a), 'home' as Ring);

export interface Peer {
  id: string;
  name: string;
  named?: boolean;       // the person gave this name (rename): never replaced by the public name
  host: string;
  port: number;
  secret: string;        // protocol v1 (qr v2); '' for a v3 peer
  fp?: string | null;    // protocol v2 (qr v3): the worker's certificate fingerprint, pinned from the qr or learned through the pin proof
  pin?: string | null;   // the one-time pairing code from that qr; cleared once paired
  paired_at?: string | null;
  // far away, behind nat: reached through this relay with this code (docs/RELAY.md).
  // only the api channel crosses a relay; split mode needs the lan.
  relay?: RelayRef | null;
  kind: PeerKind;
  ram: number | null; // MB free when it advertised
  bw: number | null;  // GB/s
  gpu?: string | null;
  vram?: number | null;
  passport?: Record<string, unknown> | null;
  // on a usb cable: reached through an adb forward to this phone (ui/cable.ts). host is
  // 127.0.0.1 and port is the forward's local port, made again on every connect.
  cable?: { serial: string } | null;
  // the phone's worker id (its mdns `id`), learned once a handshake proved this certificate:
  // the cable record and the wi-fi record of one phone share it (ui/devices.ts)
  wid?: string | null;
  added_at: string;
  last_ok?: string | null;
  ring?: Ring;           // absent: home
}

export function peersFile(): string {
  return path.join(home(), 'peers.json');
}

export function readPeers(file = peersFile()): Peer[] {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? (list as Peer[]) : [];
  } catch {
    return [];
  }
}

// Written to a temp file first, then renamed; mode 600 on both.
export function writePeers(list: Peer[], file = peersFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

const HEX = /^[0-9a-f]{16,128}$/i;
const FP = /^[0-9a-f]{64}$/i;
const PIN = /^[0-9a-f]{8,64}$/i;

export const isRemote = (p: Pick<Peer, 'relay'>): boolean => !!p.relay;

// Accepts what a worker shows: the QR json (`{"k":"kula-peer","v":2,...}` with the
// secret, or v3 with the certificate fingerprint, the pairing code and, for a worker
// far away, `relay: {url, code}`), the same json as a base64url code (one pasteable
// line), the short form `host:port:secret` for a worker whose QR is out of reach, or
// a relay code read out over the phone: six digits, optionally followed by the
// pairing code (`123456 0123456789abcdef`); `relayUrl` says which relay then.
export function parsePeerText(text: string, relayUrl?: string): Peer {
  const raw = text.trim();
  if (!raw) throw new Error('empty peer');
  let obj: any = null;
  const code = /^(\d{6})(?:[\s-]+([0-9a-fA-F]{8,64}))?$/.exec(raw);
  if (code) {
    if (!relayUrl) throw new Error('a relay code needs the relay: --relay wss://…');
    const url = normalizeRelayUrl(relayUrl);
    return {
      id: `relay:${code[1]}`, name: `code ${code[1]}`, host: '', port: 0, secret: '', fp: null, pin: code[2]?.toLowerCase() ?? null, paired_at: null,
      relay: { url, code: code[1] }, kind: 'phone', ram: null, bw: null, passport: null, added_at: new Date().toISOString(), last_ok: null,
    };
  }
  if (raw.startsWith('{')) {
    try { obj = JSON.parse(raw); } catch { throw new Error('bad peer json'); }
  } else if (/^[A-Za-z0-9_-]+=*$/.test(raw) && raw.length > 40) {
    try { obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw new Error('bad peer code'); }
  } else {
    const m = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5}):([0-9a-fA-F]+)$/.exec(raw);
    if (!m) throw new Error('peer must be the qr json, its base64url code, or host:port:secret');
    const host = m[1].replace(/^\[|\]$/g, '');
    obj = { k: 'kula-peer', v: 2, id: `${host}:${m[2]}`, name: host, host, port: Number(m[2]), secret: m[3], kind: 'pc' };
  }
  if (!obj || obj.k !== 'kula-peer') throw new Error('not a kula peer (k != kula-peer)');
  if (obj.v !== 2 && obj.v !== 3) throw new Error(`unsupported peer version ${obj.v}`);
  let relay: RelayRef | null = null;
  if (obj.relay && typeof obj.relay === 'object') {
    if (typeof obj.relay.url !== 'string' || !CODE_RE.test(String(obj.relay.code ?? ''))) throw new Error('peer has a bad relay');
    relay = { url: normalizeRelayUrl(obj.relay.url), code: String(obj.relay.code) };
  }
  const port = Number(obj.port);
  // a relayed peer may carry no reachable address at all
  if (!relay && (typeof obj.host !== 'string' || !obj.host)) throw new Error('peer has no host');
  if (!relay && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('peer has a bad port');
  let secret = '';
  let fp: string | null = null;
  let pin: string | null = null;
  if (obj.v === 3) {
    if (typeof obj.fp !== 'string' || !FP.test(obj.fp)) throw new Error('peer has a bad fingerprint');
    fp = obj.fp.toLowerCase();
    pin = typeof obj.pin === 'string' && PIN.test(obj.pin) ? obj.pin.toLowerCase() : null;
    if (typeof obj.secret === 'string' && HEX.test(obj.secret)) secret = obj.secret.toLowerCase();
  } else {
    if (typeof obj.secret !== 'string' || !HEX.test(obj.secret)) throw new Error('peer has a bad secret');
    secret = obj.secret.toLowerCase();
    if (relay) throw new Error('a relayed peer needs protocol v2 (a v3 code): the relay must not see the handshake');
  }
  const host = typeof obj.host === 'string' ? obj.host : '';
  const kind: PeerKind = obj.kind === 'phone' || obj.kind === 'tablet' || obj.kind === 'pc' ? obj.kind : 'phone';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id: typeof obj.id === 'string' && obj.id ? obj.id : relay ? `relay:${relay.code}` : `${host}:${port}`,
    name: typeof obj.name === 'string' && obj.name ? obj.name : host || `code ${relay?.code}`,
    host,
    port: Number.isInteger(port) ? port : 0,
    secret,
    fp,
    pin,
    paired_at: null,
    relay,
    kind,
    ram: num(obj.ram),
    bw: num(obj.bw),
    gpu: typeof obj.gpu === 'string' ? obj.gpu : null,
    vram: num(obj.vram),
    passport: obj.passport && typeof obj.passport === 'object' ? obj.passport : null,
    added_at: new Date().toISOString(),
    last_ok: null,
  };
}

// The base64url code of a peer, for `peers add <code>` on another computer.
export function peerCode(p: Peer): string {
  const { id, name, host, port, secret, kind, ram, bw } = p;
  const o = p.fp
    ? { k: 'kula-peer', v: 3, id, name, host, port, fp: p.fp, pin: p.pin ?? undefined, relay: p.relay ?? undefined, kind, ram, bw }
    : { k: 'kula-peer', v: 2, id, name, host, port, secret, kind, ram, bw };
  return Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
}

// How to speak to a peer: protocol v2 (tls) for a v3 peer, with the pin until paired and
// an empty fp to be learned for a code-only peer; null for a v2 peer (the secret).
export function peerTls(p: Pick<Peer, 'fp' | 'pin' | 'relay'>, identity: GateIdentity): TlsClient | null {
  if (p.fp || p.relay) return { identity, fp: p.fp ?? '', pin: p.pin ?? null };
  return null;
}

// What a successful v2 handshake teaches: the fingerprint (a code-only peer had none)
// and that the pin is spent.
export function afterPaired(p: Peer, fp: string | null): Peer {
  if (!fp) return p;
  return { ...p, fp, pin: null, paired_at: p.paired_at ?? new Date().toISOString() };
}

// "code 123456 via relay.example" for the peer book rows.
export function whereIs(p: Peer): string {
  if (p.cable) return 'usb cable';
  if (p.relay) return `relay ${p.relay.code} via ${p.relay.url.replace(/^wss?:\/\//, '')}`;
  return `${p.host}:${p.port}`;
}

// Adds or replaces (same id) a peer. Returns the list and whether it was new.
export function upsertPeer(list: Peer[], p: Peer): { list: Peer[]; added: boolean } {
  const i = list.findIndex((x) => x.id === p.id);
  if (i < 0) return { list: [...list, p], added: true };
  const next = [...list];
  next[i] = { ...list[i], ...p, added_at: list[i].added_at };
  return { list: next, added: false };
}

// Removes by id, or by a unique prefix of the id, or by name.
export function removePeer(list: Peer[], ref: string): { list: Peer[]; removed: Peer | null } {
  const hit = findPeer(list, ref);
  if (!hit) return { list, removed: null };
  return { list: list.filter((p) => p !== hit), removed: hit };
}

// Sets the ring of a device: the record found by ref and every other record of the same device
// (the same certificate or the same worker id: its cable and its wi-fi). Null when none is found.
export function setRing(list: Peer[], ref: string, ring: Ring): { list: Peer[]; peers: Peer[] } | null {
  if (!isRing(ring)) throw new Error('a ring is home, circle or world');
  const hit = findPeer(list, ref);
  if (!hit) return null;
  const group = new Set(groupOf(groupPeers(list), hit.id) ?? [hit]);
  const next = list.map((p) => (group.has(p) ? { ...p, ring } : p));
  return { list: next, peers: next.filter((_, i) => group.has(list[i])) };
}

export function findPeer(list: Peer[], ref: string): Peer | null {
  const exact = list.find((p) => p.id === ref || p.name === ref);
  if (exact) return exact;
  const pre = list.filter((p) => p.id.startsWith(ref));
  return pre.length === 1 ? pre[0] : null;
}

// Secrets never go to the terminal: 4 chars so two peers can be told apart. A v3
// peer has a certificate instead.
export function maskSecret(secret: string): string {
  return secret ? `${secret.slice(0, 4)}…` : '-';
}

export interface Found {
  id: string | null;
  name: string;
  host: string;
  port: number;
  kind: string | null;
  ram: number | null;
  bw: number | null;
  v: string | null;
}

// Listens for _kula._tcp for `ms` and returns every distinct host:port seen.
// The secret is never in the record: a found worker still needs `peers add`
// with its qr or code. `bonjour` is injectable so tests can hand in a fake.
export function discover(ms = 3000, bonjour: { find: Bonjour['find']; destroy: Bonjour['destroy'] } = new Bonjour()): Promise<Found[]> {
  return new Promise((resolve) => {
    const seen = new Map<string, Found>();
    const browser = bonjour.find({ type: 'kula', protocol: 'tcp' });
    const onUp = (s: { name: string; port: number; txt?: any; addresses?: string[]; host?: string }) => {
      const host = (s.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? s.addresses?.[0] ?? s.host ?? '';
      if (!host) return;
      const txt = s.txt ?? {};
      const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== '' ? n : null; };
      const key = `${host}:${s.port}`;
      const old = seen.get(key);
      // the same worker may be heard twice with a thinner txt: keep what is known
      seen.set(key, {
        id: typeof txt.id === 'string' ? txt.id : old?.id ?? null,
        name: typeof txt.name === 'string' ? txt.name : old?.name ?? s.name,
        host,
        port: s.port,
        kind: typeof txt.kind === 'string' ? txt.kind : old?.kind ?? null,
        ram: num(txt.ram) ?? old?.ram ?? null,
        bw: num(txt.bw) ?? old?.bw ?? null,
        v: typeof txt.v === 'string' ? txt.v : old?.v ?? null,
      });
    };
    browser.on('up', onUp);
    for (const s of browser.services ?? []) onUp(s);
    setTimeout(() => {
      try { browser.stop(); } catch {}
      bonjour.destroy();
      resolve([...seen.values()]);
    }, ms).unref();
  });
}

export interface PeerProbe {
  peer: Peer;
  rpc: ProbeResult;
  api: ProbeResult;
}

export const REMOTE_NO_SPLIT = 'remote peer: split mode needs the lan';

// The tcp + handshake probe on both channels, 2 s each by default. Workers
// that answer get their last_ok stamped in the returned copy of the peer; a v3
// peer that paired gets its pin cleared and its fingerprint pinned (code-only
// peers learn it here). `identity` is this computer's certificate, needed for v3
// peers; a relayed peer is probed through its relay on the api channel only.
export async function probePeers(list: Peer[], timeoutMs = 2000, channels: Channel[] = ['rpc', 'api'], probeFn = probe, identity?: GateIdentity): Promise<PeerProbe[]> {
  return Promise.all(list.map(async (peer) => {
    let learned: string | null = null;
    let name: string | null = null;
    const one = async (c: Channel): Promise<ProbeResult> => {
      const tls = identity ? peerTls(peer, identity) : null;
      if (peer.relay) {
        if (c === 'rpc') return { ok: false, reason: REMOTE_NO_SPLIT };
        if (!tls) return { ok: false, reason: 'no identity for tls' };
        const r = await probeRelay(peer.relay, c, tls, Math.max(timeoutMs, 8000));
        if (r.ok) { learned = r.fp; name = r.worker.name || null; return { ok: true, ms: r.ms }; }
        return r;
      }
      if (peer.fp && !tls) return { ok: false, reason: 'no identity for tls' };
      const r = await probeFn(peer.host, peer.port, peer.secret, c, timeoutMs, tls);
      if (r.ok && tls) learned = peer.fp || learned;
      return r;
    };
    const results = await Promise.all(channels.map(async (c) => [c, await one(c)] as const));
    const by = new Map<Channel, ProbeResult>(results);
    const rpc = by.get('rpc') ?? { ok: false, reason: 'not probed' };
    const api = by.get('api') ?? { ok: false, reason: 'not probed' };
    let stamped = rpc.ok || api.ok ? { ...peer, last_ok: new Date().toISOString() } : peer;
    if ((rpc.ok || api.ok) && (peer.fp || peer.relay)) stamped = afterPaired(stamped, learned ?? peer.fp ?? null);
    if (name && stamped.name.startsWith('code ')) stamped = { ...stamped, name };
    return { peer: stamped, rpc, api };
  }));
}

// `channel closed` is the gate's answer when the worker itself is up but the
// channel's program is not: still a live peer for the other mode.
export const reachable = (r: ProbeResult): boolean => r.ok || (r as { reason?: string }).reason === 'channel closed';
