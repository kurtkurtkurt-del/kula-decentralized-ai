// The peer book of a computer that runs a cluster: who the workers are, how to
// reach them and the secret each gate wants. Kept in ~/.kula-node/peers.json
// with mode 600, because the secrets are in it. Also: finding workers that
// announce themselves over mdns (_kula._tcp) and a short tcp + handshake probe.
import fs from 'node:fs';
import path from 'node:path';
import { Bonjour } from 'bonjour-service';
import { probe, type Channel, type ProbeResult } from './gate.js';
import { home } from './paths.js';

export type PeerKind = 'phone' | 'tablet' | 'pc';

export interface Peer {
  id: string;
  name: string;
  host: string;
  port: number;
  secret: string;
  kind: PeerKind;
  ram: number | null; // MB free when it advertised
  bw: number | null;  // GB/s
  gpu?: string | null;
  vram?: number | null;
  passport?: Record<string, unknown> | null;
  added_at: string;
  last_ok?: string | null;
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

// Accepts what a worker shows: the QR json (`{"k":"kula-peer","v":2,...}`),
// the same json as a base64url code (one pasteable line), or the short form
// `host:port:secret` for a worker whose QR is out of reach.
export function parsePeerText(text: string): Peer {
  const raw = text.trim();
  if (!raw) throw new Error('empty peer');
  let obj: any = null;
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
  if (obj.v !== 2) throw new Error(`unsupported peer version ${obj.v}`);
  const port = Number(obj.port);
  if (typeof obj.host !== 'string' || !obj.host) throw new Error('peer has no host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('peer has a bad port');
  if (typeof obj.secret !== 'string' || !HEX.test(obj.secret)) throw new Error('peer has a bad secret');
  const kind: PeerKind = obj.kind === 'phone' || obj.kind === 'tablet' || obj.kind === 'pc' ? obj.kind : 'phone';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id: typeof obj.id === 'string' && obj.id ? obj.id : `${obj.host}:${port}`,
    name: typeof obj.name === 'string' && obj.name ? obj.name : obj.host,
    host: obj.host,
    port,
    secret: obj.secret.toLowerCase(),
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
  return Buffer.from(JSON.stringify({ k: 'kula-peer', v: 2, id, name, host, port, secret, kind, ram, bw }), 'utf8').toString('base64url');
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

export function findPeer(list: Peer[], ref: string): Peer | null {
  const exact = list.find((p) => p.id === ref || p.name === ref);
  if (exact) return exact;
  const pre = list.filter((p) => p.id.startsWith(ref));
  return pre.length === 1 ? pre[0] : null;
}

// Secrets never go to the terminal: 4 chars so two peers can be told apart.
export function maskSecret(secret: string): string {
  return `${secret.slice(0, 4)}…`;
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

// The tcp + handshake probe on both channels, 2 s each by default. Workers
// that answer get their last_ok stamped in the returned copy of the peer.
export async function probePeers(list: Peer[], timeoutMs = 2000, channels: Channel[] = ['rpc', 'api'], probeFn = probe): Promise<PeerProbe[]> {
  return Promise.all(list.map(async (peer) => {
    const results = await Promise.all(channels.map(async (c) => [c, await probeFn(peer.host, peer.port, peer.secret, c, timeoutMs)] as const));
    const by = new Map<Channel, ProbeResult>(results);
    const rpc = by.get('rpc') ?? { ok: false, reason: 'not probed' };
    const api = by.get('api') ?? { ok: false, reason: 'not probed' };
    const stamped = rpc.ok || api.ok ? { ...peer, last_ok: new Date().toISOString() } : peer;
    return { peer: stamped, rpc, api };
  }));
}

// `channel closed` is the gate's answer when the worker itself is up but the
// channel's program is not: still a live peer for the other mode.
export const reachable = (r: ProbeResult): boolean => r.ok || (r as { reason?: string }).reason === 'channel closed';
