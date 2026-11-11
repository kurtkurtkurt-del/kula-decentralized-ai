// kula chat: the page. Vanilla, no build, nothing from the network but this computer. Model
// text reaches the DOM only through markdown.js (which escapes everything) or textContent;
// names that devices give themselves go through textContent too.
import { renderMarkdown, splitThink, stripThink } from './markdown.js';
import * as wiz from './wizard.js';
import { mountLearn } from './learn.js';
import * as bmap from './brainmap.js';

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

const DEFAULTS = { temperature: 0.7, maxTokens: 1024, ctx: 4096, system: '', theme: 'kula', mode: 'phone', model: null, peers: [], way: null, pick: {},
  start: 'new', enter: 'enter', name: '', about: '', style: 'default' };
function readSettings() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('kula.chat.settings') || '{}') }; } catch { s = { ...DEFAULTS }; }
  for (const k of ['system', 'name', 'about']) if (typeof s[k] !== 'string') s[k] = '';
  if (!['new', 'last'].includes(s.start)) s.start = 'new';
  if (!['enter', 'mod'].includes(s.enter)) s.enter = 'enter';
  if (!['default', 'concise', 'detailed', 'friendly', 'formal'].includes(s.style)) s.style = 'default';
  if (!s.pick || typeof s.pick !== 'object' || Array.isArray(s.pick)) s.pick = {};
  return s;
}
const settings = readSettings();
function saveSettings() { try { localStorage.setItem('kula.chat.settings', JSON.stringify(settings)); } catch {} }
// look (6.11.2026): kula is the green rail, white plain white, dark plain black. an older
// choice (system, light) counts as kula.
function applyTheme() {
  if (!['kula', 'white', 'dark'].includes(settings.theme)) settings.theme = 'kula';
  if (settings.theme === 'kula') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
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
const shots = [];                   // photos waiting in the composer: { file, url }
let sending = false;                // shrinking them before a send

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
    const pj = projectOf(c.id);
    if (pj) { open.classList.add('proj'); open.prepend(el('span', `moon ${pj.state}`)); }
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
    renderProjectBanner();
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
  renderProjectBanner();
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


// ---------- night projects (6.11.2026): planned here, run by kula-node while you sleep. the
// project's chat stays closed for new messages until it has run; the parts and the morning
// report arrive in it. the page asks again every few seconds while one is open.
S.projects = [];
const projectOf = (chatId) => S.projects.find((p) => p.chatId === chatId) ?? null;
const PJ_MODE_NOTE = { apart: 'every device runs its own copy; the parts go to whichever is free.', split: 'one model across the devices you tick: bigger models fit, each word crosses the cables.', phone: 'one phone runs it; this Mac only carries the words.', here: 'only this Mac; no phone needed.' };
let pjMode = 'apart';
const pjPicked = new Set();
async function loadProjects() {
  if (isGuest()) return;
  try { S.projects = await getJson('projects'); } catch { return; }
  renderChatList();
  renderProjectBanner();
}
const two = (n) => String(n).padStart(2, '0');
const localInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`; };
const whenWords = (ms) => { const d = new Date(ms), now = new Date(); const day = d.toDateString() === now.toDateString() ? 'today' : new Date(now.getTime() + 86400000).toDateString() === d.toDateString() ? 'tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toLowerCase(); return `${day} ${two(d.getHours())}:${two(d.getMinutes())}`; };
function pjHours() {
  const a = new Date($('pj-start').value).getTime(), b = new Date($('pj-end').value).getTime();
  $('pj-hours').textContent = Number.isFinite(a) && Number.isFinite(b) && b > a ? `${((b - a) / 3600000).toFixed(1).replace(/\.0$/, '')} hours, from ${whenWords(a)} until ${whenWords(b)}` : '';
}
function renderPjDevices() {
  const box = $('pj-devices');
  box.replaceChildren();
  $('pj-devices-block').hidden = pjMode === 'here';
  const list = S.peers.filter((p) => !(pjMode === 'split' && p.far));
  if (!list.length) { box.appendChild(el('p', 'none', 'no device yet: add one under devices (top right).')); return; }
  for (const p of list) {
    const l = el('label', `pick${pjPicked.has(p.id) ? ' on' : ''}`);
    const c = el('input');
    c.type = pjMode === 'phone' ? 'radio' : 'checkbox';
    c.name = 'pj-dev';
    c.checked = pjPicked.has(p.id);
    c.addEventListener('change', () => { if (pjMode === 'phone') pjPicked.clear(); c.checked ? pjPicked.add(p.id) : pjPicked.delete(p.id); renderPjDevices(); });
    l.append(c, el('b', '', p.name), viaTag(p), el('span', 'sub', p.reach ? (p.reach.ok ? `reachable now${p.ram ? ` · ${(p.ram / 1024).toFixed(1)} GB free` : ''}` : 'not reachable now: kula tries again at the start') : 'not checked yet'));
    box.appendChild(l);
  }
}
function setPjMode(m) {
  pjMode = m;
  for (const b of document.querySelectorAll('#pj-mode button')) b.setAttribute('aria-checked', String(b.dataset.mode === m));
  $('pj-mode-note').textContent = PJ_MODE_NOTE[m];
  if (m === 'phone' && pjPicked.size > 1) { const first = [...pjPicked][0]; pjPicked.clear(); pjPicked.add(first); }
  renderPjDevices();
}
async function openProject() {
  if (isGuest()) return;
  const d = $('project');
  $('pj-msg').textContent = '';
  $('pj-msg').className = 'msg';
  // tonight 01:00 until 06:00 (tomorrow's when it is already past one)
  const t = new Date(); t.setHours(1, 0, 0, 0); if (t.getTime() < Date.now() + 10 * 60000) t.setDate(t.getDate() + 1);
  if (!$('pj-start').value) { $('pj-start').value = localInput(t.getTime()); $('pj-end').value = localInput(t.getTime() + 5 * 3600000); }
  pjHours();
  try { if (!S.models.length) S.models = await getJson('models'); } catch {}
  const sel = $('pj-model');
  sel.replaceChildren(...S.models.map((m) => { const o = el('option', '', `${m.name}${m.size ? ` · ${(m.size / 1e9).toFixed(2)} GB` : ''}`); o.value = m.id; return o; }));
  const loadedId = S.status?.loaded?.model?.id;
  sel.value = loadedId && S.models.some((m) => m.id === loadedId) ? loadedId : settings.model && S.models.some((m) => m.id === settings.model) ? settings.model : (S.models[0]?.id ?? '');
  if (!pjPicked.size) for (const p of S.peers) if (p.reach?.ok && !p.far) pjPicked.add(p.id);
  setPjMode(pjMode);
  d.showModal();
  refreshPeers(true).then(() => renderPjDevices());
  setTimeout(() => $('pj-title').focus(), 0);
}
$('open-project').addEventListener('click', openProject);
for (const b of document.querySelectorAll('#pj-mode button')) b.addEventListener('click', () => setPjMode(b.dataset.mode));
$('pj-start').addEventListener('input', pjHours);
$('pj-end').addEventListener('input', pjHours);
$('pj-go').addEventListener('click', async () => {
  const body = {
    title: $('pj-title').value.trim(), request: $('pj-request').value.trim(),
    start: new Date($('pj-start').value).getTime(), end: new Date($('pj-end').value).getTime(),
    model: $('pj-model').value, mode: pjMode, peers: pjMode === 'here' ? [] : [...pjPicked], ctx: settings.ctx,
  };
  const btn = $('pj-go');
  btn.disabled = true;
  try {
    const p = await postJson('projects/new', body);
    feed('planner', `night project planned: ${p.title}, ${whenWords(p.start)} until ${whenWords(p.end)}`);
    $('project').close();
    $('pj-title').value = ''; $('pj-request').value = '';
    await loadProjects();
    await loadChats();
    openChat(p.chatId);
  } catch (e) { $('pj-msg').textContent = e.message; $('pj-msg').className = 'msg bad'; }
  finally { btn.disabled = false; }
});

// the open chat when it belongs to a project: a band on top, the composer closed until it has run
function renderProjectBanner() {
  const b = $('proj-banner');
  const p = S.chat ? projectOf(S.chat.id) : null;
  const locked = !!p && (p.state === 'waiting' || p.state === 'running');
  input.disabled = locked;
  input.placeholder = locked ? (p.state === 'waiting' ? `this chat belongs to a night project: it opens after ${whenWords(p.end)}` : 'the night project is working: read along, the report comes here') : 'message kula';
  $('composer').classList.toggle('locked', locked);
  updateSend();
  if (!p) { b.hidden = true; return; }
  b.hidden = false;
  b.className = `proj-banner ${p.state}`;
  const peers = p.peers.map((id) => S.peers.find((x) => x.id === id)?.name ?? id);
  const model = S.models.find((m) => m.id === p.model)?.name ?? p.model;
  const head = el('div', 'pb-head');
  head.append(el('span', 'pb-moon'), el('b', '', p.title), el('span', 'pb-state', { waiting: 'waiting', running: 'working', done: 'done', failed: 'stopped', cancelled: 'cancelled', missed: 'missed' }[p.state] || p.state));
  const line = p.state === 'waiting' ? `starts ${whenWords(p.start)} · until ${whenWords(p.end)}`
    : p.state === 'running' ? `${p.line || 'working'}${p.parts ? ` · ${p.done || 0} of ${p.parts} parts` : ''} · until ${whenWords(p.end)}`
    : p.state === 'done' ? `finished ${whenWords(p.endedAt || p.end)} · the morning report is below`
    : p.state === 'failed' ? `stopped: ${p.error || 'see below'}` : p.state === 'missed' ? 'the Mac was asleep at the time' : 'cancelled';
  const sub = el('div', 'pb-sub', `${line} · ${model} · ${p.mode}${peers.length ? ` · ${peers.join(', ')}` : ''}`);
  b.replaceChildren(head, sub);
  if (p.state === 'running' && p.parts) { const bar = el('div', 'pb-bar'); const f = el('span'); f.style.width = `${Math.round(((p.done || 0) / p.parts) * 100)}%`; bar.appendChild(f); b.appendChild(bar); }
  if (locked) {
    const x = el('button', 'link pb-cancel', p.state === 'waiting' ? 'cancel the project' : 'stop it');
    x.type = 'button';
    x.addEventListener('click', async () => { try { await postJson('projects/cancel', { id: p.id }); await loadProjects(); } catch (e) { toast(e.message); } });
    head.appendChild(x);
  }
}
// while a project waits or works: its list, and its chat when open, asked again
setInterval(async () => {
  if (document.hidden || isGuest() || !S.projects.some((p) => p.state === 'waiting' || p.state === 'running')) return;
  const before = S.chat ? projectOf(S.chat.id) : null;
  await loadProjects();
  const p = S.chat ? projectOf(S.chat.id) : null;
  if (p && !S.streaming) {
    try {
      const c = await getJson(`chats/${p.chatId}`);
      if (S.chat?.id === p.chatId && (c.messages.length !== S.chat.messages.length || before?.state !== p.state)) { S.chat.messages = c.messages; renderThread(true); }
    } catch {}
  }
}, 8000);

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
      if (!text && !m.photos?.length) return;
      S.editing = -1;
      S.chat.messages = S.chat.messages.slice(0, i);
      ask(text, m.photos);
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send.click(); } if (e.key === 'Escape') cancel.click(); });
    row.append(cancel, send);
    box.append(ta, row);
    wrap.appendChild(box);
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); grow(ta); }, 0);
    ta.addEventListener('input', () => grow(ta));
    return wrap;
  }
  if (m.photos?.length) wrap.appendChild(photoRow(m.photos));
  if (m.content) wrap.appendChild(el('div', 'bubble', m.content));
  const tools = el('div', 'tools');
  if (m.content) tools.appendChild(toolButton('copy', ICON.copy, () => copyText(m.content)));
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
  if (live && !m.content && m.meta?.reading) {
    const r = m.meta.reading;
    ans.appendChild(el('p', 'reading', `${r.by} is reading ${r.n === 1 ? 'the photo' : `the ${r.n} photos`} on this computer…${r.tight ? ' memory is tight: it may take a while.' : ''}`));
  }
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
    } else if (/sees photos/.test(m.meta.error) && !isGuest()) {
      const b = el('button', 'link', 'vision model');
      b.type = 'button';
      b.addEventListener('click', () => openSettings('model'));
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
    // photos (10.11.2026): seen by the model itself, or read by a vision model on this computer first
    if (x.photos) parts.push(`${x.photos.n === 1 ? 'photo' : `${x.photos.n} photos`} ${x.photos.how === 'direct' ? 'seen' : 'read'} by ${x.photos.by}${x.photos.tight ? ' (memory was tight)' : ''}`);
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
  const sys = systemText();
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of S.chat.messages.slice(0, upTo)) {
    if (m.role === 'assistant') {
      const a = stripThink(m.content);
      if (!a.trim()) continue; // a failed or empty answer is not history
      msgs.push({ role: 'assistant', content: a });
    } else if (m.photos?.length) {
      // the server looks at the newest message's photos only; earlier ones go as their reading
      msgs.push({ role: m.role, content: m.content, photos: m.photos, ...(m.seen ? { seen: m.seen } : {}) });
    } else msgs.push({ role: m.role, content: m.content });
  }
  // only the newest user message's photos travel: earlier ones only as a count and their reading
  const last = msgs.map((x) => x.role).lastIndexOf('user');
  return msgs.map((x, i) => (x.photos && i !== last ? { ...x, photos: x.photos.length } : x));
}

function ask(text, photos) {
  if (S.streaming) return;
  if (!S.chat) newChat();
  S.chat.messages.push({ role: 'user', content: text, ...(photos?.length ? { photos } : {}) });
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
  const said = feed('executor', `question sent to ${MODE_WORD[S.status?.loaded?.mode] ? `the ${MODE_WORD[S.status.loaded.mode]} model` : 'the model'}, waiting for the first word…`, { active: true });
  try {
    const asker = msgs[index - 1];
    await postSse('chat', { messages: history, maxTokens: settings.maxTokens, temperature: settings.temperature }, (ev) => {
      if (typeof ev.reading === 'string') { m.meta = { reading: { by: ev.reading, n: ev.n, tight: !!ev.tight } }; feed('executor', `${ev.reading} reads the photo on this computer${ev.tight ? ' (memory is tight)' : ''}…`); paintLive(); }
      if (typeof ev.t === 'string') { if (!first) first = performance.now() - t0; pieces++; m.content += ev.t; paintLive(); }
      if (ev.done) {
        const ph = ev.photos;
        m.meta = { tokens: ev.tokens, tps: ev.tps, firstMs: ev.firstMs, ms: ev.ms, device: ev.device, ...(ev.stopped ? { stopped: true } : {}), ...(ph ? { photos: { how: ph.how, by: ph.by, n: ph.n, ...(ph.tight ? { tight: true } : {}) } } : {}) };
        // a vision model's reading stays with the message: later turns get it instead of the photos
        if (ph?.how === 'describe' && typeof ph.text === 'string' && asker?.role === 'user') asker.seen = { text: ph.text, by: ph.by, n: ph.n };
      }
      if (ev.error) m.meta = { error: ev.error };
    }, ac.signal);
  } catch (e) {
    if (ac.signal.aborted) {
      const ms = performance.now() - t0;
      delete m.meta.reading;
      m.meta = { ...m.meta, stopped: true, tokens: m.meta.tokens ?? pieces, firstMs: m.meta.firstMs ?? Math.round(first), device: m.meta.device ?? S.status?.loaded?.devices?.[0]?.name, tps: m.meta.tps ?? (pieces ? Math.round((pieces / Math.max(1, ms - first)) * 10000) / 10 : 0) };
    } else m.meta = { error: e.message };
  } finally {
    if (m.meta.reading) delete m.meta.reading;
    feedDone(said, m.meta.error ? `the answer failed: ${m.meta.error}` : `${m.meta.stopped ? 'stopped' : 'answered'}${m.meta.device ? ` on ${m.meta.device}` : ''}${m.meta.tokens ? ` · ${m.meta.tokens} tokens` : ''}${m.meta.tps ? ` · ${m.meta.tps} tok/s` : ''}`);
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
function updateSend() { $('send').disabled = (!input.value.trim() && !shots.length) || !!S.streaming || input.disabled; }
input.addEventListener('input', () => { grow(input); updateSend(); });
// settings → general → sending: enter sends (shift+enter a new line), or ctrl/⌘+enter sends
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (settings.enter === 'mod' ? mod : !e.shiftKey && !mod) { e.preventDefault(); $('composer').requestSubmit(); }
});
function composerHint() { $('composer-hint').textContent = settings.enter === 'mod' ? 'ctrl/⌘+enter sends · enter new line' : 'enter sends · shift+enter new line'; }
composerHint();
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if ((!text && !shots.length) || S.streaming || sending) return;
  const pj = S.chat ? projectOf(S.chat.id) : null;
  if (pj && (pj.state === 'waiting' || pj.state === 'running')) return toast('this chat opens after the night project has run');
  let photos = [];
  if (shots.length) {
    sending = true;
    try { photos = await shrinkAll(shots.map((x) => x.file)); }
    catch (err) { toast(err.message); return; }
    finally { sending = false; }
    const held = (S.chat?.messages ?? []).reduce((a, m) => a + (m.photos ?? []).reduce((b, u) => b + u.length, 0), 0);
    if (held + photos.reduce((a, u) => a + u.length, 0) > CHAT_PHOTOS_MAX) return toast('this chat holds as many photos as it can: start a new chat for more');
    clearShots();
  }
  input.value = '';
  grow(input);
  updateSend();
  ask(text, photos);
});

// ---------- photos (10.11.2026): up to three per message, shrunk here before they leave the
// browser (768 px on the long side for one, 512 for two or three, as the phone does) and sent
// as jpeg data urls. The server decides who looks at them (ui/vision.ts).
const MAX_SHOTS = 3;
const PHOTO_MAX = 1000000;          // characters of one data url, as the server checks
const CHAT_PHOTOS_MAX = 6000000;    // the photos one stored chat may hold
const photoSide = (n) => (n <= 1 ? 768 : 512);

function renderShots() {
  const box = $('shots');
  box.replaceChildren();
  box.hidden = !shots.length;
  shots.forEach((x, i) => {
    const f = el('figure', 'shot');
    const img = el('img');
    img.src = x.url;
    img.alt = `photo ${i + 1}`;
    const b = el('button', 'shot-x');
    b.type = 'button';
    b.title = 'remove this photo';
    b.setAttribute('aria-label', `remove photo ${i + 1}`);
    b.appendChild(svg(ICON.x));
    b.addEventListener('click', () => { URL.revokeObjectURL(x.url); shots.splice(i, 1); renderShots(); });
    f.append(img, b);
    box.appendChild(f);
  });
  $('attach').disabled = shots.length >= MAX_SHOTS;
  updateSend();
}
function clearShots() { for (const x of shots) URL.revokeObjectURL(x.url); shots.length = 0; renderShots(); }
function addShots(files) {
  const imgs = [...files].filter((f) => /^image\//.test(f.type));
  if (!imgs.length) return false;
  const room = MAX_SHOTS - shots.length;
  if (room <= 0) { toast(`at most ${MAX_SHOTS} photos per message`); return true; }
  if (imgs.length > room) toast(`at most ${MAX_SHOTS} photos per message: ${imgs.length - room} left out`);
  for (const f of imgs.slice(0, room)) shots.push({ file: f, url: URL.createObjectURL(f) });
  renderShots();
  input.focus();
  return true;
}
// one photo as a jpeg data url, its long side at most `side` px (never larger than it was)
function shrink(file, side) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      let out = c.toDataURL('image/jpeg', 0.85);
      if (out.length > PHOTO_MAX) out = c.toDataURL('image/jpeg', 0.6);
      if (out.length > PHOTO_MAX) return reject(new Error(`${file.name || 'a photo'} is still too big after shrinking`));
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name || 'that file'} is not a photo this browser can read`)); };
    img.src = url;
  });
}
const shrinkAll = (files) => Promise.all(files.map((f) => shrink(f, photoSide(files.length))));

