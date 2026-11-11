// The night replay (11.11.2026): last night played again in 30 seconds, from the brain's black box
// (GET api/brain/replay, src/godseye/replay.ts). The devices sit around this computer like the
// branches on the brain map (brainmap.js): lit while they answer, a ring around each one that is
// busy, the tokens counting up, the feed lines coming in, and at the end one card that says the
// night in a sentence. Everything is built with createElement and textContent: a device's name is
// its own, and no string from the box goes into html.
//
// app.js only adds the button and calls mountReplay; the pure part below is shared with the tests.

export const SPEEDS = [
  { id: '30s', label: 'the night in 30 s' },
  { id: '60', label: '×60' },
  { id: '600', label: '×600' },
  { id: '3600', label: '×3600' },
];
const NIGHT_FROM = 18, NIGHT_TO = 9;
const FEED_SHOWN = 40;
const SHOWN_MAX = 16; // devices on the ring; the rest are counted

/** How long one frame stays on screen, in ms: the whole stretch in 30 s, or the clock sped up. */
export function frameMs(speed, step, frames) {
  if (speed === '30s') return 30_000 / Math.max(1, frames);
  const x = Number(speed);
  return Number.isFinite(x) && x > 0 ? Math.max(16, step / x) : 30_000 / Math.max(1, frames);
}

/** Last night (18:00 → 09:00 local, never past now), or the night that starts on the evening of `day` (yyyy-mm-dd). */
export function nightRange(now, day) {
  let start;
  if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const [y, m, d] = day.split('-').map(Number);
    start = new Date(y, m - 1, d, NIGHT_FROM, 0, 0, 0);
  } else {
    start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(NIGHT_FROM, 0, 0, 0);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setHours(NIGHT_TO, 0, 0, 0);
  return { from: start.getTime(), to: Math.min(end.getTime(), Math.max(now, start.getTime() + 1)) };
}

/** yyyy-mm-dd of a moment, local. */
export function dayOf(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 5 h 12 min, 42 min, 30 s */
export function duration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
  const h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
}

