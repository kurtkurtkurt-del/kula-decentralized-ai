// The circle's address book (docs/ANCHOR.md "address book", stage 6), this computer's side.
//
// - **Its own record:** where this computer answers now and the anchors it is registered with,
//   signed with its gate key (addrrecord.ts). A new one (a higher seq) only when that changed.
//   AnchorLinks hands it to every anchor this computer is registered with.
// - **Records of others:** whatever an anchor hands over is taken only when the fingerprint is
//   pinned here already (the peer book or the joined anchors), the certificate in it is that
//   fingerprint, the signature holds and the seq is newer than the one kept. The anchor that
//   carried it is not trusted for any of this.
// - **What a taken record changes:** the device's `addrs` and `anchors` in the peer book; where it
//   is an anchor, its address in the store of joined anchors and in every record that names it as
//   an anchor. So roads (road.ts) and AnchorLinks find a device, and an anchor, at its new address.
// - **One line when a device moved:** "<name> moved: its new address came through anchor <B>",
//   kept in the book's file; the page's engine shows it among its notes.
//
// Kept in ~/.kula-node/addrbook.json (mode 600): this computer's own record, the last taken record
// of each device, the last moves.
import fs from 'node:fs';
import path from 'node:path';
import { checkRecord, signRecord, recordBody, addrKey, type AddrRecord } from './addrrecord.js';
import { readPeers, writePeers, cleanAddrs, candidates, type Peer, type PeerAddr } from './peers.js';
import { cleanAnchors, isAnchorRoad, type PeerAnchor } from './road.js';
import { readJoined, writeJoined, joinedRoads } from './join.js';
import type { GateIdentity } from './tls.js';
import { home } from './paths.js';

const FP_RE = /^[0-9a-f]{64}$/;
const MAX_HELD = 512;
const MAX_MOVES = 20;
// how many fingerprints one `who` line asks about (a line is 4096 bytes at most)
export const WHO_BATCH = 32;

export interface Move { at: number; fp: string; text: string }
interface BookFile { own: AddrRecord | null; recs: Record<string, AddrRecord>; moved: Move[] }

export const bookFile = (dir: string = home()): string => path.join(dir, 'addrbook.json');

function readBook(file: string): BookFile {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      own: o && typeof o.own === 'object' ? o.own : null,
      recs: o && o.recs && typeof o.recs === 'object' ? o.recs : {},
      moved: Array.isArray(o?.moved) ? o.moved.filter((m: unknown) => m && typeof (m as Move).text === 'string' && typeof (m as Move).at === 'number') : [],
    };
  } catch {
    return { own: null, recs: {}, moved: [] };
  }
}

