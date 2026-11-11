// Photos on the chat page (10.11.2026, ui/vision.ts): the same routing as the phone. A vision
// model loaded here gets the photo straight (its image encoder fetched and sha-checked with it,
// llama-server told --mmproj); a text model here, or a model on a phone, gets the vision model's
// reading marked as its own, read on this computer in a short-lived second llama-server; no
// vision model, no llama.cpp: a clear message. The setting, the body caps, /v1, guests, and
// what a stored chat keeps. Fake llama-servers throughout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-photos-home-'));
process.env.KULA_NODE_HOME = HOME;

const { startUi, fromOpenAiPhotos } = await import('../src/ui/server.ts');
const { Engine, NO_VISION, VISION_NEEDS_SETUP } = await import('../src/ui/engine.ts');
const { ChatStore } = await import('../src/ui/store.ts');
const V = await import('../src/ui/vision.ts');
const { UI_CATALOG } = await import('../src/ui/catalog.ts');
const { serveModel } = await import('../src/modelserve.ts');
const { createIdentity, Paired } = await import('../src/tls.ts');
const { startApiServer } = await import('../src/api.ts');
const { startGateServer } = await import('../src/gate.ts');

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const PIN = '0123456789abcdef';
const JPEG = `data:image/jpeg;base64,${Buffer.from('a tiny jpeg stand-in').toString('base64')}`;
const PNG = `data:image/png;base64,${Buffer.from('another one').toString('base64')}`;

// ---------- fakes

