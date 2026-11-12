// guard: the one gate every snapshot passes on its way into god's eye. The engine hands the eye
// plain data it did not make, and a branch must be able to read any field of it without asking
// first. That checking used to live, slightly differently, in every branch, and one missing check
// stopped a branch for good. It happens once, here: clean() turns any raw value into a Snapshot of
// exactly the agreed shape — containers are arrays or empty, entries are objects or dropped,
// strings are strings cut to a documented bound, numbers are finite and within a documented range
// (a count or size is clamped into it; a time or measurement outside it is unknown), booleans are
// real booleans — and it never throws, whatever it is given (a getter that throws is a look that
// cannot be trusted: null, and the eye skips it). Nothing is invented beyond a clamp: a value that
// cannot be trusted becomes its empty stand-in ('' or null or false or 0), never a guess. A
// healthy snapshot comes out exactly as it went in: one whose every field is already valid is
// deep-equal to the result.
//
// documented bounds and ranges. They are checked against node/src/ui/engine.ts, which makes the
// snapshots kula-node feeds, so no bound cuts what the engine really admits:
//   a look's at: finite, 0 .. TIME_MAX; anything else is no look at all (clean returns null).
//   strings (cut to at most): ids 200, names 80, the host's own name 253 (os.hostname, which the
//   engine's hostLabel returns, may be that long); a short word (kind, via, lastOk, gpu, alg,
//   store, self, state, mode) 80; where 400 (a host and port, or a relay's address); reason,
//   why, peer and head 200; a host ledger's problem 500; a model's file and name and a device's
//   holds 300; a project's title 300; its request 4000 (the engine cuts it there); a line, an
//   error, a plan entry and a trust error 1000; a decision's text 300; a public key 4096 and a
//   certificate 8192 (the engine admits exactly those); ledger lines kept as they are, the newest
//   1000 (the engine keeps the last 500), each at most 65536 chars (the engine admits a line up to
//   64 KiB). a cut ledger line or certificate would fail its own verification — a false "bad" —
//   so these two bounds are the engine's, not smaller.
//   counts and sizes (a finite number is clamped into its range: a count past its cap is kept at
//   the cap, never dropped, so a red alarm never turns quiet; a value that is not a finite number
//   is unknown: null where the type allows null, else 0):
//     freeMb, ramMb, needMb, mb  0 .. 4 194 304 (4 TB)   null where allowed, else 0
//     size (bytes)               0 .. 1e13 (10 TB)       0
//     chatting                   0 .. 1 000 000          0
//     ctx                        0 .. 1 000 000 000      0
//     done                       0 .. 1 000 000 000      0
//     layers                     0 .. 10 000             0
//     params_b                   0 .. 10 000 (billion)   null
//     paired                     0 .. 1 000 000          null
//     count                      0 .. 1 000 000 000      null where allowed, else 0
//     parts                      0 .. 100 000           0
//     a rejectsDay value         0 .. 1 000 000 000      the entry is unknown, dropped
//   measurements (finite and within the range, else unknown: a saturated measurement would be a
//   guess, and no alarm rests on one):
//     reachMs                    0 .. 600 000 (10 min)   null
//     bwGBs                      0 .. 10 000             null
//     tps                        0 .. 100 000 (tok/s)    null
//   times (finite, 0 .. TIME_MAX; else null where the type allows it, else 0): a device's
//   checkedAt, a trust answer's at and restartedAt, loaded/loading since, a decision's at, a
//   rejectsLast entry's t, a project's start and end. A decision or a rejectsLast entry without a
//   usable time is dropped.
//   booleans: reachable, plugged, certPinned and v1 keep true and false, anything else is null;
//   tls, waitingPair, llama, busy, local, catalog, here and ledger.ok keep true and false,
//   anything else is false.
//   containers: devices, models, projects, work, work.loaded, work.loading, host, a device's trust
//   and the nested lists. An array that is not an array counts as empty; an entry that is not an
//   object is dropped; a device, model or project needs an id — any non-empty string. An id is kept
//   as it is when it is at most 200 chars, is not a key of Object.prototype ('__proto__', 'valueOf'
//   … cannot be keyed safely everywhere the eye stores them) and does not start with '~'. Any other
//   string id is not dropped: it is kept under a stand-in that depends on the id alone — '~' + the
//   first 16 hex chars of its sha256 + '~' + its first 40 chars with every char outside
//   [A-Za-z0-9._:-] replaced by '_' (at most 58 chars) — so a device cannot hide from the report by
//   choosing such an id, and the same id always gets the same stand-in whatever else is in the look.
//   A real id never starts with '~' (one that does is escaped too), so a stand-in never equals a
//   real id and cannot take its place. A project's peer and a work.loaded row get the same stand-in
//   as the device they name. An entry whose id is not a string or is empty is dropped; so is a
//   second entry with the same id (the first wins, as before); dropped() counts both, so the eye
//   can say how many were left out.
//   A null work is the empty work: loaded null, loading null, chatting 0, plan [], decisions [],
//   llama false. A loaded or loading that is not an object is null; a loaded model that is not an
//   object is the empty model (id '', name '', file '', size 0).
//   a device's trust.rejectsDay is a plain object; its keys are reason words from the snapshot, so
//   the three names that change an object's shape ("__proto__", "constructor", "prototype") are
//   skipped (they are never reason words).
//   a device's ring: absent (or null) stays absent, which means home; home, circle and world are
//   kept; any other value is world, the strictest reading (a ring nobody can read is no reason to
//   send private work there).
//   a device's health (12.11.2026): absent stays absent (a snapshot from before it); a health that
//   is not an object, or whose at is not a usable time, is null. Its readings come from the
//   phone's signed ledger health lines (WorkerService.kt writes one every 60 s or when its warnings
//   change: batteryPct is -1 when Android could not say it, batteryC 0.0 when unknown; the
//   feed's healthOf makes those null). Measurements outside their range are unknown (null), never
//   clamped, since a clamped heat or battery would be a made-up alarm or a made-up calm:
//     tempC (the battery's °C)   -30 .. 120              null
//     battery (percent)          0 .. 100                null
//   charging and throttled keep true and false, anything else is null.
//   a device's trust.attest (owner-blind, 12.11.2026): absent stays absent (a snapshot from before
//   it); null stays null (never asked). Its producer is engine.ts foldAttest, `{ at, ok: r.ok,
//   why: r.why, text: r.text }`, at being Date.now() when the proof came and r attest.ts
//   ownerBlind's out(ok, why, text): ok true, false or null, why one of attest.ts's Why words (at
//   most 10 chars), text a sentence that is usually under 200 chars but can be longer (the 'app'
//   text names every package the proof lists). An attest that is not a plain object, whose at is
//   not a usable time, whose ok is not true, false or null, or whose text is not a non-empty
//   string is null, never a guess. A usable one keeps at and ok as they are; why is cut to 40
//   (anything but a string is ''; no branch reads it); text is cut to 300, the most the trust
//   branch's ownerBlindCheck reads, so a long red proof stays red instead of turning unreadable.
//   the engine's loaded.sees and a trust's upTo are not in the Snapshot type and no branch reads
//   them: they are dropped.
import { sha256Hex } from '../hash.js';
import type { EyeDevice, EyeHealth, EyeModel, EyeProject, EyeTrust, EyeWork, Snapshot } from '../types.js';

