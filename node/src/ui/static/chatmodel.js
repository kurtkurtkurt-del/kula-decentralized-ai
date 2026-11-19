// An old chat and the model it ran on: what the line above the composer says, and the load a
// tap sends. Pure: no DOM, no fetch. The page (app.js) draws the state and runs the buttons.
// A chat's `ran` is { model, name, mode, peers, names, here, ctx, at } (store.ts keeps it).
import { deviceEntries, pickBody } from './wizard.js';

const MODES = new Set(['phone', 'apart', 'split', 'here']);
const gb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);
// "a", "a and b", "a, b and c"
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const btn = (act, label, primary = false, title = null) => ({ act, label, primary, title });
const said = (reason) => (reason ? ` (${reason})` : '');

// What a loaded model ran on, for the chat record. `parts` (a split) when present, else the
// devices; the non-local ones are the stored devices, `here` says whether this computer took part.
export function ranOf(loaded, at = Date.now()) {
  if (!loaded?.model?.id) return null;
  const list = (Array.isArray(loaded.parts) && loaded.parts.length ? loaded.parts : loaded.devices) ?? [];
  const far = list.filter((d) => d && !d.local);
  const mode = MODES.has(loaded.mode) ? loaded.mode : null;
  return {
    model: loaded.model.id,
    name: loaded.model.name ?? loaded.model.id,
    mode,
    peers: far.map((d) => d.id),
    names: far.map((d) => d.name ?? d.id),
    here: mode === 'here' || list.some((d) => d?.local),
    ctx: Number.isFinite(loaded.ctx) ? loaded.ctx : null,
    at,
  };
}

// A chat's `ran`; an old chat with only a model name gets a weaker one when the name is a row of
// the model list (no mode, no devices: it can only offer to pick how it runs).
export function ranFromChat(chat, models = []) {
  if (chat?.ran?.model) return chat.ran;
  const row = chat?.model ? (models ?? []).find((m) => m.name === chat.model) : null;
  return row ? { model: row.id, name: row.name, mode: null, peers: [], names: [], here: false, ctx: null } : null;
}

// Where it ran, in words: "on this computer", "on <phone>", "apart on …", "split over …", or ''.
export function whereWords(ran) {
  const names = ran?.names ?? [];
  if (ran?.mode === 'here') return 'on this computer';
  if (ran?.mode === 'phone') return `on ${names[0] ?? 'a phone'}`;
  if (ran?.mode === 'apart') return `apart on ${[...(ran.here ? ['this computer'] : []), ...names].join(', ')}`;
  if (ran?.mode === 'split') return `split over ${['this computer', ...names].join(', ')}`;
  return '';
}

// The engine's peer rows carry `routes` as plain ids (every record id of one device) with the
// reach on the row itself; deviceEntries reads `routes` as route objects. Turn the ids into one
// route each, the row's own id holding the row's reach and via. Rows without string routes pass.
function adapt(p) {
  if (!Array.isArray(p?.routes) || !p.routes.some((r) => typeof r === 'string')) return p;
  const via = p.via === 'cable' ? 'cable' : (p.via === 'relay' || p.far) ? 'relay' : 'wifi';
  const ids = [...new Set([p.id, ...p.routes.filter((r) => typeof r === 'string')])];
  return { ...p, routes: ids.map((id) => ({ id, via, reach: id === p.id ? (p.reach ?? null) : null })) };
}

// Today's peers as device entries (wizard.js), the engine's rows adapted first.
export function entriesOf(peers = []) {
  return deviceEntries((peers ?? []).map(adapt));
}

// Each stored device against today's peers: the entry whose ids hold the stored id, else the one
// with the same name. `entry` is null when the device is no longer paired.
function resolve(ids = [], names = [], entries = []) {
  return ids.map((id, i) => {
    const name = names[i] ?? id;
    const entry = entries.find((e) => e.ids.includes(id)) ?? entries.find((e) => e.name === name) ?? null;
    return { id, name, entry };
  });
}

// The load a tap sends: the chat's model, mode and devices (each by the route that answers today),
// and this computer when it took part.
export function loadBody(ran, peers = [], ctx = null) {
  const entries = entriesOf(peers ?? []);
  const ids = [...new Set(resolve(ran.peers, ran.names, entries).map((d) => d.entry?.id ?? d.id))];
  const body = { model: ran.model, ...(ran.mode ? { mode: ran.mode } : {}), ctx: ran.ctx ?? ctx };
  return ran.mode ? { ...body, ...pickBody(ran.mode, ran.here ? [...ids, 'here'] : ids) } : body;
}

