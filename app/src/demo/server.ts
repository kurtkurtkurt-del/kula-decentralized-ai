// The demo server (21.10.2026: "no Supabase for now, just random examples"). A build with no
// live server runs on this: every question the app asks is answered from the example world
// in snapshot.json (made by tools/demo-snapshot.mjs from a real local server, so the shapes
// are the real ones), and what the user does — keep a project, write a friend, measure the
// phone, finish a night, start a coop or a call — changes that world and stays on the phone
// (client.ts saves it). Pure functions: state in, answer out; tested in __tests__/demo.test.ts.
import snapshot from './snapshot.json';

type Row = Record<string, any>;
export type DemoState = Row & { joins: Record<string, 'right' | 'left'>; blocks: Row[]; open: Row | null; seq: number };
export type Answer = { data: unknown; error: { message: string } | null };

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
export const SNAPSHOT = snapshot as Row;
export const ME = SNAPSHOT.me as { id: string; handle: string; email: string };

export function freshState(): DemoState {
  return { ...copy(SNAPSHOT), blocks: [], open: null, seq: 1000 } as unknown as DemoState;
}

const ok = (data: unknown): Answer => ({ data, error: null });
const no = (message: string): Answer => ({ data: null, error: { message } });
const uuid = (s: DemoState) => `00000000-0000-4000-8000-${String(++s.seq).padStart(12, '0')}`;
const project = (s: DemoState, slug: string) => (s.projects as Row[]).find((p) => p.slug === slug);
const relationOf = (s: DemoState, handle: string): 'friend' | 'outgoing' | 'incoming' | 'none' => {
  const f = (s.friends_list as Row[]).find((r) => r.handle === handle);
  if (!f) return 'none';
  return f.status === 'accepted' ? 'friend' : f.direction;
};
const personOf = (s: DemoState, key: { handle?: string; id?: string }) =>
  Object.values(s.people as Record<string, { card: Row[]; cards: Row[] }>).map((p) => p.card[0]).find((c) => c && (c.handle === key.handle || c.id === key.id));
const keptProjects = (s: DemoState) => (s.projects as Row[]).filter((p) => s.joins[p.slug] === 'right');

