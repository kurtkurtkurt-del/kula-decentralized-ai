// The local dashboard: one page on 127.0.0.1 while `kula-node share` or
// `kula-node chat` runs. It is for the person at this computer only, so:
// bound to the loopback address and nothing else; every route lives under a
// random path prefix printed in the terminal; a wrong Host header (dns
// rebinding) is refused; a POST must come from this very origin (the Origin
// header a browser always sends with it); the cluster secret never leaves the
// process as text — the pairing qr is drawn here and sent as an svg.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { packageRoot } from '../paths.js';
import { qrSvg } from './qr.js';
import type { DashboardState, Patch } from './state.js';
import { batchReport, type Message, type Reply } from '../apart.js';

export interface ChatSource {
  chat(messages: Message[], onToken: (t: string) => void, opts: { maxTokens?: number; device?: string }): Promise<Reply>;
  batch(prompts: string[], opts: { maxTokens?: number; onReply?: (i: number, r: Reply) => void }): Promise<Reply[]>;
}

export interface DashboardActions {
  probe?: () => Promise<void>;          // probe the peer book, update state
  verify?: () => Promise<void> | void;  // verify the ledger, update state
  load?: (model: string) => Promise<void>; // share mode: load a model from the models dir into the local api
  unpair?: (fp: string) => Promise<void> | void; // share mode: take a paired device's access away
}

export interface DashboardOptions {
  port: number;                 // 0: any free port (tests)
  state: DashboardState;
  qrText?: () => string | null; // the pairing payload, with the secret; read only when the svg is drawn
  chat?: ChatSource;
  actions?: DashboardActions;
  log?: (s: string) => void;
  staticDir?: string;
  batchPrompts?: string[];
}

export interface Dashboard {
  port: number;
  prefix: string;
  url: string;
  close(): Promise<void>;
}

export const BATCH_PROMPTS = [
  'Name three uses of a bicycle pump in one sentence each.',
  'Explain what a hash function is to a ten year old.',
  'Write a haiku about a tired laptop.',
  'What is the capital of Australia, and why is it not Sydney?',
  'List four vegetables that grow underground.',
  'Describe the smell of rain in two sentences.',
  'Give a one line summary of how a fridge keeps things cold.',
  'Translate "good morning, the bread is fresh" into French.',
];

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const STATIC = new Set(['index.html', 'app.js', 'app.css']);
// tools/pack.mjs bakes the three files in: a packed executable has no static folder next to it
declare const __KULA_STATIC__: Record<string, string> | undefined;

export function staticDir(): string {
  return path.join(packageRoot(), 'src', 'dashboard', 'static');
}

