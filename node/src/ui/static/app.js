// kula chat: the page. Vanilla, no build, nothing from the network but this computer. Model
// text reaches the DOM only through markdown.js (which escapes everything) or textContent;
// names that devices give themselves go through textContent too.
import { renderMarkdown, splitThink, stripThink } from './markdown.js';
import * as wiz from './wizard.js';

const $ = (id) => document.getElementById(id);
const base = location.pathname.replace(/[^/]*$/, '');
const apiUrl = (p) => `${base}api/${p}`;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svg = (paths) => { const ns = 'http://www.w3.org/2000/svg'; const s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('aria-hidden', 'true'); for (const d of paths) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.appendChild(p); } return s; };
const ICON = {
  copy: ['M7 7h8.5v9.5H7z', 'M13 7V4.5H4.5V13H7'],
  again: ['M15.5 10a5.5 5.5 0 1 1-1.7-4', 'M15.5 3.8v3.4h-3.4'],
  edit: ['M4.5 15.5h3l7.5-7.5-3-3-7.5 7.5z', 'M11 6l3 3'],
  more: ['M5 10h.01M10 10h.01M15 10h.01'],
  x: ['M6 6l8 8M14 6l-8 8'],
};

// ---------- small helpers

// a guest whose invite ended gets 401: the page reloads into the "ask for a new qr" note
const gone = (r) => { if (r.status === 401) { location.reload(); throw new Error('this invite has ended'); } };
async function getJson(p) {
  const r = await fetch(apiUrl(p), { cache: 'no-store' });
  gone(r);
  const o = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(o.error || `http ${r.status}`);
  return o;
}
async function postJson(p, body) {
  const r = await fetch(apiUrl(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  gone(r);
  const o = await r.json().catch(() => ({ error: `http ${r.status}` }));
  if (!r.ok) throw new Error(o.error || `http ${r.status}`);
  return o;
}
// POST, then read the server-sent events; every `data:` object goes to onEvent
async function postSse(p, body, onEvent, signal) {
  const r = await fetch(apiUrl(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  gone(r);
  if (!r.ok || !r.body) { const o = await r.json().catch(() => null); throw new Error(o?.error || `http ${r.status}`); }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let o;
        try { o = JSON.parse(line.slice(5).trim()); } catch { continue; }
        onEvent(o);
      }
    }
  }
}
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
const gb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = el('textarea'); t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch {}
    t.remove();
  }
  toast('copied');
}
let toastTimer = null;
function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = el('div', 'toast', text);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 1600);
}

// ---------- settings (this browser only)

const DEFAULTS = { temperature: 0.7, maxTokens: 1024, ctx: 4096, system: '', theme: 'system', mode: 'phone', model: null, peers: [], way: null };
function readSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('kula.chat.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}
const settings = readSettings();
function saveSettings() { try { localStorage.setItem('kula.chat.settings', JSON.stringify(settings)); } catch {} }
function applyTheme() {
  if (settings.theme === 'light' || settings.theme === 'dark') document.documentElement.dataset.theme = settings.theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme();

// ---------- state

const S = {
  chats: [],
  chat: null,          // { id, title, messages: [{ role, content, meta }] }
  saved: false,        // the current chat has a file
  streaming: null,     // { ac, index }
  status: null,
  peers: [],
  models: [],
  cable: null,         // phones adb sees on a usb cable: { adb, help, error, devices }
  info: null,          // settings from the server: openai base + token
  editing: -1,
  menuFor: null,
  renaming: null,
  stick: true,
  role: 'owner',       // 'guest' for a device that came in with an invite
};
const isGuest = () => S.role === 'guest';

// ---------- the chat list

async function loadChats() {
  const q = $('search').value.trim();
  try { S.chats = await getJson(`chats${q ? `?q=${encodeURIComponent(q)}` : ''}`); } catch { S.chats = []; }
  renderChatList();
}

function groupOf(ms) {
  const d = new Date(ms), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff < 1) return 'today';
  if (diff < 2) return 'yesterday';
  if (diff < 8) return 'previous 7 days';
  if (diff < 31) return 'previous 30 days';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' }).toLowerCase();
}

function renderChatList() {
  const list = $('chat-list');
  list.replaceChildren();
  if (!S.chats.length) { list.appendChild(el('p', 'side-empty', $('search').value.trim() ? 'nothing matches' : 'your chats will be here')); return; }
  let group = '';
  for (const c of S.chats) {
    const g = groupOf(c.updated);
    if (g !== group) { group = g; list.appendChild(el('div', 'chat-group', g)); }
    const item = el('div', `chat-item${S.chat?.id === c.id ? ' on' : ''}`);
    if (S.renaming === c.id) {
      const input = el('input');
      input.value = c.title;
      input.setAttribute('aria-label', 'new name');
      const done = async (save) => {
        if (S.renaming !== c.id) return;
        S.renaming = null;
        if (save && input.value.trim() !== c.title) {
          try { const r = await postJson(`chats/${c.id}/rename`, { title: input.value }); if (S.chat?.id === c.id) S.chat.title = r.title; } catch (e) { toast(e.message); }
        }
        loadChats();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
      item.appendChild(input);
      list.appendChild(item);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      continue;
    }
    const open = el('button', 'open', c.title);
    open.type = 'button';
    open.title = c.title;
    open.addEventListener('click', () => openChat(c.id));
    const more = el('button', 'more');
    more.type = 'button';
    more.setAttribute('aria-label', `more for ${c.title}`);
    more.appendChild(svg(ICON.more));
    more.addEventListener('click', (e) => { e.stopPropagation(); S.menuFor = S.menuFor === c.id ? null : c.id; renderChatList(); });
    item.append(open, more);
    if (S.menuFor === c.id) {
      const menu = el('div', 'menu');
      const ren = el('button', '', 'rename');
      ren.type = 'button';
      ren.addEventListener('click', (e) => { e.stopPropagation(); S.menuFor = null; S.renaming = c.id; renderChatList(); });
      const del = el('button', 'danger', 'delete');
      del.type = 'button';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        S.menuFor = null;
        if (!confirm(`delete "${c.title}"?`)) { renderChatList(); return; }
        await postJson(`chats/${c.id}/delete`).catch((err) => toast(err.message));
        if (S.chat?.id === c.id) newChat();
        loadChats();
      });
      menu.append(ren, del);
      item.appendChild(menu);
    }
    list.appendChild(item);
  }
}

document.addEventListener('click', () => { if (S.menuFor) { S.menuFor = null; renderChatList(); } });

async function openChat(id) {
  if (S.streaming) return toast('wait for the answer, or stop it');
  try {
    const c = await getJson(`chats/${id}`);
    S.chat = { id: c.id, title: c.title, messages: c.messages || [] };
    S.saved = true;
    S.editing = -1;
    history.replaceState(null, '', `#${c.id}`);
    renderThread(true);
    renderChatList();
    if (matchMedia('(max-width: 860px)').matches) setSide(false);
  } catch (e) { toast(e.message); }
}

function newChat() {
  if (S.streaming) return;
  S.chat = { id: randomId(), title: 'new chat', messages: [] };
  S.saved = false;
  S.editing = -1;
  history.replaceState(null, '', location.pathname);
  renderThread(true);
  renderChatList();
  $('input').focus();
}

async function saveChat() {
  const c = S.chat;
  if (!c || !c.messages.length) return;
  try {
    const r = await postJson(`chats/${c.id}`, { messages: c.messages, model: S.status?.loaded?.model?.name ?? null });
    c.title = r.title;
    if (!S.saved) { S.saved = true; history.replaceState(null, '', `#${c.id}`); }
    loadChats();
  } catch (e) { toast(`not saved: ${e.message}`); }
}

// ---------- the thread

const msgEls = [];

function renderThread(toBottom = false) {
  const box = $('messages');
  box.replaceChildren();
  msgEls.length = 0;
  const msgs = S.chat?.messages ?? [];
  msgs.forEach((m, i) => { const e = m.role === 'user' ? userEl(m, i) : botEl(m, i); msgEls[i] = e; box.appendChild(e); });
  $('empty').hidden = msgs.length > 0;
  updateEmpty();
  if (toBottom) scrollDown(true);
}

function lastIndex(role) {
  const msgs = S.chat?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === role) return i;
  return -1;
}

function toolButton(label, icon, onClick) {
  const b = el('button');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(svg(icon));
  b.addEventListener('click', onClick);
  return b;
}

