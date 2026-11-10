// The connect sheet as one question at a time: which way the phone is connected (a usb cable
// or the same wi-fi), the steps of that way, then the model, how it runs, and the load. Pure:
// no DOM and no fetch, so app.js draws what these say and test/wizard.test.ts walks them.
//
//   how ─┬─ cable-plug ── cable-share ── cable-code ──┬─ connected ── model ── mode ── pick ── load ── done
//                                         (pick: which devices, for every mode but "this computer")
//        └─ wifi-share ── wifi-list ─┬─ wifi-code ────┤
//                                    └─ wifi-check ───┘
//                    wifi-code / wifi-check ── wifi-apart ─┬─ cable-plug   (use the cable instead)
//                                                          └─ hotspot ── wifi-list
//
// The cable steps follow what GET cable says (adb, the phone's state, the "use" job); the
// others move on events from the page.

export const STAGES = ['how', 'connect', 'pair', 'model', 'mode', 'devices', 'load'];
const STAGE_OF = {
  how: 0,
  'cable-plug': 1, 'wifi-share': 1, 'wifi-list': 1,
  'cable-share': 2, 'cable-code': 2, 'wifi-code': 2, 'wifi-check': 2, 'wifi-apart': 2, hotspot: 2, connected: 2,
  model: 3, mode: 4, pick: 5, load: 6, done: 6,
};
export const stageOf = (step) => STAGE_OF[step] ?? 0;
const CABLE_STEPS = new Set(['cable-plug', 'cable-share', 'cable-code']);

export function initial(way = null) {
  return { step: 'how', way, serial: null, used: [], found: null, typed: false, peerId: null, error: null, model: null, mode: null, picked: null, returning: false };
}

// Where the sheet starts. A load running: its progress. A model loaded: no sheet at all when
// the page opens by itself, the model question when someone opened it. A paired device that
// answered the probe: the model question. Else the first question.
export function startStep({ peers = [], status = null, explicit = false } = {}) {
  if (status?.loading) return 'load';
  if (status?.loaded) return explicit ? 'model' : 'done';
  if (peers.some((p) => p.reach?.ok)) return 'model';
  return 'how';
}

// The phone the model step is about: the one just connected, else the one picked last time
// if it answers, else the first that answers.
export function choosePhone(peers = [], prefer = []) {
  for (const id of prefer) { const p = peers.find((x) => x.id === id && x.reach?.ok); if (p) return p; }
  for (const id of prefer) { const p = peers.find((x) => x.id === id && !x.reach); if (p) return p; }
  return peers.find((p) => p.reach?.ok) ?? null;
}

// What GET cable means for the cable steps. `serial`: the phone this walk is about (the first
// ready one otherwise); `used`: serials this walk already pressed "use" on, so an old error
// from before is tried again once by itself and a new one waits for "try again".
export function cableState(view, serial = null, used = []) {
  if (!view) return { step: 'cable-plug', problem: 'looking' };
  if (!view.adb) return { step: 'cable-plug', problem: 'no-adb', help: view.help ?? null };
  const live = (view.devices || []).filter((d) => d.state !== 'unplugged');
  const d = live.find((x) => x.serial === serial) ?? live.find((x) => x.state === 'device') ?? live[0];
  if (!d) return { step: 'cable-plug', problem: view.error ? 'adb-error' : 'none', error: view.error ?? null };
  const base = { serial: d.serial, name: d.name, lines: d.job?.lines ?? [] };
  if (d.state === 'unauthorized') return { ...base, step: 'cable-plug', problem: 'unauthorized', help: d.help };
  if (d.state !== 'device') return { ...base, step: 'cable-plug', problem: 'offline', help: d.help };
  if (d.installed === false) return { ...base, step: 'cable-plug', problem: 'not-installed', help: d.help };
  const j = d.job;
  if (!j) return { ...base, step: 'cable-share', use: true };
  if (j.step === 'paired' && j.peerId) return { ...base, step: 'connected', peerId: j.peerId };
  if (j.step === 'code' || j.step === 'pairing') return { ...base, step: 'cable-code', busy: !!j.busy, error: j.error ?? null };
  if (j.step === 'error') return used.includes(d.serial) || j.busy ? { ...base, step: 'cable-share', error: j.error, retry: true } : { ...base, step: 'cable-share', use: true };
  return { ...base, step: 'cable-share', busy: true };
}

