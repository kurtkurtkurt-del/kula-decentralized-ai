import type { BranchId, SuggestAction } from '@godseye/core';
import type { CatalogModel } from '@/llm/catalog';
import type { LocalModel, Mode, Peer } from '@/llm/store';

// A card's action on the phone (11.11.2026): the twin of kula-node's POST brain/apply. The eye
// never acts; the person's tap does, through the phone's own engine, the way the person's own
// buttons do. What the phone has: load (a model on this phone, alone, apart or split), unload,
// fetch (a catalog model onto this phone), probe (look at devices again) and open (a page). What
// it cannot do here gets no button: a model only on the computer, 'phone' mode on another phone,
// devices it has not paired. Pure routing; run.ts hands it the real engine (PhoneEnv).

export type PhoneEnv = {
  native: boolean;                                       // llama.cpp on this phone
  models: () => LocalModel[];
  catalog: CatalogModel[];
  peers: () => Peer[];
  selfIds: () => string[];                               // this phone's own ids ('me', its worker id)
  busy: () => boolean;                                   // a load under way
  loaded: () => boolean;
  ctx: () => number;                                     // the person's context setting
  load: (model: LocalModel, mode: Mode, ctx: number, peers: Peer[]) => Promise<void>;
  unload: () => Promise<void>;
  fetch: (model: CatalogModel) => Promise<void>;
  probe: (peers: Peer[]) => Promise<{ ok: number; bad: number }>;
  open: (route: '/peers' | '/models' | '/settings') => void;
  openBranch: (b: BranchId) => void;
};

/** What a tap does: the kind for the button's word, and the work, which says what it did. */
export type PhoneAct = { kind: SuggestAction['do']; run: () => Promise<string> };

const PAGES = { devices: '/peers', models: '/models', settings: '/settings' } as const;

const localOf = (env: PhoneEnv, id: string) => env.models().find((m) => m.id === id || m.file === id) ?? null;

/** The phone's way to carry out an action, or null when the phone has none: then the card shows no button. */
export function route(a: SuggestAction | null, env: PhoneEnv): PhoneAct | null {
  if (!a) return null;
  switch (a.do) {
    case 'load': {
      if (!env.native) return null;
      const model = localOf(env, a.model);
      if (!model) return null;   // not on this phone: a fetch card says so, a load cannot
      const self = new Set(env.selfIds());
      let mode: Mode;
      let peers: Peer[] = [];
      if (a.mode === 'here') mode = 'alone';
      else if (a.mode === 'phone') {
        if (a.devices.some((d) => !self.has(d))) return null;   // one other phone: the computer's to arrange
        mode = 'alone';
      } else {
        // the phone's apart always runs a copy on this phone too: a card that leaves it out has no way here
        if (a.mode === 'apart' && a.here === false) return null;
        const want = new Set(a.devices.filter((d) => !self.has(d)));
        peers = env.peers().filter((p) => want.has(p.id));
        if (!peers.length || peers.length < want.size) return null;   // a device it has not paired
        mode = a.mode;
      }
      const ctx = a.ctx ?? env.ctx();
      return {
        kind: 'load',
        run: async () => {
          if (env.busy()) throw new Error('already loading');
          await env.load(model, mode, ctx, peers);
          return `loaded ${model.name} (${mode})`;
        },
      };
    }
    case 'unload':
      if (!env.native) return null;
      return {
        kind: 'unload',
        run: async () => {
          if (!env.loaded()) return 'nothing was loaded';
          await env.unload();
          return 'unloaded';
        },
      };
    case 'fetch': {
      if (!env.native) return null;
      const c = env.catalog.find((m) => m.id === a.model);
      if (!c || localOf(env, c.id)) return null;
      return { kind: 'fetch', run: async () => { await env.fetch(c); return `fetching ${c.name}`; } };
    }
    case 'probe': {
      const want = new Set(a.devices);
      const peers = env.peers().filter((p) => want.has(p.id));
      if (!env.native || !peers.length) return null;
      return {
        kind: 'probe',
        run: async () => {
          const r = await env.probe(peers);
          return `looked again: ${r.ok} answered, ${r.bad} did not`;
        },
      };
    }
    case 'open':
      if (a.panel === 'branch') {
        const b = a.branch!;
        return { kind: 'open', run: async () => { env.openBranch(b); return 'opened'; } };
      }
      return { kind: 'open', run: async () => { env.open(PAGES[a.panel as keyof typeof PAGES]); return 'opened'; } };
    default:
      return null;
  }
}
