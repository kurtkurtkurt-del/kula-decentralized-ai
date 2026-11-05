// Apart mode from the computer: every device runs the whole model by itself
// and prompts go to the fastest device that is free. Devices are this
// computer's own llama-server (optional) and each peer's api channel, reached
// through a local tunnel (gate client on 127.0.0.1). The wire is the worker
// api: POST /load (sse) once, then POST /chat (sse) per prompt.
import { Tunnel } from './gate.js';
import { probePeers, reachable, type Peer } from './peers.js';
import { freePort, startChild } from './children.js';
import type { LlamaBinaries } from './llama.js';

export interface Message { role: 'system' | 'user' | 'assistant'; content: string }

export interface Reply {
  text: string;
  tokens: number;
  ms: number;
  firstMs: number;
  tps: number;
  device: string;
}

export interface Device {
  id: string;
  name: string;
  local: boolean;
  apiPort: number;     // 127.0.0.1 port that speaks the worker api
  bw: number;          // GB/s, the order prompts are handed out in
  busy: boolean;
  tps: number | null;  // last measured
  done: number;        // replies so far
  close(): Promise<void>;
}

export interface ModelRef { url: string; sha256: string; size: number; name: string; ctx: number }

type Log = (s: string) => void;

// Reads an sse answer line by line, calling `onEvent` for every data object.
export async function readSse(res: Response, onEvent: (o: any) => void): Promise<void> {
  if (!res.ok && res.headers.get('content-type')?.includes('json')) {
    const o = await res.json().catch(() => ({ error: `http ${res.status}` }));
    throw new Error(o.error ?? `http ${res.status}`);
  }
  if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      try { onEvent(JSON.parse(line.slice(5).trim())); } catch {}
    }
  }
}

export async function apiLoad(apiPort: number, model: ModelRef, onProgress?: (state: string, got: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${apiPort}/load`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ url: model.url, sha256: model.sha256, size: model.size, name: model.name, ctx: model.ctx }),
  });
  let last: any = null;
  await readSse(res, (o) => {
    last = o;
    if (o.state && onProgress) onProgress(o.state, o.got ?? 0, o.total ?? 0);
    if (o.error) throw new Error(o.error);
  });
  if (!last) throw new Error('peer did not answer');
  if (last.error) throw new Error(last.error);
  if (!last.done) throw new Error('load ended without done');
}

export function apiChat(dev: Device, messages: Message[], onToken: (t: string) => void, opts: { maxTokens: number; temperature: number; reset?: boolean }): Promise<Reply> & { stop: () => void } {
  const ac = new AbortController();
  const p = (async (): Promise<Reply> => {
    const res = await fetch(`http://127.0.0.1:${dev.apiPort}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ messages, maxTokens: opts.maxTokens, temperature: opts.temperature, reset: !!opts.reset }),
    });
    let text = '';
    let last: any = null;
    let error: string | null = null;
    await readSse(res, (o) => {
      if (typeof o.t === 'string') { text += o.t; onToken(o.t); }
      if (o.error) error = o.error;
      if (o.done) last = o;
    });
    if (error) throw new Error(error);
    if (!last) throw new Error('peer gone');
    return { text, tokens: last.tokens ?? 0, ms: last.ms ?? 0, firstMs: last.firstMs ?? 0, tps: last.tps ?? 0, device: dev.name };
  })() as Promise<Reply> & { stop: () => void };
  p.stop = () => {
    fetch(`http://127.0.0.1:${dev.apiPort}/stop`, { method: 'POST' }).catch(() => {});
    ac.abort();
  };
  return p;
}

// A peer as a device: a tunnel to its api channel.
export async function openPeerDevice(peer: Peer): Promise<Device> {
  const tunnel = new Tunnel(peer.host, peer.port, peer.secret, 'api');
  const port = await tunnel.listen();
  return { id: peer.id, name: peer.name, local: false, apiPort: port, bw: peer.bw ?? 4, busy: false, tps: null, done: 0, close: () => tunnel.close() };
}

