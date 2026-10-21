import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import Storage from 'expo-sqlite/kv-store';
import { supabase } from '@/lib/supabase';

// Keep the app fast and working without a connection.
//
// Reads, saved copy first: every successful response is stored on the phone (kv-store,
//   per user, mirrored in memory). A read with a saved copy returns it at once and
//   fetches a fresh one in the background; when that differs, screens listening to the
//   shelf (useShelf) read again. Only a read with nothing saved waits for the network.
//   Offline the saved copy is all there is; with nothing saved a screen says "offline".
// Writes, one outbox: every write goes through send(). Online with an empty outbox it
//   goes straight out; otherwise it waits in order on the phone and goes out when the
//   connection returns, retried with growing pauses while the server is unreachable.
//   Each job carries an id made on the phone, so the database can tell a retry from a
//   second action (the client_id columns of 01, 08, 11). Screens show waiting jobs right away (pendingJobs).
//   A job the server refuses is dropped, counted in `refused` (the offline bar says so)
//   and the shelves it touches are read again, which undoes what the screen showed.

// ------------------------------------------------------------- connectivity

type Net = { online: boolean; pending: number; sending: boolean; refused: number };
let net: Net = { online: true, pending: 0, sending: false, refused: 0 };
const listeners = new Set<() => void>();
const tell = (next: Partial<Net>) => {
  const was = net.online;
  net = { ...net, ...next };
  listeners.forEach((fn) => fn());
  if (!was && net.online) {
    flush().catch(() => {});
    back.forEach((fn) => fn());
  }
};
const back = new Set<() => void>();

// Called when the connection returns (so screens can refresh).
export function onBackOnline(fn: () => void) {
  back.add(fn);
  return () => {
    back.delete(fn);
  };
}

export const isOnline = () => net.online;

export function useNet() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => net,
  );
}

let started = false;
export function startOffline() {
  if (started) return;
  started = true;
  NetInfo.addEventListener((s) => {
    // isInternetReachable null = unknown yet; treat as connected.
    tell({ online: !!s.isConnected && s.isInternetReachable !== false });
  });
  AppState.addEventListener('change', (s) => {
    if (s === 'active') flush().catch(() => {});
    // Going to the background: write the shelves now, the app may not come back.
    else flushShelves();
  });
  tell({ pending: mine(queue()).length });
  flush().catch(() => {});
}

// A network failure (as opposed to the server saying no).
export function isNetworkError(e: unknown) {
  if ((e as { name?: string })?.name === 'AuthRetryableFetchError') return true;
  const m = String((e as { message?: string })?.message ?? e);
  return /network request failed|failed to fetch|network|timeout|timed out|aborted|offline/i.test(m);
}

export class OfflineError extends Error {
  constructor() {
    super('offline');
  }
}

// ------------------------------------------------------------ storage

const get = (key: string) => {
  try {
    return Storage.getItemSync(key);
  } catch {
    return null;
  }
};
const put = (key: string, value: string | null) => {
  try {
    if (value === null) Storage.removeItemSync(key);
    else Storage.setItemSync(key, value);
  } catch {}
};

// Owner of the shelves. getSession() is not used: offline it cannot refresh an expired
// token, returns an empty session, and the user's cache would suddenly vanish.
// The id is written here on every auth change and persisted on the phone.
const OWNER = 'cache.owner';
let owner: string | null = null;
supabase.auth.onAuthStateChange((event, session) => {
  if (session?.user?.id) {
    owner = session.user.id;
    put(OWNER, owner);
  } else if (event === 'SIGNED_OUT') {
    owner = null;
    put(OWNER, null);
  }
});
function who() {
  return owner ?? get(OWNER) ?? 'out';
}

// ------------------------------------------------------------ shelves

type Shelf = Record<string, { t: number; v: unknown }>;

// Shelves live in memory once read; writes reach the phone's storage a moment later in
// one go, so a burst of reads does not parse and rewrite the same big JSON every time.
const mem = new Map<string, Shelf>();
const dirty = new Set<string>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function shelfOf(shelfKey: string): Shelf {
  let s = mem.get(shelfKey);
  if (!s) {
    try {
      s = JSON.parse(get(shelfKey) ?? '{}') as Shelf;
    } catch {
      s = {};
    }
    mem.set(shelfKey, s);
  }
  return s;
}

export function flushShelves() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  dirty.forEach((k) => put(k, JSON.stringify(mem.get(k) ?? {})));
  dirty.clear();
}

function persist(shelfKey: string) {
  dirty.add(shelfKey);
  if (!writeTimer) writeTimer = setTimeout(flushShelves, 400);
}

// Store one entry; a full shelf drops its oldest. True when the value changed.
function store(shelfKey: string, key: string, value: unknown, max: number, t = Date.now()) {
  const s = shelfOf(shelfKey);
  const before = s[key] ? JSON.stringify(s[key].v) : undefined;
  s[key] = { t, v: value };
  const keys = Object.keys(s).sort((a, b) => s[b].t - s[a].t);
  keys.slice(max).forEach((k) => delete s[k]);
  persist(shelfKey);
  return before !== JSON.stringify(value);
}

