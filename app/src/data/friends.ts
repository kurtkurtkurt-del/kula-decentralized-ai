import { supabase } from '@/lib/supabase';
import { stashProjects, type Project } from '@/data/projects';
import { invalidate, must, outbox, pendingJobs, remember, send } from '@/lib/offline';
import { testPeopleOn } from '@/data/local/gate';
import * as test from '@/data/local/testPeople';

// 04_profiles.sql + 05_friends.sql + 06 (friends_kept)
export type FriendRow = { other_id: string; handle: string | null; display_name: string | null; status: 'pending' | 'accepted'; direction: 'incoming' | 'outgoing' };
export async function friendsList(): Promise<FriendRow[]> {
  const server = () => remember('friends', '', async () => ((await must(supabase.rpc('friends_list'))) ?? []) as FriendRow[]);
  if (!(await testPeopleOn())) return server();
  // with the test people on, a server that cannot be reached leaves just them
  return [...(await server().catch(() => [] as FriendRow[])), ...testFriendRows()];
}

// ---- the test people (data/local/testPeople.ts): kept on the phone, never sent anywhere
function testFriendRows(): FriendRow[] {
  const s = test.loadSocial();
  const now = Date.now();
  return test.TEST_PEOPLE.flatMap((p) => {
    const r = test.relationOf(s, p, now);
    if (r === 'none') return [];
    return [{ other_id: p.id, handle: p.handle, display_name: p.display_name, status: r === 'friend' ? 'accepted' : 'pending', direction: r === 'incoming' ? 'incoming' : 'outgoing' } as FriendRow];
  });
}
const testCard = (p: test.TestPerson, relation: Relation) => ({ id: p.id, handle: p.handle, display_name: p.display_name, city_name: p.city_name, mutual: 0, relation });
function onTest<T>(p: test.TestPerson | null, fn: (s: test.SocialState, p: test.TestPerson) => T): T | undefined {
  if (!p) return undefined;
  const s = test.loadSocial();
  const r = fn(s, p);
  test.saveSocial(s);
  invalidate(...FRIEND_SHELVES, 'dms');
  return r;
}
export type FriendKept = { friend: string; friend_id: string; kept_at: string; id: string; slug: string; title: string; model: string; city_name: string | null };
export async function friendsKept(limit = 60): Promise<FriendKept[]> {
  return remember('friendsKept', String(limit), async () => ((await must(supabase.rpc('friends_kept', { p_limit: limit }))) ?? []) as FriendKept[], 3);
}
// Requests, accepts and removals go through the outbox; each is safe to send twice.
const FRIEND_SHELVES = ['friends', 'friendsKept', 'live', 'suggested', 'personCards', 'callAudience'];
outbox('friendRequest', async (j) => String((await must(supabase.rpc('friend_request', { p_handle: j.handle })))), FRIEND_SHELVES);
outbox('friendAccept', async (j) => { await must(supabase.rpc('friend_accept', { p_other: j.other })); }, FRIEND_SHELVES);
outbox('friendRemove', async (j) => { await must(supabase.rpc('friend_remove', { p_other: j.other })); }, FRIEND_SHELVES);

// The server's answer ('sent', 'accepted', 'notfound' …), or 'queued' while offline.
export async function friendRequest(handle: string): Promise<string> {
  if (test.isTestHandle(handle)) {
    if (!(await testPeopleOn())) return 'notfound';
    const r = onTest(test.testPerson({ handle }), (s, p) => test.request(s, p, Date.now())) ?? 'notfound';
    // they say yes a few seconds later: the screens listening to the friends read again then
    if (r === 'sent') setTimeout(() => invalidate(...FRIEND_SHELVES), test.ACCEPT_AFTER + 200);
    return r;
  }
  const r = await send({ kind: 'friendRequest', handle });
  return r.queued ? 'queued' : String(r.result);
}
export async function friendAccept(other: string) {
  if (test.isTestId(other)) return void onTest(test.testPerson({ id: other }), (s, p) => test.accept(s, p, Date.now()));
  await send({ kind: 'friendAccept', other });
}
export async function friendRemove(other: string) {
  if (test.isTestId(other)) return void onTest(test.testPerson({ id: other }), (s, p) => test.unfriend(s, p, Date.now()));
  await send({ kind: 'friendRemove', other });
}
export function waitingRelations(): Map<string, Relation> {
  const m = new Map<string, Relation>();
  pendingJobs().forEach((j) => {
    if (j.kind === 'friendRequest') m.set(j.handle as string, 'outgoing');
    else if (j.kind === 'friendAccept') m.set(j.other as string, 'friend');
    else if (j.kind === 'friendRemove') m.set(j.other as string, 'none');
  });
  return m;
}

