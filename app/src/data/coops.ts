import { serverText } from '@/lib/serverText';
import { supabase } from '@/lib/supabase';
import { SITE } from '@/data/deck';

// 09_coops.sql. Every call goes through a function that first checks you are in the coop.
export type CoopColor = 'red' | 'gold' | 'blue' | 'green' | 'violet' | 'paper';
export const COOP_COLORS: Record<CoopColor, string> = { red: '#E5322D', gold: '#D9A441', blue: '#3E6FD8', green: '#3FA36B', violet: '#8A5CD6', paper: '#F3F1EC' };
export const COOP_EMOJI = ['🔋', '🌙', '⚡', '🛰️', '🧠', '🔥', '🏫', '🌍', '🛟', '📡', '🧭', '✦'];

export type CoopRow = { id: string; name: string; emoji: string; color: CoopColor; members: number; role: 'owner' | 'member'; tonight_slug: string | null; tonight_title: string | null };
export type Member = { id: string; handle: string | null; name: string | null; role: 'owner' | 'member'; live: boolean };
export type Coop = { id: string; name: string; emoji: string; color: CoopColor; me: string; members: Member[]; tonight: { slug: string; title: string; model: string } | null; nights: number };
export type CoopNight = { night: string; slug: string; title: string; model: string; set_by: string | null; phones: number; tokens: number; kwh: number; credits: number };
export type Peek = { id: string; name: string; emoji: string; color: CoopColor; members: number; mine: boolean; open: boolean };
export type CoopForm = { name: string; emoji: string; color: CoopColor };

const rpc = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
};
export const myCoops = () => rpc<CoopRow[]>('my_coops');
export const coopGet = (id: string) => rpc<Coop>('coop_get', { p_id: id });
export const coopCreate = (f: CoopForm, members: string[]) => rpc<string>('coop_create', { p_name: f.name, p_emoji: f.emoji, p_color: f.color, p_members: members });
export const coopUpdate = (id: string, f: CoopForm) => rpc<void>('coop_update', { p_id: id, p_name: f.name, p_emoji: f.emoji, p_color: f.color });
export const coopAdd = (id: string, users: string[]) => rpc<number>('coop_add', { p_id: id, p_users: users });
export const coopRemove = (id: string, user: string) => rpc<void>('coop_remove', { p_id: id, p_user: user });
export const coopLeave = (id: string) => rpc<void>('coop_leave', { p_id: id });
export const coopDelete = (id: string) => rpc<void>('coop_delete', { p_id: id });
export const coopInvite = (id: string) => rpc<string>('coop_invite', { p_id: id });
export const coopPeek = async (code: string) => (await rpc<Peek[]>('coop_peek', { p_code: code }))?.[0] ?? null;
export const coopJoin = (code: string) => rpc<string>('coop_join', { p_code: code });
export const coopNightSet = (id: string, night: string, slug: string) => rpc<void>('coop_night_set', { p_id: id, p_night: night, p_slug: slug });
export const coopNights = (id: string) => rpc<CoopNight[]>('coop_nights', { p_id: id });
// The link in an invitation: a page on the site that opens the app.
export const inviteUrl = (code: string) => `${SITE}g/?c=${encodeURIComponent(code)}`;
export const why = (e: unknown) => serverText(e);

// Tonight as the server counts it: the evening a night starts (before 12:00 is the night before).
export function tonight(): string {
  const d = new Date(Date.now() - 12 * 3600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