function photoRow(list) {
  const row = el('div', 'photos');
  list.forEach((u, i) => {
    if (typeof u !== 'string' || !u.startsWith('data:image/')) return;
    const img = el('img');
    img.src = u;
    img.alt = `photo ${i + 1}`;
    img.loading = 'lazy';
    row.appendChild(img);
  });
  return row;
}

$('attach').addEventListener('click', () => $('photo-input').click());
// the "+" (10.11.2026): after the pick, unless the loaded model sees photos itself, the start a
// chat sheet asks which model should see it, listing only models that see photos (W.vision)
$('photo-input').addEventListener('change', () => {
  const added = addShots($('photo-input').files);
  $('photo-input').value = '';
  if (added && !isGuest() && !S.status?.loaded?.sees && !S.streaming) openConnect(false, true);
});
input.addEventListener('paste', (e) => { const files = e.clipboardData?.files; if (files?.length && addShots(files)) e.preventDefault(); });
const composerEl = $('composer');
composerEl.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); composerEl.classList.add('drop'); } });
composerEl.addEventListener('dragleave', (e) => { if (!composerEl.contains(e.relatedTarget)) composerEl.classList.remove('drop'); });
composerEl.addEventListener('drop', (e) => { composerEl.classList.remove('drop'); if (e.dataTransfer?.files?.length) { e.preventDefault(); addShots(e.dataTransfer.files); } });
$('stop').addEventListener('click', () => S.streaming?.ac.abort());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.streaming && !document.querySelector('dialog[open]')) S.streaming.ac.abort(); });

// ---------- top bar, empty state, brain

function whereText() {
  const st = S.status;
  const box = $('where-text');
  box.replaceChildren();
  const dot = $('where-dot');
  dot.className = 'dot';
  $('where').classList.remove('nomodel');
  if (st?.loading) {
    dot.classList.add('busy');
    box.append('loading ', el('b', '', st.loading.model), ` · ${st.loading.line}`);
    return;
  }
  if (st?.loaded) {
    const l = st.loaded;
    dot.classList.add(l.devices.some((d) => d.busy) ? 'busy' : 'ok');
    const names = (l.parts?.length ? l.parts : l.devices).map((d) => d.name).join(', ') || '—';
    box.append(el('b', '', l.model.name), ` on ${names} · ${l.mode === 'phone' ? 'phone' : l.mode}`);
    return;
  }
  $('where').classList.add('nomodel');
  box.append('no model yet · ', el('b', '', 'start a chat'));
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
    const b = el('button', 'link', 'start a chat');
    b.type = 'button';
    b.addEventListener('click', openConnect);
    sub.append(b, ' and pick a model.');
  }
}


// ---------- the brain, now (6.11.2026): what the brain is doing this moment, as it does it.
// Every line comes from real work on this page or on this computer's engine: a look at the
// devices, the usb cables, a load, an answer, a decision the engine wrote down. A line still
// running ends in "…" and is rewritten when it is done; the same line twice counts up.
const FEED = [];
const FEED_MAX = 80;
function feed(branch, text, opts = {}) {
  const now = Date.now();
  const last = FEED[0];
  if (!opts.id && last && !last.active && last.branch === branch && last.text === text) { last.n = (last.n || 1) + 1; last.at = now; renderFeed(); return last; }
  const line = { id: opts.id || null, branch, text, at: opts.at || now, active: !!opts.active, n: 1 };
  FEED.unshift(line);
  FEED.length = Math.min(FEED.length, FEED_MAX);
  renderFeed();
  return line;
}
function feedDone(line, text) { if (!line) return; line.active = false; if (text) line.text = text; line.at = Date.now(); renderFeed(); }
function renderFeed() {
  const ol = $('bfeed');
  if (!ol) return;
  const items = FEED.map((l) => {
    const li = el('li', `bf ${l.active ? 'active' : ''} b-${l.branch.replace(/[^a-z]/g, '')}`);
    const chip = el('span', 'bf-b', l.branch);
    try { chip.style.setProperty('--c', branchColor(l.branch)); } catch {}
    li.append(el('time', '', clock(l.at)), chip, el('span', 'bf-t', `${l.text}${l.active ? '' : ''}${l.n > 1 ? ` ×${l.n}` : ''}`));
    return li;
  });
  ol.replaceChildren(...items);
  if (!items.length) ol.appendChild(el('li', 'none', 'quiet. nothing running.'));
  $('bfeed-pulse').className = `bfeed-pulse${FEED.some((l) => l.active) ? ' on' : ''}`;
}

// ---------- the brain (6.11.2026): the twelve branches of the brain map, two by six. A built
// branch is lit and shows, live, what it does on this computer; one not built yet is dark,
// says what it will do and stays a promise. A tap opens the branch's page; "all twelve" goes back.
let brainOpen = null; // the branch whose page shows, or null for the tiles

const MODE_WORD = { phone: 'on the phone', apart: 'apart', split: 'split', here: 'here' };
const reachWord = (r) => (r ? (r.ok ? `reachable${r.ms ? ` · ${r.ms} ms` : ''}` : `not reachable: ${r.reason}`) : 'not checked yet');
const kv = (k, v, cls = '') => { const r = el('div', `bd-row ${cls}`); r.append(el('span', 'k', k), el('span', 'v', v)); return r; };
const bdList = (items, empty) => { const ul = el('ul', 'bd-list'); for (const t of items) ul.appendChild(typeof t === 'string' ? el('li', '', t) : t); if (!items.length) ul.appendChild(el('li', 'none', empty)); return ul; };
const devLine = (name, sub, dot) => { const li = el('li', 'bd-dev'); li.append(el('span', `dot ${dot}`), el('b', '', name), el('span', 'sub', sub)); return li; };

// god's eye (kula-node src/godseye): the brain's twelve branches. What each says, whether it is
// built and its page all come from the eye on this computer; the page only draws them. The eye
// watches the work from above and never takes part in it.
const BRANCH_MAP = [
  [1, 'senses', 'senses'], [2, 'memory', 'memory'], [3, 'forecast', 'forecast'], [4, 'learning', 'learning loop'],
  [5, 'connections', 'connections'], [6, 'planner', 'planner'], [7, 'executor', 'executor'], [8, 'trust', 'trust and verification'],
  [9, 'limits', 'limits'], [10, 'models', 'models and device care'], [11, 'review', 'request review'], [12, 'advisor', 'advisor'],
];
const eyeOf = (id) => (Array.isArray(S.brain?.branches) ? S.brain.branches.find((b) => b.id === id) : null) ?? null;
const BRANCHES = BRANCH_MAP.map(([n, id, name]) => ({
  n, id, name,
  get built() { return !!eyeOf(id)?.built; },
  get what() { return eyeOf(id)?.what || ''; },
  stat: () => eyeOf(id)?.stat || (S.brain ? 'not built yet' : 'looking…'),
  live: () => {
    const v = eyeOf(id);
    if (!v) return [];
    if (id === 'trust' && v.report) return trustReport(v.report);
    const out = (v.rows ?? []).map(([k, val]) => kv(k, val));
    // the black box (god's eye's hash-chained record) is the memory's: its rows under the memory's own
    if (id === 'memory') for (const [k, val] of bmap.boxRows(S.brain?.box)) out.push(kv(k, val, k === 'black box' && S.brain.box.ok === false ? 'busy' : ''));
    if (v.lines?.length) out.push(bdList(v.lines, ''));
    if (v.note) out.push(el('p', 'bd-note', v.note));
    if (v.error) out.push(el('p', 'bd-note', `stopped: ${v.error}`));
    return out;
  },
}));