// Shelf updates: screens read again when a background fetch brought something new.
const shelfListeners = new Map<string, Set<() => void>>();
function emit(group: string) {
  shelfListeners.get(group)?.forEach((fn) => fn());
}
export function onShelf(group: string, fn: () => void) {
  let set = shelfListeners.get(group);
  if (!set) shelfListeners.set(group, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

// A counter that goes up when any of these shelves gets something new; effects that
// read those shelves depend on it. Bursts are folded into one re-read.
export function useShelf(...groups: string[]) {
  const [n, setN] = useState(0);
  const joined = groups.join('|');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = null;
          setN((x) => x + 1);
        }, 60);
    };
    const offs = joined.split('|').map((g) => onShelf(g, bump));
    return () => {
      offs.forEach((off) => off());
      if (timer) clearTimeout(timer);
    };
  }, [joined]);
  return n;
}

// After a write, the next read of these shelves waits for the server (when online)
// instead of showing the copy from before the write. Listeners are told to read again.
const forced = new Set<string>();
export function invalidate(...groups: string[]) {
  groups.forEach((g) => {
    forced.add(g);
    emit(g);
  });
}

// Background refreshes in flight, one per shelf entry.
const inflight = new Map<string, Promise<void>>();
function refresh<T>(shelfKey: string, group: string, key: string, work: () => Promise<T>, max: number) {
  const id = `${shelfKey}|${key}`;
  if (inflight.has(id)) return;
  const p = work()
    .then((value) => {
      if (!net.online) tell({ online: true });
      if (store(shelfKey, key, value, max)) emit(group);
    })
    .catch((e) => {
      if (isNetworkError(e)) tell({ online: false });
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
}

type ReadOptions = {
  // ms during which a saved copy counts as fresh: no background fetch (lists that rarely
  // change: DJs, cities, photos of places). Default 0: always refresh in the background.
  ttl?: number;
  // Wait for the server even with a saved copy (falls back to it offline).
  fresh?: boolean;
};

// group: a shelf (deck, comments …), key: slot on the shelf, max: shelf capacity.
// stale: true when the value came from the phone, not from the server just now.
export async function cachedRead<T>(group: string, key: string, work: () => Promise<T>, max = 1, opts: ReadOptions = {}): Promise<{ value: T; stale: boolean }> {
  const shelfKey = `cache.${who()}.${group}`;
  const saved = shelfOf(shelfKey)[key];
  const wait = opts.fresh || forced.has(group);

  if (saved && !(wait && net.online)) {
    if (net.online && Date.now() - saved.t >= (opts.ttl ?? 0)) refresh(shelfKey, group, key, work, max);
    return { value: saved.v as T, stale: true };
  }
  if (!net.online) {
    if (saved) return { value: saved.v as T, stale: true };
    throw new OfflineError();
  }
  try {
    const value = await work();
    forced.delete(group);
    store(shelfKey, key, value, max);
    if (!net.online) tell({ online: true });
    return { value, stale: false };
  } catch (e) {
    if (isNetworkError(e)) {
      tell({ online: false });
      if (saved) return { value: saved.v as T, stale: true };
      throw new OfflineError();
    }
    throw e;
  }
}

export async function remember<T>(group: string, key: string, work: () => Promise<T>, max = 1, opts: ReadOptions = {}): Promise<T> {
  return (await cachedRead(group, key, work, max, opts)).value;
}

// The saved copy only, without asking the server (null when there is none).
export function peek<T>(group: string, key: string): T | null {
  const s = shelfOf(`cache.${who()}.${group}`)[key];
  return s ? (s.v as T) : null;
}

// Put something on a shelf directly (nights from the deck, so night pages open offline).
export async function shelve(group: string, entries: [string, unknown][], max: number) {
  if (!entries.length) return;
  const shelfKey = `cache.${who()}.${group}`;
  const now = Date.now();
  // Entries put here are not fresher than what is there: keep their time behind a real read.
  entries.forEach(([k, v]) => store(shelfKey, k, v, max, now));
}

// Swiped on this phone: keep them out while an older saved deck is shown.
export async function markSwiped(slug: string, on = true) {
  const key = `cache.${who()}.swiped`;
  let list: string[] = [];
  try {
    list = JSON.parse(get(key) ?? '[]');
  } catch {}
  list = list.filter((s) => s !== slug);
  if (on) list.push(slug);
  put(key, JSON.stringify(list.slice(-1500)));
}
export async function swipedHere(): Promise<Set<string>> {
  try {
    return new Set(JSON.parse(get(`cache.${who()}.swiped`) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
export function forgetSwiped() {
  put(`cache.${who()}.swiped`, null);
}

// Turns Supabase's {data, error} response into one that throws.
export async function must<T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T | null> {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

// ------------------------------------------------------------- writes

// A job: what to do (kind + its fields), whose it is, when it was done on the phone and
// its own id. Handlers for the kinds are registered by the data modules (outbox()).
export type Job = { kind: string; id: string; uid: string; at: number; [field: string]: unknown };
type Handler = { run: (job: Job) => Promise<unknown>; touches?: string[] };
const handlers = new Map<string, Handler>();

// Register what a kind of job does and which shelves it changes (read again afterwards).
export function outbox(kind: string, run: Handler['run'], touches: string[] = []) {
  handlers.set(kind, { run, touches });
}

// A version 4 uuid without a native module (ids for the database's retry check).
export function newId() {
  const h = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16));
  h[12] = '4';
  h[16] = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const QUEUE = 'outbox';
function queue(): Job[] {
  try {
    const list = JSON.parse(get(QUEUE) ?? '[]') as Partial<Job>[];
    // Jobs saved by older versions had no id or time.
    return list.map((j) => ({ ...j, id: j.id ?? newId(), at: j.at ?? Date.now() }) as Job);
  } catch {
    return [];
  }
}
const mine = (list: Job[]) => list.filter((j) => j.uid === who());
function save(list: Job[]) {
  put(QUEUE, list.length ? JSON.stringify(list) : null);
  tell({ pending: mine(list).length });
}

// Jobs still waiting, this account only; screens show them as if done (with a mark).
export function pendingJobs(kind?: string): Job[] {
  return mine(queue()).filter((j) => !kind || j.kind === kind);
}

// Built in: keep / let go (lib/offline.ts has always sent these; the rest register
// themselves in their data modules, loaded by data/jobs.ts).
outbox(
  'swipe',
  async (j) => {
    const { error } = await supabase.rpc('join_set', { p_slug: j.slug, p_direction: j.direction });
    if (error) throw error;
  },
  ['kept', 'yours', 'projectPage'],
);
outbox(
  'unswipe',
  async (j) => {
    const { error } = await supabase.rpc('join_unset', { p_slug: j.slug });
    if (error) throw error;
  },
  ['kept', 'yours', 'projectPage'],
);

function touched(job: Job) {
  const groups = handlers.get(job.kind)?.touches ?? [];
  if (groups.length) invalidate(...groups);
}

// Try now; queue when offline. A server refusal while online is thrown; the job's
// result (e.g. a card number) is returned when it went out, undefined when queued.
export async function send(op: { kind: string; [field: string]: unknown }): Promise<{ queued: boolean; result?: unknown; job: Job }> {
  const job: Job = { id: newId(), at: Date.now(), ...op, uid: who() } as Job;
  const handler = handlers.get(job.kind);
  if (!handler) throw new Error(`no outbox handler for ${job.kind}`);
  // With jobs waiting, append so order is preserved (swipe → undo).
  if (net.online && mine(queue()).length === 0) {
    try {
      const result = await handler.run(job);
      touched(job);
      return { queued: false, result, job };
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      tell({ online: false });
    }
  }
  save([...queue(), job]);
  touched(job);
  return { queued: true, job };
}

// Retry while the server cannot be reached although the phone says it is online:
// 2 s, 4 s, 8 s … up to a minute.
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 2000;
function retryLater() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flush().catch(() => {});
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60000);
}

let flushing: Promise<void> | null = null;
export function flush() {
  if (flushing) return flushing;
  // `flushing` is cleared when the run settles, never inside it: an early return inside
  // ran before the assignment below and left `flushing` set for good (nothing went out).
  flushing = (async () => {
    const uid = who();
    let list = queue();
    if (!list.length || !net.online) return;
    tell({ sending: true });
    let refused = 0;
    try {
      while (list.length) {
        const job = list[0];
        // Never send another account's work with this account: leave it for that account.
        if (job.uid !== uid) {
          if (list.every((j) => j.uid !== uid)) break;
          list = [...list.slice(1), job];
          save(list);
          continue;
        }
        const handler = handlers.get(job.kind);
        // Its module has not loaded yet (data/jobs.ts loads them all at start): wait.
        if (!handler) return;
        try {
          await handler.run(job);
          retryDelay = 2000;
        } catch (e) {
          if (isNetworkError(e)) {
            retryLater();
            return;
          }
          // Refused by the server (e.g. the night was deleted): drop it and continue.
          refused++;
        }
        list = list.slice(1);
        save(list);
        touched(job);
      }
    } finally {
      tell({ sending: false, ...(refused ? { refused: net.refused + refused } : {}) });
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

// The offline bar has shown the refusals: back to zero.
export function clearRefused() {
  if (net.refused) tell({ refused: 0 });
}

// On sign-out: remove that account's read shelves (in case someone else uses the phone).
export function forgetCache(uid: string) {
  try {
    [...mem.keys()].filter((k) => k.startsWith(`cache.${uid}.`)).forEach((k) => {
      mem.delete(k);
      dirty.delete(k);
    });
    Storage.getAllKeysSync()
      .filter((k) => k.startsWith(`cache.${uid}.`))
      .forEach((k) => Storage.removeItemSync(k));
  } catch {}
}
