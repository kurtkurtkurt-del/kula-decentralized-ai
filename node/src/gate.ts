// The gate: the one port a kula device opens. Two protocols share it and the
// server tells them apart by the first byte: a TLS ClientHello starts with 0x16,
// a v1 hello with 'K'. v1 is a line based handshake that proves both sides know
// the cluster secret; v2 is TLS 1.3 between two self-signed certificates (pinned
// by fingerprint, paired once with a one-time code) with a short hello inside.
// Either way the connection is then piped raw to a local target (the rpc server
// or the api server). This must stay byte for byte identical to the Kotlin gate
// in app/modules/kula-llama (Gate.kt); docs/GATE.md describes both protocols.
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ReplayCheck, clockCheck } from './audit/checks.js';
import { fingerprint, type GateIdentity, type Paired } from './tls.js';

export type Channel = 'rpc' | 'api';
export const CHANNELS: Channel[] = ['rpc', 'api'];
export const HANDSHAKE_MS = 5000;
export const FP_MISMATCH = 'fingerprint mismatch';
// Connections allowed to sit in a handshake at once; the next one is told "NO overloaded"
// and dropped at once, so a flood of half-open connections cannot pin memory or threads.
export const MAX_HANDSHAKES = 32;
// A pairing code lives this long after it was made (shown in a qr); then "NO pin expired"
// and a fresh one is made, so a photographed qr stops working in minutes, not days.
export const PIN_TTL_MS = 10 * 60_000;

// v: which protocol the connection spoke; fp: the client's certificate fingerprint (v2).
export type GateEvent =
  | { type: 'open'; channel: Channel; peer: string; at: number; v: 1 | 2; fp?: string }
  | { type: 'close'; channel: Channel; peer: string; at: number; ms: number; bytesIn: number; bytesOut: number; v: 1 | 2; fp?: string }
  | { type: 'reject'; channel: Channel | null; peer: string; at: number; reason: string; v: 1 | 2; fp?: string }
  | { type: 'pair'; channel: Channel; peer: string; at: number; v: 2; fp: string };

// The worker's side of v2: its identity, the clients it already trusts and the
// current one-time pairing code (null: none open). The code is spent by the first
// client that proves it; onPinUsed is where share() makes the next one.
export interface TlsServer {
  identity: GateIdentity;
  paired: Paired;
  pin: string | null;
  // when `pin` stops working (unix ms); unset: no expiry (tests, dev-gate)
  pinExpiresAt?: number | null;
  onPinUsed?: () => void;
}

// The master's side of v2: its identity, the worker's fingerprint from the qr
// and, until paired, the pairing code.
export interface TlsClient {
  identity: GateIdentity;
  fp: string;
  pin?: string | null;
}

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

// v2 pairing proofs, both ways: fp_s is the worker's fingerprint, fp_c the client's.
export function pinProofClient(pin: string, nonceC: string, nonceS: string, channel: string, fpS: string, fpC: string): string {
  return hmac(pin, `${nonceC}|${nonceS}|${channel}|${fpS}|${fpC}`);
}

export function pinProofServer(pin: string, nonceC: string, nonceS: string, channel: string, fpS: string, fpC: string): string {
  return hmac(pin, `${nonceS}|${nonceC}|${channel}|${fpS}|${fpC}`);
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

  constructor(private readonly socket: Duplex) {
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
    socket.on('error', this.onError);
  }

  // Bytes that were read before this reader existed (the protocol sniff).
  feed(chunk: Buffer) { this.onData(chunk); }

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

function writeLine(socket: Duplex, line: string) {
  socket.write(line + '\n');
}

// Pipes a <-> b after the handshake. `fromA` is what the line reader on `a`
// had already buffered: it goes to b first. Resolves with byte counts when
// either side closes.
export function pipeBoth(a: Duplex, b: Duplex, fromA: Buffer, fromB: Buffer = Buffer.alloc(0)): Promise<{ aToB: number; bToA: number }> {
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
  // the v1 secret; null turns v1 off: a plain hello is told "NO no v1" (a v2 worker that
  // never handed out a secret has no reason to take the unauthenticated-tls path)
  secret: string | null;
  targets: Targets;
  onEvent?: (e: GateEvent) => void;
  admit?: Admit;
  // with this the port also speaks v2 (tls); without it a tls client is told "NO no tls"
  tls?: TlsServer;
}

// A duplex over a socket whose first bytes were already read: the TLS wrapper
// takes over a net.Socket's handle and would lose what the sniff consumed, so it
// gets this stream instead.
function prefixed(sock: net.Socket, first: Buffer): Duplex {
  const d = new Duplex({
    read() { sock.resume(); },
    write(chunk, _enc, cb) { sock.write(chunk, cb); },
    final(cb) { sock.end(cb); },
    destroy(err, cb) { sock.destroy(); cb(err); },
  });
  d.push(first);
  sock.on('data', (c: Buffer) => { if (!d.push(c)) sock.pause(); });
  sock.on('end', () => d.push(null));
  sock.on('error', (e) => d.destroy(e));
  sock.on('close', () => d.destroy());
  return d;
}

function waitFirstChunk(socket: net.Socket, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { socket.off('data', on); resolve(null); }, timeoutMs);
    const done = () => { clearTimeout(t); socket.off('data', on); resolve(null); };
    const on = (c: Buffer) => { clearTimeout(t); socket.off('end', done); socket.off('close', done); resolve(c); };
    socket.once('data', on);
    socket.once('end', done);
    socket.once('close', done);
  });
}

