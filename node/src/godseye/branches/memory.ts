// 2 memory: what happened and why, kept on this computer. Two things live here:
//  - the decisions kula itself wrote about devices (snapshot.work.decisions), as they arrive; the
//    very first look already logs the decisions it holds, because the old view showed them;
//  - a log of what changed between one look and the next: a device appeared or left, answered or
//    stopped answering, was plugged or unplugged, changed how it is reached, or changed the model
//    file it holds; the model loaded, unloaded or changed mode; a project changed state. An event
//    only when something changes, never one per look; the other kinds never record on the first
//    look, which only remembers where things stand.
// Notes are one small json (ctx.save). Bounds: at most MAX_EVENTS events, nothing older than
// KEEP_MS by the agreed newest look, every string at most STR_MAX chars, at most MAX_DEVICES
// devices and MAX_PROJECTS projects remembered for the next look. Only the first MAX_DEVICES /
// MAX_PROJECTS by snapshot order count, a duplicate id keeps its first entry, and an id that is not
// a non-empty string of at most STR_MAX chars is ignored; the extras are ignored in the diff too,
// so they never appear as new on every look. Saved at most once a minute and only when something
// changed. The log never holds an address (where), a reason, trust data, or anything a person
// wrote: for a project it keeps its id and its new state, never its title, request, line or error.
// A decision's text is kula's own, but it names addresses: every IPv4[:port], IPv6 and host:port in
// it becomes "an address" before it is logged, and notes from before that are cleaned on load.
// Over MAX_EVENTS the oldest up/down/via lines go first, so a flapping device never pushes the
// decisions out.
// A decision's own at is the notes' watermark (lastDecisionAt); its event is stamped with the
// look's at. The notes keep two lists of at + text, at most LOGGED_MAX each: the last LOGGED_MAX
// logged decisions, so a watermark moved backwards never re-logs one, and the last LOGGED_MAX
// stamped later than their look, so a future-stamped decision is logged once and never again after
// the first list forgets it. A decision is already logged when it is in either list; a snapshot
// longer than LOGGED_MAX only counts its last LOGGED_MAX decisions (the engine appends newest
// last); a file from before the future list (memory-1) loads with an empty one.
// Data time is the snapshot's at (finite, 0..8.64e15); ctx.now() only paces saves and the hourly
// prune. Every look is diffed against the remembered state, so a look with no usable at only
// returns early and the next good look sees what changed. A clock that jumps backwards by minutes
// still records. Every high-water mark re-anchors: a look more than KEEP_MS behind the newest t
// seen (or the watermark) means a bad clock, so the log re-anchors, drops events stamped in the
// future, and logs every decision in the look not already logged. A decision stamped later than
// its look never pushes the watermark past that look's at. A look more than KEEP_MS ahead moves
// the newest t seen but not the prune anchor: the prune waits until the next look agrees, so one
// bad look cannot wipe the real history. Snapshot containers and entries are checked: a non-array
// is empty, a null entry is skipped, and a non-string, non-number field counts as missing.
import type { Branch, BranchCtx, BranchView, Snapshot } from '../types.js';
import { hhmm } from './util.js';

export const MAX_EVENTS = 2000;
export const KEEP_MS = 90 * 24 * 3600_000;
export const STR_MAX = 200;
const MAX_DEVICES = 100;
const MAX_PROJECTS = 100;
const LOGGED_MAX = 30;               // the engine sends at most its last 30 decisions
const LINES_MAX = 40;
const SAVE_EVERY_MS = 60_000;
const PRUNE_EVERY_MS = 3_600_000;
const MAX_TIME = 8.64e15;            // the last ms a Date can hold; later is no time at all

export type MemoryKind =
  | 'appeared' | 'gone' | 'up' | 'down' | 'plugged' | 'unplugged' | 'via' | 'holds'
  | 'loaded' | 'unloaded' | 'mode' | 'project' | 'decision';

