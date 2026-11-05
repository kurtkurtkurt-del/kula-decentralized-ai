import { useEffect, useState } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { CATALOG, modelUrl, type CatalogModel } from '@/llm/catalog';
import { llama, type DownloadEvent } from '@/llm/native';

// What this phone keeps about models and peers (kv-store, never sent): the models on disk,
// the downloads in flight, the chosen model and its settings, and the peers paired by qr.
// Files live in the app's own files/models (the native module owns the bytes).
export type ModelSource = 'catalog' | 'hf';
export type LocalModel = {
  id: string;            // catalog id, or "hf:<repo>/<file>"
  name: string;
  file: string;
  path: string;
  size: number;
  sha256: string | null;
  params_b: number;
  quant: string;
  kv_mb_per_1k: number;
  ctx_max: number;
  license: string | null;
  source: ModelSource;
  url: string;
  added_at: string;
};
export type Download = { id: string; got: number; total: number; state: DownloadEvent['state']; error: string | null; model: Omit<LocalModel, 'path' | 'added_at'> };
export type Peer = {
  id: string;            // the worker's lasting id
  name: string;
  host: string;
  port: number;
  secret: string;        // protocol v1 (qr v2); '' for a v3 peer
  fp?: string | null;    // protocol v2 (qr v3): the worker's certificate fingerprint, pinned from the qr
  pin?: string | null;   // the one-time pairing code from that qr; cleared once paired
  paired_at?: string | null;
  // far away, behind nat: reached through this relay with this code (docs/RELAY.md). only the
  // api channel crosses a relay, so such a peer takes part in apart mode and never in split
  relay?: { url: string; code: string } | null;
  kind: 'phone' | 'tablet' | 'pc';
  ram: number | null;    // MB free when it advertised
  bw: number | null;     // GB/s
  passport?: Record<string, unknown> | null;
  added_at: string;
  last_ok?: string | null;
};
export type Mode = 'alone' | 'apart' | 'split';
export type Settings = { modelId: string | null; ctx: number; temperature: number; maxTokens: number; lastMode: Mode; relayUrl: string };

const MODELS = 'llm.models';
const PEERS = 'llm.peers';
const SETTINGS = 'llm.settings';
const SHARE = 'llm.share'; // this phone's own worker secret + name

