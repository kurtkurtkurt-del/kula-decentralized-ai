import { serverText } from '@/lib/serverText';
import { supabase } from '@/lib/supabase';
import { invalidate, outbox, pendingJobs, remember, send } from '@/lib/offline';
import { testPeopleOn } from '@/data/local/gate';
import * as test from '@/data/local/testPeople';

// Direct messages (11_dms.sql): friends only, one thread per pair. The tables are
// closed; these calls are the only way in. The server keeps the last line each side
// has seen (dm_seen).
export type DmThread = { id: string; other_id: string; handle: string | null; name: string | null; last_body: string | null; last_mine: boolean | null; last_id: number | null; last_at: string; unread: number };
export type DmLine = { id: number; user_id: string; name: string | null; body: string; created_at: string; mine: boolean };

const rpc = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
};

export async function dmList(): Promise<DmThread[]> {
  const server = () => remember('dms', '', () => rpc<DmThread[]>('dm_list'));
  if (!(await testPeopleOn())) return server();
  return [...testThreads(), ...(await server().catch(() => [] as DmThread[]))];
}
export async function dmStart(handle: string): Promise<string> {
  if (test.isTestHandle(handle)) {
    const p = test.testPerson({ handle });
    if (!p || !(await testPeopleOn())) throw new Error('no such person');
    if (test.relationOf(test.loadSocial(), p, Date.now()) !== 'friend') throw new Error('friends only');
    return test.threadOf(p.handle);
  }
  return rpc<string>('dm_start', { p_handle: handle });
}
// A line goes through the outbox: offline it waits on the phone and leaves when the
// connection is back, in order; the job's id goes with it so a retry is stored once.
outbox('dmSend', async (j) => {
  const id = await rpc<number>('dm_send', { p_thread: j.thread, p_body: j.body, p_client_id: j.id });
  dmPing(j.thread as string);
  return id;
}, ['dms']);
export async function dmSend(thread: string, body: string): Promise<number | null> {
  if (test.isTestThread(thread)) return testSay(thread, body);
  const r = await send({ kind: 'dmSend', thread, body });
  return r.queued ? null : Number(r.result);
}
export const dmWaiting = (thread: string) => test.isTestThread(thread) ? [] : pendingJobs('dmSend').filter((j) => j.thread === thread).map((j) => ({ id: -j.at, body: String(j.body), at: new Date(j.at).toISOString() }));
export const dmSeen = (thread: string, id: number) => test.isTestThread(thread) ? testSeen(thread, id) : rpc<void>('dm_seen', { p_thread: thread, p_id: id }).then(() => invalidate('dms')).catch(() => {});

// One broadcast channel per thread: no rows travel, only "look again".
export function dmPing(thread: string) {
  if (test.isTestThread(thread)) return heard.get(thread)?.forEach((fn) => fn());
  const ch = supabase.channel('dm:' + thread);
  ch.subscribe((state) => {
    if (state !== 'SUBSCRIBED') return;
    ch.send({ type: 'broadcast', event: 'line', payload: {} }).finally(() => supabase.removeChannel(ch));
  });
}
export function dmListen(thread: string, onLine: () => void) {
  if (test.isTestThread(thread)) {
    const set = heard.get(thread) ?? new Set();
    heard.set(thread, set.add(onLine));
    return () => {
      set.delete(onLine);
    };
  }
  const ch = supabase.channel('dm:' + thread).on('broadcast', { event: 'line' }, onLine).subscribe();
  return () => {
    supabase.removeChannel(ch);
  };
}
export async function dmUnsay(id: number, thread?: string) {
  if (thread && test.isTestThread(thread)) return withTest(thread, (s, p) => test.unsay(s, p.handle, id));
  return rpc<void>('dm_unsay', { p_id: id });
}
export async function dmThread(thread: string, after: number): Promise<DmLine[]> {
  if (test.isTestThread(thread)) {
    const p = test.testPerson({ thread });
    if (!p) throw new Error('no such conversation');
    const s = test.loadSocial();
    const lines = test.linesAfter(s, p.handle, after, Date.now());
    test.saveSocial(s);
    return lines.map((l) => ({ id: l.id, user_id: l.mine ? 'me' : p.id, name: l.mine ? null : p.display_name, body: l.body, created_at: l.at, mine: l.mine }));
  }
  return rpc<DmLine[]>('dm_thread', { p_thread: thread, p_after: after });
}

// ---- conversations with the test people (data/local/testPeople.ts), on the phone only
const heard = new Map<string, Set<() => void>>();
function withTest<T>(thread: string, fn: (s: test.SocialState, p: test.TestPerson) => T): T {
  const p = test.testPerson({ thread });
  if (!p) throw new Error('no such conversation');
  const s = test.loadSocial();
  const r = fn(s, p);
  test.saveSocial(s);
  return r;
}
function testSay(thread: string, body: string): number {
  const { id, due } = withTest(thread, (s, p) => test.say(s, p, body, Date.now()));
  invalidate('dms');
  // their answer is due in a moment: tell the open conversation and the list
  setTimeout(() => {
    dmPing(thread);
    invalidate('dms');
  }, Math.max(0, due - Date.now()) + 50);
  return id;
}
async function testSeen(thread: string, id: number) {
  withTest(thread, (s, p) => test.markSeen(s, p.handle, id));
  invalidate('dms');
}
function testThreads(): DmThread[] {
  const s = test.loadSocial();
  test.settle(s, Date.now());
  test.saveSocial(s);
  return test.startedThreads(s).flatMap((h) => {
    const p = test.testPerson({ handle: h });
    if (!p) return [];
    const lines = s.threads[h].lines;
    const last = lines[lines.length - 1];
    return [{ id: test.threadOf(h), other_id: p.id, handle: p.handle, name: p.display_name, last_body: last?.body ?? null, last_mine: last?.mine ?? null, last_id: last?.id ?? null, last_at: last?.at ?? new Date().toISOString(), unread: test.unread(s, h) }];
  });
}
export const why = (e: unknown) => serverText(e);
