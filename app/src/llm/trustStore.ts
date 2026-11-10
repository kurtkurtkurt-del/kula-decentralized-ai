import { useEffect, useMemo, useState } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { peerRelay, peerTls } from '@/llm/cluster';
import { llama } from '@/llm/native';
import { peers as savedPeers, usePeers, type Peer } from '@/llm/store';
import { accept, clusterReport, deviceReport, hostCheck, look, type ClusterReport, type TrustIO, type TrustNote } from '@/llm/trust';

// The security report's notes on this phone (src/llm/trust.ts): per paired device, the last
// ledger line verified here, how many, since when, and a ledger fault that waits for the person.
// Kept in the app's kv-store, so a restart does not start the checking over (and a ledger that
// started over while the app was closed is still caught). Nothing private: hashes, counts, times.
const KEY = 'llm.trust';
const ASK_MS = 6000;
export const TRUST_EVERY_MS = 60_000; // while the brain tab or the trust screen is open

let notes: Record<string, TrustNote> | null = null;
const listeners = new Set<() => void>();

function read(): Record<string, TrustNote> {
  if (notes) return notes;
  try {
    const raw = Storage.getItemSync(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    notes = parsed && typeof parsed === 'object' ? (parsed as Record<string, TrustNote>) : {};
  } catch {
    notes = {};
  }
  return notes;
}
function write(next: Record<string, TrustNote>) {
  notes = next;
  try {
    Storage.setItemSync(KEY, JSON.stringify(next));
  } catch {}
  listeners.forEach((fn) => fn());
}

export const trustNotes = (): Record<string, TrustNote> => read();

export function useTrustNotes(): Record<string, TrustNote> {
  const [v, setV] = useState(read);
  useEffect(() => {
    const fn = () => setV(read());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return v;
}

/** "I know why (I cleared it)" on a device: its ledger is followed on from here. */
export function acceptTrust(id: string) {
  const all = read();
  if (!all[id]?.fault) return;
  write({ ...all, [id]: accept(all[id]) });
}

async function get(url: string): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ASK_MS);
  try {
    const r = await fetch(url, { signal: ac.signal });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  } catch (e) {
    throw new Error(ac.signal.aborted ? 'no answer in time' : (e as Error)?.message || 'no answer');
  } finally {
    clearTimeout(timer);
  }
}

/** The tunnels and the native checks; apart mode's tunnel to a device is the same one (KulaLlamaModule apiTunnel reuses it). */
export const nativeIO = (): TrustIO | null =>
  llama
    ? {
        tunnel: (p) => llama!.apiTunnel(p.host, p.port, p.secret, peerTls(p), peerRelay(p)),
        get,
        verify: (...a) => llama!.verifyTrust(...a),
        now: () => Date.now(),
      }
    : null;

let running: Promise<void> | null = null;

/**
 * One look at every paired device, side by side; a look already under way is the answer to a
 * second ask. Never throws and never waits on the screen: the brain tab calls it and moves on.
 * Notes of devices no longer paired go.
 */
export function checkTrust(peers: Peer[], io: TrustIO | null = nativeIO()): Promise<void> {
  if (!io) return Promise.resolve();
  if (running) return running;
  running = (async () => {
    const ids = new Set(peers.map((p) => p.id));
    const kept = Object.fromEntries(Object.entries(read()).filter(([id]) => ids.has(id)));
    if (Object.keys(kept).length !== Object.keys(read()).length) write(kept);
    await Promise.all(peers.map(async (p) => {
      const was = read()[p.id] ?? null;
      let n = await look(p, was, io);
      // the person said "I know why" while this look was on its way: the same fault stays accepted
      const now = read()[p.id];
      if (was?.fault && now && !now.fault && n.fault?.why === was.fault.why && n.fault.line === was.fault.line) n = accept(n);
      write({ ...read(), [p.id]: n });
    }));
  })().catch(() => {}).finally(() => {
    running = null;
  });
  return running;
}

/** Is a look under way (the screen says "checking…"). */
export const trustBusy = () => running !== null;

/**
 * The rhythm while a screen that shows the report is open: a look now, then every minute
 * (each look is one gate connection per device, which the device writes to its ledger, so not
 * at the 15 s the brain tab reads its own ledger). Returns the stop.
 */
export function startTrustRhythm(onDone?: () => void): () => void {
  if (!llama) return () => {};
  const go = () => {
    const list = savedPeers();
    if (list.length) checkTrust(list).then(onDone, onDone);
  };
  const first = setTimeout(go, 0);
  const every = setInterval(go, TRUST_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/** The report for the paired devices as kept now; [host] is this phone's own ledger chain (null: none read). */
export function useTrustReport(host: { ok: boolean; lines: number } | null): ClusterReport {
  const list = usePeers();
  const notes = useTrustNotes();
  const ok = host?.ok;
  const lines = host?.lines;
  return useMemo(
    () => clusterReport(list.map((p) => deviceReport(p, notes[p.id] ?? null)), hostCheck(lines == null ? null : { ok: !!ok, lines })),
    [list, notes, ok, lines],
  );
}

/** For tests: forget what was read from storage. */
export const resetTrustCache = () => {
  notes = null;
};
