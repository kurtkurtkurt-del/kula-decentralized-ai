// god's eye, the black box's facts: what of a look is kept, what one look changes against the last
// recorded one, what text is scrubbed out of it, and how the records are read back into facts.
//
// the box must never hold what the person would not want written down: a device's address and the
// reason it failed, a ledger key or certificate, ledger lines, the peers it refused, a project's
// title, request, error and line, the plan and the decisions, the loading line. Only the fields
// below go in. scrub() keeps the same strings out of the feed, a stat and a broken branch's why.
//
// arrays are sorted by id: a look that only reorders its devices, models or projects is no change,
// and replay rebuilds the same order from the deltas alone. An id is any non-empty string of at
// most 200 chars; an entry without one is left out of the record (the eye's guard has dropped such
// entries before they reach here, so this is the second wall, not the first).
//
// the key is chunked so that no payload passes PAYLOAD_CAP (12 000 chars; the box cuts past 16 384
// without saying so): chunk 0 is host, work, models and projects, then the devices ten a chunk. A
// models or projects list too big for one chunk is packed over several, and a chunk never takes an
// entry that would push it past the cap. replay() reads the whole chain: a key's chunks rebuild the
// facts, every look after it applies its delta.
import type { Snapshot } from './types.js';

export const ID_MAX = 200;           // an id longer than this is not one of ours
const NAME_MAX = 80;                 // a name kept in the record
const WORD = 80;                     // kind, via, lastOk, gpu, alg, store, self, state, mode
const MODEL = 300;                   // a model's file and name, a device's holds
const REASON = 200;                  // a ledger head, a rejectsDay reason word
const DAY_MAX = 20;                  // reasons in one rejectsDay: a reason may be 200 chars, so 20
                                     // keep one device's trust facts well under the 12 000 key cap
const SHORT_MIN = 4;                 // a secret this long is cut whole where it appears; three
                                     // chars are too common to cut (every sentence holds one)
const SHARE_MIN = 8;                 // a piece of text this long shared with a secret is scrubbed
const PEERS_MAX = 64;                // a project's peers kept; the record must stay boundable
const KEY_CAP = 11_500;              // a key chunk aims under this; PAYLOAD_CAP is 12 000
const DEVICES_PER_CHUNK = 10;        // the design's device group
const KEY_CHUNKS_MAX = 1024;         // replay refuses a key that claims more chunks than this

/** a look's host, whitelisted: the name, free memory, and whether its own ledger holds */
export interface HostFacts {
  name: string;
  freeMb: number | null;
  ledger: { ok: boolean; count: number } | null;
}

/** a device, whitelisted: down is true when it gave a reason for not answering */
export interface DeviceFacts {
  id: string;
  name: string;
  kind: string;
  via: string;
  reachable: boolean | null;
  reachMs: number | null;
  checkedAt: number | null;
  lastOk: string | null;
  ramMb: number | null;
  bwGBs: number | null;
  gpu: string | null;
  tls: boolean;
  waitingPair: boolean;
  plugged: boolean | null;
  holds: string | null;
  down: boolean;
  trust: TrustFacts | null;   // what it said about its security, the whitelisted fields only
}

/** what a device said about its security, stripped of every string it could hide a secret in */
export interface TrustFacts {
  at: number;
  err: boolean;
  alg: string | null;
  store: string | null;
  certPinned: boolean | null;
  v1: boolean | null;
  paired: number | null;
  self: string | null;
  count: number | null;
  head: string | null;
  restartedAt: number | null;
  rejectsDay: Record<string, number>;
}

export interface LoadedFacts {
  mode: string;
  model: { id: string; file: string; size: number };
  ctx: number;
  since: number;
  devices: { id: string; busy: boolean; tps: number | null; done: number }[];
  parts: { id: string; mb: number; layers: number }[];
}

export interface LoadingFacts { mode: string; model: string; since: number }

export interface WorkFacts {
  loaded: LoadedFacts | null;
  loading: LoadingFacts | null;
  chatting: number;
  llama: boolean;
  planN: number;        // the plan's words stay out; its length is enough to see it came
  decisionsN: number;   // likewise
}

export interface ModelFacts {
  id: string; name: string; file: string; size: number; quant: string | null; params_b: number | null;
  catalog: boolean; here: boolean; needMb: number;
}

export interface ProjectFacts {
  id: string; start: number; end: number; state: string; mode: string; model: string; peers: string[];
  parts: number; done: number;
}

export interface Facts {
  host: HostFacts;
  work: WorkFacts;
  models: ModelFacts[];
  projects: ProjectFacts[];
  devices: DeviceFacts[];
}

/** one look's change against the last recorded facts; a device's fields are named one by one,
 *  a gone device is null, and the lists and the work are replaced whole when they differ */
