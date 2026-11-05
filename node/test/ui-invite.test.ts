// Invite mode of `kula-node ui`: other devices on the wi-fi scan a qr and chat. Off by
// default; on, a second listener (here on ::1, standing in for the lan address) wants the
// session cookie that /join hands out for the right token. Guests chat and keep their own
// chats; the owner's endpoints, chats and the /v1 token stay out of reach; a new invite drops
// every guest; /join and guest prompts are rate-limited.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-invite-home-'));
process.env.KULA_NODE_HOME = HOME;

const { startUi } = await import('../src/ui/server.ts');
const { Engine } = await import('../src/ui/engine.ts');
const { ChatStore } = await import('../src/ui/store.ts');
const { Invite, CHAT_PER_MIN, JOIN_WRONG } = await import('../src/ui/invite.ts');
const { createIdentity } = await import('../src/tls.ts');
const { writePeers } = await import('../src/peers.ts');

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const SECRET = 'deadbeefcafef00d0123456789abcdef';
const TOKEN = 'kula-' + '12'.repeat(20);

async function setup() {
  const dir = fs.mkdtempSync(path.join(HOME, 'u-'));
  const peersFile = path.join(dir, 'peers.json');
  writePeers([{ id: 'id-phone', name: 'phone', host: '10.0.0.9', port: 50551, secret: SECRET, kind: 'phone', ram: 6000, bw: 30, added_at: 't' }], peersFile);
  const engine = new Engine({ peersFile, modelDirs: [path.join(dir, 'models')], identity: createIdentity('mac'), llama: null, probeMs: 500 });
  const store = new ChatStore(path.join(dir, 'chats'));
  const ui = await startUi({ port: 0, engine, store, token: TOKEN, lanHost: '::1' });
  const lan = `http://[::1]:${ui.port}/${ui.prefix}/`;
  return { ui, engine, store, lan, close: async () => { await ui.close(); await engine.close(); } };
}

const reachable = (host: string, port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host, port });
  const t = setTimeout(() => { s.destroy(); resolve(false); }, 1000);
  s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
  s.once('error', () => { clearTimeout(t); resolve(false); });
});