function userEl(m, i) {
  const wrap = el('div', 'msg-user');
  if (S.editing === i) {
    const box = el('div', 'edit-box');
    const ta = el('textarea');
    ta.value = m.content;
    ta.setAttribute('aria-label', 'edit your message');
    const row = el('div', 'row');
    const cancel = el('button', 'ghost', 'cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { S.editing = -1; renderThread(); });
    const send = el('button', 'primary', 'send');
    send.type = 'button';
    send.addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) return;
      S.editing = -1;
      S.chat.messages = S.chat.messages.slice(0, i);
      ask(text);
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send.click(); } if (e.key === 'Escape') cancel.click(); });
    row.append(cancel, send);
    box.append(ta, row);
    wrap.appendChild(box);
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); grow(ta); }, 0);
    ta.addEventListener('input', () => grow(ta));
    return wrap;
  }
  wrap.appendChild(el('div', 'bubble', m.content));
  const tools = el('div', 'tools');
  tools.appendChild(toolButton('copy', ICON.copy, () => copyText(m.content)));
  if (i === lastIndex('user') && !S.streaming) tools.appendChild(toolButton('edit and send again', ICON.edit, () => { S.editing = i; renderThread(); }));
  wrap.appendChild(tools);
  return wrap;
}

function botEl(m, i) {
  const wrap = el('div', `msg-bot${i === (S.chat?.messages.length ?? 0) - 1 ? ' last' : ''}`);
  fillBot(wrap, m, i);
  return wrap;
}

function fillBot(wrap, m, i) {
  const live = S.streaming?.index === i;
  const { think, answer, thinking } = splitThink(m.content);
  // keep a thinking block's open/closed state across re-renders
  const oldThink = wrap.querySelector('details.think');
  const userToggled = oldThink?.dataset.user === '1';
  const wasOpen = oldThink?.open;
  wrap.replaceChildren();
  if (think !== null && (think || thinking)) {
    const d = el('details', `think${live && thinking ? ' live' : ''}`);
    d.open = userToggled ? wasOpen : live && thinking;
    if (userToggled) d.dataset.user = '1';
    const sum = el('summary', '', live && thinking ? 'thinking…' : 'thought it over');
    sum.addEventListener('click', () => { d.dataset.user = '1'; });
    const body = el('div', 'think-body', think);
    d.append(sum, body);
    wrap.appendChild(d);
    if (live && thinking) setTimeout(() => { body.scrollTop = body.scrollHeight; }, 0);
  }
  const ans = el('div', 'answer');
  if (answer) ans.innerHTML = renderMarkdown(answer); // renderMarkdown escapes every character of model text
  if (live && !m.content) { const w = el('span', 'waiting'); w.append(el('i'), el('i'), el('i')); ans.appendChild(w); }
  else if (live && answer) {
    let tail = ans.lastElementChild;
    while (tail && tail.lastElementChild && /^(UL|OL|LI|BLOCKQUOTE)$/.test(tail.tagName)) tail = tail.lastElementChild;
    (tail && /^(P|LI|H\d)$/.test(tail.tagName) ? tail : ans).appendChild(el('span', 'cursor'));
  }
  if (m.meta?.error) {
    const err = el('div', 'err', m.meta.error);
    if (/no model loaded|connect/i.test(m.meta.error)) {
      const b = el('button', 'link', 'connect');
      b.type = 'button';
      b.addEventListener('click', openConnect);
      err.appendChild(b);
    }
    ans.appendChild(err);
  }
  wrap.appendChild(ans);
  if (!live) {
    const meta = el('div', 'meta');
    const x = m.meta || {};
    const parts = [];
    if (x.tps) parts.push(`${x.tps} tok/s`);
    if (x.firstMs) parts.push(`first token ${x.firstMs} ms`);
    if (x.tokens) parts.push(`${x.tokens} tokens`);
    if (x.device) parts.push(x.device);
    if (x.stopped) parts.push('stopped');
    parts.forEach((p, k) => { if (k) meta.appendChild(el('span', 'sep', '·')); meta.appendChild(el('span', '', p)); });
    const tools = el('div', 'tools');
    if (m.content) tools.appendChild(toolButton('copy', ICON.copy, () => copyText(stripThink(m.content))));
    if (i === (S.chat?.messages.length ?? 0) - 1 && !S.streaming) tools.appendChild(toolButton('answer again', ICON.again, regenerate));
    meta.appendChild(tools);
    wrap.appendChild(meta);
  }
}

let frame = 0;
function paintLive() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const s = S.streaming;
    if (!s) return;
    const e = msgEls[s.index];
    if (e) fillBot(e, S.chat.messages[s.index], s.index);
    scrollDown();
  });
}

const thread = $('thread');
thread.addEventListener('scroll', () => { S.stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; });
function scrollDown(force = false) { if (force || S.stick) thread.scrollTop = thread.scrollHeight; }

// copy buttons inside rendered code blocks
$('messages').addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-copy]');
  if (!b) return;
  const code = b.closest('.code')?.querySelector('code');
  if (code) copyText(code.textContent);
});

// ---------- asking

function historyFor(upTo) {
  const msgs = [];
  if (settings.system.trim()) msgs.push({ role: 'system', content: settings.system.trim() });
  for (const m of S.chat.messages.slice(0, upTo)) {
    if (m.role === 'assistant') {
      const a = stripThink(m.content);
      if (!a.trim()) continue; // a failed or empty answer is not history
      msgs.push({ role: 'assistant', content: a });
    } else msgs.push({ role: m.role, content: m.content });
  }
  return msgs;
}

function ask(text) {
  if (S.streaming) return;
  if (!S.chat) newChat();
  S.chat.messages.push({ role: 'user', content: text });
  answer();
}

function regenerate() {
  if (S.streaming) return;
  const msgs = S.chat.messages;
  if (msgs.at(-1)?.role === 'assistant') msgs.pop();
  if (msgs.at(-1)?.role !== 'user') return;
  answer();
}

async function answer() {
  const msgs = S.chat.messages;
  const history = historyFor(msgs.length);
  const m = { role: 'assistant', content: '', meta: {} };
  msgs.push(m);
  const index = msgs.length - 1;
  const ac = new AbortController();
  S.streaming = { ac, index };
  S.stick = true;
  setBusy(true);
  renderThread(true);
  const t0 = performance.now();
  let first = 0, pieces = 0;
  try {
    await postSse('chat', { messages: history, maxTokens: settings.maxTokens, temperature: settings.temperature }, (ev) => {
      if (typeof ev.t === 'string') { if (!first) first = performance.now() - t0; pieces++; m.content += ev.t; paintLive(); }
      if (ev.done) m.meta = { tokens: ev.tokens, tps: ev.tps, firstMs: ev.firstMs, ms: ev.ms, device: ev.device, ...(ev.stopped ? { stopped: true } : {}) };
      if (ev.error) m.meta = { error: ev.error };
    }, ac.signal);
  } catch (e) {
    if (ac.signal.aborted) {
      const ms = performance.now() - t0;
      m.meta = { ...m.meta, stopped: true, tokens: m.meta.tokens ?? pieces, firstMs: m.meta.firstMs ?? Math.round(first), device: m.meta.device ?? S.status?.loaded?.devices?.[0]?.name, tps: m.meta.tps ?? (pieces ? Math.round((pieces / Math.max(1, ms - first)) * 10000) / 10 : 0) };
    } else m.meta = { error: e.message };
  } finally {
    S.streaming = null;
    setBusy(false);
    renderThread();
    scrollDown();
    saveChat();
  }
}

function setBusy(on) {
  $('stop').hidden = !on;
  $('send').hidden = on;
  updateSend();
}

// ---------- composer