export interface Delta {
  host?: HostFacts;
  work?: WorkFacts;
  models?: ModelFacts[];
  projects?: ProjectFacts[];
  dev?: Record<string, Partial<DeviceFacts> | null>;
}

/** a key chunk: chunk 0 carries host, work, models, projects and the views that changed, the rest
 *  devices (at most ten) */
export interface KeyChunk {
  at: number;
  i: number;
  of: number;
  host?: HostFacts;
  work?: WorkFacts;
  models?: ModelFacts[];
  projects?: ProjectFacts[];
  v?: Record<string, unknown>;
  devices?: DeviceFacts[];
}

/** one look a replay could rebuild, at the sequence number of the record that completed it */
export interface LookFacts { n: number; at: number; facts: Facts }

/** the record as read() hands it back; box.ts's BoxRecord fits this without an import */
export interface BoxRec { n: number; t: number; k: string; b?: string | null; x?: unknown }

// ---- the small checks: the eye's guard has cleaned the look already; these keep a raw look and a
// foreign record from throwing or smuggling a wrong shape into the record

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '');
const strOrNull = (x: unknown, max: number): string | null => (typeof x === 'string' ? x.slice(0, max) : null);
const b2 = (x: unknown): boolean => x === true;
const b3 = (x: unknown): boolean | null => (x === true || x === false ? x : null);
const n3 = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const n0 = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const idOf = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 && x.length <= ID_MAX ? x : null);
const j = (x: unknown): string => JSON.stringify(x);
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const shapeKey = (k: string): boolean => k === '__proto__' || k === 'constructor' || k === 'prototype';

/** the device fields a delta names; id is the key, never a field of the change */
const DEV_KEYS = [
  'name', 'kind', 'via', 'reachable', 'reachMs', 'checkedAt', 'lastOk', 'ramMb', 'bwGBs', 'gpu',
  'tls', 'waitingPair', 'plugged', 'holds', 'down', 'trust',
] as const;

// ---- a look's reduced facts

function trustOf(raw: unknown): TrustFacts | null {
  if (!isObj(raw)) return null;
  const day: Record<string, number> = {};
  let n = 0;
  if (isObj(raw.rejectsDay)) {
    for (const [k, v] of Object.entries(raw.rejectsDay)) {
      if (n >= DAY_MAX) break;
      if (k.length > REASON || shapeKey(k)) continue;
      const c = n3(v);
      if (c !== null) { day[k] = c; n++; }
    }
  }
  return {
    at: n0(raw.at),
    err: typeof raw.error === 'string',      // the words themselves stay out
    alg: strOrNull(raw.alg, WORD),
    store: strOrNull(raw.store, WORD),
    certPinned: b3(raw.certPinned),
    v1: b3(raw.v1),
    paired: n3(raw.paired),
    self: strOrNull(raw.self, WORD),
    count: n3(raw.count),
    head: strOrNull(raw.head, REASON),
    restartedAt: n3(raw.restartedAt),
    rejectsDay: day,
  };
}

function devOf(raw: unknown): DeviceFacts | null {
  if (!isObj(raw)) return null;
  const id = idOf(raw.id);
  if (id === null) return null;
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name.slice(0, NAME_MAX) : id,
    kind: str(raw.kind, WORD),
    via: str(raw.via, WORD),
    reachable: b3(raw.reachable),
    reachMs: n3(raw.reachMs),
    checkedAt: n3(raw.checkedAt),
    lastOk: strOrNull(raw.lastOk, WORD),
    ramMb: n3(raw.ramMb),
    bwGBs: n3(raw.bwGBs),
    gpu: strOrNull(raw.gpu, WORD),
    tls: b2(raw.tls),
    waitingPair: b2(raw.waitingPair),
    plugged: b3(raw.plugged),
    holds: strOrNull(raw.holds, MODEL),
    down: reason.length > 0,
    trust: isObj(raw.trust) ? trustOf(raw.trust) : null,
  };
}

