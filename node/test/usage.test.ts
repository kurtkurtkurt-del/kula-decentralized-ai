// Usage counts (src/ui/usage.ts) and the settings page's routes: every answer counted under its
// model, device, mode, kind of use and day, kept small in ~/.kula-node/usage.json (600) with no
// text of any question or answer; the data controls (export, delete all chats, clear the
// brain's notes, reset the counts) each want their word typed back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-usage-home-'));
process.env.KULA_NODE_HOME = HOME;

const { Usage, parseUsage, dayKey, estimateTokens, DAYS_KEPT, NAMES_KEPT } = await import('../src/ui/usage.ts');
const { startUi } = await import('../src/ui/server.ts');
const { Engine } = await import('../src/ui/engine.ts');
const { ChatStore } = await import('../src/ui/store.ts');
const { GodsEye, BRANCH_IDS } = await import('../src/godseye/index.ts');
const { MAKERS } = await import('../src/godseye/branches/index.ts');
const { createIdentity } = await import('../src/tls.ts');

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOON = new Date(2026, 10, 8, 12).getTime();

// ---------- the counts

test('usage: answers counted per model, device, mode, use and day; prompt tokens estimated unless reported', () => {
  const file = path.join(HOME, 'u1', 'usage.json');
  let now = NOON;
  const u = new Usage({ file, now: () => now });
  assert.equal(u.view().since, null, 'nothing counted yet');
  u.record({ model: 'Qwen 3 1.7B', device: 'pixel', mode: 'phone', use: 'chat', promptChars: 400, completion: 50, ms: 1100, firstMs: 100 });
  u.record({ model: 'Qwen 3 1.7B', device: 'this computer', mode: 'here', use: 'api', promptChars: 9999, promptTokens: 30, completion: 10, ms: 600, firstMs: 400, stopped: true });
  u.record({ model: 'Gemma', device: 'pixel', mode: 'phone', use: 'guest', promptChars: 40, completion: 0, ms: 0, firstMs: 0, failed: true });
  const v = u.view(30);
  assert.equal(v.since, NOON);
  assert.equal(v.total.answers, 2);
  assert.equal(v.total.failed, 1);
  assert.equal(v.total.stopped, 1);
  assert.equal(v.total.prompt, 100 + 30, '400 characters ≈ 100 tokens; the reported 30 as it is');
  assert.equal(v.total.completion, 60);
  assert.equal(v.total.tokens, 190);
  assert.equal(v.total.estimated, true);
  assert.equal(v.total.tps, Math.round((60 / (1000 + 200)) * 10000) / 10);
  assert.equal(v.total.firstMs, 250);
  assert.deepEqual(v.uses.map((r) => r.name), ['chat', 'api', 'project', 'guest'], 'always the four kinds, in order');
  assert.equal(v.uses[1].estimated, false, 'the api answer had its prompt reported');
  assert.equal(v.uses[3].failed, 1);
  assert.equal(v.models[0].name, 'Qwen 3 1.7B');
  assert.equal(v.models[0].tokens, 190);
  assert.deepEqual(v.devices.map((r) => r.name).sort(), ['pixel', 'this computer']);
  assert.deepEqual(v.modes.map((r) => r.name).sort(), ['here', 'phone']);
  assert.equal(v.days.length, 30);
  assert.equal(v.days.at(-1)!.day, dayKey(NOON));
  assert.equal(v.days[0].day, dayKey(NOON - 29 * DAY));
  assert.deepEqual(v.days.at(-1)!.uses, { chat: 150, api: 40, project: 0, guest: 0 });
  assert.equal(v.days.slice(0, -1).reduce((a, d) => a + d.tokens, 0), 0);
  // on disk: 600, and a second reader sees the same
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(new Usage({ file, now: () => now }).view(30), v);
  // the next day counts on its own
  now += DAY;
  u.record({ model: 'Gemma', device: 'pixel', mode: 'apart', use: 'project', promptChars: 8, completion: 3, ms: 300, firstMs: 100 });
  const w = u.view(30);
  assert.equal(w.days.at(-1)!.tokens, 2 + 3);
  assert.equal(w.days.at(-2)!.tokens, 190);
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(5), 2);
  u.reset();
  assert.equal(fs.existsSync(file), false);
  assert.equal(u.view().total.answers, 0);
});