const input = $('input');
function grow(t) { t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, window.innerHeight * 0.4)}px`; }
function updateSend() { $('send').disabled = !input.value.trim() || !!S.streaming; }
input.addEventListener('input', () => { grow(input); updateSend(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
});
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || S.streaming) return;
  input.value = '';
  grow(input);
  updateSend();
  ask(text);
});
$('stop').addEventListener('click', () => S.streaming?.ac.abort());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.streaming && !document.querySelector('dialog[open]')) S.streaming.ac.abort(); });

// ---------- top bar, empty state, brain

function whereText() {
  const st = S.status;
  const box = $('where-text');
  box.replaceChildren();
  const dot = $('where-dot');
  dot.className = 'dot';
  if (st?.loading) {
    dot.classList.add('busy');
    box.append('loading ', el('b', '', st.loading.model), ` · ${st.loading.line}`);
    return;
  }
  if (st?.loaded) {
    const l = st.loaded;
    dot.classList.add(l.devices.some((d) => d.busy) ? 'busy' : 'ok');
    const names = l.devices.map((d) => d.name).join(', ') || '—';
    box.append(el('b', '', l.model.name), ` on ${names} · ${l.mode === 'phone' ? 'phone' : l.mode}`);
    return;
  }
  box.append('no model yet · connect a phone');
}

function updateEmpty() {
  const sub = $('empty-sub');
  sub.replaceChildren();
  const l = S.status?.loaded;
  if (l) {
    const names = l.devices.map((d) => d.name).join(', ');
    sub.textContent = l.mode === 'phone' || (l.devices.length && l.devices.every((d) => !d.local))
      ? `${l.model.name} runs on ${names}.${isGuest() ? '' : ' this computer only carries the words.'}`
      : `${l.model.name} runs on ${names}.`;
  } else if (isGuest()) {
    sub.textContent = 'nothing is loaded yet: whoever runs kula on that computer picks a model.';
  } else {
    sub.append('nothing is loaded yet. ');
    const b = el('button', 'link', 'connect a phone');
    b.type = 'button';
    b.addEventListener('click', openConnect);
    sub.append(b, ' and pick a model.');
  }
}

function renderBrain() {
  const st = S.status;
  const devs = $('brain-devices');
  devs.replaceChildren();
  const used = new Set();
  for (const d of st?.loaded?.devices ?? []) {
    used.add(d.id);
    const card = el('div', 'dev');
    const top = el('div', 'dev-top');
    top.append(el('span', `dot ${d.busy ? 'busy' : 'ok'}`), el('b', '', d.name), el('span', 'tag', d.busy ? 'answering' : 'free'));
    card.appendChild(top);
    card.appendChild(el('p', '', `holds ${st.loaded.model.name}${d.tps ? ` · ${d.tps} tok/s` : ''} · ${d.done} answer${d.done === 1 ? '' : 's'}`));
    devs.appendChild(card);
  }
  for (const p of S.peers) {
    if (used.has(p.id)) continue;
    const card = el('div', 'dev');
    const top = el('div', 'dev-top');
    top.append(el('span', `dot ${p.reach ? (p.reach.ok ? 'ok' : 'no') : ''}`), el('b', '', p.name), el('span', 'tag', p.kind));
    card.appendChild(top);
    card.appendChild(el('p', '', p.reach ? (p.reach.ok ? `reachable${p.reach.ms ? `, ${p.reach.ms} ms` : ''}; holds nothing for this chat` : `not reachable: ${p.reach.reason}`) : 'not checked yet'));
    devs.appendChild(card);
  }
  if (!devs.children.length) devs.appendChild(el('p', 'none', 'no devices yet. connect adds one.'));
  const plan = $('brain-plan');
  plan.replaceChildren();
  for (const line of st?.plan ?? []) plan.appendChild(el('li', '', line));
  if (st?.loading) plan.appendChild(el('li', '', `loading: ${st.loading.line}`));
  if (!plan.children.length) plan.appendChild(el('li', 'none', 'nothing loaded, nothing planned.'));
  const log = $('brain-log');
  log.replaceChildren();
  for (const d of [...(st?.decisions ?? [])].reverse()) {
    const li = el('li');
    const t = el('time', '', clock(d.at));
    li.append(t, el('span', '', d.text));
    log.appendChild(li);
  }
  if (!log.children.length) log.appendChild(el('li', 'none', 'nothing yet.'));
}

async function refreshStatus() {
  try { S.status = await getJson('status'); } catch { return; }
  whereText();
  updateEmpty();
  if ($('app').classList.contains('brain-open')) renderBrain();
  if ($('connect').open) renderLoadState();
}

// ---------- side panels

function setSide(open) {
  $('app').classList.toggle('side-hidden', !open);
}
function setBrain(open) {
  $('app').classList.toggle('brain-open', open);
  $('brain-toggle').setAttribute('aria-pressed', String(open));
  try { localStorage.setItem('kula.chat.brain', open ? '1' : '0'); } catch {}
  if (open) { renderBrain(); refreshPeers(false); }
}
$('side-close').addEventListener('click', () => setSide(false));
$('side-open').addEventListener('click', () => setSide(true));
$('brain-toggle').addEventListener('click', () => setBrain(!$('app').classList.contains('brain-open')));
$('brain-close').addEventListener('click', () => setBrain(false));
$('scrim').addEventListener('click', () => { setSide(false); setBrain(false); });
$('new-chat').addEventListener('click', () => { newChat(); if (matchMedia('(max-width: 860px)').matches) setSide(false); });
let searchTimer = null;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadChats, 200); });
$('where').addEventListener('click', () => (isGuest() ? setBrain(!$('app').classList.contains('brain-open')) : openConnect()));
$('open-connect').addEventListener('click', openConnect);

// ---------- connect: devices

async function refreshPeers(probe) {
  if (isGuest()) return;
  try { S.peers = probe ? await postJson('peers/probe') : await getJson('peers'); } catch (e) { toast(e.message); }
  renderPeers();
  renderModels();
  if ($('app').classList.contains('brain-open')) renderBrain();
}

function selectedPeers() {
  const ids = S.peers.map((p) => p.id);
  const sel = settings.peers.filter((id) => ids.includes(id));
  if (settings.mode === 'phone') return sel.length ? [sel[0]] : ids.slice(0, 1);
  return sel.length ? sel : ids;
}

function renderPeers() {
  const box = $('peer-list');
  box.replaceChildren();
  if (!S.peers.length) { box.appendChild(el('p', 'none', 'no device yet. add your phone below.')); $('add').open = true; return; }
  const mode = settings.mode;
  const sel = new Set(selectedPeers());
  for (const p of S.peers) {
    const row = el('div', `peer${mode !== 'here' ? ' pick' : ''}${mode !== 'here' && sel.has(p.id) ? ' on' : ''}`);
    let pick;
    if (mode === 'phone') { pick = el('input'); pick.type = 'radio'; pick.name = 'peer'; }
    else if (mode === 'here') { pick = el('span', `dot ${p.reach ? (p.reach.ok ? 'ok' : 'no') : ''}`); }
    else { pick = el('input'); pick.type = 'checkbox'; }
    if (pick.tagName === 'INPUT') { pick.checked = sel.has(p.id); pick.setAttribute('aria-label', p.name); }
    const who = el('div', 'who');
    const name = el('b', '', p.name);
    const bits = [p.kind, p.where];
    if (p.ram) bits.push(`${(p.ram / 1024).toFixed(1)} GB free`);
    if (p.waitingPair) bits.push('pairs on first contact');
    if (p.cable?.plugged === false) bits.push('unplugged');
    else bits.push(p.reach ? (p.reach.ok ? `reachable${p.reach.ms ? ` (${p.reach.ms} ms)` : ''}` : `not reachable: ${p.reach.reason}`) : p.last_ok ? `last seen ${new Date(p.last_ok).toLocaleString()}` : 'not checked yet');
    who.append(name, el('span', '', bits.join(' · ')));
    const x = el('button', 'icon x');
    x.type = 'button';
    x.setAttribute('aria-label', `forget ${p.name}`);
    x.title = 'forget';
    x.appendChild(svg(ICON.x));
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`forget ${p.name}? you would pair it again to use it.`)) return;
      await postJson('peers/remove', { id: p.id }).catch((err) => toast(err.message));
      settings.peers = settings.peers.filter((id) => id !== p.id);
      saveSettings();
      refreshPeers(false);
    });
    row.append(pick, who, x);
    if (mode !== 'here') row.addEventListener('click', (e) => {
      if (e.target === x || x.contains(e.target)) return;
      if (mode === 'phone') settings.peers = [p.id];
      else { const cur = new Set(selectedPeers()); cur.has(p.id) ? cur.delete(p.id) : cur.add(p.id); settings.peers = [...cur]; }
      saveSettings();
      renderPeers();
      renderModels();
    });
    box.appendChild(row);
  }
}

$('probe').addEventListener('click', async () => { $('probe').textContent = 'checking…'; await refreshPeers(true); $('probe').textContent = 'check again'; });

// ---------- connect: phones on a usb cable
// adb on this computer sees them; "use" forwards a port to the phone's gate, opens its share
// screen when nothing answers, and asks for the code only when the phone does not know this
// computer yet. Looked at every 2 s while the sheet is open. Rows are kept by serial so a code
// half typed survives the refresh.

const STATE_WORDS = { device: 'ready', unauthorized: 'waiting for "allow usb debugging"', offline: 'offline', unplugged: 'unplugged' };
const cableRows = new Map();   // serial -> { row, name, line, use, code, input, steps }
const cableDone = new Set();   // serials whose "paired" the page already acted on
let cableBusy = false;
let cablePlugged = '';

async function refreshCable() {
  if (isGuest() || cableBusy) return;
  cableBusy = true;
  try { S.cable = await getJson('cable'); } catch (e) { S.cable = { adb: true, help: null, error: e.message, devices: [] }; } finally { cableBusy = false; }
  renderCable();
  wizCable();
  // a cable pulled or plugged in: the device rows below say so too
  const plugged = (S.cable.devices || []).map((d) => `${d.serial}:${d.state}`).join(',');
  if (plugged !== cablePlugged) { cablePlugged = plugged; if (S.peers.some((p) => p.cable)) refreshPeers(false); }
}

function cableRow(serial) {
  let r = cableRows.get(serial);
  if (r) return r;
  const row = el('div', 'peer cable');
  const dot = el('span', 'dot');
  const who = el('div', 'who');
  const name = el('b');
  const line = el('span');
  who.append(name, line);
  const use = el('button', 'pill', 'use');
  use.type = 'button';
  use.addEventListener('click', () => useCable(serial));
  const steps = el('ul', 'cable-steps');
  const code = el('div', 'cable-code');
  code.hidden = true;
  const input = el('input');
  input.placeholder = 'the code on the phone\'s share screen';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'the code on the phone\'s share screen');
  const pair = el('button', 'primary', 'pair');
  pair.type = 'button';
  pair.addEventListener('click', () => pairCable(serial));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') pairCable(serial); });
  code.append(input, pair);
  row.append(dot, who, use, steps, code);
  r = { row, dot, name, line, use, steps, code, input, pair };
  cableRows.set(serial, r);
  return r;
}

function renderCable() {
  const c = S.cable;
  const box = $('cable-list');
  const help = $('cable-help');
  if (!c) return;
  if (!c.adb) {
    box.replaceChildren(el('p', 'none', 'adb is not on this computer, so phones on a cable cannot be seen.'));
    cableRows.clear();
    help.textContent = c.help || '';
    $('cable-note').textContent = '';
    return;
  }
  const list = c.devices || [];
  $('cable-note').textContent = list.length ? '' : 'looking every 2 s';
  help.textContent = c.error ? `adb: ${c.error}` : list.length ? '' : 'plug the phone into this computer with a usb cable. on the phone, usb debugging must be on (settings → developer options).';
  for (const [serial] of cableRows) if (!list.some((d) => d.serial === serial)) cableRows.delete(serial);
  const rows = [];
  for (const d of list) {
    const r = cableRow(d.serial);
    const job = d.job;
    r.name.textContent = d.name;
    const bits = [];
    if (d.model && d.model !== d.name) bits.push(d.model);
    bits.push(STATE_WORDS[d.state] || d.state);
    if (d.peer) bits.push(`paired as ${d.peer.name}`);
    if (d.installed === false) bits.push('kula is not installed');
    r.line.textContent = bits.join(' · ');
    r.dot.className = `dot ${d.state === 'device' ? (job?.step === 'error' ? 'no' : job?.busy ? 'busy' : 'ok') : 'no'}`;
    r.use.disabled = d.state !== 'device' || !!job?.busy || d.installed === false;
    r.use.textContent = job?.busy ? 'working…' : 'use';
    // progress lines, then the error or what the state needs
    const lines = [...(job?.lines || [])].slice(-4);
    if (job?.error) lines.push(job.error);
    else if (d.help && !job) lines.push(d.help);
    r.steps.replaceChildren(...lines.map((t, i) => el('li', job?.error && i === lines.length - 1 ? 'bad' : job?.step === 'paired' && i === lines.length - 1 ? 'ok' : '', t)));
    r.code.hidden = !job?.needCode;
    r.pair.disabled = !!job?.busy;
    if (job?.needCode && !r.code.dataset.shown) { r.code.dataset.shown = '1'; setTimeout(() => r.input.focus(), 0); }
    if (!job?.needCode) delete r.code.dataset.shown;
    // a phone just paired (or found again): picked for loading, once
    if (job?.step === 'paired' && job.peerId && !cableDone.has(d.serial)) {
      cableDone.add(d.serial);
      pickPeer(job.peerId);
    }
    if (job && job.step !== 'paired') cableDone.delete(d.serial);
    rows.push(r.row);
  }
  box.replaceChildren(...rows);
  if (!rows.length) box.appendChild(el('p', 'none', 'no phone on a cable.'));
}

function pickPeer(id) {
  if (settings.mode === 'here') settings.mode = 'phone';
  if (settings.mode === 'phone' || !settings.peers.length) settings.peers = [id];
  else if (!settings.peers.includes(id)) settings.peers.push(id);
  saveSettings();
  renderModes();
  refreshPeers(false);
}

async function useCable(serial) {
  const r = cableRows.get(serial);
  if (r) { r.use.disabled = true; r.use.textContent = 'working…'; }
  cableDone.delete(serial);
  try { await postJson('cable/use', { serial }); } catch (e) { toast(e.message); }
  refreshCable();
}

async function pairCable(serial) {
  const r = cableRows.get(serial);
  if (!r) return;
  const code = r.input.value.trim();
  if (!code) { r.input.focus(); return; }
  r.pair.disabled = true;
  try {
    await postJson('cable/pair', { serial, code });
    r.input.value = '';
  } catch (e) { toast(e.message); }
  refreshCable();
}

// looked at while the advanced part shows, or while the wizard is on a cable step
setInterval(() => { if ($('connect').open && !document.hidden && (!$('advanced').hidden || WIZ_CABLE.has(W.step))) refreshCable(); }, 1500);

// ---------- connect: add a device

let scan = null; // the camera while it looks for a qr (BarcodeDetector needs a secure context: 127.0.0.1 is one)
function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const b of document.querySelectorAll('.tab-body')) b.hidden = b.dataset.body !== name;
  if (name !== 'scan') stopScan();
}
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
const canScan = 'BarcodeDetector' in window;
$('tab-scan').hidden = !canScan;
showTab(canScan ? 'scan' : 'type');

function addMsg(text, kind = '') { const m = $('add-msg'); m.textContent = text; m.className = `msg ${kind}`; }

async function added(row) {
  $('add').open = false;
  addMsg(`added ${row.name}${row.reach ? (row.reach.ok ? ', reachable' : `, but not reachable now: ${row.reach.reason}`) : ''}.`, row.reach && !row.reach.ok ? 'bad' : 'ok');
  if (settings.mode === 'phone' || !settings.peers.length) settings.peers = [row.id];
  else if (!settings.peers.includes(row.id)) settings.peers.push(row.id);
  saveSettings();
  await refreshPeers(false);
}

$('add-type').addEventListener('click', async () => {
  addMsg('pairing…');
  try {
    const row = await postJson('peers/add', { address: $('add-address').value.trim(), pin: $('add-pin').value.trim(), fp: $('add-fp').value.trim(), name: $('add-name').value.trim() });
    $('add-pin').value = '';
    await added(row);
  } catch (e) { addMsg(e.message, 'bad'); }
});
$('add-paste').addEventListener('click', async () => {
  const text = $('add-text').value.trim();
  if (!text) return addMsg('paste what the phone shows first', 'bad');
  addMsg('adding…');
  try {
    const row = await postJson('peers/add', { text, relay: $('add-relay').value.trim() || undefined });
    $('add-text').value = '';
    await added(row);
  } catch (e) { addMsg(e.message, 'bad'); }
});

async function addScanned(text) {
  addMsg('found the code, pairing…');
  try { await added(await postJson('peers/add', { text })); } catch (e) { addMsg(e.message, 'bad'); }
}
async function startScan() {
  stopScan();
  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const video = $('scan-video');
    video.srcObject = stream;
    video.classList.add('on');
    await video.play();
    scan = { stream, timer: 0 };
    addMsg('looking for the qr…');
    const tick = async () => {
      if (!scan) return;
      try {
        const found = await detector.detect(video);
        const hit = found.find((f) => /kula-peer/.test(f.rawValue || ''));
        if (hit) { stopScan(); return addScanned(hit.rawValue); }
      } catch {}
      if (scan) scan.timer = setTimeout(tick, 250);
    };
    tick();
  } catch (e) { addMsg(`no camera: ${e.message}`, 'bad'); }
}
function stopScan() {
  if (!scan) return;
  clearTimeout(scan.timer);
  for (const t of scan.stream.getTracks()) t.stop();
  $('scan-video').srcObject = null;
  $('scan-video').classList.remove('on');
  scan = null;
}
$('scan-start').addEventListener('click', startScan);
$('scan-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const found = await new BarcodeDetector({ formats: ['qr_code'] }).detect(bmp);
    const hit = found.find((x) => /kula-peer/.test(x.rawValue || ''));
    if (!hit) return addMsg('no kula code in that picture', 'bad');
    addScanned(hit.rawValue);
  } catch (err) { addMsg(err.message, 'bad'); }
});

// ---------- connect: mode and model

function renderModes() {
  const llama = !!S.status?.llama;
  for (const b of document.querySelectorAll('.mode')) {
    const m = b.dataset.mode;
    b.setAttribute('aria-checked', String(settings.mode === m));
    b.disabled = (m === 'split' || m === 'here') && !llama;
  }
  const notes = {
    phone: 'the phone downloads the model from huggingface itself (sha256-checked) the first time, then keeps it.',
    apart: 'every chosen device loads its own copy; a prompt goes to the fastest one that is free. this computer joins when it has the file.',
    split: 'the model sits on this computer and its layers are spread over the chosen phones (lan only).',
    here: 'llama-server on this computer; no phone needed.',
  };
  $('mode-note').textContent = notes[settings.mode] + (!llama ? ' split and here need llama.cpp on this computer: kula-node setup.' : '');
}
for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => {
  settings.mode = b.dataset.mode;
  saveSettings();
  renderModes();
  renderPeers();
  renderModels();
});

function fitFor(m, p) {
  if (!p.ram) return null;
  const need = m.needMb;
  if (need <= p.ram * 0.8) return ['yes', `fits on ${p.name}`];
  if (need <= p.ram) return ['tight', `tight on ${p.name}`];
  return ['no', `too big for ${p.name}`];
}

function renderModels() {
  const box = $('model-list');
  box.replaceChildren();
  const mode = settings.mode;
  const peers = S.peers.filter((p) => selectedPeers().includes(p.id));
  $('model-for').textContent = mode === 'phone' && peers[0] ? `for ${peers[0].name}` : mode === 'here' ? 'for this computer' : '';
  if (!S.models.length) { box.appendChild(el('p', 'none', 'loading the list…')); return; }
  const forPhones = mode === 'phone' || mode === 'apart';
  if (!settings.model || !S.models.some((m) => m.id === settings.model)) settings.model = S.models[0].id;
  for (const m of S.models) {
    const b = el('button', 'model');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(settings.model === m.id));
    const off = forPhones && !m.catalog;
    b.disabled = off;
    b.append(el('b', '', `${m.name}${m.quant ? ` · ${m.quant}` : ''}`), el('span', 'size', gb(m.size)), el('span', 'blurb', off ? 'a file on this computer: phones only fetch from the public internet, so use here or split for it' : m.blurb));
    const fit = el('span', 'fit');
    if (forPhones) for (const p of peers) { const f = fitFor(m, p); if (f) fit.appendChild(el('span', f[0], f[1])); }
    if (mode === 'here' || mode === 'split') fit.appendChild(el('span', m.here ? 'yes' : 'info', m.here ? 'on this computer' : `downloads here first (${gb(m.size)})`));
    else if (m.here && mode === 'apart') fit.appendChild(el('span', 'info', 'this computer has it too'));
    if (fit.children.length) b.appendChild(fit);
    b.addEventListener('click', () => { settings.model = m.id; saveSettings(); renderModels(); });
    box.appendChild(b);
  }
}

// ---------- connect: load

let loadRun = null;
function renderLoadState() {
  const st = S.status;
  const loading = !!st?.loading || !!loadRun;
  $('load').disabled = loading;
  $('load').textContent = st?.loaded ? 'load instead' : 'load';
  $('load-stop').hidden = !loading;
  $('unload').hidden = !st?.loaded || loading;
  if (!loadRun) {
    if (st?.loading) { setProgress(null); loadMsg(`${st.loading.model}: ${st.loading.line}`); }
    else if (st?.loaded && !$('load-msg').classList.contains('bad')) { $('load-progress').hidden = true; loadMsg(`${st.loaded.model.name} is ready on ${st.loaded.devices.map((d) => d.name).join(', ')}.`, 'ok'); }
  }
}
function loadMsg(text, kind = '') { const m = $('load-msg'); m.textContent = text; m.className = `msg ${kind}`; }
function setProgress(frac) {
  const p = $('load-progress');
  p.hidden = false;
  p.classList.toggle('indeterminate', frac == null);
  $('load-bar').style.width = frac == null ? '' : `${Math.round(frac * 100)}%`;
}

// One load through the page's api; `show` draws it (the old block below, or the wizard's
// load step). Resolves true when the model is ready.
async function runLoad(body, show) {
  if (loadRun) return false;
  loadRun = true;
  show.progress(null);
  show.msg('starting…');
  renderLoadState();
  let ok = false;
  try {
    await postSse('load', body, (ev) => {
      if (ev.error) throw new Error(ev.error);
      if (ev.done) { ok = true; S.status = ev.status; return; }
      if (ev.line) {
        const frac = ev.total ? ev.got / ev.total : null;
        show.progress(ev.phase === 'running' || ev.phase === 'checking' ? frac : null);
        const amount = ev.total && ev.phase === 'running' ? ` ${Math.floor((ev.got / ev.total) * 100)}% of ${gb(ev.total)}` : '';
        show.msg(`${ev.device ? `${ev.device}: ` : ''}${ev.line}${amount}`);
      }
    });
    if (!ok) throw new Error('the load ended without an answer');
    show.progress(1);
    show.msg(`${S.status.loaded.model.name} is ready on ${S.status.loaded.devices.map((d) => d.name).join(', ')}.`, 'ok');
    return true;
  } catch (e) {
    show.progress(false);
    show.msg(e.message, 'bad');
    return false;
  } finally {
    loadRun = null;
    await refreshStatus();
    renderLoadState();
    refreshPeers(false);
  }
}

$('load').addEventListener('click', async () => {
  if (loadRun) return;
  const body = { model: settings.model, mode: settings.mode, peers: settings.mode === 'here' ? [] : selectedPeers(), ctx: settings.ctx };
  if (settings.mode === 'phone' && !body.peers.length) return loadMsg('add a phone first', 'bad');
  const ok = await runLoad(body, { progress: (f) => (f === false ? ($('load-progress').hidden = true) : setProgress(f)), msg: loadMsg });
  if (ok) setTimeout(() => { if ($('connect').open && !loadRun) $('connect').close(); }, 900);
});
$('load-stop').addEventListener('click', () => postJson('stop').catch(() => {}));
$('unload').addEventListener('click', async () => { await postJson('unload').catch((e) => toast(e.message)); loadMsg(''); refreshStatus(); });

// ---------- connect: one question at a time (wizard.js decides, this draws)
// how is the phone connected → the steps of that way → which model → how it runs → loading.
// The old one-page sheet stays under "advanced".

const WIZ_CABLE = new Set(['cable-plug', 'cable-share', 'cable-code']);
const PLATFORM_TOOLS = 'https://developer.android.com/tools/releases/platform-tools';
let W = wiz.initial(settings.way);
let wizSig = '';
let wizStepShown = '';
let wizRun = 0;                         // bumps on every open: answers for an older walk are dropped
const draft = { code: '', address: '', fp: '' };
let found = { list: null, looking: false, error: null };   // GET discover
let wizPairing = false;
let wizModelsProbed = 0;

function go(ev) {
  const before = W.step;
  W = wiz.next(W, ev);
  if (ev.type === 'way') { settings.way = ev.way; saveSettings(); }
  renderWiz();
  if (W.step !== before) enterStep();
}

// what a step does when it starts
function enterStep() {
  const run = wizRun;
  if (WIZ_CABLE.has(W.step)) refreshCable();
  if (W.step === 'wifi-list' && !found.looking) lookAround();
  if (W.step === 'wifi-check') checkFound(run);
  if (W.step === 'model') {
    if (!S.models.length) getJson('models').then((m) => { S.models = m; renderWiz(true); }).catch(() => {});
    if (Date.now() - wizModelsProbed > 20000) {
      wizModelsProbed = Date.now();
      postJson('peers/probe').then((list) => { if (run !== wizRun) return; S.peers = list; renderPeers(); renderWiz(true); }).catch(() => {});
    }
  }
  if (W.step === 'load') wizLoad(run);
  if (W.step === 'done') setTimeout(() => { if ($('connect').open) $('connect').close(); input.focus(); }, 700);
}

const phoneNow = () => wiz.choosePhone(S.peers, [W.peerId, ...settings.peers].filter(Boolean));

// ---- drawing

function q(text) { const h = el('h3', 'wiz-q', text); h.tabIndex = -1; h.id = 'wiz-q'; return h; }
function para(text, cls = 'wiz-p') { return el('p', cls, text); }
function btn(text, cls, onClick) { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick); return b; }
function choice(title, sub, onClick, tag) {
  const b = el('button', 'choice');
  b.type = 'button';
  b.append(el('b', '', title), el('span', '', sub));
  if (tag) b.appendChild(el('em', 'tag', tag));
  b.addEventListener('click', onClick);
  return b;
}
function steps(list, ordered = true) { const o = el(ordered ? 'ol' : 'ul', 'wiz-steps'); for (const t of list) o.appendChild(typeof t === 'string' ? el('li', '', t) : t); return o; }
function waiting(text) { const r = el('p', 'wiz-wait'); r.append(el('span', 'dot busy'), el('span', '', text)); return r; }
function errLine(text) { const e = el('p', 'msg bad', text); e.setAttribute('role', 'alert'); return e; }
// a code the phone refused is spent: it shows a new one after stop and start
function codeError(text) {
  const out = [errLine(text)];
  if (/wrong pin|bad (pin )?proof|not paired|no pin/i.test(text)) out.push(para('a code works once: on the phone stop share this phone and start it again, then type the new code.', 'hint'));
  return out;
}
function row(...kids) { const r = el('div', 'row'); r.append(...kids); return r; }
function field(label, key, attrs = {}) {
  const l = el('label', `field big${attrs.cls ? ` ${attrs.cls}` : ''}`);
  l.appendChild(el('span', '', label));
  const i = el('input');
  i.id = `wiz-${key}`;
  i.value = draft[key];
  i.spellcheck = false;
  i.autocomplete = 'off';
  i.setAttribute('autocapitalize', 'off');
  i.setAttribute('autocorrect', 'off');
  for (const [k, v] of Object.entries(attrs)) if (k !== 'cls') i.setAttribute(k, v);
  i.addEventListener('input', () => { draft[key] = i.value; });
  l.appendChild(i);
  return [l, i];
}
function outLink(text, href) { const a = el('a', '', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }

const VIEWS = {
  checking: () => [q('looking for your devices…'), waiting('asking the phones you paired before')],

  how: () => {
    const last = settings.way;
    const box = el('div', 'choices');
    box.append(
      choice('usb cable', 'the phone plugged into this computer', () => go({ type: 'way', way: 'cable' }), last === 'cable' ? 'last time' : null),
      choice('same wi-fi', 'or the phone\'s hotspot', () => go({ type: 'way', way: 'wifi' }), last === 'wifi' ? 'last time' : null),
    );
    return [q('how is the phone connected?'), box];
  },

  'cable-plug': () => {
    const c = wiz.cableState(S.cable, W.serial, W.used);
    if (c.problem === 'no-adb') {
      const get = el('li');
      get.append('get android\'s platform-tools from google\'s page: ', outLink('developer.android.com/tools/releases/platform-tools', PLATFORM_TOOLS));
      return [q('this computer needs adb first'), para('adb is google\'s small tool that talks to android phones over a cable.'),
        steps([get, 'unzip it and put the folder on your PATH, then start kula-node ui again (android studio\'s copy is found by itself).',
          'on the phone, turn on usb debugging: settings → about phone → tap "build number" seven times, then settings → developer options → usb debugging.']),
        waiting('looking for adb every few seconds')];
    }
    if (c.problem === 'unauthorized') return [q('tap allow on the phone'), para(`unlock ${c.name || 'the phone'}: it asks whether to allow usb debugging from this computer. tap allow.`), para('no prompt? unplug the cable and plug it in again.', 'hint'), waiting('waiting for allow')];
    if (c.problem === 'not-installed') return [q('kula is not on this phone'), para('install the kula app on it first and open it once.'), waiting('looking again every few seconds')];
    if (c.problem === 'offline' || c.problem === 'adb-error') return [q('the phone is not answering'), para(c.help || (c.error ? `adb: ${c.error}` : 'unplug it and plug it in again.')), waiting('looking again')];
    const how = el('details', 'wiz-more');
    how.append(el('summary', '', 'usb debugging is off?'), steps(['settings → about phone → tap "build number" seven times.', 'settings → developer options → turn on usb debugging.', 'plug in again and tap allow.']));
    return [q('plug the phone in'), para('with a usb cable, into this computer.'), how, waiting('looking for it')];
  },

  'cable-share': () => {
    const c = wiz.cableState(S.cable, W.serial, W.used);
    const out = [q('starting sharing on the phone…')];
    if (c.name) out.push(para(c.name, 'wiz-name'));
    if (c.lines?.length) out.push(steps(c.lines.slice(-5), false));
    if (c.error) out.push(errLine(c.error), row(btn('try again', 'primary big', () => useCableNow(c.serial))));
    else out.push(waiting('kula opens share this phone on it by itself'));
    return out;
  },

  'cable-code': () => {
    const c = wiz.cableState(S.cable, W.serial, W.used);
    const where = para('on the phone, under the qr, after "code".', 'hint');
    where.id = 'wiz-code-where';
    const [f, i] = field('the code', 'code', { placeholder: '16 letters and digits', maxlength: '40', inputmode: 'text', cls: 'code', 'aria-describedby': 'wiz-code-where' });
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') pairCableNow(c.serial); });
    const out = [q('type the code you see on the phone'), where, f];
    if (c.error) out.push(...codeError(c.error));
    const b = btn(c.busy || wizPairing ? 'pairing…' : 'pair', 'primary big', () => pairCableNow(c.serial));
    b.disabled = !!(c.busy || wizPairing);
    out.push(row(b));
    return out;
  },

  connected: () => {
    const name = S.peers.find((x) => x.id === W.peerId)?.name ?? 'your phone';
    return [q(`connected ✓ ${name}`),
      para(W.way === 'cable' ? 'over the usb cable. keep it plugged in while you chat.' : 'over this network. the phone keeps this computer for next time.'),
      row(btn('next: pick a model', 'primary big', () => go({ type: 'continue' })))];
  },

  'wifi-share': () => [
    q('on the phone: open share this phone and press start'),
    steps(['open kula on the phone.', 'tap share this phone.', 'press start: it shows a qr, an address and a code.']),
    para('both on the same wi-fi, or this computer on the phone\'s hotspot.', 'hint'),
    row(btn('it\'s on', 'primary big', () => go({ type: 'share-on' }))),
  ],

  'wifi-list': () => {
    const box = el('div', 'choices found-list');
    for (const f of found.list ?? []) {
      const b = choice(f.name, `${f.host}:${f.port}${f.kind ? ` · ${f.kind}` : ''}`, () => go({ type: 'pick', found: f }), f.paired ? 'paired' : null);
      box.appendChild(b);
    }
    if (found.list && !found.list.length && !found.looking) box.appendChild(para(found.error ? 'this computer cannot look for phones here: type the address instead.' : 'none heard yet. is share this phone on?', 'none'));
    if (found.looking) box.appendChild(waiting('listening for kula phones…'));
    const r = row();
    if (!found.looking && !found.error) r.appendChild(btn('look again', 'ghost', lookAround));
    r.appendChild(btn('not in the list? type its address', 'link', () => go({ type: 'type-address' })));
    return [q('phones on this network'), box, r];
  },

  'wifi-code': () => {
    const out = [q('type the code you see on the phone')];
    const inputs = [];
    if (W.found) out.push(para(`${W.found.name} · ${W.found.host}:${W.found.port}`, 'wiz-name'));
    else {
      const [a, ai] = field('its address', 'address', { placeholder: '192.168.1.20:50551', inputmode: 'url', cls: 'addr' });
      out.push(para('the address is under the qr on the phone.', 'hint'), a);
      inputs.push(ai);
    }
    const [f, fi] = field('the code', 'code', { placeholder: '16 letters and digits', maxlength: '40', inputmode: 'text', cls: 'code' });
    out.push(f);
    inputs.push(fi);
    const more = el('details', 'wiz-more');
    const [fp, fpi] = field('certificate start', 'fp', { placeholder: 'the 16 after "certificate"', maxlength: '64', cls: 'code' });
    more.append(el('summary', '', 'to be sure: the certificate'), para('optional. the code already proves both sides; this also checks what the phone shows.', 'hint'), fp);
    if (draft.fp) more.open = true;
    out.push(more);
    inputs.push(fpi);
    for (const x of inputs) x.addEventListener('keydown', (e) => { if (e.key === 'Enter') pairWifiNow(); });
    if (W.error) out.push(...codeError(W.error));
    const b = btn(wizPairing ? 'pairing…' : 'pair', 'primary big', pairWifiNow);
    b.disabled = wizPairing;
    out.push(row(b));
    return out;
  },

  'wifi-check': () => [q(`looking at ${W.found?.name ?? 'the phone'}…`), waiting('it is paired already: checking that it answers')],

  'wifi-apart': () => {
    const box = el('div', 'choices');
    box.append(
      choice('use the cable instead', 'plug the phone into this computer', () => go({ type: 'use-cable' })),
      choice('try the phone\'s hotspot', 'this computer joins the phone\'s own wi-fi', () => go({ type: 'hotspot' })),
    );
    const out = [q('this network keeps devices apart'), para('this computer cannot reach the phone. guest, office and some home wi-fis keep devices from seeing each other (or the address is off).')];
    if (W.error) out.push(para(W.error, 'hint'));
    out.push(box);
    return out;
  },

  hotspot: () => [
    q('use the phone\'s hotspot'),
    steps(['on the phone, turn on its hotspot (settings → hotspot & tethering).', 'join that hotspot\'s wi-fi from this computer.', 'in kula on the phone, stop share this phone and start it again: the address changes.']),
    para('the phone then downloads models over its mobile data: they are big.', 'hint'),
    row(btn('this computer is on it', 'primary big', () => go({ type: 'on-hotspot' }))),
  ],

  model: () => {
    const phone = phoneNow();
    const out = [q('which model?')];
    const sub = el('p', 'wiz-p');
    sub.append(phone ? `for ${phone.name}. ` : 'no phone answers right now. ');
    sub.appendChild(btn('connect another device', 'link', () => go({ type: 'another' })));
    out.push(sub);
    const l = S.status?.loaded;
    if (l) {
      const n = el('p', 'hint');
      n.append(`${l.model.name} is loaded on ${l.devices.map((d) => d.name).join(', ')}. `);
      n.appendChild(btn('unload', 'link', async () => { await postJson('unload').catch((e) => toast(e.message)); await refreshStatus(); renderWiz(true); }));
      out.push(n);
    }
    const box = el('div', 'model-list wiz-models');
    if (!S.models.length) box.appendChild(waiting('getting the list…'));
    for (const m of wiz.modelRows(S.models, phone)) {
      const b = el('button', 'model');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(settings.model === m.id));
      b.append(el('b', '', `${m.name}${m.quant ? ` · ${m.quant}` : ''}`), el('span', 'size', gb(m.size)), el('span', 'blurb', m.catalog ? m.blurb : 'a file on this computer: only this computer can run it (here or split)'));
      const fit = el('span', 'fit');
      if (m.onPhone) fit.appendChild(el('span', 'yes', `on ${phone.name} now`));
      if (m.fit) fit.appendChild(el('span', m.fit[0], m.fit[1]));
      if (m.here) fit.appendChild(el('span', 'info', 'on this computer'));
      if (fit.children.length) b.appendChild(fit);
      b.addEventListener('click', () => { settings.model = m.id; saveSettings(); go({ type: 'model', id: m.id }); });
      box.appendChild(b);
    }
    out.push(box);
    return out;
  },

  mode: () => {
    const model = S.models.find((m) => m.id === W.model) ?? null;
    const out = [q('how should it run?')];
    if (model) out.push(para(model.name, 'wiz-name'));
    const box = el('div', 'choices two');
    for (const c of wiz.modeCards({ model, phone: phoneNow(), peers: S.peers, llama: !!S.status?.llama })) {
      const b = choice(c.title, c.disabled ? c.why : c.sub, () => { settings.mode = c.mode; saveSettings(); go({ type: 'mode', mode: c.mode }); }, c.recommended && !c.disabled ? 'recommended' : null);
      if (c.disabled) { b.disabled = true; b.classList.add('off'); }
      box.appendChild(b);
    }
    out.push(box);
    return out;
  },

  load: () => {
    const st = S.status;
    const name = S.models.find((m) => m.id === W.model)?.name ?? st?.loading?.model ?? 'the model';
    const bar = el('div', 'progress indeterminate');
    bar.id = 'wiz-progress';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `loading ${name}`);
    const fill = el('div', 'bar');
    fill.id = 'wiz-bar';
    bar.appendChild(fill);
    const msg = el('p', 'msg', st?.loading ? st.loading.line : 'starting…');
    msg.id = 'wiz-msg';
    msg.setAttribute('role', 'status');
    const r = row(btn('stop', 'ghost', () => postJson('stop').catch(() => {})));
    r.classList.add('end');
    r.id = 'wiz-load-row';
    return [q(`loading ${name}`), bar, msg, r];
  },

  done: () => [q('ready ✓'), para('the composer is yours.')],
};

function wizSignature() {
  const c = WIZ_CABLE.has(W.step) ? wiz.cableState(S.cable, W.serial, W.used) : null;
  return JSON.stringify([W.step, W.error, W.found, wizPairing, settings.way,
    c && [c.step, c.problem, c.error, c.busy, W.step === 'cable-code' ? null : c.lines, c.name],
    W.step === 'wifi-list' ? found : null,
    W.step === 'connected' ? S.peers.find((x) => x.id === W.peerId)?.name : null,
    W.step === 'model' || W.step === 'mode' ? [S.models.length, S.peers.map((x) => [x.id, x.reach?.ok, x.holds, x.ram]), settings.model, S.status?.loaded?.model?.id, !!S.status?.llama] : null]);
}

function renderWiz(force = false) {
  if (W.step === 'load' && wizStepShown === 'load' && !force) return;   // the load draws itself
  const sig = wizSignature();
  if (!force && sig === wizSig && wizStepShown === W.step) return;
  // a field being typed into keeps its focus and caret across a redraw
  const a = document.activeElement;
  const active = a && a.tagName === 'INPUT' && a.id.startsWith('wiz-') ? a.id : null;
  const body = $('wiz-step');
  const inside = !active && body.contains(a);   // focus inside the step: kept there, on the question
  wizSig = sig;
  body.replaceChildren(...(VIEWS[W.step] ?? VIEWS.how)());
  // the dots: where this question sits
  const stage = wiz.stageOf(W.step);
  const dots = $('wiz-dots');
  dots.replaceChildren(...wiz.STAGES.map((name, i) => { const li = el('li', i < stage ? 'past' : i === stage ? 'now' : ''); if (i === stage) li.setAttribute('aria-current', 'step'); return li; }));
  dots.setAttribute('aria-label', `step ${stage + 1} of ${wiz.STAGES.length}`);
  $('wiz-back').hidden = !wiz.back(W) || W.step === 'checking' || W.step === 'done' || (W.step === 'load' && !!loadRun);
  if (wizStepShown !== W.step) { wizStepShown = W.step; $('wiz-q')?.focus(); }
  else if (active && $(active)) { const i = $(active); i.focus(); i.setSelectionRange?.(i.value.length, i.value.length); }
  else if (inside || document.activeElement === document.body) $('wiz-q')?.focus();
}

// ---- the cable

function wizCable() {
  if (!$('connect').open || !$('advanced').hidden || !WIZ_CABLE.has(W.step)) return;
  const c = wiz.cableState(S.cable, W.serial, W.used);
  if (c.use && c.serial && !W.used.includes(c.serial)) useCableNow(c.serial);
  const before = W.step;
  W = wiz.next(W, { type: 'cable', view: S.cable });
  if (W.step === 'connected' && before !== 'connected') { pickPeer(W.peerId); refreshPeers(false).then(() => renderWiz()); }
  renderWiz();
  if (W.step !== before) enterStep();
}

async function useCableNow(serial) {
  W = wiz.next(W, { type: 'used', serial });
  try { await postJson('cable/use', { serial }); } catch (e) { toast(e.message); }
  refreshCable();
}

async function pairCableNow(serial) {
  const code = draft.code.trim();
  if (!code) { $('wiz-code')?.focus(); return; }
  if (wizPairing) return;
  wizPairing = true;
  renderWiz();
  try {
    await postJson('cable/pair', { serial, code });
    draft.code = '';
  } catch {} // the job keeps the error; GET cable shows it
  wizPairing = false;
  await refreshCable();
  renderWiz(true);
}

// ---- wi-fi

async function lookAround() {
  const run = wizRun;
  found = { list: found.list, looking: true, error: null };
  renderWiz();
  try {
    const list = await getJson('discover');
    if (run === wizRun) found = { list, looking: false, error: null };
  } catch (e) {
    if (run === wizRun) found = { list: [], looking: false, error: e.message };
  }
  renderWiz();
}

async function pairWifiNow() {
  if (wizPairing) return;
  const f = W.found;
  const address = f ? `${f.host.includes(':') ? `[${f.host}]` : f.host}:${f.port}` : draft.address.trim();
  if (!address) { $('wiz-address')?.focus(); return; }
  if (!draft.code.trim()) { $('wiz-code')?.focus(); return; }
  const run = wizRun;
  wizPairing = true;
  W = { ...W, error: null };
  renderWiz();
  try {
    const peer = await postJson('peers/add', { address, pin: draft.code.trim(), fp: draft.fp.trim(), name: f?.name ?? '' });
    wizPairing = false;
    if (run !== wizRun) return;
    draft.code = '';
    pickPeer(peer.id);
    await refreshPeers(false);
    go({ type: 'paired', peerId: peer.id });
  } catch (e) {
    wizPairing = false;
    if (run === wizRun) go({ type: 'pair-failed', error: e.message });
  }
}

async function checkFound(run) {
  const id = W.found?.paired;
  if (!id) return;
  try {
    S.peers = await postJson('peers/probe', { ids: [id] });
    if (run !== wizRun || W.step !== 'wifi-check') return;
    const peer = S.peers.find((x) => x.id === id);
    if (peer?.reach?.ok) { pickPeer(id); go({ type: 'reached', peerId: id }); }
    else go({ type: 'pair-failed', error: peer?.reach?.reason ?? 'it did not answer' });
  } catch (e) { if (run === wizRun) go({ type: 'pair-failed', error: e.message }); }
}

// ---- the load

async function wizLoad(run) {
  const show = {
    progress: (f) => {
      const bar = $('wiz-progress');
      if (!bar) return;
      if (f === false) { bar.hidden = true; return; }
      bar.hidden = false;
      bar.classList.toggle('indeterminate', f == null);
      $('wiz-bar').style.width = f == null ? '' : `${Math.round(f * 100)}%`;
      if (f != null) bar.setAttribute('aria-valuenow', String(Math.round(f * 100))); else bar.removeAttribute('aria-valuenow');
    },
    msg: (text, kind = '') => { const m = $('wiz-msg'); if (m) { m.textContent = text; m.className = `msg ${kind}`; } },
  };
  // a load that was already running (the page came back to it): its line until it ends
  if (S.status?.loading && !loadRun) {
    const t = setInterval(async () => {
      if (run !== wizRun || W.step !== 'load') return clearInterval(t);
      await refreshStatus();
      if (S.status?.loading) show.msg(`${S.status.loading.model}: ${S.status.loading.line}`);
      else { clearInterval(t); if (S.status?.loaded) go({ type: 'loaded' }); else renderWiz(true); }
    }, 1000);
    return;
  }
  const mode = W.mode ?? settings.mode;
  const body = { model: W.model ?? settings.model, mode, peers: wiz.loadPeers(mode, phoneNow(), S.peers), ctx: settings.ctx };
  if (mode !== 'here') { settings.peers = body.peers; saveSettings(); }
  $('wiz-back').hidden = true;
  const ok = await runLoad(body, show);
  if (run !== wizRun) return;
  if (ok) { go({ type: 'loaded' }); return; }
  W = wiz.next(W, { type: 'load-failed', error: $('wiz-msg')?.textContent || 'the load failed' });
  $('wiz-back').hidden = false;
  $('wiz-load-row')?.replaceChildren(btn('try again', 'primary big', () => { renderWiz(true); wizLoad(wizRun); }));
}

// ---- open, advanced

function showAdvanced(on) {
  $('advanced').hidden = !on;
  $('wiz').hidden = on;
  if (on) {
    renderModes(); renderPeers(); renderModels(); renderLoadState(); refreshCable();
    getJson('models').then((m) => { S.models = m; renderModels(); }).catch(() => {});
    refreshPeers(S.peers.length > 0);
    $('wiz-steps').focus();
  } else { renderWiz(true); $('wiz-q')?.focus(); }
}
$('wiz-advanced').addEventListener('click', () => showAdvanced(true));
$('wiz-steps').addEventListener('click', () => showAdvanced(false));
$('wiz-back').addEventListener('click', () => go({ type: 'back' }));

// auto: the page opened it by itself (a model loaded: it stays shut)
async function openConnect(auto) {
  if (isGuest()) return;
  auto = auto === true;
  const run = ++wizRun;
  W = wiz.initial(settings.way);
  wizStepShown = '';
  found = { list: null, looking: false, error: null };
  wizPairing = false;
  wizModelsProbed = 0;
  getJson('models').then((m) => { S.models = m; if (run === wizRun) renderWiz(); }).catch(() => {});
  let peers = S.peers;
  try { peers = S.peers = await getJson('peers'); } catch {}
  let start = wiz.startStep({ peers, status: S.status, explicit: !auto });
  if (start === 'done') return;
  const d = $('connect');
  const show = (step) => {
    W = { ...W, step };
    $('advanced').hidden = true;
    $('wiz').hidden = false;
    if (!d.open) d.showModal();
    renderWiz(true);
  };
  if (start !== 'load' && peers.length) {
    // paired before: is a phone there? (the probe also says which model it has loaded)
    show('checking');
    try { peers = S.peers = await postJson('peers/probe'); wizModelsProbed = Date.now(); } catch {}
    if (run !== wizRun) return;
    start = wiz.startStep({ peers, status: S.status, explicit: !auto });
    if (start === 'done') { d.close(); return; }
  }
  show(start);
  enterStep();
}

$('connect').addEventListener('close', () => { stopScan(); input.focus(); });

// ---------- settings

function snippet(tokenShown) {
  const i = S.info?.openai;
  if (!i) return '';
  return `# ~/.continue/config.yaml
