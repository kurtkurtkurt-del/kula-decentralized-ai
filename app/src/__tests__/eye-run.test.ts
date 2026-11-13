// god's eye on the phone (11.11.2026): the shared eye (node/src/godseye, the computer's same
// source) running on the phone's kv-store, the phone's trust branch, when it runs (foreground and
// held), and a card's tap routed to the phone's own engine (src/eye/apply.ts).
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockKv = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItemSync: (k: string) => (mockKv.has(k) ? mockKv.get(k)! : null),
    setItemSync: (k: string, v: string) => { mockKv.set(k, v); },
    removeItemSync: (k: string) => mockKv.delete(k),
  },
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

import { AppState } from 'react-native';
import { BRANCH_IDS, GodsEye, dark, type BranchMaker, type SuggestAction } from '@godseye/core';
import { route, type PhoneEnv } from '@/eye/apply';
import { kvNotes, NOTES_PREFIX } from '@/eye/notes';
import { actOf, applyCard, dismissCard, eyeRunning, holdEye, look, resetEye } from '@/eye/run';
import { phoneSnapshot, type PhoneInput } from '@/eye/snapshot';
import { phoneTrust } from '@/eye/trustBranch';
import { setCurrentLang, translator } from '@/i18n/core';
import type { LocalModel, Peer } from '@/llm/store';
import { clusterReport, deviceReport, hostCheck, freshNote } from '@/llm/trust';
import { CATALOG } from '@/llm/catalog';

const MIN = 60_000;
const T0 = new Date(2026, 10, 11, 21, 0).getTime();
const peer = (o: Partial<Peer> = {}): Peer => ({ id: 'p1', name: 'Pixel', host: '192.168.1.40', port: 50551, secret: '', fp: 'ab'.repeat(32), pin: null, kind: 'phone', ram: 3500, bw: 40, added_at: 'x', ...o });
const model = (o: Partial<LocalModel> = {}): LocalModel => ({ id: 'qwen', name: 'Qwen', file: 'qwen.gguf', path: '/m/qwen.gguf', size: 400 * 1024 * 1024, sha256: null, params_b: 0.6, quant: 'Q4', kv_mb_per_1k: 100, ctx_max: 8192, license: null, source: 'hf', url: 'u', added_at: 'x', ...o });
const input = (at: number, peers: Peer[], reach: PhoneInput['reach'] = {}): PhoneInput => ({
  at, name: 'pixel 8', freeMb: 4000, ledger: null, power: { battery: 80, charging: true, hot: false },
  engine: { model: null, mode: 'alone', loading: null, plan: null, split: [], devices: [], generating: false, load: null },
  since: { loaded: null, loading: null }, peers, reach, trust: {}, models: [model()], catalog: CATALOG.slice(0, 3), tasks: [], decisions: [], llama: true,
});
const en = translator('en');
const trust = phoneTrust({ report: () => clusterReport([], hostCheck(null)), tx: () => en.tx, self: () => 'this phone' });

beforeEach(() => {
  mockKv.clear();
  resetEye();
});

