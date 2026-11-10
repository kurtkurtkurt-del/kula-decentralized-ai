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
import type { Branch, BranchCtx, BranchView, EyeDevice, Snapshot } from '../types.js';
import { reachWord } from './util.js';

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

/** What each kind is expected to be like: the assumptions table above. 'other' has none. */
export const ASSUMED: { kind: string; ms: number; drops: string }[] = [
  { kind: 'cable', ms: 20, drops: 'rare' },
  { kind: 'wifi', ms: 80, drops: 'sometimes' },
  { kind: 'relay', ms: 300, drops: 'sometimes' },
  { kind: 'internet', ms: 150, drops: 'often' },
];
const ASSUMED_BY_KIND = new Map(ASSUMED.map((a) => [a.kind, a]));
const ASSUMED_LINE = `${ASSUMED.map((a) => `${a.kind}: ${a.ms} ms, ${a.drops} drops`).join(' · ')} · other: none`;

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
}
/** The notes as they live in memory: dev is a Map by id, so ids like __proto__ are ordinary keys. */
export interface ConnectionsNotes { v: 1; dev: Map<string, DevNotes> }
/** The notes as they live on disk: dev is an array of [id, device] pairs (json cannot hold a Map). */
interface NotesFile { v: 1; dev: unknown[] }

const cut = (s: string): string => s.slice(0, STR_MAX);
/** A probe ring as the notes hold it: '1' answered, '0' missed, oldest first. */
const packRing = (ring: boolean[]): string => ring.map((ok) => (ok ? '1' : '0')).join('');
const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_TIME;
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
/** The address as today's line shows it: a string cut to WHERE_MAX; anything else is left out. */
const whereOf = (x: unknown): string | null =>
  typeof x === 'string' ? x.slice(0, WHERE_MAX) : null;
/** A reason as today's line shows it: a string cut to REASON_MAX; anything else is left out. */
const reasonOf = (x: unknown): string | null =>
  typeof x === 'string' ? x.slice(0, REASON_MAX) : null;
const listOf = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const objOf = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : null;
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
  return [id, { name: cut(e.name), seen: e.seen, kind: e.kind, at: e.at, k, sw }];
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

  function save() {
    const dev: [string, unknown][] = [...devs.entries()].map(([id, e]) => [id, {
      name: e.name, seen: e.seen, kind: e.kind, at: e.at,
      k: [...e.k.entries()].map(([kind, s]) => [kind, { ring: packRing(s.ring), ms: [...s.ms], last: s.last }]),
      sw: e.sw.map((s) => ({ ...s })),
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

  /** One device's line: the words it always had, then what the probes say about the kind the
   *  line's beginning names (the snapshot's via): the rate of that kind, or nothing until a
   *  probe on it arrives. The remembered last-reading kind never leaks into a line of another. */
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
      for (const raw of listOf(now.devices).slice(0, MAX_DEVICES)) {
        const d = objOf(raw);
        if (!d) continue;
        const id = idOf(d.id);
        if (!id || here.has(id)) continue;   // first one wins
        here.add(id);
        const name = cut(textOf(d.name) ?? '');
        let e = devs.get(id);
        if (!e) {
          e = { name, seen: at, kind: null, at: null, k: new Map(), sw: [] };
          devs.set(id, e);
          changed = true;
        }
        if (e.name !== name) { e.name = name; changed = true; }
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
          ctx.emit(`${e.name || id} is now reached over ${via} (was ${prev})`);
          changed = true;
        }
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
        changed = true;
      }
      // the cap: drop vanished devices first, the oldest seen first; never one this look holds
      if (devs.size > MAX_DEVICES) {
        const gone = [...devs.entries()].filter(([id]) => !here.has(id)).sort((a, b) => a[1].seen - b[1].seen);
        for (const [id] of gone) {
          if (devs.size <= MAX_DEVICES) break;
          devs.delete(id);
          changed = true;
        }
      }
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
      const today = snap !== null && isTime(snap.at) ? dayKey(snap.at) : null;
      let switches = 0;
      if (today !== null) {
        for (const e of devs.values()) for (const s of e.sw) if (dayKey(s.at) === today) switches++;
      }
      return {
        built: true,
        stat: `${cable} cable · ${wifi} wi-fi${relay ? ` · ${relay} relay` : ''}`,
        gauge: null,
        rows: [
          ['kinds', kinds.length ? kinds.map(([k, n]) => `${k} ${n}`).join(' · ') : 'none yet'],
          ['switches today', String(switches)],
          ['assumed', ASSUMED_LINE],
        ],
        lines: objs.filter((o) => o !== null).map((o) => deviceLine(o)),
        note: objs.length ? undefined : 'no device yet.',
      };
    },
  };
}