models:
  - name: kula (phone)
    provider: openai
    model: kula
    apiBase: ${i.base}
    apiKey: ${tokenShown}
    roles: [chat, edit, apply]`;
}
let tokenVisible = false;
function renderOpenAi() {
  const i = S.info?.openai;
  if (!i) return;
  $('oa-base').textContent = i.base;
  const masked = `${i.token.slice(0, 5)}${'•'.repeat(12)}${i.token.slice(-4)}`;
  $('oa-token').textContent = tokenVisible ? i.token : masked;
  $('oa-show').textContent = tokenVisible ? 'hide' : 'show';
  $('oa-snippet').textContent = snippet(tokenVisible ? i.token : masked);
}
$('oa-show').addEventListener('click', () => { tokenVisible = !tokenVisible; renderOpenAi(); });
for (const b of document.querySelectorAll('[data-copy-from]')) b.addEventListener('click', () => {
  const which = b.dataset.copyFrom;
  const i = S.info?.openai;
  if (!i) return;
  copyText(which === 'oa-token' ? i.token : which === 'oa-snippet' ? snippet(i.token) : i.base);
});

async function openSettings() {
  $('set-temp').value = String(settings.temperature);
  $('temp-out').textContent = Number(settings.temperature).toFixed(2);
  $('set-max').value = String(settings.maxTokens);
  $('set-ctx').value = String(settings.ctx);
  $('set-system').value = settings.system;
  for (const b of document.querySelectorAll('#set-theme button')) b.setAttribute('aria-checked', String(b.dataset.theme === settings.theme));
  $('settings').showModal();
  if (isGuest()) return;
  if (!S.info) { try { S.info = await getJson('settings'); } catch {} }
  renderOpenAi();
}

// ---------- invite a device (the owner only)

let inviteInfo = null;
function renderInvite() {
  const i = inviteInfo;
  $('invite-on').checked = !!i?.on;
  $('invite-box').hidden = !i?.on;
  const m = $('invite-msg');
  m.textContent = i?.error ?? '';
  m.className = `msg${i?.error ? ' bad' : ''}`;
  $('open-invite').setAttribute('aria-pressed', String(!!i?.on));
  if (!i?.on) return;
  $('invite-qr').src = `${apiUrl('invite.svg')}?t=${encodeURIComponent(String(i.expiresAt))}`;
  $('invite-url').textContent = i.url;
  const left = Math.max(0, Math.round((i.expiresAt - Date.now()) / 60000));
  $('invite-meta').textContent = `${i.guests} guest${i.guests === 1 ? '' : 's'} in · this invite works for ${left >= 60 ? `${Math.floor(left / 60)} h ${left % 60} min` : `${left} min`} more · new invite ends every guest's session`;
}
async function refreshInvite() {
  try { inviteInfo = await getJson('invite'); } catch (e) { inviteInfo = { on: false, error: e.message }; }
  renderInvite();
}
$('open-invite').addEventListener('click', () => { $('invite').showModal(); refreshInvite(); });
$('invite-on').addEventListener('change', async () => {
  const on = $('invite-on').checked;
  try { inviteInfo = await postJson('invite', { on }); } catch (e) { inviteInfo = { on: false, error: e.message }; }
  renderInvite();
});
$('invite-new').addEventListener('click', async () => {
  if (!confirm('a new invite: the old qr code stops working and every guest has to scan again.')) return;
  try { inviteInfo = await postJson('invite/new'); } catch (e) { inviteInfo = { ...inviteInfo, error: e.message }; }
  renderInvite();
});
$('invite-copy').addEventListener('click', () => { if (inviteInfo?.url) copyText(inviteInfo.url); });
setInterval(() => { if ($('invite').open) refreshInvite(); }, 5000);

