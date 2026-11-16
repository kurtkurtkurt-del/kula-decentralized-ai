// Joining an anchor (docs/ANCHOR.md "join", stage 4): the anchor's invite, the joiner's pairing
// with it, the pair-back, the store of anchors this computer joined, and the control connections
// to them kept while kula runs.
//
//   invite      the anchor's kula-peer v3 code: its certificate, its addresses from outside (the
//               router's mapped port, global ipv6), a one-time code `pin`, `anchor: true` and a
//               second one-time code `hpin`. Ten minutes, single use; a new invite kills the old.
//   join        the joiner pairs with the anchor's gate using `pin` (the usual pin proof, which
//               covers both certificates), keeps the anchor in its peer book and in the store of
//               joined anchors (~/.kula-node/anchors.json), then registers there (joinAnchor).
//   pair-back   the joiner's gate opens `hpin` for the anchor's certificate only; once the joiner
//               registers, the anchor dials it through its own hub (dialLocal, the in-process hop)
//               and pairs with `hpin`: the far version of the host-qr flow. Both sides then know
//               each other: each is pinned in the other's peer book and paired list.
//
// A typed entry (address, code, the first 16 hex or more of the certificate) works too: the
// certificate start is checked at TLS and `hpin` is derived from `pin` (pairBackCode), so it need
// not be typed. Nothing outside the circle is asked.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { handshake, connectRemote, GateRefused, FP_MISMATCH, FP_PREFIX_MIN, PIN_TTL_MS, type ExtraCodes } from './gate.js';
import { newPin, type GateIdentity } from './tls.js';
import { candidates, cleanAddrs, readPeers, writePeers, upsertPeer, peerCode, widestRing, type Peer, type PeerAddr, type Ring } from './peers.js';
import { joinAnchor, FP_RE, type AnchorHub, type AnchorEvent, type AnchorKind, type AnchorMembership, type AnchorBook } from './anchor.js';
import type { PeerAnchor } from './road.js';
import type { AddrRecord } from './addrrecord.js';
import { isLoopback, isPrivateAddress } from './policy.js';
import { home } from './paths.js';

export const INVITE_TTL_MS = PIN_TTL_MS;
// a code that was used or ran out is remembered this long, so a late try hears why
const GONE_MS = 30 * 60_000;

type Log = (s: string) => void;

// ---- one-time codes beside the gate's own (gate.ts ExtraCodes) ------------------------------

interface Code { exp: number; only: string | null; onUsed?: (fp: string) => void }

export class OneTimeCodes implements ExtraCodes {
  private readonly live = new Map<string, Code>();
  private readonly gone = new Map<string, { why: string; until: number; only: string | null }>();
  constructor(private readonly now: () => number = Date.now) {}

  // `only`: the one certificate that may use it (a pair-back code); `onUsed` runs after the pairing
  add(pin: string, ttlMs: number, o: { only?: string | null; onUsed?: (fp: string) => void } = {}): void {
    const p = pin.toLowerCase();
    this.gone.delete(p);
    this.live.set(p, { exp: this.now() + ttlMs, only: o.only ? o.only.toLowerCase() : null, onUsed: o.onUsed });
  }

  drop(pin: string): void {
    const p = pin.toLowerCase();
    const c = this.live.get(p);
    if (!c) return;
    this.live.delete(p);
    this.gone.set(p, { why: 'pin expired', until: this.now() + GONE_MS, only: c.only });
  }

  has(pin: string): boolean { this.sweep(); return this.live.has(pin.toLowerCase()); }

  private sweep() {
    const t = this.now();
    for (const [p, c] of this.live) if (t > c.exp) { this.live.delete(p); this.gone.set(p, { why: 'pin expired', until: t + GONE_MS, only: c.only }); }
    for (const [p, g] of this.gone) if (t > g.until) this.gone.delete(p);
  }

