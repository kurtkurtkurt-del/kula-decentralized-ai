import { useEffect, useState } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { CATALOG, modelUrl, type CatalogModel } from '@/llm/catalog';
import { llama, type DownloadEvent } from '@/llm/native';
import { factsFromMeta } from '@/llm/fit';
import { tapDone, tapFail } from '@/lib/haptics';
import { rate } from '@/llm/progress';

// What this phone keeps about models and peers (kv-store, never sent): the models on disk,
// the downloads in flight, the chosen model and its settings, and the peers paired by qr.
// Files live in the app's own files/models (the native module owns the bytes). A split
// model (hf "-00001-of-0000n") is one record with `parts`; `file`/`path`/`sha256` are the
// first part's (llama.cpp finds the rest next to it) and `size` is the sum.
export type ModelSource = 'catalog' | 'hf';
export type ModelPart = { file: string; size: number; sha256: string | null };
export type LocalModel = {
  id: string;            // catalog id, or "hf:<repo>/<file>"
  name: string;
  file: string;
  path: string;
  size: number;
  sha256: string | null;
  parts?: ModelPart[];   // absent or length 1 for a single file
  layers?: number;       // from the gguf header, once read
  arch?: string;
  meta_read?: boolean;
  params_b: number;
  active_b?: number;     // mixture of experts: the parameters one token uses (catalog, or "A3B" in the name)
  read_share?: number;   // mixture of experts: the bytes one token reads ÷ the file (catalog, measured)
  quant: string;
  kv_mb_per_1k: number;
  ctx_max: number;
  license: string | null;
  source: ModelSource;
  url: string;
  added_at: string;
};
export type ModelDraft = Omit<LocalModel, 'path' | 'added_at'>;
export type Download = { id: string; got: number; total: number; state: DownloadEvent['state'] | 'paused'; error: string | null; model: ModelDraft; part: number; parts: number; paused?: boolean; bps: number | null; at: number };

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
const HISTORY = 'llm.hfHistory'; // the last hugging face searches

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
export const partsOf = (m: { file: string; size: number; sha256: string | null; parts?: ModelPart[] }): ModelPart[] => (m.parts && m.parts.length ? m.parts : [{ file: m.file, size: m.size, sha256: m.sha256 }]);
export const partPath = (file: string) => `${modelsDir}/${file}`;
export function rememberModel(m: LocalModel) {
  write(MODELS, [m, ...localModels().filter((x) => x.id !== m.id)]);
}
export const patchModel = (id: string, patch: Partial<LocalModel>) => write(MODELS, localModels().map((m) => (m.id === id ? { ...m, ...patch } : m)));
/** Bytes the models on this phone take. */
export const usedBytes = () => localModels().reduce((a, m) => a + m.size, 0);