test('usage: bounded (90 days, 100 models), odd names cleaned, a broken file counts as nothing', () => {
  const file = path.join(HOME, 'u2', 'usage.json');
  let now = NOON;
  const u = new Usage({ file, now: () => now });
  for (let i = 0; i < DAYS_KEPT + 30; i++) { now = NOON + i * DAY; u.record({ model: `m${i}`, device: 'd', mode: 'here', use: 'chat', promptChars: 4, completion: 1, ms: 10, firstMs: 5 }); }
  const o = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(o.days).length, DAYS_KEPT);
  assert.ok(!o.days[dayKey(NOON)], 'the oldest days went');
  assert.ok(Object.keys(o.models).length <= NAMES_KEPT);
  assert.ok(o.models[`m${DAYS_KEPT + 29}`], 'the model just used stays');
  assert.equal(o.total.answers, DAYS_KEPT + 30, 'the total keeps counting');
  u.record({ model: 'a\u0000b\n' + 'x'.repeat(500), device: '', mode: 'nonsense', use: 'evil' as any, promptChars: -5, completion: -3, ms: NaN, firstMs: -1 });
  const v = u.view();
  assert.ok(v.models.some((r) => r.name.startsWith('a b x') && r.name.length === 80));
  assert.ok(v.devices.some((r) => r.name === 'unknown device'));
  assert.ok(!v.modes.some((r) => r.name === 'nonsense'));
  // junk from disk
  for (const junk of ['nope', '{"v":2}', 'null', '[]']) assert.equal(parseUsage(junk, NOON).total.answers, 0);
  const p = parseUsage(JSON.stringify({ v: 1, since: 5, total: { answers: -5, prompt: 'x', completion: 7 }, days: { bad: { answers: 1 }, '2026-11-08': { answers: 2, uses: { chat: 9, evil: 4 } } }, modes: { evil: { answers: 1 }, here: { answers: 1 } }, uses: { api: { answers: 1 }, x: {} } }), NOON);
  assert.equal(p.total.answers, 0);
  assert.equal(p.total.completion, 7);
  assert.deepEqual(Object.keys(p.days), ['2026-11-08']);
  assert.deepEqual(p.days['2026-11-08'].uses, { chat: 9, api: 0, project: 0, guest: 0 });
  assert.deepEqual(Object.keys(p.modes), ['here']);
  assert.deepEqual(Object.keys(p.uses), ['api']);
});

test("god's eye forget: the branches' files go and the branches start again; nothing else in the folder is touched", () => {
  const dir = path.join(HOME, 'eye');
  fs.mkdirSync(dir, { recursive: true });
  let made = 0;
  const id = BRANCH_IDS[0];
  const eye = new GodsEye({ snapshot: () => { throw new Error('no look in this test'); }, dir, makers: { [id]: (ctx: any) => { made++; return MAKERS[id](ctx); } } });
  assert.equal(made, 1);
  fs.writeFileSync(path.join(dir, `${id}.json`), '{"learned":true}');
  fs.writeFileSync(path.join(dir, `${BRANCH_IDS[1]}.json`), '{}');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'mine');
  assert.equal(eye.forget(), 2);
  assert.equal(made, 2, 'made again from nothing');
  assert.deepEqual(fs.readdirSync(dir), ['keep.txt']);
  assert.deepEqual(eye.view().events, []);
});

// ---------- the routes, end to end on "here" with a fake llama-server

