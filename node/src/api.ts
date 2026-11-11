// The api channel: the same tiny http api a phone offers in "apart" mode.
// GET /status, POST /load, POST /chat, POST /stop, GET /blob?mb=N, GET /trust. Streams
// are server sent events, one JSON object per `data:` line. Behind it runs llama-server.
// /blob is the bench's tunnel speed test: N MB (1024²) of zeros, N capped at 64
// (BLOB_MAX_MB), the same bytes and headers as ApiServer.kt on a phone.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { download, sha256Of } from './download.js';
import { SHA256_RE, sizeProblem, urlProblem } from './policy.js';
import { freePort, startChild, type Child } from './children.js';
import type { LlamaBinaries } from './llama.js';
import { blobMb } from './benchcore.js';
import { apiPeerOf } from './gate.js';
import { trustBody, SINCE_RE, type TrustSource } from './trust.js';
import { CHALLENGE_RE } from './attest.js';

export interface ApiStatus {
  loaded: boolean;
  model: string | null;
  sha256: string | null;
  tokensUsed: number;
  ctx: number;
  busy: boolean;
}

export interface Backend {
  port: number;
  stop(): Promise<void>;
}

export interface ApiOptions {
  models: string;
  llama: LlamaBinaries | null;
  log?: (s: string) => void;
  // how llama-server is started; tests swap in a fake
  startBackend?: (modelFile: string, ctx: number) => Promise<Backend>;
  defaultCtx?: number;
  // told about every /load: the sha256 asked for and the one on disk (null when nothing usable arrived)
  onLoad?: (name: string, wantSha256: string, gotSha256: string | null) => void;
  // tests serve their files from 127.0.0.1; a worker never takes a private url, except
  // the address of the master that sent the /load (policy.ts urlProblem)
  allowPrivateUrls?: boolean;
  // which master is behind a request, by the remote port of its socket; default: the gate's record
  masterOf?: (remotePort: number | undefined) => string | null;
  // what GET /trust tells (trust.ts); without it /trust is not found
  trust?: TrustSource;
}

export interface ApiServer {
  port: number;
  status(): ApiStatus;
  close(): Promise<void>;
}

function readJson(req: http.IncomingMessage, limit = 1 << 20): Promise<any> {
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

function json(res: http.ServerResponse, code: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

class Sse {
  constructor(private readonly res: http.ServerResponse) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
  }
  send(obj: unknown) { this.res.write(`data: ${JSON.stringify(obj)}\n\n`); }
  end(obj?: unknown) { if (obj !== undefined) this.send(obj); this.res.end(); }
}

// N MB of zeros in 64 KB writes, honouring backpressure; no compression, a fixed length.
function blob(q: string | null, res: http.ServerResponse) {
  const mb = blobMb(q);
  if (mb === null) return json(res, 400, { error: 'need mb' });
  const total = mb * 1024 * 1024;
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': total, 'cache-control': 'no-store' });
  const chunk = Buffer.alloc(64 * 1024);
  let sent = 0;
  const pump = () => {
    while (sent < total) {
      const n = Math.min(chunk.length, total - sent);
      sent += n;
      if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) { res.once('drain', pump); return; }
    }
    res.end();
  };
  res.on('close', () => { sent = total; });
  pump();
}

function safeName(name: string): string {
  const base = path.basename(String(name)).replace(/[^A-Za-z0-9._-]/g, '_');
  if (!base || base === '.' || base === '..') throw new Error('bad name');
  return base;
}

