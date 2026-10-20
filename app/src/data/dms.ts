import { serverText } from '@/lib/serverText';
import { supabase } from '@/lib/supabase';
import { invalidate, must, outbox, pendingJobs, remember, send } from '@/lib/offline';

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

export const dmList = () => remember('dms', '', () => rpc<DmThread[]>('dm_list'));
export const dmStart = (handle: string) => rpc<string>('dm_start', { p_handle: handle });
// A line goes through the outbox: offline it waits on the phone and leaves when the
// connection is back, in order; the job's id goes with it so a retry is stored once.
outbox('dmSend', async (j) => {
  const id = await rpc<number>('dm_send', { p_thread: j.thread, p_body: j.body, p_client_id: j.id });
  dmPing(j.thread as string);
  return id;
}, ['dms']);
export async function dmSend(thread: string, body: string): Promise<number | null> {
  const r = await send({ kind: 'dmSend', thread, body });
  return r.queued ? null : Number(r.result);
}
export const dmWaiting = (thread: string) => pendingJobs('dmSend').filter((j) => j.thread === thread).map((j) => ({ id: -j.at, body: String(j.body), at: new Date(j.at).toISOString() }));
export const dmSeen = (thread: string, id: number) => rpc<void>('dm_seen', { p_thread: thread, p_id: id }).then(() => invalidate('dms')).catch(() => {});

// One broadcast channel per thread: no rows travel, only "look again".
export function dmPing(thread: string) {
  const ch = supabase.channel('dm:' + thread);
  ch.subscribe((state) => {
    if (state !== 'SUBSCRIBED') return;
    ch.send({ type: 'broadcast', event: 'line', payload: {} }).finally(() => supabase.removeChannel(ch));
  });
}
export function dmListen(thread: string, onLine: () => void) {
  const ch = supabase.channel('dm:' + thread).on('broadcast', { event: 'line' }, onLine).subscribe();
  return () => {
    supabase.removeChannel(ch);
  };
}
export const dmUnsay = (id: number) => rpc<void>('dm_unsay', { p_id: id });
export const dmThread = (thread: string, after: number) => rpc<DmLine[]>('dm_thread', { p_thread: thread, p_after: after });
export const why = (e: unknown) => serverText(e);