/** One change between two looks: when it was seen, what kind, which device (or project) and a
 *  small detail. Nothing else is kept. */
export interface MemoryEvent {
  t: number;                       // snapshot.at of the look that saw it
  k: MemoryKind;
  d: string | null;                // device id, project id, or null
  n: string | null;                // device name, or null
  x: string | null;                // small detail: file, mode, from → to, project state, decision text
}

/** The order the kinds are counted in the view. */
const KINDS: MemoryKind[] = ['appeared', 'gone', 'up', 'down', 'plugged', 'unplugged', 'via', 'holds', 'loaded', 'unloaded', 'mode', 'project', 'decision'];
const KIND_SET = new Set<string>(KINDS);

export interface SeenDevice {
  id: string;
  name: string;
  reachable: boolean | null;
  plugged: boolean | null;
  via: string;
  holds: string | null;
}

export interface SeenWork { loaded: { file: string; name: string; mode: string } | null }
export interface SeenProject { id: string; state: string }
/** A decision already logged: enough to tell it from a new one after the watermark moves back. */
export interface LoggedDecision { at: number; text: string }

/** What the notes remember of the last look: enough to see a change after a restart, no more. */
export interface Remembered {
  looked: boolean;
  devices: SeenDevice[];
  work: SeenWork;
  projects: SeenProject[];
}

/** The remembered state plus the decision watermark, as the branch carries it while running. */
export interface MemoryState extends Remembered { lastDecisionAt: number | null }

export interface MemoryNotes {
  v: 1;
  ev: MemoryEvent[];
  lastDecisionAt: number | null;
  logged: LoggedDecision[];
  future: LoggedDecision[];
  state: Remembered;
}

const cut = (s: string): string => s.slice(0, STR_MAX);
const cutOrNull = (s: string | null | undefined): string | null => (s == null ? null : cut(String(s)));
const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_TIME;
const boolOrNull = (x: unknown): boolean | null => (x === true || x === false ? x : null);
/** A string from a snapshot field: strings stay, finite numbers become their text, anything else is
 *  missing. An object must never reach a line as "[object Object]". */
const textOf = (x: unknown): string | null =>
  typeof x === 'string' ? x : typeof x === 'number' && Number.isFinite(x) ? String(x) : null;
/** A usable id: a non-empty string no longer than STR_MAX, so a cut id is never compared with a full one. */
const idOf = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 && x.length <= STR_MAX ? x : null);
const listOf = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const objOf = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : null;
const sig = (at: number, text: string) => `${at}|${text}`;

/** An address inside a person-readable text, replaced with "an address": a bracketed IPv6 with an
 *  optional port, a bare IPv6 (with :: or all eight groups, so a time like 12:30:45 stays), an
 *  IPv4 with an optional port, and a host:port whose host starts with a letter. A version such as
 *  1.2.3, a time such as 23:00 and plain words stay. Applied before the cut, so a cut never leaves
 *  half an address. */
const ADDRESS = 'an address';
const V6_BRACKETED = /\[[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*(?:%[\w.-]+)?\](?::\d{1,5})?/g;
const V6_BARE = /(?<![\w:.])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:(?:\.\d{1,3}){3})?(?:%[\w.-]*\w)?(?![\w:]|\.\d)/g;
const V4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\w]|\.\d)/g;
const HOST_PORT = /(?<![\w.:-])[A-Za-z][\w-]*(?:\.[A-Za-z0-9][\w-]*)*:\d{1,5}(?![\w:]|\.\d)/g;
const isV6 = (s: string): boolean => {
  const core = s.replace(/%.*$/, '').replace(/(?:\.\d{1,3}){3}$/, '');
  return /[0-9A-Fa-f]/.test(core) && (core.includes('::') || core.split(':').length === 8);
};
export function maskAddresses(text: string): string {
  return text
    .replace(V6_BRACKETED, ADDRESS)
    .replace(V6_BARE, (m) => (isV6(m) ? ADDRESS : m))
    .replace(V4, ADDRESS)
    .replace(HOST_PORT, ADDRESS);
}
/** A decision's text as the notes keep it: no address, at most STR_MAX chars. */
const decisionText = (text: string): string => cut(maskAddresses(text));
const cleanLogged = (l: LoggedDecision): LoggedDecision => ({ at: l.at, text: decisionText(l.text) });
/** The non-empty parts of a detail joined with ·: a missing name or mode leaves no gap. */
const detail = (...parts: string[]): string | null => {
  const kept = parts.filter((p) => p.length > 0);
  return kept.length > 0 ? kept.join(' · ') : null;
};

