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
import { readPeers, writePeers, cleanAddrs, candidates, widestRing, type Peer, type PeerAddr, type Ring } from './peers.js';
import { cleanAnchors, isAnchorRoad, type PeerAnchor } from './road.js';
import { readJoined, writeJoined, joinedRoads, type JoinedAnchor } from './join.js';
import type { GateIdentity } from './tls.js';
import { home } from './paths.js';
import { undialable, isLoopback, isPrivateAddress, plainIp } from './policy.js';

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

// A json list file as pinned() needs it: absent is empty; a file that cannot be read or is not
// a list is null (readPeers and readJoined say [] for both, which would read as "nothing pinned").
function readList(file: string): unknown[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  try {
    const o = JSON.parse(text);
    return Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

// The address to dial an anchor at first: one from outside (ipv6, the router's port) before the
// lan, which only helps on its own network.
const bestOf = (addrs: PeerAddr[]): PeerAddr | null => addrs.find((a) => a.via !== 'lan') ?? addrs[0] ?? null;

// An address of a home network (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7 ...), by its
// class: a record's `via` is the device's own word. Loopback is not one here (F1's rule, `bad`).
const isLanHost = (host: string): boolean => isPrivateAddress(plainIp(host)) && !isLoopback(host);

// A ring for a fingerprint with no record in the peer book (an anchor in the joined store only):
// not home, so its private addresses are not kept.
const NO_RECORD: Ring = 'circle';

export type Accepted = { ok: true; moved: string | null } | { ok: false; why: string };

export interface AddressBookOptions {
  identity: GateIdentity;
  peersFile: string;
  joinedFile: string;
  file?: string;                 // default ~/.kula-node/addrbook.json
  addrs: () => PeerAddr[];       // where this computer answers now (share: the lan, ipv6, the router's port)
  log?: (s: string) => void;
  now?: () => number;
  // tests only, whose homes all answer on 127.0.0.1: records may name loopback. Never set in a
  // production path; every other undialable address is refused still.
  allowLoopback?: boolean;
}

export class AddressBook {
  readonly file: string;
  private readonly now: () => number;
  private readonly self: string;
  // the peer book or the joined store could not be read last time (said once until it can)
  private unreadable = false;
  // the ring each held record was last applied under (sweep): a device whose ring changed since
  // gets its record applied again, as its seq rises only when its addresses change
  private readonly appliedAs = new Map<string, Ring>();

  constructor(private readonly o: AddressBookOptions) {
    this.file = o.file ?? bookFile();
    this.now = o.now ?? Date.now;
    this.self = o.identity.fp.toLowerCase();
    // devices forgotten while kula-node was not running leave the book at start; every held
    // record is applied once under the rings the peer book says now
    try { if (fs.existsSync(this.file)) { this.prune(); this.sweep(); } } catch {}
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
  // joined. Never its own. null when either file is there but cannot be read or is not a list
  // (a corrupt file, EBUSY during a rename on Windows): that is not "nothing pinned", and the
  // callers then change nothing (a prune would drop every record and its seq floor with it).
  pinned(): Set<string> | null {
    const peers = readList(this.o.peersFile);
    const joined = readList(this.o.joinedFile);
    if (!peers || !joined) {
      if (!this.unreadable) this.o.log?.('address book: the peer book could not be read; records are kept and none taken until it can');
      this.unreadable = true;
      return null;
    }
    this.unreadable = false;
    const out = new Set<string>();
    for (const p of peers as Partial<Peer>[]) if (p && typeof p.fp === 'string' && FP_RE.test(p.fp.toLowerCase())) out.add(p.fp.toLowerCase());
    // the joined anchors readJoined keeps
    for (const a of joined as Partial<JoinedAnchor>[]) {
      if (a && typeof a.fp === 'string' && FP_RE.test(a.fp) && typeof a.host === 'string' && a.host && Number.isInteger(a.port) && a.port! > 0 && a.port! < 65536) out.add(a.fp);
    }
    out.delete(this.self);
    return out;
  }

  // A forgotten device leaves the book: the records (its lan and public addresses, its anchors)
  // and the move lines of every fingerprint no longer pinned here go, and the file is written
  // again so they are gone from disk. Run when the book is built, on every `wants()` (each anchor
  // link, every 60 s) and before a record is taken. How many records went.
  // (This is this computer's own book of other devices; an anchor's store of the records it
  // carries for its members is AnchorHub's, in memory, with its own rules.)
  // Nothing goes while the peer book cannot be read (pinned() null).
  prune(pinned: Set<string> | null = this.pinned()): number {
    if (!pinned) return 0;
    const b = readBook(this.file);
    const gone = Object.keys(b.recs).filter((fp) => !pinned.has(fp));
    const moved = b.moved.filter((m) => pinned.has(m.fp));
    if (!gone.length && moved.length === b.moved.length) return 0;
    for (const fp of gone) delete b.recs[fp];
    b.moved = moved;
    try { writeBook(this.file, b); } catch (e) { this.o.log?.(`address book: could not drop forgotten devices: ${(e as Error).message}`); return 0; }
    return gone.length;
  }

  // What to ask the anchors about: every pinned fingerprint, with the seq kept for it (an anchor
  // hands over only newer records). Records of devices no longer pinned are dropped first.
  // Nothing while the peer book cannot be read: asked with seq 0, an anchor could hand back an
  // old record.
  wants(): { fp: string; seq: number }[] {
    const pinned = this.pinned();
    if (!pinned) return [];
    this.prune(pinned);
    try { this.sweep(pinned); } catch (e) { this.o.log?.(`address book: could not apply the kept records again: ${(e as Error).message}`); }
    const recs = readBook(this.file).recs;
    return [...pinned].sort().slice(0, 4 * WHO_BATCH).map((fp) => ({ fp, seq: recs[fp]?.seq ?? 0 }));
  }

  // A record an anchor handed over (`via`: that anchor's fingerprint). Taken only when it checks
  // (addrrecord.ts), its fingerprint is pinned here and its seq is newer than the one kept; then
  // the peer book and the joined anchors follow it. A record naming any address or anchor this
  // computer must not dial (loopback, link-local, multicast, policy.ts `undialable`) is refused
  // whole: taken, every probe round would dial there, and the device could time it to learn
  // which of this computer's own ports are open.
  accept(x: unknown, via: string | null = null): Accepted {
    const c = checkRecord(x);
    if (!c.ok) return c;
    const rec = c.rec;
    const bad = (host: string) => undialable(host) && !(this.o.allowLoopback && isLoopback(host));
    if ([...rec.addrs, ...rec.anchors].some((a) => bad(a.host))) return { ok: false, why: 'an address this computer must not dial' };
    if (rec.fp === this.self) return { ok: false, why: 'this computer\'s own' };
    const pinned = this.pinned();
    if (!pinned) return { ok: false, why: 'the peer book could not be read' };
    if (!pinned.has(rec.fp)) return { ok: false, why: 'not pinned here' };
    // forgotten devices go first, so they neither stay on disk nor fill the book
    this.prune(pinned);
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

  // Every held record of a pinned fingerprint whose ring is not the one it was last applied under
  // is applied again (all of them the first time): a friend's device confirmed as the person's
  // own gets its lan addresses back, one turned a friend's loses them. Run when the book is built
  // and on every `wants()`. Nothing while the peer book cannot be read (pinned() null).
  sweep(pinned: Set<string> | null = this.pinned()): number {
    if (!pinned) return 0;
    const recs = readBook(this.file).recs;
    const rings = this.rings();
    let n = 0;
    for (const fp of Object.keys(recs)) {
      if (!pinned.has(fp)) continue;
      if (this.appliedAs.get(fp) === (rings.get(fp) ?? NO_RECORD)) continue;
      this.apply(recs[fp], recs);
      n++;
    }
    for (const fp of [...this.appliedAs.keys()]) if (!recs[fp]) this.appliedAs.delete(fp);
    return n;
  }

  // the ring of every fingerprint in the peer book: the widest over its records (peers.ts)
  private rings(list: Peer[] = readPeers(this.o.peersFile)): Map<string, Ring> {
    const by = new Map<string, Peer[]>();
    for (const p of list) {
      const fp = typeof p.fp === 'string' ? p.fp.toLowerCase() : '';
      if (!fp) continue;
      by.set(fp, [...(by.get(fp) ?? []), p]);
    }
    return new Map([...by].map(([fp, ps]) => [fp, widestRing(ps)]));
  }

  // The peer book and the joined anchors follow a taken record. For a device that is not the
  // person's own (home), the record's private addresses are left out (the person's decision,
  // 17 Nov: a friend's devices' lan addresses are not kept on this computer), and so are its
  // anchors at private addresses unless this computer joined that anchor there itself.
  private apply(rec: AddrRecord, recs: Record<string, AddrRecord>): void {
    const list = readPeers(this.o.peersFile);
    const rings = this.rings(list);
    const ringOfFp = (fp: string): Ring => rings.get(fp) ?? NO_RECORD;
    const usable = (fp: string, a: PeerAddr[]): PeerAddr[] => (ringOfFp(fp) === 'home' ? a : a.filter((w) => w.via !== 'lan' && !isLanHost(w.host)));
    const joined = readJoined(this.o.joinedFile);
    const ring = ringOfFp(rec.fp);
    const home = ring === 'home';
    const addrs = usable(rec.fp, cleanAddrs(rec.addrs));
    const best = bestOf(addrs);
    const inRec = new Set(addrs.map(addrKey));
    // an anchor named somewhere at an address its own record no longer has: the record's address
    // (of those this computer keeps for it)
    const fixAnchor = (a: PeerAnchor): PeerAnchor => {
      const r = a.fp === rec.fp ? rec : recs[a.fp];
      if (!r || !r.addrs.length || r.addrs.some((w) => w.host === a.host && w.port === a.port)) return a;
      const b = bestOf(usable(a.fp, cleanAddrs(r.addrs)));
      return b ? { ...a, host: b.host, port: b.port } : a;
    };
    const joinedAt = (a: PeerAnchor) => joined.some((j) => j.fp === a.fp && j.host === a.host && j.port === a.port);
    // the device's own records: its addresses and its anchors are what it says now
    let changed = false;
    const next = list.map((p): Peer => {
      let q = p;
      if (p.fp?.toLowerCase() === rec.fp && !p.cable && !p.relay) {
        const anchors = cleanAnchors(rec.anchors).filter((a) => home || !isLanHost(a.host) || joinedAt(a)).map(fixAnchor);
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
    // reads the store again and registers there). A friend's anchor joined at a private address
    // stays dialled there: that is where this computer found it, not something its record said.
    const hit = joined.find((a) => a.fp === rec.fp);
    if (hit && (best || !home)) {
      const keep = !best || inRec.has(addrKey(hit)) || (!home && isLanHost(hit.host));
      const was = JSON.stringify(hit);
      if (!keep) { hit.host = best!.host; hit.port = best!.port; }
      hit.addrs = addrs;
      if (JSON.stringify(hit) !== was) writeJoined(joined, this.o.joinedFile);
    }
    this.appliedAs.set(rec.fp, ring);
  }
}
