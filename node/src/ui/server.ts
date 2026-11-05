// `kula-node ui`: a chat page on this computer for a model that runs on a phone (or on several
// devices, or here). Served like the dashboard (dashboard/server.ts): bound to 127.0.0.1 and
// nothing else, every page route under a random path prefix, a foreign Host header (dns
// rebinding) refused, a POST only from this very origin. Next to it, outside the prefix, an
// OpenAI-compatible endpoint (/v1/models, /v1/chat/completions) for editors and tools; it wants
// the bearer token printed at start. Peer secrets and pins never leave the process: peers go
// out as `peerRow`s. The /v1 token is the one value the page is given (its settings show it).
//
// Invite mode (off by default; `--lan` or the page's toggle): a second listener on this
// computer's lan address, same port, for guests who scanned the invite qr (invite.ts). Who is
// who is decided by the listener a request came in on: 127.0.0.1 is the owner, the lan address
// is a guest and needs the session cookie. Guests chat with whatever is loaded and see their
// own chats (a folder per session); peers, loading, settings, the /v1 token and everybody
// else's chats are the owner's. /v1 is never on the lan listener. The lan leg is plain http:
// anyone on that wi-fi who listens can read the chat text; the page says so next to the toggle.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { packageRoot, home } from '../paths.js';
import { readJson, BASE_HEADERS, Sse } from '../dashboard/server.js';
import type { Message } from '../apart.js';
import { Engine, hostLabel, type LoadEvent } from './engine.js';
import { ChatStore, ID_RE } from './store.js';
import { Invite, INVITE_TTL_MS, type Guest } from './invite.js';
import { qrSvg } from '../dashboard/qr.js';
import { lanIPv4 } from '../sysinfo.js';

export const UI_PORT = 50590;

export interface UiOptions {
  port: number;            // 0: any free port (tests)
  engine: Engine;
  store?: ChatStore;
  token?: string;          // the /v1 bearer token; default: ~/.kula-node/ui-token
  prefix?: string;         // the page's path prefix; default: a fresh random one (kula-node ui passes ~/.kula-node/ui-prefix)
  log?: (s: string) => void;
  staticDir?: string;
  lan?: boolean;               // start with invites on
  lanHost?: string | null;     // the address guests reach; default: this computer's lan ipv4
  inviteTtlMs?: number;        // an invite (and the sessions it made) lasts this long; 8 h
  onInvite?: (url: string | null) => void; // told every new invite url (null: invites off)
}

export interface InviteInfo { on: boolean; url: string | null; host: string | null; expiresAt: number | null; guests: number; error?: string }

export interface UiServer {
  port: number;
  prefix: string;
  url: string;
  token: string;
  openaiBase: string;
  invite: { set(on: boolean): Promise<InviteInfo>; rotate(): Promise<InviteInfo>; info(): InviteInfo };
  close(): Promise<void>;
}

type Via = 'loop' | 'lan';
type Who = { role: 'owner' } | { role: 'guest'; guest: Guest; store: ChatStore };

const hostPort = (h: string, port: number) => `${h.includes(':') ? `[${h}]` : h}:${port}`;