// ---------- the keyboard on a phone: keep the composer above it

if (window.visualViewport) {
  const fit = () => document.documentElement.style.setProperty('--app-h', `${Math.round(window.visualViewport.height)}px`);
  window.visualViewport.addEventListener('resize', fit);
  fit();
}
$('open-settings').addEventListener('click', openSettings);
$('set-temp').addEventListener('input', () => { settings.temperature = Number($('set-temp').value); $('temp-out').textContent = settings.temperature.toFixed(2); saveSettings(); });
$('set-max').addEventListener('change', () => { const n = Math.round(Number($('set-max').value)); if (n >= 16) { settings.maxTokens = Math.min(n, 32768); saveSettings(); } });
$('set-ctx').addEventListener('change', () => { const n = Math.round(Number($('set-ctx').value)); if (n >= 512) { settings.ctx = Math.min(n, 131072); saveSettings(); } });
$('set-system').addEventListener('input', () => { settings.system = $('set-system').value; saveSettings(); });
for (const b of document.querySelectorAll('#set-theme button')) b.addEventListener('click', () => {
  settings.theme = b.dataset.theme;
  saveSettings();
  applyTheme();
  for (const x of document.querySelectorAll('#set-theme button')) x.setAttribute('aria-checked', String(x === b));
});

// ---------- start

if (matchMedia('(max-width: 860px)').matches) setSide(false);
try { if (localStorage.getItem('kula.chat.brain') === '1' && !matchMedia('(max-width: 860px)').matches) setBrain(true); } catch {}
const fromHash = location.hash.slice(1);
newChat();
// who is this: the owner at 127.0.0.1, or a guest who came in with an invite
try { S.role = (await getJson('me')).role; } catch { S.role = 'guest'; }
document.body.classList.toggle('guest', isGuest());
if (isGuest()) { $('input').placeholder = 'message'; $('hello').textContent = 'ask away'; }
loadChats();
if (/^[0-9a-f]{8,32}$/.test(fromHash)) openChat(fromHash);
refreshStatus().then(() => {
  if (isGuest()) return;
  refreshInvite();
  // nothing loaded: the connect sheet opens by itself, at the model question when a paired
  // phone answers, else at the first question; a model loaded: no sheet
  if (!S.status?.loaded && !S.status?.loading) openConnect(true);
});
setInterval(() => { if (!document.hidden) refreshStatus(); }, 2500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
updateSend();
