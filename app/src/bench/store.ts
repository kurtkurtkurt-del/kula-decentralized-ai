import { useEffect, useState } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { measuredTps, measuredTunnel, type BenchRecord, type ModelKey } from '@/bench/core';

// The bench history on this phone (kv-store, never sent): the newest MAX_BENCH records.
// The planner reads it through measuredFor(): a measured tok/s for this phone ('self')
// or a peer on a model replaces bandwidth × efficiency (docs/BENCH.md).
const KEY = 'bench.history';
export const MAX_BENCH = 20;

const listeners = new Set<() => void>();

export function benchHistory(): BenchRecord[] {
  try {
    const raw = Storage.getItemSync(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as BenchRecord[]).filter((r) => r?.kind === 'kula-bench') : [];
  } catch {
    return [];
  }
}

/** Keeps a record (newest first), drops the oldest past MAX_BENCH. */
export function saveBench(r: BenchRecord) {
  const list = [r, ...benchHistory().filter((x) => x.at !== r.at)].slice(0, MAX_BENCH);
  try {
    Storage.setItemSync(KEY, JSON.stringify(list));
  } catch {}
  listeners.forEach((fn) => fn());
}

export function clearBench() {
  try {
    Storage.removeItemSync(KEY);
  } catch {}
  listeners.forEach((fn) => fn());
}

export function useBenchHistory(): BenchRecord[] {
  const [v, setV] = useState(benchHistory);
  useEffect(() => {
    const fn = () => setV(benchHistory());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return v;
}

/** The newest measured decoding tok/s of 'self' (this phone) or a peer id on a model, or null. */
export const measuredFor = (device: string, model: ModelKey): number | null => measuredTps(benchHistory(), device, model);
/** The newest measured tunnel MB/s to a peer, or null. */
export const tunnelFor = (device: string): number | null => measuredTunnel(benchHistory(), device);