export const TIME_MAX = 8.64e15;     // the largest ms a Date can hold (ECMAScript)
export const ID_MAX = 200;           // an id longer than this is not one of ours
export const NAME_MAX = 80;          // a name shown is cut to this
const HASHED = 16;                   // a stand-in shows this many hex chars of the id's sha256
const SHOWN = 40;                    // ... and this many chars of the id itself
const SHOWN_SAFE = /[^A-Za-z0-9._:-]/g;   // the chars a stand-in keeps; every other becomes '_'

const WORD = 80;                     // a short word: kind, via, lastOk, gpu, alg, store, self, state, mode
const HOST_NAME = 253;               // a hostname may be this long (os.hostname, the engine's hostLabel)
const REASON = 200;                  // reason, why, peer, head
const ADDRESS = 400;                 // where: a host and port, or a relay's address
const PROBLEM = 500;                 // a host ledger's problem: a file name and a few words
const MODEL = 300;                   // a model's file and name, a device's holds
const TITLE = 300;                   // a project's title
const REQUEST = 4000;                // a project's request: the engine cuts it there
const LINE = 1000;                   // a line, an error, a plan entry, a trust error
const DECISION = 300;                // a decision's text
const PUB = 4096;                    // a public key: the engine admits up to this
const CERT = 8192;                   // a certificate, base64 der: the engine admits up to this
const LEDGER_LINES_MAX = 1000;       // ledger lines kept at most, the newest (the engine keeps 500)
const LEDGER_LINE_MAX = 65_536;      // one ledger line at most: the engine admits lines up to 64 KiB

