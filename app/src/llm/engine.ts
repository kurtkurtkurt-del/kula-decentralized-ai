import { useEffect, useState } from 'react';
import { lastPassport } from '@/data/passport';
import { native, type LoadResult, type Message } from '@/llm/native';
import { modelKey, peerArgs, peerRelay, peerTls, planSplit, probeAll, splitSummary, type Plan } from '@/llm/cluster';
import { measuredFor } from '@/bench/store';
import { type LocalModel, type Mode, type Peer, mmprojPath, registerEngine, saveSettings, saveUxFlags } from '@/llm/store';
import { assign, estimateAlone, pickDevice } from '@/llm/sim/model';
import { localFromPassport, modelProfile, workerFromPeer } from '@/llm/sim/profiles';
import { note, planEntries } from '@/llm/brainlog';

// The engine: one model loaded at a time, in one of three ways. `alone` and `split` run
// in this process (split: the layers this phone does not hold sit on tunnelled peers).
// `apart` keeps a copy on each device: this phone's own in-process model plus every peer's
// over its api channel; a chat goes to one device, a batch to all of them at once.
// Screens subscribe with useEngine(); everything else is plain async functions.
// A device in apart mode carries what the dispatcher (sim/model.ts pickDevice) needs: its
// decoding speed (estimated until the first reply measures it) and when its queue ends.
// `done`: how many real answers measured that speed (0: tps is still the bench or the estimate).
// `heardAt`: when the engine last heard the device (its probe and load, an answer, or the
// request it dropped); god's eye reads it as the device's checkedAt (eye/snapshot.ts).
export type Device = { id: string; name: string; local: boolean; busy: boolean; apiPort?: number; peer?: Peer; tps: number; busyUntil: number; out?: boolean; done: number; heardAt: number };
export type EngineState = {
  model: LocalModel | null;
  mode: Mode;
  loading: string | null; // what it is doing, or null
  error: string | null;
  load: LoadResult | null;
  plan: Plan | null;
  split: { name: string; gb: number }[];
  devices: Device[];
  generating: boolean;
  vision?: boolean; // the loaded model's mmproj is loaded too: this phone can show it photos (loadVision)
};
const state: EngineState = { model: null, mode: 'alone', loading: null, error: null, load: null, plan: null, split: [], devices: [], generating: false, vision: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const set = (patch: Partial<EngineState>) => {
  Object.assign(state, patch);
  emit();
};
export const engine = () => state;
export function useEngine(): EngineState {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return state;
}

const thisName = () => lastPassport()?.device ?? 'this phone';
// a bench on this model (bench/store.ts) wins over the estimate until the first reply measures it
const me = (model: LocalModel, freeMb: number): Device => ({ id: 'me', name: thisName(), local: true, busy: false, tps: measuredFor('self', modelKey(model)) ?? estimateAlone(modelProfile(model), localFromPassport(lastPassport(), freeMb)).tps, busyUntil: 0, done: 0, heardAt: Date.now() });
// built right after the peer answered its probe and loaded the model: heard now
const ofPeer = (model: LocalModel, p: Peer, apiPort: number): Device => ({ id: p.id, name: p.name, local: false, busy: false, apiPort, peer: p, tps: measuredFor(p.id, modelKey(model)) ?? estimateAlone(modelProfile(model), workerFromPeer(p)).tps, busyUntil: 0, done: 0, heardAt: Date.now() });
export const OUT_MS = 5 * 60 * 1000; // a device that dropped a request sits out this long

/** Loads a model in a mode. `share` answers "keep it here or share" when it fits alone. */
export async function load(model: LocalModel, mode: Mode, ctx: number, peers: Peer[], share = false): Promise<void> {
  const llama = native();
  const t0 = Date.now();
  set({ loading: 'preparing', error: null, model, mode, plan: null, load: null, split: [], devices: [], vision: false });
  try {
    const info = await llama.info();
    const bw = Number(lastPassport()?.mem_bw_read_gbs) || Number(lastPassport()?.mem_bw_gbs) || 0;
    if (mode === 'split') {
      set({ loading: 'probing' });
      const plan = await planSplit(model, info.ramFreeMb, bw, peers, share, ctx);
      set({ plan, loading: 'loading' });
      const res = await llama.loadModel(model.path, ctx, 0, peerArgs(plan), plan.localMb);
      const names = new Map<string, string>(); // tunnels hide the real hosts; map by order
      // RPC buffers are named by the 127.0.0.1:<port> the tunnel listened on; the native side
      // adds them in the order given, so pair them with plan.used by index.
      const rpc = res.split.filter((s) => /^RPC\d+\[/.test(s.buffer)).map((s) => s.buffer.match(/\[([^\]]+)\]/)![1]);
      Array.from(new Set(rpc)).forEach((ep, i) => names.set(ep, plan.used[i]?.name ?? ep));
      set({ load: res, split: splitSummary(res.split, names, thisName()), devices: [me(model, info.ramFreeMb)], loading: null });
    } else if (mode === 'apart') {
      set({ loading: 'probing' });
      const { ok, bad } = await probeAll(peers, 'api');
      const devices: Device[] = [me(model, info.ramFreeMb)];
      set({ loading: 'loading' });
      const res = await llama.loadModel(model.path, ctx, 0, [], 1);
      // every peer loads the same file (its own download when missing), in parallel
      await Promise.all(ok.map(async (p) => {
        try {
          const port = await llama.apiTunnel(p.host, p.port, p.secret, peerTls(p), peerRelay(p));
          set({ loading: `loading on ${p.name}` });
          await apiLoad(port, model, ctx);
          devices.push(ofPeer(model, p, port));
        } catch (e) {
          bad.push({ peer: p, why: (e as Error).message });
        }
      }));
      set({ load: res, devices, plan: { mode: 'apart', used: [], skipped: bad, localMb: 0, fitsAlone: true, totalMb: 0, needMb: 0 }, split: [{ name: thisName(), gb: Math.round(model.size / 1024 ** 3 * 10) / 10 }], loading: null });
    } else {
      set({ loading: 'loading' });
      const res = await llama.loadModel(model.path, ctx, 0, [], 1);
      set({ load: res, split: [{ name: thisName(), gb: Math.round(model.size / 1024 ** 3 * 10) / 10 }], devices: [me(model, info.ramFreeMb)], loading: null });
    }
    saveSettings({ modelId: model.id, ctx, lastMode: mode });
    saveUxFlags({ ran: true }); // the ladder's third rung, for good
    // the brain tab: what was planned and why, then that it stands
    note([
      ...planEntries(Date.now(), model.name, mode, state.plan, state.devices, thisName()),
      { at: Date.now(), kind: 'load', key: 'brain.load.done', vars: { model: model.name, mode, s: Math.round((Date.now() - t0) / 100) / 10 }, tone: 'ok' },
    ]);
  } catch (e) {
    const why = (e as Error).message;
    note([
      ...(state.plan ? planEntries(Date.now(), model.name, mode, state.plan, [], thisName()) : []),
      { at: Date.now(), kind: 'error', key: why === 'toobig' ? 'brain.load.toobig' : why === 'local' ? 'brain.load.local' : 'brain.load.failed', vars: { model: model.name }, detail: why === 'toobig' || why === 'local' ? undefined : why, tone: 'bad' },
    ]);
    set({ loading: null, error: (e as Error).message, model: null, load: null });
    await llama.unload().catch(() => {});
    throw e;
  }
}

export async function unload() {
  await native().unload().catch(() => {});
  set({ model: null, load: null, plan: null, split: [], devices: [], error: null, vision: false });
}

/**
 * After load: the loaded vision model's mmproj on this phone (10.11.2026, photos in night
 * projects). Only this phone sees the photos; in apart mode the peers keep the text side.
 * Throws 'novision' for a text model, or the native reason; the model stays loaded either way.
 */
export async function loadVision(): Promise<void> {
  const m = state.model;
  const path = m ? mmprojPath(m) : null;
  if (!m || !path) throw new Error('novision');
  if (state.vision) return;
  try {
    await native().loadMmproj(path, 0);
    set({ vision: true });
    note({ at: Date.now(), kind: 'load', key: 'brain.vision.on', vars: { model: m.name }, tone: 'ok' });
  } catch (e) {
    set({ vision: false });
    note({ at: Date.now(), kind: 'error', key: 'brain.vision.failed', vars: { model: m.name }, detail: (e as Error).message, tone: 'bad' });
    throw e;
  }
}
// a model's file is deleted only after it is out of memory
registerEngine({ beforeForget: async (id) => { if (state.model?.id === id) await unload(); }, runningId: () => state.model?.id ?? null });

// ---- generation -----------------------------------------------------------------------
export type Reply = { tokens: number; ms: number; firstMs: number; tps: number; stopped: boolean; device: string; images?: number };
/** Photos with a request: file uris and the long side they are scaled to (only this phone sees them). */
export type Photos = { uris: string[]; maxSide: number };

/** Streams a reply on this phone; resolves with the stats. */
export function chatLocal(messages: Message[], onToken: (t: string) => void, opts: { maxTokens: number; temperature: number; reset?: boolean; images?: Photos }): Promise<Reply> & { stop: () => void } {
  const llama = native();
  let id = -1;
  const p = new Promise<Reply>((resolve, reject) => {
    const subs = [
      llama.addListener('onToken', (e) => {
        if (e.id === id) onToken(e.text);
      }),
      llama.addListener('onDone', (e) => {
        if (e.id !== id) return;
        subs.forEach((s) => s.remove());
        set({ generating: false });
        // reject, not throw: a throw inside the listener never reached the caller and the
        // promise stayed open for good (the night's loop on this phone would hang on it)
        if (e.error) return reject(new Error(e.error));
        resolve({ tokens: e.tokens, ms: e.ms, firstMs: e.firstMs, tps: e.tps, stopped: e.stopped, device: thisName(), ...(e.images !== undefined ? { images: e.images } : {}) });
      }),
    ];
    set({ generating: true });
    const photos = opts.images && opts.images.uris.length && state.vision ? opts.images : null;
    id = photos
      ? llama.generateWithImages(messages, photos.uris, photos.maxSide, opts.maxTokens, opts.temperature, 0.95)
      : llama.generate(messages, opts.maxTokens, opts.temperature, 0.95, !!opts.reset);
  }) as Promise<Reply> & { stop: () => void };
  p.stop = () => llama.stop();
  return p;
}

/** Streams a reply from a peer over its api tunnel (SSE over fetch; XHR fallback for RN). */
export function chatRemote(dev: Device, messages: Message[], onToken: (t: string) => void, opts: { maxTokens: number; temperature: number; reset?: boolean }): Promise<Reply> & { stop: () => void } {
  const xhr = new XMLHttpRequest();
  const p = new Promise<Reply>((resolve, reject) => {
    let seen = 0;
    let last: Reply | null = null;
    xhr.open('POST', `http://127.0.0.1:${dev.apiPort}/chat`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 3) {
        const text = xhr.responseText.slice(seen);
        // no early return: the last bytes usually arrive in a readyState 3 event, and the
        // readyState 4 that follows must still reach the resolve below
        const cut = text.lastIndexOf('\n\n');
        if (cut >= 0) seen += cut + 2;
        for (const line of cut >= 0 ? text.slice(0, cut).split('\n') : []) {
          if (!line.startsWith('data: ')) continue;
          try {
            const o = JSON.parse(line.slice(6));
            if (o.t) onToken(o.t);
            if (o.error) reject(new Error(o.error));
            if (o.done) last = { tokens: o.tokens, ms: o.ms, firstMs: o.firstMs, tps: o.tps, stopped: false, device: dev.name };
          } catch {}
        }
      }
      if (xhr.readyState === 4) {
        if (last) resolve(last);
        else reject(new Error(xhr.status ? `peer http ${xhr.status}` : 'peer gone'));
      }
    };
    xhr.onerror = () => reject(new Error('peer gone'));
    xhr.send(JSON.stringify({ messages, maxTokens: opts.maxTokens, temperature: opts.temperature, reset: !!opts.reset }));
  }) as Promise<Reply> & { stop: () => void };
  p.stop = () => {
    fetch(`http://127.0.0.1:${dev.apiPort}/stop`, { method: 'POST' }).catch(() => {});
    xhr.abort();
  };
  return p;
}