// the trust branch's one screen (10.11.2026): one verdict for the cluster on top, then every
// device's checks, each with a mark: ✓ checked and holds, ✕ look at this, – not known or the
// device's own word. god's eye checked all of it on this computer; the page only draws it.
// device names come from the devices' own qrs: escaped before they go into any html string
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TRUST_WORD = { ok: 'all clear', bad: 'look at this', unknown: 'not checked yet' };
const TRUST_K = { pinned: 'pinned', encrypted: 'encrypted', identity: 'identity', refused: 'refused', ledger: 'ledger', key: 'key', 'owner-blind': 'owner-blind' };
const verdictOf = (checks) => (checks.some((c) => c.ok === false) ? 'bad' : checks.some((c) => c.ok === null) ? 'unknown' : 'ok');
function trustCard(name, verdict, checks, sub, acceptId) {
  const card = el('section', `tr-card ${verdict}`);
  const head = el('div', 'tr-head');
  head.append(el('span', `tr-dot ${verdict}`), el('b', '', name), el('span', 'tr-v', `${TRUST_WORD[verdict]}${sub ? ` · ${sub}` : ''}`));
  card.appendChild(head);
  for (const c of checks) {
    const row = el('div', `tr-check ${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'na'}`);
    row.append(el('span', 'tr-m', c.ok === true ? '✓' : c.ok === false ? '✕' : '–'), el('span', 'tr-k', TRUST_K[c.k] ?? c.k), el('span', 'tr-t', c.text));
    card.appendChild(row);
  }
  if (acceptId) {
    const b = el('button', 'link tr-accept', 'I know why (I cleared it): carry on from here');
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { const r = await postJson('brain/act', { branch: 'trust', action: 'accept', arg: acceptId }); if (r?.view) S.brain = r.view; renderBrain(); } catch (e) { b.disabled = false; b.textContent = e.message; }
    });
    card.appendChild(b);
  }
  return card;
}
function trustReport(r) {
  const top = el('div', `tr-verdict ${r.verdict}`);
  const words = el('div', 'tr-words');
  words.append(el('b', '', TRUST_WORD[r.verdict]), el('span', '', r.headline));
  top.append(el('span', 'tr-big', r.verdict === 'ok' ? '✓' : r.verdict === 'bad' ? '!' : '…'), words);
  const out = [top];
  for (const d of r.devices) out.push(trustCard(d.name, d.verdict, d.checks, d.refused, d.accept ? d.id : null));
  out.push(trustCard(`${r.host.name} · this computer`, verdictOf(r.host.checks), r.host.checks, ''));
  out.push(el('p', 'bd-note', 'checked here, not taken on trust: each certificate against the fingerprint pinned from its qr, each ledger line’s chain and signature, each phone’s hardware proof that its owner cannot read the jobs it runs (shown, not counted in the verdict yet). no prompts, no answers: only who connected and whether it was let in.'));
  return out;
}

// a colour and a sign for each branch (from kula's palette: terracotta, sage, gold, clay, and
// the dusty blue of a cable), drawn faint inside its tile like the devices bubble does
const BRANCH_LOOK = {
  senses: ['#5b7a55', ['M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z', 'M10 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z']],
  memory: ['#8a5a6e', ['M4 4.5h12v11H4z', 'M4 8h12M4 11.5h12']],
  forecast: ['#b07d3f', ['M3 16.5h14', 'M4 13l4-4 3 2.5 5-6', 'M13.5 5.5H16V8']],
  learning: ['#4a7f7a', ['M15.5 9a5.5 5.5 0 0 0-10-2.5', 'M4.5 4v3h3', 'M4.5 11a5.5 5.5 0 0 0 10 2.5', 'M15.5 16v-3h-3']],
  connections: ['#4f7397', ['M5.5 7.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z', 'M14.5 7.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z', 'M8 10h4']],
  planner: ['#c86a51', ['M3.5 4.5h5v5h-5zM11.5 4.5h5v5h-5zM7.5 11.5h5v5h-5z', 'M6 9.5v2h1.5M14 9.5v2h-1.5']],
  executor: ['#9b5b3a', ['M11 2.5 4.5 11H10l-1 6.5L15.5 9H10z']],
  trust: ['#6b7a3c', ['M10 2.5 16 5v4.5c0 4-2.6 6.6-6 8-3.4-1.4-6-4-6-8V5z', 'M7.3 10l2 2 3.5-4']],
  limits: ['#b4513a', ['M10 3a1.8 1.8 0 0 1 1.8 1.8v6.8a3.5 3.5 0 1 1-3.6 0V4.8A1.8 1.8 0 0 1 10 3z', 'M10 9v5']],
  models: ['#8b6a4a', ['M6 6h8v8H6z', 'M8.5 3.5v2.5M11.5 3.5v2.5M8.5 14v2.5M11.5 14v2.5M3.5 8.5h2.5M3.5 11.5h2.5M14 8.5h2.5M14 11.5h2.5']],
  review: ['#5f6b7a', ['M8.5 3.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10z', 'M12.2 12.2 16.5 16.5']],
  advisor: ['#a08445', ['M10 2.8a4.7 4.7 0 0 0-2.8 8.5c.6.5.9 1.1.9 1.8v.6h3.8v-.6c0-.7.3-1.3.9-1.8A4.7 4.7 0 0 0 10 2.8z', 'M8.2 16h3.6M8.8 17.8h2.4']],
};
const branchColor = (name) => { const b = BRANCHES.find((x) => x.id === name || x.name === name); return b ? BRANCH_LOOK[b.id][0] : 'var(--meta)'; };


function openBranch(id) {
  brainOpen = id;
  const br = $('brain');
  if (br.classList.contains('compact')) { br.classList.remove('compact'); br.scrollTo({ top: 0, behavior: 'smooth' }); }
  renderBrain();
}

function renderBrain() {
  const grid = $('bgrid');
  if (!grid) return;
  const built = BRANCHES.filter((b) => b.built).length;
  $('brain-sub').textContent = `${built} of 12 built`;
  if (!S.models?.length && !renderBrain.asked) { renderBrain.asked = true; getJson('models').then((m) => { S.models = m; feed('models', `${m.length} models in the list; a file is checked by sha256 before it runs`); renderBrain(); }).catch(() => {}); }
  const open = BRANCHES.find((b) => b.id === brainOpen) ?? null;
  grid.hidden = !!open;
  $('bdetail').hidden = !open;
  if (open) {
    $('bdetail').style.setProperty('--c', BRANCH_LOOK[open.id][0]);
    $('bd-n').textContent = String(open.n);
    $('bd-title').textContent = open.name;
    $('bd-state').textContent = open.built ? 'live' : 'not built yet';
    $('bd-state').className = `bd-state ${open.built ? 'on' : 'off'}`;
    $('bd-what').textContent = open.what;
    $('bd-live').replaceChildren(...(open.built ? open.live() : [el('p', 'bd-note', 'this part of the brain is on the map, not in the code yet.')]));
    return;
  }
  drawMap(grid);
}

// ---------- the map (10.11.2026, the owner's pick: "the map, then four numbers"): the twelve
// around this computer, coloured by state only (brainmap.js), then four numbers, the branch that
// needs you most (a tap on a node swaps it, "open" shows its page), the others worth a look,
// and the feed below. Every word is the eye's or the engine's; the page only arranges them.
const SHORT_MAP = { learning: 'learning loop', trust: 'trust', models: 'models', review: 'review' }; // the full name is on the branch's page
let brainPick = null; // the branch the card shows after a tap on its node; null: the one that needs you most
const MAP_SVG = (paths) => paths.map((d) => `<path d="${d}"/>`).join('');
const stateDot = (state) => `<i class="bm-s is-${state}"></i>`;
function drawMap(box) {
  const ids = BRANCHES.map((b) => b.id);
  const list = bmap.statesOf(ids, eyeOf);
  // a black box whose chain does not hold puts the memory branch on "look at this", in its words
  const boxSays = bmap.boxLine(S.brain?.box);
  if (boxSays?.state === 'look') { const m = list.find((x) => x.id === 'memory'); if (m && m.state !== 'off') m.state = 'look'; }
  const said = (id) => (id === 'memory' && boxSays?.state === 'look' ? boxSays.text : BRANCHES.find((b) => b.id === id)?.stat() ?? '');
  const stateOf = Object.fromEntries(list.map((x) => [x.id, x.state]));
  const auto = bmap.firstOpen(list);
  const pick = ids.includes(brainPick) ? brainPick : auto;
  const stat = (id) => BRANCHES.find((b) => b.id === id)?.stat() ?? '';
  const st = S.status, L = st?.loaded;
  const M = bmap.MAP;

  // the map
  let spokes = '', nodes = '';
  BRANCHES.forEach((b, k) => {
    const p = bmap.nodeAt(k), state = stateOf[b.id], sel = b.id === pick;
    spokes += `<line class="spoke is-${state}" x1="${M.cx}" y1="${M.cy}" x2="${p.x}" y2="${p.y}"/>`;
    const label = `${b.n} ${b.name}: ${b.built ? stat(b.id) : 'not built yet'} (${bmap.STATE_WORD[state]})`;
    nodes += `<g class="node is-${state}${sel ? ' sel' : ''}" data-id="${b.id}" tabindex="0" role="button" aria-pressed="${sel}" aria-label="${esc(label)}"><title>${esc(label)}</title>`
      + `${sel ? `<circle class="halo" cx="${p.x}" cy="${p.y}" r="${M.r + 5.5}"/>` : ''}<circle class="bm-dot" cx="${p.x}" cy="${p.y}" r="${M.r}"/>`
      + `<svg class="ic" x="${p.x - 9}" y="${p.y - 9}" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">${MAP_SVG(BRANCH_LOOK[b.id][1])}</svg>`
      + `<text x="${p.x}" y="${p.ly}"><tspan class="n">${b.n} </tspan>${esc(SHORT_MAP[b.id] ?? b.name)}</text></g>`;
  });
  const model = L ? L.model.name : st?.loading ? st.loading.model : 'no model loaded';
  const under = L ? `loaded · ${Math.round(L.model.size / 1e6)} MB` : st?.loading ? 'loading…' : 'start a chat';
  const fit = model.length > 15 ? ` textLength="${M.core * 2 - 12}" lengthAdjust="spacingAndGlyphs"` : '';
  const core = `<g class="core" data-id="models" tabindex="0" role="button" aria-label="this computer: ${esc(model)}, ${esc(under)}"><circle cx="${M.cx}" cy="${M.cy}" r="${M.core}"/>`
    + `<text class="c1" x="${M.cx}" y="${M.cy - 19}">this computer</text><text class="c2" x="${M.cx}" y="${M.cy + 2}"${fit}>${esc(model)}</text><text class="c3" x="${M.cx}" y="${M.cy + 20}">${esc(under)}</text></g>`;
  const map = `<svg class="bm-map" viewBox="0 ${M.top} ${M.w} ${M.h}" role="group" aria-label="the twelve branches around this computer"><ellipse class="ring" cx="${M.cx}" cy="${M.cy}" rx="${M.rx}" ry="${M.ry}"/>${spokes}${core}${nodes}</svg>`;

  // the legend: how many in each state
  const c = bmap.counts(list);
  const legend = [['look', 'to look at'], ['know', 'worth knowing'], ['fine', 'fine'], ['quiet', 'quiet'], ['off', 'not built']]
    .filter(([k]) => c[k]).map(([k, w]) => `<span>${stateDot(k)}${c[k]} ${w}</span>`).join('');

  // four numbers: the answering speed, then devices, reachability, memory
  const d = L?.devices ?? [], busy = d.some((x) => x.busy), tps = Math.max(0, ...d.map((x) => x.tps || 0));
  const four = bmap.fourNumbers({ senses: stat('senses'), learning: stat('learning'), memory: stat('memory') });
  const speed = busy ? 'answering' : tps ? `${tps.toFixed(1)}<small>tok/s</small>` : '—';
  const cell = (id, k, value, sub) => `<button type="button" class="bm-cell is-${stateOf[id]}" data-open="${id}"><span class="k">${k}</span><b>${value}</b><span class="sub">${stateOf[id] === 'know' || stateOf[id] === 'look' ? stateDot(stateOf[id]) : ''}${esc(sub)}</span></button>`;
  const card = `<div class="bm-kpi">`
    + `<button type="button" class="bm-speed" data-open="executor"><span class="big">${speed}</span><span class="bm-side"><span class="k">answering speed</span><span class="kstate">${stateDot(stateOf.executor)}${esc(stat('executor'))}</span></span></button>`
    + `<div class="bm-3">`
    + cell('senses', 'devices active', four.devices ? `${four.devices.on}<small>of ${four.devices.of}</small>` : '—', four.devices ? 'senses' : stat('senses'))
    + cell('learning', 'reachability right', four.reach != null ? `${four.reach}<small>%</small>` : '—', four.reach != null ? 'learning loop' : stat('learning'))
    + cell('memory', 'events kept', four.events ? String(four.events.n) : '—', four.events ? `memory${four.events.today != null ? ` · ${four.events.today} today` : ''}` : stat('memory'))
    + `</div></div>`;

  // the open card: the branch that needs you most, or the one tapped
  const b = BRANCHES.find((x) => x.id === pick);
  const ps = stateOf[pick];
  const hint = pick === auto && (ps === 'look' || ps === 'know') ? 'shown first: it needs you most. tap any node to swap.' : 'tap any node to swap.';
  const sel = `<div class="bm-sel is-${ps}"><div class="h"><span class="n">${b.n}</span><b>${esc(b.name)}</b><span class="tag is-${ps}">${bmap.STATE_WORD[ps]}</span></div>`
    + `<p class="stat">${esc(b.built ? said(b.id) : 'not built yet')}</p><div class="f"><span>${hint}</span><button type="button" class="link" data-open="${b.id}">open ›</button></div></div>`;

  // the others worth a look
  const also = bmap.notices(list, pick).map((x) => { const o = BRANCHES.find((y) => y.id === x.id); return `<button type="button" data-open="${o.id}">${stateDot(x.state)}<span><b>${esc(SHORT_MAP[o.id] ?? o.name)}</b> ${esc(said(o.id))}</span><span class="go">›</span></button>`; }).join('');

  box.innerHTML = `${map}<div class="bm-legend">${legend}</div>${card}${sel}${also ? `<div class="bm-also">${also}</div>` : ''}`;
  const choose = (id) => { brainPick = id === auto ? null : id; renderBrain(); box.querySelector(`.node[data-id="${id}"]`)?.focus(); };
  for (const n of box.querySelectorAll('.node')) {
    n.addEventListener('click', () => choose(n.dataset.id));
    n.addEventListener('dblclick', () => openBranch(n.dataset.id));
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(n.dataset.id); } });
  }
  const coreEl = box.querySelector('.core');
  // the centre: the models branch, or the steps to load one when nothing is loaded
  const coreGo = () => (L || st?.loading || isGuest() ? openBranch('models') : openConnect());
  coreEl.addEventListener('click', coreGo);
  coreEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); coreGo(); } });
  for (const x of box.querySelectorAll('[data-open]')) x.addEventListener('click', () => openBranch(x.dataset.open));
}
$('bback').addEventListener('click', () => { brainOpen = null; renderBrain(); });
// (6.11.2026) the tiles no longer fold: the feed scrolls in its own box
// learn (8.11.2026): a second tab of the brain panel, what to read and watch (learn.js)
mountLearn({ brain: $('brain'), tabs: $('btabs'), view: $('blearn') });