// Fingerprint of the certificate the other side showed, null when it showed none.
export function peerFingerprint(socket: tls.TLSSocket): string | null {
  const cert = socket.getPeerCertificate();
  return cert && cert.raw ? fingerprint(cert.raw) : null;
}

export interface GateServer {
  port: number;
  server: net.Server;
  close(): Promise<void>;
}

function connectLocal(port: number, timeoutMs = 3000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
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
  // v2 checks replays and clocks itself when no admit hook does
  const ring = new ReplayCheck();
  const secureContext = opts.tls ? tls.createSecureContext({ key: opts.tls.identity.keyPem, cert: opts.tls.identity.certPem, minVersion: 'TLSv1.3' }) : null;

  // After the proof: find the target, say OK, pipe until either side closes. `handshakeDone`
  // gives the handshake slot back once the connection is piped.
  const admitted = async (socket: Duplex, peer: string, channel: Channel, okLine: string, rest: Buffer, v: 1 | 2, fp: string | undefined, refuse: (reason: string) => void, handshakeDone: () => void) => {
    let targetPort: number | null = null;
    try { targetPort = await opts.targets(channel); } catch { targetPort = null; }
    if (targetPort == null) return refuse('channel closed');
    if (channel === 'rpc' && rpcPeer !== null && rpcPeer !== peer && rpcOpen > 0) return refuse('busy');
    // the rpc slot is taken before the (async) connect, so two peers arriving together cannot both get it
    if (channel === 'rpc') { rpcPeer = peer; rpcOpen++; }
    const letGo = () => { if (channel === 'rpc') { rpcOpen--; if (rpcOpen === 0) rpcPeer = null; } };
    let target: net.Socket;
    try { target = await connectLocal(targetPort); } catch { letGo(); return refuse('target down'); }
    target.setNoDelay(true);
    writeLine(socket, okLine);
    const at = Date.now();
    handshakeDone();
    emit({ type: 'open', channel, peer, at, v, fp });
    const counts = await pipeBoth(socket, target, rest);
    letGo();
    emit({ type: 'close', channel, peer, at: Date.now(), ms: Date.now() - at, bytesIn: counts.aToB, bytesOut: counts.bToA, v, fp });
  };

  const servePlain = async (socket: net.Socket, peer: string, first: Buffer, handshakeDone: () => void) => {
    const reader = new LineReader(socket);
    reader.feed(first);
    let channel: Channel | null = null;
    const refuse = (reason: string) => {
      emit({ type: 'reject', channel, peer, at: Date.now(), reason, v: 1 });
      try { writeLine(socket, `NO ${reason}`); } catch {}
      socket.end();
      setTimeout(() => socket.destroy(), 200);
    };
    if (opts.secret === null) return refuse('no v1');
    const secret = opts.secret;
    let hello: string;
    try { hello = await reader.line(HANDSHAKE_MS); } catch { return refuse('no hello'); }
    const parts = hello.trim().split(' ');
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
    if (!sameHex(proof.trim(), clientProof(secret, nonceC, nonceS, channel))) return refuse('wrong secret');
    socket.setTimeout(0);
    await admitted(socket, peer, channel, `OK ${serverProof(secret, nonceC, nonceS, channel)}`, reader.release(), 1, undefined, refuse, handshakeDone);
  };

  const serveTls = async (raw: net.Socket, peer: string, first: Buffer, t: TlsServer, handshakeDone: () => void) => {
    const socket = new tls.TLSSocket(prefixed(raw, first), { isServer: true, secureContext: secureContext!, requestCert: true, rejectUnauthorized: false });
    socket.on('error', () => {});
    const secure = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), HANDSHAKE_MS);
      socket.once('secure', () => { clearTimeout(timer); resolve(true); });
      socket.once('error', () => { clearTimeout(timer); resolve(false); });
      socket.once('close', () => { clearTimeout(timer); resolve(false); });
    });
    if (!secure) {
      emit({ type: 'reject', channel: null, peer, at: Date.now(), reason: 'tls', v: 2 });
      socket.destroy();
      return;
    }
    const fpC = peerFingerprint(socket) ?? undefined;
    const reader = new LineReader(socket);
    let channel: Channel | null = null;
    const refuse = (reason: string) => {
      emit({ type: 'reject', channel, peer, at: Date.now(), reason, v: 2, fp: fpC });
      try { writeLine(socket, `NO ${reason}`); } catch {}
      socket.end();
      setTimeout(() => socket.destroy(), 200);
    };
    let hello: string;
    try { hello = await reader.line(HANDSHAKE_MS); } catch { return refuse('no hello'); }
    const parts = hello.trim().split(' ');
    if (parts.length !== 4 || parts[0] !== 'KULA2') return refuse('bad hello');
    if (!CHANNELS.includes(parts[1] as Channel)) return refuse('bad channel');
    channel = parts[1] as Channel;
    const nonceC = parts[2];
    if (!isNonce(nonceC)) return refuse('bad nonce');
    if (!/^\d{1,16}$/.test(parts[3])) return refuse('bad hello');
    const unixMs = Number(parts[3]);
    const why = opts.admit ? opts.admit(peer, nonceC, unixMs) : (ring.check(peer, nonceC) ?? clockCheck(unixMs, Date.now()));
    if (why) return refuse(why);
    if (!fpC) return refuse('no client cert');
    const paired = t.paired.has(fpC);
    let pin = t.pin;
    if (!paired && pin !== null && t.pinExpiresAt != null && Date.now() > t.pinExpiresAt) {
      // the code is spent by time: the next qr shows a new one
      t.pin = null; pin = null;
      t.onPinUsed?.();
      return refuse('pin expired');
    }
    if (!paired && pin === null) return refuse('not paired');
    const nonceS = nonce();
    writeLine(socket, `${nonceS} ${paired ? 'paired' : 'pin'}`);
    let proof: string;
    try { proof = await reader.line(HANDSHAKE_MS); } catch { return refuse('no proof'); }
    proof = proof.trim();
    const fpS = t.identity.fp;
    let okLine: string;
    if (paired) {
      if (proof !== '-') return refuse('bad proof');
      okLine = 'OK -';
    } else {
      if (!sameHex(proof, pinProofClient(pin!, nonceC, nonceS, channel, fpS, fpC))) return refuse('wrong pin');
      // the first connection with the right code pairs the client and spends the code
      t.paired.add(fpC);
      t.pin = null;
      emit({ type: 'pair', channel, peer, at: Date.now(), v: 2, fp: fpC });
      t.onPinUsed?.();
      okLine = `OK ${pinProofServer(pin!, nonceC, nonceS, channel, fpS, fpC)}`;
    }
    await admitted(socket, peer, channel, okLine, reader.release(), 2, fpC, refuse, handshakeDone);
  };

  // Half-open on every leg: a peer that sends its FIN after the request still gets the
  // answer (llama.cpp's tunnels and the phone's Tunnel shut their write side first). The
  // open sockets are kept so close() can end them; net.Server.close() only stops listening.
  const open = new Set<net.Socket>();
  // connections between accept and the end of their handshake
  let inHandshake = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    socket.setNoDelay(true);
    const peer = socket.remoteAddress ?? '?';
    socket.on('error', () => {});
    if (inHandshake >= MAX_HANDSHAKES) {
      emit({ type: 'reject', channel: null, peer, at: Date.now(), reason: 'overloaded', v: 1 });
      try { socket.end('NO overloaded\n'); } catch {}
      setTimeout(() => socket.destroy(), 200);
      return;
    }
    inHandshake++;
    let counted = true;
    const uncount = () => { if (counted) { counted = false; inHandshake--; } };
    // the slot is given back when the pipe starts (open event) or the socket is gone
    socket.once('close', uncount);
    (async () => {
      const first = await waitFirstChunk(socket, HANDSHAKE_MS);
      if (!first) {
        emit({ type: 'reject', channel: null, peer, at: Date.now(), reason: 'no hello', v: 1 });
        try { socket.end('NO no hello\n'); } catch {}
        return;
      }
      if (first[0] === 0x16) {
        if (!opts.tls) {
          emit({ type: 'reject', channel: null, peer, at: Date.now(), reason: 'no tls', v: 2 });
          socket.end('NO no tls\n');
          return;
        }
        return serveTls(socket, peer, first, opts.tls, uncount);
      }
      return servePlain(socket, peer, first, uncount);
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
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const s of open) s.destroy();
    }),
  };
}