const MS_MAX = 600_000;              // reachMs: no probe waits ten minutes
const MB_MAX = 4 * 1024 * 1024;      // freeMb, ramMb, needMb, mb: 4 TB
const BW_MAX = 10_000;               // bwGBs
const CHATTING_MAX = 1e6;
const CTX_MAX = 1e9;
const SIZE_MAX = 1e13;               // bytes: 10 TB
const TPS_MAX = 100_000;             // tok/s
const DONE_MAX = 1e9;
const LAYERS_MAX = 10_000;
const PARAMS_MAX = 10_000;           // billion parameters
const PAIRED_MAX = 1e6;
const COUNT_MAX = 1e9;
const PARTS_MAX = 100_000;
const DAY_MAX = 1000;                // reasons in one rejectsDay
const TEMP_MIN = -30;                // a phone battery's °C: a reading outside this is no reading
const TEMP_MAX = 120;
const ATTEST_WHY = 40;               // an owner-blind proof's why: one of attest.ts's Why words (at most 10)
const ATTEST_TEXT = 300;             // ... and its text: the trust branch reads no longer one

/** an object (an array too: typeof; the callers check further) */
export const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';

/** a time the eye may keep: finite, not negative, date-sized */
export const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= TIME_MAX;

/** a finite number within [lo, hi], else null: for a measurement or a time, where out of range
 *  means no measurement rather than a saturated one */
export const num = (x: unknown, lo: number, hi: number): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null;

/** a usable id: a non-empty string of at most ID_MAX chars (cut ids are never compared with full ones) */
export const idOf = (x: unknown): string | null => typeof x === 'string' && x.length > 0 && x.length <= ID_MAX ? x : null;

/** a name: a non-empty string cut to NAME_MAX, else the id cut to NAME_MAX */
export const nameOf = (x: unknown, id: string): string => (typeof x === 'string' && x.length > 0 ? x : id).slice(0, NAME_MAX);

/** the array, or [] when it is not one */
export const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** the middle value of the finite numbers, or the mean of the two middle ones; null for none */
export function median(xs: number[]): number | null {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

// ---- the small coercions every builder uses

/** a count or a size: a finite number clamped into [lo, hi], so a value past its cap is kept at
 *  the cap and never dropped (dropping it would turn a red alarm into silence); anything that is
 *  not a finite number is unknown */
const capped = (x: unknown, lo: number, hi: number): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : null;

const word = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '');
const wordOrNull = (x: unknown, max: number): string | null => (typeof x === 'string' ? x.slice(0, max) : null);
const timeOr = (x: unknown, or: number | null): number | null => (isTime(x) ? x : or);
const bool3 = (x: unknown): boolean | null => (x === true || x === false ? x : null);
const bool2 = (x: unknown): boolean => x === true;

/** an id the eye can key anywhere, the same for the same id whatever else is in the look: a real
 *  id — non-empty, at most ID_MAX chars, not a key of Object.prototype, not starting with '~' —
 *  passes unchanged; any other string becomes '~' + the first 16 hex chars of sha256(id) + '~' +
 *  its first 40 chars with every char outside [A-Za-z0-9._:-] replaced by '_'. A real id that
 *  starts with '~' is escaped too, so a stand-in can never equal a real id. */
export function safeId(id: string): string {
  if (id.length > 0 && id.length <= ID_MAX && !id.startsWith('~') && !(id in {})) return id;
  return `~${sha256Hex(id).slice(0, HASHED)}~${id.slice(0, SHOWN).replace(SHOWN_SAFE, '_')}`;
}

/** an entry's id: safeId of a non-empty string; null when there is no id at all (the entry is left out) */
const entryId = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 ? safeId(x) : null);

/** the names that would change a plain object's shape when used as a key */
const shapeKey = (k: string): boolean => k === '__proto__' || k === 'constructor' || k === 'prototype';

// ---- the builders, one per shape

