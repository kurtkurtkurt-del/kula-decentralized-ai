// The connect sheet as one question at a time: which way the phone is connected (a usb cable
// or the same wi-fi), the steps of that way, then the model, how it runs, and the load. Pure:
// no DOM and no fetch, so app.js draws what these say and test/wizard.test.ts walks them.
//
//   how ─┬─ cable-plug ── cable-share ── cable-code ──┬─ connected ── model ── mode ── load ── done
//        └─ wifi-share ── wifi-list ─┬─ wifi-code ────┤
//                                    └─ wifi-check ───┘
//                    wifi-code / wifi-check ── wifi-apart ─┬─ cable-plug   (use the cable instead)
//                                                          └─ hotspot ── wifi-list
//
// The cable steps follow what GET cable says (adb, the phone's state, the "use" job); the
// others move on events from the page.

export const STAGES = ['how', 'connect', 'pair', 'model', 'mode', 'load'];
const STAGE_OF = {
  how: 0,
  'cable-plug': 1, 'wifi-share': 1, 'wifi-list': 1,
  'cable-share': 2, 'cable-code': 2, 'wifi-code': 2, 'wifi-check': 2, 'wifi-apart': 2, hotspot: 2, connected: 2,
  model: 3, mode: 4, load: 5, done: 5,
};
export const stageOf = (step) => STAGE_OF[step] ?? 0;
const CABLE_STEPS = new Set(['cable-plug', 'cable-share', 'cable-code']);

export function initial(way = null) {
  return { step: 'how', way, serial: null, used: [], found: null, typed: false, peerId: null, error: null, model: null, mode: null, returning: false };
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
    case 'model': return w.peerId ? 'connected' : 'how';
    case 'mode': return 'model';
    case 'load': return 'mode';
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
    case 'mode': return to('load', { mode: ev.mode });
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

// Which devices a load asks for.
export function loadPeers(mode, phone, peers = []) {
  if (mode === 'here') return [];
  if (mode === 'phone') return phone ? [phone.id] : [];
  const ids = peers.filter((p) => p.reach?.ok && (mode !== 'split' || !p.far)).map((p) => p.id);
  if (phone && !ids.includes(phone.id)) ids.unshift(phone.id);
  return ids;
}
