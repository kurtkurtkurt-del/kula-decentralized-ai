// The anchor (docs/ANCHOR.md): a reachable circle computer whose gate carries bytes between
// two of its members that cannot reach each other. It is the gate's third channel, `anchor`,
// inside the usual KULA2 handshake: the TLS client certificate is the proof, a member is a
// fingerprint in the gate's paired set or pinned (with paired_at) in this computer's peer book,
// and there is no pin path on this channel. After `OK -` comes one JSON line:
//
//   control   → {t:"register", name, kind}         ← {t:"registered"}
//             ← {t:"open", sid, from}               a member wants a stream to you: accept it
//             → {t:"ping"}                          ← {t:"pong"}           (every 25 s)
//             ← {t:"error", reason:"replaced"}      the same certificate registered again
//             ← {t:"record", rec}                   right after registered: the anchor's own address record
//             → {t:"record", rec}                   a record to carry (the member's own, another anchor's)
//             → {t:"who", fps, seqs}                ← {t:"record", rec} for each one held that is newer
//   dialer    → {t:"dial", to:<64 hex fp>}          ← {t:"ready"} | {t:"error", reason}
//   target    → {t:"accept", sid}                   ← {t:"ready"} | {t:"error", reason}
//
// Address records (addrrecord.ts, docs/ANCHOR.md "address book") are signed by the device they
// describe; the anchor checks the signature only so as not to carry rubbish, keeps the newest per
// fingerprint, and hands one to a member only when it is about a member of this anchor or about
// an anchor one of its registered members names. Whoever takes a record checks it again: the
// anchor is never trusted for it.
//
// After "ready" the dialer's and the target's connections are piped raw: the dialer runs a
// fresh gate handshake (TLS 1.3 between the two devices' own certificates) inside, so the
// anchor carries only TLS records. Membership grants no api or rpc rights here: those are the
// target's own gate's decision. The message set is the hosted relay's (node/relay), without its
// WebSocket, codes, sessions or tokens: register, accept and dial are bound to the certificate.
import fs from 'node:fs';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { LineReader, pipeBoth, handshake, connectRemote, GateRefused, HANDSHAKE_MS } from './gate.js';
import type { GateIdentity, Paired } from './tls.js';
import { checkRecord, type AddrRecord } from './addrrecord.js';

export interface AnchorCaps {
  streamsPerMember: number;  // open (and waiting) streams one member has dialed
  streamsTotal: number;      // every stream through this anchor
  // a friend's device's dials (capped members only): a bucket of dialBurst dials, refilled at
  // dialsPerMinute. llama.cpp opens ~13 short rpc connections per far worker per load, and one
  // refused dial aborts llama-server, so a load must fit in the burst
  dialsPerMinute: number;
  dialBurst: number;
  bytesPerDay: number;       // both ways, per dialing member, per UTC day; then new streams are refused and running ones cut
}

// the defaults the person can change (share's `anchor` option, setCaps)
export const ANCHOR_CAPS: AnchorCaps = { streamsPerMember: 16, streamsTotal: 128, dialsPerMinute: 30, dialBurst: 120, bytesPerDay: 5_000_000_000 };
export const ANCHOR_PING_MS = 25_000;
// how long the target has to accept a stream
export const ANCHOR_ACCEPT_MS = 10_000;
// a control connection that sent nothing (not even a ping) for this long is gone
export const ANCHOR_CONTROL_SILENCE_MS = 3 * ANCHOR_PING_MS;
// tcp keepalive on every anchor leg: dead legs are found this way, never by an idle cut
export const ANCHOR_KEEPALIVE_MS = 30_000;

export const FP_RE = /^[0-9a-f]{64}$/;
export type AnchorKind = 'pc' | 'phone' | 'tablet';
const KINDS: AnchorKind[] = ['pc', 'phone', 'tablet'];
const DAY_MS = 86_400_000;

