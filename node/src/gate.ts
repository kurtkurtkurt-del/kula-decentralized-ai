// The gate: the one port a kula device opens. A short line based handshake
// proves both sides know the cluster secret, then the connection is piped raw
// to a local target (the rpc server or the api server). This must stay byte for
// byte identical to the Kotlin gate in app/modules/kula-llama.
import net from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type Channel = 'rpc' | 'api';
export const CHANNELS: Channel[] = ['rpc', 'api'];
export const HANDSHAKE_MS = 5000;

export type GateEvent =
  | { type: 'open'; channel: Channel; peer: string; at: number }
  | { type: 'close'; channel: Channel; peer: string; at: number; ms: number; bytesIn: number; bytesOut: number }
  | { type: 'reject'; channel: Channel | null; peer: string; at: number; reason: string };

export function nonce(): string {
  return randomBytes(16).toString('hex');
}

export function isNonce(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
}

function hmac(secret: string, message: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(message, 'utf8').digest('hex');
}

// What the client must send: HMAC(secret, nonce_c|nonce_s|channel).
export function clientProof(secret: string, nonceC: string, nonceS: string, channel: string): string {
  return hmac(secret, `${nonceC}|${nonceS}|${channel}`);
}

// What the server answers with: HMAC(secret, nonce_s|nonce_c|channel).
export function serverProof(secret: string, nonceC: string, nonceS: string, channel: string): string {
  return hmac(secret, `${nonceS}|${nonceC}|${channel}`);
}

export function sameHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Reads "\n" terminated lines from a socket while keeping whatever came after
// the last line, so the raw pipe that follows loses nothing.
export class LineReader {
  private buf: Buffer = Buffer.alloc(0);
  private waiting: { resolve: (line: string) => void; reject: (e: Error) => void } | null = null;
  private closed: Error | null = null;
  private readonly onData = (chunk: Buffer) => {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.flush();
  };
  private readonly onEnd = () => {
    this.closed = new Error('connection closed');
    this.flush();
  };
  private readonly onError = (e: Error) => {
    this.closed = e;
    this.flush();
  };

  constructor(private readonly socket: net.Socket) {
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
    socket.on('error', this.onError);
  }

  private flush() {
    if (!this.waiting) return;
    const i = this.buf.indexOf(10);
    if (i >= 0) {
      const line = this.buf.subarray(0, i).toString('utf8');
      this.buf = this.buf.subarray(i + 1);
      const w = this.waiting;
      this.waiting = null;
      w.resolve(line);
    } else if (this.closed) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(this.closed);
    } else if (this.buf.length > 4096) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(new Error('line too long'));
    }
  }

  line(timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting) {
          this.waiting = null;
          reject(new Error('timeout'));
        }
      }, timeoutMs);
      this.waiting = {
        resolve: (l) => { clearTimeout(timer); resolve(l); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.flush();
    });
  }

  // Stops reading lines and hands back the bytes that arrived after the last one.
  release(): Buffer {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    this.socket.off('error', this.onError);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

function writeLine(socket: net.Socket, line: string) {
  socket.write(line + '\n');
}

// Pipes a <-> b after the handshake. `fromA` is what the line reader on `a`
// had already buffered: it goes to b first. Resolves with byte counts when
// either side closes.
export function pipeBoth(a: net.Socket, b: net.Socket, fromA: Buffer, fromB: Buffer = Buffer.alloc(0)): Promise<{ aToB: number; bToA: number }> {
  return new Promise((resolve) => {
    let aToB = fromA.length;
    let bToA = fromB.length;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      a.destroy();
      b.destroy();
      resolve({ aToB, bToA });
    };
    a.on('data', (c: Buffer) => { aToB += c.length; });
    b.on('data', (c: Buffer) => { bToA += c.length; });
    a.on('error', finish);
    b.on('error', finish);
    a.on('close', finish);
    b.on('close', finish);
    if (fromA.length) b.write(fromA);
    if (fromB.length) a.write(fromB);
    a.pipe(b);
    b.pipe(a);
  });
}

export type Targets = (channel: Channel) => number | null | Promise<number | null>;

// Called with every well formed hello before the server answers. The fourth
// hello field, the client's clock in unix ms, is null when it was not sent.
// A string refuses the connection with that reason (replay, clock).
export type Admit = (peer: string, nonceC: string, unixMs: number | null) => string | null;

export interface GateServerOptions {
  port: number;
  host?: string;
  secret: string;
  targets: Targets;
  onEvent?: (e: GateEvent) => void;
  admit?: Admit;
}

export interface GateServer {
  port: number;
  server: net.Server;
  close(): Promise<void>;
}

