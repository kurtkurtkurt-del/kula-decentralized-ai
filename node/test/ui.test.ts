// `kula-node ui`: the chat page and its OpenAI-compatible endpoint. Loopback only, a random
// prefix, same-origin posts, no secret in any body, conversations on disk; then the main use
// end to end: a fake phone (the real worker api, a fake llama-server, the real gate with tls
// and a one-time code) paired by hand, a catalog model loaded on it through the page's api,
// tokens streamed to the page, and the same model answering /v1/chat/completions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-ui-home-'));
process.env.KULA_NODE_HOME = HOME;

const { renderMarkdown, splitThink, stripThink, inline } = await import('../src/ui/static/markdown.js');
const { startUi, fromOpenAi } = await import('../src/ui/server.ts');
const { Engine, PRIVATE_URL_NOTE, needMb } = await import('../src/ui/engine.ts');
const { ChatStore, titleOf } = await import('../src/ui/store.ts');
const { UI_CATALOG } = await import('../src/ui/catalog.ts');
const { uiRows } = await import('../tools/ui-catalog.ts');
const { startApiServer } = await import('../src/api.ts');
const { startGateServer } = await import('../src/gate.ts');
const { createIdentity, Paired } = await import('../src/tls.ts');
const { serveModel } = await import('../src/modelserve.ts');
const { writePeers, readPeers } = await import('../src/peers.ts');
type Peer = import('../src/peers.ts').Peer;

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const SECRET = 'deadbeefcafef00d0123456789abcdef';
const PIN = '0123456789abcdef';

// ---------- helpers

function fakeLlamaServer(delayMs: number, pieces: string[]): Promise<{ port: number; close: () => void; chats: number; last: any }> {
  return new Promise((resolve) => {
    const state = { port: 0, close: () => {}, chats: 0, last: null as any };
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        state.chats++;
        try { state.last = JSON.parse(body); } catch {}
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const t = setInterval(() => {
          if (i < pieces.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: pieces[i].startsWith("~") ? { reasoning_content: pieces[i++].slice(1) } : { content: pieces[i++] } }] })}\n\n`);
          else { res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: pieces.length } })}\n\ndata: [DONE]\n\n`); res.end(); clearInterval(t); }
        }, delayMs);
        res.on('close', () => clearInterval(t));
      });
    });
    s.listen(0, '127.0.0.1', () => { state.port = (s.address() as any).port; state.close = () => s.close(); resolve(state); });
  });
}

// a phone as "share this phone" makes it: worker api behind a tls gate with a one-time code
async function fakePhone(pieces = ['<think>', 'hmm', '</think>', 'Hel', 'lo', ' **there**', '!'], delayMs = 3) {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-ui-phone-'));
  const llama = await fakeLlamaServer(delayMs, pieces);
  const loads: string[] = [];
  const api = await startApiServer({ models, llama: null, allowPrivateUrls: true, startBackend: async (file, ctx) => { loads.push(`${path.basename(file)}:${ctx}`); return { port: llama.port, stop: async () => {} }; } });
  const identity = createIdentity('phone');
  const tls = { identity, paired: new Paired(null), pin: PIN as string | null };
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: (ch) => (ch === 'api' ? api.port : null), tls });
  return {
    port: gate.port, fp: identity.fp, loads, llama, models, tls,
    close: async () => { await gate.close(); await api.close(); llama.close(); fs.rmSync(models, { recursive: true, force: true }); },
  };
}

