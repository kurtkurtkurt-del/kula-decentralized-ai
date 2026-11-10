// `kula-node share`: this computer becomes a worker. One open port (the gate),
// a qr for the phone that runs the cluster, an mdns record so it can be found
// without the qr, and the two local programs started when first asked for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Bonjour } from 'bonjour-service';
import qrcode from 'qrcode-terminal';
import { startGateServer, v1Open, PIN_TTL_MS, type GateEvent, type Channel, type TlsServer } from './gate.js';
import { loadOrCreateIdentity, newPin, Paired } from './tls.js';
import { findLlama, TAG } from './llama.js';
import { home, expandHome } from './paths.js';
import { lanIPv4, freeRamMB, measureBandwidth, detectGpu } from './sysinfo.js';
import { freePort, startChild, type Child } from './children.js';
import { startApiServer, type ApiServer } from './api.js';
import { loadOrCreateKey } from './audit/key.js';
import { Ledger } from './audit/ledger.js';
import { Auditor } from './audit/auditor.js';
import { startRelayWorker, type RelayWorker } from './relay.js';
import { DashboardState } from './dashboard/state.js';
import { startDashboard, type Dashboard, type ChatSource } from './dashboard/server.js';
import { selfView, peerActions, ledgerActions, modelsIn, DASHBOARD_PORT } from './dashboard/wire.js';
import { apiChat, apiLoad, type Device, type Reply, type Message } from './apart.js';
import { sha256File } from './llama.js';

export interface ShareOptions {
  port: number;
  name?: string;
  models: string;
  secret?: string;
  lieRam?: number;
  noQr?: boolean;
  // protocol v2: the gate also speaks tls and the qr is v3 (fingerprint + one-time code).
  // the default; false (--no-tls) is the old v1-only gate, prompts in plain text
  tls?: boolean;
  // far away masters: connect out to this relay, register, put the code in the qr (docs/RELAY.md). needs tls.
  relay?: string;
  dashboard?: number | false; // the local dashboard's port on 127.0.0.1; false: none
}

// The qr the phone scans. v2 carries the shared secret (protocol v1); v3 carries
// this computer's certificate fingerprint and a one-time pairing code (protocol
// v2, docs/GATE.md). A v3 worker given a secret on purpose answers v1 clients with it
// until the first device pairs; then v1 is off (gate.ts v1Open).
export interface PeerPayload {
  k: 'kula-peer';
  v: 2 | 3;
  id: string;
  name: string;
  host: string;
  port: number;
  secret?: string;
  fp?: string;
  pin?: string;
  relay?: { url: string; code: string };
  kind: 'pc';
  ram: number;
  bw: number;
  gpu: string | null;
  vram: number;
}

export function deviceId(): string {
  const file = path.join(home(), 'id');
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (id) return id;
  } catch {}
  const id = randomUUID();
  fs.writeFileSync(file, id + '\n');
  return id;
}

export function newSecret(): string {
  return randomBytes(16).toString('hex');
}

const stamp = () => new Date().toISOString().slice(11, 19);
const logSinks = new Set<(s: string) => void>();
export const log = (s: string) => { console.log(`${stamp()}  ${s}`); for (const f of logSinks) f(`${stamp()}  ${s}`); };

// What `share` hands back: stop(), with the gate port and the dashboard on it (tests, the cli's log).
export type ShareHandle = (() => Promise<void>) & { gatePort: number; dashboard: Dashboard | null };