// the engine registers these so a loaded model is unloaded before its file goes (no import
// cycle: the engine already imports this file)
let beforeForget: (id: string) => Promise<void> = async () => {};
let runningId: () => string | null = () => null;
export function registerEngine(h: { beforeForget: (id: string) => Promise<void>; runningId: () => string | null }) {
  beforeForget = h.beforeForget;
  runningId = h.runningId;
}
export async function forgetModel(id: string) {
  const m = localById(id);
  await beforeForget(id).catch(() => {});
  if (m && llama) for (const p of partsOf(m)) await llama.deleteFile(m.path.replace(/[^/]+$/, p.file)).catch(() => {});
  write(MODELS, localModels().filter((x) => x.id !== id));
  const s = settings();
  if (s.modelId === id) saveSettings({ modelId: null });
}
/** The models neither chosen nor running: what "delete unused" would remove. */
export const unusedModels = () => localModels().filter((m) => m.id !== settings().modelId && m.id !== runningId());
export async function forgetUnused(): Promise<{ n: number; bytes: number }> {
  const list = unusedModels();
  for (const m of list) await forgetModel(m.id);
  return { n: list.length, bytes: list.reduce((a, m) => a + m.size, 0) };
}
/** Drops entries whose file is gone (uninstall-reinstall, a manual delete); a split model needs every part. */
export async function reconcileModels() {
  if (!llama) return;
  const files = await llama.listModels().catch(() => []);
  const names = new Set(files.filter((f) => !f.partial).map((f) => f.name));
  const kept = localModels().filter((m) => partsOf(m).every((p) => names.has(p.file)));
  if (kept.length !== localModels().length) write(MODELS, kept);
  // a download the app was killed in: its .part is still there; show it as interrupted so
  // "retry" continues it (the native side resumes with a Range request)
  for (const f of files.filter((x) => x.partial)) {
    const file = f.name.replace(/\.part$/, '');
    if (downloads.has(file) || dropping.has(file)) continue;
    const c = CATALOG.find((m) => m.file === file);
    const model = c ? describe(c) : null;
    if (!model || downloads.has(model.id) || dropping.has(model.id)) continue;
    downloads.set(model.id, { id: model.id, got: f.size, total: model.size, state: 'error', error: 'interrupted', model, part: 0, parts: 1, bps: null, at: Date.now() });
  }
  listeners.forEach((fn) => fn());
}
/** Reads the gguf header once and keeps the true layer / kv / ctx figures on the record. */
export async function readMeta(id: string): Promise<LocalModel | null> {
  const m = localById(id);
  if (!m || !llama || m.meta_read) return m;
  try {
    const facts = factsFromMeta(await llama.ggufMeta(m.path));
    const patch: Partial<LocalModel> = { meta_read: true };
    if (facts) {
      patch.layers = facts.layers;
      patch.kv_mb_per_1k = facts.kv_mb_per_1k;
      if (facts.ctx_max > 0) patch.ctx_max = facts.ctx_max;
      if (facts.arch) patch.arch = facts.arch;
      if (!m.license && facts.license) patch.license = facts.license;
    }
    patchModel(id, patch);
  } catch {}
  return localById(id);
}

export function describe(m: CatalogModel): ModelDraft {
  return { id: m.id, name: m.name, file: m.file, size: m.size, sha256: m.sha256, params_b: m.params_b, ...(m.active_b ? { active_b: m.active_b } : {}), ...(m.read_share ? { read_share: m.read_share } : {}), quant: m.quant, kv_mb_per_1k: m.kv_mb_per_1k, ctx_max: m.ctx_max, license: m.license, source: 'catalog', url: modelUrl(m) };
}

// ---- hugging face search history (last 5) -------------------------------------------------
export const hfHistory = () => read<string[]>(HISTORY, []);
export const useHfHistory = () => useStore(hfHistory);
export function rememberQuery(q: string) {
  const text = q.trim().toLowerCase();
  if (!text) return;
  write(HISTORY, [text, ...hfHistory().filter((x) => x !== text)].slice(0, 5));
}