// What the anchor learns, and nothing more: who (fingerprints), when, how many bytes, from
// which address. `peer` is 'self' for this computer's own in-process dials.
export type AnchorEvent =
  | { type: 'register'; fp: string; peer: string; name: string; kind: AnchorKind; at: number; replaced: boolean }
  | { type: 'leave'; fp: string; peer: string; at: number; why: string }
  | { type: 'open'; sid: string; from: string; to: string; peer: string; at: number }
  | { type: 'close'; sid: string; from: string; to: string; peer: string; at: number; ms: number; bytes: number }
  | { type: 'refuse'; fp: string | null; peer: string; at: number; reason: string; to?: string };

export interface AnchorOptions {
  self: string;                       // this computer's certificate fingerprint (its own dials)
  isMember: (fp: string) => boolean;  // circleMembers() in share
  caps?: Partial<AnchorCaps>;
  // whether a dialing member's bytes a day are capped (16.11.2026, the person's decision): a
  // friend's device is, the person's own (ring home) is not. Asked again on every check, so a
  // ring changed meanwhile counts at once. Default: every member is capped. The stream and dial
  // caps hold for everyone (they guard against a broken device).
  capped?: (fp: string) => boolean;
  acceptTimeoutMs?: number;
  controlSilenceMs?: number;
  // this computer's own address record (addressbook.ts AddressBook.own): handed to every member
  // when it registers, and to a `who` about this computer
  record?: () => AddrRecord | null;
  // `who` lines answered per member: a bucket of `burst`, refilled at `perMinute` (default 60, 120)
  whoRate?: { burst: number; perMinute: number };
  // tests: every byte the anchor carries, as it sees it
  tap?: (dir: 'd→t' | 't→d', data: Buffer) => void;
  // tests: a dishonest anchor changes the records it hands out
  handOut?: (rec: AddrRecord) => unknown;
  now?: () => number;
}

// the most address records one anchor carries
export const ANCHOR_MAX_RECORDS = 512;
// fingerprints in one `who` line
const WHO_MAX = 32;

// Who may use this computer's anchor: a certificate in the gate's paired set (it paired with
// this computer's code), or one this computer pinned and paired with as a master (peers.json,
// `paired_at` set). The second is needed because pairing is directional: a phone paired by the
// host qr has this computer in its list, not the reverse. The peer book is read again when the
// file changed.
export function circleMembers(paired: Paired, peersFile: string | null): (fp: string) => boolean {
  let stamp = '';
  let pinned = new Set<string>();
  const book = (): Set<string> => {
    if (!peersFile) return pinned;
    let now = 'none';
    try { const st = fs.statSync(peersFile); now = `${st.mtimeMs}:${st.size}`; } catch {}
    if (now === stamp) return pinned;
    stamp = now;
    pinned = new Set();
    try {
      const list = JSON.parse(fs.readFileSync(peersFile, 'utf8'));
      if (Array.isArray(list)) for (const p of list) if (p && typeof p.fp === 'string' && FP_RE.test(p.fp.toLowerCase()) && p.paired_at) pinned.add(p.fp.toLowerCase());
    } catch {}
    return pinned;
  };
  return (fp: string) => paired.has(fp) || book().has(fp);
}

// A token bucket per member: `burst` dials at once, then `perMinute` more a minute.
class DialBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  take(key: string, burst: number, perMinute: number, now: number): boolean {
    const b = this.buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (Math.max(0, now - b.at) * perMinute) / 60_000);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

// Two connected in-process duplex ends with backpressure: what one writes, the other reads.
// The anchor's own dials ('self') use one end as the dialer's leg.
export function duplexPair(): [Duplex, Duplex] {
  const sides: Duplex[] = [];
  // waits[i]: the write callback held until side i's reader asks for more
  const waits: ((() => void) | null)[] = [null, null];
  const make = (i: 0 | 1) => new Duplex({
    read() { const w = waits[i]; if (w) { waits[i] = null; w(); } },
    write(chunk, _enc, cb) {
      const o = 1 - i;
      if (sides[o].destroyed) return cb(new Error('closed'));
      if (sides[o].push(chunk)) cb(); else waits[o] = cb;
    },
    final(cb) { if (!sides[1 - i].destroyed) sides[1 - i].push(null); cb(); },
    destroy(err, cb) { waits[1 - i] = null; const o = sides[1 - i]; if (!o.destroyed) o.destroy(); cb(err); },
  });
  sides.push(make(0), make(1));
  return [sides[0], sides[1]];
}