function workOf(raw: unknown): WorkFacts {
  const w = isObj(raw) ? raw : {};
  let loaded: LoadedFacts | null = null;
  if (isObj(w.loaded)) {
    const l = w.loaded;
    const devices: LoadedFacts['devices'] = [];
    for (const d of arr(l.devices)) {
      if (!isObj(d)) continue;
      const id = idOf(d.id);
      if (id === null) continue;
      devices.push({ id, busy: b2(d.busy), tps: n3(d.tps), done: n0(d.done) });
    }
    const parts: LoadedFacts['parts'] = [];
    for (const p of arr(l.parts)) {
      if (!isObj(p)) continue;
      const id = idOf(p.id);
      if (id === null) continue;
      parts.push({ id, mb: n0(p.mb), layers: n0(p.layers) });
    }
    loaded = {
      mode: str(l.mode, WORD),
      model: isObj(l.model)
        ? { id: idOf(l.model.id) ?? '', file: str(l.model.file, MODEL), size: n0(l.model.size) }
        : { id: '', file: '', size: 0 },
      ctx: n0(l.ctx),
      since: n0(l.since),
      devices,
      parts,
    };
  }
  const loading = isObj(w.loading)
    ? { mode: str(w.loading.mode, WORD), model: str(w.loading.model, MODEL), since: n0(w.loading.since) }
    : null;
  return {
    loaded,
    loading,
    chatting: n0(w.chatting),
    llama: b2(w.llama),
    planN: Math.min(arr(w.plan).length, 100_000),           // only the count is kept
    decisionsN: Math.min(arr(w.decisions).length, 1_000_000),
  };
}

function modelOf(raw: unknown): ModelFacts | null {
  if (!isObj(raw)) return null;
  const id = idOf(raw.id);
  if (id === null) return null;
  return {
    id,
    name: str(raw.name, MODEL),
    file: str(raw.file, MODEL),
    size: n0(raw.size),
    quant: strOrNull(raw.quant, WORD),
    params_b: n3(raw.params_b),
    catalog: b2(raw.catalog),
    here: b2(raw.here),
    needMb: n0(raw.needMb),
  };
}

function projectOf(raw: unknown): ProjectFacts | null {
  if (!isObj(raw)) return null;
  const id = idOf(raw.id);
  if (id === null) return null;
  const peers: string[] = [];
  for (const p of arr(raw.peers)) {
    if (peers.length >= PEERS_MAX) break;
    const peer = idOf(p);
    if (peer !== null) peers.push(peer);
  }
  return {
    id,
    start: n0(raw.start),
    end: n0(raw.end),
    state: str(raw.state, WORD),
    mode: str(raw.mode, WORD),
    model: str(raw.model, MODEL),
    peers,
    parts: n0(raw.parts),
    done: n0(raw.done),
  };
}

function hostOf(raw: unknown): HostFacts {
  const h = isObj(raw) ? raw : {};
  return {
    name: typeof h.name === 'string' && h.name.length > 0 ? h.name.slice(0, 253) : 'this computer',
    freeMb: n3(h.freeMb),
    ledger: isObj(h.ledger) ? { ok: b2(h.ledger.ok), count: n0(h.ledger.count) } : null,
  };
}

/** the ids of one list, first wins, sorted by id so order alone is never a change */
function each<T extends { id: string }>(raw: unknown, make: (x: unknown) => T | null): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr(raw)) {
    const v = make(x);
    if (v === null || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
  }
  return out.sort(byId);
}

/** one look reduced to the whitelist of boxfacts: never throws, never invents a value */
export function facts(now: Snapshot): Facts {
  const s: Record<string, unknown> = isObj(now as unknown) ? (now as unknown as Record<string, unknown>) : {};
  return {
    host: hostOf(s.host),
    work: workOf(s.work),
    models: each(s.models, modelOf),
    projects: each(s.projects, projectOf),
    devices: each(s.devices, devOf),
  };
}

/** what changed from one look's facts to the next: an empty object when nothing did */
export function diff(prev: Facts, next: Facts): Delta {
  const d: Delta = {};
  if (j(prev.host) !== j(next.host)) d.host = next.host;
  if (j(prev.work) !== j(next.work)) d.work = next.work;
  if (j(prev.models) !== j(next.models)) d.models = next.models;
  if (j(prev.projects) !== j(next.projects)) d.projects = next.projects;
  const before = new Map(prev.devices.map((x) => [x.id, x]));
  const dev: Record<string, Partial<DeviceFacts> | null> = Object.create(null);
  let any = false;
  const seen = new Set<string>();
  for (const x of next.devices) {
    seen.add(x.id);
    const old = before.get(x.id);
    if (old === undefined) { dev[x.id] = { ...x }; any = true; continue; }
    let changed: Partial<DeviceFacts> | null = null;
    for (const k of DEV_KEYS) {
      if (j(old[k]) === j(x[k])) continue;
      changed ??= {};
      changed[k] = x[k] as never;
    }
    if (changed !== null) { dev[x.id] = changed; any = true; }
  }
  for (const x of prev.devices) if (!seen.has(x.id)) { dev[x.id] = null; any = true; }
  if (any) d.dev = dev;
  return d;
}

/** one look's payload for the box: the delta, the branches whose view changed, the left-out count */
export function lookPayload(at: number, d: Delta, v: Record<string, unknown> | null, left: { devices: number; models: number; projects: number } | null): Record<string, unknown> {
  const x: Record<string, unknown> = { at };
  if (Object.keys(d).length > 0) x.d = d;
  if (v !== null) x.v = v;
  if (left !== null && (left.devices > 0 || left.models > 0 || left.projects > 0)) x.left = left;
  return x;
}