// A failed pairing or probe over wi-fi: "isolated" when the phone cannot be reached at all
// (the network keeps devices apart, or it is another network), "closed" when nothing listens
// (sharing is off), "code" for a wrong or used code, else "other".
export function pairError(message) {
  const m = String(message ?? '');
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ETIMEDOUT|connect timeout|tls timeout|timed out|timeout/i.test(m)) return 'isolated';
  if (/ECONNREFUSED|ECONNRESET|closed|socket hang up/i.test(m)) return 'closed';
  if (/code|pin|proof|not paired|certificate/i.test(m)) return 'code';
  return 'other';
}

export function back(w) {
  switch (w.step) {
    case 'cable-plug': case 'cable-share': case 'cable-code': case 'wifi-share': return 'how';
    case 'wifi-list': return 'wifi-share';
    case 'wifi-code': case 'wifi-check': return 'wifi-list';
    case 'wifi-apart': return w.found?.paired ? 'wifi-list' : 'wifi-code';
    case 'hotspot': return 'wifi-apart';
    case 'connected': return w.way === 'cable' ? 'how' : 'wifi-list';
    case 'model': return w.chat ? null : w.peerId ? 'connected' : 'how';
    case 'mode': return 'model';
    case 'pick': return 'mode';
    case 'load': return w.vision ? 'model' : w.picked && PICK_MODES.has(w.mode) ? 'pick' : 'mode'; // the "+": model, then the load
    default: return null;
  }
}

// One step on: the walk `w` and what happened. Returns a new walk (the old one is not changed).
export function next(w, ev) {
  const to = (step, more = {}) => ({ ...w, error: null, ...more, step });
  switch (ev.type) {
    case 'back': { const b = back(w); return b ? to(b) : w; }
    // one more device (6.11.2026): back to the first question; a phone already used on a cable is skipped
    case 'another': return { ...initial(w.way), returning: false, used: w.serial && !w.used.includes(w.serial) ? [...w.used, w.serial] : w.used };
    case 'way':
      return { ...initial(ev.way), way: ev.way, step: ev.way === 'cable' ? 'cable-plug' : 'wifi-share' };
    case 'cable': {
      if (!CABLE_STEPS.has(w.step)) return w;
      const c = cableState(ev.view, w.serial, w.used);
      return { ...w, step: c.step, serial: c.serial ?? w.serial, peerId: c.peerId ?? w.peerId, error: c.error ?? null };
    }
    case 'used': return { ...w, used: w.used.includes(ev.serial) ? w.used : [...w.used, ev.serial] };
    case 'share-on': return w.step === 'wifi-share' ? to('wifi-list') : w;
    case 'pick':
      if (w.step !== 'wifi-list' || !ev.found) return w;
      return to(ev.found.paired ? 'wifi-check' : 'wifi-code', { found: ev.found, typed: false });
    case 'type-address': return w.step === 'wifi-list' ? to('wifi-code', { found: null, typed: true }) : w;
    case 'reached': case 'paired': return to('connected', { peerId: ev.peerId });
    case 'pair-failed': {
      const kind = pairError(ev.error);
      if (kind === 'isolated') return to('wifi-apart', { error: ev.error });
      // a paired phone that no longer knows this computer: pair again with a new code
      if (w.step === 'wifi-check') return to('wifi-code', { found: { ...w.found, paired: null }, error: ev.error });
      return { ...w, error: ev.error };
    }
    case 'use-cable': return { ...initial('cable'), step: 'cable-plug' };
    case 'hotspot': return w.step === 'wifi-apart' ? to('hotspot') : w;
    case 'on-hotspot': return w.step === 'hotspot' ? to('wifi-list') : w;
    case 'continue': return w.step === 'connected' ? to('model') : w;
    case 'model': return to('mode', { model: ev.id });
    // every mode that uses devices asks which ones (8.11.2026); "this computer" goes straight to the load
    case 'mode': return PICK_MODES.has(ev.mode) ? to('pick', { mode: ev.mode, picked: null }) : to('load', { mode: ev.mode, picked: null });
    case 'picked': return w.step === 'pick' && ev.ids?.length && (w.mode !== 'phone' || ev.ids.length === 1) ? to('load', { picked: ev.ids }) : w;
    case 'loaded': return to('done');
    case 'load-failed': return { ...w, error: ev.error };
    default: return w;
  }
}

// ---- the model and the mode

export function fitFor(m, p) {
  if (!p?.ram) return null;
  if (m.needMb <= p.ram * 0.8) return ['yes', `fits on ${p.name}`];
  if (m.needMb <= p.ram) return ['tight', `tight on ${p.name}`];
  return ['no', `too big for ${p.name}`];
}