const send = (s: Duplex, o: Record<string, unknown>) => { try { if (!s.destroyed) s.write(JSON.stringify(o) + '\n'); } catch {} };
const SAFE = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, '').slice(0, max) : '');

interface Member {
  fp: string; peer: string; name: string; kind: AnchorKind; since: number;
  conn: Duplex;
  pending: Map<string, { resolve: (leg: { conn: Duplex; reader: LineReader }) => void; reject: (why: string) => void; timer: NodeJS.Timeout }>;
}

interface Stream {
  sid: string; from: string; to: string; peer: string; self: boolean; at: number;
  open: boolean; bytes: number;
  legs: Duplex[];
}

interface Dialer { fp: string; peer: string; conn: Duplex; reader: LineReader | null; self: boolean }

export class AnchorRefused extends Error {
  constructor(readonly reason: string) { super(`anchor: ${reason}`); }
}

export class AnchorHub {
  readonly caps: AnchorCaps;
  private readonly registry = new Map<string, Member>();
  private readonly streams = new Map<string, Stream>();
  private readonly listeners = new Set<(e: AnchorEvent) => void>();
  private readonly dials = new DialBucket();
  private readonly whos = new DialBucket();
  private readonly records = new Map<string, AddrRecord>();
  private readonly days = new Map<string, { day: number; bytes: number }>();
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly opts: AnchorOptions) {
    this.caps = { ...ANCHOR_CAPS };
    this.setCaps(opts.caps ?? {});
    this.now = opts.now ?? Date.now;
  }

  // the person changes the caps; a value that is not a positive number is ignored
  setCaps(c: Partial<AnchorCaps>): void {
    for (const k of Object.keys(ANCHOR_CAPS) as (keyof AnchorCaps)[]) {
      const v = c[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) this.caps[k] = Math.floor(v);
    }
  }

  isMember(fp: string): boolean { return fp !== this.opts.self && this.opts.isMember(fp); }

  // the daily byte cap applies to this dialing member (never to this computer's own dials)
  capped(fp: string): boolean {
    if (fp === this.opts.self) return false;
    try { return this.opts.capped ? this.opts.capped(fp) : true; } catch { return true; }
  }

  on(f: (e: AnchorEvent) => void): () => void { this.listeners.add(f); return () => { this.listeners.delete(f); }; }

  private emit(e: AnchorEvent) { for (const f of this.listeners) { try { f(e); } catch {} } }

  // the gate's refusal before the JSON line (a stranger), for the same event stream
  refused(peer: string, fp: string | null, reason: string): void { this.emit({ type: 'refuse', fp, peer, at: this.now(), reason }); }

  members(): { fp: string; name: string; kind: AnchorKind; peer: string; since: number }[] {
    return [...this.registry.values()].map((m) => ({ fp: m.fp, name: m.name, kind: m.kind, peer: m.peer, since: m.since }));
  }

  stats(): { members: number; streams: number; bytesToday: Record<string, number> } {
    const day = Math.floor(this.now() / DAY_MS);
    const bytesToday: Record<string, number> = {};
    for (const [fp, d] of this.days) if (d.day === day) bytesToday[fp] = d.bytes;
    return { members: this.registry.size, streams: this.streams.size, bytesToday };
  }

  // A member's access was removed: unless it is still a member another way, its control
  // connection and its streams (both ends) are cut. Returns how many connections.
  drop(fp: string): number {
    if (this.opts.isMember(fp)) return 0;
    let n = 0;
    const m = this.registry.get(fp);
    if (m) { this.registry.delete(fp); this.failPending(m, 'target gone'); m.conn.destroy(); n++; this.emit({ type: 'leave', fp, peer: m.peer, at: this.now(), why: 'removed' }); }
    for (const s of this.streams.values()) if (s.from === fp || s.to === fp) { for (const l of s.legs) l.destroy(); n++; }
    return n;
  }

  close(): void {
    this.closed = true;
    for (const m of this.registry.values()) { this.failPending(m, 'anchor closing'); m.conn.destroy(); }
    this.registry.clear();
    for (const s of this.streams.values()) for (const l of s.legs) l.destroy();
  }

  // The gate hands over a member's connection after `OK -`: the next line says what it wants.
  // `done` gives the gate's handshake slot back. Never throws.
  async serve(socket: Duplex, reader: LineReader, who: { fp: string; peer: string }, done: () => void): Promise<void> {
    try {
      let line: string;
      try { line = await reader.line(HANDSHAKE_MS); } catch { return this.refuse(socket, who.fp, who.peer, 'no request'); }
      let msg: any;
      try { msg = JSON.parse(line); } catch { return this.refuse(socket, who.fp, who.peer, 'bad request'); }
      done();
      if (this.closed) return this.refuse(socket, who.fp, who.peer, 'anchor closing');
      switch (msg?.t) {
        case 'register': return await this.register(socket, reader, who, msg);
        case 'dial': {
          const d: Dialer = { fp: who.fp, peer: who.peer, conn: socket, reader, self: false };
          return await this.run(d, String(msg.to ?? '').toLowerCase(), () => send(socket, { t: 'ready' }), (why) => this.refuse(socket, who.fp, who.peer, why, String(msg.to ?? '').slice(0, 64)));
        }
        case 'accept': {
          const m = this.registry.get(who.fp);
          const sid = String(msg.sid ?? '');
          const p = m?.pending.get(sid);
          if (!m || !p) return this.refuse(socket, who.fp, who.peer, 'no such stream');
          m.pending.delete(sid);
          clearTimeout(p.timer);
          p.resolve({ conn: socket, reader });
          return;
        }
        default: return this.refuse(socket, who.fp, who.peer, 'bad request');
      }
    } catch {
      socket.destroy();
    }
  }

  // This computer's own dial ('self'): a reachable computer is the anchor for its own peers, so
  // reaching a member that registered here is one hop, in-process. Resolves with a duplex piped
  // into the target's gate, ready for the gate handshake. The person's own dials count toward
  // the total, not toward a member's caps.
  dialLocal(to: string): Promise<Duplex> {
    const [mine, theirs] = duplexPair();
    return new Promise<Duplex>((resolve, reject) => {
      const d: Dialer = { fp: this.opts.self, peer: 'self', conn: theirs, reader: null, self: true };
      void this.run(d, to.toLowerCase(), () => resolve(mine), (why) => {
        this.emit({ type: 'refuse', fp: this.opts.self, peer: 'self', at: this.now(), reason: why, to: to.slice(0, 64) });
        mine.destroy(); theirs.destroy();
        reject(new GateRefused(why));
      });
    });
  }

  private refuse(socket: Duplex, fp: string | null, peer: string, reason: string, to?: string) {
    this.emit({ type: 'refuse', fp, peer, at: this.now(), reason, ...(to ? { to } : {}) });
    send(socket, { t: 'error', reason });
    try { socket.end(); } catch {}
    setTimeout(() => socket.destroy(), 200).unref();
  }

  private failPending(m: Member, why: string) {
    for (const p of m.pending.values()) { clearTimeout(p.timer); p.reject(why); }
    m.pending.clear();
  }

  private async register(socket: Duplex, reader: LineReader, who: { fp: string; peer: string }, msg: any) {
    const kind: AnchorKind = KINDS.includes(msg.kind) ? msg.kind : 'pc';
    const m: Member = { fp: who.fp, peer: who.peer, name: SAFE(msg.name, 40), kind, since: this.now(), conn: socket, pending: new Map() };
    // one control connection per member: a second register from the same certificate replaces
    // the first, which is told so and does not come back by itself
    const old = this.registry.get(who.fp);
    this.registry.set(who.fp, m);
    if (old) {
      this.failPending(old, 'target replaced');
      send(old.conn, { t: 'error', reason: 'replaced' });
      try { old.conn.end(); } catch {}
      setTimeout(() => old.conn.destroy(), 200).unref();
    }
    send(socket, { t: 'registered' });
    // this anchor's own record: a member that dialled it at an old address learns the new one here
    const own = this.ownRecord();
    if (own) send(socket, { t: 'record', rec: own });
    this.emit({ type: 'register', fp: who.fp, peer: who.peer, name: m.name, kind, at: this.now(), replaced: !!old });
    let why = 'closed';
    const silence = this.opts.controlSilenceMs ?? ANCHOR_CONTROL_SILENCE_MS;
    while (this.registry.get(who.fp) === m) {
      let line: string;
      try { line = await reader.line(silence); } catch (e) { why = (e as Error).message === 'timeout' ? 'silent' : 'closed'; break; }
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (o?.t === 'ping') send(socket, { t: 'pong' });
      else if (o?.t === 'record') this.carry(who.fp, o.rec);
      else if (o?.t === 'who') this.answerWho(socket, who.fp, o);
    }
    if (this.registry.get(who.fp) === m) {
      this.registry.delete(who.fp);
      this.failPending(m, 'target gone');
      this.emit({ type: 'leave', fp: who.fp, peer: who.peer, at: this.now(), why });
    }
    socket.destroy();
  }

  private ownRecord(): AddrRecord | null {
    try { return this.opts.record?.() ?? null; } catch { return null; }
  }

  // Whether a record about `fp` may be carried and handed out: `fp` is a member of this anchor,
  // or an anchor that a registered member's own record names (anchors learn each other this way).
  private knows(fp: string): boolean {
    if (this.opts.isMember(fp)) return true;
    for (const m of this.registry.keys()) if (this.records.get(m)?.anchors.some((a) => a.fp === fp)) return true;
    return false;
  }

  // A member gave a record: kept when it is signed by the certificate it names, about the giver
  // itself, a member, or an anchor the giver's own record names, and newer than the one kept.
  private carry(from: string, x: unknown): void {
    const c = checkRecord(x);
    if (!c.ok) return;
    const rec = c.rec;
    if (rec.fp === this.opts.self) return;
    const named = this.records.get(from)?.anchors.some((a) => a.fp === rec.fp) ?? false;
    if (rec.fp !== from && !named && !this.opts.isMember(rec.fp)) return;
    const old = this.records.get(rec.fp);
    if (old && old.seq >= rec.seq) return;
    if (!old && this.records.size >= ANCHOR_MAX_RECORDS) return;
    this.records.set(rec.fp, rec);
  }

  // `who`: the records held about the fingerprints asked for, each newer than the seq the member
  // has, one line each. Only about members and the anchors members name; this anchor's own too.
  private answerWho(socket: Duplex, from: string, o: any): void {
    const r = this.opts.whoRate ?? { burst: 60, perMinute: 120 };
    if (!this.whos.take(from, r.burst, r.perMinute, this.now())) return;
    const fps: unknown[] = Array.isArray(o.fps) ? o.fps.slice(0, WHO_MAX) : [];
    const seqs: unknown[] = Array.isArray(o.seqs) ? o.seqs : [];
    fps.forEach((f, i) => {
      if (typeof f !== 'string' || !FP_RE.test(f) || f === from) return;
      const have = Number(seqs[i]) || 0;
      const rec = f === this.opts.self ? this.ownRecord() : this.knows(f) ? this.records.get(f) ?? null : null;
      if (!rec || rec.seq <= have) return;
      send(socket, { t: 'record', rec: this.opts.handOut ? this.opts.handOut(rec) : rec });
    });
  }

  // the record this anchor carries for a device (tests, the page); null when none
  carried(fp: string): AddrRecord | null { return this.records.get(fp) ?? null; }

  private dayBytes(fp: string): { day: number; bytes: number } {
    const day = Math.floor(this.now() / DAY_MS);
    let d = this.days.get(fp);
    if (!d || d.day !== day) { d = { day, bytes: 0 }; this.days.set(fp, d); }
    return d;
  }

  private streamsOf(fp: string): number {
    let n = 0;
    for (const s of this.streams.values()) if (s.from === fp) n++;
    return n;
  }

  // One stream: the caps, the open to the target, its accept, then the pipe. `ready` is called
  // just before the pipe starts, `refuse` instead of it.
  private async run(d: Dialer, to: string, ready: () => void, refuse: (why: string) => void): Promise<void> {
    const now = this.now();
    if (!FP_RE.test(to)) return refuse('bad dial');
    if (!d.self) {
      // the dial rate is a friend's device's cap; the person's own (ring home) have none
      if (this.capped(d.fp) && !this.dials.take(d.fp, this.caps.dialBurst, this.caps.dialsPerMinute, now)) return refuse('too many dials');
      if (this.capped(d.fp) && this.dayBytes(d.fp).bytes >= this.caps.bytesPerDay) return refuse('byte limit');
      if (this.streamsOf(d.fp) >= this.caps.streamsPerMember) return refuse('too many streams');
    }
    if (this.streams.size >= this.caps.streamsTotal) return refuse('full');
    const target = this.registry.get(to);
    if (!target) return refuse('not here');
    let sid = randomBytes(8).toString('hex');
    while (this.streams.has(sid)) sid = randomBytes(8).toString('hex');
    // the slot is held from here, so caps count a stream that is still waiting for its accept
    const s: Stream = { sid, from: d.fp, to, peer: d.peer, self: d.self, at: now, open: false, bytes: 0, legs: [d.conn] };
    this.streams.set(sid, s);
    let leg: { conn: Duplex; reader: LineReader };
    try {
      leg = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { target.pending.delete(sid); reject('did not accept'); }, this.opts.acceptTimeoutMs ?? ANCHOR_ACCEPT_MS);
        timer.unref();
        target.pending.set(sid, { resolve, reject, timer });
        // the dialer left while waiting
        d.conn.once('close', () => { const p = target.pending.get(sid); if (p) { clearTimeout(p.timer); target.pending.delete(sid); reject('dialer gone'); } });
        send(target.conn, { t: 'open', sid, from: d.fp });
      });
    } catch (why) {
      this.streams.delete(sid);
      return refuse(String(why));
    }
    if (d.conn.destroyed || this.closed) { this.streams.delete(sid); leg.conn.destroy(); return; }
    s.legs.push(leg.conn);
    s.open = true;
    send(leg.conn, { t: 'ready' });
    ready();
    const restD = d.reader?.release() ?? Buffer.alloc(0);
    const restT = leg.reader.release();
    this.emit({ type: 'open', sid, from: d.fp, to, peer: d.peer, at: this.now() });
    const count = (dir: 'd→t' | 't→d', c: Buffer) => {
      this.opts.tap?.(dir, c);
      s.bytes += c.length;
      const day = this.dayBytes(d.fp);
      day.bytes += c.length;
      // over the day's bytes: this member's running streams are cut too (a capped member only)
      if (!d.self && day.bytes > this.caps.bytesPerDay && this.capped(d.fp)) {
        for (const o of this.streams.values()) if (o.from === d.fp) for (const l of o.legs) l.destroy();
      }
    };
    if (restD.length) count('d→t', restD);
    if (restT.length) count('t→d', restT);
    d.conn.on('data', (c: Buffer) => count('d→t', c));
    leg.conn.on('data', (c: Buffer) => count('t→d', c));
    await pipeBoth(d.conn, leg.conn, restD, restT);
    this.streams.delete(sid);
    const over = !d.self && this.dayBytes(d.fp).bytes > this.caps.bytesPerDay && this.capped(d.fp);
    if (over) this.emit({ type: 'refuse', fp: d.fp, peer: d.peer, at: this.now(), reason: 'byte limit', to });
    this.emit({ type: 'close', sid, from: d.fp, to, peer: d.peer, at: this.now(), ms: this.now() - s.at, bytes: s.bytes });
  }
}

