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
import { openApart, openPeerDevice, type Cluster, type Message, type ModelRef, type Reply } from '../apart.js';
import { readPeers, writePeers, parsePeerText, upsertPeer, findPeer, probePeers, peersFile, whereIs, discover, type Peer, type PeerProbe, type Found, type PeerKind } from '../peers.js';
import { connectRemote, handshake, peekGate, GateRefused, type GatePeek } from '../gate.js';
import { Adb, isSerial, stateHelp, NO_ADB_HELP, type CableDevice } from './cable.js';
import { loadOrCreateIdentity, type GateIdentity } from '../tls.js';
import { loadOrCreate as loadDeviceKey } from '../audit/key.js';
import { home, repoRoots } from '../paths.js';
import { findLlama, sha256File, type LlamaBinaries } from '../llama.js';
import { download, sha256Of } from '../download.js';
import { prepareSplit, startSplitServer } from '../split.js';
import { TooBig } from '../planner.js';
import { simModelOf } from '../gguf.js';
import { publicName } from '../devicenames.js';
import { freeRamMB, measureBandwidth } from '../sysinfo.js';
import { modelUrl, type UiModel } from './catalog.js';
import { FULL_CATALOG, lineupView, type LineupView } from './lineup.js';
import { Usage, type Use } from './usage.js';
import { groupPeers, groupOf, bestRoute, viaOf, hostQr, newHostPin, HOST_PIN_TTL_MS, type Via, type RouteState } from './devices.js';

export type Mode = 'phone' | 'apart' | 'split' | 'here';
export const MODES: Mode[] = ['phone', 'apart', 'split', 'here'];
const MB = 1024 * 1024;

export interface Reach { ok: boolean; ms?: number; reason?: string }
export interface PeerRow {
  id: string; name: string; kind: string; where: string; far: boolean; tls: boolean; waitingPair: boolean;
  ram: number | null; bw: number | null; gpu: string | null; last_ok: string | null;
  reach: Reach | null; probedAt: number | null;
  cable: { serial: string; plugged: boolean | null } | null;   // on a usb cable; plugged: null until adb was asked
  holds: string | null;               // the model file the phone has loaded, as its /status said at the last probe
  // one device, one row (devices.ts): every way it is reached side by side, the one used now
  // (`via`, whose address and reach the fields above are), its records' ids, and when mdns
  // last heard it on this network
  via: Via;
  ways: Ways;
  routes: string[];
  heardAt: number | null;
}
export interface Way { id: string; where: string; ok: boolean | null; ms: number | null; reason: string | null }
export interface Ways {
  cable: (Way & { serial: string; plugged: boolean | null }) | null;
  wifi: Way | null;
  relay: Way | null;
}

// What the background look heard on this network (mdns), each with what it is to this computer:
//   ready    paired, and its wi-fi answered the handshake just now
//   paired   paired, but its wi-fi did not answer (yet)
//   code     a kula phone with a pairing code open, not paired here: scan this computer's qr,
//            or type its code
//   knows    it says it trusts this computer, but this computer has no record of it
//   new      a kula device that does not know this computer
//   silent   announced, but nothing answers at its address
export type NearState = 'ready' | 'paired' | 'code' | 'knows' | 'new' | 'silent';
export interface NearbyRow { name: string; host: string; port: number; kind: string | null; state: NearState; peer: string | null }
export interface HostPairView {
  open: boolean;                     // a qr is up and its code unused
  exp: number | null; left: number;  // when it stops (ms epoch), ms left
  expired: boolean;
  name: string;                      // this computer, as the qr names it
  fp: string;                        // the start of this computer's certificate, to compare on the phone
  paired: { id: string; name: string } | null;   // the device that paired with this qr
}
export interface NearbyView { at: number | null; looking: boolean; list: NearbyRow[]; pair: HostPairView }
export interface WakeRow { id: string; name: string; via: Via | null; where: string | null; why: string | null }

// A kula device that announces itself on this network (mdns _kula._tcp), as the connect sheet
// lists it. Nothing secret is in an announcement; `paired` is the peer it already is, if any.
export interface FoundRow { name: string; host: string; port: number; kind: string | null; v: string | null; paired: string | null }
type BonjourLike = Parameters<typeof discover>[1];

// A phone on the cable as the connect sheet shows it, and what "use" is doing with it.
export type CableStep = 'forwarding' | 'looking' | 'waiting' | 'code' | 'pairing' | 'paired' | 'error';
export interface CableJobView { step: CableStep; lines: string[]; error: string | null; peerId: string | null; needCode: boolean; busy: boolean }
export interface CableRow {
  serial: string; name: string; model: string | null;
  state: string;                      // device, unauthorized, offline, … or unplugged (a paired phone adb no longer sees)
  help: string | null;                // what to do about that state
  installed: boolean | null;          // kula on it (null: not asked yet, or adb cannot ask)
  peer: { id: string; name: string } | null;   // already paired as this peer
  job: CableJobView | null;
}
export interface CableView { adb: boolean; help: string | null; error: string | null; devices: CableRow[] }
interface CableJob { serial: string; step: CableStep; lines: string[]; error: string | null; peerId: string | null; port: number | null; fp: string | null; busy: boolean; done: Promise<void> | null }

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
// parts: in split mode, who holds which share of the model (this computer first); the phones in it are active
export interface Part { id: string; name: string; local: boolean; mb: number; layers: number }
export interface Loaded { mode: Mode; model: { id: string; name: string; file: string; size: number }; ctx: number; devices: DeviceRow[]; since: number; parts?: Part[] }
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
  adb?: Adb;                             // phones on a cable; default: adb found on this computer
  cableWaitMs?: number;                  // how long "use" waits for a phone to start sharing; 60 s
  cablePollMs?: number;                  // how often it looks meanwhile; 1 s
  bonjour?: () => BonjourLike;           // tests: a fake mdns browser for discover
  discoverMs?: number;                   // how long discover listens; 2.5 s
  statusMs?: number;                     // how long a probe waits for a phone's /status; 2.5 s
  watch?: boolean;                       // look on mdns in the background while the page is open (kula-node ui); off in tests
  lookMs?: number;                       // how often that look is; 12 s (2.5 s while this computer's qr is up)
  watchIdleMs?: number;                  // the page silent this long: the looking stops; 45 s
  peekMs?: number;                       // how long a look at an unknown device's gate waits; 2 s
  hostId?: string;                       // the id in this computer's qr; default: the device key's id
  now?: () => number;                    // tests: the clock the qr's code expires by
  usage?: Usage;                         // where answers are counted; default: ~/.kula-node/usage.json
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

export function peerRow(p: Peer, probe?: Reach | null, probedAt: number | null = null, plugged: boolean | null = null, holds: string | null = null): PeerRow {
  return {
    id: p.id, name: p.named ? p.name : publicName(p.name), kind: p.kind, where: whereIs(p), far: !!p.relay, tls: !!p.fp, waitingPair: !p.fp && !!p.pin,
    ram: p.ram ?? null, bw: p.bw ?? null, gpu: p.gpu ?? null, last_ok: p.last_ok ?? null,
    reach: probe ?? null, probedAt,
    cable: p.cable ? { serial: p.cable.serial, plugged } : null,
    holds,
    via: viaOf(p), ways: { cable: null, wifi: null, relay: null }, routes: [p.id], heardAt: null,
  };
}