// what changed in the engine since the last look, said in the feed
function brainWatch(was, st) {
  if (!st) return;
  for (const d of st.decisions ?? []) if (d.at > seenDecision) { seenDecision = d.at; if (was) feed('memory', `noted: ${d.text}`, { at: d.at }); }
  if (st.loading && !loadLine) loadLine = feed('planner', `loading ${st.loading.model} (${MODE_WORD[st.loading.mode] || st.loading.mode})…`, { active: true });
  if (st.loading && loadLine && st.loading.line) { loadLine.text = `loading ${st.loading.model}: ${st.loading.line}…`; renderFeed(); }
  if (!st.loading && loadLine) { feedDone(loadLine, st.loaded ? `${st.loaded.model.name} is loaded, ${MODE_WORD[st.loaded.mode] || st.loaded.mode}, on ${(st.loaded.parts?.length || st.loaded.devices.length)} device${(st.loaded.parts?.length || st.loaded.devices.length) === 1 ? '' : 's'}${st.loaded.parts ? `: ${st.loaded.parts.map((p) => `${p.name} ${p.layers} layers`).join(', ')}` : ''}` : 'the load stopped'); loadLine = null; }
  if (was?.loaded && !st.loaded) feed('planner', `${was.loaded.model.name} unloaded`);
  const busy = (st.loaded?.devices ?? []).filter((d) => d.busy);
  if (busy.length && !answerLine) answerLine = feed('executor', `answering on ${busy.map((d) => d.name).join(', ')}…`, { active: true });
  if (!busy.length && answerLine) {
    const d = (st.loaded?.devices ?? []).find((x) => answerLine.text.includes(x.name));
    feedDone(answerLine, `answered${d?.tps ? ` at ${d.tps} tok/s` : ''} on ${d?.name ?? 'the device'}`); answerLine = null;
  }
}

let seenDecision = 0;
let loadLine = null;
let answerLine = null;
// the watcher's view of the dark branches, and what they said since the last look
let seenBrainAt = 0;
async function refreshBrain() {
  try { S.brain = await getJson('brain'); } catch { return; }
  const fresh = (S.brain.events ?? []).filter((e) => e.at > seenBrainAt).reverse();
  for (const e of fresh) feed(e.branch, e.text, { at: e.at });
  if (fresh.length) seenBrainAt = fresh[fresh.length - 1].at;
}