// --- a member's side ------------------------------------------------------------------

// Where an anchor is: its gate's address and its certificate fingerprint (pinned: whoever
// answers there with another certificate is not the anchor). `connect` replaces the tcp
// connect (tests, a later road).
export interface AnchorRef { host: string; port: number; fp: string; connect?: () => Promise<Duplex> }

type Log = (s: string) => void;

async function openAnchor(ref: AnchorRef, identity: GateIdentity, timeoutMs: number): Promise<{ socket: Duplex; reader: LineReader }> {
  const raw = ref.connect ? await ref.connect() : await connectRemote(ref.host, ref.port, timeoutMs);
  if (raw instanceof net.Socket) { raw.setNoDelay(true); raw.setKeepAlive(true, ANCHOR_KEEPALIVE_MS); }
  try {
    const h = await handshake(raw, '', 'anchor', timeoutMs, undefined, { identity, fp: ref.fp });
    const reader = new LineReader(h.socket);
    if (h.rest.length) reader.feed(h.rest);
    return { socket: h.socket, reader };
  } catch (e) {
    raw.destroy();
    throw e;
  }
}

async function ask(socket: Duplex, reader: LineReader, msg: Record<string, unknown>, timeoutMs: number): Promise<any> {
  socket.write(JSON.stringify(msg) + '\n');
  const line = await reader.line(timeoutMs);
  try { return JSON.parse(line); } catch { throw new Error(`anchor: bad answer ${JSON.stringify(line.slice(0, 60))}`); }
}