/** The local calendar day, YYYY-MM-DD. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

const freshState = (): Remembered => ({ looked: false, devices: [], work: { loaded: null }, projects: [] });
const freshNotes = (): MemoryNotes => ({ v: 1, ev: [], lastDecisionAt: null, logged: [], future: [], state: freshState() });

function sameState(a: Remembered, b: Remembered): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function seenDevice(d: Record<string, unknown>, id: string): SeenDevice {
  const holds = textOf(d.holds);
  return {
    id, name: cut(textOf(d.name) ?? ''), reachable: boolOrNull(d.reachable), plugged: boolOrNull(d.plugged),
    via: cut(textOf(d.via) ?? ''), holds: holds === null ? null : cut(holds),
  };
}

function smallWork(w: unknown): SeenWork['loaded'] {
  const work = objOf(w);
  const l = work ? objOf(work.loaded) : null;
  if (!l) return null;
  const m = objOf(l.model) ?? {};
  return { file: cut(textOf(m.file) ?? ''), name: cut(textOf(m.name) ?? ''), mode: cut(textOf(l.mode) ?? '') };
}

/** The small part of a snapshot worth remembering: what a later look is compared with. Only the
 *  first MAX_DEVICES devices and MAX_PROJECTS projects count; odd fields are coerced, a duplicate
 *  id keeps its first entry, and a device or project without a usable id is left out. */
export function stateOf(s: Snapshot): Remembered {
  const devices: SeenDevice[] = [];
  const devIds = new Set<string>();
  for (const raw of listOf(s?.devices).slice(0, MAX_DEVICES)) {
    const d = objOf(raw);
    if (!d) continue;
    const id = idOf(d.id);
    if (!id || devIds.has(id)) continue;           // first one wins
    devIds.add(id);
    devices.push(seenDevice(d, id));
  }
  const projects: SeenProject[] = [];
  const projIds = new Set<string>();
  for (const raw of listOf(s?.projects).slice(0, MAX_PROJECTS)) {
    const p = objOf(raw);
    if (!p) continue;
    const id = idOf(p.id);
    const state = textOf(p.state);
    if (!id || state === null || projIds.has(id)) continue;   // first one wins
    projIds.add(id);
    projects.push({ id, state: cut(state) });
  }
  return { looked: true, devices, work: { loaded: smallWork(s?.work) }, projects };
}

function remembered(x: MemoryState): Remembered {
  return { looked: x.looked, devices: x.devices, work: x.work, projects: x.projects };
}

/** The changes between what the notes remember and this look. Nothing remembered (the first look)
 *  means nothing to compare with: no events. Both sides come from stateOf, so the caps and the
 *  coercion are the same as the notes'. `next` is stateOf(now) when the caller already has it. */
