import { supabase } from '@/lib/supabase';
import { stashProjects, type Project } from '@/data/projects';
import { invalidate, must, outbox, pendingJobs, remember, send } from '@/lib/offline';

// 04_profiles.sql + 05_friends.sql + 06 (friends_kept)
export type FriendRow = { other_id: string; handle: string | null; display_name: string | null; status: 'pending' | 'accepted'; direction: 'incoming' | 'outgoing' };
export async function friendsList(): Promise<FriendRow[]> {
  return remember('friends', '', async () => ((await must(supabase.rpc('friends_list'))) ?? []) as FriendRow[]);
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
  const r = await send({ kind: 'friendRequest', handle });
  return r.queued ? 'queued' : String(r.result);
}
export async function friendAccept(other: string) {
  await send({ kind: 'friendAccept', other });
}
export async function friendRemove(other: string) {
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
  return ((await must(supabase.rpc('people_search', { p_query: query, p_limit: 12 }))) ?? []) as Found[];
}
export async function peopleSuggested(n = 3): Promise<Suggested[]> {
  return remember('suggested', String(n), async () => ((await must(supabase.rpc('people_suggested', { p_limit: n }))) ?? []) as Suggested[]);
}

// A person's public card (profile_card) plus how you stand with them.
export type PersonCard = { id: string; handle: string; display_name: string | null; bio: string | null; city_name: string | null; created_at: string; last_seen_day: string | null; relation: Relation; mutual: number; kept_count: number | null; night_count: number | null };
export async function person(handle: string): Promise<PersonCard | null> {
  const rows = ((await must(supabase.rpc('profile_card', { p_handle: handle }))) ?? []) as PersonCard[];
  return rows[0] ?? null;
}

// Blocking (02): across a block neither side sees the other, finds them, or can ask;
// the friendship goes. The other side is not told. Online only.
export type Blocked = { id: string; handle: string | null; display_name: string | null };
export async function blockUser(other: string) {
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