const reasonOf = (o: any): string => (o && o.t === 'error' ? String(o.reason) : `unexpected ${JSON.stringify(o)?.slice(0, 80)}`);

// A stream to the member `to` through the anchor, piped into its gate: the caller runs the gate
// handshake on it (Tunnel, probe), so the target's own gate decides and pins. Refusals come back
// as GateRefused with the anchor's reason ("not here", "too many streams", ...).
export async function dialAnchor(ref: AnchorRef, identity: GateIdentity, to: string, timeoutMs = HANDSHAKE_MS + ANCHOR_ACCEPT_MS): Promise<Duplex> {
  const { socket, reader } = await openAnchor(ref, identity, Math.min(timeoutMs, HANDSHAKE_MS));
  try {
    const r = await ask(socket, reader, { t: 'dial', to: to.toLowerCase() }, timeoutMs);
    if (r?.t !== 'ready') throw new GateRefused(reasonOf(r));
    const rest = reader.release();
    // nothing is lost between here and whoever reads next
    socket.pause();
    if (rest.length) socket.unshift(rest);
    return socket;
  } catch (e) {
    reader.release();
    socket.destroy();
    throw e;
  }
}

export interface AnchorMemberOptions {
  anchor: AnchorRef;
  identity: GateIdentity;
  name: string;
  kind: AnchorKind;
  gatePort: number;            // this device's own gate: every accepted stream is piped into it on 127.0.0.1
  log?: Log;
  pingMs?: number;             // default 25 s
  retryMs?: number;            // first reconnect delay, doubles up to 30 s
  timeoutMs?: number;
  onState?: (state: 'registered' | 'lost' | 'replaced') => void;
  // the address book (addressbook.ts) over this control connection: on every register and then
  // every `everyMs` (default 60 s) the records in `give()` not given yet on this connection are
  // given, and `wants()` is asked about (`who`); every record the anchor hands over goes to `take`
  book?: AnchorBook;
}

