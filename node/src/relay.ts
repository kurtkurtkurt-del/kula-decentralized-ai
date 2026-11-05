// Both ends of a relayed connection (node/relay/ is the server between them).
// The worker side connects out to the relay and registers; for every stream the
// relay announces it opens a second connection and pipes it into the local gate,
// so the gate serves a far away master exactly as it serves one on the lan: the
// TLS handshake of protocol v2 runs inside the relayed bytes, end to end. The
// master side connects out with the code, then opens one relayed stream per gate
// connection; RelayTunnel is Tunnel (gate.ts) with the relay for a road.
import net from 'node:net';
import { Duplex } from 'node:stream';
import { WebSocket, createWebSocketStream } from 'ws';
import { handshake, pipeBoth, GateRefused, HANDSHAKE_MS, type Channel, type TlsClient } from './gate.js';

type Log = (s: string) => void;

export interface RelayRef { url: string; code: string }

export const CODE_RE = /^\d{6}$/;

// "wss://relay.example/ws" or "ws://127.0.0.1:8787": the scheme is checked here so a
// pasted https:// turns into wss://.
export function normalizeRelayUrl(url: string): string {
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return u.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(u)) throw new Error('relay url must start with wss:// or ws://');
  return u;
}

function openWs(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('relay timeout')); }, timeoutMs);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(new Error(`relay: ${e.message}`)); });
  });
}

// Sends one JSON frame and waits for the next text frame.
function ask(ws: WebSocket, msg: Record<string, unknown>, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay: no answer')), timeoutMs);
    const onClose = (code: number, reason: Buffer) => { clearTimeout(timer); reject(new Error(`relay: ${reason.toString() || `closed ${code}`}`)); };
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      ws.off('close', onClose);
      if (isBinary) return reject(new Error('relay: binary before ready'));
      try { resolve(JSON.parse(data.toString())); } catch { reject(new Error('relay: bad answer')); }
    });
    ws.once('close', onClose);
    ws.send(JSON.stringify(msg));
  });
}

const say = (o: any): string => (o && o.t === 'error' ? String(o.reason) : `unexpected ${JSON.stringify(o)}`);

// --- worker side ------------------------------------------------------------------

export interface RelayWorkerOptions {
  url: string;
  id: string;
  name: string;
  fp: string | null;     // this worker's certificate fingerprint (the relay passes it on, the master still checks it)
  gatePort: number;      // the local gate every relayed stream is piped into
  log?: Log;
  onCode?: (code: string, ttlS: number) => void;
  onMaster?: (state: 'connected' | 'gone') => void;
  retryMs?: number;      // first reconnect delay (doubles up to 30 s)
}

export interface RelayWorker {
  readonly code: string | null;
  readonly connected: boolean;
  close(): Promise<void>;
}

// Registers with the relay and keeps registering after a drop (a phone's network
// changes); resolves once the first code is in hand, rejects when the first
// attempt fails outright.
export function startRelayWorker(opts: RelayWorkerOptions): Promise<RelayWorker> {
  const log = opts.log ?? (() => {});
  const url = normalizeRelayUrl(opts.url);
  let code: string | null = null;
  let control: WebSocket | null = null;
  let token = '';
  let closed = false;
  let delay = opts.retryMs ?? 1000;
  const streams = new Set<WebSocket>();

  const accept = async (sid: number) => {
    let ws: WebSocket | null = null;
    let local: net.Socket | null = null;
    try {
      ws = await openWs(url, HANDSHAKE_MS);
      streams.add(ws);
      ws.once('close', () => streams.delete(ws!));
      const r = await ask(ws, { t: 'accept', sid, token }, HANDSHAKE_MS);
      if (r?.t !== 'ready') throw new Error(say(r));
      local = net.connect({ host: '127.0.0.1', port: opts.gatePort, allowHalfOpen: true });
      await new Promise<void>((res, rej) => { local!.once('connect', res); local!.once('error', rej); });
      local.setNoDelay(true);
      const stream = createWebSocketStream(ws, { allowHalfOpen: false });
      stream.on('error', () => {});
      await pipeBoth(stream, local, Buffer.alloc(0));
    } catch (e) {
      log(`relay stream ${sid}: ${(e as Error).message}`);
      ws?.close();
      local?.destroy();
    }
  };

  const connect = (): Promise<void> => new Promise((resolve, reject) => {
    openWs(url, 10_000).then(async (ws) => {
      control = ws;
      try {
        const r = await ask(ws, { t: 'register', id: opts.id, name: opts.name, fp: opts.fp ?? undefined }, 10_000);
        if (r?.t !== 'registered') throw new Error(say(r));
        code = String(r.code); token = String(r.token);
        delay = opts.retryMs ?? 1000;
        log(`relay: registered at ${url}, code ${code} (${r.ttl_s} s)`);
        opts.onCode?.(code, Number(r.ttl_s));
      } catch (e) { ws.close(); return reject(e); }
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.t === 'open') void accept(Number(m.sid));
        else if (m.t === 'code') { code = String(m.code); log(`relay: new code ${code}`); opts.onCode?.(code, Number(m.ttl_s)); }
        else if (m.t === 'master') { log(`relay: master ${m.state}`); opts.onMaster?.(m.state); }
      });
      ws.on('error', () => {});
      ws.once('close', (c, reason) => {
        control = null; code = null;
        if (closed) return;
        log(`relay: connection lost (${reason.toString() || c}); again in ${delay / 1000} s`);
        setTimeout(() => { if (!closed) connect().catch((e) => log(`relay: ${(e as Error).message}`)); }, delay).unref();
        delay = Math.min(delay * 2, 30_000);
      });
      resolve();
    }).catch(reject);
  });

  return connect().then(() => ({
    get code() { return code; },
    get connected() { return control?.readyState === WebSocket.OPEN; },
    close: async () => {
      closed = true;
      control?.close(1000, 'bye');
      for (const s of streams) s.close(1000, 'bye');
    },
  }));
}

