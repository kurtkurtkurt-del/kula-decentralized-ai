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
// A decision's own at is kept as the notes' watermark (lastDecisionAt); its event is stamped with
// the look's at, like every other event. The notes also keep the last LOGGED_MAX logged decisions
// (at + text), so a watermark that has to move backwards never re-logs one of them.
// Data time is the snapshot's at (finite, 0..8.64e15); ctx.now() only paces saves and the hourly
// prune. A clock that jumps backwards by minutes still records. Every high-water mark re-anchors:
// a look more than KEEP_MS behind the newest t seen (or the decision watermark) means the earlier
// value was a bad clock, so the log re-anchors to this look and drops the events stamped in the
// future; a decision stamped later than its look never pushes the watermark past that look's at.
// A look more than KEEP_MS ahead moves the newest t seen but not the prune anchor: the prune waits
// until the next look agrees with it, so one bad look cannot wipe the real history. A look with no
// usable at is skipped, and the next good look compares with the remembered state instead of the
// skipped snapshot. Snapshot containers and entries are checked: a non-array is empty, a null
// entry is skipped, and a non-string, non-number field counts as missing.
import type { Branch, BranchCtx, BranchView, Snapshot } from '../types.js';
import { hhmm } from './util.js';

export const MAX_EVENTS = 2000;
export const KEEP_MS = 90 * 24 * 3600_000;
export const STR_MAX = 200;
const MAX_DEVICES = 100;
const MAX_PROJECTS = 100;
const LOGGED_MAX = 30;
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
const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const freshState = (): Remembered => ({ looked: false, devices: [], work: { loaded: null }, projects: [] });
const freshNotes = (): MemoryNotes => ({ v: 1, ev: [], lastDecisionAt: null, logged: [], state: freshState() });

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

/** The changes between the last look and this one. `before` is the last snapshot when the eye has a
 *  usable one; after a restart (or a skipped look) it is null and the remembered state stands in
 *  for it. On the very first look (no before and nothing remembered) there is nothing to compare
 *  with: no events. Null containers and entries, duplicates and ids past the caps are ignored here
 *  too, exactly as the notes will not remember them. */