export function diff(now: Snapshot, rememberedState: Remembered | null, next: Remembered = stateOf(now)): MemoryEvent[] {
  const was = rememberedState ?? freshState();
  if (!was.looked) return [];
  const t = now.at;
  const out: MemoryEvent[] = [];
  const push = (k: MemoryKind, d: string | null, n: string | null, x: string | null) =>
    out.push({ t, k, d: cutOrNull(d), n: cutOrNull(n), x: cutOrNull(x) });

  const prev = new Map<string, SeenDevice>();
  for (const d of was.devices) prev.set(d.id, d);
  for (const d of next.devices) {
    const name = d.name || null;
    const p = prev.get(d.id);
    if (!p) { push('appeared', d.id, name, null); continue; }
    // null means "not looked at / unknown": it never counts as up/down or plugged/unplugged
    if (p.reachable !== null && d.reachable !== null && p.reachable !== d.reachable) push(d.reachable ? 'up' : 'down', d.id, name, null);
    if (p.plugged !== null && d.plugged !== null && p.plugged !== d.plugged) push(d.plugged ? 'plugged' : 'unplugged', d.id, name, null);
    if (p.via !== d.via) push('via', d.id, name, `${p.via} → ${d.via}`);
    if (p.holds !== d.holds) push('holds', d.id, name, d.holds);
  }
  const here = new Set(next.devices.map((d) => d.id));
  for (const p of was.devices) if (!here.has(p.id)) push('gone', p.id, p.name || null, null);

  const wasWork = was.work.loaded;
  const isWork = next.work.loaded;
  if (!wasWork && isWork) push('loaded', null, null, detail(isWork.name, isWork.mode));
  else if (wasWork && !isWork) push('unloaded', null, null, null);
  else if (wasWork && isWork) {
    if (wasWork.file !== isWork.file) push('loaded', null, null, detail(isWork.name, isWork.mode));
    else if (wasWork.mode !== isWork.mode) push('mode', null, null, `${wasWork.mode} → ${isWork.mode}`);
  }

  // only the id and the new state: a project's title, request, line and error may hold what a person wrote
  const projects = new Map<string, string>();
  for (const p of was.projects) projects.set(p.id, p.state);
  for (const p of next.projects) {
    const wasState = projects.get(p.id);
    if (wasState !== undefined && wasState !== p.state) push('project', p.id, null, p.state);
  }

  return out;
}

/** Decisions not already logged, as events, the new watermark and the two bounded lists. Only the
 *  last LOGGED_MAX decisions of the snapshot count (the engine appends newest last), so a longer
 *  list cannot outgrow the lists. On a normal look that means decisions newer than the watermark;
 *  when the watermark is later than this look (a corrected clock), the look re-anchors: every
 *  decision in the look that is not already in a list is logged, whatever its at. A decision
 *  stamped later than now.at is logged once and kept in `future`, so the ring rolling over never
 *  logs it again; the watermark never moves past now.at. */
export function newDecisions(
  now: Snapshot,
  lastDecisionAt: number | null,
  logged: LoggedDecision[] = [],
  future: LoggedDecision[] = [],
): { events: MemoryEvent[]; last: number | null; logged: LoggedDecision[]; future: LoggedDecision[] } {
  const events: MemoryEvent[] = [];
  const ring = logged.slice(-LOGGED_MAX).map(cleanLogged);
  const ahead = future.slice(-LOGGED_MAX).map(cleanLogged);
  const seen = new Set([...ring, ...ahead].map((l) => sig(l.at, l.text)));
  const reanchored = lastDecisionAt !== null && lastDecisionAt > now.at;
  let last = reanchored ? now.at : lastDecisionAt;
  // the watermark before this look: the loop's own marks must not hide a decision that came
  // after a future-stamped one in the list
  const floor = last;
  for (const raw of listOf(objOf(now.work)?.decisions).slice(-LOGGED_MAX)) {
    const d = objOf(raw);
    if (!d) continue;
    const at = d.at;
    const text = textOf(d.text);
    if (!isTime(at) || text === null) continue;
    const x = decisionText(text);                              // never an address in the log
    if (seen.has(sig(at, x))) continue;                        // already logged: never again
    // the engine stamps and appends a decision in one step, so a first look is at or past its at;
    // one at or below the watermark is skipped, which only a same-millisecond tie can cause
    if (!reanchored && floor !== null && at <= floor) continue;
    events.push({ t: now.at, k: 'decision', d: null, n: null, x });
    seen.add(sig(at, x));
    if (at > now.at) {
      ahead.push({ at, text: x });
      if (ahead.length > LOGGED_MAX) ahead.shift();
    } else {
      ring.push({ at, text: x });
      if (ring.length > LOGGED_MAX) ring.shift();
    }
    const mark = Math.min(at, now.at);                         // never push the watermark past this look
    if (last === null || mark > last) last = mark;
  }
  return { events, last, logged: ring, future: ahead };
}