async function tinyModel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-ui-model-'));
  const file = path.join(dir, 'tiny-q8_0.gguf');
  const bytes = randomBytes(150_000);
  fs.writeFileSync(file, bytes);
  const served = await serveModel(file, '127.0.0.1', '127.0.0.1');
  const entry = {
    id: 'tiny', name: 'Tiny 0.1B', family: 'tiny', params_b: 0.1, quant: 'Q8_0', repo: 'x/y', file: 'tiny-q8_0.gguf', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), license: 'mit', ctx_max: 8192, kv_mb_per_1k: 8, blurb: 'a test model', good: '', url: served.url,
  };
  return { entry, dir, served, close: async () => { await served.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function newEngine(extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(HOME, 'e-'));
  const modelsDir = path.join(dir, 'models');
  fs.mkdirSync(modelsDir);
  const peersFile = path.join(dir, 'peers.json');
  const engine = new Engine({ peersFile, modelDirs: [modelsDir], identity: createIdentity('mac'), llama: null, probeMs: 1500, ...extra });
  return { engine, peersFile, modelsDir, dir };
}

const origin = (port: number) => ({ origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' });
const post = (url: string, port: number, body: unknown, headers: Record<string, string> = origin(port)) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function sseAll(res: Response): Promise<any[]> {
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => b.slice(6)).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
}

function rawGet(port: number, p: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

// ---------- pure parts

test('markdown: every bit of model text is escaped; links keep http(s) only; code, lists, tables', () => {
  const evil = '<script>alert(1)</script> <img src=x onerror="alert(2)"> **<b>bold</b>** `<i>` [x](javascript:alert(3)) [y](https://ok.example/?a=1&b="2")';
  const html = renderMarkdown(evil);
  assert.ok(!/<script|<img|<b>|<i>|onerror="/i.test(html), html);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<strong>&lt;b&gt;bold&lt;\/b&gt;<\/strong>/);
  assert.match(html, /<code>&lt;i&gt;<\/code>/);
  assert.ok(!html.includes('href="javascript'), 'no javascript: link');
  assert.match(html, /<a href="https:\/\/ok\.example\/\?a=1&amp;b=&quot;2&quot;" target="_blank" rel="noopener noreferrer">y<\/a>/);
  // a fence keeps its content verbatim (escaped), and gets a copy button
  const code = renderMarkdown('```html\n<div onclick="x()">hi</div>\n```');
  assert.match(code, /<pre><code class="language-html">&lt;div onclick=&quot;x\(\)&quot;&gt;hi&lt;\/div&gt;<\/code><\/pre>/);
  assert.match(code, /data-copy/);
  // a language name cannot break out either
  assert.ok(!renderMarkdown('```"><script>\nx\n```').includes('<script>'));
  // structure
  assert.match(renderMarkdown('# t\n\n- a\n- b\n  - c\n\n1. x\n2. y'), /<h1>t<\/h1>\n<ul><li>a<\/li><li>b<ul><li>c<\/li><\/ul><\/li><\/ul>\n<ol><li>x<\/li><li>y<\/li><\/ol>/);
  assert.match(renderMarkdown('| a | b |\n|---|---|\n| <1> | 2 |'), /<td>&lt;1&gt;<\/td>/);
  assert.equal(inline('snake_case_name and *it*'), 'snake_case_name and <em>it</em>');
  // no attribute other than the few it writes itself
  const attrs = [...renderMarkdown(evil + '\n\n```js\nx\n```\n\n- [x] done').matchAll(/<[a-z0-9]+\s([^>]*)>/g)].flatMap((m) => [...m[1].replace(/"[^"]*"/g, '""').matchAll(/([a-z-]+)=/g)].map((x) => x[1]));
  assert.ok(attrs.every((a) => ['href', 'target', 'rel', 'class', 'type', 'data-copy', 'start'].includes(a)), attrs.join(','));
  // thinking
  assert.deepEqual(splitThink('<think>\nhmm\n</think>\n\nhi'), { think: 'hmm', answer: 'hi', thinking: false });
  assert.deepEqual(splitThink('<think>still'), { think: 'still', answer: '', thinking: true });
  assert.deepEqual(splitThink('plain'), { think: null, answer: 'plain', thinking: false });
  assert.equal(stripThink('<think>x</think>answer'), 'answer');
});

test('the catalog copy matches the phone app\'s catalog', () => {
  assert.deepEqual(UI_CATALOG, uiRows(), 'node/src/ui/catalog.ts is behind app/src/llm/catalog.ts: run `npx tsx tools/ui-catalog.ts` in node/');
  for (const m of UI_CATALOG) assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.equal(needMb(1024 * 1024 * 1000, 64, 4096), Math.round(1000 * 1.05 + 256 + 300));
});

test('openai messages: text parts joined, developer is system, tool is user', () => {
  assert.deepEqual(fromOpenAi([{ role: 'developer', content: 'be brief' }, { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: {} }, { type: 'text', text: 'b' }] }, { role: 'tool', content: 'r' }, { role: 'assistant', content: null }]),
    [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'ab' }, { role: 'user', content: 'r' }, { role: 'assistant', content: '' }]);
});

test('conversations: put, title from the first message, list newest first, search, rename, delete; files are 600', async () => {
  const store = new ChatStore(path.join(HOME, 'chats-unit'));
  assert.deepEqual(store.list(), []);
  const a = store.put('aaaaaaaaaaaaaaaa', { messages: [{ role: 'user', content: '  how do\n tides work?  ' }, { role: 'assistant', content: 'the moon', meta: { tps: 12.5, device: 'pixel', evil: 'x' } }] });
  assert.equal(a.title, 'how do tides work?');
  assert.deepEqual(a.messages[1].meta, { tps: 12.5, device: 'pixel' });
  await new Promise((r) => setTimeout(r, 5));
  store.put('bbbbbbbbbbbbbbbb', { messages: [{ role: 'user', content: 'x'.repeat(100) }] });
  assert.deepEqual(store.list().map((r) => r.id), ['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa']);
  assert.equal(store.list()[0].title.length, 58);
  assert.deepEqual(store.list('MOON').map((r) => r.id), ['aaaaaaaaaaaaaaaa']);
  const r = store.rename('aaaaaaaaaaaaaaaa', 'tides');
  assert.equal(r?.title, 'tides');
  // a renamed chat keeps its name when more is said
  assert.equal(store.put('aaaaaaaaaaaaaaaa', { messages: [{ role: 'user', content: 'other' }] }).title, 'tides');
  assert.equal((fs.statSync(path.join(store.dir, 'aaaaaaaaaaaaaaaa.json')).mode & 0o777), 0o600);
  assert.equal(store.remove('aaaaaaaaaaaaaaaa'), true);
  assert.equal(store.get('aaaaaaaaaaaaaaaa'), null);
  assert.throws(() => store.put('../etc', {}), /bad id/);
  assert.equal(titleOf([]), 'new chat');
});

// ---------- the server

test('ui server: 127.0.0.1 only, random prefix, host check, same-origin posts, no secret in any body', async () => {
  const { engine, peersFile } = newEngine();
  const relayPin = 'feedfacefeedface';
  const peers: Peer[] = [
    { id: 'id-phone', name: 'phone', host: '10.0.0.9', port: 50551, secret: SECRET, kind: 'phone', ram: 6000, bw: 30, added_at: 't' },
    { id: 'relay:123456', name: 'far', host: '', port: 0, secret: '', fp: null, pin: relayPin, relay: { url: 'wss://relay.example', code: '123456' }, kind: 'phone', ram: null, bw: null, added_at: 't' },
  ];
  writePeers(peers, peersFile);
  const ui = await startUi({ port: 0, engine, store: new ChatStore(path.join(HOME, 'chats-srv')), token: 'kula-' + 'ab'.repeat(20) });
  try {
    assert.match(ui.url, new RegExp(`^http://127\\.0\\.0\\.1:${ui.port}/[0-9a-f]{24}/$`));
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    if (lan) {
      const refused = await new Promise<boolean>((resolve) => {
        const s = net.connect({ host: lan, port: ui.port });
        const t = setTimeout(() => { s.destroy(); resolve(true); }, 1500);
        s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(false); });
        s.once('error', () => { clearTimeout(t); resolve(true); });
      });
      assert.equal(refused, true, `the chat page answered on ${lan}`);
    }
    const root = await fetch(`http://127.0.0.1:${ui.port}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), `/${ui.prefix}/`);
    assert.equal((await fetch(`http://127.0.0.1:${ui.port}/api/peers`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${ui.port}/${'0'.repeat(24)}/api/peers`)).status, 404);
    assert.equal(await rawGet(ui.port, `/${ui.prefix}/api/status`, `evil.example:${ui.port}`), 400);
    assert.equal(await rawGet(ui.port, `/v1/models`, `evil.example:${ui.port}`), 400);
    assert.equal(await rawGet(ui.port, `/${ui.prefix}/api/status`, `localhost:${ui.port}`), 200);
    const page = await fetch(ui.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'; script-src 'self'/);
    assert.match(await page.text(), /<title>kula chat<\/title>/);
    for (const f of ['app.js', 'app.css', 'markdown.js']) assert.equal((await fetch(ui.url + f)).status, 200, f);
    assert.equal((await fetch(ui.url + 'app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');

    // posts: no origin, a foreign one, another local port, a cross-site fetch: refused
    const u = `${ui.url}api/chats/cccccccccccccccc`;
    assert.equal((await post(u, ui.port, {}, {})).status, 403);
    assert.equal((await post(u, ui.port, {}, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(u, ui.port, {}, { origin: `http://127.0.0.1:${ui.port + 1}` })).status, 403);
    assert.equal((await post(u, ui.port, {}, { origin: `http://127.0.0.1:${ui.port}`, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await post(`${ui.url}api/peers/remove`, ui.port, { id: 'id-phone' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal(readPeers(peersFile).length, 2, 'nothing was removed');

    // no secret, no pairing code in what the page can read
    for (const route of ['peers', 'status', 'models', 'chats', 'settings']) {
      const text = await (await fetch(`${ui.url}api/${route}`)).text();
      assert.ok(!text.includes(SECRET), `${route} leaks the secret`);
      assert.ok(!text.includes(relayPin), `${route} leaks the pin`);
    }
    const list = await (await fetch(`${ui.url}api/peers`)).json();
    assert.deepEqual(list.map((p: any) => p.name), ['phone', 'far']);
    assert.ok(list.every((p: any) => !('secret' in p) && !('pin' in p) && !('fp' in p)));
    assert.equal(list[1].waitingPair, true);
    assert.equal(list[1].far, true);
    const probed = await (await post(`${ui.url}api/peers/probe`, ui.port, { ids: ['id-phone'] })).text();
    assert.ok(!probed.includes(SECRET));

    // the page's conversation api
    const put = await post(u, ui.port, { messages: [{ role: 'user', content: 'hello there' }, { role: 'assistant', content: 'hi', meta: { tps: 3 } }] });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).title, 'hello there');
    assert.deepEqual((await (await fetch(`${ui.url}api/chats`)).json()).map((c: any) => c.title), ['hello there']);
    assert.equal((await (await fetch(`${ui.url}api/chats/cccccccccccccccc`)).json()).messages[1].meta.tps, 3);
    assert.equal((await (await post(`${u}/rename`, ui.port, { title: 'greeting' })).json()).title, 'greeting');
    assert.deepEqual((await (await fetch(`${ui.url}api/chats?q=greet`)).json()).map((c: any) => c.id), ['cccccccccccccccc']);
    assert.equal((await post(`${u}/delete`, ui.port, {})).status, 200);
    assert.equal((await fetch(`${ui.url}api/chats/cccccccccccccccc`)).status, 404);
    assert.equal((await fetch(`${ui.url}api/chats/..%2f..%2fpeers`)).status, 404);

    // chatting before anything is loaded says so
    const none = await sseAll(await post(`${ui.url}api/chat`, ui.port, { messages: [{ role: 'user', content: 'x' }] }));
    assert.match(none.at(-1).error, /no model loaded/);
  } finally { await ui.close(); await engine.close(); }
});

test('mode phone end to end: pair by hand through a real tls gate, the phone fetches the model, tokens reach the page, /v1 answers', async () => {
  const phone = await fakePhone();
  const model = await tinyModel();
  const { engine, peersFile } = newEngine({ catalog: [model.entry] });
  const token = 'kula-' + 'cd'.repeat(20);
  const ui = await startUi({ port: 0, engine, store: new ChatStore(path.join(HOME, 'chats-e2e')), token });
  try {
    // a wrong code, a certificate that does not match: refused, nothing kept
    const wrong = await post(`${ui.url}api/peers/add`, ui.port, { address: `127.0.0.1:${phone.port}`, pin: 'ffffffffffffffff' });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /wrong pin/);
    const badFp = await post(`${ui.url}api/peers/add`, ui.port, { address: `127.0.0.1:${phone.port}`, pin: PIN, fp: '00000000' });
    assert.match((await badFp.json()).error, /does not match/);
    assert.deepEqual(readPeers(peersFile), []);
    // the code was spent on that refused pairing (the gate does not know we walked away); a new one
    phone.tls.pin = PIN;

    const added = await post(`${ui.url}api/peers/add`, ui.port, { address: `127.0.0.1:${phone.port}`, pin: PIN.toUpperCase().replace(/(.{4})/g, '$1 '), fp: phone.fp.slice(0, 16), name: 'pixel' });
    assert.equal(added.status, 200, await added.clone().text());
    const row = await added.json();
    assert.equal(row.name, 'pixel');
    assert.equal(row.tls, true);
    const kept = readPeers(peersFile)[0];
    assert.equal(kept.fp, phone.fp);
    assert.equal(kept.pin, null);
    assert.equal(phone.tls.paired.size, 1, 'the phone now knows this computer');

    // a file only on this computer cannot go to a phone: said, not attempted
    const localOnly = await sseAll(await post(`${ui.url}api/load`, ui.port, { model: 'local:nothing.gguf', mode: 'phone' }));
    assert.match(localOnly.at(-1).error, /no such file here/);

    // load the catalog model on the phone: it downloads it (from the url in the catalog) itself
    const events = await sseAll(await post(`${ui.url}api/load`, ui.port, { model: 'tiny', mode: 'phone', peers: [row.id], ctx: 2048 }));
    const last = events.at(-1);
    assert.equal(last.done, true, JSON.stringify(events.slice(-3)));
    assert.equal(last.status.loaded.mode, 'phone');
    assert.deepEqual(last.status.loaded.devices.map((d: any) => d.name), ['pixel']);
    assert.ok(events.some((e) => e.phase === 'running' && e.device === 'pixel'), 'download progress from the phone');
    assert.deepEqual(phone.loads, ['tiny-q8_0.gguf:2048']);
    assert.ok(fs.existsSync(path.join(phone.models, 'tiny-q8_0.gguf')));
    const st = await (await fetch(`${ui.url}api/status`)).json();
    assert.ok(st.plan.some((l: string) => /runs on pixel; this computer only carries the chat/.test(l)), st.plan.join('\n'));
    assert.ok(st.decisions.some((d: any) => /tiny 0\.1b ready on pixel/i.test(d.text)));
    // a probe asks the phone what it has loaded (its /status): the connect sheet offers that first
    assert.equal(row.holds, null);
    const probed = await (await post(`${ui.url}api/peers/probe`, ui.port, { ids: [row.id] })).json();
    assert.equal(probed.find((p: any) => p.id === row.id).holds, 'tiny-q8_0.gguf');

    // chat: tokens one by one, then done with the numbers and the device
    const chat = await sseAll(await post(`${ui.url}api/chat`, ui.port, { messages: [{ role: 'system', content: 'be kind' }, { role: 'user', content: 'hi' }], maxTokens: 64, temperature: 0.2 }));
    assert.deepEqual(chat.filter((e) => 't' in e).map((e) => e.t), ['<think>', 'hmm', '</think>', 'Hel', 'lo', ' **there**', '!']);
    const done = chat.at(-1);
    assert.equal(done.done, true);
    assert.equal(done.device, 'pixel');
    assert.equal(done.tokens, 7);
    assert.ok(typeof done.tps === 'number' && typeof done.firstMs === 'number');
    assert.equal(phone.llama.last.temperature, 0.2);
    assert.equal(phone.llama.last.max_tokens, 64);
    assert.equal(phone.llama.last.messages[0].role, 'system');

    // the openai endpoint: a token, then the same model
    const v1 = `http://127.0.0.1:${ui.port}/v1`;
    assert.equal((await fetch(`${v1}/models`)).status, 401);
    assert.equal((await fetch(`${v1}/models`, { headers: { authorization: 'Bearer nope' } })).status, 401);
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const models = await (await fetch(`${v1}/models`, { headers: auth })).json();
    assert.deepEqual(models.data.map((m: any) => m.id), ['kula', 'tiny']);
    assert.equal(models.object, 'list');
    // a page on another origin is refused even with the token
    assert.equal((await fetch(`${v1}/models`, { headers: { ...auth, origin: 'http://evil.example' } })).status, 403);

    const plain = await fetch(`${v1}/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'kula', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], max_tokens: 50 }) });
    assert.equal(plain.status, 200);
    const one = await plain.json();
    assert.equal(one.object, 'chat.completion');
    assert.match(one.id, /^chatcmpl-/);
    assert.equal(one.model, 'kula');
    assert.deepEqual(one.choices[0].message, { role: 'assistant', content: '<think>hmm</think>Hello **there**!' });
    assert.equal(one.choices[0].finish_reason, 'stop');
    assert.equal(one.usage.completion_tokens, 7);

    const streamed = await fetch(`${v1}/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'tiny', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 7, stream_options: { include_usage: true } }) });
    const raw = await streamed.text();
    assert.ok(raw.trimEnd().endsWith('data: [DONE]'), raw.slice(-80));
    const chunks = raw.split('\n\n').filter((b) => b.startsWith('data: ') && b !== 'data: [DONE]').map((b) => JSON.parse(b.slice(6)));
    assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk' && c.id === chunks[0].id && c.model === 'tiny'));
    assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
    assert.equal(chunks.filter((c) => c.choices[0]?.delta?.content).map((c) => c.choices[0].delta.content).join(''), '<think>hmm</think>Hello **there**!');
    const fin = chunks.filter((c) => c.choices[0]?.finish_reason);
    assert.equal(fin.length, 1);
    assert.equal(fin[0].choices[0].finish_reason, 'length');
    assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 0, completion_tokens: 7, total_tokens: 7 });
    assert.equal((await fetch(`${v1}/chat/completions`, { method: 'POST', headers: auth, body: '{"messages":[]}' })).status, 400);

    // unloaded: /v1 says so instead of hanging
    assert.equal((await post(`${ui.url}api/unload`, ui.port, {})).status, 200);
    const gone = await fetch(`${v1}/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(gone.status, 503);
    assert.match((await gone.json()).error.message, /no model loaded/);
  } finally {
    await ui.close();
    await engine.close();
    await model.close();
    await phone.close();
  }
});

test('stop: closing the page\'s stream stops the phone, keeps what came, and the next prompt works', async () => {
  const phone = await fakePhone(Array.from({ length: 60 }, (_, i) => `w${i} `), 25);
  const model = await tinyModel();
  const { engine } = newEngine({ catalog: [model.entry] });
  const ui = await startUi({ port: 0, engine, store: new ChatStore(path.join(HOME, 'chats-stop')), token: 'kula-' + 'ef'.repeat(20) });
  try {
    await engine.pairByHand({ address: `127.0.0.1:${phone.port}`, pin: PIN, name: 'pixel' });
    const loaded = await sseAll(await post(`${ui.url}api/load`, ui.port, { model: 'tiny', mode: 'phone' }));
    assert.equal(loaded.at(-1).done, true, JSON.stringify(loaded.at(-1)));
    const ac = new AbortController();
    const res = await fetch(`${ui.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...origin(ui.port) }, body: JSON.stringify({ messages: [{ role: 'user', content: 'long' }] }), signal: ac.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /"t":"w0 "/);
    ac.abort();
    // the engine lets go quickly and the phone is free again
    const t0 = Date.now();
    while ((await (await fetch(`${ui.url}api/status`)).json()).chatting > 0) { assert.ok(Date.now() - t0 < 5000, 'still chatting'); await new Promise((r) => setTimeout(r, 50)); }
    const st = await (await fetch(`${ui.url}api/status`)).json();
    assert.ok(st.decisions.some((d: any) => /\(stopped\)/.test(d.text)), JSON.stringify(st.decisions));
    assert.ok(Date.now() - t0 < 3000, 'stopped by /stop, not by the 4 s cut');
    phone.llama.chats = 0;
    const again = await sseAll(await post(`${ui.url}api/chat`, ui.port, { messages: [{ role: 'user', content: 'short' }], maxTokens: 4 }));
    assert.equal(again.at(-1).done, true, JSON.stringify(again.at(-1)));
    // the stop button: the page's own stop route
    const p = sseAll(await post(`${ui.url}api/chat`, ui.port, { messages: [{ role: 'user', content: 'again' }] }));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal((await (await post(`${ui.url}api/stop`, ui.port, {})).json()).stopped, 1);
    const stopped = (await p).at(-1);
    assert.equal(stopped.done, true);
    assert.equal(stopped.stopped, true);
    assert.ok(stopped.tokens < 60);
  } finally {
    await ui.close();
    await engine.close();
    await model.close();
    await phone.close();
  }
});

test('mode here with a fake llama-server: a catalog model is fetched to this computer first, sha-checked; a local file in phone mode is refused with the reason', async () => {
  const model = await tinyModel();
  const llama = await fakeLlamaServer(2, ['~let me ', '~think', 'ok']);
  const { engine, modelsDir } = newEngine({ catalog: [model.entry], startBackend: async () => ({ port: llama.port, stop: async () => {} }) });
  try {
    const events: any[] = [];
    const st = await engine.load({ model: 'tiny', mode: 'here' }, (e) => events.push(e));
    assert.deepEqual(st.loaded?.devices.map((d) => d.name), ['this computer']);
    assert.ok(fs.existsSync(path.join(modelsDir, 'tiny-q8_0.gguf')));
    assert.ok(events.some((e) => e.phase === 'running' && e.device === 'this computer'));
    let text = '';
    const r = await engine.chat([{ role: 'user', content: 'x' }], (t) => { text += t; });
    assert.equal(text, '<think>let me think</think>\n\nok', 'reasoning_content arrives inline like the phone sends it');
    assert.equal(r.device, 'this computer');
    // the list now marks it as here, and a stray gguf shows up as a local file
    fs.writeFileSync(path.join(modelsDir, 'mine-Q4_K_M.gguf'), 'x');
    const rows = engine.models();
    assert.equal(rows.find((m) => m.id === 'tiny')?.here, true);
    const mine = rows.find((m) => m.id === 'local:mine-Q4_K_M.gguf');
    assert.equal(mine?.catalog, false);
    assert.equal(mine?.quant, 'Q4_K_M');
    // a local file reaches devices only over the wi-fi, from this computer's own address (10.11.2026)
    await assert.rejects(engine.load({ model: 'local:mine-Q4_K_M.gguf', mode: 'phone' }, () => {}), /no paired device/);
    await assert.rejects(engine.load({ model: 'local:mine-Q4_K_M.gguf', mode: 'apart' }, () => {}), (e: Error) => e.message === PRIVATE_URL_NOTE);
    await assert.rejects(engine.load({ model: 'nope', mode: 'phone' }, () => {}), /unknown model/);
    await assert.rejects(engine.load({ model: 'tiny', mode: 'phone' }, () => {}), /no paired device/);
    // without llama.cpp, split and here say what is missing
    const bare = newEngine({ catalog: [model.entry] }).engine;
    await assert.rejects(bare.load({ model: 'tiny', mode: 'split' }, () => {}), /split needs llama\.cpp/);
  } finally {
    await engine.close();
    llama.close();
    await model.close();
  }
});

test('picked devices: with all the load uses exactly the ticked ones (none is none), this computer can be left out of apart, and the plan says which', async () => {
  const pixel = await fakePhone(['a']);
  const tab = await fakePhone(['b']);
  const model = await tinyModel();
  const llama = await fakeLlamaServer(2, ['here']);
  const { engine, modelsDir } = newEngine({ catalog: [model.entry], startBackend: async () => ({ port: llama.port, stop: async () => {} }) });
  try {
    const p = await engine.pairByHand({ address: `127.0.0.1:${pixel.port}`, pin: PIN, name: 'pixel' });
    const t = await engine.pairByHand({ address: `127.0.0.1:${tab.port}`, pin: PIN, name: 'tab' });
    // the file is on this computer too, so apart could use it: the page left it out
    fs.copyFileSync(path.join(model.dir, 'tiny-q8_0.gguf'), path.join(modelsDir, 'tiny-q8_0.gguf'));
    let st = await engine.load({ model: 'tiny', mode: 'apart', peers: [p.id], all: true, here: false }, () => {});
    assert.deepEqual(st.loaded?.devices.map((d) => d.name), ['pixel']);
    assert.deepEqual(tab.loads, [], 'the unticked tablet was not asked');
    assert.ok(st.plan.includes('you picked pixel: only it is used.'), st.plan.join('\n'));
    assert.ok(st.plan.includes('this computer sits out: you left it out.'), st.plan.join('\n'));
    // this computer ticked too
    st = await engine.load({ model: 'tiny', mode: 'apart', peers: [t.id], all: true, here: true }, () => {});
    assert.deepEqual(st.loaded?.devices.map((d) => d.name).sort(), ['tab', 'this computer']);
    assert.ok(st.plan.includes('you picked this computer, tab: only these are used.'), st.plan.join('\n'));
    // nothing ticked is nothing, not every paired device
    await assert.rejects(engine.load({ model: 'tiny', mode: 'apart', peers: [], all: true, here: false }, () => {}), /pick at least one device/);
    await assert.rejects(engine.load({ model: 'tiny', mode: 'phone', peers: [], all: true }, () => {}), /pick the device that runs it/);
    await assert.rejects(engine.load({ model: 'tiny', mode: 'split', peers: [], all: true }, () => {}), /at least one device besides this computer/);
    // phone: exactly the ticked one
    st = await engine.load({ model: 'tiny', mode: 'phone', peers: [t.id], all: true }, () => {});
    assert.deepEqual(st.loaded?.devices.map((d) => d.name), ['tab']);
    assert.ok(st.plan.includes('you picked tab: only it is used.'), st.plan.join('\n'));
    // without all (older pages, the advanced sheet): an empty list still means every paired device
    st = await engine.load({ model: 'tiny', mode: 'apart', peers: [] }, () => {});
    assert.deepEqual(st.loaded?.devices.map((d) => d.name).sort(), ['pixel', 'tab', 'this computer']);
    assert.ok(!st.plan.some((l) => /you picked/.test(l)));
  } finally {
    await engine.close();
    llama.close();
    await model.close();
    await pixel.close();
    await tab.close();
  }
});

// finding A5 (12.11.2026): a card's id leaves out its devices, so the page sends the action it drew
// and the server runs it only while the card still says exactly that; otherwise the fresh view, nothing run
test('brain/apply runs only the action the person saw: a changed or missing action is a 409 with the fresh view, nothing loads', async () => {
  const { GodsEye, dark } = await import('../src/godseye/index.ts');
  const { sameAction } = await import('../src/godseye/eye.ts');
  assert.equal(sameAction({ do: 'load', model: 'm', mode: 'apart', devices: ['p1'] }, { devices: ['p1'], mode: 'apart', model: 'm', do: 'load' }), true, 'key order does not matter');
  assert.equal(sameAction({ do: 'load', model: 'm', mode: 'apart', devices: ['p1'] }, { do: 'load', model: 'm', mode: 'apart', devices: ['p1', 'p2'] }), false);
  assert.equal(sameAction({ do: 'unload' }, { do: 'unload', extra: 1 }), false);
  assert.equal(sameAction({ do: 'unload' }, undefined), false);
  const { engine } = newEngine();
  const loads: unknown[] = [];
  (engine as any).load = async (o: unknown) => { loads.push(o); return engine.status(); };
  const loadA = { do: 'load', model: 'tiny', mode: 'apart', devices: ['p1'] };
  const say: { planner: unknown[] } = { planner: [
    { id: 'planner:load', kind: 'suggest', title: 'load', why: 'w', action: loadA },
    { id: 'planner:open', kind: 'suggest', title: 'open', why: 'w', action: { do: 'open', panel: 'devices' } },
  ] };
  const eye = new GodsEye({ snapshot: () => ({ at: 1000, host: { name: 'mac', freeMb: 4000 }, devices: [], work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true }, models: [], projects: [] }) as any,
    dir: path.join(HOME, 'eye-a5'), makers: { planner: () => ({ id: 'planner', observe() {}, view: () => ({ ...dark(), built: true, stat: 'x', suggestions: say.planner as any }) }) } });
  eye.tick();
  const ui = await startUi({ port: 0, engine, eye, store: new ChatStore(path.join(HOME, 'chats-a5')), token: 'kula-' + 'cd'.repeat(20) } as any);
  const apply = (body: unknown) => post(`${ui.url}api/brain/apply`, ui.port, body);
  try {
    // a phone joined between drawing and tapping: the card now loads on two devices
    say.planner[0] = { id: 'planner:load', kind: 'suggest', title: 'load', why: 'w', action: { ...loadA, devices: ['p1', 'p2'] } };
    eye.tick();
    const stale = await apply({ id: 'planner:load', action: loadA });
    assert.equal(stale.status, 409);
    const sv = await stale.json();
    assert.deepEqual(sv.view.cards.find((c: any) => c.id === 'planner:load').action.devices, ['p1', 'p2'], 'the fresh view to draw again');
    assert.deepEqual(loads, [], 'the changed card was not run');
    const bare = await apply({ id: 'planner:load' });
    assert.equal(bare.status, 409, 'a load without the action seen is not run');
    assert.ok((await bare.json()).view);
    assert.deepEqual(loads, []);
    // what the person sees now, key order shuffled: applied
    const ok = await apply({ id: 'planner:load', action: { devices: ['p1', 'p2'], mode: 'apart', do: 'load', model: 'tiny' } });
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).word, /loading tiny/);
    assert.equal(loads.length, 1);
    assert.deepEqual((loads[0] as any).peers, ['p1', 'p2']);
    // finding C1: a card that leaves this computer out reaches the engine with here === false
    const outA = { do: 'load', model: 'tiny', mode: 'apart', devices: ['p1'], here: false };
    say.planner.push({ id: 'planner:out', kind: 'suggest', title: 'leave it out', why: 'w', action: outA });
    eye.tick();
    const keepsIt = await apply({ id: 'planner:out', action: { do: 'load', model: 'tiny', mode: 'apart', devices: ['p1'] } });
    assert.equal(keepsIt.status, 409, 'the action seen without here:false is not this card');
    assert.equal(loads.length, 1);
    const out = await apply({ id: 'planner:out', action: outA });
    assert.equal(out.status, 200);
    assert.equal(loads.length, 2);
    assert.equal((loads[1] as any).here, false, 'this computer stays out');
    assert.equal((loads[0] as any).here, undefined, 'a card without here leaves the default');
    // open only moves the page: no action needed
    const open = await apply({ id: 'planner:open' });
    assert.equal(open.status, 200);
    assert.equal((await open.json()).word, 'opened');
  } finally { await ui.close(); eye.stop(); await engine.close(); }
});
