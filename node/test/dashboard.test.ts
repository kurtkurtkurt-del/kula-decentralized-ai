// The local dashboard: loopback only, a random prefix, same-origin posts, a
// live sse stream, the chat and batch boxes over a fake cluster, the qr drawn
// on the server, and no secret in any body. Then the real `share` with its
// dashboard, a real handshake through the gate showing up on the page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-dash-home-'));
process.env.KULA_NODE_HOME = HOME;

const { qr, qrSvg } = await import('../src/dashboard/qr.ts');
const { DashboardState, peerView, readPassport, badgesOf } = await import('../src/dashboard/state.ts');
const { startDashboard } = await import('../src/dashboard/server.ts');
const { writePeers } = await import('../src/peers.ts');
const { probe } = await import('../src/gate.ts');
const { share } = await import('../src/share.ts');
type Reply = import('../src/apart.ts').Reply;
type Peer = import('../src/peers.ts').Peer;

const SECRET = 'deadbeefcafef00d0123456789abcdef';
const here = path.dirname(fileURLToPath(import.meta.url));

function fakeCluster(names = ['fast', 'slow']) {
  const calls: string[] = [];
  const reply = (device: string, text: string): Reply => ({ text, tokens: text.split(' ').length, ms: device === 'fast' ? 40 : 130, firstMs: 10, tps: device === 'fast' ? 30 : 8, device });
  return {
    calls,
    chat: async (messages: { content: string }[], onToken: (t: string) => void, o: { device?: string }) => {
      const dev = o.device ?? names[0];
      calls.push(`chat:${dev}`);
      for (const w of ['hello', ' there', ` ${messages.at(-1)!.content.length}`]) { onToken(w); await new Promise((r) => setTimeout(r, 2)); }
      return reply(dev, 'hello there');
    },
    batch: async (prompts: string[], o: { onReply?: (i: number, r: Reply) => void }) => {
      const out: Reply[] = [];
      for (const [i, p] of prompts.entries()) { const r = reply(names[i % names.length], `re: ${p}`); out.push(r); o.onReply?.(i, r); }
      return out;
    },
  };
}

function newState(withPeer = true) {
  const state = new DashboardState('chat', { name: 'box', id: 'id-box', host: '10.0.0.5', ram: 8000, totalRam: 16000, bw: 20, gpu: null, vram: 0, passport: null, passportFile: null });
  const peer: Peer = { id: 'id-phone', name: 'phone', host: '10.0.0.9', port: 50551, secret: SECRET, kind: 'phone', ram: 6000, bw: 30, gpu: null, vram: 0, added_at: 't' };
  if (withPeer) state.peers([peerView(peer)]);
  return state;
}