  open(fp: string): string[] {
    this.sweep();
    const f = fp.toLowerCase();
    return [...this.live].filter(([, c]) => !c.only || c.only === f).map(([p]) => p);
  }

  recent(fp: string): { pin: string; why: string }[] {
    this.sweep();
    const f = fp.toLowerCase();
    return [...this.gone].filter(([, g]) => !g.only || g.only === f).map(([pin, g]) => ({ pin, why: g.why }));
  }

  take(pin: string, fp: string): boolean {
    this.sweep();
    const p = pin.toLowerCase();
    const c = this.live.get(p);
    if (!c || (c.only && c.only !== fp.toLowerCase())) return false;
    this.live.delete(p);
    this.gone.set(p, { why: 'pin used', until: this.now() + GONE_MS, only: c.only });
    // after the gate added the certificate to its paired list (it does so right after this call)
    if (c.onUsed) queueMicrotask(() => { try { c.onUsed!(fp.toLowerCase()); } catch {} });
    return true;
  }
}

// The pair-back code of an invite: carried in the invite as `hpin`, and derived from `pin` when the
// invite was typed. Whoever saw the invite knows both anyway; the joiner opens it only for the
// anchor's certificate, and only after its own pairing with the anchor worked.
export function pairBackCode(pin: string): string {
  return createHmac('sha256', pin.toLowerCase()).update('kula anchor pair-back').digest('hex').slice(0, 16);
}

// ---- whose bytes are capped ---------------------------------------------------------------

// The anchor's daily byte cap is for friends' devices (16.11.2026, the person's decision): a
// member whose record in this computer's peer book is ring circle (or world) is capped, the
// person's own (ring home) never. A member without a record yet (it paired, the pair-back has not
// run) is capped until it has one. The book is read again when it changes, so a ring set with
// `peers ring` or the page counts at the next check.
export function ringCapped(peersFile: string): (fp: string) => boolean {
  let stamp = '';
  let rings = new Map<string, Ring>();
  return (fp: string) => {
    let now = 'none';
    try { const st = fs.statSync(peersFile); now = `${st.mtimeMs}:${st.size}`; } catch {}
    if (now !== stamp) {
      stamp = now;
      const by = new Map<string, Peer[]>();
      for (const p of readPeers(peersFile)) if (p.fp) { const k = p.fp.toLowerCase(); by.set(k, [...(by.get(k) ?? []), p]); }
      rings = new Map([...by].map(([k, list]) => [k, widestRing(list)]));
    }
    const r = rings.get(fp.toLowerCase());
    return r === undefined || r !== 'home';
  };
}

// ---- reached from outside -----------------------------------------------------------------

// A member registered from an address that is neither private nor loopback: the gate answers from
// outside. Only this says so, never an outside service.
export function reachableFromOutside(members: { peer: string }[]): boolean {
  return members.some((m) => m.peer !== 'self' && !isLoopback(m.peer) && !isPrivateAddress(m.peer));
}

// ---- the invite (the anchor's side) -------------------------------------------------------

// whose device an invite is for: the person's own, or a friend's
export type Whose = 'mine' | 'friend';
export const isWhose = (v: unknown): v is Whose => v === 'mine' || v === 'friend';

export interface Invite {
  whose: Whose;
  code: string;         // the base64url kula-peer v3 code to paste
  text: string;         // its json (the qr)
  exp: number;
  fp: string;
  addrs: PeerAddr[];
  lanOnly: boolean;     // no address from outside: it works on this network only
  typed: { address: string; code: string; certificate: string };
}

const hp = (h: string, port: number) => `${h.includes(':') ? `[${h}]` : h}:${port}`;

export interface AnchorHostOptions {
  identity: GateIdentity;
  codes: OneTimeCodes;
  hub: Pick<AnchorHub, 'on' | 'members' | 'dialLocal'>;
  peersFile: string;
  id: string;
  name: string;
  log?: Log;
  ttlMs?: number;
  now?: () => number;
  timeoutMs?: number;
  onUsed?: (fp: string) => void;
  onPairedBack?: (peer: Peer) => void;
}

