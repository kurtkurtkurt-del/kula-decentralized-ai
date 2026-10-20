import { dmList, dmSeen, type DmThread } from '@/data/dms';

// Messages: the direct conversations, with what is new (the server keeps the mark).
export const markDmSeen = (id: string, lastLine: number) => dmSeen(id, lastLine);
export type Inbox = { dms: DmThread[]; unread: number };
export async function inbox(): Promise<Inbox> {
  const dms = await dmList().catch(() => [] as DmThread[]);
  return { dms, unread: dms.reduce((n, d) => n + (d.unread ?? 0), 0) };
}