// ---- downloads in flight (memory only; the native side keeps the .part file) ------------
// A split model is fetched part by part under native ids "<model id>#<n>"; the record is
// written only when the last part has passed its sha256.
const downloads = new Map<string, Download>();
let subscribed = false;
export const useDownloads = () => useStore(() => Array.from(downloads.values()));
export const downloadOf = (id: string) => downloads.get(id) ?? null;
const nativeId = (id: string, part: number, parts: number) => (parts > 1 ? `${id}#${part}` : id);
const modelIdOf = (nid: string) => nid.replace(/#\d+$/, '');
/** Bytes of a part's url: the same repo path, the part's own file name. */
const partUrl = (model: ModelDraft, p: ModelPart) => model.url.replace(/[^/]+$/, encodeURIComponent(p.file).replace(/%2F/g, '/'));
function subscribe() {
  if (subscribed || !llama) return;
  subscribed = true;
  llama.addListener('onDownload', (e) => {
    const d = downloads.get(modelIdOf(e.id));
    if (!d) return;
    const now = Date.now();
    const parts = partsOf(d.model);
    const before = parts.slice(0, d.part).reduce((a, p) => a + p.size, 0);
    const got = before + e.got;
    d.bps = e.state === 'running' ? rate(d.bps, got - d.got, now - d.at) : null;
    d.at = now;
    d.got = got;
    d.state = e.state;
    d.error = e.error;
    if (e.state === 'done') {
      if (d.part + 1 < parts.length) {
        d.part += 1;
        d.state = 'running';
        startPart(d).catch((err) => { d.state = 'error'; d.error = String((err as Error).message); listeners.forEach((fn) => fn()); });
      } else {
        rememberModel({ ...d.model, path: partPath(d.model.file), added_at: new Date().toISOString() });
        downloads.delete(d.id);
        tapDone();
      }
    }
    if (e.state === 'error') tapFail();
    // a pause is a cancel that keeps its row: the .part stays, "resume" asks for the rest
    if (e.state === 'cancelled') {
      if (d.paused) d.state = 'paused';
      else downloads.delete(d.id);
    }
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
function startPart(d: Download) {
  if (!llama) throw new Error('nonative');
  const parts = partsOf(d.model);
  const p = parts[d.part];
  return llama.download(nativeId(d.id, d.part, parts.length), parts.length > 1 ? partUrl(d.model, p) : d.model.url, p.file, p.sha256, p.size);
}
export async function startDownload(model: ModelDraft, fromPart = 0) {
  if (!llama) throw new Error('nonative');
  if (!modelsDir) await initStore();
  const parts = partsOf(model);
  const was = downloads.get(model.id);
  const got = parts.slice(0, fromPart).reduce((a, p) => a + p.size, 0);
  const d: Download = { id: model.id, got: Math.max(got, was?.got ?? 0), total: model.size, state: 'running', error: null, model, part: fromPart, parts: parts.length, paused: false, bps: null, at: Date.now() };
  downloads.set(model.id, d);
  listeners.forEach((fn) => fn());
  await startPart(d);
}
// Removing a download (6.11.2026, the bug a paused one showed: × did nothing on the phone).
// The native cancel keeps the .part so a pause can resume, and the models tab re-runs
// reconcileModels whenever the list of downloads changes; reconcile saw the .part and put the
// row straight back as "interrupted". And with the row removed only after the native cancel
// had answered, a rejected cancel (a paused download has no thread left) kept it on screen.
// Now: the row goes first (the screen updates at once), the id sits in `dropping` so a
// reconcile in between does not bring it back, then the native side is told, and every
// part's file and .part is deleted. Nothing here may throw: the user asked for it gone.
const dropping = new Set<string>();
export async function cancelDownload(id: string) {
  const d = downloads.get(id);
  const files = d ? partsOf(d.model).map((p) => p.file) : [CATALOG.find((m) => m.id === id)?.file].filter((f): f is string => !!f);
  dropping.add(id);
  files.forEach((f) => dropping.add(f));
  if (d) { d.state = 'cancelled'; d.paused = false; downloads.delete(id); }
  listeners.forEach((fn) => fn());
  try {
    await llama?.cancelDownload(d ? nativeId(id, d.part, d.parts) : id).catch(() => {});
    if (llama && modelsDir) {
      // a finished earlier part is the file itself; the part in flight is "<file>.part"
      for (const f of files) {
        await llama.deleteFile(partPath(f)).catch(() => {});
        await llama.deleteFile(`${partPath(f)}.part`).catch(() => {});
      }
    }
  } finally {
    dropping.delete(id);
    files.forEach((f) => dropping.delete(f));
  }
}
export async function pauseDownload(id: string) {
  const d = downloads.get(id);
  if (!d) return;
  d.paused = true;
  d.state = 'paused';
  listeners.forEach((fn) => fn());
  await llama?.cancelDownload(nativeId(id, d.part, d.parts));
}
export function retryDownload(id: string) {
  const d = downloads.get(id);
  if (d) return startDownload(d.model, d.part);
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

// ---- small ux flags (5.11.2026): the first-run ladder ----------------------------------
const UX = 'ux.flags';
export type UxFlags = { ran: boolean; stepsDone: boolean };
export const uxFlags = (): UxFlags => ({ ran: false, stepsDone: false, ...read<Partial<UxFlags>>(UX, {}) });
export const useUxFlags = () => useStore(uxFlags);
export const saveUxFlags = (patch: Partial<UxFlags>) => write(UX, { ...uxFlags(), ...patch });

// ---- this phone as a worker ---------------------------------------------------------------
export type Share = { secret: string; name: string; port: number; relay?: string | null };
export const share = () => read<Share | null>(SHARE, null);
export const saveShare = (s: Share | null) => write(SHARE, s);
export const useShare = () => useStore(share);