export interface AnchorBook {
  give(): AddrRecord[];                       // this device's own record first, then other anchors'
  wants(): { fp: string; seq: number }[];     // what to ask about, with the seq already held
  take(rec: unknown): void;                   // a record the anchor handed over (unchecked)
  everyMs?: number;
}

export const ANCHOR_BOOK_MS = 60_000;

export interface AnchorMembership {
  readonly registered: boolean;
  readonly replaced: boolean;
  close(): Promise<void>;
}

// Registers this device with an anchor and keeps the control connection: a ping every 25 s,
// a reconnect with backoff when it is lost. A second register from the same certificate
// replaces this one: then it stops and says "replaced" instead of fighting back. Resolves once
// registered the first time, rejects when that first attempt fails.
export function joinAnchor(opts: AnchorMemberOptions): Promise<AnchorMembership> {
  const log = opts.log ?? (() => {});
  const pingMs = opts.pingMs ?? ANCHOR_PING_MS;
  const timeoutMs = opts.timeoutMs ?? HANDSHAKE_MS;
  const firstDelay = opts.retryMs ?? 1000;
  let delay = firstDelay;
  let control: Duplex | null = null;
  let registered = false;
  let replaced = false;
  let closed = false;
  let retry: NodeJS.Timeout | null = null;
  const streams = new Set<Duplex>();

  const accept = async (sid: string, from: string) => {
    let socket: Duplex | null = null;
    let local: net.Socket | null = null;
    try {
      const o = await openAnchor(opts.anchor, opts.identity, timeoutMs);
      socket = o.socket;
      streams.add(socket);
      socket.once('close', () => streams.delete(socket!));
      const r = await ask(socket, o.reader, { t: 'accept', sid }, timeoutMs);
      if (r?.t !== 'ready') throw new Error(reasonOf(r));
      const rest = o.reader.release();
      socket.pause();
      local = net.connect({ host: '127.0.0.1', port: opts.gatePort, allowHalfOpen: true });
      await new Promise<void>((res, rej) => { local!.once('connect', res); local!.once('error', rej); });
      local.setNoDelay(true);
      await pipeBoth(socket, local, rest);
    } catch (e) {
      log(`anchor stream from ${from.slice(0, 16)}…: ${(e as Error).message}`);
      socket?.destroy();
      local?.destroy();
    }
  };

  const connect = async (): Promise<void> => {
    const { socket, reader } = await openAnchor(opts.anchor, opts.identity, timeoutMs);
    let r: any;
    try { r = await ask(socket, reader, { t: 'register', name: opts.name, kind: opts.kind }, timeoutMs); }
    catch (e) { socket.destroy(); throw e; }
    if (r?.t !== 'registered') { socket.destroy(); throw new GateRefused(reasonOf(r)); }
    control = socket;
    registered = true;
    delay = firstDelay;
    log(`anchor: registered at ${opts.anchor.host}:${opts.anchor.port}`);
    opts.onState?.('registered');
    const ping = setInterval(() => send(socket, { t: 'ping' }), pingMs);
    ping.unref();
    // the address book: records given on this connection (fingerprint → seq), and the asking
    const book = opts.book;
    const given = new Map<string, number>();
    const exchange = () => {
      if (!book || socket.destroyed) return;
      try {
        for (const r of book.give()) {
          if (!r || given.get(r.fp) === r.seq) continue;
          given.set(r.fp, r.seq);
          send(socket, { t: 'record', rec: r });
        }
        // the anchor itself is asked about too: its own record answers a seq that is behind
        const want = book.wants();
        for (let i = 0; i < want.length; i += WHO_MAX) {
          const part = want.slice(i, i + WHO_MAX);
          send(socket, { t: 'who', fps: part.map((w) => w.fp), seqs: part.map((w) => w.seq) });
        }
      } catch (e) {
        log(`anchor: address book: ${(e as Error).message}`);
      }
    };
    exchange();
    const tick = book ? setInterval(exchange, book.everyMs ?? ANCHOR_BOOK_MS) : null;
    tick?.unref();
    void (async () => {
      // the anchor answers every ping: two pings without a word mean the connection is dead
      while (!closed) {
        let line: string;
        try { line = await reader.line(2 * pingMs + timeoutMs); } catch { break; }
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m?.t === 'open' && typeof m.sid === 'string') void accept(m.sid, String(m.from ?? ''));
        else if (m?.t === 'record') { try { book?.take(m.rec); } catch {} }
        else if (m?.t === 'error' && m.reason === 'replaced') { replaced = true; break; }
      }
      clearInterval(ping);
      if (tick) clearInterval(tick);
      reader.release();
      socket.destroy();
      if (control === socket) { control = null; registered = false; }
      if (closed) return;
      if (replaced) { log('anchor: this certificate registered again elsewhere; this connection steps back'); opts.onState?.('replaced'); return; }
      log(`anchor: connection lost; again in ${delay / 1000} s`);
      opts.onState?.('lost');
      const again = () => {
        retry = null;
        if (closed) return;
        connect().catch((e) => {
          log(`anchor: ${(e as Error).message}; again in ${delay / 1000} s`);
          retry = setTimeout(again, delay); retry.unref();
          delay = Math.min(delay * 2, 30_000);
        });
      };
      retry = setTimeout(again, delay); retry.unref();
      delay = Math.min(delay * 2, 30_000);
    })();
  };

  return connect().then(() => ({
    get registered() { return registered; },
    get replaced() { return replaced; },
    close: async () => {
      closed = true;
      if (retry) clearTimeout(retry);
      control?.destroy();
      for (const s of streams) s.destroy();
    },
  }));
}
