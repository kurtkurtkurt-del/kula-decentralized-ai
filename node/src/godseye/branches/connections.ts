// 5 connections: how each device is reached. The link kind is a dimension, not a fixed list:
// 'cable', 'wifi' and 'relay' exist today, and 'internet' will work the day it appears, with no
// code change. From each device's probe readings (a reading is new when its checkedAt differs
// from the last one taken in) the branch keeps, per kind: how many probes, how many answered,
// the last MS_MAX answer times and the look time of the last probe. A change of kind is one
// remembered switch and one feed line, and the view says which kind has been the steadier when a
// device was seen on more than one kind probed within a day. It only says these things: it never
// switches anything.
//
// What each kind is expected to be like. Starting assumptions, not measurements, so the planner
// and forecast can share them later:
//
//   kind       usual ms   drops
//   cable      20         rare
//   wifi       80         sometimes
//   relay      300        sometimes
//   internet   150        often
//   anchor     300        sometimes
//   other      -          none
//
// Notes are one small json (ctx.save). Bounds: at most MAX_DEVICES devices (a device the current
// look holds is never evicted), at most MAX_KINDS kinds and MAX_SW switches per device, the last
// RING_MAX probe outcomes (packed as a string of '0'/'1') and the last MS_MAX ms values per kind,
// every name cut to STR_MAX. The notes never hold where, a reason or trust data. Data time is
// the snapshot's at (finite, 0..8.64e15); ctx.now() only paces saves. A reading with an unusable
// checkedAt or a reachable that is not a boolean is ignored; an unusable answer time is ignored,
// the probe still counts. A look far behind a device's remembered times means the remembered ones
// were a bad clock: the remembered kind is forgotten (no switch, no feed line) and seen
// re-anchors. Saved at most once a minute and only when something changed.
//
// Which address answered (11.11.2026, docs/INTERNET.md): a snapshot device may say reachedBy,
// 'lan', 'ipv6' or 'mapped' (its router's port). A device that answers, but only at a global ipv6
// address or its router's port, gets one card: it is reached over the internet, answers are
// slower there, and apart and split both work over it (a split waits about one round trip per
// token for each far worker; the planner says the estimate). Something to know; its button only
// looks again (a probe), which puts it back on the lan once the lan answers. A device reached
// through an anchor gets the anchor's card below instead.
//
// A remote peer's link, in words (13.11.2026): for a device reached over the internet, a relay or
// an anchor, once its kind has 10 probes, the line also says what the ring and the ms list already
// hold, and nothing new is probed: the spread (8 in 10 of its last answer times fall within a
// range, from at least 10 of them), the loss (the 80% Wilson interval of the missed share, whole
// percents) and what that costs a split (one round trip per token before any compute, so at best
// 1000/ms tok/s: an upper bound). A fourth row, 'remote links', says how many such devices the look
// holds and the slowest usual latency among them. No card and no feed line for these words; the
// deciding branches get one hint per such device (16.11.2026): { id, loss: { hi } }, the upper end
// of that 80% Wilson interval as a share 0..1, from the same ring.
//
// Anchors (16.11.2026, the anchor network): a device may be reached via 'anchor', through an
// always-on computer of the person's own circle (its row id in the snapshot's `through`) that
// passes the bytes on and cannot read them (tls end to end). No server outside. The stat counts
// them ('· n anchor'). The notes keep per device `thru`, the last anchor id it was routed through
// (an id only, never an address): set while its row says via 'anchor' through a usable id that is
// a row of the look, cleared once it answers over another kind or via 'anchor' through a null id,
// and cleared for every device whose anchor is absent from the look (an absent anchor may be
// forgotten or cut from the list: that is not "not answering"); a file without it loads as null
// and v stays 1. How many
// readings in a row each device missed lives in memory (from the notes' last kind on start). A
// switch to an anchor is the feed line "X is now reached through anchor Y (was wifi)". Three cards,
// each only a probe or opening a panel; an anchor this computer cannot name reads "an anchor":
//   connections:through:<Y>     warn 1   reachable devices via anchor through Y, one card per Y
//   connections:anchor-down:<Y> warn 3   Y, a row of the look, missed its last 3 readings and a
//                                        device last routed through Y is not reachable; goes when
//                                        either answers once; one feed line when it shows, one when it goes
//   connections:one-anchor      suggest 1  exactly one anchor known (rows with anchor, plus this
//                                        computer's host.anchor.on) and at least one far device
//                                        (internet or anchor); through Steady (SHOW 3 / HIDE 4).
//                                        It opens devices; when host.anchor.on is false and the one
//                                        anchor is a far row it carries { do: 'anchor', on: true }
//                                        (DECISIONS 5, E2: the person accepts, after a "really?")
// A snapshot without the new fields gives none of it.
// P1b (16.11.2026): a row's `through` is 'self' when this computer is the anchor. Its through card
// (keyed 'self') reads "X is reached through this computer (its anchor)"; it never sets `thru` (it
// clears it) and never gives an anchor-down card (this computer is up by definition; a 'self' left in
// older notes is cleared); for one-anchor it counts as this computer's own anchor, once, beside
// host.anchor.on. A row's `throughName` (the anchor's name the engine knows) names an anchor that is
// not a row of the look: an anchor's name is its row's, else a throughName a row of the look gives
// for that id, else the notes', else "an anchor". A row through a null id with a throughName gets a
// through card keyed `name:<throughName>` (cardId hashes it) and nothing else: no `thru`, no
// anchor-down. The notes still keep ids only, never a name of an anchor.
//
// A moved address (16.11.2026, P5): a device that answers with its pinned certificate (tls true,
// and trust.certPinned not false when the device said it) from a public address block it was not
// seen on before. The block is the public ipv4 /16 or the global ipv6 /32 (2000::/3), parsed from
// the row's `where` (host:port, [ipv6]:port, a bare address; the first word only, so whereIs's
// "(router port, over the internet)" tail is left out). An unparsable where, a lan or other
// private address (10/8, 172.16/12, 192.168/16, 100.64/10, loopback, link-local, ula, multicast),
// or a device via 'anchor' (no address of its own) gives nothing: a lan change, or lan to internet,
// is not a move (the switch line says that). The notes keep per device `nb`, at most NB_MAX
// entries of [h, first, last, n]: h the first 12 hex of sha256(id|block), first and last the look
// times it answered from that block, n how many answers; never an address or a block. A full list
// drops the entry seen least recently. The hash is not readable at a glance, not secret: the id is
// in the same file, so trying the 65,536 ipv4 /16 blocks turns an entry back into its block; the
// notes stay on this computer. A file without nb loads with an empty list; an empty list is
// not written. A device's first block says nothing. A later unseen block gives one feed line a day
// at most per device, "X answered from a network it was not seen on before (its pinned certificate
// matched)", and, only when the device was settled before it (at most 2 blocks, at least 20
// answers over them, first to last at least 3 days), the card
//   connections:moved:<id>      warn 2     for 24 h from that look (in memory), opens trust
// The feed day and the card's time live in memory: a restart forgets them.
//
// Roads risk (17.11.2026, P1). The snapshot's `roads` (P0) counts the roads this computer has to a
// device: lan addresses, direct internet addresses and anchors. The notes keep per device `hr`, its
// probes by the hour of the look's at: at most HR_MAX entries [h, n, m], h the whole hours since 1970
// (UTC), n readings taken in that hour, m of them missed; counts only, never an address. It is kept
// for a row that offers the anchor role (anchor true), a row another row of the look goes through,
// or a far row that says its roads (a snapshot with the new fields), and once kept it keeps counting; an hour older than HR_MAX hours before
// the look, or after it (a bad clock), is dropped. A file without hr loads with none, and none is
// not written. Two cards, each opening a panel only:
//   connections:one-road:<X>      suggest 1 (warn 2 when Y missed at least once and the interval's
//        upper end is 20% or more)
//        a far device, reachable, whose roads say direct + anchors = 1, while two or more anchors are
//        known (as one-anchor counts them; with one, one-anchor says it). Y is its one road: the
//        anchor it goes through (an id of a row, not this computer, not a null id: there is nothing
//        to count of those) or, for its one direct address, the device itself. The why says "Y
//        missed a of n probes in 7 days, 80% interval lo–hi%, seen from this computer only", the
//        interval by ONE_ROAD_WAY, 4-hour blocks (bench8 scored three ways: test/brain-bench/bench8.ts), or that
//        Y was not probed from here in 7 days.
//   connections:anchor-unconfirmed suggest 1   host.anchor.on, its reachable not true, and its
//        since 6 hours or more before the look: "nothing reached it from another network yet; not
//        confirmed is not closed".
import type { Branch, BranchCtx, BranchView, DeviceHint, EyeDevice, Snapshot, Suggestion } from '../types.js';
import { reachWord } from './util.js';
import { Steady, cardId, names } from './decide.js';
import { sha256Hex } from '../hash.js';

