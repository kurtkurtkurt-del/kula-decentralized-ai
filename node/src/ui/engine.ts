// What the chat page drives: the peer book, the models on offer, and the one model that is
// loaded somewhere at a time. Four ways to run it:
//   phone  one paired phone runs the model; this computer only relays the chat. The phone is
//          told the model's public Hugging Face url and fetches it itself (sha256-checked), so
//          the worker's rule against private urls never bites.
//   apart  several devices, each with its own copy; a prompt goes to the fastest free one.
//   split  the model on this computer's llama-server, layers spread over phones by --rpc.
//   here   this computer's llama-server alone.
// Every mode ends up as an apart `Cluster` (apart.ts): the same chat, stop and busy flags.
// Nothing here hands out a secret: peers leave through `peerRow`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openApart, type Cluster, type Message, type ModelRef, type Reply } from '../apart.js';
import { readPeers, writePeers, parsePeerText, upsertPeer, removePeer, findPeer, probePeers, peersFile, whereIs, type Peer, type PeerProbe } from '../peers.js';
import { connectRemote, handshake, GateRefused } from '../gate.js';
import { loadOrCreateIdentity, type GateIdentity } from '../tls.js';
import { loadOrCreate as loadDeviceKey } from '../audit/key.js';
import { home, repoRoots } from '../paths.js';
import { findLlama, sha256File, type LlamaBinaries } from '../llama.js';
import { download, sha256Of } from '../download.js';
import { prepareSplit, startSplitServer } from '../split.js';
import { TooBig } from '../planner.js';
import { simModelOf } from '../gguf.js';
import { freeRamMB, measureBandwidth } from '../sysinfo.js';
import { UI_CATALOG, modelUrl, type UiModel } from './catalog.js';

export type Mode = 'phone' | 'apart' | 'split' | 'here';
export const MODES: Mode[] = ['phone', 'apart', 'split', 'here'];
const MB = 1024 * 1024;

export interface Reach { ok: boolean; ms?: number; reason?: string }
export interface PeerRow {
  id: string; name: string; kind: string; where: string; far: boolean; tls: boolean; waitingPair: boolean;
  ram: number | null; bw: number | null; gpu: string | null; last_ok: string | null;
  reach: Reach | null; probedAt: number | null;
}

export interface ModelRow {
  id: string;                 // a catalog id, or "local:<file name>"
  name: string;
  file: string;
  size: number;
  quant: string | null;
  params_b: number | null;
  blurb: string;
  catalog: boolean;           // phones can fetch it (public url + sha256)
  here: boolean;              // the file is on this computer
  needMb: number;             // about what running it whole takes at ctx 4096
}

export interface DeviceRow { id: string; name: string; local: boolean; busy: boolean; tps: number | null; done: number }
export interface Loaded { mode: Mode; model: { id: string; name: string; file: string; size: number }; ctx: number; devices: DeviceRow[]; since: number }
export interface Status {
  loaded: Loaded | null;
  loading: { mode: Mode; model: string; since: number; line: string } | null;
  chatting: number;
  plan: string[];                              // why the model sits where it sits, in plain words
  decisions: { at: number; text: string }[];   // the last things that happened, newest last
  llama: boolean;                              // llama-server is here (split and here need it)
}

export type LoadEvent =
  | { phase: string; device?: string; got?: number; total?: number; line: string }
  | { done: true; status: Status };

// The catalog entry with an optional url instead of Hugging Face (tests serve files locally).
export type CatalogEntry = UiModel & { url?: string };

export interface EngineOptions {
  peersFile?: string;
  catalog?: CatalogEntry[];
  modelDirs?: string[];                  // where local .gguf files are looked for; the first is where downloads go
  llama?: LlamaBinaries | null | (() => LlamaBinaries | null);
  identity?: GateIdentity;
  probeMs?: number;
  log?: (s: string) => void;
  // tests: a fake llama-server for 'here'
  startBackend?: (file: string, ctx: number) => Promise<{ port: number; stop(): Promise<void> }>;
  bandwidth?: () => Promise<number>;
}

// What a model takes in memory, run whole: the file, the kv cache for ctx, some slack.
export function needMb(size: number, kvMbPer1k: number, ctx: number): number {
  return Math.round((size / MB) * 1.05 + (kvMbPer1k * ctx) / 1024 + 300);
}