const read = <T,>(k: string, d: T): T => {
  try {
    const raw = Storage.getItemSync(k);
    return raw ? (JSON.parse(raw) as T) : d;
  } catch {
    return d;
  }
};
const write = (k: string, v: unknown) => {
  try {
    Storage.setItemSync(k, JSON.stringify(v));
  } catch {}
  listeners.forEach((fn) => fn());
};
const listeners = new Set<() => void>();
function useStore<T>(get: () => T): T {
  const [v, setV] = useState(get);
  useEffect(() => {
    const fn = () => setV(get());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return v;
}

// ---- models on disk --------------------------------------------------------------------
export const localModels = () => read<LocalModel[]>(MODELS, []);
export const useLocalModels = () => useStore(localModels);
export const localById = (id: string) => localModels().find((m) => m.id === id) ?? null;
export function rememberModel(m: LocalModel) {
  write(MODELS, [m, ...localModels().filter((x) => x.id !== m.id)]);
}
export async function forgetModel(id: string) {
  const m = localById(id);
  if (m && llama) await llama.deleteFile(m.path).catch(() => {});
  write(MODELS, localModels().filter((x) => x.id !== id));
  const s = settings();
  if (s.modelId === id) saveSettings({ modelId: null });
}
/** Drops entries whose file is gone (uninstall-reinstall, a manual delete). */
export async function reconcileModels() {
  if (!llama) return;
  const files = await llama.listModels().catch(() => []);
  const names = new Set(files.filter((f) => !f.partial).map((f) => f.name));
  const kept = localModels().filter((m) => names.has(m.file));
  if (kept.length !== localModels().length) write(MODELS, kept);
  // a download the app was killed in: its .part is still there; show it as interrupted so
  // "retry" continues it (the native side resumes with a Range request)
  for (const f of files.filter((x) => x.partial)) {
    const file = f.name.replace(/\.part$/, '');
    if (downloads.has(file)) continue;
    const c = CATALOG.find((m) => m.file === file);
    const model = c ? describe(c) : null;
    if (!model || downloads.has(model.id)) continue;
    downloads.set(model.id, { id: model.id, got: f.size, total: model.size, state: 'error', error: 'interrupted', model });
  }
  listeners.forEach((fn) => fn());
}

export function describe(m: CatalogModel): Omit<LocalModel, 'path' | 'added_at'> {
  return { id: m.id, name: m.name, file: m.file, size: m.size, sha256: m.sha256, params_b: m.params_b, quant: m.quant, kv_mb_per_1k: m.kv_mb_per_1k, ctx_max: m.ctx_max, license: m.license, source: 'catalog', url: modelUrl(m) };
}

// ---- downloads in flight (memory only; the native side keeps the .part file) ------------
const downloads = new Map<string, Download>();
let subscribed = false;
export const useDownloads = () => useStore(() => Array.from(downloads.values()));
export const downloadOf = (id: string) => downloads.get(id) ?? null;
function subscribe() {
  if (subscribed || !llama) return;
  subscribed = true;
  llama.addListener('onDownload', (e) => {
    const d = downloads.get(e.id);
    if (!d) return;
    d.got = e.got;
    d.total = e.total || d.total;
    d.state = e.state;
    d.error = e.error;
    if (e.state === 'done') {
      rememberModel({ ...d.model, path: `${modelsDir}/${d.model.file}`, added_at: new Date().toISOString() });
      downloads.delete(e.id);
    }
    if (e.state === 'cancelled') downloads.delete(e.id);
    listeners.forEach((fn) => fn());
  });
}
let modelsDir = '';
export async function initStore() {
  if (!llama) return;
  const info = await llama.info();
  modelsDir = info.modelsDir;
  subscribe();
  await reconcileModels();
  return info;
}
export async function startDownload(model: Omit<LocalModel, 'path' | 'added_at'>) {
  if (!llama) throw new Error('nonative');
  if (!modelsDir) await initStore();
  const d: Download = { id: model.id, got: 0, total: model.size, state: 'running', error: null, model };
  downloads.set(model.id, d);
  listeners.forEach((fn) => fn());
  await llama.download(model.id, model.url, model.file, model.sha256, model.size);
}
export async function cancelDownload(id: string) {
  await llama?.cancelDownload(id);
  const d = downloads.get(id);
  if (d) { d.state = 'cancelled'; downloads.delete(id); listeners.forEach((fn) => fn()); }
}
export function retryDownload(id: string) {
  const d = downloads.get(id);
  if (d) return startDownload(d.model);
  const c = CATALOG.find((m) => m.id === id);
  if (c) return startDownload(describe(c));
  return Promise.resolve();
}

// ---- settings --------------------------------------------------------------------------
// relayUrl: the relay "share far away" registers with and "add by code" reaches; empty until set (docs/RELAY.md)
const DEFAULTS: Settings = { modelId: null, ctx: 2048, temperature: 0.7, maxTokens: 512, lastMode: 'alone', relayUrl: '' };
export const settings = () => ({ ...DEFAULTS, ...read<Partial<Settings>>(SETTINGS, {}) });
export const useSettings = () => useStore(settings);
export const saveSettings = (patch: Partial<Settings>) => write(SETTINGS, { ...settings(), ...patch });

// ---- peers -----------------------------------------------------------------------------
export const peers = () => read<Peer[]>(PEERS, []);
export const usePeers = () => useStore(peers);
export function rememberPeer(p: Peer) {
  write(PEERS, [p, ...peers().filter((x) => x.id !== p.id)].slice(0, 8));
}
export const forgetPeer = (id: string) => write(PEERS, peers().filter((x) => x.id !== id));
export const touchPeer = (id: string, patch: Partial<Peer>) => write(PEERS, peers().map((p) => (p.id === id ? { ...p, ...patch } : p)));

// ---- this phone as a worker ---------------------------------------------------------------
export type Share = { secret: string; name: string; port: number; relay?: string | null };
export const share = () => read<Share | null>(SHARE, null);
export const saveShare = (s: Share | null) => write(SHARE, s);
export const useShare = () => useStore(share);