// a llama-server for chat: streams pieces and keeps the last request body
function fakeLlama(pieces = ['fine']): Promise<{ port: number; bodies: any[]; close: () => void }> {
  return new Promise((resolve) => {
    const bodies: any[] = [];
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try { bodies.push(JSON.parse(body)); } catch {}
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const p of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: pieces.length } })}\n\ndata: [DONE]\n\n`);
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as any).port, bodies, close: () => s.close() }));
  });
}

// the short-lived vision llama-server: answers each photo with a description, counts starts and stops
function fakeVision(say = 'a red mug on a wooden desk; the mug says "KULA"') {
  const st = { starts: [] as { model: string; mmproj: string; ctx: number }[], stops: 0, bodies: [] as any[], servers: [] as http.Server[] };
  const start = (model: string, mmproj: string, ctx: number) => new Promise<{ port: number; stop(): Promise<void> }>((resolve) => {
    st.starts.push({ model: path.basename(model), mmproj: path.basename(mmproj), ctx });
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const b = JSON.parse(body);
        st.bodies.push(b);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `${say} (${st.bodies.length})` } }] }));
      });
    });
    st.servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as any).port, stop: async () => { st.stops++; s.close(); } }));
  });
  return { st, start };
}

async function served(name: string, n: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-photos-file-'));
  const file = path.join(dir, name);
  const bytes = randomBytes(n);
  fs.writeFileSync(file, bytes);
  const srv = await serveModel(file, '127.0.0.1', '127.0.0.1');
  return { url: srv.url, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), close: async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const base = { family: 'tiny', quant: 'Q8_0', repo: 'x/y', license: 'mit', ctx_max: 8192, kv_mb_per_1k: 8, blurb: '', good: '' };
const X_SHA = createHash('sha256').update('x').digest('hex');   // put() writes 'x'
const textModel = (size = 1, sha256 = X_SHA) => ({ ...base, id: 'text', name: 'Tiny Text', params_b: 0.1, file: 'tiny-text.gguf', size, sha256 });
const visionModel = (o: { id?: string; name?: string; file?: string; size?: number; sha256?: string; mm?: { file: string; size: number; sha256: string }; url?: string; mmprojUrl?: string } = {}) => ({
  ...base, id: o.id ?? 'eye', name: o.name ?? 'Tiny Vision', params_b: 0.2, file: o.file ?? 'tiny-vision.gguf', size: o.size ?? 20, sha256: o.sha256 ?? '1'.repeat(64),
  mmproj: o.mm ?? { file: `mmproj-${o.file ?? 'tiny-vision.gguf'}`, size: 5, sha256: '2'.repeat(64) }, ...(o.url ? { url: o.url } : {}), ...(o.mmprojUrl ? { mmprojUrl: o.mmprojUrl } : {}),
});

function newEngine(extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(HOME, 'e-'));
  const modelsDir = path.join(dir, 'models');
  fs.mkdirSync(modelsDir);
  const engine = new Engine({ peersFile: path.join(dir, 'peers.json'), modelDirs: [modelsDir], identity: createIdentity('mac'), llama: null, probeMs: 1500, settingsFile: path.join(dir, 'ui-settings.json'), freeMb: () => 64000, ...extra });
  const put = (file: string) => fs.writeFileSync(path.join(modelsDir, file), 'x');
  return { engine, modelsDir, dir, put };
}

const lastUser = (b: any) => b.messages.filter((m: any) => m.role === 'user').at(-1);

// ---------- pure parts

test('photos: only base64 jpeg/png/webp data urls within the cap, at most three; earlier photos become notes', () => {
  assert.equal(V.photoProblem(JPEG), null);
  assert.equal(V.photoProblem(PNG), null);
  assert.match(V.photoProblem('https://example.com/cat.jpg')!, /data: urls, not links/);
  assert.match(V.photoProblem('data:image/svg+xml;base64,PHN2Zz4=')!, /jpeg, png or webp/);
  assert.match(V.photoProblem('data:image/jpeg;base64,abc"><script>')!, /jpeg, png or webp/);
  assert.match(V.photoProblem(`data:image/jpeg;base64,${'A'.repeat(V.PHOTO_MAX_CHARS)}`)!, /too big/);
  assert.throws(() => V.checkPhotos([JPEG, JPEG, JPEG, JPEG]), /at most 3 photos/);
  assert.deepEqual(V.checkPhotos(undefined), []);
  assert.equal(V.photoSide(1), 768);
  assert.equal(V.photoSide(3), 512);

  const { messages, photos } = V.splitPhotos([
    { role: 'user', content: 'what is this', photos: 1, seen: { text: 'a cat', by: 'SmolVLM 500M', n: 1 } },
    { role: 'assistant', content: 'a cat' },
    { role: 'user', content: 'and this?', photos: [JPEG, PNG] },
  ]);
  assert.deepEqual(photos, [JPEG, PNG]);
  assert.equal(messages[2].content, 'and this?', 'the newest photos travel apart, the text stays as it is');
  assert.match(messages[0].content, /^what is this\n\n\[The person sent a photo\. SmolVLM 500M, a vision model on this computer, looked at it and wrote:\na cat\n\(end of the vision model's description\)\]$/);
  // an earlier photo without a reading: the model is told it cannot see it
  assert.match(V.splitPhotos([{ role: 'user', content: 'x', photos: [JPEG] }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }]).messages[0].content, /you cannot see it/);
  assert.match(V.describePrompt('what does the sign say?'), /copy any visible text exactly.*The person asks about it: "what does the sign say\?"/s);
  // /v1: image_url parts, as a string or { url }
  const oa = fromOpenAiPhotos([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: JPEG } }, { type: 'image_url', image_url: PNG }] }]);
  assert.deepEqual(oa, [{ role: 'user', content: 'look', photos: [JPEG, PNG] }]);
});

// ---------- routing

test('a vision model loaded here: its image encoder is fetched next to it and sha-checked, llama-server gets --mmproj, the photo goes straight to it', async () => {
  const model = await served('tiny-vision.gguf', 40_000);
  const mm = await served('mmproj-tiny-vision.gguf', 9_000);
  const llama = await fakeLlama(['a mug']);
  const starts: any[] = [];
  const { engine, modelsDir } = newEngine({
    catalog: [visionModel({ size: model.size, sha256: model.sha256, url: model.url, mm: { file: 'mmproj-tiny-vision.gguf', size: mm.size, sha256: mm.sha256 }, mmprojUrl: mm.url })],
    startBackend: async (file: string, ctx: number, o?: { mmproj?: string | null }) => { starts.push({ file: path.basename(file), mmproj: o?.mmproj ? path.basename(o.mmproj) : null }); return { port: llama.port, stop: async () => {} }; },
  });
  try {
    const st = await engine.load({ model: 'eye', mode: 'here' }, () => {});
    assert.ok(fs.existsSync(path.join(modelsDir, 'tiny-vision.gguf')));
    assert.ok(fs.existsSync(path.join(modelsDir, 'mmproj-tiny-vision.gguf')), 'the encoder sits next to the model');
    assert.deepEqual(starts, [{ file: 'tiny-vision.gguf', mmproj: 'mmproj-tiny-vision.gguf' }]);
    assert.equal(st.loaded?.sees, true);
    assert.ok(st.plan.some((l) => /sees photos/.test(l)));
    const r = await engine.chat([{ role: 'system', content: 'be brief' }, { role: 'user', content: 'what is it?' }], () => {}, { photos: [JPEG] });
    assert.deepEqual(r.photos, { how: 'direct', by: 'Tiny Vision', n: 1 });
    const sent = lastUser(llama.bodies.at(-1));
    assert.deepEqual(sent.content, [{ type: 'text', text: 'what is it?' }, { type: 'image_url', image_url: { url: JPEG } }]);
    assert.equal(llama.bodies.at(-1).messages[0].content, 'be brief');
    // the vision setting lists it as on this computer with its encoder
    assert.deepEqual(engine.visionView().list[0], { id: 'eye', name: 'Tiny Vision', size: model.size + mm.size, here: true, mmprojHere: true });
  } finally { await engine.close(); llama.close(); await model.close(); await mm.close(); }
});

test('an image encoder with a wrong sha256 is deleted; the model still loads, text only, and says so', async () => {
  const model = await served('tiny-vision.gguf', 30_000);
  const mm = await served('mmproj-tiny-vision.gguf', 8_000);
  const llama = await fakeLlama();
  const { engine, modelsDir } = newEngine({
    catalog: [visionModel({ size: model.size, sha256: model.sha256, url: model.url, mm: { file: 'mmproj-tiny-vision.gguf', size: mm.size, sha256: 'f'.repeat(64) }, mmprojUrl: mm.url })],
    startBackend: async () => ({ port: llama.port, stop: async () => {} }),
  });
  try {
    const st = await engine.load({ model: 'eye', mode: 'here' }, () => {});
    assert.equal(fs.existsSync(path.join(modelsDir, 'mmproj-tiny-vision.gguf')), false);
    assert.equal(st.loaded?.sees, false);
    assert.ok(st.plan.some((l) => /could not be fetched.*checksum mismatch.*text only/.test(l)), st.plan.join(' | '));
  } finally { await engine.close(); llama.close(); await model.close(); await mm.close(); }
});

test('a text model here and a vision model on this computer: the vision model reads first in its own llama-server, stopped after; its text goes to the chat model, marked', async () => {
  const llama = await fakeLlama(['it is a mug']);
  const vis = fakeVision();
  const { engine, put } = newEngine({ catalog: [textModel(), visionModel(), visionModel({ id: 'big', name: 'Big Vision', file: 'big-vision.gguf', size: 900 })], startBackend: async () => ({ port: llama.port, stop: async () => {} }), startVision: vis.start });
  for (const f of ['tiny-text.gguf', 'tiny-vision.gguf', 'mmproj-tiny-vision.gguf', 'big-vision.gguf', 'mmproj-big-vision.gguf']) put(f);
  try {
    const st = await engine.load({ model: 'text', mode: 'here' }, () => {});
    assert.equal(st.loaded?.sees, false);
    const reading: any[] = [];
    const r = await engine.chat([{ role: 'user', content: 'what does the mug say?' }], () => {}, { photos: [JPEG, PNG], onReading: (x) => reading.push(x) });
    assert.deepEqual(reading, [{ by: 'Tiny Vision', n: 2, tight: false }], 'the smallest vision model here, unless the setting says otherwise');
    assert.deepEqual(vis.st.starts, [{ model: 'tiny-vision.gguf', mmproj: 'mmproj-tiny-vision.gguf', ctx: V.DESCRIBE_CTX }]);
    assert.equal(vis.st.stops, 1, 'stopped right after');
    assert.equal(vis.st.bodies.length, 2, 'one photo at a time');
    const ask = vis.st.bodies[0].messages[0].content;
    assert.equal(ask[1].image_url.url, JPEG);
    assert.match(ask[0].text, /Describe this photo briefly.*"what does the mug say\?"/s);
    assert.equal(vis.st.bodies[1].messages[0].content[1].image_url.url, PNG);
    const sent = lastUser(llama.bodies.at(-1));
    assert.equal(typeof sent.content, 'string', 'the chat model gets text only');
    assert.match(sent.content, /^what does the mug say\?\n\n\[The person sent 2 photos\. Tiny Vision, a vision model on this computer, looked at them and wrote:\nphoto 1: a red mug.*\(1\)\nphoto 2: .*\(2\)\n\(end of the vision model's description\)\]$/s);
    assert.equal(r.photos?.how, 'describe');
    assert.equal(r.photos?.by, 'Tiny Vision');
    assert.match(r.photos!.text!, /^photo 1: a red mug/);
    assert.ok(engine.status().decisions.some((d) => /Tiny Vision reads 2 photos on this computer/.test(d.text)));

    // the setting picks the bigger one; it is the computer's, kept in ui-settings.json
    engine.setVision('big');
    await engine.chat([{ role: 'user', content: 'again' }], () => {}, { photos: [JPEG] });
    assert.equal(vis.st.starts.at(-1)?.model, 'big-vision.gguf');
    assert.equal(engine.visionView().setting, 'big');
    assert.throws(() => engine.setVision('text'), /does not see photos/);
    assert.equal(engine.setVision(null).chosen, 'eye', 'unset: the smallest here again');
  } finally { await engine.close(); llama.close(); }
});

test('memory too tight for both: the reading is tried anyway and says so; a vision model that cannot start says why', async () => {
  const llama = await fakeLlama();
  const vis = fakeVision();
  let fail = false;
  const { engine, put } = newEngine({
    catalog: [textModel(), visionModel()], freeMb: () => 100, startBackend: async () => ({ port: llama.port, stop: async () => {} }),
    startVision: async (m: string, mm: string, c: number) => { if (fail) throw new Error('llama-server exited while loading'); return vis.start(m, mm, c); },
  });
  for (const f of ['tiny-text.gguf', 'tiny-vision.gguf', 'mmproj-tiny-vision.gguf']) put(f);
  try {
    await engine.load({ model: 'text', mode: 'here' }, () => {});
    const r = await engine.chat([{ role: 'user', content: 'x' }], () => {}, { photos: [JPEG] });
    assert.equal(r.photos?.tight, true);
    assert.ok(engine.status().decisions.some((d) => /memory is tight: Tiny Vision needs about \d+ MB.*about 100 MB free next to Tiny Text; trying anyway/.test(d.text)));
    assert.ok(engine.loadedModel(), 'the model that was loaded stays loaded');
    fail = true;
    await assert.rejects(engine.chat([{ role: 'user', content: 'x' }], () => {}, { photos: [JPEG] }), /Tiny Vision could not start next to the model that is loaded: .*unload the model or pick a smaller vision model/);
  } finally { await engine.close(); llama.close(); }
});

test('no vision model here: a clear message pointing at the model list; no llama.cpp: kula-node setup; a missing encoder is fetched on the first photo', async () => {
  const llama = await fakeLlama();
  const a = newEngine({ catalog: [textModel(), visionModel()], startBackend: async () => ({ port: llama.port, stop: async () => {} }), startVision: fakeVision().start });
  a.put('tiny-text.gguf');
  // vision models in the catalog, none on this computer
  const mm = await served('mmproj-tiny-vision.gguf', 6_000);
  const vis = fakeVision();
  const b = newEngine({ catalog: [textModel(), visionModel({ mm: { file: 'mmproj-tiny-vision.gguf', size: mm.size, sha256: mm.sha256 }, mmprojUrl: mm.url })], startBackend: async () => ({ port: llama.port, stop: async () => {} }), startVision: vis.start });
  b.put('tiny-text.gguf'); b.put('tiny-vision.gguf');
  const c = newEngine({ catalog: [textModel(), visionModel()], startBackend: async () => ({ port: llama.port, stop: async () => {} }) });
  c.put('tiny-text.gguf'); c.put('tiny-vision.gguf'); c.put('mmproj-tiny-vision.gguf');
  try {
    await a.engine.load({ model: 'text', mode: 'here' }, () => {});
    await assert.rejects(a.engine.chat([{ role: 'user', content: 'x' }], () => {}, { photos: [JPEG] }), (e: Error) => e.message === NO_VISION);
    assert.match(NO_VISION, /sees photos/);
    // text without photos still works
    assert.equal((await a.engine.chat([{ role: 'user', content: 'x' }], () => {})).text, 'fine');
    // counted for god's eye: one photo, nothing here saw it
    assert.deepEqual({ ...a.engine.photos(), at: null }, { n: 1, unseen: 1, at: null });

    await b.engine.load({ model: 'text', mode: 'here' }, () => {});
    const r = await b.engine.chat([{ role: 'user', content: 'x' }], () => {}, { photos: [JPEG] });
    assert.equal(r.photos?.how, 'describe');
    assert.equal(b.engine.photos().unseen, 0, 'read by the vision model: not unseen');
    assert.ok(fs.existsSync(path.join(b.modelsDir, 'mmproj-tiny-vision.gguf')), 'the encoder was fetched and checked first');

    // llama: null and no fake vision server: setup is not done
    await c.engine.load({ model: 'text', mode: 'here' }, () => {});
    await assert.rejects(c.engine.chat([{ role: 'user', content: 'x' }], () => {}, { photos: [JPEG] }), (e: Error) => e.message === VISION_NEEDS_SETUP);
  } finally { await a.engine.close(); await b.engine.close(); await c.engine.close(); llama.close(); await mm.close(); }
});

test('a model on a phone: the photo is read on this computer, only text goes to the phone', async () => {
  const model = await served('tiny-text.gguf', 20_000);
  const vis = fakeVision('a street sign: "Main St"');
  // the phone: the real worker api behind a tls gate with a one-time code, a fake llama-server
  const llama = await fakeLlama(['Main St']);
  const pmodels = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-photos-phone-'));
  const api = await startApiServer({ models: pmodels, llama: null, allowPrivateUrls: true, startBackend: async () => ({ port: llama.port, stop: async () => {} }) });
  const identity = createIdentity('phone');
  const gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: null, targets: (ch) => (ch === 'api' ? api.port : null), tls: { identity, paired: new Paired(null), pin: PIN as string | null } });
  const { engine, put } = newEngine({ catalog: [{ ...textModel(model.size, model.sha256), url: model.url }, visionModel()], startVision: vis.start });
  put('tiny-vision.gguf'); put('mmproj-tiny-vision.gguf');
  try {
    await engine.pairByHand({ address: `127.0.0.1:${gate.port}`, pin: PIN, name: 'pixel' });
    await engine.load({ model: 'text', mode: 'phone', peers: [`127.0.0.1:${gate.port}`] }, () => {});
    const r = await engine.chat([{ role: 'user', content: 'which street?' }], () => {}, { photos: [JPEG] });
    assert.equal(r.device, 'pixel');
    assert.equal(r.photos?.how, 'describe');
    const sent = lastUser(llama.bodies.at(-1));
    assert.equal(typeof sent.content, 'string');
    assert.match(sent.content, /Tiny Vision, a vision model on this computer, looked at it and wrote:\na street sign: "Main St"/);
    assert.ok(!JSON.stringify(llama.bodies).includes('base64'), 'no photo reached the phone');
    assert.ok(engine.status().decisions.some((d) => /only its text goes to the phone/.test(d.text)));
  } finally { await engine.close(); await gate.close(); await api.close(); llama.close(); await model.close(); fs.rmSync(pmodels, { recursive: true, force: true }); }
});

// ---------- the page's server

const origin = (port: number, host = `127.0.0.1:${port}`) => ({ origin: `http://${host}`, 'sec-fetch-site': 'same-origin' });
const post = (url: string, port: number, body: unknown, headers: Record<string, string> = origin(port)) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
async function sse(res: Response): Promise<any[]> {
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => b.slice(6)).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
}