/** 41 230 */
export function count(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

export function clock(t) { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
const dayWords = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** What the stretch is called: last night, the last 12 hours, or its dates. */
export function rangeName(r) {
  if (r.range === 'night') return 'last night';
  if (r.range === '12h') return 'the last 12 hours';
  return `the night of ${dayWords(r.from)}`;
}

/** The card's one sentence: "last night: 3 devices, 5 h 12 min of work, 41 230 tokens, 1 rest warning". */
export function summaryLine(r) {
  const s = r.summary;
  if (!s.looks) return `${rangeName(r)}: the brain saw nothing (kula was not running)`;
  if (!s.devices) return `${rangeName(r)}: ${plural(s.seen, 'device')} there, none answered`;
  const parts = [plural(s.devices, 'device'), `${duration(s.workMs)} of work`, `about ${plural(s.tokens, 'token')}`];
  if (s.rests) parts.push(plural(s.rests, 'rest warning'));
  if (s.badVerdicts) parts.push(plural(s.badVerdicts, 'trust warning'));
  return `${rangeName(r)}: ${parts.join(', ')}`;
}

/** Where the k-th of n devices sits on the ring around this computer (clockwise from the top). */
export const STAGE = { w: 360, h: 320, cx: 180, cy: 160, rx: 132, ry: 110, r: 16, core: 46 };
export function ringAt(k, n) {
  const a = ((-90 + (360 * k) / Math.max(1, n)) * Math.PI) / 180;
  const x = STAGE.cx + STAGE.rx * Math.cos(a), y = STAGE.cy + STAGE.ry * Math.sin(a);
  // the ones at the top carry their name and speed above, the rest below
  const top = y < STAGE.cy - 40;
  const r1 = (v) => Math.round(v * 10) / 10;
  return { x: r1(x), y: r1(y), ly: r1(top ? y - 36 : y + 30), ty: r1(top ? y - 24 : y + 42) };
}

/** The eye's own records in a frame, in words for the feed. */
const MARK_WORD = {
  start: 'the brain started watching', stop: 'the brain stopped watching', gap: 'some looks could not be written down',
  skip: 'a look was skipped', forget: 'the brain\'s notes were cleared', tamper: 'the black box saw a change it did not make',
  accept: 'the owner accepted the change', retention: 'the oldest records were let go', repair: 'a torn last line was cut',
};

/** The feed lines up to frame i, newest first, at most `max`. */
export function feedUpTo(frames, i, max = FEED_SHOWN) {
  const out = [];
  for (let k = Math.min(i, frames.length - 1); k >= 0 && out.length < max; k--) {
    const f = frames[k];
    const lines = [...(f.marks ?? []).filter((m) => MARK_WORD[m]).map((m) => ({ t: f.t, branch: 'brain', text: MARK_WORD[m], mark: true })), ...(f.feed ?? [])];
    for (let j = lines.length - 1; j >= 0 && out.length < max; j--) out.push(lines[j]);
  }
  return out;
}

// ---------- the page

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sv = (tag, attrs = {}, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text != null) e.textContent = text; return e; };
const icon = (paths, cls) => { const s = sv('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' }); if (cls) s.setAttribute('class', cls); for (const d of paths) s.appendChild(sv('path', { d })); return s; };
const ICON = {
  play: ['M7 4.5v11l9-5.5z'],
  pause: ['M7 4.5v11M13 4.5v11'],
  close: ['M5.5 5.5l9 9M14.5 5.5l-9 9'],
  again: ['M15.5 10a5.5 5.5 0 1 1-1.7-4', 'M15.5 3.8v3.4h-3.4'],
  phone: ['M7 2.8h6v14.4H7z', 'M9.3 15h1.4'],
  computer: ['M4 5h12v8.5H4z', 'M2.5 16h15'],
  other: ['M10 4.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z'],
};
const kindIcon = (kind) => (/phone|tablet|android|ios/.test(kind) ? ICON.phone : /pc|computer|mac|laptop|desktop|linux|windows/.test(kind) ? ICON.computer : ICON.other);

/** Mounts the replay: a click on `button` opens it. `getJson(path)` is the page's own fetch. */
export function mountReplay({ button, getJson }) {
  if (!button) return;
  let ui = null;
  button.addEventListener('click', () => {
    ui ??= build(getJson);
    ui.open();
  });
}