// ---- the strings that never leave the eye in a feed, a stat or a why

/** secret text remembered between looks: at most this much; the least recently seen go first */
export const CACHE_TEXT_MAX = 8 * 1024 * 1024;
/** new secret text windowed in one look: a look bringing more withholds its quoted texts, and
 *  the rest is windowed on the following looks (a device cannot stall the eye's tick) */
export const NEW_TEXT_MAX = 256 * 1024;

/** one look's private strings, and how much text they held in all */
export interface SecretScan {
  secrets: string[];   // the distinct strings of four chars or more
  total: number;       // every candidate string's chars, duplicates and all
}

/** the strings of one look that a branch can quote, and so may reach a feed line, a stat or a
 *  why: a device's name, where it sits and why it failed; a project's title, request, line and
 *  error; the plan, the decisions and the loading line. ledger lines, certificates, public keys
 *  and refused peers are never quoted by a branch (they stay out of the box facts as well), so
 *  they need no scrubbing and are not collected here. a string under four chars is too common to
 *  cut (every sentence holds one); four to seven are cut whole, eight or more by their windows. */
export function secretScan(now: Snapshot): SecretScan {
  const out: string[] = [];
  let total = 0;
  const add = (x: unknown): void => {
    if (typeof x !== 'string' || x.length < SHORT_MIN) return;
    total += x.length;
    out.push(x);
  };
  const s: Record<string, unknown> = isObj(now as unknown) ? (now as unknown as Record<string, unknown>) : {};
  for (const raw of arr(s.devices)) {
    if (!isObj(raw)) continue;
    add(raw.name);
    add(raw.where);
    add(raw.reason);
  }
  if (isObj(s.work)) {
    if (isObj(s.work.loading)) add(s.work.loading.line);
    for (const p of arr(s.work.plan)) add(p);
    for (const d of arr(s.work.decisions)) if (isObj(d)) add(d.text);
  }
  for (const raw of arr(s.projects)) {
    if (!isObj(raw)) continue;
    add(raw.title);
    add(raw.request);
    add(raw.line);
    add(raw.error);
  }
  return { secrets: out, total };
}

/** the strings of one look that the box must not hold (the scan, without its total) */
export function secretsOf(now: Snapshot): string[] {
  return secretScan(now).secrets;
}

/** a quoted text the eye withheld: the look brought more new secret text than one look windows */
export interface Scrubbed { scrubbed: true; len: number }

/** one look's scrubber: its secrets' windows are known from the last looks, and every quoted
 *  text is then one walk of that text */
export interface Scrubber {
  over: boolean;                             // this look's texts are withheld
  scrub(text: string): string | Scrubbed;
}

/** what always goes, whatever its source: an e-mail, an ipv4 or an ipv6 address, with or
 *  without its port. the local part and the labels are bounded: an unbounded run before a '@'
 *  that is no address makes the regex backtrack over the whole run, and a ledger line is one. */
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;
const IPV6 = /\[[0-9A-Fa-f:.]{2,}\](?::\d{1,5})?|\b[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?::\d{1,5})?\b/g;

/** an ipv6 address has "::" or a group of three or four hex digits; either way it has three
 *  colons. without both, a clock (12:30:45) or a ratio (1:2:3) is not an address. */
const ipv6 = (m: string): boolean => m.includes('::') || (/(?:^|[^0-9A-Fa-f])[0-9A-Fa-f]{3,4}(?:[^0-9A-Fa-f]|$)/.test(m) && (m.match(/:/g)?.length ?? 0) >= 3);

/** the rolling hash of an eight-char window: h = c0*31^7 + c1*31^6 + … + c7, mod 2^32 */
const POW31_7 = (() => { let p = 1; for (let i = 0; i < SHARE_MIN - 1; i++) p = Math.imul(p, 31); return p; })();

/** the eight-char window hashes of one secret, in order; 32 bits, so a collision can only cut
 *  more than needed, never less */