function connectLocal(port: number, timeoutMs = 3000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export async function startGateServer(opts: GateServerOptions): Promise<GateServer> {
  const emit = opts.onEvent ?? (() => {});
  // The rpc channel is one remote peer at a time: the ip that holds it and how
  // many of its connections are open.
  let rpcPeer: string | null = null;
  let rpcOpen = 0;

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const peer = socket.remoteAddress ?? '?';
    const reader = new LineReader(socket);
    let channel: Channel | null = null;

    const refuse = (reason: string) => {
      emit({ type: 'reject', channel, peer, at: Date.now(), reason });
      try { writeLine(socket, `NO ${reason}`); } catch {}
      socket.end();
      setTimeout(() => socket.destroy(), 200);
    };

    (async () => {
      let hello: string;
      try { hello = await reader.line(HANDSHAKE_MS); } catch { return refuse('no hello'); }
      const parts = hello.split(' ');
      if ((parts.length !== 3 && parts.length !== 4) || parts[0] !== 'KULA1') return refuse('bad hello');
      if (!CHANNELS.includes(parts[1] as Channel)) return refuse('bad channel');
      channel = parts[1] as Channel;
      const nonceC = parts[2];
      if (!isNonce(nonceC)) return refuse('bad nonce');
      let unixMs: number | null = null;
      if (parts.length === 4) {
        if (!/^\d{1,16}$/.test(parts[3])) return refuse('bad hello');
        unixMs = Number(parts[3]);
      }
      if (opts.admit) {
        const why = opts.admit(peer, nonceC, unixMs);
        if (why) return refuse(why);
      }
      const nonceS = nonce();
      writeLine(socket, nonceS);
      let proof: string;
      try { proof = await reader.line(HANDSHAKE_MS); } catch { return refuse('no proof'); }
      if (!sameHex(proof, clientProof(opts.secret, nonceC, nonceS, channel))) return refuse('wrong secret');

      let targetPort: number | null = null;
      try { targetPort = await opts.targets(channel); } catch { targetPort = null; }
      if (targetPort == null) return refuse('channel closed');
      if (channel === 'rpc' && rpcPeer !== null && rpcPeer !== peer && rpcOpen > 0) return refuse('busy');
      let target: net.Socket;
      try { target = await connectLocal(targetPort); } catch { return refuse('target down'); }
      target.setNoDelay(true);
      if (channel === 'rpc') { rpcPeer = peer; rpcOpen++; }

      socket.setTimeout(0);
      writeLine(socket, `OK ${serverProof(opts.secret, nonceC, nonceS, channel)}`);
      const rest = reader.release();
      const at = Date.now();
      emit({ type: 'open', channel, peer, at });
      const counts = await pipeBoth(socket, target, rest);
      if (channel === 'rpc') { rpcOpen--; if (rpcOpen === 0) rpcPeer = null; }
      emit({ type: 'close', channel, peer, at: Date.now(), ms: Date.now() - at, bytesIn: counts.aToB, bytesOut: counts.bToA });
    })().catch(() => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => { server.off('error', reject); resolve(); });
  });
  const addr = server.address() as net.AddressInfo;
  return {
    port: addr.port,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export class GateRefused extends Error {
  constructor(public readonly reason: string) {
    super(`NO ${reason}`);
  }
}

// Client side. On success the socket is ready for raw traffic; `rest` is what
// the server already sent after its OK line (normally nothing).
export async function handshake(socket: net.Socket, secret: string, channel: Channel, timeoutMs = HANDSHAKE_MS, clockMs?: number): Promise<{ rest: Buffer }> {
  const reader = new LineReader(socket);
  try {
    const nonceC = nonce();
    writeLine(socket, clockMs === undefined ? `KULA1 ${channel} ${nonceC}` : `KULA1 ${channel} ${nonceC} ${clockMs}`);
    const nonceS = await reader.line(timeoutMs);
    if (nonceS.startsWith('NO ')) throw new GateRefused(nonceS.slice(3));
    if (!isNonce(nonceS)) throw new Error(`bad server nonce: ${JSON.stringify(nonceS)}`);
    writeLine(socket, clientProof(secret, nonceC, nonceS, channel));
    const answer = await reader.line(timeoutMs);
    if (answer.startsWith('NO ')) throw new GateRefused(answer.slice(3));
    if (!answer.startsWith('OK ')) throw new Error(`bad server answer: ${JSON.stringify(answer)}`);
    if (!sameHex(answer.slice(3), serverProof(secret, nonceC, nonceS, channel))) throw new Error('server failed its proof');
    return { rest: reader.release() };
  } catch (e) {
    reader.release();
    throw e;
  }
}

export function connectRemote(host: string, port: number, timeoutMs = 3000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export type ProbeResult = { ok: true; ms: number } | { ok: false; reason: string };

// Does one handshake and hangs up. `reason` is the server's NO reason or the
// local error.
export async function probe(host: string, port: number, secret: string, channel: Channel, timeoutMs = 2000): Promise<ProbeResult> {
  const t0 = Date.now();
  let socket: net.Socket | null = null;
  try {
    socket = await connectRemote(host, port, timeoutMs);
    await handshake(socket, secret, channel, timeoutMs);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof GateRefused) return { ok: false, reason: e.reason };
    return { ok: false, reason: (e as Error).message };
  } finally {
    socket?.destroy();
  }
}

// A local door to a remote channel: listens on 127.0.0.1 and pipes every
// accepted connection through a freshly handshaken connection to the gate.
export class Tunnel {
  private server: net.Server | null = null;
  port = 0;

  constructor(
    readonly host: string,
    readonly gatePort: number,
    readonly secret: string,
    readonly channel: Channel,
  ) {}

  async listen(localPort = 0): Promise<number> {
    const server = net.createServer(async (local) => {
      local.setNoDelay(true);
      let remote: net.Socket | null = null;
      try {
        remote = await connectRemote(this.host, this.gatePort);
        remote.setNoDelay(true);
        const { rest } = await handshake(remote, this.secret, this.channel);
        await pipeBoth(remote, local, rest);
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
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }
}