/** The kinds one flapping device can repeat without end: over the cap they go first, so a device
 *  going up and down all night never pushes a person's decisions out of the log. */
const CHURN = new Set<MemoryKind>(['up', 'down', 'via']);

/** The log after its bounds: nothing older than KEEP_MS below the prune anchor, at most MAX_EVENTS
 *  events. Over the cap the oldest up/down/via lines go first, then the oldest of anything. Pure:
 *  the input array is not changed. */
export function prune(events: MemoryEvent[], newestT: number): MemoryEvent[] {
  const cutoff = newestT - KEEP_MS;
  return capped(events.filter((e) => e.t >= cutoff));
}

/** At most MAX_EVENTS events: the oldest up/down/via first, then the oldest of anything. */
function capped(kept: MemoryEvent[]): MemoryEvent[] {
  const over = kept.length - MAX_EVENTS;
  if (over <= 0) return kept;
  const drop = new Set<number>();
  for (let i = 0; i < kept.length && drop.size < over; i++) if (CHURN.has(kept[i].k)) drop.add(i);
  const rest = drop.size > 0 ? kept.filter((_, i) => !drop.has(i)) : kept;
  return rest.length > MAX_EVENTS ? rest.slice(rest.length - MAX_EVENTS) : rest;
}

const ev = (x: unknown): MemoryEvent | null => {
  const e = x as MemoryEvent;
  if (!e || typeof e !== 'object') return null;
  if (!isTime(e.t) || typeof e.k !== 'string' || !KIND_SET.has(e.k)) return null;
  if (!(e.d === null || typeof e.d === 'string') || !(e.n === null || typeof e.n === 'string') || !(e.x === null || typeof e.x === 'string')) return null;
  return { t: e.t, k: e.k as MemoryKind, d: cutOrNull(e.d), n: cutOrNull(e.n), x: cutOrNull(e.x) };
};

/** Set when loading masked an address that older notes still held, so they are written back. */
interface Load { masked: boolean }

/** A decision's text from disk: notes written before the mask may still hold an address. */
function loadedText(s: string, load: Load): string {
  const clean = decisionText(s);
  if (clean !== cut(s)) load.masked = true;
  return clean;
}

function saneLogged(x: unknown, load: Load): LoggedDecision[] | null {
  if (!Array.isArray(x)) return null;
  const out: LoggedDecision[] = [];
  for (const raw of x.slice(-LOGGED_MAX)) {
    const e = objOf(raw);
    if (!e || !isTime(e.at) || typeof e.text !== 'string') return null;
    out.push({ at: e.at, text: loadedText(e.text, load) });
  }
  return out;
}