function windowHashes(s: string): Int32Array {
  const out = new Int32Array(s.length - SHARE_MIN + 1);
  let h = 0;
  for (let i = 0; i < SHARE_MIN; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  out[0] = h;
  for (let i = SHARE_MIN; i < s.length; i++) {
    h = (Math.imul((h - Math.imul(s.charCodeAt(i - SHARE_MIN), POW31_7)) | 0, 31) + s.charCodeAt(i)) | 0;
    out[i - SHARE_MIN + 1] = h;
  }
  return out;
}

/** one secret's windows, or null for a four-to-seven char secret (it is cut whole, no windows).
 *  a secret seen in the last looks is here already and costs nothing to window again. */
interface CachedSecret { windows: Int32Array | null; chars: number; seen: number }
const cache = new Map<string, CachedSecret>();
let cacheChars = 0;
let generation = 0;                                // the look each cache entry was last seen in

/** the open-addressing table of the window hashes the look's secrets hold (0: empty). it is
 *  never rebuilt for a changed secret: new windows are inserted, it doubles when the load passes
 *  a half, and a secret that leaves stays in it (over-redaction only) until the stale share
 *  passes a half, then one rebuild. */
let table: Int32Array | null = null;
let tableSize = 0;
let tableMask = 0;
let tableShift = 22;                              // the slot comes from the top bits
let tableWindows = 0;                             // occupied slots since the last rebuild
let staleWindows = 0;                             // windows in it whose secret left the look
let inTable = new Set<string>();                  // the secrets whose windows are in it
let staleSecrets = new Set<string>();
let lastCurrent = new Set<string>();              // the last complete look's secrets
let shortByFirst = new Map<string, Set<string>>(); // four-to-seven char secrets, by first char

/** a random odd multiplier, fixed for the process: a device cannot choose secrets whose windows
 *  land in known slots (the table stores Math.imul(hash, ODD)) */
const ODD = (() => {
  let x = 0;
  while (x === 0) x = (Math.random() * 0x100000000) >>> 0;
  return (x | 1) >>> 0;
})();

/** the table's stored value for a window hash; 0 is the empty slot, a real 0 is stored as 1
 *  (a collision with a real 1 only cuts more than needed) */
const slotValue = (h: number): number => {
  const v = Math.imul(h, ODD) | 0;
  return v === 0 ? 1 : v;
};

/** the slot is taken from the TOP bits of the multiplied hash: hashes crafted to share their low
 *  bits then spread over the whole table instead of piling into a few slots. returns true when
 *  the window was not in the table yet. */
function tableInsert(t: Int32Array, mask: number, shift: number, h: number): boolean {
  const v = slotValue(h);
  let slot = v >>> shift;
  for (;;) {
    const at = t[slot];
    if (at === 0) { t[slot] = v; return true; }
    if (at === v) return false;
    slot = (slot + 1) & mask;
  }
}

function tableHas(t: Int32Array, mask: number, shift: number, h: number): boolean {
  const v = slotValue(h);
  let slot = v >>> shift;
  for (;;) {
    const at = t[slot];
    if (at === 0) return false;
    if (at === v) return true;
    slot = (slot + 1) & mask;
  }
}

/** a new table for at least count windows, at least minSize slots and load at most a half */
function newTable(count: number, minSize: number): void {
  let size = Math.max(1024, minSize);
  while (size < count * 2 && size < (1 << 27)) size <<= 1;
  table = new Int32Array(size);
  tableSize = size;
  tableMask = size - 1;
  tableShift = 32 - Math.log2(size);
}

/** one rebuild, from the cached windows of the current look only: used on the first look, when
 *  the load passes a half (the table doubles) and when the stale share passes a half */
function rebuildTable(current: Set<string>, minSize: number): void {
  const windows: Int32Array[] = [];
  const shorts = new Map<string, Set<string>>();
  let count = 0;
  for (const s of current) {
    const e = cache.get(s);
    if (e === undefined) continue;
    if (e.windows === null) {
      const first = s[0];
      const bucket = shorts.get(first);
      if (bucket === undefined) shorts.set(first, new Set([s])); else bucket.add(s);
    } else {
      windows.push(e.windows);
      count += e.windows.length;
    }
  }
  newTable(count, minSize);
  const t = table as Int32Array;
  let occupied = 0;
  for (const w of windows) for (let i = 0; i < w.length; i++) if (tableInsert(t, tableMask, tableShift, w[i])) occupied++;
  tableWindows = occupied;
  staleWindows = 0;
  staleSecrets.clear();
  inTable = current;
  shortByFirst = shorts;
}

/** a four-to-seven char secret's bucket; the stale ones stay (over-redaction) until a rebuild */
function addShort(s: string): void {
  const first = s[0];
  const bucket = shortByFirst.get(first);
  if (bucket === undefined) shortByFirst.set(first, new Set([s])); else bucket.add(s);
}

/** one text, its e-mail and addresses cut whole, every run of eight chars or more that the
 *  look's secrets hold cut as […], and a four-to-seven char secret cut where it appears whole.
 *  the text is walked once; a run is every consecutive window the secrets have, so two windows
 *  meeting make one cut and no shared eight-char piece is left. short secrets are checked at
 *  every position whose first char starts one, so a secret that spans a space is found too (a
 *  match inside a longer word only cuts more than needed). */
function scrubWith(text: string, t: Int32Array | null, mask: number, shift: number, shorts: ReadonlyMap<string, ReadonlySet<string>>): string {
  if (typeof text !== 'string' || text.length === 0) return typeof text === 'string' ? text : '';
  const n = text.length;
  const hidden = new Array<boolean>(n).fill(false);
  const masks: Array<[RegExp, ((m: string) => boolean) | null]> = [];
  if (text.includes('@')) masks.push([EMAIL, null]);       // no '@', no address to look for
  if (text.includes('.')) masks.push([IPV4, null]);
  if (text.includes(':')) masks.push([IPV6, ipv6]);
  for (const [re, ok] of masks) {
    for (const m of text.matchAll(re)) {
      if (ok !== null && !ok(m[0])) continue;
      const a = m.index as number;
      for (let i = a; i < a + m[0].length; i++) hidden[i] = true;
    }
  }
  if (n >= SHARE_MIN && t !== null) {
    let h = 0;
    for (let i = 0; i < n; i++) {
      h = i < SHARE_MIN
        ? (Math.imul(h, 31) + text.charCodeAt(i)) | 0
        : (Math.imul((h - Math.imul(text.charCodeAt(i - SHARE_MIN), POW31_7)) | 0, 31) + text.charCodeAt(i)) | 0;
      if (i < SHARE_MIN - 1 || !tableHas(t, mask, shift, h)) continue;
      const a = i - SHARE_MIN + 1;
      for (let k = a; k <= i; k++) hidden[k] = true;
    }
  }
  if (shorts.size > 0) {
    for (let i = 0; i < n; i++) {
      const bucket = shorts.get(text[i]);
      if (bucket === undefined) continue;
      for (let len = SHORT_MIN; len < SHARE_MIN && i + len <= n; len++) {
        if (!bucket.has(text.slice(i, i + len))) continue;
        for (let k = i; k < i + len; k++) hidden[k] = true;
      }
    }
  }
  let out = '';
  let i = 0;
  while (i < n) {
    if (!hidden[i]) { out += text[i]; i++; continue; }
    while (i < n && hidden[i]) i++;
    out += '[…]';
  }
  return out;
}

const markerScrubber = (): Scrubber => ({
  over: true,
  scrub: (text: string): Scrubbed => ({ scrubbed: true, len: typeof text === 'string' ? text.length : 0 }),
});

/** the scrubber for one look. a secret's windows are windowed once and cached, so the ledger
 *  lines of the last looks cost nothing but a map lookup; at most NEW_TEXT_MAX of new secret text
 *  is windowed in one look, and a look bringing more withholds its quoted texts (privacy-safe)
 *  while the rest is windowed on the following looks. the cache holds CACHE_TEXT_MAX of text;
 *  anything not seen in this look goes before anything that was (a dropped secret that returns
 *  is new again). a look that alone holds more than the cache can never be whole, so it is
 *  withheld at once and nothing of it is hashed or kept. */
export function makeScrubber(secrets: readonly string[], _total?: number): Scrubber {
  // the eye still passes its scan total; the bound is on this look's text, summed here (a
  // duplicate counts: a look carrying the same line a thousand times is withheld too)
  let lookChars = 0;
  for (const s of secrets) if (typeof s === 'string' && s.length >= SHORT_MIN) lookChars += s.length;
  if (lookChars > CACHE_TEXT_MAX) return markerScrubber();   // never whole: no work at all
  const gen = ++generation;
  const current = new Set<string>();
  const fresh: string[] = [];
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < SHORT_MIN || current.has(s)) continue;
    current.add(s);
    const known = cache.get(s);
    if (known === undefined) fresh.push(s);
    else known.seen = gen;                             // seen this look
  }
  let budget = NEW_TEXT_MAX;
  let deferred = false;
  for (const s of fresh) {
    if (s.length < SHARE_MIN) {                        // a short secret: cut whole, no windows
      cache.set(s, { windows: null, chars: s.length, seen: gen });
      cacheChars += s.length;
      continue;
    }
    if (s.length > budget) { deferred = true; continue; }   // the following looks window the rest
    cache.set(s, { windows: windowHashes(s), chars: s.length, seen: gen });
    cacheChars += s.length;
    budget -= s.length;
  }
  // the cache is bounded by secret text: the least recently seen go first. a secret of this look
  // that has to go leaves the table incomplete, so this look's texts are withheld
  let complete = !deferred;
  if (cacheChars > CACHE_TEXT_MAX) {
    const byAge = [...cache].sort((a, b) => a[1].seen - b[1].seen);
    for (const [s, e] of byAge) {
      if (cacheChars <= CACHE_TEXT_MAX) break;
      if (e.seen === gen) complete = false;
      cache.delete(s);
      cacheChars -= e.chars;
    }
  }
  if (!complete) return markerScrubber();              // the cache changed; the table is left as is
  if (table === null) {
    rebuildTable(current, 1024);                       // the first whole look
  } else {
    // a changed secret is inserted, never re-windowed: only the windows the table lacks go in.
    // a batch that would take the load past a half is inserted by one doubling rebuild instead
    // (inserting it first would probe a far too full table)
    const missing: string[] = [];
    let newWindows = 0;
    for (const s of current) {
      if (inTable.has(s)) continue;
      missing.push(s);
      newWindows += cache.get(s)?.windows?.length ?? 0;
    }
    if (tableWindows + newWindows > tableSize / 2) {
      rebuildTable(current, tableSize * 2);
    } else {
      for (const s of missing) {
        const e = cache.get(s);
        if (e !== undefined) {
          if (e.windows === null) addShort(s);
          else for (let i = 0; i < e.windows.length; i++) if (tableInsert(table, tableMask, tableShift, e.windows[i])) tableWindows++;
        }
        inTable.add(s);
      }
      // a secret that left stays in the table: its windows only over-redact. count them, and take
      // them out only when they pass half the table; a secret that comes back stops being stale
      if (lastCurrent.size > 0) {
        for (const s of lastCurrent) {
          if (current.has(s)) continue;
          const e = cache.get(s);
          if (e === undefined || e.windows === null || !inTable.has(s)) continue;
          staleWindows += e.windows.length;
          staleSecrets.add(s);
        }
        for (const s of staleSecrets) {
          if (!current.has(s)) continue;
          staleSecrets.delete(s);
          staleWindows -= cache.get(s)?.windows?.length ?? 0;
        }
      }
      if (staleWindows > tableWindows / 2) rebuildTable(current, tableSize);   // the stale share passed a half
    }
  }
  lastCurrent = current;
  const t = table;
  const mask = tableMask;
  const shift = tableShift;
  const shorts = shortByFirst;
  return { over: false, scrub: (text: string) => scrubWith(text, t, mask, shift, shorts) };
}