async function refreshStatus() {
  const was = S.status;
  try { S.status = await getJson('status'); } catch { return; }
  brainWatch(was, S.status);
  if ($('app').classList.contains('brain-open') && !isGuest()) await refreshBrain();
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
  if (open) { renderBrain(); refreshPeers(false); if (!isGuest()) refreshBrain().then(renderBrain); }
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

// ---------- connect: devices

async function refreshPeers(probe) {
  if (isGuest()) return;
  const before = new Set(S.peers.map((p) => p.id));
  const look = probe && S.peers.length ? feed('senses', `checking ${S.peers.length} link${S.peers.length === 1 ? '' : 's'} to the devices…`, { active: true }) : null;
  try { S.peers = probe ? await postJson('peers/probe') : await getJson('peers'); } catch (e) { toast(e.message); feedDone(look, `could not check: ${e.message}`); }
  if (look?.active) {
    const ok = S.peers.filter((p) => p.reach?.ok);
    const best = ok.filter((p) => p.reach.ms).sort((a, b) => a.reach.ms - b.reach.ms)[0];
    feedDone(look, `${ok.length} of ${S.peers.length} answer${best ? `, fastest ${best.name} in ${best.reach.ms} ms` : ''}`);
    const tls = S.peers.filter((p) => p.tls && p.reach?.ok).length;
    if (ok.length) feed('trust', `${tls} of ${ok.length} answering links are tls with the pinned certificate`);
  }
  for (const p of S.peers) if (before.size && !before.has(p.id)) feed('connections', `paired with ${p.name} (${(p.via ?? (p.cable ? 'cable' : p.far ? 'relay' : 'wifi')) === 'wifi' ? 'wi-fi' : p.via ?? 'cable'})`);
  const fresh = before.size ? S.peers.filter((p) => !before.has(p.id)).map((p) => p.id) : [];
  if (fresh.length && settings.peers.length && settings.mode !== 'phone') { settings.peers = [...new Set([...settings.peers, ...fresh])]; saveSettings(); }
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

function renderPeers() { renderDevices(); }

// ---------- devices: one list (6.11.2026). Every device once, however it is reached: a phone
// adb sees on a cable and the paired records of it (by cable, by wi-fi) are one row. Active
// ones first. A cable row is blue, a wi-fi row green, with its sign faint inside the box.
const VIA_ICON = {
  cable: ['M7.5 2.5v4M12.5 2.5v4', 'M5.5 6.5h9v3a4.5 4.5 0 0 1-9 0z', 'M10 14v3.5'],
  wifi: ['M2.5 8a11 11 0 0 1 15 0', 'M5 10.8a7.3 7.3 0 0 1 10 0', 'M7.6 13.5a3.5 3.5 0 0 1 4.8 0', 'M10 16.3v.01'],
};
const devKey = (name) => String(name || '').toLowerCase().replace(/samsung|galaxy/g, '').replace(/[^a-z0-9]/g, '');

// what a device does in the loaded model, by peer id: a split part, or its own copy
function activeRoles() {
  const L = S.status?.loaded;
  const m = new Map();
  if (!L) return m;
  for (const p of L.parts ?? []) if (!p.local) m.set(p.id, `holds ${p.layers} layers of ${L.model.name} (${p.mb} MB)`);
  for (const d of L.devices ?? []) if (!d.local && !m.has(d.id)) m.set(d.id, `${d.busy ? 'answering with' : 'runs'} ${L.model.name}${d.tps ? ` · ${d.tps} tok/s` : ''}`);
  return m;
}

// One device, one row (8.11.2026): the server merges a phone's cable record and its wi-fi
// record by its certificate (GET peers: `ways`, `via`, `routes`). Here a phone adb sees on the
// cable joins its paired row by serial; one not paired yet joins a row of the same name.
function deviceGroups() {
  const groups = [];
  const roles = activeRoles();
  for (const d of S.cable?.adb === false ? [] : S.cable?.devices || []) groups.push({ key: devKey(d.name), name: d.name, cable: d, peers: [] });
  for (const p of S.peers) {
    let g = groups.find((x) => x.cable && (x.cable.peer?.id === p.id || (p.cable && p.cable.serial === x.cable.serial)))
      ?? groups.find((x) => x.cable && !x.cable.peer && !x.peers.length && x.key && x.key === devKey(p.name));
    if (!g) { g = { key: devKey(p.name), name: p.name, cable: null, peers: [] }; groups.push(g); }
    g.peers.push(p);
  }
  for (const g of groups) {
    const p = g.peers[0] ?? null;
    const w = p?.ways ?? { cable: null, wifi: null, relay: null };
    g.ways = w;
    g.cablePeer = w.cable ? p : null;
    g.cableOn = !!g.cable && g.cable.state === 'device';
    g.wifiOn = !!w.wifi?.ok;
    g.relayOn = !!w.relay?.ok;
    g.active = g.cableOn || g.wifiOn || g.relayOn;
    g.via = g.cableOn ? 'cable' : g.wifiOn || g.relayOn ? 'wifi' : g.cable || w.cable ? 'cable' : 'wifi';
    const inUse = g.peers.find((x) => (x.routes ?? [x.id]).some((id) => roles.has(id)));
    g.role = inUse ? roles.get((inUse.routes ?? [inUse.id]).find((id) => roles.has(id))) : null;
    if (p) g.name = p.name;
  }
  return groups.sort((a, b) => Number(!!b.role) - Number(!!a.role) || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

// rename (6.11.2026): the name becomes a field; enter keeps it, escape leaves it
let renaming = null;
function startRename(g, who, nameEl) {
  renaming = g.peers.map((p) => p.id).join(',');
  const f = el('input', 'rename');
  f.id = `rename-${renaming.replace(/[^a-z0-9]/gi, '')}`;
  f.value = g.name;
  f.maxLength = 40;
  f.setAttribute('aria-label', `new name for ${g.name}`);
  nameEl.replaceWith(f);
  f.focus();
  f.select();
  let done = false;
  const finish = async (keep) => {
    if (done) return;
    done = true;
    const v = f.value.trim();
    if (keep && v && v !== g.name) {
      for (const p of g.peers) await postJson('peers/rename', { id: p.id, name: v }).catch((e) => toast(e.message));
      feed('connections', `${g.name} is called ${v} now`);
    }
    renaming = null;
    refreshPeers(false);
    refreshCable();
  };
  f.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  f.addEventListener('blur', () => finish(true));
}

function renderDevices() {
  const box = $('dev-list');
  if (!box) return;
  if (renaming) return; // a name is being typed: the list waits
  const groups = deviceGroups();
  $('dev-count').textContent = groups.length ? String(groups.length) : '';
  const rows = [];
  for (const g of groups) {
    const row = el('div', `dev ${g.via}${g.active ? ' on' : ' off'}`);
    const mark = svg(VIA_ICON[g.via]);
    mark.classList.add('dev-mark');
    const who = el('div', 'who');
    const name = el('b', '', g.name);
    if (g.role) name.appendChild(el('small', 'active-tag', 'active'));
    who.appendChild(name);
    if (g.role) who.appendChild(el('span', 'role', g.role));
    // its ways side by side, lit when they work now
    const w = g.ways;
    const badges = el('i', 'ways');
    if (g.cable || w.cable) badges.appendChild(el('i', `way cable${g.cableOn ? ' on' : ''}`, 'cable'));
    if (w.wifi) badges.appendChild(el('i', `way wifi${g.wifiOn ? ' on' : ''}`, 'wi-fi'));
    if (w.relay) badges.appendChild(el('i', `way relay${g.relayOn ? ' on' : ''}`, 'relay'));
    if (badges.childNodes.length) name.appendChild(badges);
    const lines = [];
    const fresh = g.peers[0]?.heardAt && Date.now() - g.peers[0].heardAt < 60000;
    if (g.cable || w.cable) {
      const st = g.cable ? (STATE_WORDS[g.cable.state] || g.cable.state) : 'unplugged';
      const reach = w.cable?.ok ? ` · reachable${w.cable.ms ? ` (${w.cable.ms} ms)` : ''}` : '';
      const paired = w.cable ? '' : g.cable?.installed === false ? ' · kula is not installed' : ' · not paired yet';
      lines.push(`cable · ${st}${reach}${paired}`);
    }
    if (w.wifi) lines.push(`wi-fi · ${w.wifi.where} · ${w.wifi.ok ? `ready${w.wifi.ms ? ` (${w.wifi.ms} ms)` : ''}` : w.wifi.ok === false ? (fresh ? 'heard here, not answering' : 'not reachable') : fresh ? 'heard on this wi-fi' : 'not checked'}`);
    if (w.relay) lines.push(`relay · ${w.relay.where} · ${w.relay.ok ? 'reachable' : w.relay.ok === false ? 'not reachable' : 'not checked'}`);
    if ([g.cableOn, g.wifiOn, g.relayOn].filter(Boolean).length > 1) lines.push(`talks over ${g.via === 'cable' ? 'the cable' : 'wi-fi'} now`);
    const p0 = g.peers[0];
    const extra = [];
    if (p0?.ram) extra.push(`${(p0.ram / 1024).toFixed(1)} GB free`);
    if (g.peers.find((p) => p.holds)) extra.push(`holds ${g.peers.find((p) => p.holds).holds}`);
    if (g.peers.some((p) => p.waitingPair)) extra.push('pairs on first contact');
    if (extra.length) lines.push(extra.join(' · '));
    for (const t of lines) who.appendChild(el('span', '', t));
    const tools = el('div', 'dev-tools');
    let cr = null;
    if (g.peers.length) {
      const pen = el('button', 'icon pen');
      pen.type = 'button';
      pen.title = 'rename';
      pen.setAttribute('aria-label', `rename ${g.name}`);
      pen.appendChild(svg(['M12.5 4.5l3 3L8 15H5v-3z', 'M11 6l3 3']));
      pen.addEventListener('click', () => startRename(g, who, name));
      tools.appendChild(pen);
    }
    if (g.cable) {
      cr = cableRow(g.cable.serial);
      cr.use.textContent = cr.use.textContent === 'working…' ? 'working…' : g.cablePeer ? 'use again' : 'use';
      tools.appendChild(cr.use);
    }
    // two directions, two buttons (10.11.2026): "forget" = this computer stops using the
    // device (its peer book); "remove its access" = the device may no longer use this computer
    // (this computer's own gate, kula-node share). The second shows only when it applies.
    const usesMe = g.peers.some((p) => p.usesThisComputer);
    if (usesMe) {
      who.appendChild(el('span', '', 'can use this computer too (kula-node share)'));
      const cut = el('button', 'pill unpair', 'remove its access');
      cut.type = 'button';
      cut.setAttribute('aria-label', `remove ${g.name}'s access to this computer`);
      cut.title = `${g.name} can no longer use this computer`;
      cut.addEventListener('click', async () => {
        if (!confirm(`remove ${g.name}'s access to this computer?\n\nit can no longer use this computer: a running kula-node share refuses it and closes what it has open. this computer can still use ${g.name} (that is "forget"). to let it back in, pair it again with a new code.`)) return;
        const id = g.peers.find((p) => p.usesThisComputer).id;
        try { await postJson('peers/unpair', { id }); toast(`${g.name} can no longer use this computer`); } catch (err) { toast(err.message); }
        refreshPeers(false);
      });
      tools.appendChild(cut);
    }
    if (g.peers.length) {
      const x = el('button', 'icon x');
      x.type = 'button';
      x.setAttribute('aria-label', `forget ${g.name}`);
      x.title = 'forget: this computer stops using it';
      x.appendChild(svg(ICON.x));
      x.addEventListener('click', async () => {
        const both = [w.cable && 'cable', w.wifi && 'wi-fi', w.relay && 'relay'].filter(Boolean);
        // forgetting here takes nothing away on the phone: it still knows this computer's
        // certificate until it is removed there (share this phone › devices that can use this phone)
        const still = g.peers.some((p) => p.tls) ? `\n\n${g.name} still lets this computer in until you remove this computer there: on ${g.name}, kula › share this phone › devices that can use this phone › remove.` : '';
        if (!confirm(`forget ${g.name}? this computer stops using it.${both.length > 1 ? ` every way (${both.join(' and ')}) is forgotten.` : ''} you would pair it again to use it.${still}`)) return;
        for (const p of g.peers) await postJson('peers/remove', { id: p.id }).catch((err) => toast(err.message));
        const gone = new Set(g.peers.flatMap((p) => p.routes ?? [p.id]));
        settings.peers = settings.peers.filter((id) => !gone.has(id));
        saveSettings();
        refreshPeers(false);
      });
      tools.appendChild(x);
    }
    row.append(mark, el('span', `dot ${g.active ? 'ok' : 'no'}`), who, tools);
    if (cr) row.append(cr.steps, cr.code);
    rows.push(row);
  }
  box.replaceChildren(...rows);
  if (!rows.length) { box.appendChild(el('p', 'none', 'no device yet. plug a phone in, or add one below.')); $('add').open = true; }
  renderNearby();
}

// ---------- nearby (8.11.2026): while the page is open this computer listens on mdns by itself
// (every 12 s). Paired phones show ready the moment they answer, with no click; kula phones on
// this wi-fi that are not paired show here with a pair button: it shows this computer's qr.
let NEAR = { at: null, list: [], pair: null };
const NEAR_WORDS = { code: 'nearby, a code open, not paired', knows: 'nearby, knows this computer, not in the list', new: 'nearby, not paired', silent: 'nearby, not answering' };
function renderNearby() {
  const box = $('near-list');
  if (!box) return;
  const list = (NEAR.list || []).filter((r) => !r.peer && r.state !== 'paired' && r.state !== 'ready');
  box.hidden = !list.length;
  const rows = list.map((r) => {
    const row = el('div', 'near');
    const who = el('div', 'who');
    who.append(el('b', '', r.name), el('span', '', `${r.host}:${r.port} · ${NEAR_WORDS[r.state] || 'nearby'}`));
    const b = el('button', 'pill', 'pair');
    b.type = 'button';
    b.addEventListener('click', () => { $('add').open = true; showTab('host'); addMsg(`on ${r.name}: open kula → scan a computer, and point it at this code.`); });
    row.append(el('span', 'dot no'), who, b);
    return row;
  });
  box.replaceChildren(...(rows.length ? [el('h4', '', 'nearby, not paired'), ...rows] : []));
}

let nearBusy = false;
async function refreshNearby() {
  if (isGuest() || nearBusy) return;
  nearBusy = true;
  try {
    const v = await getJson('nearby');
    const was = NEAR;
    NEAR = v;
    if (v.at && v.at !== was.at) {
      const before = new Map((was.list || []).map((r) => [`${r.host}:${r.port}`, r.state]));
      for (const r of v.list) {
        const old = before.get(`${r.host}:${r.port}`);
        if (r.state === 'ready' && old !== 'ready') feed('senses', `${r.name} is ready over wi-fi (${r.host})`);
        else if (!r.peer && !old && r.state !== 'silent') feed('connections', `${r.name} is on this wi-fi, not paired`);
      }
      await refreshPeers(false);
    }
    if (v.pair) renderHostPair(v.pair);
  } catch {} finally { nearBusy = false; }
  renderNearby();
}
setInterval(() => { if (!document.hidden) refreshNearby(); }, 5000);
refreshNearby();

// ---------- connect: a refresh (6.11.2026): asks again for the status, probes every device,
// reads the cable list. Each device row says how it is reached (viaTag).

function viaTag(p) {
  if (p.cable) return el('small', `via cable${p.cable.plugged === false ? ' off' : ''}`, p.cable.plugged === false ? 'cable · unplugged' : 'cable');
  if (p.far) return el('small', 'via', 'relay');
  return el('small', 'via', 'wi-fi');
}

async function refreshAll() {
  const b = $('connect-refresh');
  if (b.classList.contains('spin')) return;
  b.classList.add('spin');
  b.querySelector('span').textContent = 'looking…';
  try {
    await Promise.all([refreshStatus(), refreshPeers(true), refreshCable()]);
  } finally {
    b.classList.remove('spin');
    b.querySelector('span').textContent = 'refresh';
    if (!$('wiz').hidden) renderWiz();
  }
}
$('connect-refresh').addEventListener('click', refreshAll);
function openDevices() { const d = $('devices'); if (d.open) return d.close(); d.showModal(); renderPeers(); renderCable(); refreshAll(); refreshNearby(); if ($('add').open && document.querySelector('.tab[aria-selected="true"]')?.dataset.tab === 'host') showHostPair(); }
$('open-devices').addEventListener('click', openDevices);
$('devices').addEventListener('click', (e) => { if (e.target === $('devices')) $('devices').close(); }); // a click on the backdrop
$('devices').addEventListener('close', () => stopScan());
refreshPeers(false); // the count on the devices button from the start
loadProjects();


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
  if (plugged !== cablePlugged) {
    const old = new Map((cablePlugged || '').split(',').filter(Boolean).map((x) => x.split(':')));
    const now = new Map((S.cable.devices || []).map((d) => [d.serial, d]));
    for (const [serial, d] of now) if (old.get(serial) !== d.state) feed('connections', d.state === 'device' ? `${d.name} is on a usb cable, ready` : `${d.name} on the cable: ${STATE_WORDS[d.state] || d.state}`);
    for (const [serial] of old) if (!now.has(serial) && cablePlugged !== null) feed('connections', `a cable was pulled (${serial.slice(0, 6)}…)`);
    cablePlugged = plugged; if (S.peers.some((p) => p.cable)) refreshPeers(false); }
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
  const box = null;
  const help = $('cable-help');
  if (!c) return;
  if (!c.adb) {
    cableRows.clear();
    help.textContent = `adb is not on this computer, so phones on a cable cannot be seen. ${c.help || ''}`;
    renderDevices();
    return;
  }
  const list = c.devices || [];
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
  void box; void rows;
  renderDevices();
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
setInterval(() => { if (!document.hidden && ($('devices').open || ($('connect').open && (!$('advanced').hidden || WIZ_CABLE.has(W.step))))) refreshCable(); }, 1500);

// ---------- connect: add a device

let scan = null; // the camera while it looks for a qr (BarcodeDetector needs a secure context: 127.0.0.1 is one)
function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const b of document.querySelectorAll('.tab-body')) b.hidden = b.dataset.body !== name;
  if (name !== 'scan') stopScan();
  if (name === 'host') { if ($('devices').open && $('add').open) showHostPair(); } else hideHostPair();
}
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
const canScan = 'BarcodeDetector' in window;
$('tab-scan').hidden = !canScan;

// ---------- add a device → same wi-fi (8.11.2026): the phone scans this computer. The qr holds
// this computer's certificate and a one-time code for ten minutes (kula-host v1); the phone sets
// that code on its gate and starts sharing, this computer hears it on mdns and pairs with the
// code by itself. Nothing is typed. A new qr makes a new code; closing the bubble drops it.
let hostShown = false;
let hostExp = null;
let hostPairedSeen = null;
async function showHostPair(fresh = false) {
  hostShown = true;
  try {
    let v = await getJson('hostpair');
    if (fresh || !v.open) v = await postJson('hostpair/new');
    renderHostPair(v);
  } catch (e) { $('host-line').textContent = e.message; }
}
function hideHostPair() {
  if (!hostShown) return;
  hostShown = false;
  hostExp = null;
  postJson('hostpair/close').catch(() => {});
}
function renderHostPair(v) {
  if (!hostShown || !v) return;
  const img = $('host-qr');
  if (v.paired && v.paired.id !== hostPairedSeen) {
    hostPairedSeen = v.paired.id;
    addMsg(`paired with ${v.paired.name} over wi-fi: it scanned this computer.`, 'ok');
    feed('connections', `paired with ${v.paired.name} (wi-fi, it scanned this computer's qr)`);
    if (settings.mode === 'phone' || !settings.peers.length) settings.peers = [v.paired.id];
    else if (!settings.peers.includes(v.paired.id)) settings.peers.push(v.paired.id);
    saveSettings();
    refreshPeers(false);
  }
  if (v.open) {
    if (hostExp !== v.exp) { hostExp = v.exp; img.src = `${apiUrl('hostpair.svg')}?t=${encodeURIComponent(String(v.exp))}`; }
    img.hidden = false;
    const min = Math.max(1, Math.ceil(v.left / 60000));
    $('host-line').textContent = `${v.name} · certificate ${v.fp.match(/.{4}/g).join(' ')} · works once, ${min} more minute${min === 1 ? '' : 's'}`;
  } else {
    img.hidden = true;
    hostExp = null;
    $('host-line').textContent = v.paired ? `${v.paired.name} paired with it. a new code for the next phone:` : v.expired ? 'this code ran out: make a new one.' : '';
  }
  $('host-new').hidden = v.open;
}
$('host-new').addEventListener('click', () => showHostPair(true));
$('host-pair').addEventListener('click', async () => {
  const address = $('host-address').value.trim();
  if (!address) return $('host-address').focus();
  addMsg('pairing with the code of this qr…');
  try { const row = await postJson('nearby/pair', { address }); hostPairedSeen = row.id; $('host-address').value = ''; await added(row); } catch (e) { addMsg(e.message, 'bad'); }
});
setInterval(() => { if (hostShown && !document.hidden && $('devices').open && $('add').open) getJson('hostpair').then(renderHostPair).catch(() => {}); }, 2000);
$('add').addEventListener('toggle', () => { if ($('add').open && $('devices').open) showTab(document.querySelector('.tab[aria-selected="true"]')?.dataset.tab || 'host'); else hideHostPair(); });
$('devices').addEventListener('close', () => hideHostPair());
showTab('host');

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
    if (m.vision) fit.appendChild(el('span', 'info', 'sees photos'));
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
    pickAt = { maker: null, series: null };
    if (!S.models.length) getJson('models').then((m) => { S.models = m; renderWiz(true); }).catch(() => {});
    getJson('lineup').then((l) => { S.lineup = l; renderWiz(true); }).catch(() => {});
    if (Date.now() - wizModelsProbed > 20000) {
      wizModelsProbed = Date.now();
      postJson('peers/probe').then((list) => { if (run !== wizRun) return; S.peers = list; renderPeers(); renderWiz(true); }).catch(() => {});
    }
  }
  if (W.step === 'pick') {
    // readiness is checked again every time: the ticks follow what answers now
    wizPick = null; wizPickTouched = false; wizPickChecking = true; renderWiz(true);
    if (!S.lineup) getJson('lineup').then((l) => { S.lineup = l; if (W.step === 'pick') renderWiz(true); }).catch(() => {});
    postJson('peers/probe').then((list) => { if (run !== wizRun) return; S.peers = list; wizModelsProbed = Date.now(); renderPeers(); })
      .catch(() => {})
      .finally(() => { if (run !== wizRun || W.step !== 'pick') return; wizPickChecking = false; if (!wizPickTouched) wizPick = null; renderWiz(true); });
  }
  if (W.step === 'load') wizLoad(run);
  if (W.step === 'done') setTimeout(() => { if ($('connect').open) $('connect').close(); input.focus(); }, 700);
}

let wizPick = null;            // the devices step's ticked rows (ids), null: not drawn yet
let wizPickTouched = false;    // the user ticked or unticked something: a late probe keeps their ticks
let wizPickChecking = false;   // the step's probe is out
let pickAt = { maker: null, series: null };   // where the model step's picker is