// This computer as an anchor: its invites and the pair-back with whoever used one.
export class AnchorHost {
  private last: { invite: Invite; pin: string; used: boolean } | null = null;
  private readonly backs = new Map<string, { hpin: string; exp: number; busy: boolean; ring: Ring }>();
  private readonly off: () => void;
  private readonly now: () => number;

  constructor(private readonly o: AnchorHostOptions) {
    this.now = o.now ?? Date.now;
    this.off = o.hub.on((e: AnchorEvent) => { if (e.type === 'register') void this.pairBack(e.fp, e.name, e.kind); });
  }

  private log(s: string) { this.o.log?.(s); }

  // A new invite; the one before it stops working. `addrs`: the ways in from outside (the caller
  // falls back to the lan address when there is none, and the invite then says lanOnly).
  // `whose`: the person says whose device will use it: their own (ring home, never byte-capped) or
  // a friend's (ring circle, capped); kept on the record the pair-back writes, changeable later.
  invite(addrs: PeerAddr[], info: { ram?: number | null; bw?: number | null } = {}, whose: Whose = 'friend'): Invite {
    const ways = cleanAddrs(addrs);
    if (!ways.length) throw new Error('this computer has no address another device could use: is it on a network?');
    if (this.last && !this.last.used) this.o.codes.drop(this.last.pin);
    const pin = newPin();
    const hpin = pairBackCode(pin);
    const ttl = this.o.ttlMs ?? INVITE_TTL_MS;
    const exp = this.now() + ttl;
    const entry = { invite: null as unknown as Invite, pin, used: false };
    this.o.codes.add(pin, ttl, {
      onUsed: (fp) => {
        entry.used = true;
        this.backs.set(fp, { hpin, exp: this.now() + ttl, busy: false, ring: whose === 'mine' ? 'home' : 'circle' });
        this.log(`anchor: the invite was used by ${fp.slice(0, 16)}…; pairing back once it registers here`);
        this.o.onUsed?.(fp);
        const m = this.o.hub.members().find((x) => x.fp === fp);
        if (m) void this.pairBack(fp, m.name, m.kind);
      },
    });
    const peer: Peer = {
      id: this.o.id, name: this.o.name, host: ways[0].host, port: ways[0].port, secret: '', fp: this.o.identity.fp, pin, hpin, anchor: true,
      addrs: ways, kind: 'pc', ram: info.ram ?? null, bw: info.bw ?? null, added_at: new Date(this.now()).toISOString(),
    };
    const code = peerCode(peer);
    const invite: Invite = {
      whose, code, text: Buffer.from(code, 'base64url').toString('utf8'), exp, fp: this.o.identity.fp, addrs: ways,
      lanOnly: ways.every((a) => a.via === 'lan'),
      typed: { address: hp(ways[0].host, ways[0].port), code: pin, certificate: this.o.identity.fp.slice(0, 16) },
    };
    entry.invite = invite;
    this.last = entry;
    this.log(`anchor: a new invite, good for ${Math.round(ttl / 60_000)} minutes, once${invite.lanOnly ? ' (this network only: no address from outside yet)' : ''}`);
    return invite;
  }

  // the invite still open (not used, not run out); null otherwise
  current(): Invite | null {
    const l = this.last;
    return l && !l.used && this.now() < l.invite.exp && this.o.codes.has(l.pin) ? l.invite : null;
  }

  // pair-backs waiting for their member to register
  waiting(): number { return this.backs.size; }

