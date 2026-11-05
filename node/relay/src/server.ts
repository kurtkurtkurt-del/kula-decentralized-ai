// kula-relay: a pipe between two devices that cannot reach each other (both behind
// NAT). The worker connects out and registers; the relay gives it a six digit code;
// the master connects out with that code; from then on the relay copies bytes
// between the two and understands none of them: the gate handshake (TLS 1.3 between
// the devices' own certificates, docs/GATE.md) runs end to end inside the pipe, so
// the relay sees ciphertext and the devices still pin each other.
//
// Transport: WebSocket over HTTPS (the host terminates TLS for the relay itself).
// Chosen over raw TCP with a length prefix because every PaaS routes HTTP without a
// dedicated port, phone networks and office firewalls let 443 through, the browser
// and React Native speak it natively, and `ws` gives framing and backpressure for
// free. The frame overhead (2-8 bytes) is nothing next to a token.
//
// Messages (the first frame on every connection is one JSON text frame):
//   worker control   → {t:"register", id, name?, fp?}
//                    ← {t:"registered", code, ttl_s, token}
//                    ← {t:"code", code, ttl_s}             a fresh code when the old one expired
//                    ← {t:"open", sid}                     a master wants a stream: accept it
//                    ← {t:"master", state:"connected"|"gone"}
//   worker stream    → {t:"accept", sid, token}            ← {t:"ready"}, then binary both ways
//   master control   → {t:"connect", code}
//                    ← {t:"connected", session, worker:{id, name, fp}} | {t:"error", reason}
//   master stream    → {t:"stream", session}               ← {t:"ready"}, then binary both ways
// After "ready" only binary frames are allowed; a text frame closes the stream.
// Each stream is one gate connection (the api channel opens one per HTTP request).
import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

export interface RelayOptions {
  port: number;
  host?: string;
  codeTtlMs?: number;          // how long a code opens the door (default 10 min)
  acceptTimeoutMs?: number;    // how long the worker has to accept a stream (default 10 s)
  helloTimeoutMs?: number;     // first frame deadline (default 5 s)
  idleTimeoutMs?: number;      // a stream without bytes for this long is closed (default 5 min)
  maxWorkers?: number;         // registered workers at once (default 1000)
  maxStreamsPerSession?: number; // open streams of one master (default 16)
  maxBytesPerSession?: number; // both ways, then the session ends (default 1 GiB)
  maxFrameBytes?: number;      // one WebSocket frame (default 1 MiB)
  connectsPerMinute?: number;  // new connections per ip (default 120)
  badCodesPerMinute?: number;  // wrong codes per ip (default 10)
  log?: (s: string) => void;
  // tests: every relayed chunk, as the relay sees it
  tap?: (dir: 'm→w' | 'w→m', data: Buffer) => void;
}

export interface RelayServer {
  port: number;
  url: string;
  stats(): { workers: number; sessions: number; streams: number; bytes: number };
  close(): Promise<void>;
}

interface Worker {
  id: string;
  name: string;
  fp: string | null;
  code: string;
  codeUntil: number;
  token: string;
  ws: WebSocket;
  session: Session | null;
  pending: Map<number, { resolve: (ws: WebSocket) => void; timer: NodeJS.Timeout }>;
}

interface Session {
  id: string;
  worker: Worker;
  ws: WebSocket;
  streams: Set<WebSocket>;
  bytes: number;
  ip: string;
}

const CODE_RE = /^\d{6}$/;
const SAFE_NAME = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, '').slice(0, max) : '');

class PerMinute {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number) {}
  take(key: string, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= this.limit) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
  sweep(now = Date.now()) {
    for (const [k, list] of this.hits) { const live = list.filter((t) => now - t < 60_000); if (live.length) this.hits.set(k, live); else this.hits.delete(k); }
  }
}

export function newCode(taken: (code: string) => boolean): string {
  for (let i = 0; i < 100; i++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (!taken(code)) return code;
  }
  throw new Error('no free code');
}

const send = (ws: WebSocket, o: Record<string, unknown>) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
const refuse = (ws: WebSocket, reason: string) => { send(ws, { t: 'error', reason }); ws.close(4000, reason.slice(0, 100)); };