// What the devices could hold together: this computer's memory × 0.7 and every paired device's
// advertised free memory × 0.75 (the split planner's shares), MB. `max` counts this computer's
// whole memory (what it could give with other programs closed), `now` what is free right now.
function memoryTogether() {
  const peers = S.peers.reduce((n, p) => n + (p.ram ?? 0) * 0.75, 0);
  return { max: Math.round((S.lineup?.hereTotalMb ?? 0) * 0.7 + peers), now: Math.round((S.lineup?.hereFreeMb ?? 0) * 0.7 + peers) };
}

// The lineup with every model joined to its row in GET models (or its reason), plus the files
// that are only on this computer as their own maker at the end.
function pickTree(phone) {
  const cap = memoryTogether();
  const rows = new Map(wiz.modelRows(S.models, phone).map((m) => [m.id, m]));
  const join = (m) => {
    const r = rows.get(m.id);
    if (m.why || !r) return { ...m, off: m.why ?? 'not offered on this computer' };
    const gbs = (mb) => (mb / 1024).toFixed(1);
    const off = r.needMb > cap.max ? `needs about ${gbs(r.needMb)} GB; this computer and your devices have about ${gbs(cap.max)} GB together` : null;
    const tight = !off && r.needMb > cap.now ? `more than is free right now (about ${gbs(cap.now)} GB): close other programs or add a device` : null;
    return { ...m, ...r, off, tight };
  };
  const tree = S.lineup.makers.map((k) => ({ ...k, series: k.series.map((x) => ({ ...x, models: x.models.map(join) })) }));
  const local = [...rows.values()].filter((r) => !r.catalog);
  if (local.length) tree.push({ id: 'local', name: 'on this computer', by: 'files in your models folder', blurb: 'only this computer can run these (here or split): phones fetch models from the internet', series: [{ id: 'local', name: 'files on this computer', blurb: 'gguf files found here', models: local.map((r) => ({ ...r, off: null })) }] });
  return tree;
}

function modelButton(m, phone) {
  const b = el('button', `model${m.off ? ' off' : ''}`);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(settings.model === m.id));
  const size = m.size ? gb(m.size) : '';
  b.append(el('b', '', `${m.name}${m.quant ? ` · ${m.quant}` : ''}`), el('span', 'size', size), el('span', 'blurb', m.catalog === false ? 'a file on this computer: only this computer can run it (here or split)' : m.blurb));
  const fit = el('span', 'fit');
  // a mixture of experts (10.11.2026): all of it in memory, only the active part read per token
  if (m.active_b) fit.appendChild(el('span', 'info', `MoE · ${m.active_b}B active${m.params_b ? ` of ${m.params_b}B` : ''}`));
  if (m.vision) fit.appendChild(el('span', 'info', 'sees photos'));
  if (m.off) fit.appendChild(el('span', 'no', m.off));
  else {
    if (m.onPhone) fit.appendChild(el('span', 'yes', `on ${phone.name} now`));
    if (m.fit) fit.appendChild(el('span', m.fit[0], m.fit[1]));
    if (m.here) fit.appendChild(el('span', 'info', 'on this computer'));
    if (m.tight) fit.appendChild(el('span', 'tight', m.tight));
  }
  if (fit.children.length) b.appendChild(fit);
  if (m.off) b.disabled = true;
  // for a photo (W.vision) it runs on this computer: only there does the model get the photo itself
  else if (W.vision) b.addEventListener('click', () => { settings.model = m.id; settings.mode = 'here'; saveSettings(); W = wiz.next(W, { type: 'model', id: m.id }); go({ type: 'mode', mode: 'here' }); });
  else b.addEventListener('click', () => { settings.model = m.id; saveSettings(); go({ type: 'model', id: m.id }); });
  return b;
}
// The "+" for a photo (10.11.2026): only the models that see photos, flat, each judged for this
// computer alone (it runs here, the one place the photo goes straight to the model). None that
// can run is said plainly; closing the sheet keeps the photo in the message box.
function visionModelsView(phone, loadedNote) {
  const out = [q('which model should see the photo?')];
  const note = loadedNote();
  if (note) out.push(note);
  const close = (text) => btn(text, 'ghost', () => $('connect').close());
  if (!S.status?.llama) {
    out.push(errLine('no model can see photos here yet: it would run on this computer, and this computer has no llama.cpp. run kula-node setup, then try again.'), para('the photo stays in the message box.', 'hint'), row(close('close')));
    return out;
  }
  const gbs = (mb) => (mb / 1024).toFixed(1);
  const max = Math.round((S.lineup?.hereTotalMb ?? 0) * 0.7), free = Math.round((S.lineup?.hereFreeMb ?? 0) * 0.7);
  const seen = new Set();
  const list = pickTree(phone).flatMap((k) => k.series.flatMap((x) => x.models))
    .filter((m) => m.vision && !seen.has(m.id) && seen.add(m.id))
    .map((m) => {
      const off = m.off ?? (max && m.needMb > max ? `needs about ${gbs(m.needMb)} GB; this computer has about ${gbs(max)} GB for a model` : null);
      const tight = !off && free && m.needMb > free ? `more than is free right now (about ${gbs(free)} GB): close other programs` : null;
      return { ...m, off, tight, onPhone: false, fit: m.here || !m.size ? null : ['info', `downloads here first (${gb(m.size)})`] };
    });
  if (!list.some((m) => !m.off)) {
    out.push(errLine(list.length ? 'no model that sees photos fits on this computer right now.' : 'no model that sees photos is offered on this computer.'));
    if (list.length) { const box = el('div', 'model-list wiz-models'); for (const m of list) box.appendChild(modelButton(m, phone)); out.push(box); }
    out.push(para('the photo stays in the message box.', 'hint'), row(close('close')));
    return out;
  }
  out.push(para('only models that see photos are listed. it runs on this computer, so the photo goes straight to it.', 'hint'));
  const box = el('div', 'model-list wiz-models');
  for (const m of list) box.appendChild(modelButton(m, phone));
  out.push(box, row(close('not now')));
  return out;
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
      row(btn('next: pick a model', 'primary big', () => go({ type: 'continue' })), btn('+ add one more', 'pill big', () => go({ type: 'another' })))];
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

  // which model: the makers, then a maker's series, then the models (8.11.2026). A model that
  // cannot run is dimmed with its reason: one in several files, an architecture llama.cpp does
  // not know yet, or more memory than this computer and the paired devices have together.
  model: () => {
    const phone = phoneNow();
    const out = [];
    const l = S.status?.loaded;
    const loadedNote = () => {
      if (!l) return null;
      const n = el('p', 'hint');
      n.append(`${l.model.name} is loaded on ${l.devices.map((d) => d.name).join(', ')}. `);
      n.appendChild(btn('unload', 'link', async () => { await postJson('unload').catch((e) => toast(e.message)); await refreshStatus(); renderWiz(true); }));
      return n;
    };
    if (!S.models.length || !S.lineup) { out.push(q('which model?'), waiting('getting the list…')); return out; }
    if (W.vision) return visionModelsView(phone, loadedNote);
    const tree = pickTree(phone);
    const goTo = (maker, series) => { pickAt = { maker, series }; renderWiz(true); $('wiz-q')?.focus(); };
    const maker = tree.find((k) => k.id === pickAt.maker) ?? null;
    const series = maker?.series.find((x) => x.id === pickAt.series) ?? null;
    const count = (list) => { const n = list.length, k = list.filter((m) => !m.off).length; return `${n} model${n === 1 ? '' : 's'} · ${k ? `${k} can run` : 'none can run yet'}`; };
    const mark = (list) => (list.some((m) => m.id === l?.model?.id) ? 'loaded' : list.some((m) => m.id === settings.model) ? 'last used' : null);
    const card = (title, sub, onClick, tag, off) => { const c = choice(title, sub, onClick, tag); if (off) c.classList.add('off'); return c; };

    if (!maker) {
      out.push(q('which model?'));
      const note = loadedNote();
      if (note) out.push(note);
      const box = el('div', 'choices pick-list');
      const held = phone?.holds ? S.models.find((m) => m.file === phone.holds) : null;
      if (held) box.appendChild(card(held.name, `already on ${phone.name}: no download`, () => { settings.model = held.id; saveSettings(); go({ type: 'model', id: held.id }); }, 'on the phone'));
      for (const k of tree) {
        const all = k.series.flatMap((x) => x.models);
        box.appendChild(card(k.name, `${k.by} · ${count(all)}`, () => goTo(k.id, k.series.length === 1 ? k.series[0].id : null), mark(all), all.every((m) => m.off)));
      }
      out.push(para('pick a maker, then a series, then the model.', 'hint'), box);
      return out;
    }
    const back = (text, onClick) => btn(text, 'link pick-back', onClick);
    if (!series) {
      out.push(back('‹ all makers', () => goTo(null, null)), q(maker.name), para(maker.blurb, 'hint'));
      const box = el('div', 'choices pick-list');
      for (const x of maker.series) box.appendChild(card(x.name, `${x.blurb} · ${count(x.models)}`, () => goTo(maker.id, x.id), mark(x.models), x.models.every((m) => m.off)));
      out.push(box);
      return out;
    }
    out.push(back(maker.series.length === 1 ? '‹ all makers' : `‹ ${maker.name}`, () => goTo(maker.series.length === 1 ? null : maker.id, null)), q(series.name), para(series.blurb, 'hint'));
    const box = el('div', 'model-list wiz-models');
    for (const m of series.models) box.appendChild(modelButton(m, phone));
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

  // which devices (8.11.2026): every mode but "this computer". This computer plus each device
  // once (a phone on a cable and on the wi-fi is one row), each with its state, how it is
  // reached, its free memory and whether the model fits. The ready ones come ticked.
  pick: () => {
    const mode = W.mode;
    const model = S.models.find((m) => m.id === W.model) ?? null;
    const rows = pickRowsNow();
    if (!wizPick) wizPick = wiz.preselect(mode, rows, model, settings.pick?.[mode] ?? {}, [W.peerId].filter(Boolean));
    // a device whose answering route changed (cable ↔ wi-fi) keeps its tick
    wizPick = [...new Set(wizPick.map((id) => rows.find((r) => r.ids.includes(id))?.id).filter(Boolean))];
    const Q = { phone: 'which device runs it?', apart: 'which devices answer?', split: 'which devices hold a part?' };
    const P = {
      phone: 'one device runs the whole model; this computer only carries the words.',
      apart: 'every ticked device runs its own copy; each prompt goes to the fastest free one.',
      split: 'this computer always keeps the first and the last layers. every ticked device takes some of the rest.',
    };
    const out = [q(Q[mode] ?? 'which devices?')];
    if (model) out.push(para(model.name, 'wiz-name'));
    out.push(para(P[mode] ?? ''));
    if (wizPickChecking) out.push(waiting('checking which devices answer…'));
    const box = el('div', 'pick-list');
    box.setAttribute('role', mode === 'phone' ? 'radiogroup' : 'group');
    box.setAttribute('aria-label', Q[mode] ?? 'devices');
    for (const r of rows) box.appendChild(pickRow(mode, model, r));
    if (!rows.length) box.appendChild(para('no device paired yet: add one from the devices bubble.', 'none'));
    out.push(box);
    const check = wiz.pickCheck({ mode, model, rows, picked: wizPick, hereFreeMb: S.lineup?.hereFreeMb ?? null });
    if (check.warn.length) {
      const w = el('ul', 'wiz-warn');
      w.setAttribute('role', 'status');
      for (const t of check.warn) w.appendChild(el('li', '', t));
      out.push(w);
    }
    const go1 = btn(wiz.pickGo(mode, wizPick), 'primary big', () => {
      settings.pick = { ...settings.pick, [mode]: wiz.remember(mode, rows, wizPick) };
      saveSettings();
      go({ type: 'picked', ids: [...wizPick] });
    });
    go1.disabled = !check.ok;
    out.push(row(go1));
    if (check.block) out.push(para(check.block, 'hint'));
    else if (mode === 'split' && wizPick.length > 2) out.push(para('more devices = more room for a big model; for a small one every extra hop makes each word a little slower.', 'hint'));
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

  done: () => [q('ready ✓'), para(W.vision ? `${S.models.find((m) => m.id === W.model)?.name ?? 'the model'} sees photos: ask about yours and send.` : 'the composer is yours.')],
};

const STATE_TAG = { ready: 'ready', off: 'not answering', busy: 'busy', unknown: 'not checked' };
function pickRowsNow() {
  const model = S.models.find((m) => m.id === W.model) ?? null;
  return wiz.pickRows({ mode: W.mode, peers: S.peers, model, llama: !!S.status?.llama, freeMb: S.lineup?.hereFreeMb ?? null });
}
function pickRow(mode, model, r) {
  const on = wizPick.includes(r.id);
  const l = el('label', `pick${on ? ' on' : ''}${r.fixed ? ' fixed' : ''}${r.blocked || (r.local && r.state !== 'ready') ? ' off' : ''}`);
  const c = el('input');
  c.type = mode === 'phone' ? 'radio' : 'checkbox';
  if (mode === 'phone') c.name = 'wiz-pick-one';
  c.checked = on;
  c.disabled = !!(r.fixed || r.blocked);
  c.addEventListener('change', () => { wizPick = wiz.toggle(mode, wizPick, r); wizPickTouched = true; renderWiz(true); });
  const tags = el('span', 'tags');
  for (const v of r.via) tags.appendChild(el('small', `via${v === 'cable' ? ' cable' : ''}`, v));
  tags.appendChild(el('small', `state ${r.state}`, r.fixed ? 'always' : r.local && r.state !== 'ready' ? 'cannot join' : STATE_TAG[r.state] ?? r.state));
  const sub = [];
  if (r.state === 'ready' && r.ms) sub.push(`answers in ${r.ms} ms`);
  if (r.state !== 'ready' && r.reason) sub.push(r.reason);
  if (r.ram) sub.push(`${(r.ram / 1024).toFixed(1)} GB free`);
  else if (!r.local) sub.push('free memory not told yet');
  if (r.holds) sub.push(`has ${r.holds} loaded`);
  const fit = wiz.fitOf(mode, model, r);
  const s = el('span', 'sub');
  s.append(sub.join(' · '));
  if (fit) { s.append(sub.length ? ' · ' : ''); s.appendChild(el('span', `fitw ${fit[0]}`, fit[0] === 'yes' ? 'the model fits' : fit[0] === 'tight' ? 'the model fits, tight' : 'the model is too big for it')); }
  l.append(c, el('b', '', r.name), tags, s);
  return l;
}

function wizSignature() {
  const c = WIZ_CABLE.has(W.step) ? wiz.cableState(S.cable, W.serial, W.used) : null;
  return JSON.stringify([W.step, W.error, W.found, wizPairing, settings.way,
    c && [c.step, c.problem, c.error, c.busy, W.step === 'cable-code' ? null : c.lines, c.name],
    W.step === 'wifi-list' ? found : null,
    W.step === 'connected' ? S.peers.find((x) => x.id === W.peerId)?.name : null,
    W.step === 'pick' ? [wizPick, wizPickChecking] : null,
    W.step === 'model' || W.step === 'mode' || W.step === 'pick' ? [S.models.length, S.peers.map((x) => [x.id, x.reach?.ok, x.holds, x.ram]), settings.model, S.status?.loaded?.model?.id, !!S.status?.llama, !!S.lineup, pickAt] : null]);
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
  const first = W.chat ? 3 : 0; // start a chat: model · mode · devices · load
  const stage = Math.max(0, wiz.stageOf(W.step) - first);
  const names = wiz.STAGES.slice(first);
  const dots = $('wiz-dots');
  dots.replaceChildren(...names.map((name, i) => { const li = el('li', i < stage ? 'past' : i === stage ? 'now' : ''); if (i === stage) li.setAttribute('aria-current', 'step'); return li; }));
  dots.setAttribute('aria-label', `step ${stage + 1} of ${names.length}`);
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
  // exactly the ticked devices (the devices step); without one, the old guess
  const picked = wiz.PICK_MODES.has(mode) && W.picked?.length ? W.picked : null;
  const body = { model: W.model ?? settings.model, mode, ctx: settings.ctx, ...(picked ? wiz.pickBody(mode, picked) : { peers: wiz.loadPeers(mode, phoneNow(), S.peers) }) };
  if (mode !== 'here' && body.peers.length) { settings.peers = body.peers; saveSettings(); }
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
// vision: opened by the "+" for a photo, so only models that see photos are offered, run here
async function openConnect(auto, vision) {
  if (isGuest()) return;
  auto = auto === true;
  vision = vision === true;
  const run = ++wizRun;
  W = wiz.initial(settings.way);
  wizStepShown = '';
  found = { list: null, looking: false, error: null };
  wizPairing = false;
  wizModelsProbed = 0;
  getJson('models').then((m) => { S.models = m; if (run === wizRun) renderWiz(); }).catch(() => {});
  let peers = S.peers;
  try { peers = S.peers = await getJson('peers'); } catch {}
  // start a chat (6.11.2026): devices are added in the devices bubble, so this sheet begins at
  // the model (or the load running); the cable and wi-fi steps are reached from "add a device"
  let start = S.status?.loading ? 'load' : 'model';
  W = { ...W, chat: true, vision };
  $('connect-title').textContent = vision ? 'a model that sees photos' : 'start a chat';
  $('wiz-advanced').parentElement.hidden = vision;
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
    start = S.status?.loading ? 'load' : 'model';
  }
  show(start);
  enterStep();
}

$('connect').addEventListener('close', () => { stopScan(); input.focus(); });

// ---------- settings (8.11.2026: sections on the left, like the big chat apps; only what kula
// really does). general, personalisation and model are this browser's (localStorage); usage,
// devices, data controls and developer are the owner's and come from the server.

let tokenVisible = false;
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
function curlSnippet(tokenShown) {
  const i = S.info?.openai;
  if (!i) return '';
  return `curl ${i.base}/chat/completions \\
  -H "authorization: Bearer ${tokenShown}" \\
  -H "content-type: application/json" \\
  -d '{"model":"kula","messages":[{"role":"user","content":"hello"}]}'`;
}
function renderOpenAi() {
  const i = S.info?.openai;
  if (!i) return;
  $('oa-base').textContent = i.base;
  const masked = `${i.token.slice(0, 5)}${'•'.repeat(12)}${i.token.slice(-4)}`;
  $('oa-token').textContent = tokenVisible ? i.token : masked;
  $('oa-show').textContent = tokenVisible ? 'hide' : 'show';
  $('oa-snippet').textContent = snippet(tokenVisible ? i.token : masked);
  $('oa-curl').textContent = curlSnippet(tokenVisible ? i.token : masked);
}
$('oa-show').addEventListener('click', () => { tokenVisible = !tokenVisible; renderOpenAi(); });
for (const b of document.querySelectorAll('[data-copy-from]')) b.addEventListener('click', () => {
  const which = b.dataset.copyFrom;
  const i = S.info?.openai;
  if (!i) return;
  copyText(which === 'oa-token' ? i.token : which === 'oa-snippet' ? snippet(i.token) : which === 'oa-curl' ? curlSnippet(i.token) : i.base);
});

// a segmented control: buttons with data-v, one checked
function segSet(id, v) { for (const b of document.querySelectorAll(`#${id} button`)) b.setAttribute('aria-checked', String((b.dataset.v ?? b.dataset.theme) === v)); }
function segOn(id, fn) {
  for (const b of document.querySelectorAll(`#${id} button`)) b.addEventListener('click', () => { fn(b.dataset.v ?? b.dataset.theme); segSet(id, b.dataset.v ?? b.dataset.theme); });
}

let setSec = 'general';
function showSec(sec) {
  const btn = document.querySelector(`#set-nav [data-sec="${sec}"]`);
  if (!btn || getComputedStyle(btn).display === 'none') sec = 'general';
  setSec = sec;
  for (const b of document.querySelectorAll('#set-nav button')) { b.setAttribute('aria-selected', String(b.dataset.sec === sec)); b.tabIndex = b.dataset.sec === sec ? 0 : -1; }
  btn?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  for (const p of document.querySelectorAll('.set-pane')) p.hidden = p.dataset.sec !== sec;
  $('set-body').scrollTop = 0;
  if (sec === 'usage') refreshUsage();
  if (sec === 'devices') renderSetDevices();
  if (sec === 'about' || sec === 'developer' || sec === 'data') refreshInfo();
  if (sec === 'model') renderSetModel();
  if (sec === 'personal') $('set-preview').textContent = systemText() || '(nothing: the model gets only the chat)';
}
for (const b of document.querySelectorAll('#set-nav button')) b.addEventListener('click', () => showSec(b.dataset.sec));
$('set-nav').addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll('#set-nav button')].filter((b) => getComputedStyle(b).display !== 'none');
  const i = tabs.findIndex((b) => b.dataset.sec === setSec);
  const next = tabs[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  e.preventDefault();
  showSec(next.dataset.sec);
  next.focus();
});