export function diff(now: Snapshot, before: Snapshot | null, state: Remembered | null): MemoryEvent[] {
  const was = state ?? freshState();
  if (before == null && !was.looked) return [];
  const t = now.at;
  const out: MemoryEvent[] = [];
  const push = (k: MemoryKind, d: string | null, n: string | null, x: string | null) =>
    out.push({ t, k, d: cutOrNull(d), n: cutOrNull(n), x: cutOrNull(x) });

  const prev = new Map<string, SeenDevice>();
  if (before) {
    for (const raw of listOf(before.devices).slice(0, MAX_DEVICES)) {
      const d = objOf(raw);
      if (!d) continue;
      const id = idOf(d.id);
      if (!id || prev.has(id)) continue;           // first one wins
      prev.set(id, seenDevice(d, id));
    }
  } else {
    for (const raw of listOf(was.devices)) {
      const d = objOf(raw);
      if (!d) continue;
      const id = idOf(d.id);
      if (!id || prev.has(id)) continue;           // first one wins
      prev.set(id, seenDevice(d, id));
    }
  }

  const here = new Set<string>();
  for (const raw of listOf(now.devices).slice(0, MAX_DEVICES)) {
    const d = objOf(raw);
    if (!d) continue;
    const id = idOf(d.id);
    if (!id || here.has(id)) continue;             // first one wins
    here.add(id);
    const name = cut(textOf(d.name) ?? '');
    const reach = boolOrNull(d.reachable);
    const plug = boolOrNull(d.plugged);
    const via = cut(textOf(d.via) ?? '');
    const rawHolds = textOf(d.holds);
    const holds = rawHolds === null ? null : cut(rawHolds);
    const p = prev.get(id);
    if (!p) { push('appeared', id, name || null, null); continue; }
    // null means "not looked at / unknown": it never counts as up/down or plugged/unplugged
    if (p.reachable !== null && reach !== null && p.reachable !== reach) push(reach ? 'up' : 'down', id, name || null, null);
    if (p.plugged !== null && plug !== null && p.plugged !== plug) push(plug ? 'plugged' : 'unplugged', id, name || null, null);
    if (p.via !== via) push('via', id, name || null, `${p.via} → ${via}`);
    if (p.holds !== holds) push('holds', id, name || null, holds);
  }
  for (const [id, p] of prev) if (!here.has(id)) push('gone', id, p.name || null, null);

  const wasWork = smallWork(before ? before.work : was.work);
  const isWork = smallWork(now.work);
  if (!wasWork && isWork) push('loaded', null, null, `${isWork.name} · ${isWork.mode}`);
  else if (wasWork && !isWork) push('unloaded', null, null, null);
  else if (wasWork && isWork) {
    if (wasWork.file !== isWork.file) push('loaded', null, null, `${isWork.name} · ${isWork.mode}`);
    else if (wasWork.mode !== isWork.mode) push('mode', null, null, `${wasWork.mode} → ${isWork.mode}`);
  }

  // only the id and the new state: a project's title, request, line and error may hold what a person wrote
  const projects = new Map<string, string>();
  if (before) {
    for (const raw of listOf(before.projects).slice(0, MAX_PROJECTS)) {
      const p = objOf(raw);
      if (!p) continue;
      const id = idOf(p.id);
      const s = textOf(p.state);
      if (!id || s === null || projects.has(id)) continue;   // first one wins
      projects.set(id, s);
    }
  } else {
    for (const raw of listOf(was.projects)) {
      const p = objOf(raw);
      if (!p) continue;
      const id = idOf(p.id);
      const s = textOf(p.state);
      if (!id || s === null || projects.has(id)) continue;   // first one wins
      projects.set(id, s);
    }
  }
  const projSeen = new Set<string>();
  for (const raw of listOf(now.projects).slice(0, MAX_PROJECTS)) {
    const p = objOf(raw);
    if (!p) continue;
    const id = idOf(p.id);
    const rawState = textOf(p.state);
    const s = rawState === null ? null : cut(rawState);
    if (!id || s === null || projSeen.has(id)) continue;     // first one wins
    projSeen.add(id);
    const wasState = projects.get(id);
    if (wasState !== undefined && wasState !== s) push('project', id, null, s);
  }

  return out;
}

/** Decisions newer than the watermark (or every one the first time), as events, the new watermark
 *  and the ring of the last LOGGED_MAX logged ones. A future-stamped decision is logged once but
 *  never pushes the watermark past the look's own at; when the watermark is later than this look,
 *  it moves to this look's at so real decisions after it are logged, and the ring keeps the ones
 *  already logged from coming back. */
export function newDecisions(
  now: Snapshot,
  lastDecisionAt: number | null,
  logged: LoggedDecision[] = [],
): { events: MemoryEvent[]; last: number | null; logged: LoggedDecision[] } {
  const events: MemoryEvent[] = [];
  const ring = logged.slice(-LOGGED_MAX);
  const seen = new Set(ring.map((l) => sig(l.at, l.text)));
  const reanchored = lastDecisionAt !== null && lastDecisionAt > now.at;
  const anchor = reanchored ? now.at : lastDecisionAt;
  let last = anchor;
  for (const raw of listOf(objOf(now.work)?.decisions)) {
    const d = objOf(raw);
    if (!d) continue;
    const at = d.at;
    const text = textOf(d.text);
    if (!isTime(at) || text === null) continue;
    const x = cut(text);
    if (seen.has(sig(at, x))) continue;                        // already logged: never again
    if (anchor !== null && (reanchored ? at < anchor : at <= anchor)) continue;
    events.push({ t: now.at, k: 'decision', d: null, n: null, x });
    seen.add(sig(at, x));
    ring.push({ at, text: x });
    if (ring.length > LOGGED_MAX) ring.shift();
    const mark = Math.min(at, now.at);                         // never push the watermark past this look
    if (last === null || mark > last) last = mark;
  }
  return { events, last, logged: ring };
}