describe('the shared eye on the phone\'s storage', () => {
  it('runs the twelve over the phone\'s looks, keeps the notes in the kv-store, reads them back, forgets them', () => {
    let at = T0;
    let peers: Peer[] = [peer()];
    const reach = (ok: boolean) => ({ p1: { ok, at, why: ok ? null : 'no answer' } });
    let r = reach(true);
    const make = () => new GodsEye({ snapshot: () => phoneSnapshot(input(at, peers, r)), notes: kvNotes, keys: null, now: () => at, makers: { trust } });
    const eye = make();
    for (let i = 0; i < 30; i++) {
      at = T0 + i * MIN;
      if (i === 10) r = reach(false);       // it stops answering
      if (i === 20) { r = reach(true); peers = [peer(), peer({ id: 'p2', name: 'Tab', kind: 'tablet' })]; }
      eye.tick();
    }
    const v = eye.view();
    expect(v.branches.map((b) => b.id)).toEqual(BRANCH_IDS);
    expect(v.branches.filter((b) => b.error)).toEqual([]);
    expect(v.branches.find((b) => b.id === 'trust')?.stat).toBe('not checked yet');
    expect(v.branches.find((b) => b.id === 'limits')?.rows.some(([k, val]) => k === 'pixel 8' && /battery 80%/.test(val))).toBe(true);
    // memory saw the device go and come back, and the tablet appear
    const memory = v.branches.find((b) => b.id === 'memory')!;
    expect(memory.lines.join('\n')).toMatch(/Pixel/);
    const kept = [...mockKv.keys()].filter((k) => k.startsWith(NOTES_PREFIX));
    expect(kept).toContain(`${NOTES_PREFIX}memory`);
    expect(() => JSON.parse(mockKv.get(`${NOTES_PREFIX}memory`)!)).not.toThrow();

    // a new eye (the app started again) starts from those notes
    const again = make();
    again.tick();
    expect(again.view().branches.find((b) => b.id === 'memory')!.lines.join('\n')).toMatch(/Pixel/);

    const n = again.forget();
    expect(n).toBe(kept.length);
    expect([...mockKv.keys()].filter((k) => k.startsWith(NOTES_PREFIX))).toEqual([]);
  });

  it('the phone\'s trust branch is the security report, in the reader\'s language, with a card when it is red', () => {
    const p = peer();
    const bad = { ...freshNote(), at: T0, answered: true, hasCert: true, keyId: 'ab'.repeat(16), certPinned: false };
    const report = () => clusterReport([deviceReport(p, bad)], hostCheck({ ok: true, lines: 3 }));
    const de = translator('de');
    const eye = new GodsEye({ snapshot: () => phoneSnapshot(input(T0, [p])), notes: kvNotes, makers: { trust: phoneTrust({ report, tx: () => de.tx, self: () => 'dieses handy' }) } });
    eye.tick();
    const b = eye.view().branches.find((x) => x.id === 'trust')!;
    expect(b.stat).toBe('sieh dir das an');
    expect(b.gauge).toBe(0);
    expect(eye.view().cards).toEqual([expect.objectContaining({ id: 'trust:bad', kind: 'warn', branch: 'trust', action: { do: 'open', panel: 'branch', branch: 'trust' } })]);
  });
});

describe('when the eye runs', () => {
  it('only while held and in the foreground: paused in the background, back on return, stopped when let go', () => {
    let onChange: ((s: string) => void) | null = null;
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, fn: (s: string) => void) => {
      onChange = fn;
      return { remove: () => { onChange = null; } };
    }) as never);
    jest.useFakeTimers();
    try {
      expect(eyeRunning()).toBe(false);
      const letGo = holdEye('tab');
      const cluster = holdEye('cluster');
      expect(eyeRunning()).toBe(true);
      onChange!('background');
      expect(eyeRunning()).toBe(false);
      onChange!('active');
      expect(eyeRunning()).toBe(true);
      letGo();
      expect(eyeRunning()).toBe(true);   // the cluster still holds it
      cluster();
      expect(eyeRunning()).toBe(false);
      expect(onChange).toBeNull();       // nothing listens once nobody holds it
    } finally {
      jest.useRealTimers();
      spy.mockRestore();
    }
  });

  it('a look reads the phone (no native here: no memory, no battery) and shows the twelve', () => {
    const v = look();
    expect(v.branches).toHaveLength(12);
    expect(v.branches.filter((b) => b.error)).toEqual([]);
  });
});

// ---- the cards' routing

