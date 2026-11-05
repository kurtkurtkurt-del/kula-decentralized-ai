import { supabase } from '@/lib/supabase';
import { invalidate, must, outbox, pendingJobs, remember, send } from '@/lib/offline';

// 10_calls.sql: a friend starts a project night; it travels in waves. The tables are
// closed; these calls are the only way in.
export type Reach = 1 | 2 | 3;
export type CallInvite = { id: string; slug: string; title: string; model: string; night: string; note: string | null; host_handle: string | null; host_name: string | null; going: number; wave: number; mine: 'waiting' | 'in' | 'out' };
export type MyCall = { id: string; slug: string; title: string; model: string; night: string; reach: number; note: string | null; going: number; not_going: number };
export type Audience = { wave1: number; wave2: number; wave3: number };
export type CallPerson = { handle: string | null; display_name: string | null; host: boolean };

export async function callCreate(slug: string, night: string, reach: Reach, note: string | null): Promise<string> {
  const { data, error } = await supabase.rpc('call_create', { p_slug: slug, p_night: night, p_reach: reach, p_note: note });
  if (error) throw error;
  invalidate('callMine', 'kept');
  return String(data);
}
export async function callAudience(): Promise<Audience | null> {
  const data = await remember('callAudience', '', () => must(supabase.rpc('call_audience'))).catch(() => null);
  return ((data ?? []) as Audience[])[0] ?? null;
}

// Answers and cancels still in the outbox: call id → answer ('cancel' for your own).
function waiting() {
  const m = new Map<string, string>();
  pendingJobs().forEach((j) => {
    if (j.kind === 'callAnswer') m.set(j.call as string, j.answer as string);
    else if (j.kind === 'callCancel') m.set(j.call as string, 'cancel');
  });
  return m;
}
export async function callInbox(): Promise<CallInvite[]> {
  const list = await remember('callInbox', '', async () => ((await must(supabase.rpc('call_inbox'))) ?? []) as CallInvite[]).catch(() => [] as CallInvite[]);
  const w = waiting();
  return list.filter((i) => !['in', 'out', 'cancel'].includes(w.get(i.id) ?? ''));
}
const CALL_SHELVES = ['callInbox', 'callMine', 'callPeople', 'kept'];
outbox(
  'callAnswer',
  async (j) => {
    const { error } = await supabase.rpc('call_answer', { p_call: j.call, p_answer: j.answer });
    if (error) throw error;
  },
  CALL_SHELVES,
);
outbox(
  'callCancel',
  async (j) => {
    const { error } = await supabase.rpc('call_cancel', { p_call: j.call });
    if (error) throw error;
  },
  CALL_SHELVES,
);
export async function callAnswer(call: string, answer: 'in' | 'out' | 'waiting') {
  await send({ kind: 'callAnswer', call, answer });
}
export async function callCancel(call: string) {
  await send({ kind: 'callCancel', call });
}
export async function callMine(): Promise<MyCall[]> {
  const list = await remember('callMine', '', async () => ((await must(supabase.rpc('call_mine'))) ?? []) as MyCall[]).catch(() => [] as MyCall[]);
  const w = waiting();
  return list.filter((c) => w.get(c.id) !== 'cancel');
}
export async function callPeople(id: string): Promise<CallPerson[]> {
  return remember('callPeople', id, async () => ((await must(supabase.rpc('call_people', { p_call: id }))) ?? []) as CallPerson[], 20).catch(() => []);
}
// One call as the page sees it: from the inbox, or from yours.
export async function callGet(id: string): Promise<{ invite: CallInvite | null; mine: MyCall | null }> {
  const [inbox, mine] = await Promise.all([callInbox(), callMine()]);
  return { invite: inbox.find((c) => c.id === id) ?? null, mine: mine.find((c) => c.id === id) ?? null };
}