export async function startRelay(opts: RelayOptions): Promise<RelayServer> {
  const log = opts.log ?? (() => {});
  const codeTtl = opts.codeTtlMs ?? 10 * 60_000;
  const acceptTimeout = opts.acceptTimeoutMs ?? 10_000;
  const helloTimeout = opts.helloTimeoutMs ?? 5_000;
  const idleTimeout = opts.idleTimeoutMs ?? 5 * 60_000;
  const maxWorkers = opts.maxWorkers ?? 1000;
  const maxStreams = opts.maxStreamsPerSession ?? 16;
  const maxBytes = opts.maxBytesPerSession ?? 1024 ** 3;
  const connects = new PerMinute(opts.connectsPerMinute ?? 120);
  const badCodes = new PerMinute(opts.badCodesPerMinute ?? 10);

  const workers = new Map<string, Worker>();   // by code
  const byToken = new Map<string, Worker>();
  const sessions = new Map<string, Session>();
  let nextSid = 1;
  let totalBytes = 0;
  let openStreams = 0;

  const issueCode = (w: Worker) => {
    if (w.code) workers.delete(w.code);
    w.code = newCode((c) => workers.has(c));
    w.codeUntil = Date.now() + codeTtl;
    workers.set(w.code, w);
  };

  const endSession = (s: Session, why: string) => {
    if (!sessions.has(s.id)) return;
    sessions.delete(s.id);
    for (const st of s.streams) st.close(1000, why);
    s.streams.clear();
    if (s.worker.session === s) {
      s.worker.session = null;
      send(s.worker.ws, { t: 'master', state: 'gone' });
    }
    if (s.ws.readyState === WebSocket.OPEN) s.ws.close(1000, why);
    log(`session ${s.id.slice(0, 6)} ended: ${why}`);
  };

  const dropWorker = (w: Worker) => {
    if (workers.get(w.code) === w) workers.delete(w.code);
    byToken.delete(w.token);
    for (const p of w.pending.values()) clearTimeout(p.timer);
    w.pending.clear();
    if (w.session) endSession(w.session, 'worker gone');
    log(`worker ${w.id.slice(0, 8)} left`);
  };

  // the pipe: binary frames one way and the other, counted, idle-timed, byte-capped
  const pipe = (s: Session, m: WebSocket, w: WebSocket) => {
    s.streams.add(m);
    openStreams++;
    let idle = setTimeout(() => done('idle'), idleTimeout);
    let ended = false;
    const done = (why: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(idle);
      openStreams--;
      s.streams.delete(m);
      if (m.readyState === WebSocket.OPEN) m.close(1000, why);
      if (w.readyState === WebSocket.OPEN) w.close(1000, why);
    };
    const forward = (from: WebSocket, to: WebSocket, dir: 'm→w' | 'w→m') => {
      from.on('message', (data: RawData, isBinary: boolean) => {
        if (!isBinary) return done('text frame after ready');
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        s.bytes += buf.length;
        totalBytes += buf.length;
        if (s.bytes > maxBytes) { done('byte limit'); return endSession(s, 'byte limit'); }
        opts.tap?.(dir, buf);
        clearTimeout(idle);
        idle = setTimeout(() => done('idle'), idleTimeout);
        if (to.readyState !== WebSocket.OPEN) return done('other side closed');
        to.send(buf, { binary: true });
        // backpressure: when the receiver's socket is full, stop reading the sender
        if (to.bufferedAmount > 4 * 1024 * 1024) {
          from.pause();
          const tick = setInterval(() => { if (to.bufferedAmount < 1024 * 1024 || to.readyState !== WebSocket.OPEN) { clearInterval(tick); from.resume(); } }, 20);
        }
      });
      from.once('close', () => done('closed'));
      from.once('error', () => done('error'));
    };
    forward(m, w, 'm→w');
    forward(w, m, 'w→m');
    send(m, { t: 'ready' });
    send(w, { t: 'ready' });
  };

  const onHello = (ws: WebSocket, ip: string, msg: any) => {
    switch (msg?.t) {
      case 'register': {
        if (workers.size >= maxWorkers) return refuse(ws, 'full');
        const id = SAFE_NAME(msg.id, 64);
        if (!id) return refuse(ws, 'bad register');
        const w: Worker = { id, name: SAFE_NAME(msg.name, 40), fp: /^[0-9a-f]{64}$/i.test(msg.fp ?? '') ? String(msg.fp).toLowerCase() : null, code: '', codeUntil: 0, token: randomBytes(16).toString('hex'), ws, session: null, pending: new Map() };
        issueCode(w);
        byToken.set(w.token, w);
        send(ws, { t: 'registered', code: w.code, ttl_s: Math.round(codeTtl / 1000), token: w.token });
        ws.on('message', () => {}); // a worker's control connection carries nothing more from its side
        ws.once('close', () => dropWorker(w));
        ws.on('error', () => {});
        log(`worker ${id.slice(0, 8)} registered from ${ip}, code ${w.code}`);
        return;
      }
      case 'accept': {
        const w = byToken.get(String(msg.token ?? ''));
        const p = w?.pending.get(Number(msg.sid));
        if (!w || !p) return refuse(ws, 'no such stream');
        clearTimeout(p.timer);
        w.pending.delete(Number(msg.sid));
        p.resolve(ws);
        return;
      }
      case 'connect': {
        const code = String(msg.code ?? '');
        const w = CODE_RE.test(code) ? workers.get(code) : undefined;
        if (!w || w.codeUntil < Date.now()) {
          if (!badCodes.take(ip)) return refuse(ws, 'rate limited');
          return refuse(ws, 'unknown code');
        }
        // a master that already sent its close frame is gone, even before its socket is
        if (w.session && w.session.ws.readyState !== WebSocket.OPEN) endSession(w.session, 'master gone');
        if (w.session) return refuse(ws, 'busy');
        const s: Session = { id: randomBytes(16).toString('hex'), worker: w, ws, streams: new Set(), bytes: 0, ip };
        w.session = s;
        sessions.set(s.id, s);
        send(ws, { t: 'connected', session: s.id, worker: { id: w.id, name: w.name, fp: w.fp } });
        send(w.ws, { t: 'master', state: 'connected' });
        ws.on('message', () => {});
        ws.once('close', () => endSession(s, 'master gone'));
        ws.on('error', () => {});
        log(`session ${s.id.slice(0, 6)}: master ${ip} ↔ worker ${w.id.slice(0, 8)}`);
        return;
      }
      case 'stream': {
        const s = sessions.get(String(msg.session ?? ''));
        if (!s) return refuse(ws, 'no such session');
        if (s.streams.size >= maxStreams) return refuse(ws, 'too many streams');
        const w = s.worker;
        const sid = nextSid++;
        const timer = setTimeout(() => { w.pending.delete(sid); refuse(ws, 'worker did not accept'); }, acceptTimeout);
        const got = new Promise<WebSocket>((resolve) => w.pending.set(sid, { resolve, timer }));
        send(w.ws, { t: 'open', sid });
        ws.once('close', () => { const p = w.pending.get(sid); if (p) { clearTimeout(p.timer); w.pending.delete(sid); } });
        got.then((wws) => {
          if (ws.readyState !== WebSocket.OPEN) return wws.close(1000, 'master left');
          if (!sessions.has(s.id)) return refuse(wws, 'session ended');
          pipe(s, ws, wws);
        });
        return;
      }
      default:
        return refuse(ws, 'bad hello');
    }
  };

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'kula-relay', workers: workers.size, sessions: sessions.size, streams: openStreams }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxFrameBytes ?? 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.socket.remoteAddress || '?';
    if (!connects.take(ip)) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      const deadline = setTimeout(() => ws.close(4000, 'no hello'), helloTimeout);
      ws.once('message', (data: RawData, isBinary: boolean) => {
        clearTimeout(deadline);
        if (isBinary) return refuse(ws, 'bad hello');
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return refuse(ws, 'bad hello'); }
        if (data.toString().length > 4096) return refuse(ws, 'bad hello');
        onHello(ws, ip, msg);
      });
    });
  });

  // expired codes are replaced and the worker told; rate windows are swept
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const w of [...workers.values()]) {
      if (w.codeUntil < now) { issueCode(w); send(w.ws, { t: 'code', code: w.code, ttl_s: Math.round(codeTtl / 1000) }); }
    }
    connects.sweep(now); badCodes.sweep(now);
  }, Math.min(1000, Math.max(50, codeTtl / 10)));
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  log(`kula-relay listening on ${port}`);
  return {
    port,
    url: `ws://${opts.host && opts.host !== '0.0.0.0' ? opts.host : '127.0.0.1'}:${port}`,
    stats: () => ({ workers: workers.size, sessions: sessions.size, streams: openStreams, bytes: totalBytes }),
    close: () => new Promise<void>((resolve) => {
      clearInterval(sweep);
      for (const s of [...sessions.values()]) endSession(s, 'relay closing');
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close(() => resolve());
      setTimeout(resolve, 500).unref();
    }),
  };
}