  // The member that used an invite registered: pair with its gate through this computer's hub,
  // with the invite's hpin, and keep it in this computer's peer book (reached through 'self').
  private async pairBack(fp: string, name: string, kind: AnchorKind): Promise<void> {
    const b = this.backs.get(fp);
    if (!b || b.busy) return;
    if (this.now() > b.exp) { this.backs.delete(fp); this.log(`anchor: pairing back with ${fp.slice(0, 16)}… ran out of time; a new invite pairs again`); return; }
    b.busy = true;
    let s: Duplex | null = null;
    try {
      s = await this.o.hub.dialLocal(fp);
      try {
        const h = await handshake(s, '', 'api', this.o.timeoutMs ?? 8000, undefined, { identity: this.o.identity, fp, pin: b.hpin });
        h.socket.destroy();
      } catch (e) {
        // the proof passed (the certificate is pinned at TLS) but nothing listens on its api: paired all the same
        if (!(e instanceof GateRefused && e.reason === 'channel closed')) throw e;
      }
      this.backs.delete(fp);
      const peer = recordPairedBack(this.o.peersFile, fp, name, kind, b.ring);
      this.log(`anchor: paired back with ${peer.name} (${fp.slice(0, 16)}…): it can be used from here, through this computer's anchor`);
      this.o.onPairedBack?.(peer);
    } catch (e) {
      b.busy = false;
      this.log(`anchor: pairing back with ${fp.slice(0, 16)}… did not work (${(e as Error).message}); again when it registers next`);
    } finally {
      s?.destroy();
    }
  }

  close(): void {
    this.off();
    if (this.last && !this.last.used) this.o.codes.drop(this.last.pin);
  }
}

// The member in the anchor's peer book: pinned, paired, reached through this computer's anchor,
// with the ring the invite said (the person's own: home; a friend's: circle). A record it already
// has (by certificate) is kept and told so.
export function recordPairedBack(file: string, fp: string, name: string, kind: AnchorKind, ring: Ring = 'circle'): Peer {
  const list = readPeers(file);
  const now = new Date().toISOString();
  const old = list.find((p) => p.fp?.toLowerCase() === fp);
  const peer: Peer = old
    ? { ...old, pin: null, paired_at: old.paired_at ?? now, last_ok: now, ring, route: old.host ? old.route ?? null : { via: 'anchor', anchor: 'self' } }
    : {
      id: `anchor:${fp.slice(0, 16)}`, name: (name || `computer ${fp.slice(0, 8)}`).slice(0, 60), host: '', port: 0, secret: '', fp, pin: null, paired_at: now,
      route: { via: 'anchor', anchor: 'self' }, kind, ring, ram: null, bw: null, added_at: now, last_ok: now,
    };
  writePeers(upsertPeer(list, peer).list, file);
  return peer;
}

// ---- the store of joined anchors (the member's side) ----------------------------------------

export interface JoinedAnchor {
  fp: string;
  name: string;
  host: string;            // the address that answered when joining (tried first)
  port: number;
  addrs?: PeerAddr[];      // every way the invite named
  joined_at: string;
  hpin?: string | null;    // the pair-back code, until the anchor used it or it ran out
  hpinExp?: number | null;
}

export const joinedFile = (dir: string = home()): string => path.join(dir, 'anchors.json');

export function readJoined(file: string = joinedFile()): JoinedAnchor[] {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) return [];
    return list.filter((a) => a && typeof a.fp === 'string' && FP_RE.test(a.fp) && typeof a.host === 'string' && a.host && Number.isInteger(a.port) && a.port > 0 && a.port < 65536);
  } catch {
    return [];
  }
}