export async function kept(): Promise<Project[]> {
  const list = await remember('kept', '', async () => ((await must(supabase.rpc('kept'))) ?? []) as Project[]);
  stashProjects(list);
  return list;
}

// Finding people (04): the public card only (handle, name, city); people who turned
// discoverable off never appear.
export type Relation = 'none' | 'friend' | 'outgoing' | 'incoming';
export type Person = { id: string; handle: string; display_name: string | null; city_name: string | null; mutual: number };
export type Found = Person & { relation: Relation };
export type Suggested = Person & { reason: 'mutual' | 'city' | 'new' };
export async function peopleSearch(query: string): Promise<Found[]> {
  const server = async () => ((await must(supabase.rpc('people_search', { p_query: query, p_limit: 12 }))) ?? []) as Found[];
  if (!(await testPeopleOn())) return server();
  const q = query.toLowerCase().replace(/^@/, '');
  const s = test.loadSocial();
  const mine = test.TEST_PEOPLE.filter((p) => p.handle.includes(q) || p.display_name.includes(q) || (q === 'test')).map((p) => testCard(p, test.relationOf(s, p, Date.now())));
  return [...mine, ...(await server().catch(() => [] as Found[]))];
}
export async function peopleSuggested(n = 3): Promise<Suggested[]> {
  const server = () => remember('suggested', String(n), async () => ((await must(supabase.rpc('people_suggested', { p_limit: n }))) ?? []) as Suggested[]);
  if (!(await testPeopleOn())) return server();
  const s = test.loadSocial();
  const mine = test.TEST_PEOPLE.filter((p) => test.relationOf(s, p, Date.now()) === 'none').map((p) => ({ ...testCard(p, 'none'), reason: 'new' as const }));
  return [...mine, ...(await server().catch(() => [] as Suggested[]))].slice(0, Math.max(n, mine.length));
}

// A person's public card (profile_card) plus how you stand with them.
export type PersonCard = { id: string; handle: string; display_name: string | null; bio: string | null; city_name: string | null; created_at: string; last_seen_day: string | null; relation: Relation; mutual: number; kept_count: number | null; night_count: number | null };
export async function person(handle: string): Promise<PersonCard | null> {
  if (test.isTestHandle(handle)) {
    const p = test.testPerson({ handle });
    if (!p || !(await testPeopleOn())) return null;
    return { ...testCard(p, test.relationOf(test.loadSocial(), p, Date.now())), bio: p.bio, created_at: '2026-11-06T00:00:00Z', last_seen_day: null, kept_count: 2, night_count: 5 };
  }
  const rows = ((await must(supabase.rpc('profile_card', { p_handle: handle }))) ?? []) as PersonCard[];
  return rows[0] ?? null;
}

// Blocking (02): across a block neither side sees the other, finds them, or can ask;
// the friendship goes. The other side is not told. Online only.
export type Blocked = { id: string; handle: string | null; display_name: string | null };
export async function blockUser(other: string) {
  if (test.isTestId(other)) return void onTest(test.testPerson({ id: other }), (s, p) => test.unfriend(s, p, Date.now()));
  await must(supabase.rpc('block_user', { p_other: other }));
  invalidate(...FRIEND_SHELVES, 'dms', 'callInbox');
}
export async function unblockUser(other: string) {
  await must(supabase.rpc('unblock_user', { p_other: other }));
  invalidate(...FRIEND_SHELVES, 'dms', 'callInbox');
}
export async function myBlocks(): Promise<Blocked[]> {
  return ((await must(supabase.rpc('my_blocks'))) ?? []) as Blocked[];
}