/** one quoted text scrubbed with the look's secrets (the eye builds a makeScrubber once a look) */
export function scrub(text: string, secrets: readonly string[]): string | Scrubbed {
  return makeScrubber(secrets).scrub(text);
}

/** the verdicts remembered for the next look's delta, bounded; the ids of the current report go
 *  first, so a device in front of the eye is never dropped for one that is gone */
export function trimVerdicts(memory: ReadonlyMap<string, string>, current: Iterable<string>, max: number): Map<string, string> {
  const kept = new Map<string, string>();
  if (memory.size <= max) {
    for (const [k, v] of memory) kept.set(k, v);
    return kept;
  }
  for (const k of current) {
    if (kept.size >= max) break;
    const v = memory.get(k);
    if (v !== undefined) kept.set(k, v);
  }
  for (const [k, v] of memory) {
    if (kept.size >= max) break;
    if (!kept.has(k)) kept.set(k, v);
  }
  return kept;
}

// ---- the key: the whole reduced facts in chunks that no box will cut

const keySize = (x: KeyChunk): number => j(x).length;

/** pack entries of one list over as few chunks as fit under KEY_CAP, one entry alone when needed */
function packEntries<T>(at: number, field: 'models' | 'projects', entries: T[], out: KeyChunk[]): void {
  let group: T[] = [];
  let chunk: KeyChunk = { at, i: 0, of: 0, [field]: group } as KeyChunk;
  const sizeOf = (g: T[]): number => j({ at, i: 0, of: 0, [field]: g }).length;
  for (const entry of entries) {
    group.push(entry);
    if (sizeOf(group) > KEY_CAP && group.length > 1) {
      group.pop();
      out.push(chunk);
      group = [entry];
      chunk = { at, i: 0, of: 0, [field]: group } as KeyChunk;
    }
  }
  if (group.length > 0) out.push(chunk);
}