export class GateRefused extends Error {
  constructor(public readonly reason: string) {
    super(`NO ${reason}`);
  }
}

// Wraps an open socket in TLS 1.3 with our certificate, trusting only the pinned
// fingerprint; no hostname check, peers are ip addresses. Rejects with
// FP_MISMATCH when the worker shows another certificate.
export function wrapClient(socket: net.Socket, t: TlsClient, timeoutMs = HANDSHAKE_MS): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, key: t.identity.keyPem, cert: t.identity.certPem, rejectUnauthorized: false, minVersion: 'TLSv1.3', checkServerIdentity: () => undefined });
    const timer = setTimeout(() => { s.destroy(); reject(new Error('tls timeout')); }, timeoutMs);
    s.once('secureConnect', () => {
      clearTimeout(timer);
      const fp = peerFingerprint(s);
      if (!fp || !sameHex(fp, t.fp)) { s.destroy(); return reject(new Error(FP_MISMATCH)); }
      resolve(s);
    });
    s.once('error', (e) => { clearTimeout(timer); reject(new Error(`tls ${e.message}`)); });
  });
}

// Client side. On success `socket` is ready for raw traffic (the TLS socket in
// v2, the one given in v1); `rest` is what the server already sent after its OK
// line (normally nothing). With `tls` the v2 handshake runs, else v1.
export async function handshake(socket: net.Socket, secret: string, channel: Channel, timeoutMs = HANDSHAKE_MS, clockMs?: number, tlsOpts?: TlsClient | null): Promise<{ rest: Buffer; socket: Duplex }> {
  if (tlsOpts) {
    const s = await wrapClient(socket, tlsOpts, timeoutMs);
    const reader = new LineReader(s);
    try {
      const nonceC = nonce();
      writeLine(s, `KULA2 ${channel} ${nonceC} ${clockMs ?? Date.now()}`);
      const first = await reader.line(timeoutMs);
      if (first.startsWith('NO ')) throw new GateRefused(first.slice(3));
      const [nonceS, state] = first.split(' ');
      if (!isNonce(nonceS) || (state !== 'paired' && state !== 'pin')) throw new Error(`bad server nonce: ${JSON.stringify(first)}`);
      const pairing = state === 'pin';
      if (pairing && !tlsOpts.pin) throw new GateRefused('not paired');
      const fpC = tlsOpts.identity.fp;
      writeLine(s, pairing ? pinProofClient(tlsOpts.pin!, nonceC, nonceS, channel, tlsOpts.fp, fpC) : '-');
      const answer = await reader.line(timeoutMs);
      if (answer.startsWith('NO ')) throw new GateRefused(answer.slice(3));
      if (!answer.startsWith('OK ')) throw new Error(`bad server answer: ${JSON.stringify(answer)}`);
      if (pairing && !sameHex(answer.slice(3), pinProofServer(tlsOpts.pin!, nonceC, nonceS, channel, tlsOpts.fp, fpC))) throw new Error('server failed its proof');
      return { rest: reader.release(), socket: s };
    } catch (e) {
      reader.release();
      s.destroy();
      throw e;
    }
  }
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
    return { rest: reader.release(), socket };
  } catch (e) {
    reader.release();
    throw e;
  }
}