// The line above the composer, or null for no line. First match wins (DECISIONS A4).
// `peers` null means not fetched yet: devices are then taken as fine.
export function chatModelState({ ran = null, status = null, models = [], modelsKnown = false, peers = null, guest = false, locked = false, dismissed = false, loadError = null } = {}) {
  if (guest || locked || !ran?.model) return null;
  const loaded = status?.loaded ?? null;
  if (dismissed && loaded) return null;
  const X = ran.name ?? ran.model;
  const Y = loaded?.model?.name ?? null;
  const out = (kind, text, buttons = []) => ({ kind, red: kind !== 'loading', text, buttons });
  const stay = Y ? [btn('stay', `stay with ${Y}`)] : [];

  // 2: a load is running
  const loading = status?.loading;
  if (loading) {
    return loading.model === X
      ? out('loading', `loading ${loading.model}: ${loading.line}`, [btn('stop', 'stop')])
      : out('loading', `this chat used ${X}: ${loading.model} is loading now.`);
  }

  const entries = peers ? entriesOf(peers) : null;

  // 3: the chat's model is loaded; say so only when a device of it does not answer
  if (loaded?.model?.id === ran.model) {
    if (loaded.mode !== 'here' && entries) {
      const now = ranOf(loaded, 0);
      const off = resolve(now.peers, now.names, entries).filter((d) => d.entry?.state === 'off');
      if (off.length) {
        return out('loaded-silent', `${X} is loaded, but ${andList(off.map((d) => d.name))} ${off.length > 1 ? 'do' : 'does'} not answer${said(off[0].entry.reason)}.`,
          [btn('devices', 'connect', true), btn('check', 'check again')]);
      }
    }
    return null;
  }

  // 4: the page fetches the model list first
  if (!modelsKnown) return null;

  // 5: the last load from this line failed
  if (loadError) return out('failed', `${X} did not load: ${loadError}`, [btn('load', 'try again', true), btn('pick-model', 'start a chat')]);

  // 6: the model is gone from the list
  const row = (models ?? []).find((m) => m.id === ran.model);
  if (!row) {
    const text = String(ran.model).startsWith('local:')
      ? `${X} is no longer on this computer: the file was deleted or moved.`
      : `${X} is no longer in kula's model list.`;
    return out('gone', text, [btn('pick-model', 'pick another model', true), ...stay]);
  }

  const local = ran.mode === 'here' || ran.mode === 'split';
  // 7: here and split need llama.cpp on this computer
  if (local && !status?.llama) return out('no-llama', `${X} ran ${whereWords(ran)}: that needs llama.cpp on this computer (run kula-node setup).`, [btn('pick-mode', 'pick another way', true)]);
  // 8: the file has to come again
  if (local && row.here === false) return out('refetch', `${X} is no longer on this computer: it has to be downloaded again (${gb(row.size ?? 0)}).`, [btn('load', 'download and load', true), btn('pick-model', 'pick another model')]);

  if (entries) {
    const devs = resolve(ran.peers, ran.names, entries);
    // 9: a device is no longer paired
    const gone = devs.filter((d) => !d.entry);
    if (gone.length) return out('unpaired', `${andList(gone.map((d) => d.name))} ${gone.length > 1 ? 'are' : 'is'} no longer paired with this computer.`, [btn('devices', 'add a device', true), btn('pick-mode', 'pick another way')]);
    // 10: a device does not answer, or is busy
    const off = devs.filter((d) => d.entry.state === 'off');
    const busy = devs.filter((d) => d.entry.state === 'busy');
    const again = [btn('devices', 'connect', true), btn('check', 'check again')];
    if (off.length) return out('silent', `${andList(off.map((d) => d.entry.name))} ${off.length > 1 ? 'do' : 'does'} not answer${said(off[0].entry.reason)}.`, again);
    if (busy.length) return out('silent', `${busy[0].entry.name} is busy${said(busy[0].entry.reason)}.`, again);
  }

  // 11: an old chat with only a model name
  if (ran.mode == null) {
    return out('no-way', Y ? `this chat used ${X}: ${Y} is loaded now.` : `this chat used ${X}: it is not loaded.`, [btn('pick-mode', `load ${X}`, true), ...stay]);
  }
  // 12: another model is loaded
  if (loaded) return out('other', `this chat used ${X} ${whereWords(ran)}: ${Y} is loaded now.`, [btn('load', `load ${X}`, true, `unloads ${Y} first`), ...stay]);
  // 13: nothing is loaded
  return out('idle', `this chat used ${X} ${whereWords(ran)}: it is not loaded.`, [btn('load', 'load it', true)]);
}