function trustOf(raw: Record<string, unknown>): EyeTrust {
  const lines = list(raw.lines)
    .filter((l): l is string => typeof l === 'string')
    .slice(-LEDGER_LINES_MAX)
    .map((l) => l.slice(0, LEDGER_LINE_MAX));
  const rejectsDay: Record<string, number> = {};   // a plain object, as the notes and views use
  if (isObj(raw.rejectsDay)) {
    for (const [w, n] of Object.entries(raw.rejectsDay).slice(0, DAY_MAX)) {
      if (w.length > REASON || shapeKey(w)) continue;   // not a reason word
      const c = capped(n, 0, COUNT_MAX);                 // past the cap: the cap, never silence
      if (c !== null) rejectsDay[w] = c;                 // not a number: unknown, the entry is dropped
    }
  }
  const rejectsLast: { t: number; why: string; peer: string }[] = [];
  for (const r of list(raw.rejectsLast).slice(-LEDGER_LINES_MAX)) {
    if (!isObj(r) || !isTime(r.t)) continue;
    rejectsLast.push({ t: r.t, why: word(r.why, REASON), peer: word(r.peer, REASON) });
  }
  return {
    at: timeOr(raw.at, 0) as number,
    error: wordOrNull(raw.error, LINE),
    id: wordOrNull(raw.id, ID_MAX),
    alg: wordOrNull(raw.alg, WORD),
    pub: wordOrNull(raw.pub, PUB),
    store: wordOrNull(raw.store, WORD),
    cert: wordOrNull(raw.cert, CERT),
    certPinned: bool3(raw.certPinned),
    v1: bool3(raw.v1),
    paired: capped(raw.paired, 0, PAIRED_MAX),
    self: wordOrNull(raw.self, WORD),
    count: capped(raw.count, 0, COUNT_MAX),
    head: wordOrNull(raw.head, REASON),
    lines,
    restartedAt: timeOr(raw.restartedAt, null),
    rejectsDay,
    rejectsLast,
    // only when the snapshot has the key (an older one does not)
    ...('attest' in raw ? { attest: attestOf(raw.attest) } : {}),
  };
}

/** a trust's owner-blind proof: a usable at, ok true/false/null and a non-empty text, else null */
function attestOf(raw: unknown): NonNullable<EyeTrust['attest']> | null {
  if (!isObj(raw) || !isTime(raw.at)) return null;
  if (raw.ok !== true && raw.ok !== false && raw.ok !== null) return null;
  if (typeof raw.text !== 'string' || raw.text.length === 0) return null;
  return { at: raw.at, ok: raw.ok, why: word(raw.why, ATTEST_WHY), text: raw.text.slice(0, ATTEST_TEXT) };
}

/** a device's health: an object with a usable at, else null; a reading out of its range is unknown */
function healthOf(raw: unknown): EyeHealth | null {
  if (!isObj(raw) || !isTime(raw.at)) return null;
  return {
    at: raw.at,
    tempC: num(raw.tempC, TEMP_MIN, TEMP_MAX),
    battery: num(raw.battery, 0, 100),
    charging: bool3(raw.charging),
    throttled: bool3(raw.throttled),
  };
}

function devOf(raw: Record<string, unknown>, id: string): EyeDevice {
  return {
    id,
    name: nameOf(raw.name, id),
    kind: word(raw.kind, WORD),
    via: word(raw.via, WORD) as EyeDevice['via'],
    where: word(raw.where, ADDRESS),
    reachable: bool3(raw.reachable),
    reachMs: num(raw.reachMs, 0, MS_MAX),
    reason: wordOrNull(raw.reason, REASON),
    checkedAt: timeOr(raw.checkedAt, null),
    lastOk: wordOrNull(raw.lastOk, WORD),
    ramMb: capped(raw.ramMb, 0, MB_MAX),
    bwGBs: num(raw.bwGBs, 0, BW_MAX),
    gpu: wordOrNull(raw.gpu, WORD),
    tls: bool2(raw.tls),
    waitingPair: bool2(raw.waitingPair),
    plugged: bool3(raw.plugged),
    holds: wordOrNull(raw.holds, MODEL),
    trust: isObj(raw.trust) ? trustOf(raw.trust) : null,
    // only when the snapshot has it (an older one does not): one of the three kinds, else null
    ...('reachedBy' in raw ? { reachedBy: raw.reachedBy === 'lan' || raw.reachedBy === 'ipv6' || raw.reachedBy === 'mapped' ? raw.reachedBy : null } : {}),
    ...(raw.ring == null ? {} : { ring: raw.ring === 'home' || raw.ring === 'circle' ? raw.ring : 'world' }),
    // only when the snapshot has it (an older one does not)
    ...('health' in raw ? { health: healthOf(raw.health) } : {}),
  };
}