export function connectRemote(host: string, port: number, timeoutMs = 3000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port, allowHalfOpen: true });
    const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export type ProbeResult = { ok: true; ms: number } | { ok: false; reason: string };

// Does one handshake and hangs up. `reason` is the server's NO reason or the
// local error.
export async function probe(host: string, port: number, secret: string, channel: Channel, timeoutMs = 2000, tlsOpts?: TlsClient | null): Promise<ProbeResult> {
  const t0 = Date.now();
  let socket: net.Socket | null = null;
  try {
    socket = await connectRemote(host, port, timeoutMs);
    const h = await handshake(socket, secret, channel, timeoutMs, undefined, tlsOpts);
    h.socket.destroy();
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
  private readonly open = new Set<net.Socket>();
  port = 0;

  constructor(
    readonly host: string,
    readonly gatePort: number,
    readonly secret: string,
    readonly channel: Channel,
    readonly tls: TlsClient | null = null,
  ) {}

  async listen(localPort = 0): Promise<number> {
    const server = net.createServer({ allowHalfOpen: true }, async (local) => {
      // llama.cpp may reset the local leg while the remote handshake is still going; without
      // a listener that error would take the process down
      local.on('error', () => {});
      this.open.add(local);
      local.once('close', () => this.open.delete(local));
      local.setNoDelay(true);
      let remote: net.Socket | null = null;
      try {
        remote = await connectRemote(this.host, this.gatePort);
        remote.setNoDelay(true);
        const { rest, socket } = await handshake(remote, this.secret, this.channel, HANDSHAKE_MS, undefined, this.tls);
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
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      for (const s of this.open) s.destroy();
      this.server = null;
    });
  }
}