export async function share(opts: ShareOptions): Promise<ShareHandle> {
  const models = expandHome(opts.models);
  fs.mkdirSync(models, { recursive: true });
  const llama = findLlama();
  if (llama) log(`llama.cpp ${TAG}: ${llama.where}`);
  else log(`llama.cpp ${TAG} not found: the rpc and api channels will answer "channel closed" until you run: kula-node setup`);

  const host = lanIPv4();
  if (!host) log('no lan ipv4 address found; the phone will not reach this computer');
  if (opts.relay && opts.tls === false) throw new Error('--relay needs tls: the handshake crosses the relay and must be end to end (drop --no-tls)');
  const useTls = opts.tls !== false;
  if (!useTls) log('tls is off (--no-tls): v1 only, prompts and answers cross the network in plain text');
  // v1 needs a secret in a qr. With tls the qr carries none, so unless one was given
  // on purpose (--secret, for old phones) v1 is off: there is nothing it could prove.
  const secret: string | null = opts.secret ?? (useTls ? null : newSecret());
  const id = deviceId();
  const name = opts.name ?? os.hostname().replace(/\.local$/, '');

  log('measuring memory bandwidth (a few seconds)');
  const [bw, gpu] = await Promise.all([measureBandwidth(), detectGpu()]);
  const ram = opts.lieRam ?? freeRamMB();
  if (opts.lieRam) log(`advertising a false ram of ${opts.lieRam} MB (--lie-ram)`);

  // the local dashboard sees everything from here on; nothing in it carries the secret
  const state = new DashboardState('share', selfView({ name, id, host, ram, bw, gpu: gpu.name, vram: gpu.vramMB }));
  const logSink = (line: string) => state.log(line);
  logSinks.add(logSink);

  // every gate event goes through the auditor into the signed ledger
  const { key, broken } = loadOrCreateKey(undefined, log);
  log(`device key ${key.alg} ${key.id}`);
  const ledgerFile = path.join(home(), 'ledger.jsonl');
  const auditor = new Auditor({ ledger: new Ledger(ledgerFile, key), log });
  // the old key is not readable: the lines it signed no longer verify, and the ledger says why
  if (broken) auditor.health('self', { key: 'replaced' });
  const onEvent = (e: GateEvent) => {
    state.gate(e);
    if (e.type === 'pair') { auditor.pair(e.peer, { fp: e.fp, channel: e.channel }); log(`paired ${e.peer} (certificate ${e.fp.slice(0, 16)}…)`); }
    else if (e.type === 'open') { auditor.connect(e.peer, e.channel); log(`${e.channel} open from ${e.peer}${e.v === 2 ? ' (tls)' : ''}`); }
    else if (e.type === 'close') { auditor.end(e.peer, e.channel, e.ms, e.bytesIn, e.bytesOut); log(`${e.channel} closed from ${e.peer} after ${e.ms} ms, in ${e.bytesIn} out ${e.bytesOut} bytes`); }
    else {
      // replay and clock are written by the auditor itself when it refuses the hello
      if (e.reason !== 'replay' && e.reason !== 'clock') auditor.reject(e.peer, e.reason, e.channel ? { channel: e.channel } : {});
      log(`refused ${e.peer}${e.channel ? ' on ' + e.channel : ''}: ${e.reason}`);
    }
  };
  // what the qr claims against what this machine measured
  auditor.claim('self', 'ram', ram, freeRamMB());
  const healthTimer = setInterval(() => auditor.health('self', { freeRamMB: freeRamMB(), load1: Math.round(os.loadavg()[0] * 100) / 100 }), 60_000);
  healthTimer.unref();

  // the two local programs, started when first asked for
  let rpc: Child | null = null;
  let rpcStarting: Promise<Child> | null = null;
  let api: ApiServer | null = null;
  let apiStarting: Promise<ApiServer> | null = null;

  const startRpc = async (): Promise<Child> => {
    if (!llama) throw new Error('no llama.cpp');
    const port = await freePort();
    const cache = path.join(home(), 'rpc-cache');
    fs.mkdirSync(cache, { recursive: true });
    // ggml-rpc-server keeps its cache under $HOME/.cache; "-c" turns it on
    return startChild('ggml-rpc-server', llama.rpcServer, ['-H', '127.0.0.1', '-p', String(port), '-c'], port, log, 30000);
  };

  const targets = async (channel: Channel): Promise<number | null> => {
    if (channel === 'rpc') {
      if (!llama) return null;
      if (rpc && rpc.proc.exitCode === null) return rpc.port;
      rpc = null;
      rpcStarting ??= startRpc().finally(() => { rpcStarting = null; });
      try { rpc = await rpcStarting; return rpc.port; } catch (e) { log(`ggml-rpc-server failed: ${(e as Error).message}`); return null; }
    }
    if (api) return api.port;
    apiStarting ??= startApiServer({
      models, llama, log, onLoad: (name, want, got) => auditor.load('api', name, want, got),
      // GET /trust: the key, the certificate, the gate's state and the ledger, nothing secret
      trust: {
        key, ledgerFile,
        cert: () => tlsServer?.identity.certDer ?? null,
        gate: () => ({ v1: v1Open(secret, tlsServer), tls: !!tlsServer, paired: tlsServer?.paired.size ?? 0 }),
      },
    }).finally(() => { apiStarting = null; });
    try { api = await apiStarting; log(`api on 127.0.0.1:${api.port}`); state.api({ running: true }); return api.port; } catch (e) { log(`api failed: ${(e as Error).message}`); return null; }
  };

  // one bad connection or download must not take the worker down
  process.on('uncaughtException', (e) => log(`error: ${e.message}`));
  process.on('unhandledRejection', (e) => log(`error: ${e instanceof Error ? e.message : String(e)}`));

  // the api's state, and how much of memory the loaded file takes, every two seconds
  const apiTimer = setInterval(() => {
    if (!api) return;
    const st = api.status();
    let heldMB = 0;
    if (st.loaded && st.model) { try { heldMB = Math.round(fs.statSync(path.join(models, st.model)).size / (1024 * 1024)); } catch {} }
    state.api({ ...st, heldMB, running: true });
  }, 2000);
  apiTimer.unref();

  // protocol v2: this computer's certificate, the phones it has paired with, a one-time code per qr
  let tlsServer: TlsServer | undefined;
  let relay: RelayWorker | null = null;
  let qrText = ''; // the last qr printed: the dashboard shows the same one
  const printQr = (port: number) => {
    const common = { k: 'kula-peer' as const, id, name, host: host ?? '0.0.0.0', port, kind: 'pc' as const, ram, bw, gpu: gpu.name, vram: gpu.vramMB };
    const payload: PeerPayload = tlsServer ? { ...common, v: 3, fp: tlsServer.identity.fp, pin: tlsServer.pin ?? undefined } : { ...common, v: 2, secret: secret! };
    if (relay?.code && opts.relay) payload.relay = { url: opts.relay, code: relay.code };
    const text = JSON.stringify(payload);
    qrText = text;
    if (!opts.noQr) qrcode.generate(text, { small: true }, (q) => console.log(q));
    console.log(text);
    if (payload.relay) console.log(`far away: kula-node peers add "${payload.relay.code}${payload.pin ? ' ' + payload.pin : ''}" --relay ${payload.relay.url}`);
    console.log();
  };
  if (useTls) {
    const identity = loadOrCreateIdentity(home(), key, log);
    const paired = new Paired(path.join(home(), 'paired'));
    tlsServer = { identity, paired, pin: newPin(), pinExpiresAt: Date.now() + PIN_TTL_MS };
    // the code is spent by the phone that used it, or by time; the next qr gets a fresh one
    tlsServer.onPinUsed = () => { tlsServer!.pin = newPin(); tlsServer!.pinExpiresAt = Date.now() + PIN_TTL_MS; log('pairing code used or expired; a new qr follows'); printQr(opts.port); };
    log(`tls certificate ${identity.fp.slice(0, 16)}… (${paired.size} paired); ${!secret ? 'v1 off' : paired.size ? 'v1 off (a device is paired; --secret is not used)' : 'v1 on (--secret) until the first device pairs'}`);
  }

  const gate = await startGateServer({ port: opts.port, secret, targets, onEvent, admit: (peer, nonceC, unixMs) => auditor.hello(peer, nonceC, unixMs), tls: tlsServer });
  log(`gate listening on 0.0.0.0:${gate.port}${tlsServer ? (v1Open(secret, tlsServer) ? ' (v1 and v2 tls)' : ' (v2 tls only)') : ' (v1 only, no tls)'}`);
  if (opts.relay) {
    // the relay sees this computer's id, name and certificate fingerprint, nothing more; a
    // relayed stream reaches the gate from 127.0.0.1 and is served like any other
    try {
      relay = await startRelayWorker({
        url: opts.relay, id, name, fp: tlsServer!.identity.fp, gatePort: gate.port, log,
        onCode: (code, ttl) => { log(`relay code ${code} (good for ${Math.round(ttl / 60)} min)`); if (relay) printQr(gate.port); },
        onMaster: (state) => log(state === 'connected' ? 'a master came in through the relay' : 'the master left the relay'),
      });
    } catch (e) {
      log(`relay: ${(e as Error).message}; sharing on the lan only`);
    }
  }
  state.setGatePort(gate.port);
  printQr(gate.port);

  // the dashboard: the peer book, the ledger, a chat box against the local api
  let dashboard: Dashboard | null = null;
  const peersUi = peerActions(state);
  const ledgerUi = ledgerActions(state);
  state.models(modelsIn(models));
  if (opts.dashboard !== false) {
    try {
      dashboard = await startDashboard({
        port: opts.dashboard ?? DASHBOARD_PORT,
        state,
        qrText: () => qrText,
        chat: localChatSource(() => targets('api'), models, name),
        actions: {
          probe: peersUi.probe,
          verify: ledgerUi.verify,
          load: async (file) => {
            const port = await targets('api');
            if (!port) throw new Error('the api did not start (is llama.cpp installed? kula-node setup)');
            const full = path.join(models, path.basename(file));
            if (!fs.existsSync(full)) throw new Error('no such model in ' + models);
            const sha256 = await sha256File(full);
            await apiLoad(port, { url: 'file://' + full, sha256, size: fs.statSync(full).size, name: path.basename(full), ctx: 4096 });
            state.models(modelsIn(models));
          },
        },
        log,
      });
      state.setQr(true);
      ledgerUi.watch();
      peersUi.probe().catch(() => {});
    } catch (e) {
      log(`dashboard did not start: ${(e as Error).message} (another kula-node? --dashboard <port> or --no-dashboard)`);
    }
  }

  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: `kula ${name} ${id.slice(0, 8)}`,
    type: 'kula',
    protocol: 'tcp',
    port: gate.port,
    txt: { id, ram: String(ram), bw: String(bw), name, kind: 'pc', v: 'rpc7' },
  });
  service.on('error', (e: Error) => log(`mdns: ${e.message}`));
  log(`mdns _kula._tcp announced as "${name}"`);
  log('waiting for the phone. ctrl-c to stop.');

  let stopping = false;
  const stop: ShareHandle = Object.assign(async () => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    await new Promise<void>((r) => bonjour.unpublishAll(() => r()));
    bonjour.destroy();
    await relay?.close();
    await gate.close();
    if (api) await api.close();
    if (rpc) await rpc.stop();
    clearInterval(healthTimer);
    clearInterval(apiTimer);
    ledgerUi.stop();
    logSinks.delete(logSink);
    if (dashboard) await dashboard.close();
  }, { gatePort: gate.port, dashboard });
  return stop;
}