// The models in the order the question shows them: what the phone has loaded first, then the
// catalog (phones can fetch those), then files only on this computer.
export function modelRows(models = [], phone = null) {
  const rank = (m) => (phone?.holds && m.file === phone.holds ? 0 : m.catalog ? 1 : 2);
  return models
    .map((m, i) => ({ ...m, onPhone: !!phone?.holds && m.file === phone.holds, fit: fitFor(m, phone), i }))
    .sort((a, b) => rank(a) - rank(b) || a.i - b.i)
    .map(({ i, ...m }) => m);
}

// The four ways to run it as cards; a card that cannot work says why.
export function modeCards({ model = null, phone = null, peers = [], llama = false } = {}) {
  const localOnly = !!model && !model.catalog;
  const fetchNote = 'this file is only on this computer: phones fetch models from the internet';
  const setup = 'needs llama.cpp on this computer: run kula-node setup';
  const reachable = peers.filter((p) => p.reach?.ok);
  const cards = [
    { mode: 'phone', title: 'on the phone', sub: phone ? `${phone.name} runs it; this computer only carries the words` : 'one phone runs it', recommended: true,
      why: !phone ? 'connect a phone first' : localOnly ? fetchNote : null },
    { mode: 'here', title: 'this computer', sub: 'only this computer runs it; no phone needed',
      why: !llama ? setup : null },
    { mode: 'apart', title: 'both, apart', sub: 'each its own copy; the fastest free one answers',
      why: !phone ? 'connect a phone first' : localOnly ? fetchNote : !llama && reachable.length < 2 ? `${setup}, or connect a second phone` : null },
    { mode: 'split', title: 'split', sub: 'one model spread over this computer and the phone',
      why: !llama ? setup : !phone ? 'connect a phone first' : phone.far ? 'split needs the phone nearby, not through a relay' : null },
  ];
  return cards.map((c) => ({ ...c, disabled: !!c.why }));
}

// ---- the devices step (8.11.2026): after the model and the mode, every mode that uses devices
// (phone, apart, split) asks which ones. The ones ready right now come ticked; nothing forces
// using all of them. "phone" takes exactly one; split's every ticked device holds a part; apart
// sends prompts only to the ticked ones.

export const PICK_MODES = new Set(['phone', 'apart', 'split']);

const nameKey = (name) => String(name || '').toLowerCase().replace(/samsung|galaxy/g, '').replace(/[^a-z0-9]/g, '');
const BUSY = /busy|in use|another computer|already serving/i;

// How one peer row is reached: its routes when the row carries them (one row per device with
// both a cable and a wi-fi route), else what the row itself is.
function routesOf(p) {
  if (Array.isArray(p.routes) && p.routes.length) return p.routes.map((r) => ({ via: r.via === 'cable' ? 'cable' : r.via === 'relay' ? 'relay' : 'wi-fi', reach: r.reach ?? null, id: r.id ?? p.id }));
  return [{ via: p.cable ? 'cable' : p.far ? 'relay' : 'wi-fi', reach: p.reach ?? null, id: p.id }];
}

// A probe's error in plain words.
export function reasonWords(reason) {
  if (!reason) return null;
  if (/unplugged/i.test(reason)) return 'the cable is unplugged';
  if (BUSY.test(reason)) return reason;
  const k = pairError(reason);
  if (k === 'isolated') return 'cannot be reached from here: is it on this network?';
  if (k === 'closed') return 'nothing answers: is share this phone on?';
  return reason;
}

function stateOf(reach, p) {
  if (p?.busy || (reach && !reach.ok && BUSY.test(reach.reason ?? ''))) return 'busy';
  if (reach?.ok) return 'ready';
  if (reach) return 'off';
  return 'unknown';
}