async function sseFirst(url: string, want = 1): Promise<{ events: { event: string; data: any }[]; text: string }> {
  const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  const events: { event: string; data: any }[] = [];
  const parse = () => {
    events.length = 0;
    for (const block of text.split('\n\n')) {
      const ev = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const d = /^data: (.*)$/m.exec(block)?.[1];
      if (d) events.push({ event: ev, data: JSON.parse(d) });
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    parse();
    if (events.length >= want) break;
  }
  reader.cancel().catch(() => {});
  return { events, text };
}

test('qr: the same modules as web/passport/qr.js, level m, finders in the corners, an svg', () => {
  const code = fs.readFileSync(path.join(here, '..', '..', 'web', 'passport', 'qr.js'), 'utf8');
  const ctx: any = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  for (const text of ['hello', JSON.stringify({ k: 'kula-peer', v: 2, id: 'a'.repeat(36), name: 'mac', host: '192.168.1.20', port: 50551, secret: SECRET, kind: 'pc', ram: 24000, bw: 61.3, gpu: 'Apple M2', vram: 0 }), 'ğüşiöç €']) {
    const a = qr(text), b = ctx.window.AH.qr(text);
    assert.equal(a.size, b.size);
    assert.equal(a.mask, b.mask);
    for (let y = 0; y < a.size; y++) for (let x = 0; x < a.size; x++) assert.equal(a.get(x, y), b.get(x, y), `${text.slice(0, 10)} module ${x},${y}`);
  }
  const q = qr('hello');
  assert.equal(q.size, 21);
  for (const [x, y] of [[0, 0], [20, 0], [0, 20], [3, 3], [6, 8]]) assert.equal(q.get(x, y), true);
  assert.equal(q.get(1, 1), false);
  const svg = qrSvg('hello');
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 29 29"/);
  assert.match(svg, /<path d="M4 4h1v1h-1z/);
});

test('state: a peer view has no secret, badges, a passport is read from either file', () => {
  const p: Peer = { id: 'x', name: 'n', host: 'h', port: 1, secret: SECRET, kind: 'pc', ram: 32000, bw: 60, gpu: 'rtx', vram: 8000, added_at: 't' };
  const v = peerView(p);
  assert.ok(!JSON.stringify(v).includes(SECRET));
  assert.deepEqual(badgesOf(p), ['pc', 'gpu', 'hızlı bellek', 'geniş bellek']);
  const a = path.join(HOME, 'pp-a.json'), b = path.join(HOME, 'pp-b.json');
  assert.equal(readPassport([a, b]), null);
  fs.writeFileSync(b, JSON.stringify({ schema: 'passport/0.3', device: 'mac' }));
  assert.equal(readPassport([a, b])?.file, b);
  fs.writeFileSync(a, '{"not":"a passport"}');
  assert.equal(readPassport([a, b])?.file, b);
  fs.writeFileSync(a, JSON.stringify({ schema: 'passport/0.3', device: 'pc' }));
  assert.equal((readPassport([a, b])?.passport as any).device, 'pc');
});

test('dashboard: 127.0.0.1 only, random prefix, host check, root redirects, posts need the same origin', async () => {
  const state = newState();
  const d = await startDashboard({ port: 0, state, qrText: () => `{"secret":"${SECRET}"}`, chat: fakeCluster() });
  try {
    assert.match(d.url, new RegExp(`^http://127\\.0\\.0\\.1:${d.port}/[0-9a-f]{24}/$`));
    // nothing listens on the lan address
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    if (lan) {
      const refused = await new Promise<boolean>((resolve) => {
        const s = net.connect({ host: lan, port: d.port });
        const t = setTimeout(() => { s.destroy(); resolve(true); }, 1500);
        s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(false); });
        s.once('error', () => { clearTimeout(t); resolve(true); });
      });
      assert.equal(refused, true, `the dashboard answered on ${lan}`);
    }
    // the root redirects to the prefix; anything outside the prefix is 404
    const root = await fetch(`http://127.0.0.1:${d.port}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), `/${d.prefix}/`);
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/state.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/${'0'.repeat(24)}/state.json`)).status, 404);
    // a foreign host header (dns rebinding) is refused; fetch will not forge Host, so a raw request
    const withHost = (host: string) => new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: d.port, path: `/${d.prefix}/state.json`, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    assert.equal(await withHost(`evil.example:${d.port}`), 400);
    assert.equal(await withHost(`127.0.0.1:${d.port + 1}`), 400);
    assert.equal(await withHost(`localhost:${d.port}`), 200);
    // the page and its files, with the headers that keep it on its own
    const page = await fetch(d.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /<title>kula-node<\/title>/);
    assert.equal((await fetch(`${d.url}app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${d.url}app.css`)).status, 200);
    // posts: no origin, a foreign origin, another local port: all refused before the body is read
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    const post = (headers: Record<string, string>) => fetch(`${d.url}chat`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ origin: 'http://evil.example' })).status, 403);
    assert.equal((await post({ origin: `http://127.0.0.1:${d.port + 1}` })).status, 403);
    assert.equal((await post({ origin: `http://127.0.0.1:${d.port}`, 'sec-fetch-site': 'cross-site' })).status, 403);
    const ok = await post({ origin: `http://127.0.0.1:${d.port}`, 'sec-fetch-site': 'same-origin' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'text/event-stream');
    const chunks = (await ok.text()).split('\n\n').filter(Boolean).map((b) => JSON.parse(b.slice(6)));
    assert.deepEqual(chunks.slice(0, 2), [{ t: 'hello' }, { t: ' there' }]);
    assert.equal(chunks.at(-1).done, true);
    assert.equal(chunks.at(-1).device, 'fast');
  } finally { await d.close(); }
});