function saneState(x: unknown): Remembered | null {
  const s = objOf(x) as unknown as Remembered;
  if (!s || typeof s.looked !== 'boolean' || !Array.isArray(s.devices) || !Array.isArray(s.projects)) return null;
  const devices: SeenDevice[] = [];
  const devIds = new Set<string>();
  for (const raw of s.devices.slice(0, MAX_DEVICES)) {
    const d = objOf(raw);
    if (!d) return null;
    const id = idOf(d.id);
    if (!id) return null;
    if (!(d.reachable === null || typeof d.reachable === 'boolean')) return null;
    if (!(d.plugged === null || typeof d.plugged === 'boolean')) return null;
    if (!(d.holds === null || typeof d.holds === 'string')) return null;
    if (typeof d.name !== 'string' || typeof d.via !== 'string') return null;
    if (devIds.has(id)) continue;                    // first one wins
    devIds.add(id);
    devices.push({ id, name: cut(d.name), reachable: d.reachable, plugged: d.plugged, via: cut(d.via), holds: cutOrNull(d.holds) });
  }
  const w = objOf(s.work);
  if (!w) return null;
  let loaded: SeenWork['loaded'] = null;
  if (w.loaded !== null) {
    const l = objOf(w.loaded);
    if (!l || typeof l.file !== 'string' || typeof l.name !== 'string' || typeof l.mode !== 'string') return null;
    loaded = { file: cut(l.file), name: cut(l.name), mode: cut(l.mode) };
  }
  const projects: SeenProject[] = [];
  const projIds = new Set<string>();
  for (const raw of s.projects.slice(0, MAX_PROJECTS)) {
    const p = objOf(raw);
    if (!p) return null;
    const id = idOf(p.id);
    if (!id || typeof p.state !== 'string') return null;
    if (projIds.has(id)) continue;                   // first one wins
    projIds.add(id);
    projects.push({ id, state: cut(p.state) });
  }
  return { looked: s.looked, devices, work: { loaded }, projects };
}

/** A notes file from disk, kept only if it has exactly the shape this file writes. A bad shape
 *  (or NaN / negative / past-Date times) gives fresh notes, never a throw. */
function sane(x: unknown, load: Load = { masked: false }): MemoryNotes {
  const n = objOf(x) as unknown as MemoryNotes;
  if (!n || n.v !== 1 || !Array.isArray(n.ev)) return freshNotes();
  const events: MemoryEvent[] = [];
  for (const e of n.ev) {
    const one = ev(e);
    if (!one) return freshNotes();
    if (one.k === 'decision' && one.x !== null) one.x = loadedText((e as MemoryEvent).x as string, load);
    events.push(one);
  }
  if (!(n.lastDecisionAt === null || isTime(n.lastDecisionAt))) return freshNotes();
  const logged = saneLogged(n.logged, load);
  if (!logged) return freshNotes();
  const future = n.future === undefined ? [] : saneLogged(n.future, load);   // memory-1 wrote no list
  if (!future) return freshNotes();
  const state = saneState(n.state);
  if (!state) return freshNotes();
  return { v: 1, ev: capped(events), lastDecisionAt: n.lastDecisionAt, logged, future, state };
}

/** One event as the view's line, after the HH:MM. Plain words; never an address. */
function words(e: MemoryEvent): string {
  const who = e.n || e.d || 'a device';
  const x = e.x ?? '';
  switch (e.k) {
    case 'appeared': return `${who} appeared`;
    case 'gone': return `${who} is gone`;
    case 'up': return `${who} answers again`;
    case 'down': return `${who} stopped answering`;
    case 'plugged': return `${who} was plugged in`;
    case 'unplugged': return `${who} was unplugged`;
    case 'via': return `${who} is reached differently: ${x}`;
    case 'holds': return e.x ? `${who} now holds ${x}` : `${who} holds nothing now`;
    case 'loaded': return x ? `the model loaded: ${x}` : 'the model loaded';
    case 'unloaded': return 'the model was unloaded';
    case 'mode': return `the mode changed: ${x}`;
    case 'project': return `project ${e.d ?? '?'} is now ${x}`;
    case 'decision': return x;
  }
}