export const MAX_DEVICES = 40;
export const MAX_KINDS = 6;
export const MS_MAX = 20;
export const SW_MAX = 10;
export const RING_MAX = 200;         // the last probe outcomes a kind's rate is computed from
const STR_MAX = 200;
const WHERE_MAX = 60;                // an address in a line, cut; the notes and the feed never hold one
const REASON_MAX = 120;              // a reason in a line, cut
const SAVE_EVERY_MS = 60_000;
const REANCHOR_MS = 24 * 3600_000;   // a look further back than this means the remembered time was a bad clock
const RECENT_MS = 24 * 3600_000;     // two kinds are compared only when both were probed this recently
const SLOWER_X = 3;                  // a kind answered more than 3 times its assumed ms is slower than usual
const MS_OK_MAX = 3_600_000;         // a probe answer later than an hour is no answer time at all
const MAX_TIME = 8.64e15;            // the last ms a Date can hold; later is no time at all
export const NB_MAX = 6;             // address blocks remembered per device (as hashes)
const NB_HEX = 12;                   // hex chars of sha256(id|block) a block entry keeps
const SETTLED_BLOCKS = 2;            // settled: at most this many blocks ...
const SETTLED_ANSWERS = 20;          // ... at least this many answers over them ...
const SETTLED_MS = 3 * 24 * 3600_000; // ... first to last at least this long
const MOVED_MS = 24 * 3600_000;      // the moved card lasts this long from the look that saw it
const PARSE_MAX = 100;               // a where longer than this is cut before parsing
const HOUR_MS = 3_600_000;
export const HR_MAX = 168;           // hours of probes kept per device: the 7 days the one-road card looks at
const HR_COUNT_MAX = 1_000_000;      // probes counted in one hour, at most
const UNCONFIRMED_MS = 6 * HOUR_MS;  // the anchor offered this long and not reached from outside: a card
const RISK_HI = 0.2;                 // the one-road card warns when Y missed at least once and its interval's upper end is this or more

/** What each kind is expected to be like: the assumptions table above. 'other' has none. */
export const ASSUMED: { kind: string; ms: number; drops: string }[] = [
  { kind: 'cable', ms: 20, drops: 'rare' },
  { kind: 'wifi', ms: 80, drops: 'sometimes' },
  { kind: 'relay', ms: 300, drops: 'sometimes' },
  { kind: 'internet', ms: 150, drops: 'often' },
  { kind: 'anchor', ms: 300, drops: 'sometimes' },
];
const ASSUMED_BY_KIND = new Map(ASSUMED.map((a) => [a.kind, a]));
const ASSUMED_LINE = `${ASSUMED.map((a) => `${a.kind}: ${a.ms} ms, ${a.drops} drops`).join(' · ')} · other: none`;

/** The address kinds that mean the internet: a global ipv6 address, a router's mapped port. */
export const INTERNET_ADDRS = ['ipv6', 'mapped'];
/** Did this snapshot device answer only over the internet? Its reachedBy says so, or its via. */
export function overInternet(d: Record<string, unknown>): boolean {
  return INTERNET_ADDRS.includes(d.reachedBy as string) || kindOf(d.via) === 'internet';
}

/** a dotted ipv4 as its four bytes, else null */
function v4Of(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1, 5).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}
/** an ipv4 that names a public network: not this-network, private, shared (cgnat), loopback,
 *  link-local, multicast or reserved */