export function writeJoined(list: JoinedAnchor[], file: string = joinedFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function upsertJoined(file: string, a: JoinedAnchor): void {
  const list = readJoined(file).filter((x) => x.fp !== a.fp);
  writeJoined([...list, a], file);
}

export function removeJoined(file: string, fp: string): boolean {
  const list = readJoined(file);
  const next = list.filter((x) => x.fp !== fp.toLowerCase());
  if (next.length === list.length) return false;
  writeJoined(next, file);
  return true;
}

// the joined anchors as roads (EngineOptions.anchors, RoadContext.anchors)
export function joinedRoads(list: JoinedAnchor[]): PeerAnchor[] {
  return list.map((a) => ({ fp: a.fp, host: a.host, port: a.port, ...(a.name ? { name: a.name.slice(0, 40) } : {}) }));
}

// ---- joining (the member's side) ----------------------------------------------------------

// A gate's refusal of an invite, in plain words.
export function inviteWords(e: unknown, typedCert = false): string {
  if (e instanceof GateRefused) {
    switch (e.reason) {
      // a stolen invite used first: the real joiner learns what to do about the device that took it
      case 'pin used': return 'this invite was used already: each invite works once. ask for a new one. if it was not you who used it, tell the anchor\'s owner to remove the device that used it.';
      case 'pin expired': return 'this invite ran out (it works for 10 minutes). ask for a new one.';
      case 'wrong pin': return 'the code does not match the anchor\'s invite: check it, or ask for a new invite.';
      case 'not paired': return 'the anchor has no invite open: ask for a new one.';
      default: return `the anchor said no: ${e.reason}`;
    }
  }
  const m = (e as Error)?.message ?? String(e);
  if (m === FP_MISMATCH) return typedCert ? 'the certificate does not match what the anchor shows: not joining' : 'another computer answered there, not the anchor: not joining';
  return m;
}

// An anchor's own invite pasted on that same computer.
export const SELF_INVITE_WORDS = 'this invite is from this computer itself: it cannot join its own anchor. open the invite on the other computer that should join.';

// again: this computer had joined that anchor before (the same certificate is in the store); the
// page then says so instead of "joined" a second time
export interface JoinResult { peer: Peer; anchor: JoinedAnchor; at: PeerAddr; again: boolean }

// The page's words after an invite was pasted on a computer that had joined that anchor already.
export function joinedAgainWords(name: string): string {
  return `already joined: this computer joined ${name} before and stays linked to it. an invite works once, so this one is not needed here.`;
}

// Pairs with the anchor's gate using the invite's `pin`, along its addresses in order; keeps the
// anchor in the peer book (paired, pinned, `anchor: true`) and in the store of joined anchors with
// the pair-back code, which the member's gate opens once it registers (AnchorLinks).
export async function joinWithInvite(o: {
  peer: Peer; fpPrefix?: string | null; identity: GateIdentity; peersFile: string; joinedFile: string;
  timeoutMs?: number; connect?: (host: string, port: number, timeoutMs: number) => Promise<Duplex>; ttlMs?: number;
}): Promise<JoinResult> {
  const p = o.peer;
  const pin = p.pin;
  if (!pin) throw new Error('this is not an invite: it has no one-time code');
  const fpPrefix = String(o.fpPrefix ?? '').replace(/[\s-]/g, '').toLowerCase();
  if (fpPrefix && !/^[0-9a-f]+$/.test(fpPrefix)) throw new Error('the certificate is hex (0-9, a-f)');
  if (!p.fp && fpPrefix.length < FP_PREFIX_MIN) throw new Error(`type the start of the anchor's certificate too (${FP_PREFIX_MIN} letters and digits or more)`);
  // this computer's own invite pasted here: refused before anything is dialed or the code is spent
  const own = o.identity.fp.toLowerCase();
  if ((p.fp && p.fp.toLowerCase() === own) || (fpPrefix && own.startsWith(fpPrefix))) throw new Error(SELF_INVITE_WORDS);
  const timeoutMs = o.timeoutMs ?? 6000;
  const ways = candidates(p);
  if (!ways.length) throw new Error('the invite has no address');
  let fp: string | null = null;
  let at: PeerAddr | null = null;
  const missed: string[] = [];
  for (const w of ways) {
    let raw: Duplex;
    try { raw = await (o.connect ?? connectRemote)(w.host, w.port, Math.min(timeoutMs, 4000)); } catch (e) { missed.push(`${hp(w.host, w.port)} (${(e as Error).message})`); continue; }
    try {
      const h = await handshake(raw, '', 'api', timeoutMs, undefined, { identity: o.identity, fp: p.fp ?? '', pin, fpPrefix: fpPrefix || null });
      h.socket.destroy();
      fp = h.fp;
    } catch (e) {
      raw.destroy();
      // paired, but nothing listens on its api right now: the pinned certificate was shown at TLS
      if (e instanceof GateRefused && e.reason === 'channel closed' && p.fp) fp = p.fp;
      // someone else at this address: the next one may be the anchor
      else if ((e as Error).message === FP_MISMATCH && !fpPrefix) { missed.push(`${hp(w.host, w.port)} (another computer)`); continue; }
      else throw new Error(inviteWords(e, !!fpPrefix));
    }
    at = w;
    break;
  }
  if (!fp || !at) throw new Error(`the anchor does not answer at ${missed.join(', ')}: is it on, and is its door open from where you are?`);
  fp = fp.toLowerCase();
  const before = readJoined(o.joinedFile).find((a) => a.fp.toLowerCase() === fp) ?? null;
  const again = !!before;
  const now = new Date().toISOString();
  const rest: Peer = { ...p };
  delete rest.hpin;
  const first = ways[0];
  const peer: Peer = {
    ...rest,
    name: p.name || `anchor ${fp.slice(0, 8)}`,
    fp, pin: null, paired_at: now, last_ok: now, anchor: true, kind: 'pc', ring: p.ring ?? 'circle',
    route: at.host === first.host && at.port === first.port ? null : at,
  };
  writePeers(upsertPeer(readPeers(o.peersFile), peer).list, o.peersFile);
  const anchor: JoinedAnchor = {
    fp, name: peer.name, host: at.host, port: at.port, addrs: ways, joined_at: now,
    // joined before: the anchor paired back then (or still may with the code kept), so no new
    // pair-back code is opened and the page does not say "waiting for it to pair back" again
    ...(before
      ? { hpin: before.hpin ?? null, hpinExp: before.hpinExp ?? null }
      : { hpin: p.hpin ?? pairBackCode(pin), hpinExp: Date.now() + (o.ttlMs ?? INVITE_TTL_MS) }),
  };
  upsertJoined(o.joinedFile, anchor);
  return { peer, anchor, at, again };
}

// ---- the control connections to the joined anchors (the member's side) ---------------------

export type LinkState = 'registering' | 'registered' | 'lost' | 'replaced' | 'refused';
// waitingBack: the anchor has not paired back yet and the code for it is still open
export interface LinkView { fp: string; name: string; at: string; state: LinkState; why: string | null; waitingBack: boolean }

interface Link {
  a: JoinedAnchor; state: LinkState; why: string | null; m: AnchorMembership | null;
  timer: NodeJS.Timeout | null; tries: number; way: number;
  busy: boolean;    // a register is under way
  fresh: boolean;   // a new address came in meanwhile
}

export interface AnchorLinksOptions {
  identity: GateIdentity;
  name: string;
  kind: AnchorKind;
  gatePort: number;          // this computer's gate: streams the anchor opens are piped into it
  file: string;              // the store of joined anchors
  codes: OneTimeCodes;       // this gate's extra codes: the pair-back codes go here
  log?: Log;
  join?: typeof joinAnchor;  // tests
  pollMs?: number;           // the store is looked at again this often (a `peers add` in a terminal)
  retryMs?: number;          // the first wait after a failed register; doubles up to a minute
  // the address book (addressbook.ts AddressBook): over every link this computer's own record is
  // given, with the records of the other anchors it joined (so anchors learn each other), the
  // pinned devices are asked about, and what comes back is checked and taken there
  book?: LinkBook;
  bookMs?: number;           // how often each link gives and asks again; 60 s
}

export interface LinkBook {
  own(): AddrRecord | null;
  held(fp: string): AddrRecord | null;
  wants(): { fp: string; seq: number }[];
  accept(x: unknown, via: string | null): unknown;
}

// Registers this computer with every anchor it joined and keeps it registered: a lost connection
// comes back (joinAnchor), a refused first try is tried again with backoff along the anchor's
// addresses. The store is read again when it changes.
export class AnchorLinks {
  private readonly links = new Map<string, Link>();
  private poll: NodeJS.Timeout | null = null;
  private stamp = '';
  private closed = false;

  constructor(private readonly o: AnchorLinksOptions) {}

  private log(s: string) { this.o.log?.(s); }

  start(): void {
    this.refresh(true);
    this.poll = setInterval(() => this.refresh(), this.o.pollMs ?? 5000);
    this.poll.unref();
  }

  refresh(force = false): void {
    if (this.closed) return;
    let now = 'none';
    try { const st = fs.statSync(this.o.file); now = `${st.mtimeMs}:${st.size}`; } catch {}
    if (!force && now === this.stamp) return;
    this.stamp = now;
    const list = readJoined(this.o.file);
    const want = new Set(list.map((a) => a.fp));
    for (const [fp, l] of this.links) {
      if (want.has(fp)) continue;
      this.links.delete(fp);
      if (l.timer) clearTimeout(l.timer);
      void l.m?.close();
      this.log(`anchor ${l.a.name}: left (no longer in the joined anchors)`);
    }
    for (const a of list) {
      this.openCode(a);
      const l = this.links.get(a.fp);
      if (l) {
        const moved = JSON.stringify(this.ways(l.a)) !== JSON.stringify(this.ways(a));
        l.a = a;
        // the anchor has a new address (the address book): a link that is not registered goes
        // there now instead of on dialling the old one
        if (moved && l.state !== 'registered') this.redial(l);
        continue;
      }
      const link: Link = { a, state: 'registering', why: null, m: null, timer: null, tries: 0, way: 0, busy: false, fresh: false };
      this.links.set(a.fp, link);
      void this.connect(a.fp);
    }
  }

  // the pair-back code: open on this gate for the anchor's certificate only, until used or run out
  private openCode(a: JoinedAnchor) {
    if (!a.hpin || !a.hpinExp) return;
    const left = a.hpinExp - Date.now();
    if (left <= 0 || this.o.codes.has(a.hpin)) return;
    this.o.codes.add(a.hpin, left, {
      only: a.fp,
      onUsed: () => {
        const list = readJoined(this.o.file);
        const hit = list.find((x) => x.fp === a.fp);
        if (hit) { hit.hpin = null; hit.hpinExp = null; writeJoined(list, this.o.file); }
        const l = this.links.get(a.fp);
        if (l) l.a = { ...l.a, hpin: null, hpinExp: null };
        this.log(`anchor ${a.name}: paired back; it can use this computer now`);
      },
    });
  }

  private ways(a: JoinedAnchor): { host: string; port: number }[] {
    const out = [{ host: a.host, port: a.port }];
    for (const w of a.addrs ?? []) if (!out.some((o) => o.host === w.host && o.port === w.port)) out.push({ host: w.host, port: w.port });
    return out;
  }

  // A link to an anchor that has a new address: the old membership (which keeps dialling the old
  // address) is closed and the new one dialled at once. A register under way finishes first; when
  // it fails, its retry takes the new address.
  private redial(l: Link) {
    if (this.closed) return;
    if (l.busy) { l.fresh = true; return; }
    if (l.timer) { clearTimeout(l.timer); l.timer = null; }
    const old = l.m;
    l.m = null;
    void old?.close();
    l.way = 0;
    l.tries = 0;
    this.log(`anchor ${l.a.name}: its address changed (${hp(l.a.host, l.a.port)}); linking there`);
    void this.connect(l.a.fp);
  }

  // The address book over one link: this computer's record and the other joined anchors' records
  // are given, the pinned devices asked about, and what the anchor hands over is taken (checked
  // there, never on the anchor's word).
  private bookFor(fp: string): AnchorBook | undefined {
    const b = this.o.book;
    if (!b) return undefined;
    return {
      give: () => {
        const out: AddrRecord[] = [];
        const own = b.own();
        if (own) out.push(own);
        for (const other of this.links.keys()) {
          if (other === fp) continue;
          const r = b.held(other);
          if (r) out.push(r);
        }
        return out;
      },
      wants: () => b.wants(),
      take: (rec) => { b.accept(rec, fp); },
      everyMs: this.o.bookMs,
    };
  }

  private async connect(fp: string): Promise<void> {
    const l = this.links.get(fp);
    if (!l || this.closed || l.busy) return;
    l.timer = null;
    l.busy = true;
    const ways = this.ways(l.a);
    const ref = ways[l.way % ways.length];
    l.state = 'registering';
    try {
      let mine: AnchorMembership | null = null;
      const m = await (this.o.join ?? joinAnchor)({
        anchor: { host: ref.host, port: ref.port, fp }, identity: this.o.identity, name: this.o.name, kind: this.o.kind, gatePort: this.o.gatePort, log: this.o.log,
        book: this.bookFor(fp),
        onState: (s) => {
          // a membership closed for a new address says nothing about the link any more
          if (mine && l.m !== mine) return;
          l.state = s;
          l.why = s === 'lost' ? 'the connection to it was lost; trying again' : s === 'replaced' ? 'this computer registered there again from somewhere else; this connection stepped back' : null;
        },
      });
      mine = m;
      l.busy = false;
      if (this.closed || this.links.get(fp) !== l) { await m.close(); return; }
      l.m = m; l.state = 'registered'; l.why = null; l.tries = 0;
      // the store's own address first from now on
      if (ref.host !== l.a.host || ref.port !== l.a.port) {
        const list = readJoined(this.o.file);
        const hit = list.find((x) => x.fp === fp);
        if (hit) { hit.host = ref.host; hit.port = ref.port; writeJoined(list, this.o.file); this.stamp = ''; }
      }
    } catch (e) {
      l.busy = false;
      if (this.closed || this.links.get(fp) !== l) return;
      const refused = e instanceof GateRefused;
      l.state = refused ? 'refused' : 'lost';
      l.why = refused && e.reason === 'not paired'
        ? 'the anchor does not know this computer (any more): ask its owner for a new invite'
        : refused ? `the anchor said no: ${e.reason}` : `it does not answer at ${hp(ref.host, ref.port)} (${(e as Error).message})`;
      // a new address came in while this try ran: the next try is there, soon
      if (l.fresh) { l.fresh = false; l.tries = 0; l.way = 0; }
      else l.way++;
      l.tries++;
      const delay = Math.min((this.o.retryMs ?? 2000) * 2 ** Math.min(l.tries - 1, 6), 60_000);
      l.timer = setTimeout(() => void this.connect(fp), delay);
      l.timer.unref();
    }
  }

  view(): LinkView[] {
    return [...this.links.values()].map((l) => ({
      fp: l.a.fp, name: l.a.name, at: hp(l.a.host, l.a.port), state: l.state, why: l.why,
      waitingBack: !!l.a.hpin && (l.a.hpinExp ?? 0) > Date.now(),
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    for (const l of this.links.values()) { if (l.timer) clearTimeout(l.timer); await l.m?.close(); }
    this.links.clear();
  }
}

// One line per joined anchor, for the page and the log.
export function linkWords(v: LinkView): string {
  const s = v.state === 'registered' ? `linked (${v.at})` : v.state === 'registering' ? `linking to ${v.at}…` : v.why ?? v.state;
  return `${v.name}: ${s}${v.state === 'registered' && v.waitingBack ? '; waiting for it to pair back' : ''}`;
}