function build(getJson) {
  const dlg = el('dialog', 'sheet rp');
  dlg.setAttribute('aria-labelledby', 'rp-title');
  // head
  const head = el('div', 'sheet-head rp-head');
  const titles = el('div', 'rp-titles');
  const h = el('h2', '', 'replay');
  h.id = 'rp-title';
  const sub = el('span', 'rp-sub', '');
  titles.append(h, sub);
  const pick = el('label', 'rp-pick');
  const pickWord = el('span', '', 'night of');
  const date = el('input');
  date.type = 'date';
  date.setAttribute('aria-label', 'the night that starts on this evening');
  pick.append(pickWord, date);
  const close = el('button', 'icon');
  close.type = 'button';
  close.setAttribute('aria-label', 'close the replay');
  close.appendChild(icon(ICON.close));
  head.append(titles, pick, close);

  // the stage: the map, the clock and the counters
  const body = el('div', 'sheet-body rp-body');
  const stage = el('div', 'rp-stage');
  const map = sv('svg', { class: 'rp-map', viewBox: `0 0 ${STAGE.w} ${STAGE.h}`, role: 'img' });
  const side = el('div', 'rp-side');
  const clockEl = el('div', 'rp-clock', '--:--');
  const dayEl = el('div', 'rp-day', '');
  const offEl = el('div', 'rp-off', 'the brain was not watching');
  offEl.hidden = true;
  const nums = el('dl', 'rp-nums');
  const num = (k) => { const d = el('div'); const dt = el('dt', '', k); const dd = el('dd', '', '0'); d.append(dd, dt); nums.appendChild(d); return dd; };
  const tokEl = num('tokens (from tok/s)'), ansEl = num('answers'), workEl = num('of work');
  const modelEl = el('p', 'rp-model', '');
  const trustEl = el('p', 'rp-trust', '');
  side.append(clockEl, dayEl, offEl, nums, modelEl, trustEl);
  stage.append(map, side);

  // the controls
  const ctl = el('div', 'rp-ctl');
  const playBtn = el('button', 'rp-play');
  playBtn.type = 'button';
  const scrub = el('input', 'rp-scrub');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.step = '1';
  scrub.setAttribute('aria-label', 'where in the night');
  const speed = el('select', 'rp-speed');
  speed.setAttribute('aria-label', 'how fast');
  for (const s of SPEEDS) { const o = el('option', '', s.label); o.value = s.id; speed.appendChild(o); }
  ctl.append(playBtn, scrub, speed);

  // the end card, the feed and the chain
  const card = el('section', 'rp-card');
  card.hidden = true;
  const feedH = el('h3', 'rp-feed-h', 'what the brain said');
  const feedEl = el('ol', 'rp-feed');
  feedEl.setAttribute('aria-live', 'off');
  const chainEl = el('p', 'rp-chain', '');
  const note = el('p', 'rp-note', '');
  body.append(stage, ctl, card, feedH, feedEl, chainEl, note);
  dlg.append(head, body);
  document.body.appendChild(dlg);

  // ---- state
  let r = null, i = 0, pos = 0, playing = false, raf = 0, last = 0, ask = 0, nodes = new Map(), core = null;

  const setPlaying = (on) => {
    playing = on && !!r && r.frames.length > 1;
    playBtn.replaceChildren(icon(playing ? ICON.pause : ICON.play), document.createTextNode(playing ? 'pause' : 'play'));
    playBtn.setAttribute('aria-pressed', String(playing));
    cancelAnimationFrame(raf);
    if (playing) { last = performance.now(); raf = requestAnimationFrame(tick); }
  };
  function tick(now) {
    if (!playing || !r) return;
    const per = frameMs(speed.value, r.step, r.frames.length);
    pos = Math.min(r.frames.length - 1, pos + (now - last) / per);
    last = now;
    show(pos);
    if (pos >= r.frames.length - 1) { setPlaying(false); end(); return; }
    raf = requestAnimationFrame(tick);
  }

  function drawStage() {
    map.replaceChildren();
    nodes = new Map();
    const all = r.devices.filter((d) => d.id !== 'local');
    const shown = all.slice(0, SHOWN_MAX);
    map.setAttribute('aria-label', `${all.length} device${all.length === 1 ? '' : 's'} around this computer`);
    map.appendChild(sv('ellipse', { class: 'rp-ring', cx: STAGE.cx, cy: STAGE.cy, rx: STAGE.rx, ry: STAGE.ry }));
    const spokes = sv('g'), dots = sv('g');
    shown.forEach((d, k) => {
      const p = ringAt(k, shown.length);
      const spoke = sv('line', { class: 'rp-spoke', x1: STAGE.cx, y1: STAGE.cy, x2: p.x, y2: p.y });
      spokes.appendChild(spoke);
      const g = sv('g', { class: 'rp-dev' });
      const title = sv('title', {}, d.name);
      const pulse = sv('circle', { class: 'rp-pulse', cx: p.x, cy: p.y, r: STAGE.r + 6 });
      const dot = sv('circle', { class: 'rp-dot', cx: p.x, cy: p.y, r: STAGE.r });
      const ic = icon(kindIcon(d.kind), 'rp-ic');
      for (const [k2, v] of Object.entries({ x: p.x - 8, y: p.y - 8, width: 16, height: 16 })) ic.setAttribute(k2, String(v));
      const name = sv('text', { x: p.x, y: p.ly }, d.name.length > 16 ? `${d.name.slice(0, 15)}…` : d.name);
      const tps = sv('text', { class: 'rp-tps', x: p.x, y: p.ty }, '');
      g.append(title, pulse, dot, ic, name, tps);
      dots.appendChild(g);
      nodes.set(d.id, { g, spoke, tps });
    });
    const c = sv('g', { class: 'rp-core' });
    const cPulse = sv('circle', { class: 'rp-pulse', cx: STAGE.cx, cy: STAGE.cy, r: STAGE.core + 6 });
    const cDot = sv('circle', { class: 'rp-dot', cx: STAGE.cx, cy: STAGE.cy, r: STAGE.core });
    const c1 = sv('text', { class: 'c1', x: STAGE.cx, y: STAGE.cy - 12 }, 'this computer');
    const c2 = sv('text', { class: 'c2', x: STAGE.cx, y: STAGE.cy + 6 }, '');
    const c3 = sv('text', { class: 'c3', x: STAGE.cx, y: STAGE.cy + 21 }, '');
    c.append(cPulse, cDot, c1, c2, c3);
    map.append(spokes, c, dots);
    core = { g: c, c2, c3 };
    if (all.length > shown.length) map.appendChild(sv('text', { class: 'rp-more', x: STAGE.w - 6, y: STAGE.h - 6 }, `+${all.length - shown.length} more`));
    if (!all.length) map.appendChild(sv('text', { class: 'rp-more mid', x: STAGE.cx, y: STAGE.h - 10 }, 'no device in this stretch'));
  }

  function show(p) {
    const k = Math.max(0, Math.min(r.frames.length - 1, Math.floor(p)));
    const f = r.frames[k];
    const nx = r.frames[Math.min(r.frames.length - 1, k + 1)];
    const frac = p - k;
    const t = f.t + frac * r.step;
    clockEl.textContent = clock(t);
    dayEl.textContent = dayWords(t);
    scrub.value = String(k);
    scrub.setAttribute('aria-valuetext', `${clock(t)}, ${dayWords(t)}`);
    offEl.hidden = !f.off;
    stage.classList.toggle('off', f.off);
    tokEl.textContent = count(f.tokens + (nx.tokens - f.tokens) * frac);
    ansEl.textContent = count(f.answers);
    workEl.textContent = duration(f.workMs);
    modelEl.textContent = f.off ? '' : f.model ? `${f.model}${f.mode ? ` · ${f.mode}` : ''}` : f.loading ? `loading ${f.loading}…` : 'no model loaded';
    const v = Object.values(f.verdicts ?? {});
    const bad = v.includes('bad');
    trustEl.textContent = !v.length ? '' : bad ? 'trust: look at this' : f.verdicts['*'] === 'ok' ? 'trust: all clear' : 'trust: not checked yet';
    trustEl.className = `rp-trust${bad ? ' bad' : ''}`;
    const by = new Map(f.devices.map((d) => [d.id, d]));
    for (const [id, n] of nodes) {
      const d = by.get(id);
      const state = !d || f.off ? 'gone' : d.busy ? 'busy' : d.loaded ? 'loaded' : d.present ? 'here' : 'gone';
      n.g.setAttribute('class', `rp-dev is-${state}`);
      n.spoke.setAttribute('class', `rp-spoke is-${state} via-${d?.via === 'cable' || d?.via === 'relay' ? d.via : 'wifi'}`);
      n.tps.textContent = d?.busy && d.tps ? `${Math.round(d.tps * 10) / 10} tok/s` : d?.plugged === true ? 'on the cable' : '';
    }
    const local = by.get('local');
    core.g.setAttribute('class', `rp-core${local?.busy ? ' is-busy' : ''}${f.off ? ' is-gone' : ''}`);
    const m = f.model ?? (f.off ? '' : 'nothing loaded');
    core.c2.textContent = m.length > 18 ? `${m.slice(0, 17)}…` : m;
    core.c3.textContent = local?.busy && local.tps ? `${Math.round(local.tps * 10) / 10} tok/s` : f.mode ?? '';
    if (k !== i || !feedEl.childElementCount) { i = k; drawFeed(); }
    card.hidden = true;
  }

  function drawFeed() {
    const lines = feedUpTo(r.frames, i);
    const now = r.frames[i]?.t ?? 0;
    feedEl.replaceChildren(...lines.map((l) => {
      // only the lines of the frame on screen come in; the rest are already there
      const li = el('li', `${l.mark ? 'mark' : ''}${playing && l.t >= now ? ' new' : ''}`);
      li.append(el('time', '', clock(l.t)), el('span', 'b', l.branch), el('span', 't', l.text));
      return li;
    }));
    if (!lines.length) feedEl.appendChild(el('li', 'none', 'nothing said yet'));
  }

  function end() {
    card.replaceChildren();
    const s = r.summary;
    card.appendChild(el('p', 'rp-card-line', summaryLine(r)));
    if (s.byDevice.length) {
      const ul = el('ul', 'rp-card-devs');
      for (const d of s.byDevice.slice(0, 8)) ul.appendChild(el('li', '', `${d.id === 'local' ? 'this computer' : d.name}: ${duration(d.workMs)}, ${plural(d.tokens, 'token')}, ${plural(d.answers, 'answer')}`));
      card.appendChild(ul);
    }
    const extra = [];
    if (s.models.length) extra.push(`model${s.models.length === 1 ? '' : 's'}: ${s.models.join(', ')}`);
    if (s.offMs >= 60_000) extra.push(`the brain was not watching for ${duration(s.offMs)}`);
    if (extra.length) card.appendChild(el('p', 'rp-card-more', extra.join(' · ')));
    const again = el('button', 'pill rp-again');
    again.type = 'button';
    again.append(icon(ICON.again), document.createTextNode('play again'));
    again.addEventListener('click', () => { pos = 0; show(0); setPlaying(true); });
    card.appendChild(again);
    card.hidden = false;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function load(q) {
    const my = ++ask;
    setPlaying(false);
    card.hidden = true;
    note.textContent = 'reading the black box…';
    note.className = 'rp-note';
    const qs = q ? `?from=${Math.round(q.from)}&to=${Math.round(q.to)}` : '';
    let got;
    try { got = await getJson(`brain/replay${qs}`); } catch (e) {
      if (my !== ask) return;
      note.textContent = `the replay could not be read: ${e.message}`;
      note.className = 'rp-note bad';
      return;
    }
    if (my !== ask) return;
    r = got;
    sub.textContent = `${rangeName(r)} · ${dayWords(r.from)} ${clock(r.from)} → ${clock(r.to)}`;
    date.value = dayOf(r.range === '12h' ? r.to - 86_400_000 : r.from);
    if (r.box.first) date.min = dayOf(r.box.first - 86_400_000);
    if (r.box.last) date.max = dayOf(r.box.last);
    scrub.max = String(Math.max(0, r.frames.length - 1));
    chainEl.textContent = r.records.count
      ? (r.chain.ok ? `records ${r.records.from}–${r.records.to} of the black box: the chain holds` : `the chain does not hold: ${r.chain.problem}`)
      : 'no record of the black box in this stretch';
    chainEl.className = `rp-chain${r.chain.ok ? '' : ' bad'}`;
    note.textContent = r.summary.looks ? 'tokens are counted from each device’s tok/s while it answered: an estimate.' : 'the brain saw nothing in this stretch: kula-node ui was not running. pick another night.';
    drawStage();
    pos = 0; i = -1;
    feedEl.replaceChildren();
    show(0);
    if (r.summary.looks) setPlaying(true);
  }

  playBtn.addEventListener('click', () => {
    if (!r) return;
    if (!playing && pos >= r.frames.length - 1) pos = 0;
    setPlaying(!playing);
  });
  scrub.addEventListener('input', () => { if (!r) return; setPlaying(false); pos = Number(scrub.value); show(pos); if (pos >= r.frames.length - 1) end(); });
  speed.addEventListener('change', () => { last = performance.now(); });
  date.addEventListener('change', () => { if (date.value) load(nightRange(Date.now(), date.value)); });
  close.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => setPlaying(false));
  dlg.addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.target === dlg) { e.preventDefault(); playBtn.click(); }
  });
  setPlaying(false);

  return { open() { if (!dlg.open) dlg.showModal(); load(null); } };
}