/** Answers one rpc as the server would. Writes change `s` in place. */
export function demoRpc(s: DemoState, name: string, a: Row = {}): Answer {
  switch (name) {
    // ---- the projects
    case 'kept':
      return ok(keptProjects(s));
    case 'join_set':
      s.joins[a.p_slug] = a.p_direction;
      return ok(null);
    case 'join_unset':
      delete s.joins[a.p_slug];
      return ok(null);
    case 'project_page': {
      const page = copy(s.project_pages[a.p_slug] ?? []);
      if (page[0]) page[0].kept = s.joins[a.p_slug] === 'right';
      return ok(page);
    }
    case 'about_for':
      return ok(((s.about[a.p_lang] ?? s.about.en) as Row[]).filter((r) => (a.p_projects ?? []).includes(r.project_id)));
    case 'samples_for':
      return ok(((s.samples[a.p_lang] ?? s.samples.en) as Row[]).filter((r) => (a.p_projects ?? []).includes(r.project_id)));

    // ---- you
    case 'profile_me':
      return ok(s.profile_me);
    case 'settings_set':
      Object.assign(s.profile_me[0], a.p_patch ?? {});
      return ok(null);
    case 'profile_setup': {
      if (!/^[a-z0-9_]{3,20}$/.test(a.p_handle ?? '')) return ok('format');
      const city = (s.network_nodes as Row[]).find((c) => c.city_slug === a.p_city_slug);
      Object.assign(s.profile_me[0], { handle: a.p_handle, display_name: a.p_display_name, bio: a.p_bio, city_slug: city?.city_slug ?? null, city_name: city?.city_name ?? null });
      return ok('ok');
    }
    case 'handle_status':
      if (!/^[a-z0-9_]{3,20}$/.test(a.p_handle ?? '')) return ok('format');
      if (a.p_handle === s.profile_me[0]?.handle) return ok('yours');
      return ok(personOf(s, { handle: a.p_handle }) ? 'taken' : 'ok');
    case 'passport_save': {
      const id = uuid(s);
      s.passport_mine.unshift({ id, data: a.p_data, measured_at: a.p_data?.measured_at ?? new Date().toISOString() });
      return ok(id);
    }
    case 'passport_mine':
      return ok((s.passport_mine as Row[]).slice(0, a.p_limit ?? 10));
    case 'terms_status':
    case 'account_status':
    case 'min_app_version':
    case 'migrations_applied':
    case 'network_nodes':
    case 'device_catalog':
    case 'network_estimate':
    case 'friends_kept':
    case 'friends_live':
    case 'call_audience':
      return ok(s[name]);
    case 'accept_terms':
      s.terms_status = [{ version: a.p_version, at: new Date().toISOString() }];
      return ok(null);

    // ---- nights and cards
    case 'contribution_start': {
      const p = project(s, a.p_slug);
      if (!p) return no('noproject');
      if (s.joins[a.p_slug] !== 'right') return no('notkept');
      s.open = { id: uuid(s), slug: p.slug, title: p.title, model: p.model, started_at: a.p_at ?? new Date().toISOString() };
      return ok(s.open.id);
    }
    case 'contribution_open':
      return ok(s.open ? [s.open] : []);
    case 'contribution_end': {
      if (!s.open || s.open.id !== a.p_id) return no('nonight');
      const p = project(s, s.open.slug)!;
      const cardNo = Math.max(0, ...(s.my_cards as Row[]).map((c) => c.card_no)) + 1;
      const credits = Math.round(((a.p_tokens ?? 0) / 1000) * (Number(p.params_b) / 7) * 100) / 100;
      const at = a.p_at ?? new Date().toISOString();
      s.my_cards.unshift({ card_no: cardNo, started_at: s.open.started_at, ended_at: at, tokens: a.p_tokens ?? 0, seconds: a.p_seconds ?? 0, kwh: String(a.p_kwh ?? 0), credits: String(credits),
        slug: p.slug, title: p.title, model: p.model, org: p.org, city_name: p.city_name, poster_no: p.poster_no, image_url: p.image_url, night_no: (s.my_cards as Row[]).filter((c) => c.slug === p.slug).length + 1, crew: [], crew_more: 0 });
      s.credits_mine.unshift({ id: cardNo, amount: String(credits), weight: String(Math.round((Number(p.params_b) / 7) * 10000) / 10000), slug: p.slug, title: p.title, card_no: cardNo, created_at: at });
      s.profile_me[0].credits = Math.round((Number(s.profile_me[0].credits ?? 0) + credits) * 100) / 100;
      s.open = null;
      return ok(cardNo);
    }
    case 'my_cards':
    case 'credits_mine':
      return ok(s[name]);

    // ---- people
    case 'friends_list':
      return ok(s.friends_list);
    case 'friend_request': {
      const p = personOf(s, { handle: a.p_handle });
      if (!p) return ok(a.p_handle === s.profile_me[0]?.handle ? 'yourself' : 'notfound');
      const f = (s.friends_list as Row[]).find((r) => r.handle === p.handle);
      if (f?.status === 'accepted') return ok('accepted');
      if (f?.direction === 'incoming') { f.status = 'accepted'; return ok('accepted'); }
      if (!f) s.friends_list.push({ other_id: p.id, handle: p.handle, display_name: p.display_name, status: 'pending', direction: 'outgoing' });
      return ok('sent');
    }
    case 'friend_accept': {
      const f = (s.friends_list as Row[]).find((r) => r.other_id === a.p_other);
      if (f) f.status = 'accepted';
      return ok(null);
    }
    case 'friend_remove':
      s.friends_list = (s.friends_list as Row[]).filter((r) => r.other_id !== a.p_other);
      return ok(null);
    case 'people_search': {
      const q = String(a.p_query ?? '').toLowerCase().replace(/^@/, '');
      return ok(Object.values(s.people as Record<string, { card: Row[] }>).map((p) => p.card[0]).filter((c) => c && (c.handle.includes(q) || String(c.display_name ?? '').toLowerCase().includes(q)))
        .slice(0, a.p_limit ?? 12).map((c) => ({ id: c.id, handle: c.handle, display_name: c.display_name, city_name: c.city_name, mutual: c.mutual, relation: relationOf(s, c.handle) })));
    }
    case 'people_suggested':
      return ok((s.people_suggested as Row[]).filter((p) => relationOf(s, p.handle) === 'none').slice(0, a.p_limit ?? 3));
    case 'profile_card': {
      const c = personOf(s, { handle: a.p_handle });
      return ok(c ? [{ ...c, relation: relationOf(s, c.handle) }] : []);
    }
    case 'person_cards':
      return ok(relationOf(s, a.p_handle) === 'friend' ? s.people[a.p_handle]?.cards ?? [] : []);
    case 'my_blocks':
      return ok(s.blocks);
    case 'block_user': {
      const c = personOf(s, { id: a.p_other });
      if (c && !s.blocks.some((b) => b.id === c.id)) s.blocks.push({ id: c.id, handle: c.handle, display_name: c.display_name });
      s.friends_list = (s.friends_list as Row[]).filter((r) => r.other_id !== a.p_other);
      return ok(null);
    }
    case 'unblock_user':
      s.blocks = s.blocks.filter((b) => b.id !== a.p_other);
      return ok(null);

    // ---- messages
    case 'dm_list':
      return ok(s.dm_list);
    case 'dm_thread':
      return ok(((s.dm_threads[a.p_thread] ?? []) as Row[]).filter((l) => l.id > (a.p_after ?? 0)));
    case 'dm_start': {
      const p = personOf(s, { handle: a.p_handle });
      if (!p) return no('no person');
      if (relationOf(s, p.handle) !== 'friend') return no('friends only');
      const found = (s.dm_list as Row[]).find((d) => d.handle === p.handle);
      if (found) return ok(found.id);
      const id = uuid(s);
      s.dm_list.unshift({ id, other_id: p.id, handle: p.handle, name: p.display_name, last_body: null, last_mine: false, last_id: 0, last_at: new Date().toISOString(), unread: 0 });
      s.dm_threads[id] = [];
      return ok(id);
    }
    case 'dm_send': {
      const lines = (s.dm_threads[a.p_thread] ??= []) as Row[];
      const id = Math.max(0, ...Object.values(s.dm_threads as Record<string, Row[]>).flat().map((l) => l.id)) + 1;
      const at = new Date().toISOString();
      lines.push({ id, user_id: ME.id, name: s.profile_me[0]?.display_name ?? 'you', body: a.p_body, created_at: at, mine: true });
      const d = (s.dm_list as Row[]).find((x) => x.id === a.p_thread);
      if (d) Object.assign(d, { last_body: a.p_body, last_mine: true, last_id: id, last_at: at });
      return ok(id);
    }
    case 'dm_seen': {
      const d = (s.dm_list as Row[]).find((x) => x.id === a.p_thread);
      if (d) d.unread = 0;
      return ok(null);
    }
    case 'dm_unsay':
      for (const k of Object.keys(s.dm_threads)) s.dm_threads[k] = (s.dm_threads[k] as Row[]).filter((l) => !(l.id === a.p_id && l.mine));
      return ok(null);

    // ---- coops
    case 'my_coops':
      return ok(s.my_coops);
    case 'coop_get':
      return s.coops[a.p_id] ? ok(s.coops[a.p_id]) : no('coop');
    case 'coop_nights':
      return ok(s.coop_nights[a.p_id] ?? []);
    case 'coop_create': {
      const id = uuid(s);
      const me = s.profile_me[0];
      const members = [{ id: ME.id, handle: me.handle, name: me.display_name, role: 'owner', live: false },
        ...((a.p_members ?? []) as string[]).map((m) => personOf(s, { id: m })).filter(Boolean).map((c: any) => ({ id: c.id, handle: c.handle, name: c.display_name, role: 'member', live: false }))];
      s.coops[id] = { id, name: a.p_name, emoji: a.p_emoji, color: a.p_color, me: ME.id, members, tonight: null, nights: 0 };
      s.coop_nights[id] = [];
      s.my_coops.unshift({ id, name: a.p_name, emoji: a.p_emoji, color: a.p_color, members: members.length, role: 'owner', tonight_slug: null, tonight_title: null });
      return ok(id);
    }
    case 'coop_update': {
      for (const o of [s.coops[a.p_id], (s.my_coops as Row[]).find((c) => c.id === a.p_id)]) if (o) Object.assign(o, { name: a.p_name, emoji: a.p_emoji, color: a.p_color });
      return ok(null);
    }
    case 'coop_night_set': {
      const p = project(s, a.p_slug);
      if (!p) return no('noproject');
      if (s.coops[a.p_id]) s.coops[a.p_id].tonight = { slug: p.slug, title: p.title, model: p.model };
      const row = (s.my_coops as Row[]).find((c) => c.id === a.p_id);
      if (row) Object.assign(row, { tonight_slug: p.slug, tonight_title: p.title });
      return ok(null);
    }
    case 'coop_leave':
    case 'coop_delete':
      s.my_coops = (s.my_coops as Row[]).filter((c) => c.id !== a.p_id);
      delete s.coops[a.p_id];
      return ok(null);
    case 'coop_add':
      return ok(0);
    case 'coop_remove': {
      const c = s.coops[a.p_id];
      if (c) c.members = (c.members as Row[]).filter((m) => m.id !== a.p_user);
      return ok(null);
    }
    case 'coop_invite':
      return ok('DEMOKULA');
    case 'coop_peek':
      return ok([]);
    case 'coop_join':
      return no('code');

    // ---- calls
    case 'call_inbox':
    case 'call_mine':
      return ok(s[name]);
    case 'call_people':
      return ok(s.call_people[a.p_call] ?? []);
    case 'call_answer': {
      const c = (s.call_inbox as Row[]).find((x) => x.id === a.p_call);
      if (c) c.mine = a.p_answer;
      return ok(null);
    }
    case 'call_create': {
      const p = project(s, a.p_slug);
      if (!p) return no('noproject');
      const id = uuid(s);
      s.call_mine.unshift({ id, slug: p.slug, title: p.title, model: p.model, night: `${a.p_night}T00:00:00.000Z`, reach: a.p_reach, note: a.p_note, going: 0, not_going: 0 });
      s.call_people[id] = [{ handle: s.profile_me[0]?.handle, display_name: s.profile_me[0]?.display_name, host: true }];
      return ok(id);
    }
    case 'call_cancel':
      s.call_mine = (s.call_mine as Row[]).filter((c) => c.id !== a.p_call);
      return ok(null);

    // ---- the account
    case 'export_me':
      return ok({ profile: s.profile_me[0], passports: (s.passport_mine as Row[]).map((p) => p.data), nights: s.my_cards, friends: s.friends_list, note: 'demo: example data' });
    case 'delete_account':
      Object.assign(s, freshState());
      return ok(null);
    case 'report':
    case 'feedback_send':
    case 'log_error':
    case 'push_register':
    case 'push_unregister':
      return ok(null);

    // ---- staff and admin: the demo user is neither
    case 'staff_projects':
    case 'staff_reports':
    case 'feedback_list':
    case 'admin_errors':
    case 'admin_people':
      return ok([]);
    default:
      return no(`demo: ${name} is not part of the example world`);
  }
}