test('the page: photos through the chat route (reading, seen by), the setting, body caps, /v1 image parts, guests, and what a stored chat keeps', async () => {
  const llama = await fakeLlama(['ok']);
  const vis = fakeVision();
  const { engine, put, dir } = newEngine({ catalog: [textModel(), visionModel()], startBackend: async () => ({ port: llama.port, stop: async () => {} }), startVision: vis.start });
  for (const f of ['tiny-text.gguf', 'tiny-vision.gguf', 'mmproj-tiny-vision.gguf']) put(f);
  const store = new ChatStore(path.join(dir, 'chats'));
  const TOKEN = 'kula-' + 'ab'.repeat(20);
  const ui = await startUi({ port: 0, engine, store, token: TOKEN, eye: false, lanHost: '::1' });
  const api = (p: string) => `${ui.url}api/${p}`;
  try {
    await engine.load({ model: 'text', mode: 'here' }, () => {});
    // a chat with a photo: "reading" first, then the answer, then how the photo was seen
    const ev = await sse(await post(api('chat'), ui.port, { messages: [
      { role: 'user', content: 'first', photos: 1, seen: { text: 'a dog', by: 'Tiny Vision', n: 1 } },
      { role: 'assistant', content: 'a dog' },
      { role: 'user', content: 'and now?', photos: [JPEG] },
    ] }));
    assert.deepEqual(ev[0], { reading: 'Tiny Vision', n: 1, tight: false });
    const done = ev.at(-1);
    assert.equal(done.done, true);
    assert.equal(done.photos.how, 'describe');
    assert.match(done.photos.text, /a red mug/);
    const sent = llama.bodies.at(-1).messages;
    assert.match(sent[0].content, /^first\n\n\[The person sent a photo\. Tiny Vision.*\na dog\n/s, 'an earlier photo goes as its kept reading');
    assert.match(sent[2].content, /^and now\?\n\n\[The person sent a photo/);

    // caps: four photos, a link, one too big, a body over 4 MB
    const err = async (body: unknown) => (await (await post(api('chat'), ui.port, body)).json()).error;
    assert.match(await err({ messages: [{ role: 'user', content: 'x', photos: [JPEG, JPEG, JPEG, JPEG] }] }), /at most 3 photos/);
    assert.match(await err({ messages: [{ role: 'user', content: 'x', photos: ['http://10.0.0.1/a.jpg'] }] }), /not links/);
    assert.match(await err({ messages: [{ role: 'user', content: 'x', photos: [`data:image/jpeg;base64,${'A'.repeat(V.PHOTO_MAX_CHARS)}`] }] }), /too big/);
    const huge = await post(api('chat'), ui.port, { messages: [{ role: 'user', content: 'x'.repeat(4.2e6) }] });
    assert.equal(huge.status, 413);
    assert.match((await huge.json()).error, /at most 3 photos, shrunk/);
    // three shrunk photos (300 KB each, as a 768 px jpeg would be) fit
    const shrunk = `data:image/jpeg;base64,${Buffer.alloc(225_000, 7).toString('base64')}`;
    const ok3 = await sse(await post(api('chat'), ui.port, { messages: [{ role: 'user', content: 'x', photos: [shrunk, shrunk, shrunk] }] }));
    assert.equal(ok3.at(-1).photos.n, 3);

    // the setting: in GET settings, changed by POST settings/vision, kept on this computer
    const s0 = await (await fetch(api('settings'))).json();
    assert.equal(s0.vision.chosen, 'eye');
    assert.equal(s0.vision.llama, true);
    const s1 = await (await post(api('settings/vision'), ui.port, { id: 'eye' })).json();
    assert.equal(s1.setting, 'eye');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ui-settings.json'), 'utf8')), { visionModel: 'eye' });
    assert.equal((await post(api('settings/vision'), ui.port, { id: 'text' })).status, 400);

    // a stored chat keeps the photos and the reading; bad ones and too many are refused clearly
    const id = 'aa11bb22cc33dd44';
    const kept = await (await post(api(`chats/${id}`), ui.port, { messages: [
      { role: 'user', content: 'look', photos: [JPEG], seen: { text: 'a mug', by: 'Tiny Vision', n: 1 } },
      { role: 'assistant', content: 'a mug', meta: { photos: { how: 'describe', by: 'Tiny Vision', n: 1 }, reading: { by: 'x' } } },
    ] })).json();
    assert.deepEqual(kept.messages[0].photos, [JPEG]);
    assert.equal(kept.messages[0].seen.text, 'a mug');
    assert.deepEqual(kept.messages[1].meta, { photos: { how: 'describe', by: 'Tiny Vision', n: 1 } });
    assert.equal((fs.statSync(path.join(store.dir, `${id}.json`)).mode & 0o777), 0o600);
    const bad = await post(api(`chats/${id}`), ui.port, { messages: [{ role: 'user', content: 'x', photos: ['javascript:alert(1)'] }] });
    assert.equal(bad.status, 400);
    const many = Array.from({ length: 7 }, () => ({ role: 'user', content: 'x', photos: [`data:image/jpeg;base64,${'A'.repeat(900_000)}`] }));
    assert.match((await (await post(api(`chats/${id}`), ui.port, { messages: many })).json()).error, /too many photos.*start a new chat/);

    // /v1: OpenAI image_url parts take the same way; a link is refused
    const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const v1 = await (await fetch(`${ui.openaiBase}/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'what?' }, { type: 'image_url', image_url: { url: JPEG } }] }] }) })).json();
    assert.equal(v1.choices[0].message.content, 'ok');
    assert.deepEqual(v1.kula, { photos: { how: 'describe', by: 'Tiny Vision', n: 1 } });
    const link = await fetch(`${ui.openaiBase}/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://169.254.169.254/x.png' } }] }] }) });
    assert.equal(link.status, 400);
    assert.match((await link.json()).error.message, /not links/);

    // a guest: photos the same way; the setting stays the owner's
    const on = await (await post(api('invite'), ui.port, { on: true })).json();
    const j = await fetch(on.url, { redirect: 'manual' });
    await j.text();
    const cookie = j.headers.get('set-cookie')!.split(';')[0];
    const lan = `http://[::1]:${ui.port}/${ui.prefix}/api/`;
    const gh = { ...origin(ui.port, `[::1]:${ui.port}`), cookie };
    const g = await sse(await post(`${lan}chat`, ui.port, { messages: [{ role: 'user', content: 'guest photo', photos: [PNG] }] }, gh));
    assert.equal(g.at(-1).photos.how, 'describe');
    assert.equal((await post(`${lan}settings/vision`, ui.port, { id: 'eye' }, gh)).status, 403);
    assert.equal((await post(`${lan}vision/fetch`, ui.port, { id: 'eye' }, gh)).status, 403);
  } finally { await ui.close(); await engine.close(); llama.close(); }
});

test('the catalog: the three vision models carry their image encoder in the same repo', () => {
  const vision = UI_CATALOG.filter((m) => m.mmproj).map((m) => m.id);
  assert.deepEqual(vision, ['smolvlm-500m-q8', 'smolvlm2-2.2b-q4', 'gemma3-4b']);
  for (const m of UI_CATALOG.filter((x) => x.mmproj)) {
    assert.match(m.mmproj!.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.mmproj!.size > 1e6);
  }
  const e = new Engine({ peersFile: path.join(HOME, 'p.json'), modelDirs: [path.join(HOME, 'none')], llama: null, settingsFile: path.join(HOME, 's.json'), identity: createIdentity('m') });
  assert.deepEqual(e.visionView().list.map((m) => m.id), ['smolvlm-500m-q8', 'smolvlm2-2.2b-q4', 'gemma3-4b'], 'smallest first');
  assert.equal(e.visionView().chosen, null);
  assert.equal(e.models().find((m) => m.id === 'gemma3-4b')?.vision, true);
  assert.equal(e.models().find((m) => m.id === 'qwen3-0.6b-q8')?.vision, false);
});
