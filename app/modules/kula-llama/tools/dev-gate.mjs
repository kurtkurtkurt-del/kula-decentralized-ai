#!/usr/bin/env node
// A gate on this Mac for testing the phone cluster without a second phone: the same
// handshake as Gate.kt (KULA1, HMAC-SHA256 over "nonce_c|nonce_s|channel"), piping the rpc
// channel to a ggml-rpc-server it starts on 127.0.0.1 and the api channel to llama-server
// through a shim that speaks the worker API (/status /load /chat /stop).
// kula-node (node/) is the real thing; this is the smallest piece of it, kept here so the
// module's own tests do not depend on node/.
//
//   node tools/dev-gate.mjs --secret <hex> [--port 50551] [--model path.gguf] [--tls [--pin <code>] [--dir <state dir>]]
//
// --tls adds protocol v2 (docs/GATE.md) on the same port: TLS 1.3 with a self-signed P-256
// certificate (made once with the openssl command line into ../../../.llama/dev-gate/, which
// spares this script the DER writer node/src/tls.ts has), a v3 qr with the fingerprint and a
// one-time pairing code, and the phones it paired with in .llama/dev-gate/paired.
// Binaries: ../../../.llama/host (node tools/llama-src.mjs --host).
import { createHmac, randomBytes, timingSafeEqual, createHash, X509Certificate } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { Duplex } from 'node:stream';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? true] : [])).filter((x) => x.length));
const secret = String(args.secret ?? randomBytes(32).toString('hex'));
const port = Number(args.port ?? 50551);
const here = dirname(fileURLToPath(import.meta.url));
const host = resolve(here, '../../../../.llama/host');
const hmacWith = (key, ...parts) => createHmac('sha256', key).update(parts.join('|')).digest('hex');
const hmac = (...parts) => hmacWith(secret, ...parts);
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// --- protocol v2 (--tls): certificate, paired phones, one-time code -------------------
let tlsCtx = null, fp = null, pin = null;
const paired = new Set();
// --dir moves the certificate and the paired list elsewhere (node/test/devgate.test.ts uses a temp dir)
const tlsDir = args.dir ? resolve(String(args.dir)) : resolve(here, '../../../../.llama/dev-gate');
const pairedFile = join(tlsDir, 'paired');
if (args.tls) {
  mkdirSync(tlsDir, { recursive: true });
  const keyPem = join(tlsDir, 'key.pem'), certPem = join(tlsDir, 'cert.pem');
  if (!existsSync(keyPem) || !existsSync(certPem)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPem, '-out', certPem, '-subj', '/CN=dev-gate', '-days', '3650'], { stdio: 'ignore' });
  }
  const key = readFileSync(keyPem), cert = readFileSync(certPem);
  tlsCtx = createSecureContext({ key, cert, minVersion: 'TLSv1.3' });
  fp = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
  if (existsSync(pairedFile)) for (const l of readFileSync(pairedFile, 'utf8').split('\n')) { const f = l.trim().split(' ')[0]; if (f.length === 64) paired.add(f); }
  pin = String(args.pin ?? randomBytes(8).toString('hex'));
}
const seenNonces = new Set();
const CLOCK_SKEW_MS = 120_000;

// a duplex over a socket whose first bytes were already read: TLSSocket takes the socket's
// handle and would lose them, so it gets this instead
function prefixed(sock, first) {
  const d = new Duplex({ read() { sock.resume(); }, write(c, _e, cb) { sock.write(c, cb); }, final(cb) { sock.end(cb); }, destroy(err, cb) { sock.destroy(); cb(err); } });
  d.push(first);
  sock.on('data', (c) => { if (!d.push(c)) sock.pause(); });
  sock.on('end', () => d.push(null));
  sock.on('error', (e) => d.destroy(e));
  sock.on('close', () => d.destroy());
  return d;
}

