// `kula-node share`: this computer becomes a worker. One open port (the gate),
// a qr for the phone that runs the cluster, an mdns record so it can be found
// without the qr, and the two local programs started when first asked for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Bonjour } from 'bonjour-service';
import qrcode from 'qrcode-terminal';
import { startGateServer, type GateEvent, type Channel } from './gate.js';
import { findLlama, TAG } from './llama.js';
import { home, expandHome } from './paths.js';
import { lanIPv4, freeRamMB, measureBandwidth, detectGpu } from './sysinfo.js';
import { freePort, startChild, type Child } from './children.js';
import { startApiServer, type ApiServer } from './api.js';
import { loadOrCreate } from './audit/key.js';
import { Ledger } from './audit/ledger.js';
import { Auditor } from './audit/auditor.js';

export interface ShareOptions {
  port: number;
  name?: string;
  models: string;
  secret?: string;
  lieRam?: number;
  noQr?: boolean;
}

export interface PeerPayload {
  k: 'kula-peer';
  v: 2;
  id: string;
  name: string;
  host: string;
  port: number;
  secret: string;
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
export const log = (s: string) => console.log(`${stamp()}  ${s}`);

export async function share(opts: ShareOptions): Promise<() => Promise<void>> {
  const models = expandHome(opts.models);
  fs.mkdirSync(models, { recursive: true });
  const llama = findLlama();
  if (llama) log(`llama.cpp ${TAG}: ${llama.where}`);
  else log(`llama.cpp ${TAG} not found: the rpc and api channels will answer "channel closed" until you run: kula-node setup`);

  const host = lanIPv4();
  if (!host) log('no lan ipv4 address found; the phone will not reach this computer');
  const secret = opts.secret ?? newSecret();
  const id = deviceId();
  const name = opts.name ?? os.hostname().replace(/\.local$/, '');

  log('measuring memory bandwidth (a few seconds)');
  const [bw, gpu] = await Promise.all([measureBandwidth(), detectGpu()]);
  const ram = opts.lieRam ?? freeRamMB();
  if (opts.lieRam) log(`advertising a false ram of ${opts.lieRam} MB (--lie-ram)`);

  // every gate event goes through the auditor into the signed ledger
  const key = loadOrCreate();
  log(`device key ${key.alg} ${key.id}`);
  const auditor = new Auditor({ ledger: new Ledger(path.join(home(), 'ledger.jsonl'), key), log });
  const onEvent = (e: GateEvent) => {
    if (e.type === 'open') { auditor.connect(e.peer, e.channel); log(`${e.channel} open from ${e.peer}`); }
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
    apiStarting ??= startApiServer({ models, llama, log, onLoad: (name, want, got) => auditor.load('api', name, want, got) }).finally(() => { apiStarting = null; });
    try { api = await apiStarting; log(`api on 127.0.0.1:${api.port}`); return api.port; } catch (e) { log(`api failed: ${(e as Error).message}`); return null; }
  };

  // one bad connection or download must not take the worker down
  process.on('uncaughtException', (e) => log(`error: ${e.message}`));
  process.on('unhandledRejection', (e) => log(`error: ${e instanceof Error ? e.message : String(e)}`));

  const gate = await startGateServer({ port: opts.port, secret, targets, onEvent, admit: (peer, nonceC, unixMs) => auditor.hello(peer, nonceC, unixMs) });
  log(`gate listening on 0.0.0.0:${gate.port}`);

  const payload: PeerPayload = { k: 'kula-peer', v: 2, id, name, host: host ?? '0.0.0.0', port: gate.port, secret, kind: 'pc', ram, bw, gpu: gpu.name, vram: gpu.vramMB };
  const text = JSON.stringify(payload);
  if (!opts.noQr) qrcode.generate(text, { small: true }, (q) => console.log(q));
  console.log(text);
  console.log();

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
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    await new Promise<void>((r) => bonjour.unpublishAll(() => r()));
    bonjour.destroy();
    await gate.close();
    if (api) await api.close();
    if (rpc) await rpc.stop();
    clearInterval(healthTimer);
  };
  return stop;
}