function rawGet(port: number, p: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

async function join(url: string): Promise<{ status: number; cookie: string | null; location: string | null }> {
  const r = await fetch(url, { redirect: 'manual' });
  await r.text();
  const set = r.headers.get('set-cookie');
  return { status: r.status, cookie: set ? set.split(';')[0] : null, location: r.headers.get('location') };
}

test('invite mode off: no lan listener, a lan host is refused on the loopback one; on: the qr url, /join, the cookie', async () => {
  const s = await setup();
  try {
    assert.equal(s.ui.invite.info().on, false);
    assert.equal(await reachable('::1', s.ui.port), false, 'nothing on the lan address while invites are off');
    assert.equal(await rawGet(s.ui.port, `/${s.ui.prefix}/api/me`, `192.168.1.50:${s.ui.port}`), 400);
    assert.equal(await rawGet(s.ui.port, `/${s.ui.prefix}/api/me`, `[::2]:${s.ui.port}`), 400);
    // the owner page can switch it on (same-origin post), a guest-less page cannot read the url
    const on = await (await fetch(`${s.ui.url}api/invite`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${s.ui.port}` }, body: '{"on":true}' })).json();
    assert.equal(on.on, true);
    assert.match(on.url, new RegExp(`^http://\\[::1\\]:${s.ui.port}/${s.ui.prefix}/join\\?k=[0-9a-f]{64}$`));
    assert.ok(on.expiresAt > Date.now() + 7 * 3600_000);
    assert.equal((await fetch(`${s.ui.url}api/invite.svg`)).headers.get('content-type'), 'image/svg+xml');

    // no cookie: the page and the api say 401; the root too
    for (const p of ['', 'api/status', 'api/chats', 'app.js']) assert.equal((await fetch(s.lan + p, { redirect: 'manual' })).status, 401, p);
    assert.equal((await fetch(`http://[::1]:${s.ui.port}/`, { redirect: 'manual' })).status, 401);
    // a wrong token, a missing one: refused, no cookie
    const bad = await join(`${s.lan}join?k=${'0'.repeat(64)}`);
    assert.equal(bad.status, 401);
    assert.equal(bad.cookie, null);
    assert.equal((await join(`${s.lan}join`)).status, 401);
    // the right one: a cookie, HttpOnly + SameSite=Strict + the prefix path, and into the chat
    const r = await fetch(on.url, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `/${s.ui.prefix}/`);
    const set = r.headers.get('set-cookie')!;
    assert.match(set, /^kula_guest=[0-9a-f]{32}; HttpOnly; SameSite=Strict; Path=\/[0-9a-f]{24}\/; Max-Age=\d+$/);
    const cookie = set.split(';')[0];
    const page = await fetch(s.lan, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>kula chat<\/title>/);
    assert.deepEqual(await (await fetch(`${s.lan}api/me`, { headers: { cookie } })).json(), { role: 'guest' });
    assert.deepEqual(await (await fetch(`${s.ui.url}api/me`)).json(), { role: 'owner' });
    // a cookie made up by hand is no cookie
    assert.equal((await fetch(`${s.lan}api/me`, { headers: { cookie: `kula_guest=${'a'.repeat(32)}` } })).status, 401);
    assert.equal(s.ui.invite.info().guests, 1);
    // the lan listener answers to the lan host only
    const lanHostOnly = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '::1', port: s.ui.port, path: `/${s.ui.prefix}/api/me`, headers: { host: `127.0.0.1:${s.ui.port}`, cookie } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(lanHostOnly, 400);

    await s.ui.invite.set(false);
    assert.equal(await reachable('::1', s.ui.port), false, 'the lan listener is gone');
    assert.equal(s.ui.invite.info().guests, 0);
  } finally { await s.close(); }
});

test('a guest chats and keeps its own chats; owner endpoints, other chats and the /v1 token are out of reach', async () => {
  const s = await setup();
  try {
    const { url } = await s.ui.invite.set(true);
    const a = (await join(url!)).cookie!;
    const b = (await join(url!)).cookie!;
    const lanOrigin = `http://[::1]:${s.ui.port}`;
    const get = (p: string, cookie: string) => fetch(s.lan + p, { headers: { cookie } });
    const post = (p: string, cookie: string, body: unknown, origin = lanOrigin) => fetch(s.lan + p, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    // owner things: refused, and nothing secret in the refusals
    for (const p of ['api/peers', 'api/models', 'api/settings', 'api/invite', 'api/invite.svg']) {
      const r = await get(p, a);
      assert.equal(r.status, 403, p);
      const text = await r.text();
      assert.ok(!text.includes(SECRET) && !text.includes(TOKEN), p);
    }
    for (const p of ['api/load', 'api/unload', 'api/stop', 'api/peers/add', 'api/peers/remove', 'api/peers/probe', 'api/invite', 'api/invite/new']) assert.equal((await post(p, a, { on: false, text: 'x', id: 'id-phone' })).status, 403, p);
    assert.equal(s.ui.invite.info().on, true, 'a guest could not switch invites off');
    // /v1 is not on the lan listener, even with the right bearer token
    assert.equal((await fetch(`${lanOrigin}/v1/models`, { headers: { cookie: a, authorization: `Bearer ${TOKEN}` } })).status, 404);
    // status: the model and devices, not the decisions log
    const st = await (await get('api/status', a)).json();
    assert.deepEqual(st.decisions, []);
    assert.equal(st.loaded, null);

    // posts need the lan page's own origin
    assert.equal((await post('api/chats/aaaaaaaaaaaaaaaa', a, {}, 'http://evil.example')).status, 403);
    assert.equal((await post('api/chats/aaaaaaaaaaaaaaaa', a, {}, `http://127.0.0.1:${s.ui.port}`)).status, 403);

    // chats are per guest, and apart from the owner's
    s.store.put('cccccccccccccccc', { messages: [{ role: 'user', content: 'the owner asked this' }] });
    assert.equal((await post('api/chats/aaaaaaaaaaaaaaaa', a, { messages: [{ role: 'user', content: 'guest a here' }] })).status, 200);
    assert.deepEqual((await (await get('api/chats', a)).json()).map((c: any) => c.title), ['guest a here']);
    assert.deepEqual(await (await get('api/chats', b)).json(), []);
    assert.equal((await get('api/chats/aaaaaaaaaaaaaaaa', b)).status, 404);
    assert.equal((await get('api/chats/cccccccccccccccc', a)).status, 404);
    assert.equal((await post('api/chats/cccccccccccccccc/delete', a, {})).status, 404);
    assert.ok(s.store.get('cccccccccccccccc'), 'the owner\'s chat is still there');
    assert.deepEqual((await (await fetch(`${s.ui.url}api/chats`)).json()).map((c: any) => c.title), ['the owner asked this']);

    // a guest chat goes to the engine (nothing loaded here: it says so), then the rate limit
    const first = await post('api/chat', a, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(first.status, 200);
    assert.match(await first.text(), /no model loaded/);
    for (let i = 1; i < CHAT_PER_MIN; i++) await (await post('api/chat', a, { messages: [{ role: 'user', content: 'hi' }] })).text();
    const limited = await post('api/chat', a, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /slow down/);
    // the other guest has its own budget
    assert.equal((await post('api/chat', b, { messages: [{ role: 'user', content: 'hi' }] })).status, 200);
  } finally { await s.close(); }
});

test('a new invite drops every guest and the old qr; /join is rate-limited per address', async () => {
  const s = await setup();
  try {
    const first = await s.ui.invite.set(true);
    const cookie = (await join(first.url!)).cookie!;
    assert.equal((await fetch(`${s.lan}api/me`, { headers: { cookie } })).status, 200);
    const next = await s.ui.invite.rotate();
    assert.notEqual(next.url, first.url);
    assert.equal(next.guests, 0);
    assert.equal((await fetch(`${s.lan}api/me`, { headers: { cookie } })).status, 401, 'the old session is gone');
    assert.equal((await join(first.url!)).status, 401, 'the old qr is dead');
    assert.equal((await join(next.url!)).status, 302);
    // wrong tokens from one address: after a few, even the right one waits
    // (the dead qr above was the first wrong one)
    for (let i = 2; i < JOIN_WRONG; i++) assert.equal((await join(`${s.lan}join?k=${'f'.repeat(64)}`)).status, 401);
    assert.equal((await join(`${s.lan}join?k=${'f'.repeat(64)}`)).status, 401);
    assert.equal((await join(next.url!)).status, 429);
  } finally { await s.close(); }
});

test('invite: sessions run out with the invite; a guest answers one prompt at a time', () => {
  let now = 1_000_000;
  const inv = new Invite(60_000, () => now);
  assert.equal(inv.on, false);
  assert.ok('error' in inv.join('x', 'ip'));
  const k = inv.rotate();
  const r = inv.join(k, 'ip');
  assert.ok('guest' in r);
  const g = (r as { guest: { id: string; active: number } }).guest;
  assert.equal(inv.guestOf(`a=b; kula_guest=${g.id}`)?.id, g.id);
  g.active = 1;
  assert.equal(inv.chatAllowed(g as any), 'one answer at a time');
  g.active = 0;
  assert.equal(inv.chatAllowed(g as any), null);
  now += 61_000;
  assert.equal(inv.on, false, 'the invite ran out');
  assert.equal(inv.guestOf(`kula_guest=${g.id}`), null);
  assert.ok('error' in inv.join(k, 'ip2'));
});
