// One device, one row (8.11.2026). The peer book keeps a record per way a device is reached:
// the same phone can be in it as its usb cable (an adb forward to 127.0.0.1) and as its wi-fi
// address, and before this the page showed it twice. Here those records become one device:
//
//   - the same certificate fingerprint (fp) is the same phone: its gate shows the one
//     certificate on every way in, and a tls handshake proves the key behind it;
//   - the same worker id (the phone's `id` in its mdns announcement and in its qr) is the
//     same phone too; it is learned only where the fp already matched.
//
// The records stay apart underneath ("routes"); `bestRoute` picks the one to talk through:
// the cable while it is plugged in, else the wi-fi, else a relay. Also the host qr: what this
// computer shows so a phone pairs by scanning it (`kula-host` v1), pure helpers only.
import { randomBytes } from 'node:crypto';
import type { Peer } from '../peers.js';

export type Via = 'cable' | 'wifi' | 'relay';

export const viaOf = (p: Pick<Peer, 'cable' | 'relay'>): Via => (p.cable ? 'cable' : p.relay ? 'relay' : 'wifi');

// The groups in peer book order; each group in peer book order too, so the first record
// (the oldest way this device was added) gives the device its id and that id stays.
export function groupPeers(list: Peer[]): Peer[][] {
  const parent = list.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[Math.max(x, y)] = Math.min(x, y); };
  const by = new Map<string, number>();
  const link = (key: string | null | undefined, i: number) => {
    if (!key) return;
    const j = by.get(key);
    if (j === undefined) by.set(key, i); else join(i, j);
  };
  list.forEach((p, i) => {
    link(p.fp ? `fp:${p.fp.toLowerCase()}` : null, i);
    link(p.wid ? `wid:${p.wid}` : null, i);
  });
  // a record whose id is a worker id another record learned (a phone added by its own qr)
  list.forEach((p, i) => { const j = by.get(`wid:${p.id}`); if (j !== undefined) join(i, j); });
  const groups = new Map<number, Peer[]>();
  list.forEach((p, i) => { const r = find(i); const g = groups.get(r); if (g) g.push(p); else groups.set(r, [p]); });
  return [...groups.values()];
}

export function groupOf(groups: Peer[][], id: string): Peer[] | null {
  return groups.find((g) => g.some((p) => p.id === id)) ?? null;
}

// What is known about one route right now: plugged (cable: adb sees it; null: not asked) and
// whether the last probe or use got through (null: not tried).
export interface RouteState { plugged: boolean | null; ok: boolean | null; at: number | null }

// The cable while it is plugged in and has not just failed, else the wi-fi that answered last
// (or any wi-fi), else a relay, else the cable (it then says "unplugged").
export function bestRoute(group: Peer[], state: (p: Peer) => RouteState): Peer {
  const cable = group.filter((p) => p.cable);
  const wifi = group.filter((p) => !p.cable && !p.relay);
  const relay = group.filter((p) => p.relay);
  const newest = (list: Peer[]) => [...list].sort((a, b) => {
    const sa = state(a), sb = state(b);
    return Number(sb.ok === true) - Number(sa.ok === true) || String(b.last_ok ?? '').localeCompare(String(a.last_ok ?? ''));
  })[0];
  const pluggedIn = cable.filter((p) => { const s = state(p); return s.plugged === true || (s.plugged === null && s.ok === true); });
  const w = wifi.length ? newest(wifi) : null;
  if (pluggedIn.length) {
    const c = newest(pluggedIn);
    // plugged, but the cable just failed while the wi-fi answers: the wi-fi
    if (state(c).ok === false && w && state(w).ok === true) return w;
    return c;
  }
  if (w) return w;
  if (relay.length) return newest(relay);
  return newest(cable.length ? cable : group);
}

// ---- the host qr: a phone scans this computer (kula-host v1)
//
//   {"k":"kula-host","v":1,"id":"<host id>","name":"<computer name>","fp":"<sha256 hex of this
//    computer's gate certificate>","pin":"<16 hex>","exp":<ms epoch>}
//
// The phone sets `pin` as its gate's one-time code (until `exp`) and starts sharing; this
// computer then hears it on mdns and does the usual v3 pairing handshake with that code. The
// code's proof covers both certificates, so the phone also learns that the computer holding
// the code is the one with `fp`. One code per qr, ten minutes, spent by the first pairing.

export const HOST_PIN_TTL_MS = 10 * 60_000;

export interface HostQr { k: 'kula-host'; v: 1; id: string; name: string; fp: string; pin: string; exp: number }

export function newHostPin(): string { return randomBytes(8).toString('hex'); }

export function hostQr(o: { id: string; name: string; fp: string; pin: string; exp: number }): HostQr {
  return { k: 'kula-host', v: 1, id: o.id, name: o.name.slice(0, 60), fp: o.fp.toLowerCase(), pin: o.pin, exp: o.exp };
}

// The reading the phone does, here so both sides can be checked against one rule.
export function parseHostQr(text: string, now = Date.now()): HostQr {
  let o: any;
  try { o = JSON.parse(text); } catch { throw new Error('not json'); }
  if (!o || o.k !== 'kula-host') throw new Error('not a kula computer (k != kula-host)');
  if (o.v !== 1) throw new Error(`unsupported version ${o.v}`);
  if (typeof o.id !== 'string' || !/^[0-9a-zA-Z._:-]{1,64}$/.test(o.id)) throw new Error('bad id');
  if (typeof o.fp !== 'string' || !/^[0-9a-f]{64}$/.test(o.fp)) throw new Error('bad fingerprint');
  if (typeof o.pin !== 'string' || !/^[0-9a-f]{16}$/.test(o.pin)) throw new Error('bad pin');
  if (typeof o.exp !== 'number' || !Number.isFinite(o.exp)) throw new Error('bad expiry');
  if (o.exp <= now) throw new Error('expired');
  return { k: 'kula-host', v: 1, id: o.id, name: typeof o.name === 'string' ? o.name.slice(0, 60) : '', fp: o.fp, pin: o.pin, exp: o.exp };
}