// Each physical device once. A row that carries routes is one device already; otherwise a cable
// row and a wi-fi row of the same name are the same phone paired twice (the devices bubble groups
// them the same way). The id a load sends is the route that answers, the cable first.
export function deviceEntries(peers = []) {
  const groups = [];
  for (const p of peers) {
    const routes = routesOf(p);
    const key = nameKey(p.name);
    const cableRow = !p.routes && !!p.cable;
    const twin = !p.routes && key && groups.find((g) => !g.routed && g.key === key && g.rows.length === 1 && !!g.rows[0].cable !== cableRow);
    if (twin) { twin.rows.push(p); twin.routes.push(...routes); continue; }
    groups.push({ key, routed: !!p.routes, rows: [p], routes: [...routes] });
  }
  return groups.map((g) => {
    const order = (r) => (r.reach?.ok ? 0 : 2) + (r.via === 'cable' ? 0 : 1);
    const routes = [...g.routes].sort((a, b) => order(a) - order(b));
    const best = routes[0];
    const head = g.rows.find((r) => r.id === best.id) ?? g.rows[0];
    const ram = Math.max(0, ...g.rows.map((r) => r.ram ?? 0)) || null;
    const ms = routes.filter((r) => r.reach?.ok && r.reach.ms).map((r) => r.reach.ms);
    const states = g.rows.map((r) => stateOf(routes.find((x) => x.id === r.id)?.reach ?? r.reach, r));
    const state = routes.some((r) => r.reach?.ok) ? 'ready' : states.includes('busy') ? 'busy' : states.includes('off') ? 'off' : 'unknown';
    return {
      id: best.id,                                    // what the load sends
      ids: [...new Set([...g.rows.map((r) => r.id), ...routes.map((r) => r.id)])],
      name: (g.rows.find((r) => r.cable) ?? head).name,
      local: false,
      state,
      reason: state === 'ready' ? null : reasonWords(routes.map((r) => r.reach?.reason).find(Boolean) ?? null),
      via: [...new Set(routes.map((r) => r.via))],
      far: routes.every((r) => r.via === 'relay'),
      ram,
      ms: ms.length ? Math.min(...ms) : null,
      holds: g.rows.map((r) => r.holds).find(Boolean) ?? null,
    };
  });
}

// This computer as an entry: always in a split (it keeps the first and last layers); in apart it
// runs its own copy when llama.cpp is here and the model's file is too.
export function hereEntry({ mode, model = null, llama = false, freeMb = null } = {}) {
  const why = !llama ? 'needs llama.cpp on this computer: kula-node setup'
    : mode === 'apart' && model && !model.here ? 'the model file is not on this computer (load it once with "this computer" to fetch it)' : null;
  return { id: 'here', ids: ['here'], name: 'this computer', local: true, fixed: mode === 'split', state: why ? 'off' : 'ready', reason: why, via: ['main device'], far: false, ram: freeMb, ms: null, holds: null };
}

// The rows the step shows for a mode: this computer first (not for "phone"), then the devices.
// Split cannot use a device behind a relay: it is shown, off, with why.
export function pickRows({ mode, peers = [], model = null, llama = false, freeMb = null } = {}) {
  const devs = deviceEntries(peers).map((e) => (mode === 'split' && e.far ? { ...e, state: 'off', reason: 'split needs it nearby, not through a relay', blocked: true } : e));
  const rank = { ready: 0, busy: 1, unknown: 2, off: 3 };
  devs.sort((a, b) => rank[a.state] - rank[b.state]);
  return mode === 'phone' ? devs : [hereEntry({ mode, model, llama, freeMb }), ...devs];
}

// What fits where. Phone and apart: each ticked device runs the whole model. Split: the parts
// together (this computer's free memory × 0.7 and every device's × 0.75, the planner's shares).
export function fitOf(mode, model, e) {
  if (!model?.needMb || !e?.ram) return null;
  if (mode === 'split') return null;
  return fitFor(model, e);
}

// Which rows start ticked. `last` is what this browser remembers for the mode: { skip: ids the
// user unticked while they were ready, here: false when this computer was unticked in apart,
// id: the phone picked last }. Readiness is checked every time: only ready rows are ticked.
export function preselect(mode, rows = [], model = null, last = {}, prefer = []) {
  const ready = rows.filter((r) => r.state === 'ready' && !r.blocked);
  if (mode === 'phone') {
    // the one just connected, else the last one, else where the model fits best
    const room = { yes: 0, tight: 2, no: 3 };
    const score = (r) => room[fitOf(mode, model, r)?.[0]] ?? 1;
    const want = [...prefer, last.id].filter(Boolean);
    const pick = want.map((id) => ready.find((r) => r.ids.includes(id))).find(Boolean)
      ?? [...ready].sort((x, y) => score(x) - score(y))[0] ?? null;
    return pick ? [pick.id] : [];
  }
  const skip = new Set(last.skip ?? []);
  return ready.filter((r) => {
    if (r.fixed) return true;
    if (r.local) return last.here !== false;
    if (r.ids.some((id) => skip.has(id))) return false;
    return mode === 'split' || fitOf(mode, model, r)?.[0] !== 'no';
  }).map((r) => r.id);
}