const VIA_WORDS: Record<Via, string> = { cable: 'the usb cable', wifi: 'wi-fi', relay: 'the relay' };
export const viaWords = (via: Via, where?: string | null): string => (via === 'cable' ? `on ${VIA_WORDS.cable}` : via === 'wifi' ? `over wi-fi${where ? ` (${where})` : ''}` : `through ${VIA_WORDS.relay}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const UNPLUGGED = 'unplugged: plug the cable in';
const NOT_INSTALLED = 'kula is not installed on this phone: install the kula app on it first.';

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
  private adbTool: Adb | null = null;
  private seen: { at: number; list: CableDevice[]; error: string | null } | null = null;
  private seeing: Promise<CableDevice[]> | null = null;
  private installedBy = new Map<string, boolean>();
  private jobs = new Map<string, CableJob>();
  private held = new Map<string, string | null>();
  private discovering: Promise<FoundRow[]> | null = null;
  // a paired wi-fi phone that mdns heard at another address than the peer book has (it got a
  // new ip on this network): tried by the next probe when the saved address does not answer,
  // and kept only when the handshake there proves it is that phone
  private heard = new Map<string, { host: string; port: number }>();
  // when mdns last heard each record's device, by record id
  private heardAt = new Map<string, number>();
  // the background look (look()): what it heard, its timer, and gate looks at unknown devices
  private near: { at: number | null; list: NearbyRow[] } = { at: null, list: [] };
  private looking: Promise<NearbyView> | null = null;
  private hearing: Promise<Found[]> | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private watchedAt = 0;
  private closed = false;
  private peeks = new Map<string, { at: number; peek: GatePeek }>();
  // this computer's qr (kula-host v1): its one-time code, until when, and who paired with it
  private hostPin: { pin: string; exp: number; peerId: string | null; tried: Set<string> } | null = null;
  private hostIdCache: string | null = null;
  readonly catalog: CatalogEntry[];
  // every answer counted (usage.ts): tokens, speed, per model, device, mode, use and day
  readonly usage: Usage;

  constructor(private readonly opts: EngineOptions = {}) {
    this.catalog = opts.catalog ?? FULL_CATALOG;
    this.usage = opts.usage ?? new Usage({ log: (s) => this.log(s) });
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

  // ---- peers: one row per device (devices.ts), its ways side by side

  peers(): PeerRow[] {
    return groupPeers(readPeers(this.file())).map((g) => this.deviceRow(g));
  }

  private routeState = (p: Peer): RouteState => {
    const x = this.reach.get(p.id);
    return { plugged: this.plugged(p), ok: x ? x.r.ok : null, at: x?.at ?? null };
  };

  // the device a record belongs to, by its id (the device's first record): what the page knows
  groupId(id: string): string {
    const g = groupOf(groupPeers(readPeers(this.file())), id);
    return g ? g[0].id : id;
  }

  private deviceRow(g: Peer[]): PeerRow {
    const best = bestRoute(g, this.routeState);
    const x = this.reach.get(best.id);
    const pick = (list: Peer[]) => (list.length ? bestRoute(list, this.routeState) : null);
    const cab = pick(g.filter((p) => p.cable));
    const wifi = pick(g.filter((p) => !p.cable && !p.relay));
    const relay = pick(g.filter((p) => p.relay));
    const way = (p: Peer): Way => {
      const s = this.reach.get(p.id);
      return { id: p.id, where: whereIs(p), ok: s ? s.r.ok : null, ms: s?.r.ms ?? null, reason: s && !s.r.ok ? s.r.reason ?? null : null };
    };
    const row = peerRow(best, x?.r ?? null, x?.at ?? null, cab ? this.plugged(cab) : null, null);
    const named = g.find((p) => p.named);
    const first = g[0];
    const known = <T>(f: (p: Peer) => T | null | undefined): T | null => { const b = f(best); if (b != null) return b; for (const p of g) { const v = f(p); if (v != null) return v; } return null; };
    const lastOk = g.map((p) => p.last_ok ?? '').sort().pop() || null;
    const heardAt = Math.max(0, ...g.map((p) => this.heardAt.get(p.id) ?? 0)) || null;
    return {
      ...row,
      id: first.id,
      name: named ? named.name : first.named ? first.name : publicName(first.name),
      kind: first.kind,
      tls: !!best.fp,
      waitingPair: g.some((p) => !p.fp && !!p.pin),
      ram: known((p) => p.ram), bw: known((p) => p.bw), gpu: known((p) => p.gpu),
      last_ok: lastOk,
      cable: cab ? { serial: cab.cable!.serial, plugged: this.plugged(cab) } : null,
      holds: g.map((p) => this.held.get(p.id)).find((h) => !!h) ?? null,
      via: viaOf(best),
      ways: {
        cable: cab ? { ...way(cab), serial: cab.cable!.serial, plugged: this.plugged(cab) } : null,
        wifi: wifi ? way(wifi) : null,
        relay: relay ? way(relay) : null,
      },
      routes: g.map((p) => p.id),
      heardAt,
    };
  }

  // a device's ids (any of its records', or its name) as the ids of all its records
  private expand(ids?: string[]): string[] | undefined {
    if (!ids?.length) return ids;
    const all = readPeers(this.file());
    const gs = groupPeers(all);
    return [...new Set(ids.flatMap((id) => { const p = findPeer(all, id); const g = p ? groupOf(gs, p.id) : null; return g ? g.map((x) => x.id) : [id]; }))];
  }

  private plugged(p: Peer): boolean | null {
    if (!p.cable || !this.seen || this.seen.error) return null;
    return this.seen.list.some((d) => d.serial === p.cable!.serial && d.state === 'device');
  }

  private stamp(stamped: Peer[]) {
    if (!stamped.length) return;
    const file = this.file();
    writePeers(readPeers(file).map((p) => stamped.find((s) => s.id === p.id) ?? p), file);
  }

  // The api channel of every device (or the ones named: every way of each), 2 s each; a v3
  // peer pairs here.
  async probe(ids?: string[]): Promise<PeerRow[]> {
    await this.probeExact(this.expand(ids));
    return this.peers();
  }

  // the probe of exactly these records (all: none named)
  private async probeExact(ids?: string[]): Promise<void> {
    let all = readPeers(this.file());
    const asked = (p: Peer) => !ids?.length || ids.includes(p.id);
    if (all.some((p) => p.cable && asked(p))) all = await this.refreshCables(all.filter(asked));
    const wanted = all.filter((p) => asked(p) && !(p.cable && this.reach.get(p.id)?.r.reason === UNPLUGGED));
    if (wanted.length) {
      const results: PeerProbe[] = await probePeers(wanted, this.opts.probeMs ?? 2000, ['api'], undefined, this.identity());
      // the saved address is silent but mdns heard the phone elsewhere: the handshake there
      // (its pinned certificate or the shared secret) decides whether the new address is kept
      const moved = results.filter((r) => !r.api.ok && this.heard.has(r.peer.id))
        .map((r) => ({ ...r.peer, ...this.heard.get(r.peer.id)! }));
      for (const p of moved) this.heard.delete(p.id);
      if (moved.length) {
        const again = await probePeers(moved, this.opts.probeMs ?? 2000, ['api'], undefined, this.identity());
        for (const r of again) {
          if (!r.api.ok) continue;
          const i = results.findIndex((x) => x.peer.id === r.peer.id);
          this.note(`${r.peer.name} answered at its new address (${whereIs(r.peer)})`);
          results[i] = r;
        }
      }
      const at = Date.now();
      for (const r of results) this.reach.set(r.peer.id, { r: r.api as Reach, at });
      this.stamp(results.map((r) => r.peer));
      // what a reachable phone has loaded: the connect sheet offers that model first
      const fresh = readPeers(this.file());
      await Promise.all(results.filter((r) => r.api.ok).map(async (r) => {
        const p = fresh.find((x) => x.id === r.peer.id);
        if (p) this.held.set(p.id, await this.holds(p));
      }));
    }
  }

  // The worker's GET /status through a tunnel to its api channel: the file it has loaded, or
  // null (nothing loaded, an old worker, no answer in time). The model that this computer
  // loaded on it counts too.
  private async holds(p: Peer): Promise<string | null> {
    const mine = this.loaded && this.cluster?.devices.some((d) => d.id === p.id) ? this.loaded.model.file : null;
    let dev: Awaited<ReturnType<typeof openPeerDevice>> | null = null;
    const ms = this.opts.statusMs ?? 2500;
    try {
      const open = openPeerDevice(p, this.identity());
      dev = await Promise.race([open, sleep(ms).then(() => { open.then((d) => d.close()).catch(() => {}); return null; })]);
      if (!dev) return mine;
      const r = await fetch(`http://127.0.0.1:${dev.apiPort}/status`, { signal: AbortSignal.timeout(ms) });
      const st = (await r.json()) as { loaded?: unknown; model?: unknown };
      return st.loaded === true && typeof st.model === 'string' && st.model ? path.basename(st.model).slice(0, 200) : mine;
    } catch { return mine; } finally { await dev?.close().catch(() => {}); }
  }

  // Kula devices announcing themselves on this network (mdns), for the wi-fi steps. One look
  // at a time however many ask; a device already in the peer book says which peer it is.
  discover(): Promise<FoundRow[]> {
    if (this.discovering) return this.discovering;
    this.discovering = this.hear().then((found: Found[]) => {
      const peers = readPeers(this.file());
      const gs = groupPeers(peers);
      return found.map((f) => {
        const p = this.matchFound(peers, f);
        const g = p ? groupOf(gs, p.id) : null;
        return { name: String(f.name).slice(0, 60), host: f.host, port: f.port, kind: f.kind, v: f.v, paired: g ? g[0].id : null };
      });
    }).finally(() => { this.discovering = null; });
    return this.discovering;
  }

  // One mdns listen however many ask (discover, the background look). A paired device heard
  // at another address than its wi-fi record has is noted for the next probe (`heard`).
  private hear(): Promise<Found[]> {
    if (this.hearing) return this.hearing;
    const bonjour = this.opts.bonjour?.();
    this.hearing = discover(this.opts.discoverMs ?? 2500, bonjour).then((found) => {
      const peers = readPeers(this.file());
      const gs = groupPeers(peers);
      const now = Date.now();
      for (const f of found) {
        const p = this.matchFound(peers, f);
        const g = p ? groupOf(gs, p.id) : null;
        if (!g) continue;
        for (const x of g) this.heardAt.set(x.id, now);
        const w = g.find((x) => !x.relay && !x.cable);
        if (w && (w.host !== f.host || w.port !== f.port)) this.heard.set(w.id, { host: f.host, port: f.port });
      }
      return found;
    }).finally(() => { this.hearing = null; });
    return this.hearing;
  }

  // which record an announcement is: its worker id (a record's id, or the id it learned), else
  // the address of a wi-fi record. Only a hint: the handshake decides (pinned certificate).
  private matchFound(peers: Peer[], f: Found): Peer | null {
    return (f.id ? peers.find((x) => x.id === f.id || x.wid === f.id) : undefined)
      ?? peers.find((x) => x.host === f.host && x.port === f.port && !x.relay && !x.cable) ?? null;
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
    return this.rowOf(peer.id);
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
    const fp = await this.pinPair(host, port, pin);
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
    return this.rowOf(peer.id);
  }

  // One handshake with the one-time code: learns the phone's certificate (the code's proof
  // covers both certificates, so a device in the middle fails it) and the phone keeps ours.
  private async pinPair(host: string, port: number, pin: string): Promise<string> {
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
    return fp;
  }

  // A name the person chose for a device (6.11.2026). Kept as typed (trimmed, at most 40
  // characters) and marked, so the public model name never replaces it. Every way of the
  // device gets it.
  renamePeer(id: string, name: string): boolean {
    const clean = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
    if (!clean) throw new Error('give it a name');
    const file = this.file();
    const list = readPeers(file);
    const hit = findPeer(list, id);
    const g = hit ? groupOf(groupPeers(list), hit.id) : null;
    if (!g) return false;
    const p = g[0];
    const was = (g.find((x) => x.named) ?? p).named ? (g.find((x) => x.named) ?? p).name : publicName(p.name);
    for (const x of g) { x.name = clean; x.named = true; }
    writePeers(list, file);
    this.note(`renamed ${was} to ${clean}`);
    return true;
  }

  // Forgets a device: every way of it (the cable record and the wi-fi record both).
  removePeer(id: string): boolean {
    const file = this.file();
    const list = readPeers(file);
    const hit = findPeer(list, id);
    const g = hit ? groupOf(groupPeers(list), hit.id) : null;
    if (!g) return false;
    const row = this.deviceRow(g);
    writePeers(list.filter((p) => !g.includes(p)), file);
    for (const p of g) {
      this.reach.delete(p.id); this.held.delete(p.id); this.heard.delete(p.id); this.heardAt.delete(p.id);
      if (p.cable) this.jobs.delete(p.cable.serial);
    }
    const ways = [row.ways.cable && 'cable', row.ways.wifi && 'wi-fi', row.ways.relay && 'relay'].filter(Boolean);
    this.note(`forgot ${row.name}${ways.length > 1 ? ` (${ways.join(' and ')})` : ''}`);
    return true;
  }

  // the row of the device a record belongs to
  private rowOf(id: string): PeerRow {
    const g = groupOf(groupPeers(readPeers(this.file())), id);
    if (!g) throw new Error(`no such device: ${id}`);
    return this.deviceRow(g);
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }
  private hostId(): string {
    if (!this.hostIdCache) this.hostIdCache = this.opts.hostId ?? loadDeviceKey().id;
    return this.hostIdCache;
  }

  // ---- this computer's qr: a phone pairs by scanning it (devices.ts, kula-host v1)
  //
  // "add a device → same wi-fi" shows it. The phone sets the code as its gate's one-time code
  // and starts sharing; the look below hears it on mdns, sees a gate with a code open, and
  // pairs with this code: the usual v3 handshake, whose proof covers both certificates. One
  // code per qr (a new qr makes a new code and the old one is dead), ten minutes, spent by
  // the first pairing. The code leaves this process only inside the qr image.

  openHostPair(): HostPairView {
    const now = this.now();
    this.hostPin = { pin: newHostPin(), exp: now + HOST_PIN_TTL_MS, peerId: null, tried: new Set() };
    this.log('this computer\'s qr is up: a phone that scans it in the next 10 minutes pairs by itself');
    this.touch(true);
    return this.hostPair();
  }

  closeHostPair(): HostPairView {
    if (this.hostPin && !this.hostPin.peerId) this.hostPin = null;
    return this.hostPair();
  }

  private pinOpen(): boolean {
    const h = this.hostPin;
    return !!h && !h.peerId && this.now() < h.exp;
  }

  // the qr's json, while its code is open; null otherwise
  hostPairPayload(): string | null {
    const h = this.hostPin;
    if (!h || !this.pinOpen()) return null;
    return JSON.stringify(hostQr({ id: this.hostId(), name: hostLabel(), fp: this.identity().fp, pin: h.pin, exp: h.exp }));
  }

  hostPair(): HostPairView {
    const h = this.hostPin;
    const now = this.now();
    let paired: HostPairView['paired'] = null;
    if (h?.peerId) { try { const r = this.rowOf(h.peerId); paired = { id: r.id, name: r.name }; } catch {} }
    return {
      open: this.pinOpen(), exp: h?.exp ?? null, left: h && !h.peerId ? Math.max(0, h.exp - now) : 0,
      expired: !!h && !h.peerId && now >= h.exp, name: hostLabel(), fp: this.identity().fp.slice(0, 16), paired,
    };
  }

  // A phone that scanned the qr, by its address: paired with the qr's code now (the look does
  // the same by itself once mdns hears it; this is for a network where mdns does not carry).
  async pairNearby(input: { host?: unknown; port?: unknown; address?: unknown }): Promise<PeerRow> {
    let host = typeof input.host === 'string' ? input.host.trim() : '';
    let port = Number(input.port);
    if (typeof input.address === 'string' && input.address.trim()) {
      const m = HOST_PORT.exec(input.address.trim());
      if (!m) throw new Error('address must look like 192.168.1.20:50551');
      host = m[1].replace(/^\[|\]$/g, ''); port = Number(m[2]);
    }
    if (!host || !/^[0-9A-Za-z.:-]{1,253}$/.test(host)) throw new Error('bad address');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port');
    if (!this.pinOpen()) throw new Error('show this computer\'s qr first (devices → add → same wi-fi) and scan it with the phone, or type the phone\'s code');
    const f = this.near.list.find((r) => r.host === host && r.port === port);
    const peer = await this.pairFound({ id: null, name: f?.name ?? `phone ${host}`, host, port, kind: f?.kind ?? 'phone', ram: null, bw: null, v: null }, this.hostPin!.pin);
    this.spend(peer);
    return this.rowOf(peer.id);
  }

  // one handshake with the qr's code at a heard address; kept like a phone paired by its code
  private async pairFound(f: Found, pin: string): Promise<Peer> {
    const fp = await this.pinPair(f.host, f.port, pin);
    const file = this.file();
    const list = readPeers(file);
    const now = new Date().toISOString();
    const same = groupPeers(list).find((g) => g.some((p) => p.fp === fp)) ?? null;
    const base = same?.[0] ?? null;
    const taken = (id: string) => list.some((p) => p.id === id && p.fp !== fp);
    const id = f.id && !taken(f.id) ? f.id : !taken(`${f.host}:${f.port}`) ? `${f.host}:${f.port}` : `wifi:${fp.slice(0, 12)}`;
    const kind: PeerKind = f.kind === 'tablet' || f.kind === 'pc' ? f.kind : 'phone';
    const peer: Peer = {
      id, wid: f.id ?? null, name: (base ? base.name : f.name || `phone ${f.host}`).slice(0, 60), ...(base?.named ? { named: true } : {}),
      host: f.host, port: f.port, secret: '', fp, pin: null, paired_at: now, relay: null, kind,
      ram: f.ram ?? base?.ram ?? null, bw: f.bw ?? base?.bw ?? null, gpu: base?.gpu ?? null, vram: base?.vram ?? null, passport: null, added_at: now, last_ok: now,
    };
    writePeers(upsertPeer(list, peer).list, file);
    this.reach.set(peer.id, { r: { ok: true }, at: Date.now() });
    this.heardAt.set(peer.id, Date.now());
    return peer;
  }

  private spend(peer: Peer) {
    if (this.hostPin) this.hostPin.peerId = peer.id;
    this.note(`paired with ${peer.named ? peer.name : publicName(peer.name)} over wi-fi (${peer.host}:${peer.port}): it scanned this computer's qr`);
  }

  // ---- the background look (8.11.2026)
  //
  // While the page is open (every request of the owner's page calls touch), mdns is listened
  // to every 12 s, 2.5 s each time. What it hears:
  //   a paired device: noted as heard; its wi-fi is probed when its last answer is old or its
  //     address changed (the probe tries the new address, the pinned certificate decides), so
  //     it shows "ready" without a click;
  //   an unknown one: its gate is looked at (tls: the certificate it proves, and whether it
  //     knows this computer). The certificate of a device paired another way (the cable) makes
  //     this its wi-fi too, one device with both ways. A gate with a code open while this
  //     computer's qr is up is tried with the qr's code: the phone that scanned it pairs. The
  //     rest is "nearby, not paired".
  // Nothing here leaves this network: mdns and the gates of devices on it.

  touch(soon = false): void {
    this.watchedAt = Date.now();
    if (this.closed || this.opts.watch !== true) return;
    if (this.watchTimer && !soon) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    const every = this.opts.lookMs ?? 12_000;
    const due = soon || this.near.at === null ? 100 : Math.max(100, this.near.at + every - Date.now());
    this.later(due);
  }

  private later(ms: number) {
    this.watchTimer = setTimeout(() => { void this.tickWatch(); }, ms);
    this.watchTimer.unref?.();
  }

  private async tickWatch(): Promise<void> {
    this.watchTimer = null;
    if (this.closed) return;
    if (Date.now() - this.watchedAt > (this.opts.watchIdleMs ?? 45_000) && !this.pinOpen()) return;
    try { await this.look(); } catch (e) { this.log(`look: ${(e as Error).message}`); }
    if (!this.closed && !this.watchTimer) this.later(this.pinOpen() ? Math.min(2500, this.opts.lookMs ?? 12_000) : this.opts.lookMs ?? 12_000);
  }

  // what the last look heard (and this computer's qr), for GET nearby
  nearby(): NearbyView {
    return { at: this.near.at, looking: !!this.looking, list: this.near.list.map((r) => ({ ...r })), pair: this.hostPair() };
  }

  look(): Promise<NearbyView> {
    if (this.looking) return this.looking;
    this.looking = this.lookOnce().finally(() => { this.looking = null; });
    return this.looking;
  }

  private inUse(id: string): boolean { return !!this.cluster?.devices.some((d) => d.id === id); }

  private async peekFound(f: Found): Promise<GatePeek> {
    const key = `${f.host}:${f.port}`;
    const c = this.peeks.get(key);
    if (c && !this.pinOpen() && Date.now() - c.at < 30_000) return c.peek;
    const peek = await peekGate(f.host, f.port, this.identity(), this.opts.peekMs ?? 2000).catch((e): GatePeek => ({ up: false, reason: (e as Error).message }));
    this.peeks.set(key, { at: Date.now(), peek });
    if (this.peeks.size > 64) this.peeks.delete(this.peeks.keys().next().value!);
    return peek;
  }

  private async lookOnce(): Promise<NearbyView> {
    const found = await this.hear();
    const now = Date.now();
    const wifiOf = (g: Peer[]) => g.find((p) => !p.cable && !p.relay) ?? null;
    // the gates of what is not a paired device's wi-fi yet, all at once
    const first = readPeers(this.file());
    const firstGroups = groupPeers(first);
    const needPeek = found.filter((f) => { const p = this.matchFound(first, f); const g = p ? groupOf(firstGroups, p.id) : null; return !g || !wifiOf(g); });
    const peeked = new Map<Found, GatePeek>();
    await Promise.all(needPeek.map(async (f) => { peeked.set(f, await this.peekFound(f)); }));

    const rows: NearbyRow[] = [];
    const toProbe = new Set<string>();
    for (const f of found) {
      const list = readPeers(this.file());
      const gs = groupPeers(list);
      const m = this.matchFound(list, f);
      let g = m ? groupOf(gs, m.id) : null;
      let state: NearState = 'new';
      const pk = peeked.get(f);
      if (pk?.up) {
        const same = gs.find((x) => x.some((p) => !!p.fp && p.fp === pk.fp)) ?? null;
        if (same) { this.learnWifi(same, f, pk); g = groupOf(groupPeers(readPeers(this.file())), same[0].id); }
        else if (!g && pk.state === 'pin' && this.pinOpen() && !this.hostPin!.tried.has(pk.fp)) {
          try {
            const peer = await this.pairFound(f, this.hostPin!.pin);
            this.spend(peer);
            g = groupOf(groupPeers(readPeers(this.file())), peer.id);
          } catch (e) {
            this.hostPin?.tried.add(pk.fp);
            this.log(`${f.name} at ${f.host}:${f.port} did not take this computer's code: ${(e as Error).message}`);
          }
        }
        if (!g) state = pk.state === 'pin' ? 'code' : pk.state === 'paired' ? 'knows' : 'new';
      } else if (pk && !g) state = 'silent';
      if (g) {
        for (const p of g) this.heardAt.set(p.id, now);
        const w = wifiOf(g);
        if (w && !this.inUse(w.id)) {
          const r = this.reach.get(w.id);
          if (!r || !r.r.ok || now - r.at > 30_000 || this.heard.has(w.id)) toProbe.add(w.id);
        }
      }
      rows.push({ name: String(f.name).slice(0, 60), host: f.host, port: f.port, kind: f.kind, state: g ? 'paired' : state, peer: g ? g[0].id : null });
    }
    if (toProbe.size) {
      const before = new Map([...toProbe].map((id) => [id, this.reach.get(id)?.r.ok ?? null]));
      await this.probeExact([...toProbe]).catch((e) => this.log(`look: ${(e as Error).message}`));
      for (const [id, was] of before) {
        const ok = this.reach.get(id)?.r.ok ?? null;
        if (ok && was !== true) { try { const r = this.rowOf(id); this.note(`${r.name} is ready over wi-fi (${r.ways.wifi?.where ?? ''})`); } catch {} }
      }
    }
    const devices = new Map(this.peers().map((r) => [r.id, r]));
    for (const r of rows) if (r.peer) r.state = devices.get(r.peer)?.ways.wifi?.ok ? 'ready' : 'paired';
    this.near = { at: now, list: rows };
    return this.nearby();
  }

  // A device paired another way (the cable) answered on this wi-fi with the same certificate
  // (tls proves it): its worker id is noted on every record, and it gets a wi-fi record when
  // its gate says it trusts this computer, or its wi-fi record the heard address.
  private learnWifi(g: Peer[], f: Found, pk: Extract<GatePeek, { up: true }>) {
    const file = this.file();
    const list = readPeers(file);
    const ids = new Set(g.map((p) => p.id));
    let changed = false;
    if (f.id) for (const p of list) if (ids.has(p.id) && p.wid !== f.id) { p.wid = f.id; changed = true; }
    const w = list.find((p) => ids.has(p.id) && !p.cable && !p.relay);
    if (w) {
      if (w.host !== f.host || w.port !== f.port) this.heard.set(w.id, { host: f.host, port: f.port });
    } else if (pk.state === 'paired') {
      const first = list.find((p) => p.id === g[0].id) ?? g[0];
      const free = (id: string) => !list.some((p) => p.id === id);
      const id = f.id && free(f.id) ? f.id : free(`${f.host}:${f.port}`) ? `${f.host}:${f.port}` : `wifi:${pk.fp.slice(0, 12)}`;
      const now = new Date().toISOString();
      list.push({
        id, wid: f.id ?? null, name: first.name, ...(first.named ? { named: true } : {}), host: f.host, port: f.port, secret: '', fp: pk.fp, pin: null,
        paired_at: first.paired_at ?? now, relay: null, kind: first.kind, ram: f.ram ?? first.ram, bw: f.bw ?? first.bw, gpu: first.gpu ?? null, vram: first.vram ?? null,
        passport: null, added_at: now, last_ok: null,
      });
      changed = true;
      this.note(`${first.named ? first.name : publicName(first.name)} answered on this wi-fi too (${f.host}:${f.port}): the same phone as on the cable, now reachable both ways`);
    }
    if (changed) writePeers(list, file);
  }

  // ---- waking the devices for a night project: each by the way that works now
  //
  // A device on a plugged-in cable: "use" on it (its share screen opened again if it slept).
  // Else its wi-fi: mdns listened to once if it was not heard lately (a new address), then the
  // handshake. Else a relay. Says which way each was reached; the load picks the same way.
  async wake(ids: string[] = []): Promise<WakeRow[]> {
    const all = readPeers(this.file());
    const gs = groupPeers(all);
    const want = ids.length ? [...new Set(ids.map((id) => { const p = findPeer(all, id); return p ? groupOf(gs, p.id) : null; }))].filter((g): g is Peer[] => !!g) : gs;
    const out: WakeRow[] = [];
    let listened = false;
    for (const g of want) {
      const row = this.deviceRow(g);
      const tried: string[] = [];
      let got: WakeRow | null = null;
      const cab = g.find((p) => p.cable);
      if (cab) {
        const devs = await this.cableDevices(true);
        const d = devs.find((x) => x.serial === cab.cable!.serial);
        if (d?.state === 'device') {
          try {
            this.useCable(cab.cable!.serial);
            const v = await this.cableSettled(cab.cable!.serial);
            if (v?.step === 'paired') got = { id: row.id, name: row.name, via: 'cable', where: null, why: null };
            else tried.push(`cable: ${v?.error ?? 'did not connect'}`);
          } catch (e) { tried.push(`cable: ${(e as Error).message}`); }
        } else tried.push('cable: unplugged');
      }
      const w = g.find((p) => !p.cable && !p.relay);
      if (!got && w) {
        if (!listened && Date.now() - (this.heardAt.get(w.id) ?? 0) > 60_000) { listened = true; await this.hear().catch(() => []); }
        await this.probeExact([w.id]).catch(() => {});
        const r = this.reach.get(w.id)?.r;
        if (r?.ok) { const fresh = readPeers(this.file()).find((p) => p.id === w.id) ?? w; got = { id: row.id, name: row.name, via: 'wifi', where: whereIs(fresh), why: null }; }
        else tried.push(`wi-fi: ${r?.reason ?? 'no answer'}`);
      }
      const rl = g.find((p) => p.relay);
      if (!got && rl) {
        await this.probeExact([rl.id]).catch(() => {});
        const r = this.reach.get(rl.id)?.r;
        if (r?.ok) got = { id: row.id, name: row.name, via: 'relay', where: null, why: null };
        else tried.push(`relay: ${r?.reason ?? 'no answer'}`);
      }
      out.push(got ?? { id: row.id, name: row.name, via: null, where: null, why: tried.join('; ') || 'no way to reach it' });
    }
    for (const r of out) this.note(r.via ? `${r.name} reached ${viaWords(r.via, r.where)}` : `${r.name} not reached: ${r.why}`);
    return out;
  }

  // ---- phones on a usb cable (cable.ts)
  //
  // "use" on a phone: an adb forward from a port on 127.0.0.1 to the phone's gate, then a
  // look at the gate (peekGate). Nothing answers: the share screen is opened with start=1 and
  // the gate is looked at every second for up to a minute. The gate already trusts this
  // computer ("paired"): the phone is kept (or found again) at once. It has a code open
  // ("pin"): the page asks for the code on the phone's share screen and `pairCable` does the
  // pin proof. The forward's port can change (unplugged, adb restarted), so every connect
  // makes it again. Nothing here says the code back: job lines are plain progress.

  // adb missing is looked for again every few seconds: installing platform-tools (or Android
  // Studio) while the page is open shows the phone without a restart
  private adbLooked = 0;
  private adb(): Adb {
    if (!this.adbTool || (!this.opts.adb && !this.adbTool.present && Date.now() - this.adbLooked > 3000)) {
      this.adbTool = this.opts.adb ?? new Adb();
      this.adbLooked = Date.now();
    }
    return this.adbTool;
  }

  // `adb devices -l`, at most every 1.5 s however many ask
  private async cableDevices(fresh = false): Promise<CableDevice[]> {
    const adb = this.adb();
    if (!adb.present) { this.seen = { at: Date.now(), list: [], error: NO_ADB_HELP }; return []; }
    if (!fresh && this.seen && Date.now() - this.seen.at < 1500) return this.seen.list;
    if (this.seeing) return this.seeing;
    this.seeing = adb.devices().then((list) => {
      this.seen = { at: Date.now(), list, error: null };
      for (const s of [...this.installedBy.keys()]) if (!list.some((d) => d.serial === s && d.state === 'device')) this.installedBy.delete(s);
      return list;
    }, (e) => { this.seen = { at: Date.now(), list: [], error: (e as Error).message }; return []; }).finally(() => { this.seeing = null; });
    return this.seeing;
  }

  private jobView(j: CableJob | undefined): CableJobView | null {
    if (!j) return null;
    return { step: j.step, lines: j.lines.slice(-8), error: j.error, peerId: j.peerId, needCode: j.step === 'code', busy: j.busy };
  }

  async cable(): Promise<CableView> {
    const adb = this.adb();
    if (!adb.present) return { adb: false, help: NO_ADB_HELP, error: null, devices: [] };
    const list = await this.cableDevices();
    const peers = readPeers(this.file());
    const gs = groupPeers(peers);
    // a cable record is shown as its device (the id and name the devices list has)
    const dev = (p: Peer) => { const g = groupOf(gs, p.id) ?? [p]; const n = g.find((x) => x.named) ?? g[0]; return { id: g[0].id, name: n.named ? n.name : publicName(n.name) }; };
    const rows: CableRow[] = [];
    for (const d of list) {
      if (d.state === 'device' && !this.installedBy.has(d.serial)) {
        try { this.installedBy.set(d.serial, await adb.installed(d.serial)); } catch {}
      }
      const p = peers.find((x) => x.cable?.serial === d.serial);
      const installed = this.installedBy.get(d.serial) ?? null;
      rows.push({
        serial: d.serial, name: p ? dev(p).name : d.model ? publicName(d.model) : `phone ${d.serial.slice(-4)}`, model: d.model, state: d.state,
        help: stateHelp(d.state) ?? (installed === false ? NOT_INSTALLED : null),
        installed, peer: p ? dev(p) : null, job: this.jobView(this.jobs.get(d.serial)),
      });
    }
    for (const p of peers) {
      if (!p.cable || list.some((d) => d.serial === p.cable!.serial)) continue;
      rows.push({ serial: p.cable.serial, name: dev(p).name, model: null, state: 'unplugged', help: 'plug the cable in to use it', installed: null, peer: dev(p), job: this.jobView(this.jobs.get(p.cable.serial)) });
    }
    return { adb: true, help: null, error: this.seen?.error ?? null, devices: rows };
  }

  // Starts "use" for a phone on the cable and returns at once; GET cable shows how it goes.
  useCable(serial: unknown): CableJobView {
    if (!isSerial(serial)) throw new Error('bad serial');
    const running = this.jobs.get(serial);
    if (running?.busy) return this.jobView(running)!;
    const job: CableJob = { serial, step: 'forwarding', lines: [], error: null, peerId: null, port: null, fp: null, busy: true, done: null };
    this.jobs.set(serial, job);
    job.done = this.runCable(job).catch((e) => {
      job.step = 'error';
      job.error = (e as Error).message;
      this.note(`cable ${serial}: ${(e as Error).message}`);
    }).finally(() => { job.busy = false; });
    return this.jobView(job)!;
  }

  // tests: wait for a "use" to settle
  async cableSettled(serial: string): Promise<CableJobView | null> {
    await this.jobs.get(serial)?.done;
    return this.jobView(this.jobs.get(serial));
  }

  private async runCable(job: CableJob): Promise<void> {
    const adb = this.adb();
    const say = (step: CableStep, line?: string) => { job.step = step; if (line) job.lines.push(line); };
    const here = async () => (await this.cableDevices(true)).find((d) => d.serial === job.serial) ?? null;
    if (!adb.present) throw new Error(NO_ADB_HELP);
    const dev = await here();
    if (!dev) throw new Error('that phone is not on the cable any more');
    if (dev.state !== 'device') throw new Error(stateHelp(dev.state)!);
    say('forwarding', 'forwarding a port on this computer to the phone');
    const { port } = await adb.forward(job.serial);
    job.port = port;
    say('looking', `127.0.0.1:${port} reaches the phone's port 50551: looking for kula there`);
    const look = () => peekGate('127.0.0.1', port, this.identity(), 2000);
    const ready = (p: GatePeek): boolean => p.up && p.state !== 'refused';
    const said = (p: GatePeek): string | null => (p.up ? p.reason ?? 'no' : null);
    let peek: GatePeek = await look();
    if (!ready(peek)) {
      if (this.installedBy.get(job.serial) === false) throw new Error(NOT_INSTALLED);
      say('waiting', said(peek) ? `the phone said ${said(peek)}: opening its share screen` : 'nothing answers yet: opening the share screen on the phone');
      try { await adb.openShare(job.serial); } catch (e) { job.lines.push(`could not open it (${(e as Error).message}): on the phone open kula → share this phone and press start`); }
      job.lines.push('waiting for the phone to share');
      const until = Date.now() + (this.opts.cableWaitMs ?? 60_000);
      while (Date.now() < until) {
        await sleep(this.opts.cablePollMs ?? 1000);
        peek = await look();
        if (ready(peek)) break;
        const d = await here();
        if (!d || d.state !== 'device') throw new Error('the phone went away from the cable');
      }
      if (!ready(peek)) {
        throw new Error(said(peek)
          ? `the phone said no: ${said(peek)}. on the phone open kula → share this phone, stop and start again, then press use again`
          : 'the phone did not start sharing within a minute: on the phone open kula → share this phone and press start, then press use again');
      }
    }
    const found = peek as Extract<GatePeek, { up: true }>;
    job.fp = found.fp;
    const peers = readPeers(this.file());
    const mine = peers.find((p) => p.cable?.serial === job.serial) ?? null;
    if (found.state === 'paired') {
      // the phone already trusts this computer's certificate. A peer with this certificate
      // is that phone; with none, the certificate is taken from the cable itself: adb only
      // forwards to the phone this computer's adb key was allowed on.
      if (mine?.fp && mine.fp !== found.fp) throw new Error('this phone shows another certificate than the one it paired with: forget it and pair again');
      const same = mine ?? peers.find((p) => p.fp === found.fp && (p.host === '127.0.0.1' || p.host === 'localhost') && !p.relay && !p.cable) ?? null;
      const peer = this.keepCable(same, job.serial, port, found.fp, dev.model);
      this.reach.set(peer.id, { r: { ok: true }, at: Date.now() });
      job.peerId = this.groupId(peer.id);
      say('paired', same ? `connected to ${peer.name} over the cable` : `${peer.name} already knew this computer: connected over the cable`);
      this.note(`${peer.name} on the cable (127.0.0.1:${port})`);
      return;
    }
    say('code', 'the phone is sharing: type the code from its share screen');
  }

  // A paired phone on the cable kept in the peer book: one that was there updated (its
  // port), or a new one named after its model.
  private keepCable(prev: Peer | null, serial: string, port: number, fp: string, model: string | null): Peer {
    const now = new Date().toISOString();
    const peer: Peer = prev
      ? { ...prev, host: '127.0.0.1', port, fp, pin: null, paired_at: prev.paired_at ?? now, cable: { serial }, last_ok: now }
      : {
        id: `cable:${serial}`, name: (model ? publicName(model) : `phone ${serial.slice(-4)}`).slice(0, 60), host: '127.0.0.1', port, secret: '', fp, pin: null, paired_at: now,
        relay: null, kind: 'phone', ram: null, bw: null, gpu: null, vram: null, passport: null, cable: { serial }, added_at: now, last_ok: now,
      };
    const file = this.file();
    writePeers(upsertPeer(readPeers(file), peer).list, file);
    return peer;
  }

  // The code from the phone's share screen, for the phone "use" left waiting for it.
  async pairCable(serial: unknown, code: unknown): Promise<{ peer: PeerRow; job: CableJobView }> {
    if (!isSerial(serial)) throw new Error('bad serial');
    const job = this.jobs.get(serial);
    if (!job || job.step !== 'code' || job.busy) throw new Error('press "use" on that phone first');
    const pin = String(code ?? '').replace(/[\s-]/g, '').toLowerCase();
    if (!/^[0-9a-f]{8,64}$/.test(pin)) throw new Error('the code is the 16 letters and digits after "code" on the phone');
    job.busy = true;
    job.error = null;
    job.step = 'pairing';
    job.lines.push('pairing with the code');
    try {
      const dev = (await this.cableDevices(true)).find((d) => d.serial === serial);
      if (!dev || dev.state !== 'device') throw new Error('the phone went away from the cable');
      const { port } = await this.adb().forward(serial);
      const fp = await this.pinPair('127.0.0.1', port, pin);
      if (job.fp && fp !== job.fp) throw new Error('the phone showed another certificate than a moment ago: not pairing');
      const mine = readPeers(this.file()).find((p) => p.cable?.serial === serial) ?? null;
      const peer = this.keepCable(mine, serial, port, fp, dev.model);
      this.reach.set(peer.id, { r: { ok: true }, at: Date.now() });
      job.peerId = this.groupId(peer.id);
      job.step = 'paired';
      job.lines.push(`paired with ${peer.name} over the cable`);
      this.note(`paired with ${peer.name} over the cable`);
      return { peer: this.rowOf(peer.id), job: this.jobView(job)! };
    } catch (e) {
      job.step = 'code';
      job.error = (e as Error).message;
      throw e;
    } finally { job.busy = false; }
  }

  // Before every connect: the forward of each cable peer made again (its port may have
  // changed) and written down; one adb does not see is marked unplugged.
  private async refreshCables(list: Peer[]): Promise<Peer[]> {
    const file = this.file();
    const cabled = list.filter((p) => p.cable);
    if (!cabled.length) return readPeers(file);
    const adb = this.adb();
    const devs = adb.present ? await this.cableDevices(true) : [];
    for (const p of cabled) {
      const d = devs.find((x) => x.serial === p.cable!.serial);
      if (!adb.present || !d || d.state !== 'device') { this.reach.set(p.id, { r: { ok: false, reason: adb.present ? UNPLUGGED : 'adb is missing on this computer' }, at: Date.now() }); continue; }
      try {
        const { port } = await adb.forward(p.cable!.serial);
        if (port !== p.port || p.host !== '127.0.0.1') {
          writePeers(readPeers(file).map((x) => (x.id === p.id ? { ...x, host: '127.0.0.1', port } : x)), file);
          this.log(`${p.name}: the cable's forward is 127.0.0.1:${port} now`);
        }
        if (this.reach.get(p.id)?.r.reason === UNPLUGGED) this.reach.delete(p.id);
      } catch (e) { this.reach.set(p.id, { r: { ok: false, reason: (e as Error).message }, at: Date.now() }); }
    }
    return readPeers(file);
  }

  // ---- models

  private findLocal(name: string): string | null {
    for (const d of this.dirs()) {
      const f = path.join(d, name);
      try { if (fs.statSync(f).isFile()) return f; } catch {}
    }
    return null;
  }

  // the model picker's tree (makers, series, models), with this computer's free and total memory
  lineup(): LineupView { return lineupView(freeRamMB(), Math.round(os.totalmem() / MB)); }

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

  // The devices asked for (by any of their records' ids, or a name), each once. No list: with
  // `exact` (the load's `all`, the page's picked devices) none, else all (older pages, the cli).
  private groupsFor(ids: unknown, exact = false): Peer[][] {
    const all = readPeers(this.file());
    const gs = groupPeers(all);
    if (!Array.isArray(ids) || !ids.length) return exact ? [] : gs;
    const out: Peer[][] = [];
    for (const r of ids) {
      const p = findPeer(all, String(r));
      const g = p ? groupOf(gs, p.id) : null;
      if (!g) throw new Error(`no such device: ${r}`);
      if (!out.includes(g)) out.push(g);
    }
    return out;
  }

  async load(req: { model?: unknown; mode?: unknown; peers?: unknown; ctx?: unknown; all?: unknown; here?: unknown }, emit: (e: LoadEvent) => void): Promise<Status> {
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

    // each device by the way that works now (devices.ts): its cable while it is plugged in
    // (the forward made again first: the port may have changed), else its wi-fi, else a relay
    let peers: Peer[] = [];
    const reached: string[] = [];
    const exact = req.all === true;
    if (mode !== 'here') {
      const asked = this.groupsFor(req.peers, exact);
      const use = mode === 'phone' ? asked.slice(0, 1) : asked;
      if (mode === 'phone' && !use.length) throw new Error(exact ? 'pick the device that runs it' : 'no paired device yet: add one in connect');
      const cabled = use.flat().filter((p) => p.cable);
      if (cabled.length) await this.refreshCables(cabled);
      const fresh = groupPeers(readPeers(this.file()));
      peers = use.map((g) => bestRoute(groupOf(fresh, g[0].id) ?? g, this.routeState));
      const off = peers.find((p) => p.cable && this.reach.get(p.id)?.r.reason === UNPLUGGED);
      if (mode === 'phone' && off) throw new Error(`${off.name} is ${UNPLUGGED}`);
      for (const p of peers) {
        const g = groupOf(fresh, p.id) ?? [p];
        if (g.length > 1) reached.push(`${p.named ? p.name : publicName(p.name)} ${viaWords(viaOf(p), p.cable ? null : whereIs(p))}`);
      }
    }
    // apart: this computer runs its own copy unless the page left it out
    const hereToo = !(mode === 'apart' && req.here === false);
    if (exact && mode === 'apart' && !peers.length && !hereToo) throw new Error('pick at least one device');
    if (exact && mode === 'split' && !peers.length) throw new Error('split needs at least one device besides this computer: pick one, or load on this computer');

    const ac = new AbortController();
    this.loadAbort = ac;
    const modelName = cat?.name ?? localOnly!.name;
    this.loading = { mode, model: modelName, since: Date.now(), line: 'starting' };
    const say = (e: LoadEvent) => { if ('line' in e && this.loading) this.loading.line = `${e.device ? `${e.device}: ` : ''}${e.line}`; emit(e); };
    const plan: string[] = [];
    try {
      await this.unload(true);
      if (reached.length) plan.push(`reached ${reached.join(', ')}.`);
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
      let splitParts: Part[] | undefined;
      let file: string;
      let size: number;
      // which devices the page picked, in the plan's first words
      if (exact && mode !== 'here') {
        const used = [...(mode === 'split' || (mode === 'apart' && hereToo) ? ['this computer'] : []), ...peers.map((p) => p.name)];
        plan.push(`you picked ${used.join(', ')}: only ${used.length === 1 ? 'it is' : 'these are'} used.`);
      }

      if (mode === 'phone' || mode === 'apart') {
        const m = cat!;
        const ref: ModelRef = { url: m.url ?? modelUrl(m), sha256: m.sha256, size: m.size, name: m.file, ctx };
        const need = needMb(m.size, m.kv_mb_per_1k, ctx);
        // this computer joins apart mode only when it can run the file it already has
        const localFile = mode === 'apart' && hereToo && (llama || this.opts.startBackend) ? this.findLocal(m.file) : null;
        if (mode === 'phone') {
          const p = peers[0];
          plan.push(`the model runs on ${p.name}; this computer only carries the chat to it and back.`);
          plan.push(p.ram ? `${p.name} said it had ${p.ram} MB free; ${m.name} needs about ${need} MB at ${ctx} tokens of context${p.ram < need ? ': it may not fit' : ''}.` : `${p.name} has not told its free memory; ${m.name} needs about ${need} MB.`);
          plan.push(`${p.name} fetches ${m.file} from huggingface itself and checks its sha256; a phone that already has it starts at once.`);
        } else {
          plan.push(`every device runs its own copy of ${m.name}; each prompt goes to the fastest free one (measured tok/s, memory bandwidth before the first answer).`);
          plan.push(localFile ? 'this computer joins with the file it has.' : !hereToo ? 'this computer sits out: you left it out.' : (llama || this.opts.startBackend) ? `this computer sits out: ${m.file} is not here (load it once with "here" to fetch it).` : 'this computer sits out: llama.cpp is not set up here.');
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
            setup = await prepareSplit({ model: simModelOf(file), ctx, localFreeMb: freeRamMB(), localBw: bw, peers: near, share: true, all: req.all === true, probeMs: common.probeMs, log: common.log, identity: common.identity });
          } catch (e) {
            if (e instanceof TooBig) throw new Error(`too big: the model needs about ${e.needMb} MB, these devices offer ${e.totalMb} MB`);
            throw e;
          }
          this.extraClose.push(setup.close);
          const pl = setup.plan;
          splitParts = [{ id: 'local', name: 'this computer', local: true, mb: pl.localMb, layers: pl.localLayers ?? 0 }, ...pl.used.map((u) => ({ id: u.id, name: u.named ? u.name : publicName(u.name), local: false, mb: u.assignedMb, layers: u.layers }))];
          plan.push(`${modelName} is split: this computer keeps ${pl.localMb} MB of it${pl.used.length ? `, ${pl.used.map((u) => `${u.named ? u.name : publicName(u.name)} ${u.assignedMb} MB (${u.layers} layers)`).join(', ')}` : ''}.`);
          if (!pl.used.length) plan.push('no phone answered on its rpc channel: the model runs here alone.');
          if (pl.fitsAlone) plan.push(`it would fit here alone${pl.aloneFaster ? ' and would be faster that way' : ''}; it is shared because split was asked for.`);
          if (req.all === true) plan.push('every device you picked holds a part, even where fewer would be faster.');
          for (const s of pl.skipped) plan.push(`${s.peer.name} left out: ${s.why}.`);
          if (pl.est) plan.push(`estimate: about ${Math.round(pl.est.tps * 10) / 10} tok/s.`);
          cluster = await openApart({ ...common, model: ref, peers: [], localModelFile: file, llama, startBackend: (f, c) => startSplitServer(llama, f, c, setup!, common.log) });
        }
      }
      this.stamp(cluster.stamped);
      for (const r of cluster.stamped) this.reach.set(r.id, { r: { ok: !cluster.skipped.some((s) => s.peer?.id === r.id) }, at: Date.now() });
      for (const s of cluster.skipped) if (s.peer) { plan.push(`${s.peer.name} left out: ${s.why}.`); this.reach.set(s.peer.id, { r: { ok: false, reason: s.why }, at: Date.now() }); }
      this.cluster = cluster;
      this.loaded = { mode, model: { id: cat?.id ?? `local:${localOnly!.name}`, name: modelName, file: path.basename(file), size }, ctx, devices: [], since: Date.now(), ...(splitParts ? { parts: splitParts } : {}) };
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

  // `use` says who asked (the page, /v1, a night project, a guest): only for the counts
  async chat(messages: Message[], onToken: (t: string) => void, o: { maxTokens?: number; temperature?: number; signal?: AbortSignal; use?: Use } = {}): Promise<Reply & { stopped?: boolean }> {
    if (!this.cluster || !this.loaded) throw new Error('no model loaded: open connect and load one');
    const loaded = this.loaded;
    const ac = new AbortController();
    const relay = () => ac.abort();
    if (o.signal?.aborted) ac.abort();
    o.signal?.addEventListener('abort', relay, { once: true });
    this.chats.add(ac);
    const t0 = Date.now();
    let pieces = 0, first = 0;
    const count = { model: loaded.model.name, mode: loaded.mode, use: o.use ?? 'chat', promptChars: messages.reduce((a, m) => a + String(m.content ?? '').length, 0) } as const;
    try {
      const r = await this.cluster.chat(messages, (t) => { if (!first) first = Date.now() - t0; pieces++; onToken(t); }, { maxTokens: o.maxTokens, temperature: o.temperature, signal: ac.signal });
      this.note(`${r.device}: ${r.tokens} tokens, ${r.tps} tok/s, first after ${r.firstMs} ms${r.stopped ? ' (stopped)' : ''}`);
      this.usage.record({ ...count, device: r.device, promptTokens: r.promptTokens, completion: r.tokens || pieces, ms: r.ms, firstMs: r.firstMs, stopped: r.stopped === true });
      return r;
    } catch (e) {
      const dev = this.cluster?.devices.find((d) => d.busy)?.name ?? this.cluster?.devices[0]?.name ?? 'unknown device';
      if (ac.signal.aborted && pieces) this.usage.record({ ...count, device: dev, completion: pieces, ms: Date.now() - t0, firstMs: first, stopped: true });
      else this.usage.record({ ...count, device: dev, completion: 0, ms: 0, firstMs: 0, failed: true });
      throw e;
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

  async close(): Promise<void> {
    this.closed = true;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    await this.unload(true);
    await this.adbTool?.close().catch(() => {});
  }
}

export const hostLabel = (): string => os.hostname().replace(/\.local$/, '');