function devicesOf(raw: unknown): EyeDevice[] {
  const seen = new Set<string>();
  const out: EyeDevice[] = [];
  for (const d of list(raw)) {
    if (!isObj(d)) continue;
    const id = entryId(d.id);
    if (id === null || seen.has(id)) continue;   // no usable id, or the same id twice: the first wins
    seen.add(id);
    out.push(devOf(d, id));
  }
  return out;
}

function loadedOf(raw: unknown): EyeWork['loaded'] {
  if (!isObj(raw)) return null;
  const model = isObj(raw.model)
    ? {
        id: entryId(raw.model.id) ?? '',
        name: word(raw.model.name, MODEL),
        file: word(raw.model.file, MODEL),
        size: capped(raw.model.size, 0, SIZE_MAX) ?? 0,
      }
    : { id: '', name: '', file: '', size: 0 };   // the empty model, never a guess
  const devices: { id: string; name: string; local: boolean; busy: boolean; tps: number | null; done: number }[] = [];
  for (const d of list(raw.devices)) {
    if (!isObj(d)) continue;
    const id = entryId(d.id);
    if (id === null) continue;
    devices.push({
      id,
      name: nameOf(d.name, id),
      local: bool2(d.local),
      busy: bool2(d.busy),
      tps: num(d.tps, 0, TPS_MAX),
      done: capped(d.done, 0, DONE_MAX) ?? 0,
    });
  }
  const loaded: NonNullable<EyeWork['loaded']> = {
    mode: word(raw.mode, WORD),
    model,
    ctx: capped(raw.ctx, 0, CTX_MAX) ?? 0,
    since: timeOr(raw.since, 0) as number,
    devices,
  };
  if (raw.parts !== undefined) {
    loaded.parts = list(raw.parts).map((p) => {
      if (!isObj(p)) return null;
      const id = entryId(p.id);
      if (id === null) return null;
      return { id, name: nameOf(p.name, id), local: bool2(p.local), mb: capped(p.mb, 0, MB_MAX) ?? 0, layers: capped(p.layers, 0, LAYERS_MAX) ?? 0 };
    }).filter((p): p is NonNullable<NonNullable<EyeWork['loaded']>['parts']>[number] => p !== null);
  }
  return loaded;
}

function workOf(raw: unknown): EyeWork {
  if (!isObj(raw)) return { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: false };
  const loading = isObj(raw.loading)
    ? {
        mode: word(raw.loading.mode, WORD),
        model: word(raw.loading.model, MODEL),
        since: timeOr(raw.loading.since, 0) as number,
        line: word(raw.loading.line, LINE),
      }
    : null;
  const decisions = list(raw.decisions)
    .map((d) => (isObj(d) && isTime(d.at) ? { at: d.at, text: word(d.text, DECISION) } : null))
    .filter((d): d is { at: number; text: string } => d !== null);
  return {
    loaded: loadedOf(raw.loaded),
    loading,
    chatting: capped(raw.chatting, 0, CHATTING_MAX) ?? 0,
    plan: list(raw.plan).map((p) => word(p, LINE)),
    decisions,
    llama: bool2(raw.llama),
    ...(isObj(raw.photos) ? { photos: { n: capped(raw.photos.n, 0, COUNT_MAX) ?? 0, unseen: capped(raw.photos.unseen, 0, COUNT_MAX) ?? 0, at: timeOr(raw.photos.at, null) } } : {}),
  };
}

function modelsOf(raw: unknown): EyeModel[] {
  const seen = new Set<string>();
  const out: EyeModel[] = [];
  for (const m of list(raw)) {
    if (!isObj(m)) continue;
    const id = entryId(m.id);
    if (id === null || seen.has(id)) continue;   // no usable id, or the same id twice: the first wins
    seen.add(id);
    out.push({
      id,
      name: word(m.name, MODEL),
      file: word(m.file, MODEL),
      size: capped(m.size, 0, SIZE_MAX) ?? 0,
      quant: wordOrNull(m.quant, WORD),
      params_b: capped(m.params_b, 0, PARAMS_MAX),
      catalog: bool2(m.catalog),
      here: bool2(m.here),
      needMb: capped(m.needMb, 0, MB_MAX) ?? 0,
      ...(m.active_b !== undefined ? { active_b: capped(m.active_b, 0, PARAMS_MAX) } : {}),
      ...(m.vision !== undefined ? { vision: bool2(m.vision) } : {}),
    });
  }
  return out;
}