function publicV4(b: number[]): boolean {
  const [a, c] = b;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && c >= 64 && c <= 127) return false;
  if (a === 169 && c === 254) return false;
  if (a === 172 && c >= 16 && c <= 31) return false;
  if (a === 192 && c === 168) return false;
  return true;
}
/** an ipv6 as its eight 16-bit groups ('::' and a trailing dotted ipv4 allowed), else null */
function v6Of(s: string): number[] | null {
  if (s.length > 45 || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2 || (halves.length === 2 && halves[0].includes('.'))) return null;
  const part = (x: string): number[] | null => {
    if (x === '') return [];
    const out: number[] = [];
    const bits = x.split(':');
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i];
      if (i === bits.length - 1 && b.includes('.')) {
        const v4 = v4Of(b);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(b)) out.push(parseInt(b, 16));
      else return null;
    }
    return out;
  };
  const head = part(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = part(halves[1]);
  if (!tail || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}
/** The public address block a row's where names: 'a.b' (ipv4 /16) or 'g1:g2' (global ipv6 /32,
 *  lower-case hex, no leading zeros); null for an unparsable where, a hostname, or a lan / private
 *  address. Only the first word is read (host:port, [ipv6]:port or a bare address). */
export function blockOf(where: unknown): string | null {
  if (typeof where !== 'string') return null;
  const tok = where.trim().slice(0, PARSE_MAX).split(/\s/)[0] ?? '';
  let host: string;
  if (tok.startsWith('[')) {
    const end = tok.indexOf(']');
    if (end < 0) return null;
    const rest = tok.slice(end + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return null;
    host = tok.slice(1, end);
  } else if (tok.split(':').length === 2) {
    const [h, p] = tok.split(':');
    if (!/^\d{1,5}$/.test(p)) return null;
    host = h;
  } else {
    host = tok;
  }
  host = host.replace(/%[^%]*$/, '');               // an ipv6 zone (%en0) says nothing of the block
  if (!host) return null;
  const v4 = v4Of(host);
  if (v4) return publicV4(v4) ? `${v4[0]}.${v4[1]}` : null;
  const g = v6Of(host);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {   // ::ffff:a.b.c.d is an ipv4
    const b = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
    return publicV4(b) ? `${b[0]}.${b[1]}` : null;
  }
  if (g[0] < 0x2000 || g[0] > 0x3fff) return null;  // only global unicast: not ula, link-local, loopback, multicast
  return `${g[0].toString(16)}:${g[1].toString(16)}`;
}

/** Is this snapshot device far: reached over the internet or through an anchor (a relay is not)? */
export function isFar(d: Record<string, unknown>): boolean {
  return overInternet(d) || kindOf(d.via) === 'anchor';
}

/** The link kind as a dimension, from a snapshot's via: cut to 20 chars, lower case, letters /
 *  digits / dashes only; anything else is 'other'. A new kind needs no code change. */
export function kindOf(x: unknown): string {
  if (typeof x !== 'string') return 'other';
  const k = x.slice(0, 20).toLowerCase();
  return /^[a-z0-9-]+$/.test(k) ? k : 'other';
}

/** ok of n probes answered, a rate 0..1 (expect 0 <= ok <= n); null when there are no probes. */
export function reachRate(n: number, ok: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(ok) || n <= 0) return null;
  return ok / n;
}

/** The median of the ms values, rounded to a whole ms: the usual latency. Needs at least 5, else
 *  null. The input array is not changed. */
export function usualMs(ms: number[]): number | null {
  if (ms.length < 5) return null;
  const sorted = [...ms].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const med = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(med);
}

/** Which of two kinds answers more reliably: the higher reach rate; a tie goes to the lower
 *  usual latency. -1: a is the steadier, 1: b is, 0: a tie. A kind with no usual latency cannot
 *  win a rate tie. */
export function steadier(a: { rate: number; ms: number | null }, b: { rate: number; ms: number | null }): -1 | 0 | 1 {
  if (a.rate > b.rate) return -1;
  if (a.rate < b.rate) return 1;
  if (a.ms !== null && b.ms !== null) return a.ms < b.ms ? -1 : a.ms > b.ms ? 1 : 0;
  if (a.ms !== null) return -1;
  if (b.ms !== null) return 1;
  return 0;
}

/** One kind's readings: the last RING_MAX probe outcomes (true: answered), the last MS_MAX answer
 *  times, and the look time of the last probe (null in a file written before this field). The
 *  counts and the rate are computed from the ring, so an old era stops counting. */
export interface KindStat { ring: boolean[]; ms: number[]; last: number | null }
/** One change of kind: when it was seen and from what to what. */
export interface SwitchRec { at: number; from: string; to: string }
/** What the notes remember of one device. k is a Map of kind -> readings, in first-seen order. */
export interface DevNotes {
  name: string;
  seen: number;          // snapshot.at of the last look that held this device
  kind: string | null;   // the kind of the last reading taken in; null: no reading yet
  at: number | null;     // the checkedAt of the last reading taken in
  k: Map<string, KindStat>;
  sw: SwitchRec[];
  thru: string | null;   // the last anchor id it was routed through; null: none (or a file from before this field)
  nb: BlockRec[];        // public address blocks it answered from, as hashes; [] in a file from before this field
  hr: HourRec[];         // its probes by the hour, oldest first; [] in a file from before this field
}
/** One hour's probes of a device: h the whole hours since 1970 (UTC) of the looks, n readings taken
 *  in, m of them missed. Counts only. */
export type HourRec = [h: number, n: number, m: number];
/** One address block a device answered from: 12 hex of sha256(id|block), the first and last look
 *  time it answered from there, how many answers. Never the address or the block itself. */
export type BlockRec = [h: string, first: number, last: number, n: number];
/** The notes as they live in memory: dev is a Map by id, so ids like __proto__ are ordinary keys. */
export interface ConnectionsNotes { v: 1; dev: Map<string, DevNotes> }
/** The notes as they live on disk: dev is an array of [id, device] pairs (json cannot hold a Map). */
interface NotesFile { v: 1; dev: unknown[] }

const cut = (s: string): string => s.slice(0, STR_MAX);
/** A probe ring as the notes hold it: '1' answered, '0' missed, oldest first. */
const packRing = (ring: boolean[]): string => ring.map((ok) => (ok ? '1' : '0')).join('');
const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_TIME;
/** whole hours since 1970 that a Date can hold */
const isHourNo = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= Math.floor(MAX_TIME / HOUR_MS);
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= HR_COUNT_MAX;
/** a count from a snapshot's roads: a finite number >= 0, floored; anything else is 0 */
const roadCount = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
/** A probe answer time: a finite ms in a plausible range (up to an hour), rounded to a whole ms
 *  so a decayed value never shows a tail in a line. */
const usableMs = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MS_OK_MAX ? Math.round(x) : null;
/** A rate as a line says it: a whole percent, rounded. 100% only when every probe in the window
 *  answered; anything short of that shows at most 99. */
const pctOf = (rate: number) => (rate >= 1 ? 100 : Math.min(99, Math.round(rate * 100)));
const boolOrNull = (x: unknown): boolean | null => (x === true || x === false ? x : null);
/** A string from a snapshot field: strings stay, finite numbers become their text, anything else
 *  is missing. An object must never reach a line as "[object Object]". */
const textOf = (x: unknown): string | null =>
  typeof x === 'string' ? x : typeof x === 'number' && Number.isFinite(x) ? String(x) : null;
/** A usable id: a non-empty string no longer than STR_MAX, so a cut id is never compared with a full one. */
const idOf = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 && x.length <= STR_MAX ? x : null);
/** A row's `through` when this computer is the anchor (P1b). */
const SELF = 'self';
/** A row's throughName as a title says it: a string cut to STR_MAX; null when empty or not one. */
const throughNameOf = (o: Record<string, unknown>): string | null =>
  (typeof o.throughName === 'string' ? cut(o.throughName) : '') || null;
/** The address as today's line shows it: a string cut to WHERE_MAX; anything else is left out. */
const whereOf = (x: unknown): string | null =>
  typeof x === 'string' ? x.slice(0, WHERE_MAX) : null;
/** A reason as today's line shows it: a string cut to REASON_MAX; anything else is left out. */
const reasonOf = (x: unknown): string | null =>
  typeof x === 'string' ? x.slice(0, REASON_MAX) : null;
const listOf = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const objOf = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : null;
/** The 80% Wilson interval of k successes in n (z 1.2816), clamped to 0..1; null without trials. */
function wilson80(k: number, n: number): [number, number] | null {
  if (!(n > 0)) return null;
  const z = 1.2816, z2 = z * z, p = k / n;
  const den = 1 + z2 / n;
  const mid = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}
/** A device's missed share over some hours, with its 80% interval: a of n probes missed (both
 *  counts as they were), lo and hi the interval's ends as shares 0..1, hours how many hours had a
 *  probe. Null without a probe. */
export interface MissShare { a: number; n: number; hours: number; lo: number; hi: number }
/** One hour's probes as the notes keep them: h the whole hours since 1970 (UTC), probes n, of them
 *  missed m. */
export interface HourProbes { h: number; n: number; m: number }
const sumOf = (hs: HourProbes[]) => {
  let a = 0, n = 0, hours = 0;
  for (const h of hs) if (h.n > 0) { a += h.m; n += h.n; hours++; }
  return { a, n, hours };
};
/** Wilson over probes: every probe one independent trial (today's `loss` way). Probes come in
 *  bursts (a 15 s round while the brain is open) and outages last minutes to hours, so the trials
 *  are not independent: bench8 measures how often this holds the truth. */
export function missByProbe(hs: HourProbes[]): MissShare | null {
  const s = sumOf(hs);
  const w = wilson80(s.a, s.n);
  return w ? { ...s, lo: w[0], hi: w[1] } : null;
}
/** Wilson over hours: each hour with a probe is one block, its missed share the hour's; the share
 *  is the mean over those hours and the evidence is the number of hours, not of probes. */
export function missByHour(hs: HourProbes[]): MissShare | null {
  const s = sumOf(hs);
  if (s.hours === 0) return null;
  let sum = 0;
  for (const h of hs) if (h.n > 0) sum += h.m / h.n;
  const w = wilson80(sum, s.hours);
  return w ? { ...s, lo: w[0], hi: w[1] } : null;
}
/** Wilson over blocks of `size` hours: an hour's block is floor(h / size) on its UTC hour number; a
 *  block's missed share is its summed misses over its summed probes; the share is the mean over the
 *  blocks that had a probe and the evidence is the number of those blocks. */
export function missByBlock(hs: HourProbes[], size: number): MissShare | null {
  const s = sumOf(hs);
  const blocks = new Map<number, { n: number; m: number }>();
  for (const h of hs) {
    if (!(h.n > 0)) continue;
    const k = Math.floor(h.h / size);
    const b = blocks.get(k) ?? { n: 0, m: 0 };
    b.n += h.n; b.m += h.m;
    blocks.set(k, b);
  }
  if (blocks.size === 0) return null;
  let sum = 0;
  for (const b of blocks.values()) sum += b.m / b.n;
  const w = wilson80(sum, blocks.size);
  return w ? { ...s, lo: w[0], hi: w[1] } : null;
}
/** The way the one-road card states its interval (bench8, 17.11.2026): 4-hour blocks, the way the
 *  rule picks (4 of 5 seeds covering at every level; test/brain-bench/bench8.ts). Over blocks the
 *  interval held the truth in 94.5% of the 7-day windows at each of A 0.99, 0.9 and 0.7 (5 of 5
 *  seeds each), at a mean width of 5–18%; over hours in 73–86% (4, 3 and 2 of 5 seeds), over probes
 *  in 2–9% (0 of 5). The outage shape is invented: with outages of 240 minutes on average at A 0.9
 *  the blocks hold it in 70% (3 of 5 seeds), so the card still says "seen from this computer only". */