const GONE_PAGE = (why: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>kula chat</title></head><body><p>${why.replace(/[&<>"']/g, '')}</p><p>ask whoever runs kula on that computer for a new qr code.</p></body></html>`;

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
export const UI_STATIC = ['index.html', 'app.js', 'app.css', 'markdown.js'];
// tools/pack.mjs bakes these in: a packed executable has no static folder next to it
declare const __KULA_UI_STATIC__: Record<string, string> | undefined;

export function uiStaticDir(): string {
  return path.join(packageRoot(), 'src', 'ui', 'static');
}

// The page may use the camera (to read the phone's qr) and nothing from anywhere else.
const PAGE_HEADERS = {
  ...BASE_HEADERS,
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
};

function send(res: http.ServerResponse, code: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(code, { ...PAGE_HEADERS, 'content-type': type, 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}
const json = (res: http.ServerResponse, code: number, body: unknown) => send(res, code, JSON.stringify(body), 'application/json; charset=utf-8');

// The /v1 token: kept in ~/.kula-node/ui-token (600) so an editor's config survives a restart.
export function loadOrCreateToken(rotate = false): string {
  const file = path.join(home(), 'ui-token');
  if (!rotate) {
    try { const t = fs.readFileSync(file, 'utf8').trim(); if (/^kula-[0-9a-f]{40}$/.test(t)) return t; } catch {}
  }
  const t = `kula-${randomBytes(20).toString('hex')}`;
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return t;
}

// The page's path prefix: kept in ~/.kula-node/ui-prefix (600) so the address stays the same
// across restarts and can be bookmarked; --new-prefix makes a new one.
export const PREFIX_RE = /^[0-9a-f]{24}$/;
export function loadOrCreatePrefix(rotate = false): string {
  const file = path.join(home(), 'ui-prefix');
  if (!rotate) {
    try { const t = fs.readFileSync(file, 'utf8').trim(); if (PREFIX_RE.test(t)) return t; } catch {}
  }
  const t = randomBytes(12).toString('hex');
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return t;
}

const sameSecret = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// OpenAI messages to kula's: text parts joined; developer counts as system, tool as user.
export function fromOpenAi(list: unknown): Message[] {
  if (!Array.isArray(list)) return [];
  return list.map((m: any) => {
    const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'system' || m?.role === 'developer' ? 'system' : 'user';
    const c = m?.content;
    const content = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => (typeof p === 'string' ? p : p?.type === 'text' || typeof p?.text === 'string' ? String(p.text ?? '') : '')).join('') : '';
    return { role, content } as Message;
  });
}

const posNum = (v: unknown, d: number, max: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : d; };

export async function startUi(opts: UiOptions): Promise<UiServer> {
  const log = opts.log ?? (() => {});
  const engine = opts.engine;
  const store = opts.store ?? new ChatStore();
  const token = opts.token ?? loadOrCreateToken();
  if (opts.prefix !== undefined && !PREFIX_RE.test(opts.prefix)) throw new Error('the prefix must be 24 hex characters');
  const prefix = opts.prefix ?? randomBytes(12).toString('hex');
  const dir = opts.staticDir ?? uiStaticDir();
  const baked = !opts.staticDir && typeof __KULA_UI_STATIC__ === 'object' ? __KULA_UI_STATIC__ : null;
  const files = new Map<string, Buffer>();
  for (const f of UI_STATIC) files.set(f, baked ? Buffer.from(baked[f], 'utf8') : fs.readFileSync(path.join(dir, f)));
  const open = new Set<http.ServerResponse>();
  const guestOpen = new Map<string, Set<http.ServerResponse>>();
  let port = 0;
  const invite = new Invite(opts.inviteTtlMs ?? INVITE_TTL_MS);
  let lan: http.Server | null = null;
  let lanHost: string | null = null;
  invite.onDrop = (ids) => {
    for (const id of ids) { for (const r of guestOpen.get(id) ?? []) r.destroy(); guestOpen.delete(id); }
  };

  // the loopback listener answers to its own names only; the lan one to the lan address only
  const hostOk = (req: http.IncomingMessage, via: Via) => {
    const h = req.headers.host ?? '';
    if (via === 'lan') return !!lanHost && h === hostPort(lanHost, port);
    return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
  };
  const sameOrigin = (req: http.IncomingMessage) => {
    const o = req.headers.origin;
    if (typeof o !== 'string') return false;
    const sfs = req.headers['sec-fetch-site'];
    if (typeof sfs === 'string' && sfs !== 'same-origin') return false;
    return o === `http://${req.headers.host}`;
  };
  const openaiBase = () => `http://127.0.0.1:${port}/v1`;
  const inviteUrl = () => (invite.on && lanHost ? `http://${hostPort(lanHost, port)}/${prefix}/join?k=${invite.token}` : null);
  const inviteInfo = (error?: string): InviteInfo => ({ on: invite.on && !!lan, url: lan ? inviteUrl() : null, host: lan ? lanHost : null, expiresAt: invite.on ? invite.expiresAt : null, guests: invite.guests.size, ...(error ? { error } : {}) });

  // ---- the openai-compatible endpoint

  const oaError = (res: http.ServerResponse, code: number, message: string, type = 'invalid_request_error') => json(res, code, { error: { message, type, code: null } });

  async function openai(req: http.IncomingMessage, res: http.ServerResponse, p: string) {
    const auth = String(req.headers.authorization ?? '');
    const given = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!given || !sameSecret(given, token)) return oaError(res, 401, 'missing or wrong bearer token (kula-node ui prints it; the chat page shows it under settings)', 'authentication_error');
    // a browser page elsewhere has no business here even with the token
    const o = req.headers.origin;
    if (typeof o === 'string' && o !== `http://${req.headers.host}`) return oaError(res, 403, 'no cross-origin requests', 'permission_error');
    const loaded = engine.loadedModel();
    if (req.method === 'GET' && (p === '/v1/models' || p === '/v1/models/')) {
      const created = Math.floor((loaded?.since ?? Date.now()) / 1000);
      const data = [{ id: 'kula', object: 'model', created, owned_by: 'kula' }];
      if (loaded) data.push({ id: loaded.model.id, object: 'model', created, owned_by: 'kula' });
      return json(res, 200, { object: 'list', data });
    }
    if (req.method === 'POST' && p === '/v1/chat/completions') {
      let body: any;
      try { body = await readJson(req, 4 << 20); } catch (e) { return oaError(res, 400, (e as Error).message); }
      const messages = fromOpenAi(body?.messages);
      if (!messages.length) return oaError(res, 400, 'need messages');
      if (!loaded) return oaError(res, 503, 'no model loaded: open the kula chat page and load one', 'server_error');
      const maxTokens = posNum(body.max_completion_tokens ?? body.max_tokens, 1024, 32768);
      const temperature = Number.isFinite(Number(body.temperature)) ? Math.max(0, Math.min(2, Number(body.temperature))) : 0.7;
      const id = `chatcmpl-${randomBytes(12).toString('hex')}`;
      const created = Math.floor(Date.now() / 1000);
      const model = typeof body.model === 'string' && body.model ? body.model : loaded.model.id;
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      if (body.stream === true) {
        res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.flushHeaders();
        open.add(res);
        const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
        chunk({ role: 'assistant', content: '' }, null);
        try {
          const r = await engine.chat(messages, (t) => chunk({ content: t }, null), { maxTokens, temperature, signal: ac.signal });
          chunk({}, r.tokens >= maxTokens ? 'length' : 'stop');
          if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: 0, completion_tokens: r.tokens, total_tokens: r.tokens } })}\n\n`);
        } catch (e) {
          res.write(`data: ${JSON.stringify({ error: { message: (e as Error).message, type: 'server_error' } })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
        open.delete(res);
        return;
      }
      try {
        const r = await engine.chat(messages, () => {}, { maxTokens, temperature, signal: ac.signal });
        return json(res, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: r.tokens >= maxTokens ? 'length' : 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: r.tokens, total_tokens: r.tokens },
        });
      } catch (e) { return oaError(res, 500, (e as Error).message, 'server_error'); }
    }
    return oaError(res, 404, 'not found');
  }

  // ---- the page's api

  async function api(req: http.IncomingMessage, res: http.ServerResponse, route: string, query: URLSearchParams, who: Who) {
    const guest = who.role === 'guest' ? who : null;
    const chats = guest ? guest.store : store;
    const isChats = route === 'chats' || route.startsWith('chats/');
    if (route === 'me' && req.method === 'GET') return json(res, 200, { role: who.role });
    // a guest chats and keeps its own chats; everything else is the owner's
    if (guest && !(isChats || route === 'chat' || (route === 'status' && req.method === 'GET'))) return json(res, 403, { error: 'only the owner of this computer can do that' });
    if (req.method === 'GET') {
      if (route === 'status') {
        const st = engine.status();
        return json(res, 200, guest ? { loaded: st.loaded, loading: st.loading, chatting: st.chatting, plan: st.plan, decisions: [], llama: st.llama } : st);
      }
      if (route === 'invite') return json(res, 200, inviteInfo());
      if (route === 'invite.svg') { const u = inviteUrl(); return u && lan ? send(res, 200, qrSvg(u), TYPES['.svg']) : send(res, 404, 'no invite'); }
      if (route === 'peers') return json(res, 200, engine.peers());
      if (route === 'cable') return json(res, 200, await engine.cable());
      if (route === 'models') return json(res, 200, engine.models());
      if (route === 'settings') return json(res, 200, { openai: { base: openaiBase(), token }, host: hostLabel(), relay: process.env.KULA_RELAY ?? null });
      if (route === 'chats') return json(res, 200, chats.list(query.get('q') ?? undefined));
      const m = /^chats\/([0-9a-f]+)$/.exec(route);
      if (m && ID_RE.test(m[1])) { const c = chats.get(m[1]); return c ? json(res, 200, c) : json(res, 404, { error: 'no such chat' }); }
      return json(res, 404, { error: 'not found' });
    }
    if (req.method !== 'POST') return send(res, 405, 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'same origin only');
    let body: any;
    try { body = await readJson(req, 4 << 20); } catch (e) { return json(res, 400, { error: (e as Error).message }); }
    const fail = (e: unknown, code = 400) => json(res, code, { error: (e as Error).message });

    if (route === 'invite') return json(res, 200, await setInvite(body?.on === true));
    if (route === 'invite/new') return json(res, 200, await rotateInvite());
    if (route === 'peers/add') {
      try {
        if (typeof body?.address === 'string') return json(res, 200, await engine.pairByHand({ address: body.address, pin: body.pin, fp: body.fp, name: body.name }));
        if (typeof body?.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'paste the code from the phone' });
        return json(res, 200, await engine.addPeer(body.text, { name: typeof body.name === 'string' ? body.name : undefined, relay: typeof body.relay === 'string' ? body.relay : undefined }));
      } catch (e) { return fail(e); }
    }
    // phones on a usb cable: "use" starts and returns at once (GET cable shows the steps);
    // "pair" takes the code from the phone's share screen. The code never comes back.
    if (route === 'cable/use') { try { return json(res, 200, engine.useCable(body?.serial)); } catch (e) { return fail(e); } }
    if (route === 'cable/pair') { try { return json(res, 200, await engine.pairCable(body?.serial, body?.code)); } catch (e) { return fail(e); } }
    if (route === 'peers/remove') return engine.removePeer(String(body?.id ?? '')) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such device' });
    if (route === 'peers/probe') {
      try { return json(res, 200, await engine.probe(Array.isArray(body?.ids) ? body.ids.map(String) : undefined)); } catch (e) { return fail(e, 500); }
    }
    if (route === 'load') {
      const sse = new Sse(res);
      open.add(res);
      // closing the page mid-load does not stop it: a phone halfway through a download keeps
      // going, and the page sees the result in status when it comes back; "stop" stops it
      try {
        await engine.load(body ?? {}, (e: LoadEvent) => { if (!res.writableEnded) sse.send(e); });
      } catch (e) { if (!res.writableEnded) sse.send({ error: (e as Error).message }); }
      open.delete(res);
      if (!res.writableEnded) sse.end();
      return;
    }
    if (route === 'unload') { await engine.unload(); return json(res, 200, engine.status()); }
    if (route === 'stop') return json(res, 200, { stopped: engine.stop() });
    if (route === 'chat') {
      if (!Array.isArray(body?.messages) || !body.messages.length) return json(res, 400, { error: 'need messages' });
      const messages: Message[] = body.messages.map((m: any) => ({ role: m?.role === 'assistant' || m?.role === 'system' ? m.role : 'user', content: String(m?.content ?? '') }));
      if (guest) {
        const why = invite.chatAllowed(guest.guest);
        if (why) return json(res, 429, { error: why });
        const g = guest.guest;
        g.active++;
        const set = guestOpen.get(g.id) ?? new Set<http.ServerResponse>();
        set.add(res);
        guestOpen.set(g.id, set);
        res.on('close', () => { g.active = Math.max(0, g.active - 1); set.delete(res); });
      }
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      const sse = new Sse(res);
      open.add(res);
      try {
        const r = await engine.chat(messages, (t) => sse.send({ t }), { maxTokens: posNum(body.maxTokens, 1024, 32768), temperature: Number.isFinite(Number(body.temperature)) ? Math.max(0, Math.min(2, Number(body.temperature))) : 0.7, signal: ac.signal });
        sse.end({ done: true, tokens: r.tokens, ms: r.ms, firstMs: r.firstMs, tps: r.tps, device: r.device, stopped: r.stopped === true });
      } catch (e) { sse.end({ error: (e as Error).message }); }
      open.delete(res);
      return;
    }
    const m = /^chats\/([0-9a-f]+)(?:\/(rename|delete))?$/.exec(route);
    if (m && ID_RE.test(m[1])) {
      if (m[2] === 'delete') return chats.remove(m[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such chat' });
      if (m[2] === 'rename') { const c = chats.rename(m[1], String(body?.title ?? '')); return c ? json(res, 200, c) : json(res, 404, { error: 'no such chat' }); }
      try { return json(res, 200, chats.put(m[1], body)); } catch (e) { return fail(e); }
    }
    return json(res, 404, { error: 'not found' });
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, via: Via) => {
    if (!hostOk(req, via)) return send(res, 400, 'bad host');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const p = url.pathname;
    let who: Who = { role: 'owner' };
    if (via === 'lan') {
      // the lan leg: /join swaps the token for a cookie; everything else needs the cookie
      if (p === `/${prefix}/join` && req.method === 'GET') {
        const r = invite.join(url.searchParams.get('k') ?? '', req.socket.remoteAddress ?? '?');
        if ('error' in r) return send(res, r.code, GONE_PAGE(r.error), 'text/html; charset=utf-8');
        log(`a guest joined from ${req.socket.remoteAddress} (${invite.guests.size} now)`);
        return send(res, 302, '', 'text/plain', { location: `/${prefix}/`, 'set-cookie': invite.cookie(r.guest, prefix) });
      }
      const g = invite.guestOf(req.headers.cookie);
      if (!g) return send(res, 401, GONE_PAGE(invite.on ? 'this page needs an invite: scan the qr code again.' : 'invites are off on this computer.'), 'text/html; charset=utf-8');
      if (p === '/v1' || p.startsWith('/v1/') || !p.startsWith(`/${prefix}/`)) return send(res, 404, 'not found');
      who = { role: 'guest', guest: g, store: new ChatStore(path.join(store.dir, 'guests', g.id)) };
    }
    if (p === '/v1' || p.startsWith('/v1/')) return openai(req, res, p);
    if (p === '/' && req.method === 'GET') return send(res, 302, '', 'text/plain', { location: `/${prefix}/` });
    if (!p.startsWith(`/${prefix}/`)) return send(res, 404, 'not found');
    const route = p.slice(prefix.length + 2) || 'index.html';
    // "is kula's page here?": for a second kula-node ui and the mac launcher; nothing secret
    if (route === 'health' && req.method === 'GET') return json(res, 200, { kula: 'ui' });
    if (route.startsWith('api/')) return api(req, res, route.slice(4), url.searchParams, who);
    if ((req.method === 'GET' || req.method === 'HEAD') && files.has(route)) return send(res, 200, files.get(route)!, TYPES[path.extname(route)]);
    return send(res, 404, 'not found');
  };

  const serve = (via: Via) => {
    const s = http.createServer((req, res) => {
      handle(req, res, via).catch((e) => { log(`ui: ${(e as Error).message}`); if (!res.headersSent) send(res, 500, 'error'); else res.end(); });
    });
    s.keepAliveTimeout = 5000;
    return s;
  };
  const shut = (s: http.Server) => new Promise<void>((resolve) => { s.closeIdleConnections?.(); s.close(() => resolve()); s.closeAllConnections?.(); });

  // invites on: the lan listener up (same port), a fresh token; off: listener down, guests out
  async function setInvite(on: boolean): Promise<InviteInfo> {
    if (!on) {
      invite.off();
      if (lan) { const s = lan; lan = null; await shut(s); log('invites off'); opts.onInvite?.(null); }
      return inviteInfo();
    }
    if (lan && invite.on) return inviteInfo();
    const host = opts.lanHost !== undefined ? opts.lanHost : lanIPv4();
    if (!host) return inviteInfo('no wi-fi or lan address on this computer');
    if (!lan) {
      const s = serve('lan');
      try {
        await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(port, host, () => { s.off('error', reject); resolve(); }); });
      } catch (e) { return inviteInfo(`cannot listen on ${host}:${port}: ${(e as Error).message}`); }
      lan = s;
      lanHost = host;
    }
    invite.rotate();
    log(`invites on: devices on this network can join at ${hostPort(host, port)} with the qr code`);
    opts.onInvite?.(inviteUrl());
    return inviteInfo();
  }
  async function rotateInvite(): Promise<InviteInfo> {
    if (!lan) return setInvite(true);
    invite.rotate();
    log('a new invite: the old qr code and every guest are out');
    opts.onInvite?.(inviteUrl());
    return inviteInfo();
  }

  const server = serve('loop');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/${prefix}/`;
  if (opts.lan) await setInvite(true);
  return {
    port, prefix, url, token, openaiBase: openaiBase(),
    invite: { set: setInvite, rotate: rotateInvite, info: () => inviteInfo() },
    close: async () => {
      for (const s of open) s.destroy();
      open.clear();
      invite.off();
      if (lan) { const s = lan; lan = null; await shut(s); }
      await shut(server);
    },
  };
}