function projectsOf(raw: unknown): EyeProject[] {
  const seen = new Set<string>();
  const out: EyeProject[] = [];
  for (const p of list(raw)) {
    if (!isObj(p)) continue;
    const id = entryId(p.id);
    if (id === null || seen.has(id)) continue;   // no usable id, or the same id twice: the first wins
    seen.add(id);
    const project: EyeProject = {
      id,
      title: word(p.title, TITLE),
      request: word(p.request, REQUEST),
      start: timeOr(p.start, 0) as number,
      end: timeOr(p.end, 0) as number,
      state: word(p.state, WORD),
      mode: word(p.mode, WORD),
      model: word(p.model, MODEL),
      peers: list(p.peers).map((x) => entryId(x)).filter((x): x is string => x !== null),
    };
    if (p.parts !== undefined) project.parts = capped(p.parts, 0, PARTS_MAX) ?? 0;
    if (p.done !== undefined) project.done = capped(p.done, 0, DONE_MAX) ?? 0;
    if (p.line !== undefined) project.line = word(p.line, LINE);
    if (p.error !== undefined) project.error = word(p.error, LINE);
    out.push(project);
  }
  return out;
}

function hostOf(raw: unknown): Snapshot['host'] {
  const h = isObj(raw) ? raw : null;
  const host: Snapshot['host'] = {
    name: h && typeof h.name === 'string' && h.name.length > 0 ? h.name.slice(0, HOST_NAME) : 'this computer',
    freeMb: h ? capped(h.freeMb, 0, MB_MAX) : null,
  };
  if (h && h.ledger !== undefined) {
    host.ledger = isObj(h.ledger)
      ? { ok: bool2(h.ledger.ok), count: capped(h.ledger.count, 0, COUNT_MAX) ?? 0, problem: wordOrNull(h.ledger.problem, PROBLEM) }
      : null;
  }
  if (h && h.power !== undefined) {
    host.power = isObj(h.power)
      ? { battery: capped(h.power.battery, 0, 100), charging: bool3(h.power.charging), hot: bool3(h.power.hot) }
      : null;
  }
  return host;
}

/** how many entries of a look clean() leaves out: not an object, no id at all (not a string, or
 *  empty), or the same id again after its first entry. */
export interface Dropped { devices: number; models: number; projects: number }

/** the same counts clean() makes: what it still drops, so the eye can say it. a getter that throws
 *  is no look (clean() returns null and the eye skips it), so there is nothing to count. */
export function dropped(raw: unknown): Dropped {
  const out: Dropped = { devices: 0, models: 0, projects: 0 };
  try {
    if (!isObj(raw)) return out;
    out.devices = leftOut(raw.devices);
    out.models = leftOut(raw.models);
    out.projects = leftOut(raw.projects);
  } catch {
    // a getter that throws is no look: clean() returns null and the eye skips it
  }
  return out;
}

/** one list's left-out entries: no usable id, and every entry after the first with the same id */
function leftOut(xs: unknown): number {
  const seen = new Set<string>();
  let n = 0;
  for (const x of list(xs)) {
    const id = isObj(x) ? entryId(x.id) : null;
    if (id === null || seen.has(id)) n++;
    else seen.add(id);
  }
  return n;
}

/** one raw value in, one clean Snapshot out. null when it is not an object or its `at` is not a
 *  usable time; never a throw (a getter that throws is a look that cannot be trusted). */
export function clean(raw: unknown): Snapshot | null {
  try {
    if (!isObj(raw)) return null;      // not an object: no look
    if (!isTime(raw.at)) return null;  // no usable time: no look
    return {
      at: raw.at,
      host: hostOf(raw.host),
      devices: devicesOf(raw.devices),
      work: workOf(raw.work),
      models: modelsOf(raw.models),
      projects: projectsOf(raw.projects),
    };
  } catch {
    return null;
  }
}