let rpcPort = 0;
let apiPort = 0;
async function freePort() {
  return new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
async function ensureRpc() {
  if (rpcPort) return rpcPort;
  rpcPort = await freePort();
  const bin = join(host, 'ggml-rpc-server');
  if (!existsSync(bin)) throw new Error(`no ${bin}: node tools/llama-src.mjs --host`);
  const p = spawn(bin, ['-H', '127.0.0.1', '-p', String(rpcPort), '-c'], { stdio: 'inherit', env: { ...process.env, DYLD_LIBRARY_PATH: host } });
  p.on('exit', (c) => { console.log('rpc-server exited', c); rpcPort = 0; });
  await new Promise((r) => setTimeout(r, 800));
  return rpcPort;
}
async function ensureApi() {
  if (apiPort) return apiPort;
  if (!args.model) return null;
  apiPort = await freePort();
  const p = spawn(join(host, 'llama-server'), ['-m', String(args.model), '--host', '127.0.0.1', '--port', String(apiPort), '-c', '2048'], { stdio: 'inherit', env: { ...process.env, DYLD_LIBRARY_PATH: host } });
  p.on('exit', () => { apiPort = 0; apiReady = null; });
  // llama-server answers 503 on /health while the model loads; a tunnel opened before that
  // would hand the peer a refusal, so wait until it is healthy (a few seconds for small models)
  const port = apiPort;
  for (let i = 0; i < 240; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
    if (ok) return port;
    if (!apiPort) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
let apiReady = null;
const ensureApiOnce = () => (apiReady ??= ensureApi().then((p) => { if (!p) apiReady = null; return p; }));

// The app's api channel speaks kula's worker API (ApiServer.kt: /status /load /chat /stop),
// not llama-server's; this shim translates, so a Mac with only llama-server acts as a worker.
let shimPort = 0;
let shimReady = null;
const ensureShim = () => (shimReady ??= startShim().then((p) => { if (!p) shimReady = null; return p; }));
async function startShim() {
  if (shimPort) return shimPort;
  const upstream = await ensureApiOnce();
  if (!upstream) return null;
  const served = basename(String(args.model));
  const srv = createHttpServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    console.log('api', req.method, req.url, body.length, 'bytes');
    const json = body ? JSON.parse(body) : {};
    // close-delimited like ApiServer.kt (no chunked framing): the app reads until the socket ends
    const sse = () => { res.useChunkedEncodingByDefault = false; res.chunkedEncoding = false; res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' }); };
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ loaded: true, model: served, busy: false, ctx: 2048 }));
    }
    if (req.method === 'POST' && req.url === '/stop') { res.writeHead(200); return res.end('{"ok":true}'); }
    if (req.method === 'POST' && req.url === '/load') {
      sse();
      if (json.name && json.name !== served) send({ error: `dev gate serves ${served} only` });
      else send({ done: true, ctx: 2048, sha256: json.sha256 ?? null });
      return res.end();
    }
    if (req.method === 'POST' && req.url === '/chat') {
      sse();
      const start = Date.now();
      let first = 0, n = 0;
      try {
        const r = await fetch(`http://127.0.0.1:${upstream}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: json.messages ?? [], max_tokens: json.maxTokens ?? 512, temperature: json.temperature ?? 0.7, top_p: json.topP ?? 0.95, top_k: json.topK ?? 40, min_p: json.minP ?? 0.05, repeat_penalty: json.repeatPenalty ?? 1.1, stream: true }),
        });
        let buf = '';
        for await (const chunk of r.body) {
          buf += Buffer.from(chunk).toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
            const piece = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
            if (piece) { if (!first) first = Date.now(); n++; send({ t: piece }); }
          }
        }
        const ms = Date.now() - start;
        console.log('api chat done', n, 'pieces in', Date.now() - start, 'ms');
        send({ done: true, tokens: n, ms, firstMs: first ? first - start : ms, tps: n && ms ? (n * 1000) / ms : 0 });
      } catch (e) {
        console.log('api chat failed', e);
        send({ error: String(e.message ?? e) });
      }
      return res.end();
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"no such route"}');
  });
  shimPort = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  console.log(`kula api shim on 127.0.0.1:${shimPort} -> llama-server ${upstream}`);
  return shimPort;
}

const ledger = [];
const qrJson = () => JSON.stringify(tlsCtx
  ? { k: 'kula-peer', v: 3, id: 'dev-gate', name: 'this mac', host: args.host ?? '10.0.2.2', port, fp, pin, kind: 'pc', ram: 8000, bw: 60 }
  : { k: 'kula-peer', v: 2, id: 'dev-gate', name: 'this mac', host: args.host ?? '10.0.2.2', port, secret, kind: 'pc', ram: 8000, bw: 60 });

// The handshake over a plain socket (v1) or inside tls (v2, fpC = the phone's certificate).
function serve(sock, peer, first, v, fpC) {
  let buf = Buffer.alloc(0);
  let step = 0, nonceC = '', nonceS = '', channel = '', pairing = false, code = null;
  const refuse = (why) => { ledger.push({ t: Date.now(), kind: 'reject', peer, why, v }); console.log('refused', peer, `v${v}`, why); sock.end(`NO ${why}\n`); };
  const timer = setTimeout(() => refuse('no hello'), 5000);
  const onData = async (d) => {
    buf = Buffer.concat([buf, d]);
    while (step < 2) {
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString('ascii').trim();
      buf = buf.subarray(nl + 1);
      if (step === 0) {
        const p = line.split(' ');
        // v1: 3 fields or 4 with the client's clock (v1.1, Gate.kt / node/src/gate.ts; the clock is not checked here).
        // v2 (inside tls): always 4 fields, KULA2, and the clock is checked below.
        if (v === 1 ? (p.length !== 3 && p.length !== 4) || p[0] !== 'KULA1' : p.length !== 4 || p[0] !== 'KULA2') return refuse('bad hello');
        if (v === 1 && p.length === 4 && !/^\d{1,16}$/.test(p[3])) return refuse('bad hello');
        if (p[1] !== 'rpc' && p[1] !== 'api') return refuse('bad channel');
        if (!/^[0-9a-f]{32}$/.test(p[2])) return refuse('bad nonce');
        channel = p[1]; nonceC = p[2]; nonceS = randomBytes(16).toString('hex');
        if (v === 2) {
          if (!/^\d{1,16}$/.test(p[3])) return refuse('bad hello');
          if (seenNonces.has(nonceC)) return refuse('replay');
          seenNonces.add(nonceC);
          if (Math.abs(Number(p[3]) - Date.now()) > CLOCK_SKEW_MS) return refuse('clock');
          if (!fpC) return refuse('no client cert');
          pairing = !paired.has(fpC);
          if (pairing && !pin) return refuse('not paired');
          code = pin;
          sock.write(`${nonceS} ${pairing ? 'pin' : 'paired'}\n`);
        } else sock.write(`${nonceS}\n`);
        step = 1;
      } else {
        clearTimeout(timer);
        let ok;
        if (v === 1) { if (!same(line, hmac(nonceC, nonceS, channel))) return refuse('wrong secret'); ok = `OK ${hmac(nonceS, nonceC, channel)}`; }
        else if (!pairing) { if (line !== '-') return refuse('bad proof'); ok = 'OK -'; }
        else {
          if (!same(line, hmacWith(code, nonceC, nonceS, channel, fp, fpC))) return refuse('wrong pin');
          paired.add(fpC); appendFileSync(pairedFile, `${fpC} ${Date.now()}\n`);
          pin = randomBytes(8).toString('hex');
          ledger.push({ t: Date.now(), kind: 'pair', peer, fp: fpC });
          console.log('paired', peer, fpC.slice(0, 16) + '…', 'new code; the qr is now:');
          console.log(qrJson());
          ok = `OK ${hmacWith(code, nonceS, nonceC, channel, fp, fpC)}`;
        }
        const target = channel === 'rpc' ? await ensureRpc().catch(() => null) : await ensureShim();
        if (!target) return refuse('channel closed');
        const local = connect({ port: target, host: '127.0.0.1', allowHalfOpen: true });
        local.on('connect', () => {
          sock.write(`${ok}\n`);
          if (buf.length) local.write(buf);
          sock.pipe(local).pipe(sock);
          let up = 0, down = 0;
          local.on('data', (d) => (down += d.length));
          sock.on('data', (d) => (up += d.length));
          local.on('end', () => console.log('target ended', channel, 'up', up, 'down', down));
          sock.on('close', () => console.log('peer closed', channel, 'up', up, 'down', down));
          ledger.push({ t: Date.now(), kind: 'connect', peer, channel, v });
          console.log('connected', peer, `v${v}`, channel, '->', target);
        });
        local.on('error', () => refuse('target down'));
        step = 2;
      }
    }
  };
  sock.on('data', onData);
  sock.on('error', () => {});
  if (first.length) onData(first);
}

// half-open on both legs: a client that finishes sending (FIN) still gets the whole reply
createServer({ allowHalfOpen: true }, (raw) => {
  const peer = raw.remoteAddress;
  raw.on('error', () => {});
  raw.once('data', (d) => {
    if (d[0] !== 0x16) return serve(raw, peer, d, 1, null);
    if (!tlsCtx) { console.log('refused', peer, 'tls client, no --tls'); return raw.end('NO no tls\n'); }
    const t = new TLSSocket(prefixed(raw, d), { isServer: true, secureContext: tlsCtx, requestCert: true, rejectUnauthorized: false });
    t.on('error', (e) => console.log('tls', peer, e.message));
    t.once('secure', () => {
      const c = t.getPeerCertificate();
      serve(t, peer, Buffer.alloc(0), 2, c && c.raw ? createHash('sha256').update(c.raw).digest('hex') : null);
    });
  });
}).listen(port, '0.0.0.0', () => {
  console.log(`dev gate on 0.0.0.0:${port}${tlsCtx ? ` (v1 + v2 tls, certificate ${fp.slice(0, 16)}…, ${paired.size} paired)` : ''}`);
  if (args.model) ensureShim().then((p) => { if (!p) console.log('llama-server failed'); });
  console.log(qrJson());
});