/** the full facts as key chunks: chunk 0 host/work/models/projects (and the views that changed,
 *  since a key is also a look), then up to ten devices each */
export function keyChunks(at: number, f: Facts, v?: Record<string, unknown> | null): KeyChunk[] {
  const out: KeyChunk[] = [];
  const views = v === undefined || v === null ? {} : { v };
  const base: KeyChunk = { at, i: 0, of: 0, host: f.host, work: f.work, models: f.models, projects: f.projects, ...views };
  if (keySize(base) <= KEY_CAP) out.push(base);
  else {
    // models and projects are what made it too big: they go to chunks of their own
    out.push({ at, i: 0, of: 0, host: f.host, work: f.work, ...views });
    packEntries(at, 'models', f.models, out);
    packEntries(at, 'projects', f.projects, out);
  }
  let group: DeviceFacts[] = [];
  const flush = (): void => {
    if (group.length > 0) { out.push({ at, i: 0, of: 0, devices: group }); group = []; }
  };
  for (const d of f.devices) {
    if (group.length >= DEVICES_PER_CHUNK) flush();
    group.push(d);
    if (j({ at, i: 0, of: 0, devices: group }).length > KEY_CAP && group.length > 1) {
      const last = group.pop() as DeviceFacts;
      flush();
      group = [last];
    }
  }
  flush();
  const of = out.length;
  for (let i = 0; i < out.length; i++) { out[i].i = i; out[i].of = of; }
  return out;
}

