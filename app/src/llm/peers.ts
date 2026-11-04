import { newId } from '@/lib/offline';
import { deviceId, lastPassport, linkPassport } from '@/data/passport';
import type { Passport } from '@/passport/contract';
import { GATE_PORT, llama } from '@/llm/native';
import { rememberPeer, saveShare, share, type Peer } from '@/llm/store';

// The peer qr (v2, 4.11.2026): what a shared phone or a computer shows, and what the master
// scans. It carries the gate address and the pairing secret, and the device's passport when
// it has one, so the together page knows the device too. The old passport-only qr still
// reads (data/passport.ts linkPassport); this file tells the two apart.
export type PeerQr = {
  k: 'kula-peer';
  v: 2;
  id: string;
  name: string;
  host: string;
  port: number;
  secret: string;
  kind: 'phone' | 'tablet' | 'pc';
  ram?: number | null;
  bw?: number | null;
  passport?: Passport | null;
};

export function isPeerQr(text: string): boolean {
  try {
    const o = JSON.parse(text);
    return o && o.k === 'kula-peer' && typeof o.secret === 'string' && typeof o.host === 'string';
  } catch {
    return false;
  }
}

/** Parses and remembers a peer qr; links its passport too. Throws 'notPeer' | 'self' | 'old'. */
export function takePeerQr(text: string): Peer {
  let o: PeerQr;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('notPeer');
  }
  if (!o || o.k !== 'kula-peer') throw new Error('notPeer');
  if (o.v !== 2) throw new Error('old');
  if (!o.id || !o.host || !o.port || !/^[0-9a-f]{32,}$/i.test(o.secret)) throw new Error('notPeer');
  if (o.id === myWorkerId) throw new Error('self');
  const peer: Peer = {
    id: o.id, name: o.name || o.host, host: o.host, port: Number(o.port), secret: o.secret,
    kind: o.kind === 'pc' || o.kind === 'tablet' ? o.kind : 'phone',
    ram: o.ram ?? null, bw: o.bw ?? null, passport: (o.passport as Record<string, unknown>) ?? null,
    added_at: new Date().toISOString(), last_ok: null,
  };
  rememberPeer(peer);
  if (o.passport) {
    try {
      linkPassport(JSON.stringify(o.passport));
    } catch {}
  }
  return peer;
}

let myWorkerId: string | null = null;
export const setMyWorkerId = (id: string) => (myWorkerId = id);

/** This phone's own qr as a worker: a new secret the first time, kept until "stop sharing". */
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
  const q: PeerQr = {
    k: 'kula-peer', v: 2, id: info.workerId, name: s.name, host: info.wifiIp ?? '0.0.0.0', port: s.port, secret: s.secret,
    kind: p?.kind === 'tablet' ? 'tablet' : 'phone', ram: info.ramFreeMb, bw: p ? Number(p.mem_bw_read_gbs) || Number(p.mem_bw_gbs) || null : null,
    passport: p ? ({ ...p, device_id: p.device_id ?? deviceId() } as Passport) : null,
  };
  return { qr: JSON.stringify(q), share: s };
}

function randomHex(bytes: number): string {
  // newId() gives 20+ random chars; stretch it into hex of the wanted length
  let out = '';
  while (out.length < bytes * 2) out += Array.from(newId() + newId(), (c) => c.charCodeAt(0).toString(16).slice(-1)).join('');
  return out.slice(0, bytes * 2).toLowerCase().replace(/[^0-9a-f]/g, '0');
}