function fakeLlama(pieces: string[]): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const p of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 33, completion_tokens: pieces.length } })}\n\ndata: [DONE]\n\n`);
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as any).port, close: () => s.close() }));
  });
}

test('routes: usage counts the page and /v1 without their text; settings, export, delete all, reset and forget', async () => {
  const llama = await fakeLlama(['Hel', 'lo', '!']);
  const dir = fs.mkdtempSync(path.join(HOME, 'e-'));
  const models = path.join(dir, 'models');
  fs.mkdirSync(models);
  fs.writeFileSync(path.join(models, 'tiny-q8_0.gguf'), Buffer.alloc(4096, 1));
  const engine = new Engine({ peersFile: path.join(dir, 'peers.json'), modelDirs: [models], identity: createIdentity('mac'), llama: null, probeMs: 500, startBackend: async () => ({ port: llama.port, stop: async () => {} }) });
  const store = new ChatStore(path.join(HOME, 'chats-usage'));
  const token = 'kula-' + 'cd'.repeat(20);
  const ui = await startUi({ port: 0, engine, store, token, eye: false });
  const api = (p: string) => `${ui.url}api/${p}`;
  const hdr = { 'content-type': 'application/json', origin: `http://127.0.0.1:${ui.port}`, 'sec-fetch-site': 'same-origin' };
  const post = (p: string, body: unknown, headers: Record<string, string> = hdr) => fetch(api(p), { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const empty = await (await fetch(api('usage'))).json();
    assert.equal(empty.total.answers, 0);
    assert.equal(empty.days.length, 30);

    const load = await post('load', { model: 'local:tiny-q8_0.gguf', mode: 'here', ctx: 2048 });
    const text = await load.text();
    assert.match(text, /"done":true/, text);

    const SECRET = 'my very secret question about pancakes';
    const chat = await (await post('chat', { messages: [{ role: 'user', content: SECRET }] })).text();
    assert.match(chat, /"done":true/);
    const v1 = await fetch(`${ui.openaiBase}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: SECRET }] }) });
    assert.equal(v1.status, 200);
    await v1.json();

    const u = await (await fetch(api('usage'))).json();
    assert.equal(u.total.answers, 2);
    assert.equal(u.total.completion, 6, "llama-server's own count, three a reply");
    assert.equal(u.total.estimated, true, 'the prompt is estimated: the worker does not pass it on');
    assert.equal(u.uses.find((r: any) => r.name === 'chat').answers, 1);
    assert.equal(u.uses.find((r: any) => r.name === 'api').answers, 1);
    assert.deepEqual(u.modes.map((r: any) => r.name), ['here']);
    assert.equal(u.models[0].name, 'tiny-q8_0.gguf');
    assert.equal(u.devices.length, 1);
    assert.equal(u.days.at(-1).tokens, u.total.tokens);
    const file = path.join(HOME, 'usage.json');
    assert.equal(u.file, file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('pancakes'), 'no text of the question on disk');

    // settings: what the about and developer sections show
    const s = await (await fetch(api('settings'))).json();
    assert.equal(s.llamaTag, 'b11157');
    assert.match(s.version, /^\d+\.\d+\.\d+/);
    assert.equal(s.openai.token, token);
    assert.equal(s.paths.usage, file);
    assert.equal(s.paths.chats, store.dir);

    // export: every chat as one json file to download
    store.put('aaaaaaaa11111111', { messages: [{ role: 'user', content: 'one' }] });
    store.put('bbbbbbbb22222222', { messages: [{ role: 'user', content: 'two' }] });
    const ex = await fetch(api('data/export'));
    assert.equal(ex.status, 200);
    assert.match(ex.headers.get('content-disposition') ?? '', /^attachment; filename="kula-chats-\d{4}-\d{2}-\d{2}\.json"$/);
    const dump = await ex.json();
    assert.equal(dump.count, 2);
    assert.deepEqual(dump.chats.map((c: any) => c.messages[0].content).sort(), ['one', 'two']);

    // the wiping ones: the word typed back, same origin only
    assert.equal((await post('data/delete-chats', {})).status, 400);
    assert.equal((await post('data/delete-chats', { confirm: 'delete' }, { 'content-type': 'application/json' })).status, 403);
    assert.equal(store.list().length, 2);
    fs.mkdirSync(path.join(store.dir, 'guests', 'g1'), { recursive: true });
    fs.writeFileSync(path.join(store.dir, 'guests', 'g1', 'cccccccc33333333.json'), '{}');
    assert.deepEqual(await (await post('data/delete-chats', { confirm: 'delete' })).json(), { deleted: 2 });
    assert.equal(store.list().length, 0);
    assert.equal(fs.existsSync(path.join(store.dir, 'guests')), false);

    assert.equal((await post('usage/reset', { confirm: 'yes' })).status, 400);
    const r = await (await post('usage/reset', { confirm: 'reset' })).json();
    assert.equal(r.total.answers, 0);
    assert.equal(fs.existsSync(file), false);

    assert.equal((await post('data/forget-brain', {})).status, 400);
    assert.deepEqual(await (await post('data/forget-brain', { confirm: 'forget' })).json(), { forgot: 0 });
  } finally {
    await ui.close();
    await engine.close();
    llama.close();
  }
});
