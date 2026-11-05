import { deviceId, lastPassport, linkPassport } from '@/data/passport';
import type { Passport } from '@/passport/contract';
import { GATE_PORT, llama } from '@/llm/native';
import { randomHex } from '@/llm/random';
import { rememberPeer, saveShare, share, type Peer } from '@/llm/store';

// The peer qr: what a shared phone or a computer shows, and what the master scans. It
// carries the gate address and what the first connection needs, and the device's passport
// when it has one, so the together page knows the device too. Two versions read:
//   v2 (4.11.2026): `secret`, the shared key of the plain handshake (gate protocol v1).
//   v3 (5.11.2026): `fp`, the worker's certificate fingerprint the master pins, and `pin`,
//   a one-time pairing code; the connection is tls (gate protocol v2, docs/GATE.md).
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
  kind: 'phone' | 'tablet' | 'pc';
  ram?: number | null;
  bw?: number | null;
  passport?: Passport | null;
};

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`, 'i');

export function isPeerQr(text: string): boolean {
  try {
    const o = JSON.parse(text);
    return !!o && o.k === 'kula-peer' && typeof o.host === 'string' && (typeof o.secret === 'string' || typeof o.fp === 'string');
  } catch {
    return false;
  }
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
  if (!o.id || !o.host || !o.port) throw new Error('notPeer');
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
    id: o.id, name: o.name || o.host, host: o.host, port: Number(o.port), secret, fp, pin, paired_at: null,
    kind: o.kind === 'pc' || o.kind === 'tablet' ? o.kind : 'phone',
    ram: o.ram ?? null, bw: o.bw ?? null, passport: (o.passport as Record<string, unknown>) ?? null,
    added_at: new Date().toISOString(), last_ok: null,
  };
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

/** The qr text for this device: v3 when it has a certificate fingerprint, else v2 with the secret. */
export function makePeerQr(p: Omit<PeerQr, 'k' | 'v'>): string {
  const q: PeerQr = p.fp
    ? { k: 'kula-peer', v: 3, ...p, secret: undefined }
    : { k: 'kula-peer', v: 2, ...p, fp: undefined, pin: undefined };
  return JSON.stringify(q);
}

/**
 * This phone's own qr as a worker: a new secret the first time, kept until "stop sharing".
 * Once the worker runs it reports its certificate fingerprint and the open pairing code
 * (worker status), and the qr becomes v3; before that it is v2 with the secret.
 */
export async function myPeerQr(): Promise<{ qr: string; share: { secret: string; name: string; port: number } }> {
  if (!llama) throw new Error('nonative');
  const info = await llama.info();
  myWorkerId = info.workerId;
  let s = share();
  if (!s) {
    s = { secret: randomHex(32), name: lastPassport()?.device ?? 'phone', port: GATE_PORT };
    saveShare(s);
  }
  const p = lastPassport();
  const status = await llama.workerStatus().catch(() => null);
  const live = status && (status.state === 'running' || status.state === 'starting') && status.fp ? status : null;
  const qr = makePeerQr({
    id: info.workerId, name: s.name, host: info.wifiIp ?? '0.0.0.0', port: s.port,
    secret: s.secret, fp: live?.fp ?? undefined, pin: live?.pin ?? null,
    kind: p?.kind === 'tablet' ? 'tablet' : 'phone', ram: info.ramFreeMb, bw: p ? Number(p.mem_bw_read_gbs) || Number(p.mem_bw_gbs) || null : null,
    passport: p ? ({ ...p, device_id: p.device_id ?? deviceId() } as Passport) : null,
  });
  return { qr, share: s };
}
