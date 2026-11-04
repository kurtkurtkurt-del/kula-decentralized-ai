#!/usr/bin/env node
// A gate on this Mac for testing the phone cluster without a second phone: the same
// handshake as Gate.kt (KULA1, HMAC-SHA256 over "nonce_c|nonce_s|channel"), piping the rpc
// channel to a ggml-rpc-server it starts on 127.0.0.1 and the api channel to llama-server.
// kula-node (node/) is the real thing; this is the smallest piece of it, kept here so the
// module's own tests do not depend on node/.
//
//   node tools/dev-gate.mjs --secret <hex> [--port 50551] [--model path.gguf]
//
// Binaries: ../../../.llama/host (node tools/llama-src.mjs --host).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? true] : [])).filter((x) => x.length));
const secret = String(args.secret ?? randomBytes(32).toString('hex'));
const port = Number(args.port ?? 50551);
const here = dirname(fileURLToPath(import.meta.url));
const host = resolve(here, '../../../../.llama/host');
const hmac = (...parts) => createHmac('sha256', secret).update(parts.join('|')).digest('hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

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
  p.on('exit', () => (apiPort = 0));
  await new Promise((r) => setTimeout(r, 1500));
  return apiPort;
}

const ledger = [];
createServer((sock) => {
  const peer = sock.remoteAddress;
  let buf = Buffer.alloc(0);
  let step = 0, nonceC = '', nonceS = '', channel = '';
  const refuse = (why) => { ledger.push({ t: Date.now(), kind: 'reject', peer, why }); console.log('refused', peer, why); sock.end(`NO ${why}\n`); };
  const timer = setTimeout(() => refuse('no hello'), 5000);
  sock.on('data', async (d) => {
    buf = Buffer.concat([buf, d]);
    while (step < 2) {
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString('ascii').trim();
      buf = buf.subarray(nl + 1);
      if (step === 0) {
        const p = line.split(' ');
        if (p.length !== 3 || p[0] !== 'KULA1') return refuse('bad hello');
        if (p[1] !== 'rpc' && p[1] !== 'api') return refuse('bad channel');
        if (!/^[0-9a-f]{32}$/.test(p[2])) return refuse('bad nonce');
        channel = p[1]; nonceC = p[2]; nonceS = randomBytes(16).toString('hex');
        sock.write(`${nonceS}\n`);
        step = 1;
      } else {
        clearTimeout(timer);
        if (!same(line, hmac(nonceC, nonceS, channel))) return refuse('wrong secret');
        const target = channel === 'rpc' ? await ensureRpc().catch(() => null) : await ensureApi();
        if (!target) return refuse('channel closed');
        const local = connect(target, '127.0.0.1');
        local.on('connect', () => {
          sock.write(`OK ${hmac(nonceS, nonceC, channel)}\n`);
          if (buf.length) local.write(buf);
          sock.pipe(local).pipe(sock);
          ledger.push({ t: Date.now(), kind: 'connect', peer, channel });
          console.log('connected', peer, channel, '->', target);
        });
        local.on('error', () => refuse('target down'));
        step = 2;
      }
    }
  });
  sock.on('error', () => {});
}).listen(port, '0.0.0.0', () => {
  console.log(`dev gate on 0.0.0.0:${port}`);
  console.log(JSON.stringify({ k: 'kula-peer', v: 2, id: 'dev-gate', name: 'this mac', host: args.host ?? '10.0.2.2', port, secret, kind: 'pc', ram: 8000, bw: 60 }));
});