// ---- reading the record back

/** a key's chunks rebuilt into the facts: host and work from chunk 0, the lists joined in order */
function assemble(chunks: Map<number, Record<string, unknown>>, of: number): Facts {
  const first = chunks.get(0) ?? {};
  const models: unknown[] = [];
  const projects: unknown[] = [];
  const devices: unknown[] = [];
  for (let i = 0; i < of; i++) {
    const c = chunks.get(i);
    if (c === undefined) continue;
    for (const m of arr(c.models)) models.push(m);
    for (const p of arr(c.projects)) projects.push(p);
    for (const d of arr(c.devices)) devices.push(d);
  }
  const host = isObj(first.host) ? (first.host as unknown as HostFacts) : hostOf(null);
  const work = isObj(first.work) ? (first.work as unknown as WorkFacts) : workOf(null);
  return {
    host,
    work,
    models: models as ModelFacts[],
    projects: projects as ProjectFacts[],
    devices: (devices as DeviceFacts[]).sort(byId),
  };
}

/** one look's delta applied to the facts before it; the old state is left untouched */
function apply(state: Facts, d: unknown): Facts {
  if (!isObj(d)) return state;
  const out: Facts = { host: state.host, work: state.work, models: state.models, projects: state.projects, devices: state.devices };
  if (isObj(d.host)) out.host = d.host as unknown as HostFacts;
  if (isObj(d.work)) out.work = d.work as unknown as WorkFacts;
  if (Array.isArray(d.models)) out.models = d.models as ModelFacts[];
  if (Array.isArray(d.projects)) out.projects = d.projects as ProjectFacts[];
  if (isObj(d.dev)) {
    const map = new Map<string, DeviceFacts>();
    for (const x of state.devices) map.set(x.id, x);
    for (const [id, change] of Object.entries(d.dev)) {
      if (change === null) { map.delete(id); continue; }
      if (!isObj(change)) continue;
      const old = map.get(id);
      const merged = (old ? { ...old, ...change } : { ...change }) as DeviceFacts;
      merged.id = id;
      map.set(id, merged);
    }
    out.devices = [...map.values()].sort(byId);
  }
  return out;
}

/** the facts of every look a record holds, oldest first. a key is applied when its last chunk is
 *  read; looks before the first whole key cannot be rebuilt and are left out; a broken record is
 *  skipped, never thrown on. */
export function replay(records: readonly BoxRec[]): LookFacts[] {
  const out: LookFacts[] = [];
  const next = replayer();
  for (const r of records) {
    const look = next(r);
    if (look !== null) out.push(look);
  }
  return out;
}

/** replay() one record at a time, for a record too long to hold whole (the night replay walks the
 *  box with it): each call gives the look that record completed, or null */
export function replayer(): (r: BoxRec) => LookFacts | null {
  let state: Facts | null = null;
  let key: { at: number; of: number; chunks: Map<number, Record<string, unknown>> } | null = null;
  return (r: BoxRec): LookFacts | null => {
    if (!isObj(r)) return null;
    const x = isObj(r.x) ? r.x : null;
    if (r.k === 'key' && x !== null) {
      const at = n3(x.at);
      const i = n3(x.i);
      const of = n3(x.of);
      if (at === null || i === null || of === null) return null;
      if (!Number.isSafeInteger(i) || !Number.isSafeInteger(of) || of < 1 || of > KEY_CHUNKS_MAX || i < 0 || i >= of) return null;
      if (key === null || key.at !== at || key.of !== of) key = { at, of, chunks: new Map() };
      key.chunks.set(i, x);
      if (key.chunks.size === of) {
        state = assemble(key.chunks, of);
        key = null;
        return { n: r.n, at, facts: state };
      }
    } else if (r.k === 'look' && x !== null) {
      if (state === null) return null;   // no whole key in the kept record: this look cannot be rebuilt
      const at = n3(x.at) ?? n0(r.t);
      state = apply(state, x.d);
      return { n: r.n, at, facts: state };
    }
    return null;
  };
}