export const ONE_ROAD_WAY: 'probe' | 'hour' | 'block4' = 'block4';
export const missOneRoad = (hs: HourProbes[]): MissShare | null =>
  ONE_ROAD_WAY === 'block4' ? missByBlock(hs, 4) : ONE_ROAD_WAY === 'hour' ? missByHour(hs) : missByProbe(hs);
/** Where 8 in 10 of the ms values fall: the 10th and 90th percentile of the sorted values (a =
 *  sorted[floor(0.1(m-1))], b = sorted[ceil(0.9(m-1))]). Needs at least 10, else null. */
function spreadOf(ms: number[]): [number, number] | null {
  const m = ms.length;
  if (m < 10) return null;
  const sorted = [...ms].sort((x, y) => x - y);
  return [sorted[Math.floor(0.1 * (m - 1))], sorted[Math.ceil(0.9 * (m - 1))]];
}
/** A range as a line says it: one number when both ends are equal. */
const rangeWords = (a: number, b: number) => (a === b ? `${a}` : `${a}–${b}`);
const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const freshNotes = (): ConnectionsNotes => ({ v: 1, dev: new Map() });

/** A kind exactly as this file writes one: already cut, lower case, letters / digits / dashes. */
const saneKind = (x: unknown): x is string => typeof x === 'string' && kindOf(x) === x;

function saneStat(x: unknown): KindStat | null {
  const s = objOf(x);
  if (!s || !Array.isArray(s.ms)) return null;
  const ring: boolean[] = [];
  if (typeof s.ring === 'string') {                // the packed shape: '0'/'1', oldest first
    const packed = s.ring.slice(-RING_MAX);
    for (let i = 0; i < packed.length; i++) {
      const c = packed.charCodeAt(i);
      if (c !== 48 && c !== 49) return null;       // not a packed ring
      ring.push(c === 49);
    }
  } else if (Array.isArray(s.ring)) {              // a file from before the packing: boolean outcomes
    for (const r of s.ring.slice(-RING_MAX)) {
      if (typeof r !== 'boolean') return null;
      ring.push(r);
    }
  } else {
    return null;
  }
  const ms: number[] = [];
  for (const m of s.ms.slice(-MS_MAX)) {
    const v = usableMs(m);
    if (v === null) return null;
    ms.push(v);
  }
  let last: number | null = null;                  // missing in a file from before this field
  if (s.last !== undefined && s.last !== null) {
    if (!isTime(s.last)) return null;
    last = s.last;
  }
  return { ring, ms, last };
}

function saneDev(x: unknown): [string, DevNotes] | null {
  if (!Array.isArray(x) || x.length < 2) return null;
  const [rawId, rawE] = x;
  const id = idOf(rawId);
  const e = objOf(rawE);
  if (!id || !e || typeof e.name !== 'string' || !isTime(e.seen)) return null;
  if (!(e.at === null || isTime(e.at))) return null;
  if (!(e.kind === null || saneKind(e.kind))) return null;
  if (!Array.isArray(e.k)) return null;
  const k = new Map<string, KindStat>();
  for (const pair of e.k.slice(0, MAX_KINDS)) {
    if (!Array.isArray(pair) || pair.length < 2 || !saneKind(pair[0])) return null;
    if (k.has(pair[0])) continue;            // first one wins
    const st = saneStat(pair[1]);
    if (!st) return null;
    k.set(pair[0], st);
  }
  if (e.kind !== null && !k.has(e.kind)) return null;   // this file always writes the last kind with its readings
  if (!Array.isArray(e.sw)) return null;
  const sw: SwitchRec[] = [];
  for (const raw of e.sw.slice(-SW_MAX)) {
    const s = objOf(raw);
    if (!s || !isTime(s.at) || !saneKind(s.from) || !saneKind(s.to) || s.from === s.to) return null;
    sw.push({ at: s.at, from: s.from, to: s.to });
  }
  let thru: string | null = null;                  // missing in a file from before this field
  if (e.thru !== undefined && e.thru !== null) {
    thru = idOf(e.thru);
    if (thru === null) return null;
  }
  const nb: BlockRec[] = [];                       // missing in a file from before this field
  if (e.nb !== undefined) {
    if (!Array.isArray(e.nb)) return null;
    for (const r of e.nb.slice(-NB_MAX)) {
      if (!Array.isArray(r) || r.length !== 4) return null;
      const [h, first, last, n] = r;
      if (typeof h !== 'string' || !/^[0-9a-f]{12}$/.test(h) || !isTime(first) || !isTime(last) || first > last) return null;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return null;
      if (nb.some((x) => x[0] === h)) continue;    // first one wins
      nb.push([h, first, last, n]);
    }
  }
  const hr: HourRec[] = [];                        // missing in a file from before this field
  if (e.hr !== undefined) {
    if (!Array.isArray(e.hr)) return null;
    for (const r of e.hr.slice(-HR_MAX)) {
      if (!Array.isArray(r) || r.length !== 3) return null;
      const [h, n, m] = r;
      if (!isHourNo(h) || !isCount(n) || n < 1 || !isCount(m) || m > n) return null;
      if (hr.length && h <= hr[hr.length - 1][0]) return null;   // this file writes them in order, one per hour
      hr.push([h, n, m]);
    }
  }
  return [id, { name: cut(e.name), seen: e.seen, kind: e.kind, at: e.at, k, sw, thru, nb, hr }];
}

/** A notes file from disk, kept only if it has exactly the shape this file writes. A bad shape
 *  (or NaN / negative / past-Date times) gives fresh notes, never a throw. The dev Map is rebuilt,
 *  so ids like __proto__ stay ordinary keys. */
function sane(x: unknown): ConnectionsNotes {
  const n = objOf(x) as unknown as NotesFile;
  if (!n || n.v !== 1 || !Array.isArray(n.dev)) return freshNotes();
  const dev = new Map<string, DevNotes>();
  for (const raw of n.dev.slice(0, MAX_DEVICES)) {
    const one = saneDev(raw);
    if (!one) return freshNotes();
    if (dev.has(one[0])) continue;           // first one wins
    dev.set(one[0], one[1]);
  }
  return { v: 1, dev };
}