async function refreshInfo() {
  if (isGuest()) return renderAbout();
  try { S.info = await getJson('settings'); } catch {}
  renderOpenAi();
  renderAbout();
  const n = S.info?.chats;
  $('set-chat-sum').textContent = n == null ? 'every chat as one json file.' : `${n} chat${n === 1 ? '' : 's'} as one json file (guests' chats stay out).`;
}

function renderAbout() {
  const i = S.info;
  const dl = $('set-about-list');
  dl.replaceChildren();
  const add = (list, k, v) => { list.append(el('dt', '', k), el('dd', '', v)); };
  add(dl, 'kula-node', i?.version ? `version ${i.version}` : 'kula-node');
  add(dl, 'llama.cpp', `${i?.llamaTag ?? 'b11157'}${i ? (i.llama ? ', set up on this computer' : ', not set up here yet: kula-node setup (split and here need it)') : ''}`);
  if (i?.node) add(dl, 'node', i.node);
  if (i?.host) add(dl, 'this computer', i.host);
  add(dl, 'privacy', 'chats, notes and counts stay on this computer; the page loads nothing from the internet.');
  const p = $('set-paths');
  p.replaceChildren();
  if (!i?.paths) return;
  const names = { home: 'everything', chats: 'chats', models: 'downloaded models', brain: "the brain's notes", usage: 'usage counts', token: 'the /v1 token' };
  for (const [k, label] of Object.entries(names)) if (i.paths[k]) {
    const dd = el('dd', 'path');
    const c = el('code', '', i.paths[k]);
    const b = el('button', 'link', 'copy');
    b.type = 'button';
    b.addEventListener('click', () => copyText(i.paths[k]));
    dd.append(c, b);
    p.append(el('dt', '', label), dd);
  }
}

// ---- personalisation: one system message from the pieces

const STYLE_TEXT = {
  default: '',
  concise: 'answer briefly: short sentences, no filler, a list only when it helps.',
  detailed: 'answer thoroughly: explain the reasoning step by step and give examples where they help.',
  friendly: 'answer in a warm, friendly, plain-spoken way.',
  formal: 'answer in a formal, precise, professional tone.',
};
function systemText() {
  const parts = [];
  if (settings.system.trim()) parts.push(settings.system.trim());
  if (settings.name.trim()) parts.push(`the user's name is ${settings.name.trim()}.`);
  if (settings.about.trim()) parts.push(`about the user: ${settings.about.trim()}`);
  if (STYLE_TEXT[settings.style]) parts.push(STYLE_TEXT[settings.style]);
  return parts.join('\n\n');
}
const preview = () => { $('set-preview').textContent = systemText() || '(nothing: the model gets only the chat)'; };
$('set-system').addEventListener('input', () => { settings.system = $('set-system').value; saveSettings(); preview(); });
$('set-name').addEventListener('input', () => { settings.name = $('set-name').value; saveSettings(); preview(); });
$('set-about').addEventListener('input', () => { settings.about = $('set-about').value; saveSettings(); preview(); });
segOn('set-style', (v) => { settings.style = v; saveSettings(); preview(); });

// ---- general

segOn('set-theme', (v) => { settings.theme = v; saveSettings(); applyTheme(); });
segOn('set-start', (v) => { settings.start = v; saveSettings(); });
segOn('set-enter', (v) => { settings.enter = v; saveSettings(); composerHint(); });

// ---- model

const MODE_NOTE = {
  phone: 'one phone runs the model; this computer carries the chat.',
  apart: 'every chosen device runs its own copy; a question goes to the fastest free one.',
  split: 'one model spread over this computer and the phones (needs llama.cpp here).',
  here: 'this computer alone (needs llama.cpp here).',
};
function renderSetModel() {
  const sel = $('set-model');
  sel.replaceChildren();
  if (!S.models.length) sel.append(el('option', '', 'no models listed yet'));
  for (const m of S.models) { const o = el('option', '', `${m.name}${m.here ? ' · on this computer' : ''}`); o.value = m.id; sel.append(o); }
  if (settings.model && S.models.some((m) => m.id === settings.model)) sel.value = settings.model;
  segSet('set-mode', settings.mode);
  const llama = !!S.status?.llama;
  for (const b of document.querySelectorAll('#set-mode button')) b.disabled = (b.dataset.v === 'split' || b.dataset.v === 'here') && !llama;
  $('set-mode-note').textContent = (MODE_NOTE[settings.mode] ?? '') + (llama ? '' : ' split and here need llama.cpp on this computer: kula-node setup.');
  const l = S.status?.loaded;
  $('set-loaded').textContent = l ? `loaded now: ${l.model.name} (${MODE_WORD[l.mode] ?? l.mode}, ${l.ctx} tokens of context). a change here is used at the next load.` : 'nothing is loaded now. these are what the next load starts with.';
  $('set-temp').value = String(settings.temperature);
  $('temp-out').textContent = Number(settings.temperature).toFixed(2);
  $('set-max').value = String(settings.maxTokens);
  $('set-ctx').value = String(settings.ctx);
  if (!isGuest()) refreshVision();
}

