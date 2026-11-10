// What the dashboard shows, in one place: a snapshot the page gets when it
// opens and small patches pushed over sse as things happen. Nothing in here
// may hold a secret: the peer book goes through `peerView`, which drops it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Channel, GateEvent } from '../gate.js';
import type { ApiStatus } from '../api.js';
import type { Peer, PeerProbe } from '../peers.js';
import { home } from '../paths.js';

export interface SelfView {
  name: string;
  id: string;
  host: string | null;
  ram: number;        // MB free when advertised
  totalRam: number;   // MB
  bw: number;         // GB/s
  gpu: string | null;
  vram: number;
  passport: Record<string, unknown> | null;
  passportFile: string | null;
}

export interface OpenConn { peer: string; channel: Channel; since: number }
export interface GateView { port: number | null; open: OpenConn[]; lastPeer: string | null; lastAt: number | null; lastReject: { peer: string; reason: string; at: number } | null }
export interface Counter { opens: number; closes: number; rejects: number; bytesIn: number; bytesOut: number }
export type Traffic = Record<Channel, Counter>;
export interface ApiView { loaded: boolean; model: string | null; ctx: number; busy: boolean; tokensUsed: number; heldMB: number; running: boolean }
export interface Reach { ok: boolean; ms?: number; reason?: string }
export interface PeerView {
  id: string; name: string; kind: string; host: string; port: number;
  ram: number | null; bw: number | null; gpu: string | null; vram: number | null;
  badges: string[]; last_ok: string | null;
  reach: { rpc: Reach; api: Reach } | null; probedAt: number | null;
}
export interface DeviceView { id: string; name: string; local: boolean; busy: boolean; tps: number | null; done: number; bw: number }
// A device that can use this computer without a code (share mode, tls): its fingerprint is
// public (it was in no secret), the rest is what this computer saw. Never a secret.
export interface PairedView { fp: string; name: string | null; address: string | null; pairedAt: number | null; lastSeen: number | null }
export interface LedgerView { file: string; lines: string[]; total: number; verify: { ok: boolean; count: number; problems: { file: string; n: number; reason: string }[]; keyId: string; at: number } | null }

export interface Snapshot {
  mode: 'share' | 'chat';
  startedAt: number;
  self: SelfView;
  gate: GateView;
  traffic: Traffic;
  api: ApiView;
  peers: PeerView[];
  // share mode: the devices paired with this computer's gate (docs/GATE.md, remove a device's access)
  paired: PairedView[];
  devices: DeviceView[];
  ledger: LedgerView;
  models: string[];
  log: string[];
  hasQr: boolean;
}

export type Patch =
  | { kind: 'self'; data: SelfView }
  | { kind: 'gate'; data: GateView }
  | { kind: 'traffic'; data: Traffic }
  | { kind: 'api'; data: ApiView }
  | { kind: 'peers'; data: PeerView[] }
  | { kind: 'paired'; data: PairedView[] }
  | { kind: 'devices'; data: DeviceView[] }
  | { kind: 'ledger'; data: LedgerView }
  | { kind: 'models'; data: string[] }
  | { kind: 'log'; data: string }
  | { kind: 'qr'; data: boolean };

const counter = (): Counter => ({ opens: 0, closes: 0, rejects: 0, bytesIn: 0, bytesOut: 0 });

// The passport the pc page saved for us, or the one the mac script wrote.
export function passportFiles(): string[] {
  return [path.join(home(), 'passport.json'), path.join(os.homedir(), '.kula', 'passport.json')];
}
export function readPassport(files = passportFiles()): { passport: Record<string, unknown>; file: string } | null {
  for (const file of files) {
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (p && typeof p === 'object' && typeof p.schema === 'string') return { passport: p, file };
    } catch {}
  }
  return null;
}

// The badges the app shows on a device card, from what the peer advertised.
export function badgesOf(p: Pick<Peer, 'kind' | 'ram' | 'bw' | 'gpu' | 'vram'>): string[] {
  const b: string[] = [p.kind];
  if (p.gpu) b.push('gpu');
  if ((p.bw ?? 0) >= 20) b.push('hızlı bellek');
  if ((p.ram ?? 0) >= 16000) b.push('geniş bellek');
  return b;
}