export function create(ctx: BranchCtx): Branch {
  const notes = sane(ctx.load<unknown>(null));
  const devs = notes.dev;                    // a Map by id, so ids like __proto__ are ordinary keys
  let snap: Snapshot | null = null;
  let savedAt = Number.NEGATIVE_INFINITY;    // the first change after start is saved at once
  let dirty = false;                         // something changed since the last save
  // readings missed in a row, per device id, in memory: on start, the trailing misses of the
  // notes' last kind; a new reading adds one or resets it
  const miss = new Map<string, number>();
  for (const [id, e] of devs) {
    const ring = e.kind === null ? [] : e.k.get(e.kind)?.ring ?? [];
    let n = 0;
    for (let i = ring.length - 1; i >= 0 && !ring[i]; i--) n++;
    miss.set(id, n);
  }
  const steady = new Steady();               // the one-anchor card's hysteresis
  let steadyCards: Suggestion[] = [];
  let downCards: Suggestion[] = [];          // the anchor-down cards of the last look
  const downNow = new Set<string>();         // the anchor ids whose anchor-down card shows, for the feed
  const movedAt = new Map<string, number>(); // id -> the look time its moved card dates from (in memory)
  const movedDay = new Map<string, string>(); // id -> the day of its last moved feed line (in memory)

  /** settled: at most 2 blocks, at least 20 answers over them, first to last at least 3 days */
  function settled(nb: BlockRec[]): boolean {
    if (nb.length < 1 || nb.length > SETTLED_BLOCKS) return false;
    let n = 0, first = Infinity, last = -Infinity;
    for (const [, f, l, k] of nb) { n += k; first = Math.min(first, f); last = Math.max(last, l); }
    return n >= SETTLED_ANSWERS && last - first >= SETTLED_MS;
  }

  /** A pinned answer from a public block: count it; an unseen block after the first is one feed
   *  line a day, and a card when the device was settled. True when the notes changed. */
  function noteBlock(id: string, e: DevNotes, d: Record<string, unknown>, at: number): boolean {
    if (d.tls !== true || objOf(d.trust)?.certPinned === false) return false;   // not pinned
    if (kindOf(d.via) === 'anchor') return false;    // no address of its own
    const block = blockOf(d.where);
    if (block === null) return false;
    const h = sha256Hex(`${id}|${block}`).slice(0, NB_HEX);
    const known = e.nb.find((r) => r[0] === h);
    if (known) {
      known[1] = Math.min(known[1], at);
      known[2] = Math.max(known[2], at);
      if (known[3] < Number.MAX_SAFE_INTEGER) known[3]++;
      return true;
    }
    if (e.nb.length > 0) {
      if (settled(e.nb)) movedAt.set(id, at);
      const day = dayKey(at);
      if (movedDay.get(id) !== day) {
        movedDay.set(id, day);
        ctx.emit(movedWords(e.name || id));
      }
    }
    e.nb.push([h, at, at, 1]);
    while (e.nb.length > NB_MAX) {                 // drop the one seen least recently, never the new one
      let drop = 0;
      for (let i = 1; i < e.nb.length - 1; i++) if (e.nb[i][2] < e.nb[drop][2]) drop = i;
      e.nb.splice(drop, 1);
    }
    return true;
  }
  const movedWords = (name: string) => `${name} answered from a network it was not seen on before (its pinned certificate matched)`;

  /** An anchor's name as this computer knows it: 'this computer' for SELF; its row in the look,
   *  else a throughName a row of the look gives for it, else the notes; null: unknown. */
  function anchorName(id: string): string | null {
    if (id === SELF) return 'this computer';
    const devices = listOf(snap?.devices).slice(0, MAX_DEVICES);
    for (const raw of devices) {
      const o = objOf(raw);
      if (o && idOf(o.id) === id) { const n = cut(textOf(o.name) ?? ''); if (n) return n; break; }
    }
    for (const raw of devices) {
      const o = objOf(raw);
      if (o && idOf(o.through) === id) { const n = throughNameOf(o); if (n) return n; }
    }
    return devs.get(id)?.name || null;
  }
  /** "(was wifi)" after the anchor's words, folded into their own bracket when they end in one */
  const wasAfter = (w: string, prev: string): string => (w.endsWith(')') ? `${w.slice(0, -1)}, was ${prev})` : `${w} (was ${prev})`);
  /** "anchor Y", "this computer (its anchor)" for SELF, or "an anchor" when this computer cannot
   *  name it; tn: the row's own throughName, for an anchor known by name only */
  const anchorWords = (id: string | null, tn: string | null = null) => {
    if (id === SELF) return 'this computer (its anchor)';
    const n = (id === null ? null : anchorName(id)) ?? tn;
    return n ? `anchor ${n}` : 'an anchor';
  };
  /** a device's name as a card says it: its row's name, else its id */
  const rowName = (o: Record<string, unknown>, id: string) => cut(textOf(o.name) ?? '') || id;
  /** "X", "X, Z" or "X, Z (+n more)" */
  const fewNames = (ns: string[]) => `${ns.slice(0, 2).join(', ')}${ns.length > 2 ? ` (+${ns.length - 2} more)` : ''}`;

  /** The anchor-down cards of this look, from the rows and the notes: an anchor Y of the look that
   *  missed its last 3 readings, with at least one row last routed through Y not reachable. An
   *  absent Y gives nothing (observe cleared every thru pointing at it). */
  function anchorDown(now: Snapshot, here: Set<string>): { y: string; card: Suggestion }[] {
    const lost = new Map<string, { id: string; name: string }[]>();   // Y -> unreachable rows through it, first-seen order
    const taken = new Set<string>();
    for (const raw of listOf(now.devices).slice(0, MAX_DEVICES)) {
      const o = objOf(raw);
      const id = o ? idOf(o.id) : null;
      if (!o || id === null || taken.has(id)) continue;
      taken.add(id);
      const y = devs.get(id)?.thru ?? null;
      if (y === null || y === SELF || y === id || o.reachable !== false) continue;   // this computer is up
      lost.set(y, [...(lost.get(y) ?? []), { id, name: rowName(o, id) }]);
    }
    const out: { y: string; card: Suggestion }[] = [];
    for (const [y, ds] of lost) {
      if (!here.has(y) || (miss.get(y) ?? 0) < 3) continue;
      const yT = anchorWords(y);
      const who = ds.length <= 2 ? names(ds) : fewNames(ds.map((d) => d.name));
      out.push({ y, card: {
        id: cardId('connections', 'anchor-down', y), kind: 'warn', weight: 3,
        title: `${yT} is not answering: ${who} cannot be reached`,
        why: `they were last reached through ${yT}. they return when ${anchorName(y) ?? 'it'} answers or on this wi-fi. seen from this computer only.`,
        action: { do: 'probe', devices: [y, ...ds.map((d) => d.id)] }, label: 'look again',
      } });
    }
    return out;
  }

  /** The anchors this look knows: rows offering the role, by id (how a title names each), and this
   *  computer once when its own counters say so or a row is reached through it; far: a far row. */
  function anchorsKnown(now: Snapshot): { anchors: Map<string, string>; hostOn: boolean; far: boolean; n: number } {
    const anchors = new Map<string, string>();   // id -> how a title names it
    let far = false;
    let viaSelf = false;                         // a row reached through this computer: it is an anchor
    for (const raw of listOf(now.devices).slice(0, MAX_DEVICES)) {
      const o = objOf(raw);
      if (!o) continue;
      if (isFar(o)) far = true;
      if (kindOf(o.via) === 'anchor' && idOf(o.through) === SELF) viaSelf = true;
      const id = idOf(o.id);
      if (id !== null && o.anchor === true && !anchors.has(id)) anchors.set(id, rowName(o, id));
    }
    // this computer offers the role: its own counters say so, or a row is reached through it (once)
    const hostOn = objOf(objOf(now.host)?.anchor)?.on === true || viaSelf;
    return { anchors, hostOn, far, n: anchors.size + (hostOn ? 1 : 0) };
  }

  /** a row whose probes are kept by the hour: it offers the anchor role, or it is far and says its roads */
  const keepsHours = (d: Record<string, unknown>) => d.anchor === true || (isFar(d) && objOf(d.roads) !== null);
  /** one reading in the hour of the look at: counted, and the hours outside the 7 days before it dropped */
  function noteHour(e: DevNotes, at: number, reach: boolean) {
    const h = Math.floor(at / HOUR_MS);
    e.hr = e.hr.filter((r) => r[0] > h - HR_MAX && r[0] <= h);   // older than 7 days, or after this look (a bad clock)
    const last = e.hr[e.hr.length - 1];
    if (last && last[0] === h) {
      if (last[1] < HR_COUNT_MAX) { last[1]++; if (!reach) last[2]++; }
    } else {
      e.hr.push([h, 1, reach ? 0 : 1]);
    }
  }
  /** a device's probes by the hour over the 7 days up to the look at */
  function hoursOf(id: string, at: number): HourProbes[] {
    const h = Math.floor(at / HOUR_MS);
    return (devs.get(id)?.hr ?? []).filter((r) => r[0] > h - HR_MAX && r[0] <= h).map((r) => ({ h: r[0], n: r[1], m: r[2] }));
  }

  /** The one-road cards of a look: a far device, reachable, with one road (direct + anchors = 1),
   *  while two or more anchors are known; Y, its one road, says how often it missed in 7 days. */
  function oneRoad(now: Snapshot): Suggestion[] {
    if (!isTime(now.at) || anchorsKnown(now).n < 2) return [];
    const out: Suggestion[] = [];
    const taken = new Set<string>();
    for (const raw of listOf(now.devices).slice(0, MAX_DEVICES)) {
      const o = objOf(raw);
      const id = o ? idOf(o.id) : null;
      if (!o || id === null || taken.has(id)) continue;
      taken.add(id);
      const roads = objOf(o.roads);
      if (!roads || o.reachable !== true || !isFar(o)) continue;
      const direct = roadCount(roads.direct), anchors = roadCount(roads.anchors);
      if (direct + anchors !== 1) continue;
      const x = rowName(o, id);
      let y: string, road: string, yN: string;
      if (anchors === 1) {
        const t = kindOf(o.via) === 'anchor' ? idOf(o.through) : null;
        if (t === null || t === SELF || t === id) continue;   // nothing of it to count from here
        y = t;
        road = anchorWords(t, throughNameOf(o));
        yN = anchorName(t) ?? throughNameOf(o) ?? 'the anchor';
      } else {
        if (!overInternet(o)) continue;
        y = id;
        road = 'its one internet address';
        yN = 'that address';
      }
      const s = missOneRoad(hoursOf(y, now.at));
      // a warn needs a miss: zero misses over fewer than 7 blocks already gives an upper end of 19-62%
      const warn = s !== null && s.a >= 1 && s.hi >= RISK_HI;
      const seen = s === null
        ? `${yN} was not probed from this computer in 7 days, so how often it is away is not known.`
        : `${yN} missed ${s.a} of ${s.n} probes in 7 days, 80% interval ${rangeWords(Math.round(s.lo * 100), Math.round(s.hi * 100))}%, seen from this computer only.`;
      out.push({
        id: cardId('connections', 'one-road', id), kind: warn ? 'warn' : 'suggest', weight: warn ? 2 : 1,
        title: `${x} has one road from here: ${road}`,
        why: `if ${yN} goes, ${x} cannot be reached from this computer. ${seen} another anchor it is paired with gives it a second road.`,
        action: { do: 'open', panel: 'devices' },
      });
    }
    return out;
  }

  /** The anchor-unconfirmed card: this computer offers the role, nothing confirmed it from outside,
   *  and it has done so for 6 hours or more. */
  function unconfirmed(now: Snapshot): Suggestion[] {
    const a = objOf(objOf(now.host)?.anchor);
    if (!a || a.on !== true || a.reachable === true || !isTime(a.since) || !isTime(now.at)) return [];
    const ms = now.at - a.since;
    if (ms < UNCONFIRMED_MS) return [];
    return [{
      id: cardId('connections', 'anchor-unconfirmed'), kind: 'suggest', weight: 1,
      title: 'this computer\'s anchor is not confirmed from outside',
      why: `it has offered the anchor role for ${Math.floor(ms / HOUR_MS)} hours. nothing reached it from another network yet; not confirmed is not closed. a device in another home that joins through it confirms it.`,
      action: { do: 'open', panel: 'devices' },
    }];
  }

  /** The one-anchor card's reason this look: exactly one anchor known and a far device. */
  function oneAnchor(now: Snapshot): Suggestion[] {
    const { anchors, hostOn, far, n } = anchorsKnown(now);
    if (n !== 1 || !far) return [];
    const only = hostOn ? 'this computer' : [...anchors.values()][0];
    // this computer's role is off and the one anchor is a far row: the change is to turn it on, behind
    // a "really?" (DECISIONS 5, E2; the person said yes, 17.11.2026)
    const oneId = hostOn ? null : [...anchors.keys()][0];
    const oneRow = oneId == null ? null : listOf(now.devices).slice(0, MAX_DEVICES).map(objOf).find((o) => o !== null && idOf(o.id) === oneId) ?? null;
    const turnOn = objOf(objOf(now.host)?.anchor)?.on === false && oneRow !== null && isFar(oneRow);
    return [{
      id: cardId('connections', 'one-anchor'), kind: 'suggest', weight: 1,
      title: `only one anchor (${only}): if it goes, far devices lose each other`,
      why: 'a second always-on computer in another home, made an anchor, keeps the circle up. this computer knows only the anchors it is paired with.',
      ...(turnOn ? { action: { do: 'anchor', on: true }, label: 'make this an anchor' } : { action: { do: 'open', panel: 'devices' } }),
    }];
  }

  function save() {
    const dev: [string, unknown][] = [...devs.entries()].map(([id, e]) => [id, {
      name: e.name, seen: e.seen, kind: e.kind, at: e.at,
      k: [...e.k.entries()].map(([kind, s]) => [kind, { ring: packRing(s.ring), ms: [...s.ms], last: s.last }]),
      sw: e.sw.map((s) => ({ ...s })),
      ...(e.thru !== null ? { thru: e.thru } : {}),   // only when there is one: today's shape otherwise
      ...(e.nb.length ? { nb: e.nb.map((r) => [...r]) } : {}),   // hashes and times only
      ...(e.hr.length ? { hr: e.hr.map((r) => [...r]) } : {}),   // counts by the hour only
    }]);
    ctx.save({ v: 1, dev });
    dirty = false;
  }

  /** The two rates as the steadier sentence says them. When the whole percents collide, one
   *  decimal (and two, if that collides too) tells the kinds apart. */
  function rateWords(a: number, b: number): string {
    const pa = pctOf(a), pb = pctOf(b);
    if (pa !== pb) return `${pa}% vs ${pb}%`;
    const a1 = (a * 100).toFixed(1), b1 = (b * 100).toFixed(1);
    if (a1 !== b1) return `${a1}% vs ${b1}%`;
    return `${(a * 100).toFixed(2)}% vs ${(b * 100).toFixed(2)}%`;
  }

  /** Which kind answered most reliably, with the numbers that say it; null when nothing is
   *  steadier or the deciding numbers cannot be said. Only kinds with at least 10 probes in
   *  their ring count. */
  function bestPath(e: DevNotes): string | null {
    const lookAt = snap !== null && isTime(snap.at) ? snap.at : null;
    if (lookAt === null) return null;            // no usable look: nothing to compare it with
    const seen: { kind: string; rate: number; ms: number | null }[] = [];
    for (const [kind, s] of e.k) {
      if (s.ring.length < 10) continue;
      // a kind last probed another day, or ahead of this look, has a ring from another era:
      // setting its rate against this one would compare two times without saying so
      if (s.last === null || s.last > lookAt || lookAt - s.last > RECENT_MS) continue;
      const ok = s.ring.filter((x) => x).length;
      // no answer in this ring: the ms list is older than it, so it cannot break a rate tie
      seen.push({ kind, rate: reachRate(s.ring.length, ok)!, ms: ok > 0 ? usualMs(s.ms) : null });
    }
    if (seen.length < 2) return null;
    let best = seen[0];
    for (const s of seen.slice(1)) if (steadier(s, best) < 0) best = s;
    const rest = seen.filter((s) => s !== best);
    let second = rest[0];
    for (const s of rest.slice(1)) if (steadier(s, second) < 0) second = s;
    if (steadier(best, second) >= 0) return null;             // equal: nothing is the steadier
    if (best.rate === second.rate) {
      if (best.ms === null || second.ms === null) return null;   // the tie-breaking numbers cannot be said
      return `${best.kind} has been the steadier link (${best.ms} ms vs ${second.ms} ms)`;
    }
    return `${best.kind} has been the steadier link (${rateWords(best.rate, second.rate)})`;
  }

  /** A snapshot device reached over the internet, a relay or an anchor: the ones whose link gets the words. */
  const isRemote = (d: Record<string, unknown>) => isFar(d) || kindOf(d.via) === 'relay';

  /** What the probes say of the kind a snapshot device names (its via): null until that kind
   *  has 10 probes; med is null until 5 of the ring's answers carry a time. */
  function readingOf(d: Record<string, unknown>): { n: number; ok: number; ms: number[]; med: number | null } | null {
    const id = idOf(d.id);
    const st = id === null ? undefined : devs.get(id)?.k.get(kindOf(d.via));
    if (!st || st.ring.length < 10) return null;
    const ok = st.ring.filter((x) => x).length;
    // only the last ok answer times can be this ring's: earlier answers are another window
    const ms = ok > 0 ? st.ms.slice(-ok) : [];
    return { n: st.ring.length, ok, ms, med: ok > 0 ? usualMs(ms) : null };
  }

  /** The remote link's words: spread, loss and what a split across it can do at best. */
  function remoteWords(r: { n: number; ok: number; ms: number[]; med: number | null }): string {
    let w = '';
    const spread = spreadOf(r.ms);
    if (spread) w += ` · 8 in 10 answers within ${rangeWords(spread[0], spread[1])} ms`;
    const loss = wilson80(r.n - r.ok, r.n);
    if (loss) w += ` · loses ${rangeWords(Math.round(loss[0] * 100), Math.round(loss[1] * 100))}% of probes`;
    if (r.med !== null && r.med >= 1) {
      const best = Math.floor(1000 / r.med);
      const slow = spread && spread[1] >= 1 ? Math.floor(1000 / spread[1]) : null;
      const say = best === 0 ? 'under 1' : `~${slow === null ? best : rangeWords(slow, best)}`;
      w += ` · a split across it: at best ${say} tok/s`;
    }
    return w;
  }

  /** The 'remote links' row: how many devices the look reaches over the internet or a relay,
   *  and the slowest usual latency among them. */
  function remoteRow(objs: (Record<string, unknown> | null)[]): string {
    const remote = objs.filter((o): o is Record<string, unknown> => o !== null && isRemote(o));
    if (!remote.length) return 'none';
    const n = `${remote.length} device${remote.length === 1 ? '' : 's'}`;
    let slowest: number | null = null;
    for (const o of remote) {
      const med = readingOf(o)?.med ?? null;
      if (med !== null && (slowest === null || med > slowest)) slowest = med;
    }
    return slowest === null ? `${n} · not enough answers yet` : `${n} · slowest usually ${slowest} ms`;
  }

  /** One device's line: the words it always had, then what the probes say about the kind the
   *  line's beginning names (the snapshot's via): the rate of that kind, or nothing until a
   *  probe on it arrives. The remembered last-reading kind never leaks into a line of another.
   *  A remote link (internet or relay) then gets its spread, loss and split cost. */
  function deviceLine(raw: unknown): string {
    const d = objOf(raw) ?? {};
    const kind = kindOf(d.via);
    const where = whereOf(d.where);
    const how = kind === 'cable' ? `cable${d.plugged === false ? ' (unplugged)' : ''}` : where === null ? kind : `${kind} · ${where}`;
    const disp = { reachable: boolOrNull(d.reachable), reachMs: usableMs(d.reachMs), reason: reasonOf(d.reason) };
    const id = idOf(d.id);
    const e = id === null ? undefined : devs.get(id);
    let line = `${cut(textOf(d.name) ?? '')} · ${how} · ${reachWord(disp as EyeDevice)}`;
    const st = e?.k.get(kind);
    if (!st || st.ring.length < 10) {
      line += ' · not enough looks yet';
    } else {
      const ok = st.ring.filter((x) => x).length;
      line += ` · answers ${pctOf(ok / st.ring.length)}% over ${kind}`;
      // only the last ok answer times can be this ring's: earlier answers are another window
      const med = ok > 0 ? usualMs(st.ms.slice(-ok)) : null;
      if (med !== null) {
        line += ` · usually ${med} ms`;
        const a = ASSUMED_BY_KIND.get(kind);
        if (a && med > SLOWER_X * a.ms) line += ` · slower than a ${kind} link usually is`;
      }
      const r = isRemote(d) ? readingOf(d) : null;
      if (r) line += remoteWords(r);
    }
    const best = e ? bestPath(e) : null;
    return best ? `${line} · ${best}` : line;
  }

  return {
    id: 'connections',
    observe(now) {
      if (!isTime(now.at)) return;           // no usable time: this look says nothing
      snap = now;
      const at = now.at;
      let changed = false;
      const here = new Set<string>();
      const lookIds = new Set<string>();     // every row id of this look, before the rows are taken in
      const thruIds = new Set<string>();     // the anchors a row of this look goes through: their probes are kept by the hour
      for (const raw of listOf(now.devices).slice(0, MAX_DEVICES)) {
        const o = objOf(raw);
        const id = idOf(o?.id);
        if (id) lookIds.add(id);
        const t = o && kindOf(o.via) === 'anchor' ? idOf(o.through) : null;
        if (t !== null) thruIds.add(t);
      }
      for (const raw of listOf(now.devices).slice(0, MAX_DEVICES)) {
        const d = objOf(raw);
        if (!d) continue;
        const id = idOf(d.id);
        if (!id || here.has(id)) continue;   // first one wins
        here.add(id);
        const name = cut(textOf(d.name) ?? '');
        let e = devs.get(id);
        if (!e) {
          e = { name, seen: at, kind: null, at: null, k: new Map(), sw: [], thru: null, nb: [], hr: [] };
          devs.set(id, e);
          miss.set(id, 0);
          changed = true;
        }
        if (e.name !== name) { e.name = name; changed = true; }
        // the anchor it is routed through: its row says so, and only an anchor that is a row of this
        // look (an absent one may be forgotten or cut from the list: not "not answering"); through
        // this computer, through an absent anchor, or answering over another kind or through a null
        // id clears it, so a later anchor-down card never names an anchor it no longer went through
        const through = kindOf(d.via) === 'anchor' ? idOf(d.through) : null;
        if (through === SELF || (through !== null && through !== id && !lookIds.has(through))) {
          if (e.thru !== null) { e.thru = null; changed = true; }
        } else if (through !== null && through !== id) {
          if (e.thru !== through) { e.thru = through; changed = true; }
        } else if (e.thru !== null && d.reachable === true && (kindOf(d.via) !== 'anchor' || through === null)) {
          e.thru = null;
          changed = true;
        }
        if (at < e.seen - REANCHOR_MS) { e.seen = at; changed = true; }   // the stored seen was a bad clock
        else if (at > e.seen) e.seen = at;
        if (!isTime(d.checkedAt)) continue;  // unusable time: no reading
        const checked = d.checkedAt;
        if (e.at !== null && checked === e.at) continue;   // the same probe: already counted
        if (e.at !== null && at < e.at - REANCHOR_MS) {
          if (e.kind !== null) { e.kind = null; changed = true; }   // the stored reading was a bad clock: forget its kind, no switch; only a real change is dirty
        }
        const reach = boolOrNull(d.reachable);
        if (reach === null) continue;        // not a boolean: this reading says nothing
        const via = kindOf(d.via);
        const prev = e.kind;
        if (prev !== null && via !== prev) {
          e.sw.push({ at, from: prev, to: via });
          if (e.sw.length > SW_MAX) e.sw.shift();
          ctx.emit(via === 'anchor'
            ? `${e.name || id} is now reached through ${wasAfter(anchorWords(through, throughNameOf(d)), prev)}`
            : `${e.name || id} is now reached over ${via} (was ${prev})`);
          changed = true;
        }
        miss.set(id, reach ? 0 : (miss.get(id) ?? 0) + 1);
        e.kind = via;
        e.at = checked;
        let k = e.k.get(via);
        if (!k) {
          if (e.k.size >= MAX_KINDS) {
            // drop the kind with the fewest probes, never the one just switched from: its
            // history was just named in the feed line. a tie drops the earliest seen of the rest
            let drop: string | null = null;
            for (const [kKind, s] of e.k) {
              if (kKind === prev) continue;
              if (drop === null || s.ring.length < e.k.get(drop)!.ring.length) drop = kKind;
            }
            if (drop === null) drop = e.k.keys().next().value ?? null;   // only prev is there: cannot happen with MAX_KINDS > 1
            if (drop !== null) e.k.delete(drop);
          }
          k = { ring: [], ms: [], last: at };
          e.k.set(via, k);
        }
        k.ring.push(reach);
        if (k.ring.length > RING_MAX) k.ring.shift();
        if (reach) {
          const ms = usableMs(d.reachMs);
          if (ms !== null) {
            k.ms.push(ms);
            if (k.ms.length > MS_MAX) k.ms.shift();
          }
        }
        k.last = at;
        if (reach) noteBlock(id, e, d, at);
        if (e.hr.length || keepsHours(d) || thruIds.has(id)) noteHour(e, at, reach);
        changed = true;
      }
      // an anchor absent from this look: no device keeps it as the anchor it went through (also
      // those not in the look, and a 'self' left in older notes)
      for (const e of devs.values()) {
        if (e.thru !== null && !lookIds.has(e.thru)) { e.thru = null; changed = true; }
      }
      // the cap: drop vanished devices first, the oldest seen first; never one this look holds
      if (devs.size > MAX_DEVICES) {
        const gone = [...devs.entries()].filter(([id]) => !here.has(id)).sort((a, b) => a[1].seen - b[1].seen);
        for (const [id] of gone) {
          if (devs.size <= MAX_DEVICES) break;
          devs.delete(id);
          miss.delete(id);
          movedAt.delete(id);
          movedDay.delete(id);
          changed = true;
        }
      }
      // a moved card lasts 24 h from its look; a look before it (a bad clock) ends it too
      for (const [id, t] of movedAt) if (at - t >= MOVED_MS || at < t) movedAt.delete(id);
      // the anchor-down cards: one feed line when one shows and one when it goes
      const down = anchorDown(now, here);
      downCards = down.map((x) => x.card);
      for (const { y, card } of down) if (!downNow.has(y)) ctx.emit(card.title);
      for (const y of downNow.keys()) {
        if (down.some((x) => x.y === y)) continue;
        const yT = anchorWords(y);
        ctx.emit(here.has(y) && (miss.get(y) ?? 0) === 0
          ? `${yT} answers again`
          : `nothing reached through ${yT} is cut off now`);
      }
      downNow.clear();
      for (const { y } of down) downNow.add(y);
      const one = oneAnchor(now);
      steadyCards = steady.step(one, one);
      if (changed) dirty = true;
      const wall = ctx.now();
      if (Number.isFinite(wall)) { if (wall < savedAt) savedAt = wall; }   // a backward clock must not stop saving for long
      if (dirty && Number.isFinite(wall) && wall - savedAt >= SAVE_EVERY_MS) { save(); savedAt = wall; }
    },
    view(): BranchView {
      const objs = listOf(snap?.devices).map((d) => objOf(d));   // null where an entry is not an object
      const cable = objs.filter((o) => o !== null && kindOf(o.via) === 'cable' && o.plugged !== false).length;
      const wifi = objs.filter((o) => o !== null && kindOf(o.via) === 'wifi').length;
      const relay = objs.filter((o) => o !== null && kindOf(o.via) === 'relay').length;
      const kindCounts = new Map<string, number>();              // one pass, first-seen order, no find() per entry
      for (const o of objs) {
        if (o === null) continue;
        const k = kindOf(o.via);
        kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
      }
      const kinds = [...kindCounts.entries()];
      // reached, but only over the internet: one card per device while it lasts
      const suggestions: Suggestion[] = [];
      for (const o of objs) {
        if (o === null || o.reachable !== true || !overInternet(o) || kindOf(o.via) === 'anchor') continue;
        const id = idOf(o.id);
        if (id === null) continue;
        const name = rowName(o, id);
        const at = o.reachedBy === 'mapped' ? 'the port its router opened' : o.reachedBy === 'ipv6' ? 'its ipv6 address' : 'an internet address';
        suggestions.push({
          id: cardId('connections', 'internet', id), kind: 'warn', weight: 1,
          title: `${name} is reached over the internet`,
          why: `its lan address did not answer; its pinned certificate answered at ${at}. answers are slower there. apart and split both work over it; a split waits about one round trip per token for each far worker (the planner says the estimate).`,
          action: { do: 'probe', devices: [id] }, label: 'look again',
        });
      }
      // reached through an anchor: one card per anchor while it lasts
      // key: Y (an id, or SELF), or name:<throughName> for an anchor the engine knows by name only
      const through = new Map<string, { y: string | null; tn: string | null; ds: { id: string; name: string }[] }>();
      const taken = new Set<string>();
      for (const o of objs) {
        if (o === null || o.reachable !== true || kindOf(o.via) !== 'anchor') continue;
        const id = idOf(o.id), y = idOf(o.through), tn = throughNameOf(o);
        const key = y ?? (tn !== null ? `name:${tn}` : null);
        if (id === null || key === null || y === id || taken.has(id)) continue;
        taken.add(id);
        const g = through.get(key) ?? { y, tn, ds: [] };
        g.ds.push({ id, name: rowName(o, id) });
        through.set(key, g);
      }
      for (const [key, { y, tn, ds }] of through) {
        // the anchor kind's readings of these devices, pooled: usually ~N ms from K probes
        let k = 0;
        const ms: number[] = [];
        for (const d of ds) {
          const st = devs.get(d.id)?.k.get('anchor');
          if (!st) continue;
          k += st.ring.length;
          const ok = st.ring.filter((x) => x).length;
          if (ok > 0) ms.push(...st.ms.slice(-ok));   // only the last ok answer times are this ring's
        }
        const med = k >= 10 ? usualMs(ms) : null;
        const yN = (y === null ? null : anchorName(y)) ?? tn;
        suggestions.push({
          id: cardId('connections', 'through', key), kind: 'warn', weight: 1,
          title: `${fewNames(ds.map((d) => d.name))} ${ds.length === 1 ? 'is' : 'are'} reached through ${anchorWords(y, tn)}`,
          why: `neither their wi-fi nor a direct internet address answered. ${yN ?? 'the anchor'} passes the bytes on and cannot read them. `
            + `${med !== null ? `usually ~${med} ms (from ${k} probes)` : 'not enough looks yet'}. apart and split both work; the planner says what a split would cost.`,
          action: { do: 'probe', devices: ds.map((d) => d.id) }, label: 'look again',
        });
      }
      // answered from an unseen network after being settled: 24 h, opens the trust branch
      for (const id of movedAt.keys()) {
        const e = devs.get(id);
        if (!e) continue;
        suggestions.push({
          id: cardId('connections', 'moved', id), kind: 'warn', weight: 2,
          title: movedWords(e.name || id),
          why: 'its certificate is the one pinned from its qr, so it holds the same key: normal after a move or a new provider, or its provider gave it a new address. '
            + 'if nobody moved it, its key may have been copied: ask its owner, or pair again. the brain compares address blocks; it cannot say where.',
          action: { do: 'open', panel: 'branch', branch: 'trust' }, label: 'trust',
        });
      }
      if (snap !== null) suggestions.push(...oneRoad(snap), ...unconfirmed(snap));
      suggestions.push(...downCards, ...steadyCards);
      // the loss hint for the deciding branches: remote devices whose kind has 10 probes
      const hints: DeviceHint[] = [];
      const hinted = new Set<string>();
      for (const o of objs) {
        if (o === null || !isRemote(o)) continue;
        const id = idOf(o.id);
        const r = id === null || hinted.has(id) ? null : readingOf(o);
        const loss = r ? wilson80(r.n - r.ok, r.n) : null;
        if (id === null || !loss) continue;
        hinted.add(id);
        hints.push({ id, loss: { hi: loss[1] } });
      }
      const today = snap !== null && isTime(snap.at) ? dayKey(snap.at) : null;
      let switches = 0;
      if (today !== null) {
        for (const e of devs.values()) for (const s of e.sw) if (dayKey(s.at) === today) switches++;
      }
      return {
        built: true,
        stat: `${cable} cable · ${wifi} wi-fi${relay ? ` · ${relay} relay` : ''}${kindCounts.get('internet') ? ` · ${kindCounts.get('internet')} internet` : ''}`
          + `${kindCounts.get('anchor') ? ` · ${kindCounts.get('anchor')} anchor` : ''}`,
        gauge: null,
        rows: [
          ['kinds', kinds.length ? kinds.map(([k, n]) => `${k} ${n}`).join(' · ') : 'none yet'],
          ['switches today', String(switches)],
          ['assumed', ASSUMED_LINE],
          ['remote links', remoteRow(objs)],
        ],
        lines: objs.filter((o) => o !== null).map((o) => deviceLine(o)),
        note: objs.length ? undefined : 'no device yet.',
        ...(suggestions.length ? { suggestions } : {}),
        ...(hints.length ? { hints } : {}),
      };
    },
  };
}