test('dashboard: the sse stream opens with a snapshot and carries every patch', async () => {
  const state = newState();
  const d = await startDashboard({ port: 0, state });
  try {
    const first = await sseFirst(`${d.url}events`);
    assert.equal(first.events[0].event, 'snapshot');
    assert.equal(first.events[0].data.mode, 'chat');
    assert.equal(first.events[0].data.peers[0].name, 'phone');
    // a second stream, then a gate open, a log line and an api change arrive in order
    const p = sseFirst(`${d.url}events`, 5);
    await new Promise((r) => setTimeout(r, 50));
    state.gate({ type: 'open', channel: 'api', peer: '10.0.0.9', at: 1000 });
    state.log('hello log');
    state.api({ loaded: true, model: 'tiny.gguf', ctx: 2048, heldMB: 12 });
    const { events } = await p;
    assert.deepEqual(events.map((e) => e.event), ['snapshot', 'gate', 'traffic', 'log', 'api']);
    assert.equal(events[4].data.model, 'tiny.gguf');
    assert.equal(events[1].data.open[0].peer, '10.0.0.9');
    assert.equal(events[2].data.api.opens, 1);
    assert.equal(events[3].data, 'hello log');
    const snap = await (await fetch(`${d.url}state.json`)).json();
    assert.equal(snap.api.model, 'tiny.gguf');
    assert.equal(snap.gate.open.length, 1);
    state.gate({ type: 'close', channel: 'api', peer: '10.0.0.9', at: 2000, ms: 1000, bytesIn: 10, bytesOut: 20 });
    const after = await (await fetch(`${d.url}state.json`)).json();
    assert.equal(after.gate.open.length, 0);
    assert.deepEqual(after.traffic.api, { opens: 1, closes: 1, rejects: 0, bytesIn: 10, bytesOut: 20 });
  } finally { await d.close(); }
});

test('dashboard: batch streams one line per prompt and a report with tok/s per device; probe / verify / load answer', async () => {
  const state = newState();
  let probed = 0, verified = 0;
  const loads: string[] = [];
  const cluster = fakeCluster();
  const d = await startDashboard({ port: 0, state, chat: cluster, actions: { probe: async () => { probed++; }, verify: () => { verified++; }, load: async (m) => { loads.push(m); } } });
  const post = (route: string, body: unknown = {}) => fetch(`${d.url}${route}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${d.port}` } });
  try {
    const res = await post('batch');
    const chunks = (await res.text()).split('\n\n').filter(Boolean).map((b) => JSON.parse(b.slice(6)));
    assert.equal(chunks[0].prompts.length, 8);
    assert.equal(chunks.filter((c) => c.i !== undefined).length, 8);
    const last = chunks.at(-1);
    assert.equal(last.done, true);
    assert.deepEqual(last.report.map((r: any) => [r.device, r.prompts]), [['fast', 4], ['slow', 4]]);
    assert.ok(last.report[0].tps > last.report[1].tps);
    const two = await post('batch', { prompts: ['a', 'b'] });
    assert.equal((await two.text()).split('\n\n').filter(Boolean).length, 4);
    assert.equal((await post('probe')).status, 200);
    assert.equal((await post('verify')).status, 200);
    assert.equal((await post('load', { model: '../../etc/passwd' })).status, 200);
    assert.deepEqual([probed, verified, loads], [1, 1, ['passwd']]);
    assert.equal((await post('load', {})).status, 400);
    assert.equal((await post('nothing')).status, 404);
    assert.equal((await post('chat', { messages: [] })).status, 400);
    const bad = await fetch(`${d.url}chat`, { method: 'POST', body: '{nope', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${d.port}` } });
    assert.equal(bad.status, 400);
  } finally { await d.close(); }
});

test('dashboard: the qr is drawn on the server and the secret is in no body', async () => {
  const state = newState();
  state.log(`never ${SECRET}`.replace(SECRET, '***')); // the log sink would be the obvious leak: share() masks nothing, so it must not log the secret
  const d = await startDashboard({ port: 0, state, qrText: () => JSON.stringify({ k: 'kula-peer', secret: SECRET }), chat: fakeCluster() });
  try {
    const svg = await fetch(`${d.url}qr.svg`);
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    const bodies: Record<string, string> = { svg: await svg.text() };
    for (const r of ['', 'app.js', 'app.css', 'state.json']) bodies[r || 'index'] = await (await fetch(`${d.url}${r}`)).text();
    bodies.events = (await sseFirst(`${d.url}events`)).text;
    bodies.chat = await (await fetch(`${d.url}chat`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: SECRET }] }), headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${d.port}` } })).text();
    assert.match(bodies.svg, /^<svg /);
    for (const [name, body] of Object.entries(bodies)) {
      assert.ok(!body.includes(SECRET), `the secret is in ${name}`);
      assert.ok(!body.includes(SECRET.slice(0, 12)), `part of the secret is in ${name}`);
    }
    // without a qr the route says so
    const none = await startDashboard({ port: 0, state });
    assert.equal((await fetch(`${none.url}qr.svg`)).status, 404);
    await none.close();
  } finally { await d.close(); }
});