export const PRIVATE_URL_NOTE = 'phones only fetch models from the public internet (a huggingface url with a sha256); a file that is only on this computer cannot reach them. pick a model from the list, or use "here" or "split" for this file.';

export function defaultModelDirs(): string[] {
  const dirs = [path.join(home(), 'models')];
  for (const r of repoRoots()) dirs.push(path.join(r, '.llama', 'models'));
  return [...new Set(dirs)];
}

export function peerRow(p: Peer, probe?: Reach | null, probedAt: number | null = null): PeerRow {
  return {
    id: p.id, name: p.name, kind: p.kind, where: whereIs(p), far: !!p.relay, tls: !!p.fp, waitingPair: !p.fp && !!p.pin,
    ram: p.ram ?? null, bw: p.bw ?? null, gpu: p.gpu ?? null, last_ok: p.last_ok ?? null,
    reach: probe ?? null, probedAt,
  };
}

const HOST_PORT = /^(\[[^\]]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/;

export class Engine {
  private cluster: Cluster | null = null;
  private loaded: Loaded | null = null;
  private loading: Status['loading'] = null;
  private loadAbort: AbortController | null = null;
  private plan: string[] = [];
  private decisions: { at: number; text: string }[] = [];
  private reach = new Map<string, { r: Reach; at: number }>();
  private chats = new Set<AbortController>();
  private extraClose: (() => Promise<void>)[] = [];
  private ident: GateIdentity | null;
  readonly catalog: CatalogEntry[];

  constructor(private readonly opts: EngineOptions = {}) {
    this.catalog = opts.catalog ?? UI_CATALOG;
    this.ident = opts.identity ?? null;
  }

  private log(s: string) { this.opts.log?.(s); }
  private note(text: string) {
    this.decisions.push({ at: Date.now(), text });
    if (this.decisions.length > 60) this.decisions.splice(0, this.decisions.length - 60);
    this.log(text);
  }
  private identity(): GateIdentity {
    if (!this.ident) this.ident = loadOrCreateIdentity(home(), loadDeviceKey());
    return this.ident;
  }
  private llama(): LlamaBinaries | null {
    const l = this.opts.llama;
    if (typeof l === 'function') return l();
    return l === undefined ? findLlama() : l;
  }
  private file(): string { return this.opts.peersFile ?? peersFile(); }
  private dirs(): string[] { return this.opts.modelDirs ?? defaultModelDirs(); }

  // ---- peers

  peers(): PeerRow[] {
    return readPeers(this.file()).map((p) => { const x = this.reach.get(p.id); return peerRow(p, x?.r ?? null, x?.at ?? null); });
  }

  private stamp(stamped: Peer[]) {
    if (!stamped.length) return;
    const file = this.file();
    writePeers(readPeers(file).map((p) => stamped.find((s) => s.id === p.id) ?? p), file);
  }

  // The api channel of every peer (or the ones named), 2 s each; a v3 peer pairs here.
  async probe(ids?: string[]): Promise<PeerRow[]> {
    const all = readPeers(this.file());
    const wanted = ids?.length ? all.filter((p) => ids.includes(p.id)) : all;
    if (wanted.length) {
      const results: PeerProbe[] = await probePeers(wanted, this.opts.probeMs ?? 2000, ['api'], undefined, this.identity());
      const at = Date.now();
      for (const r of results) this.reach.set(r.peer.id, { r: r.api as Reach, at });
      this.stamp(results.map((r) => r.peer));
    }
    return this.peers();
  }

  // The qr json, its base64url code, host:port:secret, or a relay code (+ pin): parsed by the
  // same code as `kula-node peers add`, then probed once so a v3 peer pairs right away.
  async addPeer(text: string, opts: { name?: string; relay?: string } = {}): Promise<PeerRow> {
    const peer = parsePeerText(text, opts.relay || process.env.KULA_RELAY || undefined);
    if (opts.name?.trim()) peer.name = opts.name.trim().slice(0, 60);
    const file = this.file();
    const { list, added } = upsertPeer(readPeers(file), peer);
    writePeers(list, file);
    this.note(`${added ? 'added' : 'updated'} ${peer.name} (${whereIs(peer)})`);
    await this.probe([peer.id]).catch(() => {});
    return this.peers().find((p) => p.id === peer.id)!;
  }

  // What a phone's share screen prints under its qr: the address (192.168.1.20:50551) and the
  // one-time code; optionally the start of the certificate. One tls handshake with the code
  // learns the certificate (the code's proof covers both certificates, so a device in the
  // middle fails it), the start shown on the phone must match, and the peer is kept paired.
  async pairByHand(input: { address: string; pin: string; fp?: string; name?: string }): Promise<PeerRow> {
    const m = HOST_PORT.exec(String(input.address ?? '').trim());
    if (!m) throw new Error('address must look like 192.168.1.20:50551');
    const host = m[1].replace(/^\[|\]$/g, '');
    const port = Number(m[2]);
    if (port < 1 || port > 65535) throw new Error('bad port');
    const pin = String(input.pin ?? '').replace(/[\s-]/g, '').toLowerCase();
    if (!/^[0-9a-f]{8,64}$/.test(pin)) throw new Error('the code is the 16 letters and digits after "code" on the phone');
    const fpStart = String(input.fp ?? '').replace(/[\s-]/g, '').toLowerCase();
    if (fpStart && !/^[0-9a-f]{4,64}$/.test(fpStart)) throw new Error('the certificate is hex (0-9, a-f)');
    let fp: string | null = null;
    const socket = await connectRemote(host, port, 4000).catch((e) => { throw new Error(`cannot reach ${host}:${port}: ${(e as Error).message}`); });
    try {
      const h = await handshake(socket, '', 'api', 6000, undefined, { identity: this.identity(), fp: '', pin });
      fp = h.fp;
      h.socket.destroy();
    } catch (e) {
      throw new Error(e instanceof GateRefused ? `the phone said no: ${e.reason}` : (e as Error).message);
    } finally { socket.destroy(); }
    if (!fp) throw new Error('the phone did not show a certificate');
    if (fpStart && !fp.startsWith(fpStart)) throw new Error('the certificate does not match what the phone shows: not pairing');
    const now = new Date().toISOString();
    const peer: Peer = {
      id: `${host}:${port}`, name: input.name?.trim().slice(0, 60) || `phone ${host}`, host, port, secret: '', fp, pin: null, paired_at: now,
      relay: null, kind: 'phone', ram: null, bw: null, gpu: null, vram: null, passport: null, added_at: now, last_ok: now,
    };
    const file = this.file();
    const { list } = upsertPeer(readPeers(file), peer);
    writePeers(list, file);
    this.reach.set(peer.id, { r: { ok: true }, at: Date.now() });
    this.note(`paired with ${peer.name} at ${host}:${port}`);
    return this.peers().find((p) => p.id === peer.id)!;
  }

  removePeer(id: string): boolean {
    const file = this.file();
    const { list, removed } = removePeer(readPeers(file), id);
    if (!removed) return false;
    writePeers(list, file);
    this.reach.delete(removed.id);
    this.note(`forgot ${removed.name}`);
    return true;
  }

  // ---- models

  private findLocal(name: string): string | null {
    for (const d of this.dirs()) {
      const f = path.join(d, name);
      try { if (fs.statSync(f).isFile()) return f; } catch {}
    }
    return null;
  }

  models(): ModelRow[] {
    const rows: ModelRow[] = this.catalog.map((m) => ({
      id: m.id, name: m.name, file: m.file, size: m.size, quant: m.quant, params_b: m.params_b, blurb: m.blurb,
      catalog: true, here: !!this.findLocal(m.file), needMb: needMb(m.size, m.kv_mb_per_1k, 4096),
    }));
    const seen = new Set(this.catalog.map((m) => m.file));
    for (const d of this.dirs()) {
      let names: string[] = [];
      try { names = fs.readdirSync(d).filter((f) => f.endsWith('.gguf')).sort(); } catch {}
      for (const n of names) {
        if (seen.has(n)) continue;
        seen.add(n);
        let size = 0;
        try { size = fs.statSync(path.join(d, n)).size; } catch { continue; }
        const quant = /(q\d_[a-z0-9_]+|q\d_\d|f16|bf16)/i.exec(n)?.[1]?.toUpperCase() ?? null;
        rows.push({ id: `local:${n}`, name: n.replace(/\.gguf$/, ''), file: n, size, quant, params_b: null, blurb: 'a file on this computer', catalog: false, here: true, needMb: needMb(size, 64, 4096) });
      }
    }
    return rows;
  }

  // ---- status

  status(): Status {
    if (this.loaded && this.cluster) this.loaded.devices = this.cluster.devices.map((d) => ({ id: d.id, name: d.name, local: d.local, busy: d.busy, tps: d.tps, done: d.done }));
    return {
      loaded: this.loaded ? structuredClone(this.loaded) : null,
      loading: this.loading ? { ...this.loading } : null,
      chatting: this.chats.size,
      plan: [...this.plan],
      decisions: this.decisions.slice(-30),
      llama: !!(this.opts.startBackend || this.llama()),
    };
  }

  // ---- load

  // A catalog model on this computer: found in a model folder, else downloaded (sha256-checked)
  // into the first one.
  private async ensureLocal(m: CatalogEntry, emit: (e: LoadEvent) => void, signal: AbortSignal): Promise<string> {
    const have = this.findLocal(m.file);
    if (have) return have;
    const dest = path.join(this.dirs()[0], m.file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const url = m.url ?? modelUrl(m);
    this.note(`this computer fetches ${m.file} (${Math.round(m.size / MB)} MB) from ${new URL(url).host}`);
    let last = 0;
    await download(url, dest, (got, total) => {
      const now = Date.now();
      if (now - last < 250 && got < total) return;
      last = now;
      emit({ phase: 'running', device: 'this computer', got, total: total || m.size, line: 'downloading here' });
    }, signal, { size: m.size, allowPrivate: !!m.url });
    emit({ phase: 'checking', device: 'this computer', got: 0, total: m.size, line: 'checking the file' });
    const sum = await sha256Of(dest);
    if (sum !== m.sha256) { fs.rmSync(dest, { force: true }); throw new Error(`${m.file}: checksum mismatch; the file was deleted`); }
    return dest;
  }

  private resolvePeers(ids: unknown): Peer[] {
    const all = readPeers(this.file());
    if (!Array.isArray(ids) || !ids.length) return all;
    return ids.map((r) => { const p = findPeer(all, String(r)); if (!p) throw new Error(`no such device: ${r}`); return p; });
  }

  async load(req: { model?: unknown; mode?: unknown; peers?: unknown; ctx?: unknown }, emit: (e: LoadEvent) => void): Promise<Status> {
    if (this.loading) throw new Error('already loading: wait, or stop it');
    const mode = String(req.mode ?? 'phone') as Mode;
    if (!MODES.includes(mode)) throw new Error('mode must be phone, apart, split or here');
    const modelId = String(req.model ?? '');
    const cat = this.catalog.find((m) => m.id === modelId) ?? null;
    let localOnly: { file: string; name: string; size: number } | null = null;
    if (!cat) {
      if (!modelId.startsWith('local:')) throw new Error('unknown model');
      const name = path.basename(modelId.slice(6));
      const f = name.endsWith('.gguf') ? this.findLocal(name) : null;
      if (!f) throw new Error(`no such file here: ${name}`);
      localOnly = { file: f, name, size: fs.statSync(f).size };
    }
    const ctxMax = cat?.ctx_max ?? 32768;
    const ctx = Math.max(512, Math.min(ctxMax, Number(req.ctx) > 0 ? Math.floor(Number(req.ctx)) : 4096));
    if (localOnly && (mode === 'phone' || mode === 'apart')) throw new Error(PRIVATE_URL_NOTE);
    const llama = this.llama();
    if ((mode === 'split' || mode === 'here') && !llama && !this.opts.startBackend) throw new Error(`${mode} needs llama.cpp on this computer: run kula-node setup (or pick "phone")`);

    let peers: Peer[] = [];
    if (mode === 'phone') {
      const list = this.resolvePeers(req.peers);
      if (!list.length) throw new Error('no paired device yet: add one in connect');
      peers = [list[0]];
    } else if (mode === 'apart' || mode === 'split') peers = this.resolvePeers(req.peers);

    const ac = new AbortController();
    this.loadAbort = ac;
    const modelName = cat?.name ?? localOnly!.name;
    this.loading = { mode, model: modelName, since: Date.now(), line: 'starting' };
    const say = (e: LoadEvent) => { if ('line' in e && this.loading) this.loading.line = `${e.device ? `${e.device}: ` : ''}${e.line}`; emit(e); };
    const plan: string[] = [];
    try {
      await this.unload(true);
      say({ phase: 'probe', line: peers.length ? `looking for ${peers.map((p) => p.name).join(', ')}` : 'starting here' });
      const lastPct = new Map<string, number>();
      const onProgress = (device: string, state: string, got: number, total: number) => {
        const pct = total ? Math.floor((got / total) * 100) : -1;
        const key = `${device}:${state}`;
        if (state === 'running' && lastPct.get(key) === pct) return;
        lastPct.set(key, pct);
        const line = state === 'running' ? 'downloading' : state === 'checking' ? 'checking the file' : state === 'loading' ? 'loading into memory' : state;
        say({ phase: state, device, got, total, line });
      };
      const common = { probeMs: this.opts.probeMs ?? 2500, log: (s: string) => this.log(s), identity: this.identity(), onProgress, signal: ac.signal };
      let cluster: Cluster;
      let file: string;
      let size: number;

      if (mode === 'phone' || mode === 'apart') {
        const m = cat!;
        const ref: ModelRef = { url: m.url ?? modelUrl(m), sha256: m.sha256, size: m.size, name: m.file, ctx };
        const need = needMb(m.size, m.kv_mb_per_1k, ctx);
        // this computer joins apart mode only when it can run the file it already has
        const localFile = mode === 'apart' && (llama || this.opts.startBackend) ? this.findLocal(m.file) : null;
        if (mode === 'phone') {
          const p = peers[0];
          plan.push(`the model runs on ${p.name}; this computer only carries the chat to it and back.`);
          plan.push(p.ram ? `${p.name} said it had ${p.ram} MB free; ${m.name} needs about ${need} MB at ${ctx} tokens of context${p.ram < need ? ': it may not fit' : ''}.` : `${p.name} has not told its free memory; ${m.name} needs about ${need} MB.`);
          plan.push(`${p.name} fetches ${m.file} from huggingface itself and checks its sha256; a phone that already has it starts at once.`);
        } else {
          plan.push(`every device runs its own copy of ${m.name}; each prompt goes to the fastest free one (measured tok/s, memory bandwidth before the first answer).`);
          plan.push(localFile ? 'this computer joins with the file it has.' : (llama || this.opts.startBackend) ? `this computer sits out: ${m.file} is not here (load it once with "here" to fetch it).` : 'this computer sits out: llama.cpp is not set up here.');
          for (const p of peers) if (p.ram && p.ram < need) plan.push(`${p.name}: ${p.ram} MB free, the model needs about ${need} MB; it may fail to load.`);
        }
        cluster = await openApart({ ...common, model: ref, peers, localModelFile: localFile, llama, startBackend: this.opts.startBackend });
        file = m.file; size = m.size;
      } else {
        file = localOnly ? localOnly.file : await this.ensureLocal(cat!, say, ac.signal);
        size = fs.statSync(file).size;
        say({ phase: 'checking', device: 'this computer', line: 'hashing the file' });
        const sha256 = cat?.sha256 ?? await sha256File(file);
        const ref: ModelRef = { url: 'file://' + file, sha256, size, name: path.basename(file), ctx };
        if (mode === 'here') {
          plan.push(`${modelName} runs on this computer alone (llama-server on 127.0.0.1).`);
          cluster = await openApart({ ...common, model: ref, peers: [], localModelFile: file, llama, startBackend: this.opts.startBackend });
        } else {
          const bw = await (this.opts.bandwidth ?? (() => measureBandwidth().catch(() => 4)))();
          const near = peers.filter((p) => !p.relay);
          for (const p of peers.filter((p) => p.relay)) plan.push(`${p.name} is far away (relay): split needs the lan, so it is left out.`);
          let setup;
          try {
            setup = await prepareSplit({ model: simModelOf(file), ctx, localFreeMb: freeRamMB(), localBw: bw, peers: near, share: true, probeMs: common.probeMs, log: common.log, identity: common.identity });
          } catch (e) {
            if (e instanceof TooBig) throw new Error(`too big: the model needs about ${e.needMb} MB, these devices offer ${e.totalMb} MB`);
            throw e;
          }
          this.extraClose.push(setup.close);
          const pl = setup.plan;
          plan.push(`${modelName} is split: this computer keeps ${pl.localMb} MB of it${pl.used.length ? `, ${pl.used.map((u) => `${u.name} ${u.assignedMb} MB (${u.layers} layers)`).join(', ')}` : ''}.`);
          if (!pl.used.length) plan.push('no phone answered on its rpc channel: the model runs here alone.');
          if (pl.fitsAlone) plan.push(`it would fit here alone${pl.aloneFaster ? ' and would be faster that way' : ''}; it is shared because split was asked for.`);
          for (const s of pl.skipped) plan.push(`${s.peer.name} left out: ${s.why}.`);
          if (pl.est) plan.push(`estimate: about ${Math.round(pl.est.tps * 10) / 10} tok/s.`);
          cluster = await openApart({ ...common, model: ref, peers: [], localModelFile: file, llama, startBackend: (f, c) => startSplitServer(llama, f, c, setup!, common.log) });
        }
      }
      this.stamp(cluster.stamped);
      for (const r of cluster.stamped) this.reach.set(r.id, { r: { ok: !cluster.skipped.some((s) => s.peer?.id === r.id) }, at: Date.now() });
      for (const s of cluster.skipped) if (s.peer) { plan.push(`${s.peer.name} left out: ${s.why}.`); this.reach.set(s.peer.id, { r: { ok: false, reason: s.why }, at: Date.now() }); }
      this.cluster = cluster;
      this.loaded = { mode, model: { id: cat?.id ?? `local:${localOnly!.name}`, name: modelName, file: path.basename(file), size }, ctx, devices: [], since: Date.now() };
      this.plan = plan;
      this.note(`${modelName} ready on ${cluster.devices.map((d) => d.name).join(', ')} (${mode})`);
      const st = this.status();
      emit({ done: true, status: st });
      return st;
    } catch (e) {
      for (const c of this.extraClose.splice(0)) await c().catch(() => {});
      const msg = ac.signal.aborted ? 'stopped' : (e as Error).message;
      this.plan = plan;
      this.note(`load failed: ${msg}`);
      throw new Error(msg);
    } finally {
      this.loading = null;
      this.loadAbort = null;
    }
  }

  async unload(quiet = false): Promise<void> {
    for (const c of this.chats) c.abort();
    const c = this.cluster;
    const was = this.loaded;
    this.cluster = null;
    this.loaded = null;
    if (c) await c.close().catch(() => {});
    for (const x of this.extraClose.splice(0)) await x().catch(() => {});
    if (was && !quiet) { this.plan = []; this.note(`unloaded ${was.model.name}`); }
  }

  // ---- chat

  loadedModel(): Loaded | null { return this.loaded; }

  async chat(messages: Message[], onToken: (t: string) => void, o: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}): Promise<Reply & { stopped?: boolean }> {
    if (!this.cluster || !this.loaded) throw new Error('no model loaded: open connect and load one');
    const ac = new AbortController();
    const relay = () => ac.abort();
    if (o.signal?.aborted) ac.abort();
    o.signal?.addEventListener('abort', relay, { once: true });
    this.chats.add(ac);
    try {
      const r = await this.cluster.chat(messages, onToken, { maxTokens: o.maxTokens, temperature: o.temperature, signal: ac.signal });
      this.note(`${r.device}: ${r.tokens} tokens, ${r.tps} tok/s, first after ${r.firstMs} ms${r.stopped ? ' (stopped)' : ''}`);
      return r;
    } finally {
      this.chats.delete(ac);
      o.signal?.removeEventListener('abort', relay);
    }
  }

  // Stops every answer in flight and a load that is still running.
  stop(): number {
    const n = this.chats.size + (this.loadAbort ? 1 : 0);
    for (const c of this.chats) c.abort();
    this.loadAbort?.abort();
    return n;
  }

  async close(): Promise<void> { await this.unload(true); }
}

export const hostLabel = (): string => os.hostname().replace(/\.local$/, '');