// This computer as a device: its own llama-server on 127.0.0.1 with the gguf,
// reached through the same tiny api so the scheduler sees one kind of thing.
// `startBackend` is what tests replace with a fake.
export async function openLocalDevice(opts: { llama: LlamaBinaries | null; modelFile: string; ctx: number; bw: number; log: Log; startBackend?: (file: string, ctx: number) => Promise<{ port: number; stop(): Promise<void> }> }): Promise<Device> {
  const { startApiServer } = await import('./api.js');
  const startBackend = opts.startBackend ?? (async (file: string, ctx: number) => {
    if (!opts.llama) throw new Error('llama.cpp is not set up here (run: kula-node setup), or pass --no-local to use the peers only');
    const port = await freePort();
    const child = await startChild('llama-server', opts.llama.llamaServer, ['--host', '127.0.0.1', '--port', String(port), '-m', file, '-c', String(ctx), '-ngl', '99', '--no-webui'], port, opts.log, 180000);
    const t0 = Date.now();
    for (;;) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {}
      if (child.proc.exitCode !== null) throw new Error('llama-server exited while loading');
      if (Date.now() - t0 > 600000) { await child.stop(); throw new Error('llama-server took too long to load the model'); }
      await new Promise((r) => setTimeout(r, 300));
    }
    return child;
  });
  // the local api keeps no copy: it is told the file it already has
  const path = await import('node:path');
  const api = await startApiServer({ models: path.dirname(opts.modelFile), llama: opts.llama, log: opts.log, startBackend, defaultCtx: opts.ctx });
  return { id: 'local', name: 'this computer', local: true, apiPort: api.port, bw: opts.bw, busy: false, tps: null, done: 0, close: () => api.close() };
}

export interface ApartOptions {
  model: ModelRef;        // what the peers fetch
  localModelFile?: string | null; // when set, this computer joins with its own llama-server
  localBw?: number;
  llama?: LlamaBinaries | null;
  peers: Peer[];
  probeMs?: number;
  log?: Log;
  startBackend?: (file: string, ctx: number) => Promise<{ port: number; stop(): Promise<void> }>;
  probe?: typeof probePeers;
}

export interface Cluster {
  devices: Device[];
  skipped: { peer: Peer; why: string }[];
  chat(messages: Message[], onToken: (t: string) => void, opts?: { maxTokens?: number; temperature?: number; reset?: boolean; device?: string }): Promise<Reply>;
  batch(prompts: string[], opts?: { maxTokens?: number; temperature?: number; onReply?: (i: number, r: Reply) => void }): Promise<Reply[]>;
  close(): Promise<void>;
}