test('share: the dashboard comes up with the worker; a handshake through the gate shows on it; nothing leaks', { timeout: 60000 }, async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-dash-models-'));
  fs.writeFileSync(path.join(models, 'a.gguf'), 'x');
  const peer: Peer = { id: 'id-p', name: 'phone', host: '127.0.0.1', port: 1, secret: SECRET, kind: 'phone', ram: 1, bw: 1, added_at: 't' };
  writePeers([peer]);
  const secret = 'abcdef0123456789abcdef0123456789';
  const quiet = console.log;
  console.log = () => {};
  let stop: Awaited<ReturnType<typeof share>> | null = null;
  try {
    stop = await share({ port: 0, models, secret, noQr: true, dashboard: 0, name: 'tester' });
    assert.ok(stop.dashboard, 'no dashboard');
    const url = stop.dashboard!.url;
    const snap = await (await fetch(`${url}state.json`)).json();
    assert.equal(snap.mode, 'share');
    assert.equal(snap.self.name, 'tester');
    assert.equal(snap.gate.port, stop.gatePort);
    assert.equal(snap.hasQr, true);
    assert.deepEqual(snap.models, ['a.gguf']);
    assert.equal(snap.peers[0].name, 'phone');
    assert.ok(snap.ledger.total >= 1, 'the claim line');
    // the pairing qr carries the secret as modules only
    const svg = await (await fetch(`${url}qr.svg`)).text();
    assert.match(svg, /^<svg /);
    // a wrong secret is refused and counted; the right one on the api channel opens (and closes: no llama.cpp here)
    const bad = await probe('127.0.0.1', stop.gatePort, 'ffffffffffffffffffffffffffffffff', 'api');
    assert.equal(bad.ok, false);
    const good = await probe('127.0.0.1', stop.gatePort, secret, 'api');
    assert.ok(good.ok || (good as any).reason === 'channel closed', JSON.stringify(good));
    await new Promise((r) => setTimeout(r, 200));
    const after = await (await fetch(`${url}state.json`)).json();
    assert.ok(after.traffic.api.rejects >= 1 || after.gate.lastReject, 'the refusal is on the page');
    assert.equal(after.gate.lastReject?.peer, '127.0.0.1');
    assert.ok(after.log.some((l: string) => /refused 127\.0\.0\.1/.test(l)), 'the log reached the page');
    // the verify button
    const ver = await fetch(`${url}verify`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${stop.dashboard!.port}` } });
    assert.equal(ver.status, 200);
    const verified = await (await fetch(`${url}state.json`)).json();
    assert.equal(verified.ledger.verify.ok, true);
    // neither our secret nor the peer's is anywhere
    for (const r of ['', 'app.js', 'state.json', 'qr.svg']) {
      const body = await (await fetch(`${url}${r}`)).text();
      assert.ok(!body.includes(secret), `the cluster secret is in ${r || 'index'}`);
      assert.ok(!body.includes(SECRET), `the peer secret is in ${r || 'index'}`);
    }
    const events = (await sseFirst(`${url}events`)).text;
    assert.ok(!events.includes(secret) && !events.includes(SECRET));
    // the chat box without a model says so instead of hanging
    const chat = await fetch(`${url}chat`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${stop.dashboard!.port}` } });
    const text = await chat.text();
    assert.match(text, /"error"/);
  } finally {
    console.log = quiet;
    if (stop) await stop();
    fs.rmSync(models, { recursive: true, force: true });
  }
});

after(() => { fs.rmSync(HOME, { recursive: true, force: true }); });