// A peer without its secret. The only way a peer leaves this module.
export function peerView(p: Peer, probe?: PeerProbe | null, probedAt: number | null = null): PeerView {
  return {
    id: p.id, name: p.name, kind: p.kind, host: p.host, port: p.port,
    ram: p.ram ?? null, bw: p.bw ?? null, gpu: p.gpu ?? null, vram: p.vram ?? null,
    badges: badgesOf(p), last_ok: p.last_ok ?? null,
    reach: probe ? { rpc: probe.rpc as Reach, api: probe.api as Reach } : null,
    probedAt,
  };
}

export class DashboardState {
  private snap: Snapshot;
  private subs = new Set<(p: Patch) => void>();
  constructor(mode: 'share' | 'chat', self: SelfView) {
    this.snap = {
      mode, startedAt: Date.now(), self,
      gate: { port: null, open: [], lastPeer: null, lastAt: null, lastReject: null },
      traffic: { rpc: counter(), api: counter() },
      api: { loaded: false, model: null, ctx: 0, busy: false, tokensUsed: 0, heldMB: 0, running: false },
      peers: [], paired: [], devices: [],
      ledger: { file: '', lines: [], total: 0, verify: null },
      models: [], log: [], hasQr: false,
    };
  }

  snapshot(): Snapshot { return structuredClone(this.snap); }

  subscribe(fn: (p: Patch) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
  private emit(p: Patch) { for (const fn of this.subs) { try { fn(p); } catch {} } }

  setSelf(s: SelfView) { this.snap.self = s; this.emit({ kind: 'self', data: s }); }
  setGatePort(port: number) { this.snap.gate.port = port; this.emit({ kind: 'gate', data: this.snap.gate }); }
  setQr(has: boolean) { this.snap.hasQr = has; this.emit({ kind: 'qr', data: has }); }

  gate(e: GateEvent) {
    const g = this.snap.gate, t = this.snap.traffic;
    if (e.type === 'open') {
      g.open.push({ peer: e.peer, channel: e.channel, since: e.at });
      g.lastPeer = e.peer; g.lastAt = e.at;
      t[e.channel].opens++;
    } else if (e.type === 'close') {
      const i = g.open.findIndex((o) => o.peer === e.peer && o.channel === e.channel);
      if (i >= 0) g.open.splice(i, 1);
      t[e.channel].closes++; t[e.channel].bytesIn += e.bytesIn; t[e.channel].bytesOut += e.bytesOut;
    } else if (e.type === 'pair') {
      // a phone paired with this computer's one-time code: a peer, not a connection
      g.lastPeer = e.peer; g.lastAt = e.at;
    } else {
      g.lastReject = { peer: e.peer, reason: e.reason, at: e.at };
      if (e.channel) t[e.channel].rejects++;
    }
    this.emit({ kind: 'gate', data: g });
    this.emit({ kind: 'traffic', data: t });
  }

  api(s: Partial<ApiStatus> & { heldMB?: number; running?: boolean }) {
    const a = this.snap.api;
    const next: ApiView = {
      loaded: s.loaded ?? a.loaded, model: s.model ?? a.model, ctx: s.ctx ?? a.ctx, busy: s.busy ?? a.busy,
      tokensUsed: s.tokensUsed ?? a.tokensUsed, heldMB: s.heldMB ?? a.heldMB, running: s.running ?? a.running,
    };
    if (JSON.stringify(next) === JSON.stringify(a)) return;
    this.snap.api = next;
    this.emit({ kind: 'api', data: next });
  }

  peers(list: PeerView[]) { this.snap.peers = list; this.emit({ kind: 'peers', data: list }); }
  paired(list: PairedView[]) {
    if (JSON.stringify(list) === JSON.stringify(this.snap.paired)) return;
    this.snap.paired = list;
    this.emit({ kind: 'paired', data: list });
  }
  devices(list: DeviceView[]) { this.snap.devices = list; this.emit({ kind: 'devices', data: list }); }
  ledger(l: LedgerView) { this.snap.ledger = l; this.emit({ kind: 'ledger', data: l }); }
  models(list: string[]) { this.snap.models = list; this.emit({ kind: 'models', data: list }); }
  log(line: string) {
    this.snap.log.push(line);
    if (this.snap.log.length > 80) this.snap.log.splice(0, this.snap.log.length - 80);
    this.emit({ kind: 'log', data: line });
  }
}