// ---- model › vision model: the computer's setting (ui-settings.json), not this browser's:
// /v1 and guests use it too. Unset, the smallest vision model on this computer reads photos.
let visionView = null;
async function refreshVision() {
  try { visionView = (await getJson('settings')).vision ?? null; } catch { visionView = null; }
  renderVision();
}
function renderVision() {
  const sel = $('set-vision');
  const v = visionView;
  sel.replaceChildren();
  if (!v) { sel.append(el('option', '', 'not known yet')); sel.disabled = true; return; }
  sel.disabled = false;
  const auto = el('option', '', 'the smallest on this computer');
  auto.value = '';
  sel.append(auto);
  for (const m of v.list) {
    const o = el('option', '', `${m.name} · ${gb(m.size)} · ${m.here ? 'on this computer' : 'not here yet'}`);
    o.value = m.id;
    sel.append(o);
  }
  sel.value = v.setting && v.list.some((m) => m.id === v.setting) ? v.setting : '';
  const want = v.list.find((m) => m.id === sel.value) ?? null;
  const chosen = v.list.find((m) => m.id === v.chosen) ?? null;
  const fetch = $('set-vision-fetch');
  fetch.hidden = !want || want.here;
  if (want && !want.here) fetch.textContent = `fetch ${want.name} (${gb(want.size)})`;
  $('set-vision-note').textContent = !v.llama
    ? 'reading photos needs llama.cpp on this computer: kula-node setup.'
    : chosen
      ? `${chosen.name} reads photos${want && !want.here ? ' until the one picked is fetched' : ''}. a model that sees photos itself, loaded here, gets them straight.`
      : 'no model on this computer sees photos yet: pick one and fetch it, or load one from the model list ("sees photos").';
}
$('set-vision').addEventListener('change', async () => {
  try { visionView = await postJson('settings/vision', { id: $('set-vision').value || null }); } catch (e) { toast(e.message); }
  renderVision();
});
$('set-vision-fetch').addEventListener('click', async () => {
  const id = $('set-vision').value;
  const b = $('set-vision-fetch');
  const out = $('set-vision-progress');
  b.disabled = true;
  out.textContent = 'starting…';
  try {
    await postSse('vision/fetch', { id }, (ev) => {
      if (ev.error) throw new Error(ev.error);
      if (ev.vision) { visionView = ev.vision; out.textContent = 'done: it reads photos now.'; }
      else if (ev.line) out.textContent = `${ev.line}${ev.total ? ` · ${Math.floor(((ev.got ?? 0) / ev.total) * 100)}%` : ''}`;
    });
  } catch (e) { out.textContent = e.message; }
  b.disabled = false;
  renderVision();
  getJson('models').then((m) => { S.models = m; renderModels(); }).catch(() => {});
});
$('set-model').addEventListener('change', () => { if (!S.models.some((m) => m.id === $('set-model').value)) return; settings.model = $('set-model').value; saveSettings(); renderModels(); });
segOn('set-mode', (v) => { settings.mode = v; if (v === 'phone' && settings.peers.length > 1) settings.peers = settings.peers.slice(0, 1); saveSettings(); renderModes(); renderSetModel(); });
$('set-temp').addEventListener('input', () => { settings.temperature = Number($('set-temp').value); $('temp-out').textContent = settings.temperature.toFixed(2); saveSettings(); });
$('set-max').addEventListener('change', () => { const n = Math.round(Number($('set-max').value)); if (n >= 16) { settings.maxTokens = Math.min(n, 32768); saveSettings(); } $('set-max').value = String(settings.maxTokens); });
$('set-ctx').addEventListener('change', () => { const n = Math.round(Number($('set-ctx').value)); if (n >= 512) { settings.ctx = Math.min(n, 131072); saveSettings(); } $('set-ctx').value = String(settings.ctx); });
$('set-reset-model').addEventListener('click', () => { settings.temperature = DEFAULTS.temperature; settings.maxTokens = DEFAULTS.maxTokens; settings.ctx = DEFAULTS.ctx; saveSettings(); renderSetModel(); });

// ---- devices

function renderSetDevices() {
  const list = $('set-dev-list');
  list.replaceChildren();
  const n = S.peers.length;
  $('set-dev-sum').textContent = n ? `${n} paired; the green dot answered at the last look.` : 'none yet: add a phone on a usb cable or this wi-fi.';
  for (const p of S.peers) {
    const li = el('li');
    const dot = el('span', `dot${p.reach?.ok ? ' ok' : ''}`);
    li.append(dot, el('b', '', p.name), el('span', '', `${p.cable ? 'usb cable' : p.far ? 'far' : 'wi-fi'}${p.ram ? ` · ${p.ram} MB free` : ''}${p.holds ? ` · has ${p.holds}` : ''}`));
    list.append(li);
  }
  const i = inviteInfo;
  $('set-inv-sum').textContent = i?.on ? `on: ${i.guests} guest${i.guests === 1 ? '' : 's'} in. guests chat with what is loaded and see only their own chats.` : 'off. a phone on this wi-fi scans a qr code and chats with what is loaded here.';
}
$('set-dev-open').addEventListener('click', () => { $('settings').close(); openDevices(); });
$('set-connect').addEventListener('click', () => { $('settings').close(); openConnect(); });
$('set-invite').addEventListener('click', () => { $('settings').close(); $('invite').showModal(); refreshInvite(); });

// ---- data controls

function dataMsg(text, bad) { const m = $('set-data-msg'); m.textContent = text; m.className = `msg${bad ? ' bad' : ' ok'}`; }
$('set-export').href = apiUrl('data/export');
$('set-del-chats').addEventListener('click', async () => {
  if (S.streaming) return dataMsg('wait for the answer, or stop it', true);
  if (!confirm('delete every chat on this computer, the guests\' too? this cannot be undone. export them first if you want to keep them.')) return;
  try {
    const r = await postJson('data/delete-chats', { confirm: 'delete' });
    newChat();
    await loadChats();
    renderProjectBanner();
    dataMsg(`${r.deleted} chat${r.deleted === 1 ? '' : 's'} deleted.`);
    refreshInfo();
  } catch (e) { dataMsg(e.message, true); }
});
$('set-forget').addEventListener('click', async () => {
  if (!confirm('clear what the brain learned (speeds, devices seen, its notes)? it starts again from nothing.')) return;
  try { const r = await postJson('data/forget-brain', { confirm: 'forget' }); dataMsg(`the brain's notes are cleared (${r.forgot} file${r.forgot === 1 ? '' : 's'}).`); } catch (e) { dataMsg(e.message, true); }
});
$('set-reset-usage').addEventListener('click', async () => {
  if (!confirm('reset the usage counts (tokens, answers, speeds)? the chats stay.')) return;
  try { usage = await postJson('usage/reset', { confirm: 'reset' }); dataMsg('the usage counts start again from zero.'); } catch (e) { dataMsg(e.message, true); }
});
$('set-reset-page').addEventListener('click', () => {
  if (!confirm('put this browser\'s settings back to the start: theme, personalisation, model defaults? chats stay.')) return;
  const keep = { model: settings.model, mode: settings.mode, peers: settings.peers, way: settings.way };
  Object.assign(settings, DEFAULTS, keep);
  saveSettings();
  applyTheme();
  fillSettings();
  dataMsg('this browser\'s settings are back to the start.');
});

// ---- usage: tokens counted on this computer (GET usage)

let usage = null;
const USE_NAME = { chat: 'chat page', api: '/v1 api', project: 'night projects', guest: 'guests' };
const MODE_NAME = { phone: 'one phone', apart: 'apart', split: 'split', here: 'here' };
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
const full = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const dayName = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toLowerCase(); };

async function refreshUsage() {
  try { usage = await getJson('usage'); } catch (e) { usage = null; $('u-note').textContent = e.message; }
  renderUsage();
}

function renderUsage() {
  const u = usage;
  const tiles = $('u-tiles');
  tiles.replaceChildren();
  if (!u) return;
  const t = u.total;
  const last30 = u.days.reduce((a, d) => a + d.tokens, 0);
  const tile = (k, v, sub) => { const d = el('div', 'u-tile'); d.append(el('span', 'k', k), el('b', '', v), el('span', 's', sub)); tiles.append(d); };
  tile('tokens', fmt(t.tokens), `${fmt(last30)} in the last 30 days`);
  tile('answers', fmt(t.answers), t.failed ? `${t.failed} failed · ${t.stopped} stopped` : `${t.stopped} stopped`);
  tile('speed', t.tps != null ? `${t.tps}` : '–', 'tokens a second, on average');
  tile('first token', t.firstMs != null ? (t.firstMs >= 1000 ? `${(t.firstMs / 1000).toFixed(1)} s` : `${t.firstMs} ms`) : '–', 'until the answer starts');

  // the chart: one stacked bar a day, a segment per kind of use
  const legend = $('u-legend');
  legend.replaceChildren();
  const used = USES_ORDER.filter((k) => u.days.some((d) => d.uses[k] > 0));
  for (const k of used.length ? used : ['chat']) { const s = el('span', 'u-key'); s.append(el('i', `u-${k}`), document.createTextNode(USE_NAME[k])); legend.append(s); }
  const chart = $('u-chart');
  chart.replaceChildren();
  const max = Math.max(1, ...u.days.map((d) => d.tokens));
  chart.setAttribute('aria-label', `tokens a day over the last 30 days; the most was ${full(max)} in a day. the tables below hold the same numbers.`);
  for (const d of u.days) {
    const col = el('div', 'u-col');
    col.tabIndex = d.tokens ? 0 : -1;
    const bar = el('div', 'u-bar');
    bar.style.height = d.tokens ? `${Math.max(2, (d.tokens / max) * 100)}%` : '0';
    for (const k of USES_ORDER) if (d.uses[k] > 0) { const s = el('i', `u-${k}`); s.style.flexGrow = String(d.uses[k]); bar.append(s); }
    col.append(bar);
    const tip = el('div', 'u-tip');
    tip.append(el('b', '', dayName(d.day)), el('span', '', `${full(d.tokens)} tokens · ${d.answers} answer${d.answers === 1 ? '' : 's'}`));
    for (const k of USES_ORDER) if (d.uses[k] > 0) { const r = el('span', 'u-tip-row'); r.append(el('i', `u-${k}`), document.createTextNode(`${USE_NAME[k]} ${full(d.uses[k])}`)); tip.append(r); }
    col.append(tip);
    chart.append(col);
  }
  const axis = $('u-axis');
  axis.replaceChildren(el('span', '', dayName(u.days[0].day)), el('span', '', 'today'));

  // the tables
  const box = $('u-tables');
  box.replaceChildren();
  const table = (title, rows, name) => {
    const live = rows.filter((r) => r.answers || r.failed);
    const sec = el('section', 'u-table');
    sec.append(el('h3', '', title));
    if (!live.length) { sec.append(el('p', 'hint', 'nothing yet.')); box.append(sec); return; }
    const wrap = el('div', 'u-scroll');
    const tb = el('table');
    const head = el('tr');
    for (const h of ['', 'answers', 'prompt', 'answer', 'tok/s', 'first']) head.append(el('th', '', h));
    const thead = el('thead');
    thead.append(head);
    tb.append(thead);
    const body = el('tbody');
    for (const r of live) {
      const tr = el('tr');
      const td0 = el('td', 'n', name(r.name));
      td0.title = name(r.name);
      tr.append(td0, el('td', '', full(r.answers)), el('td', '', `${r.estimated ? '≈' : ''}${fmt(r.prompt)}`), el('td', '', fmt(r.completion)), el('td', '', r.tps != null ? String(r.tps) : '–'), el('td', '', r.firstMs != null ? (r.firstMs >= 1000 ? `${(r.firstMs / 1000).toFixed(1)} s` : `${r.firstMs} ms`) : '–'));
      body.append(tr);
    }
    tb.append(body);
    wrap.append(tb);
    sec.append(wrap);
    box.append(sec);
  };
  table('by kind of use', u.uses, (k) => USE_NAME[k] ?? k);
  table('by model', u.models, (k) => k);
  table('by device', u.devices, (k) => k);
  table('by mode', u.modes, (k) => MODE_NAME[k] ?? k);
  const since = u.since ? new Date(u.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).toLowerCase() : null;
  $('u-note').textContent = `${since ? `counted on this computer since ${since}. ` : 'nothing counted yet: every answer from now on adds to these. '}answer tokens are what the device reported; prompt tokens (≈) are estimated from the text sent, about 4 characters a token, since no device reports them yet. only counts are kept, never a word of a question or an answer: ${u.file}`;
}
const USES_ORDER = ['chat', 'api', 'project', 'guest'];

// ---- open

function fillSettings() {
  segSet('set-theme', settings.theme);
  segSet('set-start', settings.start);
  segSet('set-enter', settings.enter);
  segSet('set-style', settings.style);
  $('set-system').value = settings.system;
  $('set-name').value = settings.name;
  $('set-about').value = settings.about;
  preview();
  renderSetModel();
}

function openSettings(sec) {
  fillSettings();
  $('settings').showModal();
  showSec(typeof sec === 'string' ? sec : setSec);
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
$('open-settings').addEventListener('click', () => openSettings());

// ---------- start

if (matchMedia('(max-width: 860px)').matches) setSide(false);
// the brain is always open on a wide screen (6.11.2026); on a narrow one it is a drawer
const WIDE = matchMedia('(min-width: 861px)');
// wide: open unless the person closed it (the brain button in the top bar opens and closes it,
// 10.11.2026); narrow: a drawer, shut until asked for
const brainShut = () => { try { return localStorage.getItem('kula.chat.brain') === '0'; } catch { return false; } };
if (WIDE.matches && !brainShut()) setBrain(true);
WIDE.addEventListener('change', () => { if (!WIDE.matches) { $('app').classList.remove('brain-open'); $('brain-toggle').setAttribute('aria-pressed', 'false'); } else if (!brainShut()) setBrain(true); });
const fromHash = location.hash.slice(1);
newChat();
// who is this: the owner at 127.0.0.1, or a guest who came in with an invite
try { S.role = (await getJson('me')).role; } catch { S.role = 'guest'; }
document.body.classList.toggle('guest', isGuest());
if (isGuest()) { $('input').placeholder = 'message'; $('hello').textContent = 'ask away'; }
const opening = /^[0-9a-f]{8,32}$/.test(fromHash);
loadChats().then(() => { if (!opening && settings.start === 'last' && S.chats[0] && !S.chat?.messages.length) openChat(S.chats[0].id); });
if (opening) openChat(fromHash);
refreshStatus().then(() => {
  if (isGuest()) return;
  refreshInvite();
  // 6.11.2026: no sheet opens by itself on load; the page waits for a click on connect or devices
});
setInterval(() => { if (!document.hidden) refreshStatus(); }, 2500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
updateSend();

// the senses look again every 15 s while the brain shows (a probe of every device)
setInterval(() => { if (!document.hidden && $('app').classList.contains('brain-open') && !isGuest() && S.peers.length) { feed('routine', 'the 15 s round: senses look at every device'); refreshPeers(true); } }, 15000);
setInterval(() => { if (!document.hidden && $('app').classList.contains('brain-open') && !isGuest()) refreshCable(); }, 4000);