/** The log after its bounds: nothing older than KEEP_MS below the prune anchor, at most MAX_EVENTS
 *  events. The oldest recorded lines go first. Pure: the input array is not changed. */
export function prune(events: MemoryEvent[], newestT: number): MemoryEvent[] {
  const cutoff = newestT - KEEP_MS;
  const kept = events.filter((e) => e.t >= cutoff);
  return kept.length > MAX_EVENTS ? kept.slice(kept.length - MAX_EVENTS) : kept;
}

const ev = (x: unknown): MemoryEvent | null => {
  const e = x as MemoryEvent;
  if (!e || typeof e !== 'object') return null;
  if (!isTime(e.t) || typeof e.k !== 'string' || !KIND_SET.has(e.k)) return null;
  if (!(e.d === null || typeof e.d === 'string') || !(e.n === null || typeof e.n === 'string') || !(e.x === null || typeof e.x === 'string')) return null;
  return { t: e.t, k: e.k as MemoryKind, d: cutOrNull(e.d), n: cutOrNull(e.n), x: cutOrNull(e.x) };
};

function saneLogged(x: unknown): LoggedDecision[] | null {
  if (x === undefined) return [];                    // notes from before this field: nothing remembered
  if (!Array.isArray(x)) return null;
  const out: LoggedDecision[] = [];
  for (const raw of x.slice(-LOGGED_MAX)) {
    const e = objOf(raw);
    if (!e || !isTime(e.at) || typeof e.text !== 'string') return null;
    out.push({ at: e.at, text: cut(e.text) });
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
function sane(x: unknown): MemoryNotes {
  const n = objOf(x) as unknown as MemoryNotes;
  if (!n || n.v !== 1 || !Array.isArray(n.ev)) return freshNotes();
  const events: MemoryEvent[] = [];
  for (const e of n.ev) {
    const one = ev(e);
    if (!one) return freshNotes();
    events.push(one);
  }
  if (!(n.lastDecisionAt === null || isTime(n.lastDecisionAt))) return freshNotes();
  const logged = saneLogged(n.logged);
  if (!logged) return freshNotes();
  const state = saneState(n.state);
  if (!state) return freshNotes();
  return { v: 1, ev: events.slice(-MAX_EVENTS), lastDecisionAt: n.lastDecisionAt, logged, state };
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
    case 'loaded': return `the model loaded: ${x}`;
    case 'unloaded': return 'the model was unloaded';
    case 'mode': return `the mode changed: ${x}`;
    case 'project': return `project ${e.d ?? '?'} is now ${x}`;
    case 'decision': return x;
  }
}

export function create(ctx: BranchCtx): Branch {
  const notes = sane(ctx.load<unknown>(null));
  let state: MemoryState = { ...notes.state, lastDecisionAt: notes.lastDecisionAt };
  let logged = notes.logged;
  let events = notes.ev;
  let newestT: number | null = events.reduce<number | null>((m, e) => (m === null || e.t > m ? e.t : m), null);
  let pruneT: number | null = newestT;      // the newest time two agreeing looks have shown
  let snap: Snapshot | null = null;
  let skipped = false;                      // the last look had no usable at, so `before` was never seen
  let savedAt = Number.NEGATIVE_INFINITY;   // the first change after start is saved at once
  let lastPrune = Number.NEGATIVE_INFINITY;
  let dirty = false;                        // something changed since the last save

  function save() {
    notes.ev = events;
    notes.lastDecisionAt = state.lastDecisionAt;
    notes.logged = logged;
    notes.state = remembered(state);
    ctx.save(notes);
    dirty = false;
  }

  return {
    id: 'memory',
    observe(now, before) {
      if (!isTime(now.at)) { skipped = true; return; }    // no usable time: this look says nothing
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

      const useBefore = skipped ? null : before;          // a skipped look never became the remembered state
      skipped = false;
      const changed = diff(now, useBefore, state);
      const d = newDecisions(now, state.lastDecisionAt, logged);
      changed.push(...d.events);
      logged = d.logged;
      const next: MemoryState = { ...stateOf(now), lastDecisionAt: d.last };
      if (!sameState(state, next)) dirty = true;
      state = next;

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