// The dashboard's chat box in share mode talks to this computer's own worker
// api, one prompt at a time, the same wire a master would use.
export function localChatSource(apiPort: () => Promise<number | null>, models: string, name: string): ChatSource {
  const device = async (): Promise<Device> => {
    const port = await apiPort();
    if (!port) throw new Error('the api did not start: run kula-node setup, then load a model');
    const st = await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json()).catch(() => null) as { loaded?: boolean } | null;
    if (!st?.loaded) throw new Error('no model loaded here yet: pick one above (' + models + ')');
    return { id: 'self', name, local: true, apiPort: port, bw: 0, busy: false, tps: null, done: 0, close: async () => {} };
  };
  let chain: Promise<unknown> = Promise.resolve();
  const one = async (messages: Message[], onToken: (t: string) => void, maxTokens: number, reset: boolean): Promise<Reply> => {
    const dev = await device();
    const run = chain.then(() => apiChat(dev, messages, onToken, { maxTokens, temperature: 0.7, reset }));
    chain = run.catch(() => {});
    return run;
  };
  return {
    chat: (messages, onToken, o) => one(messages, onToken, o.maxTokens ?? 256, false),
    batch: async (prompts, o) => {
      const out: Reply[] = [];
      for (const [i, p] of prompts.entries()) {
        const r = await one([{ role: 'user', content: p }], () => {}, o.maxTokens ?? 128, true);
        out.push(r);
        o.onReply?.(i, r);
      }
      return out;
    },
  };
}