export function readJson(req: http.IncomingMessage, limit = 256 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (d: Buffer) => { n += d.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

export const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function send(res: http.ServerResponse, code: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(code, { ...BASE_HEADERS, 'content-type': type, 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}
const json = (res: http.ServerResponse, code: number, body: unknown) => send(res, code, JSON.stringify(body), 'application/json; charset=utf-8');

export class Sse {
  constructor(private readonly res: http.ServerResponse) {
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
  }
  send(obj: unknown, event?: string) { this.res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`); }
  ping() { this.res.write(': ping\n\n'); }
  end(obj?: unknown) { if (obj !== undefined) this.send(obj); this.res.end(); }
}

export async function startDashboard(opts: DashboardOptions): Promise<Dashboard> {
  const log = opts.log ?? (() => {});
  const prefix = randomBytes(12).toString('hex');
  const dir = opts.staticDir ?? staticDir();
  const files = new Map<string, Buffer>();
  const baked = !opts.staticDir && typeof __KULA_STATIC__ === 'object' ? __KULA_STATIC__ : null;
  for (const f of STATIC) files.set(f, baked ? Buffer.from(baked[f], 'utf8') : fs.readFileSync(path.join(dir, f)));
  const streams = new Set<http.ServerResponse>();
  let port = 0;

  const hostOk = (req: http.IncomingMessage) => {
    const h = req.headers.host ?? '';
    return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
  };
  // a POST must carry the Origin of this very page; a page on any other
  // origin (even one on another local port) is refused before the body is read
  const sameOrigin = (req: http.IncomingMessage) => {
    const o = req.headers.origin;
    if (typeof o !== 'string') return false;
    const sfs = req.headers['sec-fetch-site'];
    if (typeof sfs === 'string' && sfs !== 'same-origin') return false;
    return o === `http://${req.headers.host}`;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!hostOk(req)) return send(res, 400, 'bad host');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const p = url.pathname;
    if (p === '/' && req.method === 'GET') return send(res, 302, '', 'text/plain', { location: `/${prefix}/` });
    if (!p.startsWith(`/${prefix}/`)) return send(res, 404, 'not found');
    const route = p.slice(prefix.length + 2) || 'index.html';

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (STATIC.has(route)) return send(res, 200, files.get(route)!, TYPES[path.extname(route)]);
      if (route === 'state.json') return json(res, 200, opts.state.snapshot());
      if (route === 'qr.svg') {
        const text = opts.qrText?.() ?? null;
        if (!text) return send(res, 404, 'no qr');
        return send(res, 200, qrSvg(text), TYPES['.svg']);
      }
      if (route === 'events') {
        const sse = new Sse(res);
        streams.add(res);
        sse.send(opts.state.snapshot(), 'snapshot');
        const off = opts.state.subscribe((patch: Patch) => sse.send(patch.data, patch.kind));
        const timer = setInterval(() => sse.ping(), 15000);
        res.on('close', () => { off(); clearInterval(timer); streams.delete(res); });
        return;
      }
      return send(res, 404, 'not found');
    }

    if (req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, 'same origin only');
      let body: any;
      try { body = await readJson(req); } catch (e) { return json(res, 400, { error: (e as Error).message }); }

      if (route === 'probe') {
        if (!opts.actions?.probe) return json(res, 404, { error: 'no peers here' });
        try { await opts.actions.probe(); return json(res, 200, { ok: true }); } catch (e) { return json(res, 500, { error: (e as Error).message }); }
      }
      if (route === 'verify') {
        if (!opts.actions?.verify) return json(res, 404, { error: 'no ledger here' });
        try { await opts.actions.verify(); return json(res, 200, { ok: true }); } catch (e) { return json(res, 500, { error: (e as Error).message }); }
      }
      if (route === 'load') {
        if (!opts.actions?.load) return json(res, 404, { error: 'loading is for share mode' });
        const model = typeof body?.model === 'string' ? path.basename(body.model) : '';
        if (!model) return json(res, 400, { error: 'need model' });
        try { await opts.actions.load(model); return json(res, 200, { ok: true }); } catch (e) { return json(res, 500, { error: (e as Error).message }); }
      }
      if (route === 'unpair') {
        if (!opts.actions?.unpair) return json(res, 404, { error: 'nothing is paired here' });
        const fp = typeof body?.fp === 'string' ? body.fp.toLowerCase() : '';
        if (!/^[0-9a-f]{64}$/.test(fp)) return json(res, 400, { error: 'need fp' });
        try { await opts.actions.unpair(fp); return json(res, 200, { ok: true }); } catch (e) { return json(res, 500, { error: (e as Error).message }); }
      }
      if (route === 'chat') {
        if (!opts.chat) return json(res, 409, { error: 'no device to talk to' });
        if (!Array.isArray(body?.messages) || !body.messages.length) return json(res, 400, { error: 'need messages' });
        const messages: Message[] = body.messages.map((m: any) => ({ role: m?.role === 'assistant' || m?.role === 'system' ? m.role : 'user', content: String(m?.content ?? '') }));
        const sse = new Sse(res);
        try {
          const r = await opts.chat.chat(messages, (t) => sse.send({ t }), { maxTokens: Number(body.maxTokens) > 0 ? Number(body.maxTokens) : 256, device: typeof body.device === 'string' ? body.device : undefined });
          sse.end({ done: true, tokens: r.tokens, ms: r.ms, firstMs: r.firstMs, tps: r.tps, device: r.device });
        } catch (e) { sse.end({ error: (e as Error).message }); }
        return;
      }
      if (route === 'batch') {
        if (!opts.chat) return json(res, 409, { error: 'no device to talk to' });
        const prompts: string[] = Array.isArray(body?.prompts) && body.prompts.length ? body.prompts.map(String).slice(0, 64) : (opts.batchPrompts ?? BATCH_PROMPTS);
        const sse = new Sse(res);
        const t0 = Date.now();
        try {
          sse.send({ start: true, prompts });
          const replies = await opts.chat.batch(prompts, { maxTokens: Number(body.maxTokens) > 0 ? Number(body.maxTokens) : 128, onReply: (i, r) => sse.send({ i, device: r.device, tokens: r.tokens, ms: r.ms, firstMs: r.firstMs, tps: r.tps, text: r.text }) });
          sse.end({ done: true, seconds: Math.round((Date.now() - t0) / 100) / 10, report: batchReport(replies) });
        } catch (e) { sse.end({ error: (e as Error).message }); }
        return;
      }
      return send(res, 404, 'not found');
    }
    return send(res, 405, 'method not allowed');
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { log(`dashboard: ${(e as Error).message}`); if (!res.headersSent) send(res, 500, 'error'); else res.end(); });
  });
  server.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/${prefix}/`;
  log(`dashboard on ${url} (this computer only)`);
  return {
    port, prefix, url,
    close: () => new Promise<void>((resolve) => {
      for (const s of streams) s.destroy();
      streams.clear();
      server.closeIdleConnections?.();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