const calls: string[] = [];
const env = (o: Partial<PhoneEnv> = {}): PhoneEnv => ({
  native: true, models: () => [model()], catalog: CATALOG, peers: () => [peer(), peer({ id: 'p2', name: 'Tab' })], selfIds: () => ['me', 'w-self'],
  busy: () => false, loaded: () => true, ctx: () => 2048,
  load: async (m, mode, ctx, peers) => { calls.push(`load ${m.id} ${mode} ${ctx} ${peers.map((p) => p.id).join(',')}`); return peers.map((p) => p.id); },
  unload: async () => { calls.push('unload'); },
  fetch: async (c) => { calls.push(`fetch ${c.id}`); },
  probe: async (list) => { calls.push(`probe ${list.map((p) => p.id).join(',')}`); return { ok: list.length, bad: 0 }; },
  open: (to) => { calls.push(`open ${to}`); },
  openBranch: (b) => { calls.push(`branch ${b}`); },
  ...o,
});
const run = async (a: SuggestAction, e = env()) => {
  const act = route(a, e);
  return act ? act.run() : null;
};

describe('a card\'s tap on the phone', () => {
  beforeEach(() => { calls.length = 0; });

  it('load: here and this phone are alone, apart and split take the paired devices, ctx from the card or the settings', async () => {
    await run({ do: 'load', model: 'qwen', mode: 'here', devices: [] });
    await run({ do: 'load', model: 'qwen.gguf', mode: 'phone', devices: ['w-self'] });
    await run({ do: 'load', model: 'qwen', mode: 'apart', devices: ['me', 'p1', 'p2'], ctx: 4096 });
    await run({ do: 'load', model: 'qwen', mode: 'split', devices: ['p2'] });
    expect(calls).toEqual(['load qwen alone 2048 ', 'load qwen alone 2048 ', 'load qwen apart 4096 p1,p2', 'load qwen split 2048 p2']);
  });

  it('what the phone cannot do gets no button', () => {
    const e = env();
    expect(route({ do: 'load', model: 'not-here', mode: 'here', devices: [] }, e)).toBeNull();          // a model only on the computer
    expect(route({ do: 'load', model: 'qwen', mode: 'phone', devices: ['p1'] }, e)).toBeNull();          // one other phone
    expect(route({ do: 'load', model: 'qwen', mode: 'apart', devices: ['p1', 'stranger'] }, e)).toBeNull();
    expect(route({ do: 'load', model: 'qwen', mode: 'split', devices: [] }, e)).toBeNull();
    // C1: the phone's apart always runs this phone too, so a card that leaves it out gets no button
    expect(route({ do: 'load', model: 'qwen', mode: 'apart', devices: ['p1', 'p2'], here: false }, e)).toBeNull();
    expect(route({ do: 'probe', devices: ['stranger'] }, e)).toBeNull();
    expect(route({ do: 'fetch', model: 'qwen' }, e)).toBeNull();                                         // not a catalog model
    expect(route({ do: 'fetch', model: CATALOG[0].id }, env({ models: () => [model({ id: CATALOG[0].id })] }))).toBeNull();   // already here
    expect(route({ do: 'unload' }, env({ native: false }))).toBeNull();
    expect(route(null, e)).toBeNull();
  });

  it('unload, fetch, probe and open go to the phone\'s engine and pages', async () => {
    expect(await run({ do: 'unload' })).toBe('unloaded');
    expect(await run({ do: 'unload' }, env({ loaded: () => false }))).toBe('nothing was loaded');
    expect(await run({ do: 'fetch', model: CATALOG[0].id })).toBe(`fetching ${CATALOG[0].name}`);
    expect(await run({ do: 'probe', devices: ['p1', 'stranger'] })).toBe('looked again: 1 answered, 0 did not');
    await run({ do: 'open', panel: 'devices' });
    await run({ do: 'open', panel: 'models' });
    await run({ do: 'open', panel: 'settings' });
    await run({ do: 'open', panel: 'branch', branch: 'limits' });
    expect(calls).toEqual(['unload', `fetch ${CATALOG[0].id}`, 'probe p1', 'open /peers', 'open /models', 'open /settings', 'branch limits']);
  });

  it('a load while another is under way is refused', async () => {
    await expect(run({ do: 'load', model: 'qwen', mode: 'here', devices: [] }, env({ busy: () => true }))).rejects.toThrow('already loading');
  });

  it('applyCard carries the card out through the phone, then hides it; dismiss hides it; a gone card says so', async () => {
    const advisor: BranchMaker = () => ({
      id: 'advisor', observe() {},
      view: () => ({ ...dark(), built: true, stat: 'two ideas', suggestions: [
        { id: 'advisor:load', kind: 'suggest', title: 'try qwen here', why: 'it fits', action: { do: 'load', model: 'qwen', mode: 'here', devices: [] } },
        { id: 'advisor:mac', kind: 'suggest', title: 'run it on the mac', why: 'it is faster', action: { do: 'load', model: 'big', mode: 'here', devices: [] } },
      ] }),
    });
    resetEye({ advisor });
    const v = look();
    expect(v.cards.map((c) => c.id)).toEqual(['advisor:load', 'advisor:mac']);
    const e = env();
    expect(actOf(v.cards[0], e)?.kind).toBe('load');
    expect(actOf(v.cards[1], e)).toBeNull();   // drawn without a button
    await expect(applyCard('advisor:load', v.cards[0].action, e)).resolves.toBe('loaded Qwen (alone)');
    expect(calls).toEqual(['load qwen alone 2048 ']);
    expect(look().cards.map((c) => c.id)).toEqual(['advisor:mac']);
    await expect(applyCard('advisor:mac', v.cards[1].action, e)).rejects.toThrow('not here');
    expect(dismissCard('advisor:mac')).toBe(true);
    expect(look().cards).toEqual([]);
    await expect(applyCard('advisor:load', v.cards[0].action, e)).rejects.toThrow('gone');
  });

  it('applyCard carries out only the action the person saw: a device that joined between showing and pressing is refused as changed (A5-phone)', async () => {
    let devices = ['p1'];
    const planner: BranchMaker = () => ({
      id: 'planner', observe() {},
      view: () => ({ ...dark(), built: true, stat: 'one plan', suggestions: [
        { id: 'planner:apart:m', kind: 'suggest', title: 'run qwen apart', why: 'it fits across', action: { do: 'load', model: 'qwen', mode: 'apart', devices: [...devices] } },
      ] }),
    });
    resetEye({ planner });
    const shown = look().cards[0];
    expect(shown.id).toBe('planner:apart:m');
    const first = shown.action!;
    devices = ['p1', 'p2'];   // the tablet joins before the tap
    const now = look().cards[0].action!;
    let loads = 0;
    const e = env({ load: async (_m, _mode, _ctx, peers) => { loads++; return peers.map((p) => p.id); } });
    await expect(applyCard('planner:apart:m', first, e)).rejects.toThrow('changed');
    expect(loads).toBe(0);
    await expect(applyCard('planner:apart:m', now, e)).resolves.toMatch(/loaded/);
    expect(loads).toBe(1);
  });

  // D2, the phone half: a load card is hidden while its load runs; a load that throws, or an apart
  // load that resolves with every device the card named left out, shows the card again. Nothing retries.
  const apartCard = (): BranchMaker => () => ({
    id: 'planner', observe() {},
    view: () => ({ ...dark(), built: true, stat: 'one plan', suggestions: [
      { id: 'planner:apart:qwen', kind: 'suggest', title: 'run qwen apart', why: 'it fits across', action: { do: 'load', model: 'qwen', mode: 'apart', devices: ['me', 'p1', 'p2'] } },
    ] }),
  });

  it('route: an apart load that took none of the card\'s devices is not "loaded" (D2-phone)', async () => {
    const a: SuggestAction = { do: 'load', model: 'qwen', mode: 'apart', devices: ['me', 'p1', 'p2'] };
    await expect(run(a, env({ load: async () => [] }))).rejects.toMatchObject({ leftOut: ['Pixel', 'Tab'], model: 'Qwen' });
    await expect(run(a, env({ load: async () => ['p2'] }))).resolves.toBe('loaded Qwen (apart)');   // one joined: that is apart
    await expect(run({ do: 'load', model: 'qwen', mode: 'here', devices: [] }, env({ load: async () => [] }))).resolves.toBe('loaded Qwen (alone)');
  });

  it('route: a split load that used no peer is not "loaded (split)"', async () => {
    const a: SuggestAction = { do: 'load', model: 'qwen', mode: 'split', devices: ['p1'] };
    await expect(run(a, env({ load: async () => [] }))).rejects.toMatchObject({ leftOut: ['Pixel'], model: 'Qwen' });
    await expect(run(a, env({ load: async () => ['p1'] }))).resolves.toBe('loaded Qwen (split)');
  });

  it('applyCard: a split load that used no peer shows the card again; nothing retries', async () => {
    const splitter: BranchMaker = () => ({
      id: 'planner', observe() {},
      view: () => ({ ...dark(), built: true, stat: 'one plan', suggestions: [
        { id: 'planner:split:qwen', kind: 'suggest', title: 'split qwen', why: 'it fits across', action: { do: 'load', model: 'qwen', mode: 'split', devices: ['p1'] } },
      ] }),
    });
    setCurrentLang('en');
    resetEye({ planner: splitter });
    const shown = look().cards[0];
    let loads = 0;
    const e = env({ load: async () => { loads++; return []; } });
    await expect(applyCard(shown.id, shown.action, e)).rejects.toThrow(/Pixel did not join/);
    expect(look().cards.map((c) => c.id)).toEqual(['planner:split:qwen']);
    look();
    expect(loads).toBe(1);
  });

  it('applyCard: an apart load that left every device out shows the card again and says so; nothing retries (D2-phone)', async () => {
    setCurrentLang('en');
    resetEye({ planner: apartCard() });
    const shown = look().cards[0];
    let loads = 0;
    let during: string[] | null = null;
    const e = env({ load: async () => { loads++; during = look().cards.map((c) => c.id); return []; } });
    await expect(applyCard(shown.id, shown.action, e)).rejects.toThrow(/Pixel, Tab did not join.*Qwen runs on this phone alone/);
    expect(during).toEqual([]);   // hidden while it loaded
    expect(look().cards.map((c) => c.id)).toEqual(['planner:apart:qwen']);
    look();
    look();
    expect(loads).toBe(1);
  });

  it('applyCard: a load that throws shows the card again; nothing retries (D2-phone)', async () => {
    resetEye({ planner: apartCard() });
    const shown = look().cards[0];
    let loads = 0;
    let during: string[] | null = null;
    const e = env({ load: async () => { loads++; during = look().cards.map((c) => c.id); throw new Error('toobig'); } });
    await expect(applyCard(shown.id, shown.action, e)).rejects.toThrow('toobig');
    expect(during).toEqual([]);   // hidden while it loaded, like the computer's card
    expect(look().cards.map((c) => c.id)).toEqual(['planner:apart:qwen']);
    look();
    expect(loads).toBe(1);
  });

  it('applyCard: an apart load that took a device stays hidden (D2-phone)', async () => {
    resetEye({ planner: apartCard() });
    const shown = look().cards[0];
    await expect(applyCard(shown.id, shown.action, env({ load: async () => ['p1'] }))).resolves.toBe('loaded Qwen (apart)');
    expect(look().cards).toEqual([]);
  });

  it('an open card needs no match: it only moves the page', async () => {
    const pager: BranchMaker = () => ({
      id: 'advisor', observe() {},
      view: () => ({ ...dark(), built: true, stat: 'see', suggestions: [
        { id: 'advisor:see', kind: 'suggest', title: 'look', why: 'why', action: { do: 'open', panel: 'branch', branch: 'limits' } },
      ] }),
    });
    resetEye({ advisor: pager });
    look();
    calls.length = 0;
    await applyCard('advisor:see', null, env());
    expect(calls).toEqual(['branch limits']);
  });
});