// Probes, tunnels, loads the model everywhere (in parallel), returns the
// scheduler. A peer that fails to load is dropped, not fatal, as long as one
// device is left.
export async function openApart(opts: ApartOptions): Promise<Cluster> {
  const log = opts.log ?? (() => {});
  const probed = await (opts.probe ?? probePeers)(opts.peers, opts.probeMs ?? 2000, ['api']);
  const skipped: { peer: Peer; why: string }[] = [];
  const live: Peer[] = [];
  for (const r of probed) {
    if (r.api.ok || reachable(r.api)) live.push(r.peer);
    else { skipped.push({ peer: r.peer, why: (r.api as { reason: string }).reason }); log(`${r.peer.name}: skipped, ${(r.api as { reason: string }).reason}`); }
  }
  const devices: Device[] = [];
  if (opts.localModelFile) {
    const dev = await openLocalDevice({ llama: opts.llama ?? null, modelFile: opts.localModelFile, ctx: opts.model.ctx, bw: opts.localBw ?? 4, log, startBackend: opts.startBackend });
    devices.push(dev);
  }
  for (const p of live) {
    try { devices.push(await openPeerDevice(p)); } catch (e) { skipped.push({ peer: p, why: (e as Error).message }); }
  }
  if (!devices.length) throw new Error('no device: every peer was unreachable and this computer did not join');

  // load everywhere at once; the local api is told the file it already holds
  const pathMod = await import('node:path');
  const loads = devices.map(async (dev) => {
    const ref: ModelRef = dev.local && opts.localModelFile
      ? { ...opts.model, url: 'file://' + opts.localModelFile, name: pathMod.basename(opts.localModelFile) }
      : opts.model;
    let lastState = '';
    try {
      await apiLoad(dev.apiPort, ref, (state, got, total) => {
        if (state !== lastState) { lastState = state; log(`${dev.name}: ${state}${total ? ` (${(total / 1e6).toFixed(0)} MB)` : ''}`); }
      });
      log(`${dev.name}: ready`);
      return true;
    } catch (e) {
      log(`${dev.name}: load failed, ${(e as Error).message}`);
      return false;
    }
  });
  const ok = await Promise.all(loads);
  const ready = devices.filter((_, i) => ok[i]);
  for (const [i, dev] of devices.entries()) if (!ok[i]) { await dev.close().catch(() => {}); if (!dev.local) skipped.push({ peer: opts.peers.find((p) => p.id === dev.id)!, why: 'load failed' }); }
  if (!ready.length) throw new Error('no device loaded the model');

  // the scheduler: a queue of waiters; the fastest free device (by measured
  // tok/s once known, by advertised bandwidth before) takes the next prompt
  const waiters: (() => void)[] = [];
  const pick = (name?: string): Device | null => {
    const free = ready.filter((d) => !d.busy && (!name || d.name === name || d.id === name));
    if (!free.length) return null;
    return free.sort((a, b) => (b.tps ?? b.bw * 1000) - (a.tps ?? a.bw * 1000))[0];
  };
  const acquire = async (name?: string): Promise<Device> => {
    for (;;) {
      const d = pick(name);
      if (d) { d.busy = true; return d; }
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const release = (d: Device) => { d.busy = false; const w = waiters.shift(); w?.(); };

  const chat: Cluster['chat'] = async (messages, onToken, o = {}) => {
    const dev = await acquire(o.device);
    try {
      const r = await apiChat(dev, messages, onToken, { maxTokens: o.maxTokens ?? 256, temperature: o.temperature ?? 0.7, reset: o.reset });
      if (r.tps) dev.tps = r.tps;
      dev.done++;
      return r;
    } finally { release(dev); }
  };
  const batch: Cluster['batch'] = async (prompts, o = {}) => {
    const out: Reply[] = new Array(prompts.length);
    await Promise.all(prompts.map(async (p, i) => {
      out[i] = await chat([{ role: 'user', content: p }], () => {}, { maxTokens: o.maxTokens, temperature: o.temperature, reset: true });
      o.onReply?.(i, out[i]);
    }));
    return out;
  };
  return {
    devices: ready,
    skipped,
    chat,
    batch,
    close: async () => { for (const d of ready) await d.close().catch(() => {}); },
  };
}

// Per device: how many prompts, mean tok/s. For the --batch report.
export function batchReport(replies: Reply[]): { device: string; prompts: number; tokens: number; tps: number }[] {
  const by = new Map<string, { prompts: number; tokens: number; genMs: number }>();
  for (const r of replies) {
    const row = by.get(r.device) ?? { prompts: 0, tokens: 0, genMs: 0 };
    row.prompts++;
    row.tokens += r.tokens;
    row.genMs += Math.max(1, r.ms - r.firstMs);
    by.set(r.device, row);
  }
  return [...by].map(([device, r]) => ({ device, prompts: r.prompts, tokens: r.tokens, tps: Math.round((r.tokens / r.genMs) * 1000 * 10) / 10 })).sort((a, b) => b.tps - a.tps);
}