// One tick or untick. "phone" keeps exactly one; this computer in a split cannot be unticked.
export function toggle(mode, picked = [], row) {
  if (row.fixed || row.blocked) return picked;
  if (mode === 'phone') return [row.id];
  return picked.includes(row.id) ? picked.filter((id) => id !== row.id) : [...picked, row.id];
}

// What to remember after the step: the ready rows left unticked, and this computer in apart.
export function remember(mode, rows = [], picked = []) {
  if (mode === 'phone') return { id: picked[0] ?? null };
  const out = { skip: rows.filter((r) => !r.local && r.state === 'ready' && !picked.includes(r.id)).flatMap((r) => r.ids) };
  if (mode === 'apart') out.here = picked.includes('here');
  return out;
}

const gbs = (mb) => `${(mb / 1024).toFixed(1)} GB`;

// Before the load: whether it can go, and the words for what will not work. `block`: the button
// waits; `warn`: said plainly, the load can still go (a device may answer by then).
export function pickCheck({ mode, model = null, rows = [], picked = [], hereFreeMb = null } = {}) {
  const on = rows.filter((r) => picked.includes(r.id));
  const devs = on.filter((r) => !r.local);
  const warn = [];
  let block = null;
  if (mode === 'phone' && on.length !== 1) block = 'pick the one device that runs it';
  if (mode === 'apart' && !on.length) block = 'pick at least one device';
  if (mode === 'split' && !devs.length) block = 'pick at least one device besides this computer (or go back and pick "this computer")';
  for (const r of on) {
    if (r.local && r.state !== 'ready') warn.push(`this computer cannot join: ${r.reason}.`);
    else if (r.state === 'off') warn.push(`${r.name} does not answer${r.reason ? ` (${r.reason})` : ''}: ${mode === 'phone' ? 'the load will fail unless it answers by then' : 'it will be left out unless it answers by then'}.`);
    else if (r.state === 'busy') warn.push(`${r.name} is busy${r.reason ? ` (${r.reason})` : ''}: it may refuse.`);
    else if (r.state === 'unknown') warn.push(`${r.name} has not been checked yet: the load tries it.`);
    const f = fitOf(mode, model, r);
    if (f?.[0] === 'no') warn.push(`${model.name} is too big for ${r.name}: it has about ${gbs(r.ram)} free, the model needs about ${gbs(model.needMb)}.`);
    else if (f?.[0] === 'tight') warn.push(`${model.name} is tight on ${r.name} (about ${gbs(r.ram)} free for ${gbs(model.needMb)}): close other apps on it.`);
  }
  if (mode === 'split' && model?.needMb) {
    const here = on.find((r) => r.local);
    const offer = Math.round(((here?.ram ?? hereFreeMb ?? 0) * 0.7) + devs.reduce((n, r) => n + (r.ram ?? 0) * 0.75, 0));
    if (offer && offer < model.needMb) warn.push(`${model.name} needs about ${gbs(model.needMb)}; the ticked devices offer about ${gbs(offer)} together: tick more, or pick a smaller model.`);
  }
  if (mode === 'apart' && on.length && on.every((r) => r.local)) warn.push('only this computer is ticked: no phone takes prompts.');
  return { ok: !block, block, warn };
}

// The load body's devices: exactly the ticked ones. `all` tells the engine to use these and no
// others (and, in a split, to give every one a part); `here` says whether this computer runs its
// own copy in apart.
export function pickBody(mode, picked = []) {
  if (mode === 'here') return { peers: [] };
  const peers = picked.filter((id) => id !== 'here');
  if (mode === 'phone') return { peers: peers.slice(0, 1), all: true };
  if (mode === 'apart') return { peers, all: true, here: picked.includes('here') };
  return { peers, all: true };
}

// What the button says.
export function pickGo(mode, picked = []) {
  const n = picked.length;
  if (mode === 'phone') return n === 1 ? 'load on it' : 'pick one';
  if (mode === 'split') return n > 1 ? `split over ${n} devices` : 'pick at least one';
  return n ? `load on ${n} device${n === 1 ? '' : 's'}` : 'pick at least one';
}

// Which devices a load asks for (the advanced sheet and old callers).
export function loadPeers(mode, phone, peers = []) {
  if (mode === 'here') return [];
  if (mode === 'phone') return phone ? [phone.id] : [];
  const ids = peers.filter((p) => p.reach?.ok && (mode !== 'split' || !p.far)).map((p) => p.id);
  if (phone && !ids.includes(phone.id)) ids.unshift(phone.id);
  return ids;
}