/**
 * Picks the device expected to finish first (its queue, the prompt, the answer) and
 * streams from it. A peer that drops the request before its first token sits out for
 * OUT_MS and the request goes to the next device, once. A measured reply refines the
 * device's speed for the next pick.
 */
// With photos (opts.images, and the mmproj loaded) the request goes to this phone: peers have no mmproj.
export function chat(messages: Message[], onToken: (t: string) => void, opts: { maxTokens: number; temperature: number; reset?: boolean; device?: string; now?: () => number; images?: Photos }) {
  if (opts.images?.uris.length && state.vision) opts = { ...opts, device: state.devices.find((d) => d.local)?.id ?? opts.device };
  const now = opts.now ?? Date.now;
  const req = { promptTokens: Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4), maxTokens: opts.maxTokens };
  const pick = (except: string | null): Device | null => {
    const t = now();
    for (const d of state.devices) if (d.out && d.busyUntil <= t) d.out = false;
    const forced = opts.device && !except ? state.devices.find((d) => d.id === opts.device && !d.out) : null;
    return forced ?? pickDevice(state.devices.filter((d) => d.id !== except), req, t) ?? null;
  };
  let sawToken = false;
  const start = (dev: Device) => {
    dev.busy = true;
    assign(dev, req, now());
    emit();
    const tok = (t: string) => {
      sawToken = true;
      onToken(t);
    };
    const inner = dev.local ? chatLocal(messages, tok, opts) : chatRemote(dev, messages, tok, opts);
    const p = inner.finally(() => {
      dev.busy = false;
      dev.busyUntil = Math.min(dev.busyUntil, now());
      emit();
    }) as Promise<Reply> & { stop: () => void };
    p.stop = inner.stop;
    return p;
  };
  const first = pick(null);
  if (!first) throw new Error('nomodel');
  let current = first;
  // the brain tab: which device the dispatcher chose, when it had a choice (the night names
  // its device itself and says so in its own lines)
  if (!opts.device && state.devices.length > 1) note({ at: now(), kind: 'dispatch', key: 'brain.dispatch', vars: { device: first.name.toLowerCase(), tps: Math.round(first.tps * 10) / 10, n: state.devices.filter((d) => !d.out).length }, tone: 'info' });
  let run = start(current);
  const measured = (r: Reply) => {
    current.heardAt = now();
    if (r.tps > 0) {
      current.tps = Math.round(r.tps * 10) / 10;
      current.done += 1;
    }
    return r;
  };
  const done = run.then(measured, (e: Error) => {
    if (current.local || sawToken) throw e;
    // the peer dropped the request before a token: out for a while, the request moves on
    current.out = true;
    current.heardAt = now(); // the drop is news too: the eye sees it as a fresh 'no'
    current.busyUntil = now() + OUT_MS;
    emit();
    const next = pick(current.id);
    note({ at: now(), kind: 'retry', key: next ? 'brain.retry' : 'brain.retry.none', vars: { from: current.name.toLowerCase(), to: next?.name.toLowerCase() ?? '', min: Math.round(OUT_MS / 60000) }, detail: e.message, tone: 'warn' });
    if (!next) throw e;
    current = next;
    run = start(current);
    return run.then(measured);
  }) as Promise<Reply> & { stop: () => void };
  done.stop = () => run.stop();
  return done;
}

async function apiLoad(port: number, model: LocalModel, ctx: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/load`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: model.url, sha256: model.sha256, size: model.size, name: model.file, ctx }) });
  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  const last = lines[lines.length - 1];
  if (!last || last.error) throw new Error(last?.error ?? 'peer did not answer');
}