// --- master side ------------------------------------------------------------------

export interface RelayWorkerInfo { id: string; name: string; fp: string | null }

// One master session with a far away worker: the control connection that holds
// the code, and a stream per gate connection.
export class RelayMaster {
  private constructor(readonly url: string, private readonly control: WebSocket, readonly session: string, readonly worker: RelayWorkerInfo) {
    control.on('error', () => {});
    control.once('close', () => { this.gone = true; });
  }
  gone = false;

  static async connect(url: string, code: string, timeoutMs = 10_000): Promise<RelayMaster> {
    const u = normalizeRelayUrl(url);
    if (!CODE_RE.test(code)) throw new Error('a relay code is six digits');
    const ws = await openWs(u, timeoutMs);
    const r = await ask(ws, { t: 'connect', code }, timeoutMs).catch((e) => { ws.close(); throw e; });
    if (r?.t !== 'connected') { ws.close(); throw new GateRefused(say(r)); }
    return new RelayMaster(u, ws, String(r.session), { id: String(r.worker?.id ?? ''), name: String(r.worker?.name ?? ''), fp: r.worker?.fp ?? null });
  }

  // A relayed byte stream to the worker's gate, ready for the handshake.
  async open(timeoutMs = HANDSHAKE_MS * 3): Promise<Duplex> {
    if (this.gone) throw new Error('relay: session ended');
    const ws = await openWs(this.url, timeoutMs);
    const r = await ask(ws, { t: 'stream', session: this.session }, timeoutMs).catch((e) => { ws.close(); throw e; });
    if (r?.t !== 'ready') { ws.close(); throw new Error(`relay: ${say(r)}`); }
    const d = createWebSocketStream(ws, { allowHalfOpen: false });
    d.on('error', () => {});
    return d;
  }

  close(): void {
    this.control.close(1000, 'bye');
  }
}

export type RelayProbe = { ok: true; ms: number; fp: string | null; worker: RelayWorkerInfo } | { ok: false; reason: string };

// One relayed handshake on a channel and hang up: is the far worker there and are we
// allowed in? Returns the worker's fingerprint so a code-only peer can pin it.
export async function probeRelay(relay: RelayRef, channel: Channel, tlsOpts: TlsClient, timeoutMs = 8000): Promise<RelayProbe> {
  const t0 = Date.now();
  let m: RelayMaster | null = null;
  let d: Duplex | null = null;
  try {
    m = await RelayMaster.connect(relay.url, relay.code, timeoutMs);
    d = await m.open(timeoutMs);
    const h = await handshake(d, '', channel, timeoutMs, undefined, tlsOpts);
    h.socket.destroy();
    return { ok: true, ms: Date.now() - t0, fp: h.fp, worker: m.worker };
  } catch (e) {
    if (e instanceof GateRefused) return { ok: false, reason: e.reason };
    return { ok: false, reason: (e as Error).message };
  } finally {
    d?.destroy();
    m?.close();
  }
}

// Tunnel (gate.ts) over the relay: a local door on 127.0.0.1 whose every connection
// becomes a relayed stream with a fresh gate handshake. `onFp` hears the worker's
// fingerprint after the first handshake so the peer book can pin it.
export class RelayTunnel {
  private server: net.Server | null = null;
  private readonly open = new Set<net.Socket>();
  private master: RelayMaster | null = null;
  port = 0;

  constructor(readonly relay: RelayRef, readonly channel: Channel, readonly tls: TlsClient, private readonly onFp?: (fp: string) => void) {}

  async listen(localPort = 0): Promise<number> {
    this.master = await RelayMaster.connect(this.relay.url, this.relay.code);
    const server = net.createServer({ allowHalfOpen: true }, async (local) => {
      local.on('error', () => {});
      this.open.add(local);
      local.once('close', () => this.open.delete(local));
      local.setNoDelay(true);
      let remote: Duplex | null = null;
      try {
        if (!this.master || this.master.gone) this.master = await RelayMaster.connect(this.relay.url, this.relay.code);
        remote = await this.master.open();
        const { rest, socket, fp } = await handshake(remote, '', this.channel, HANDSHAKE_MS * 2, undefined, this.tls);
        if (fp) { if (!this.tls.fp) this.tls.fp = fp; if (this.tls.pin) this.tls.pin = null; this.onFp?.(fp); }
        await pipeBoth(socket, local, rest);
      } catch {
        local.destroy();
        remote?.destroy();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(localPort, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    this.port = (server.address() as net.AddressInfo).port;
    return this.port;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.master?.close();
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      for (const s of this.open) s.destroy();
      this.server = null;
    });
  }
}