function writeBook(file: string, b: BookFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

// The moves kept in a book file after `since` (ms): the engine's notes read them.
export function readMoves(file: string, since = 0): Move[] {
  return readBook(file).moved.filter((m) => m.at > since);
}

const sameList = <T>(a: T[], b: T[]): boolean => JSON.stringify(a) === JSON.stringify(b);

// The address to dial an anchor at first: one from outside (ipv6, the router's port) before the
// lan, which only helps on its own network.
const bestOf = (addrs: PeerAddr[]): PeerAddr | null => addrs.find((a) => a.via !== 'lan') ?? addrs[0] ?? null;

export type Accepted = { ok: true; moved: string | null } | { ok: false; why: string };

export interface AddressBookOptions {
  identity: GateIdentity;
  peersFile: string;
  joinedFile: string;
  file?: string;                 // default ~/.kula-node/addrbook.json
  addrs: () => PeerAddr[];       // where this computer answers now (share: the lan, ipv6, the router's port)
  log?: (s: string) => void;
  now?: () => number;
}

export class AddressBook {
  readonly file: string;
  private readonly now: () => number;
  private readonly self: string;

  constructor(private readonly o: AddressBookOptions) {
    this.file = o.file ?? bookFile();
    this.now = o.now ?? Date.now;
    this.self = o.identity.fp.toLowerCase();
  }

  // This computer's record now: the one kept while its addresses and anchors are the same, a new
  // one (seq max(last + 1, now)) when they changed. null while it has no address to say.
  own(): AddrRecord | null {
    let addrs: PeerAddr[];
    let anchors: PeerAnchor[];
    try {
      addrs = cleanAddrs(this.o.addrs());
      anchors = cleanAnchors(joinedRoads(readJoined(this.o.joinedFile))).filter((a) => a.fp !== this.self);
    } catch {
      return null;
    }
    if (!addrs.length) return null;
    const b = readBook(this.file);
    const old = b.own && b.own.fp === this.self ? b.own : null;
    const draft = recordBody(addrs, anchors);
    if (old && old.cert === this.o.identity.certDer.toString('base64') && sameList(old.addrs, draft.addrs) && sameList(old.anchors, draft.anchors)) return old;
    const now = this.now();
    const rec = signRecord(this.o.identity, { addrs, anchors, seq: Math.max((old?.seq ?? 0) + 1, now), at: now });
    b.own = rec;
    try { writeBook(this.file, b); } catch (e) { this.o.log?.(`address book: could not keep this computer's record: ${(e as Error).message}`); }
    return rec;
  }

  // the last record taken for a device; null when none
  held(fp: string): AddrRecord | null {
    return readBook(this.file).recs[fp.toLowerCase()] ?? null;
  }

  // The fingerprints this computer may take records for: pinned in its peer book, or an anchor it
  // joined. Never its own.
  pinned(): Set<string> {
    const out = new Set<string>();
    for (const p of readPeers(this.o.peersFile)) if (p && typeof p.fp === 'string' && FP_RE.test(p.fp.toLowerCase())) out.add(p.fp.toLowerCase());
    for (const a of readJoined(this.o.joinedFile)) out.add(a.fp.toLowerCase());
    out.delete(this.self);
    return out;
  }

  // What to ask the anchors about: every pinned fingerprint, with the seq kept for it (an anchor
  // hands over only newer records).
  wants(): { fp: string; seq: number }[] {
    const recs = readBook(this.file).recs;
    return [...this.pinned()].sort().slice(0, 4 * WHO_BATCH).map((fp) => ({ fp, seq: recs[fp]?.seq ?? 0 }));
  }

  // A record an anchor handed over (`via`: that anchor's fingerprint). Taken only when it checks
  // (addrrecord.ts), its fingerprint is pinned here and its seq is newer than the one kept; then
  // the peer book and the joined anchors follow it.
  accept(x: unknown, via: string | null = null): Accepted {
    const c = checkRecord(x);
    if (!c.ok) return c;
    const rec = c.rec;
    if (rec.fp === this.self) return { ok: false, why: 'this computer\'s own' };
    if (!this.pinned().has(rec.fp)) return { ok: false, why: 'not pinned here' };
    const b = readBook(this.file);
    const old = b.recs[rec.fp] ?? null;
    if (old && rec.seq <= old.seq) return { ok: false, why: 'not newer' };
    if (!old && Object.keys(b.recs).length >= MAX_HELD) return { ok: false, why: 'the book is full' };
    const before = this.knownAddrs(rec.fp, old);
    b.recs[rec.fp] = rec;
    const moved = this.movedWords(rec, old, before, via);
    if (moved) {
      b.moved.push({ at: this.now(), fp: rec.fp, text: moved });
      if (b.moved.length > MAX_MOVES) b.moved.splice(0, b.moved.length - MAX_MOVES);
    }
    writeBook(this.file, b);
    this.apply(rec, b.recs);
    if (moved) this.o.log?.(moved);
    return { ok: true, moved };
  }

  // the addresses this computer knew for a device before a record: the last record's, else what
  // the peer book and the joined anchors say
  private knownAddrs(fp: string, old: AddrRecord | null): Set<string> {
    if (old) return new Set(old.addrs.map(addrKey));
    const out = new Set<string>();
    for (const p of readPeers(this.o.peersFile)) {
      if (p.fp?.toLowerCase() !== fp || p.cable || p.relay) continue;
      for (const a of candidates(p)) out.add(addrKey(a));
    }
    for (const a of readJoined(this.o.joinedFile)) {
      if (a.fp !== fp) continue;
      out.add(addrKey(a));
      for (const w of a.addrs ?? []) out.add(addrKey(w));
    }
    return out;
  }

  private nameOf(fp: string): string {
    const p = readPeers(this.o.peersFile).find((x) => x.fp?.toLowerCase() === fp);
    if (p?.name) return p.name;
    const a = readJoined(this.o.joinedFile).find((x) => x.fp === fp);
    return a?.name || `${fp.slice(0, 8)}…`;
  }

  // A device moved: its record names other addresses than the last one did, or (the first
  // record) none of the ones known. Nothing is said for a device whose address was not known.
  private movedWords(rec: AddrRecord, old: AddrRecord | null, before: Set<string>, via: string | null): string | null {
    if (!before.size || !rec.addrs.length) return null;
    const now = new Set(rec.addrs.map(addrKey));
    const changed = old ? now.size !== before.size || [...now].some((k) => !before.has(k)) : ![...now].some((k) => before.has(k));
    if (!changed) return null;
    const name = this.nameOf(rec.fp);
    if (!via || via === rec.fp) return `${name} moved: it said its new address itself`;
    return `${name} moved: its new address came through anchor ${this.nameOf(via)}`;
  }

  // The peer book and the joined anchors follow a taken record.
  private apply(rec: AddrRecord, recs: Record<string, AddrRecord>): void {
    const addrs = cleanAddrs(rec.addrs);
    const best = bestOf(addrs);
    const inRec = new Set(addrs.map(addrKey));
    // an anchor named somewhere at an address its own record no longer has: the record's address
    const fixAnchor = (a: PeerAnchor): PeerAnchor => {
      const r = a.fp === rec.fp ? rec : recs[a.fp];
      if (!r || !r.addrs.length || r.addrs.some((w) => w.host === a.host && w.port === a.port)) return a;
      const b = bestOf(r.addrs)!;
      return { ...a, host: b.host, port: b.port };
    };
    // the device's own records: its addresses and its anchors are what it says now
    const list = readPeers(this.o.peersFile);
    let changed = false;
    const next = list.map((p): Peer => {
      let q = p;
      if (p.fp?.toLowerCase() === rec.fp && !p.cable && !p.relay) {
        const anchors = cleanAnchors(rec.anchors).map(fixAnchor);
        q = { ...q, addrs, anchors };
        // a kept route to an address it no longer has is dropped: the next connection picks again
        if (q.route && !isAnchorRoad(q.route) && !inRec.has(addrKey(q.route)) && !(q.route.host === q.host && q.route.port === q.port)) q = { ...q, route: null };
      }
      if (q.anchors?.some((a) => a.fp === rec.fp)) q = { ...q, anchors: q.anchors.map(fixAnchor) };
      if (q !== p && JSON.stringify(q) !== JSON.stringify(p)) changed = true;
      return q;
    });
    if (changed) writePeers(next, this.o.peersFile);
    // an anchor this computer joined: dialled at the record's address from now on (AnchorLinks
    // reads the store again and registers there)
    const joined = readJoined(this.o.joinedFile);
    const hit = joined.find((a) => a.fp === rec.fp);
    if (hit && best) {
      const keep = inRec.has(addrKey(hit));
      const was = JSON.stringify(hit);
      if (!keep) { hit.host = best.host; hit.port = best.port; }
      hit.addrs = addrs;
      if (JSON.stringify(hit) !== was) writeJoined(joined, this.o.joinedFile);
    }
  }
}