export async function startApiServer(opts: ApiOptions): Promise<ApiServer> {
  const log = opts.log ?? (() => {});
  fs.mkdirSync(opts.models, { recursive: true });
  const state: ApiStatus = { loaded: false, model: null, sha256: null, tokensUsed: 0, ctx: 0, busy: false };
  let backend: Backend | null = null;
  let current: AbortController | null = null;

  const startBackend = opts.startBackend ?? (async (modelFile: string, ctx: number): Promise<Backend> => {
    if (!opts.llama) throw new Error('llama.cpp is not set up (run: kula-node setup)');
    const port = await freePort();
    const child: Child = await startChild('llama-server', opts.llama.llamaServer,
      ['--host', '127.0.0.1', '--port', String(port), '-m', modelFile, '-c', String(ctx), '-ngl', '99', '--no-webui'],
      port, log, 180000);
    // the port opens before the model is in memory: wait for /health
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) break;
      } catch {}
      if (child.proc.exitCode !== null) throw new Error('llama-server exited while loading');
      if (Date.now() - t0 > 600000) { await child.stop(); throw new Error('llama-server took too long to load the model'); }
      await new Promise((r) => setTimeout(r, 300));
    }
    return child;
  });

  async function unload() {
    if (backend) { const b = backend; backend = null; await b.stop(); }
    state.loaded = false; state.model = null; state.sha256 = null; state.ctx = 0;
  }

  async function handleLoad(body: any, res: http.ServerResponse, masterIp: string | null) {
    if (state.busy) return json(res, 409, { error: 'busy' });
    const { url, sha256, size, name } = body ?? {};
    if (typeof url !== 'string' || typeof sha256 !== 'string' || typeof name !== 'string') return json(res, 400, { error: 'need url, sha256, size, name' });
    const want = sha256.toLowerCase();
    if (!SHA256_RE.test(want)) return json(res, 400, { error: 'sha256 must be 64 hex characters' });
    const sizeWhy = sizeProblem(size);
    if (sizeWhy) return json(res, 400, { error: sizeWhy });
    const ctx = Number(body.ctx) > 0 ? Math.min(Math.floor(Number(body.ctx)), 1 << 20) : (opts.defaultCtx ?? 4096);
    let file: string;
    try { file = path.join(opts.models, safeName(name)); } catch (e) { return json(res, 400, { error: (e as Error).message }); }
    // the url is only fetched when the file is not here yet, so only then must it pass the
    // policy (as ApiServer.kt does): this computer's own api is told file://<the model it has>
    if (!fs.existsSync(file)) {
      const urlWhy = urlProblem(url, opts.allowPrivateUrls, masterIp);
      if (urlWhy) return json(res, 400, { error: urlWhy });
    }
    state.busy = true;
    const sse = new Sse(res);
    const ac = new AbortController();
    current = ac;
    // a phone that drops off wi-fi mid-load: stop the work, free busy; otherwise every later
    // /load and /chat from it would be 409 until the download and start ran their course
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    try {
      await unload();
      let have = fs.existsSync(file);
      if (have) {
        sse.send({ state: 'checking', got: 0, total: size ?? 0 });
        const sum = await sha256Of(file, (got, total) => sse.send({ state: 'checking', got, total }));
        if (sum !== want) { log(`${name}: on disk but wrong sha256, fetching again`); fs.rmSync(file); have = false; }
        else opts.onLoad?.(name, want, sum);
      }
      if (!have) {
        log(`downloading ${name} from ${url}`);
        sse.send({ state: 'running', got: 0, total: size ?? 0 });
        await download(url, file, (got, total) => sse.send({ state: 'running', got, total: total || size || 0 }), ac.signal, { size: Number(size), allowPrivate: opts.allowPrivateUrls, masterIp });
        sse.send({ state: 'checking', got: 0, total: size ?? 0 });
        const sum = await sha256Of(file, (got, total) => sse.send({ state: 'checking', got, total }));
        opts.onLoad?.(name, want, sum);
        if (sum !== want) { fs.rmSync(file); throw new Error('checksum mismatch; file deleted, load again'); }
      }
      if (ac.signal.aborted) throw new Error('stopped');
      sse.send({ state: 'loading', got: 0, total: 0 });
      log(`loading ${name} (ctx ${ctx})`);
      backend = await startBackend(file, ctx);
      state.loaded = true; state.model = name; state.sha256 = want; state.ctx = ctx;
      sse.end({ done: true, ctx, sha256: want });
      log(`${name} ready`);
    } catch (e) {
      log(`load failed: ${(e as Error).message}`);
      sse.end({ error: (e as Error).message });
    } finally {
      state.busy = false;
      current = null;
    }
  }

  async function handleChat(body: any, res: http.ServerResponse) {
    // 409 like ApiServer.kt (the phone's worker), not 400
    if (!state.loaded || !backend) return json(res, 409, { error: 'no model loaded' });
    if (state.busy) return json(res, 409, { error: 'busy' });
    if (!Array.isArray(body?.messages)) return json(res, 400, { error: 'need messages' });
    state.busy = true;
    const sse = new Sse(res);
    const ac = new AbortController();
    current = ac;
    // the client went away mid-stream: abort llama-server's request and free busy
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const t0 = Date.now();
    let firstMs = 0;
    let tokens = 0;
    try {
      const upstream = await fetch(`http://127.0.0.1:${backend.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          messages: body.messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: Number(body.maxTokens) > 0 ? Number(body.maxTokens) : 512,
          temperature: body.temperature ?? 0.7,
          top_p: body.topP ?? 0.95,
          cache_prompt: !body.reset,
        }),
      });
      if (!upstream.ok || !upstream.body) throw new Error(`llama-server: ${upstream.status} ${await upstream.text().catch(() => '')}`);
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let usageTokens = 0;
      let thinking = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let obj: any;
          try { obj = JSON.parse(data); } catch { continue; }
          // llama-server hands a thinking model's reasoning over apart (reasoning_content); the
          // phone's worker streams it inline as <think>…</think>, so this one does too
          const delta = obj?.choices?.[0]?.delta;
          const reason = delta?.reasoning_content;
          if (typeof reason === 'string' && reason.length) {
            if (!firstMs) firstMs = Date.now() - t0;
            tokens++;
            sse.send({ t: thinking ? reason : `<think>${reason}` });
            thinking = true;
          }
          const piece = delta?.content;
          if (typeof piece === 'string' && piece.length) {
            if (!firstMs) firstMs = Date.now() - t0;
            tokens++;
            sse.send({ t: thinking ? `</think>\n\n${piece}` : piece });
            thinking = false;
          }
          if (obj?.usage?.completion_tokens) usageTokens = obj.usage.completion_tokens;
          if (obj?.timings?.predicted_n) usageTokens = obj.timings.predicted_n;
        }
      }
      if (thinking) sse.send({ t: '</think>' });
      if (usageTokens) tokens = usageTokens;
      const ms = Date.now() - t0;
      const gen = Math.max(1, ms - firstMs);
      state.tokensUsed += tokens;
      sse.end({ done: true, tokens, ms, firstMs, tps: Math.round((tokens / gen) * 1000 * 10) / 10 });
    } catch (e) {
      const stopped = ac.signal.aborted;
      const ms = Date.now() - t0;
      state.tokensUsed += tokens;
      if (stopped) sse.end({ done: true, tokens, ms, firstMs, tps: 0, stopped: true });
      else sse.end({ error: (e as Error).message });
    } finally {
      state.busy = false;
      current = null;
    }
  }

  const masterOf = opts.masterOf ?? apiPeerOf;
  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && url === '/status') return json(res, 200, state);
      if (req.method === 'GET' && url === '/trust' && opts.trust) {
        const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        const since = q.get('since');
        if (since !== null && !SINCE_RE.test(since)) return json(res, 400, { error: 'bad since' });
        const challenge = q.get('challenge');
        if (challenge !== null && !CHALLENGE_RE.test(challenge)) return json(res, 400, { error: 'bad challenge' });
        return json(res, 200, trustBody(opts.trust, since, challenge));
      }
      if (req.method === 'GET' && url === '/blob') return blob(new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('mb'), res);
      if (req.method === 'POST' && url === '/load') return handleLoad(await readJson(req), res, masterOf(req.socket.remotePort));
      // a chat may carry up to three shrunk photos (ui/vision.ts) for this computer's own llama-server
      if (req.method === 'POST' && url === '/chat') return handleChat(await readJson(req, 4 << 20), res);
      if (req.method === 'POST' && url === '/stop') { current?.abort(); return json(res, 200, { ok: true, wasBusy: state.busy }); }
      if (req.method === 'POST' && url === '/unload') { if (state.busy) return json(res, 409, { error: 'busy' }); await unload(); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: (e as Error).message });
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    status: () => state,
    close: async () => {
      current?.abort();
      await unload();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