export function create(ctx: BranchCtx): Branch {
  const load: Load = { masked: false };
  const notes = sane(ctx.load<unknown>(null), load);
  let state: MemoryState = { ...notes.state, lastDecisionAt: notes.lastDecisionAt };
  let logged = notes.logged;
  let future = notes.future;
  let events = notes.ev;
  let newestT: number | null = events.reduce<number | null>((m, e) => (m === null || e.t > m ? e.t : m), null);
  let pruneT: number | null = newestT;      // the newest time two agreeing looks have shown
  let snap: Snapshot | null = null;
  let savedAt = Number.NEGATIVE_INFINITY;   // the first change after start is saved at once
  let lastPrune = Number.NEGATIVE_INFINITY;
  let dirty = load.masked;                  // something changed since the last save (or an old address was masked)

  function save() {
    notes.ev = events;
    notes.lastDecisionAt = state.lastDecisionAt;
    notes.logged = logged;
    notes.future = future;
    notes.state = remembered(state);
    ctx.save(notes);
    dirty = false;
  }

  return {
    id: 'memory',
    observe(now) {
      if (!isTime(now.at)) return;             // no usable time: this look says nothing, the state stands
      snap = now;
      const at = now.at;

      // Every high-water mark re-anchors. A look far behind the newest t seen means that newest was
      // a bad clock: re-anchor to this look and drop the events stamped in the future. A look far
      // ahead is recorded, but the prune anchor waits until the next look agrees with it.
      if (newestT === null) {
        newestT = at;
        pruneT = at;
      } else if (at < newestT - KEEP_MS) {
        const kept = events.filter((e) => e.t <= at);
        if (kept.length !== events.length) { events = kept; dirty = true; }
        newestT = at;
        pruneT = at;
      } else if (at > newestT + KEEP_MS) {
        newestT = at;
      } else {
        newestT = Math.max(newestT, at);
        pruneT = newestT;
      }
      const anchor = pruneT ?? at;

      const nextState = stateOf(now);
      const changed = diff(now, state, nextState);
      const d = newDecisions(now, state.lastDecisionAt, logged, future);
      changed.push(...d.events);
      logged = d.logged;
      future = d.future;
      const after: MemoryState = { ...nextState, lastDecisionAt: d.last };
      if (!sameState(state, after)) dirty = true;
      state = after;

      const added = changed.length > 0;
      if (added) { events = events.concat(changed); dirty = true; }

      const wall = ctx.now();
      if (Number.isFinite(wall)) {
        if (wall < savedAt) savedAt = wall;               // a backward clock must not stop saving for long
        if (wall < lastPrune) lastPrune = wall;
      }
      // prune after new events whatever the wall clock says, and once an hour when it can be paced
      if (added || (Number.isFinite(wall) && wall - lastPrune >= PRUNE_EVERY_MS)) {
        const kept = prune(events, anchor);
        if (kept.length !== events.length) dirty = true;
        events = kept;
        if (Number.isFinite(wall)) lastPrune = wall;
      }
      if (dirty && Number.isFinite(wall) && wall - savedAt >= SAVE_EVERY_MS) { save(); savedAt = wall; }
    },
    view(): BranchView {
      const today = snap !== null && isTime(snap.at) ? dayKey(snap.at) : null;
      let todays = 0;
      const counts = new Map<MemoryKind, number>();
      for (const e of events) {
        if (today === null || dayKey(e.t) !== today) continue;
        todays++;
        counts.set(e.k, (counts.get(e.k) ?? 0) + 1);
      }
      const countsText = KINDS.filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${k}`).join(' · ');
      const oldest = events.length ? events.reduce((m, e) => (e.t < m ? e.t : m), events[0].t) : null;

      return {
        built: true,
        stat: `${events.length} events kept · ${todays} today`,
        gauge: Math.min(100, Math.max(0, Math.round((events.length / MAX_EVENTS) * 100))),
        rows: [
          ['kept since', oldest === null ? 'nothing yet' : dayKey(oldest)],
          ['today', countsText || 'nothing yet'],
          ['keeps', 'changes only, at most 2000, 90 days; no prompts, no answers, no addresses'],
        ],
        lines: events.slice(-LINES_MAX).reverse().map((e) => `${hhmm(e.t)}  ${words(e)}`),
        note: events.length ? undefined : 'nothing yet.',
        what: 'keeps a change-only log: devices that come and go or change, the model that is loaded, project states and kula\'s own decisions. never prompts, answers, addresses, reasons or anything a person wrote.',
      };
    },
  };
}
