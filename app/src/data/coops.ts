import { serverText } from '@/lib/serverText';
import { supabase } from '@/lib/supabase';
import { SITE } from '@/data/projects';
import { loadProfile } from '@/data/profile';
import { testPeopleOn } from '@/data/local/gate';
import * as local from '@/data/local/coops';
import { t } from '@/i18n/core';

// Coops (6.11.2026: kept on the phone, no server tables; the old 09_coops.sql calls are gone
// from the app). data/local/coops.ts holds them per account in kv-store; this file keeps the
// names and shapes the screens always used.
export type CoopColor = local.CoopColor;
export const COOP_COLORS: Record<CoopColor, string> = { red: '#E5322D', gold: '#D9A441', blue: '#3E6FD8', green: '#3FA36B', violet: '#8A5CD6', paper: '#F3F1EC' };
export const COOP_EMOJI = ['🔋', '🌙', '⚡', '🛰️', '🧠', '🔥', '🏫', '🌍', '🛟', '📡', '🧭', '✦'];

export type CoopRow = { id: string; name: string; emoji: string; color: CoopColor; members: number; role: 'owner' | 'member'; tonight_slug: string | null; tonight_title: string | null };
export type Member = local.Member;
export type Coop = { id: string; name: string; emoji: string; color: CoopColor; me: 'owner' | 'member'; members: Member[]; tonight: local.Tonight | null; nights: number };
export type CoopNight = local.CoopNight;
export type Peek = local.Peek;
export type CoopForm = local.CoopForm;
/** Someone to put in a coop: a friend's id, handle and name. */
export type CoopPerson = local.Me;

async function whoAmI(): Promise<local.Me> {
  const { data } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
  const id = data.session?.user?.id ?? 'guest';
  const p = await loadProfile().catch(() => null);
  return { id, handle: p?.handle ?? null, name: p?.display_name ?? p?.handle ?? t('word.you') };
}
// Read (and for a write, save) the coops of the account on this phone.
async function withCoops<T>(fn: (s: local.CoopState, me: local.Me) => T, write = false): Promise<T> {
  const me = await whoAmI();
  const s = local.loadCoops(me.id);
  const r = fn(s, me);
  if (write) local.saveCoops(me.id, s);
  return r;
}

export const myCoops = (): Promise<CoopRow[]> => withCoops((s) => local.list(s));
export const coopGet = (id: string): Promise<Coop> => withCoops((s) => local.get(s, id));
export const coopCreate = (f: CoopForm, members: CoopPerson[]) => withCoops((s, me) => local.create(s, me, f, members), true);
export const coopUpdate = (id: string, f: CoopForm) => withCoops((s) => local.update(s, id, f), true);
export const coopAdd = (id: string, people: CoopPerson[]) => withCoops((s) => local.add(s, id, people), true);
export const coopRemove = (id: string, user: string) => withCoops((s) => local.remove(s, id, user), true);
export const coopLeave = (id: string) => withCoops((s) => local.leave(s, id), true);
export const coopDelete = (id: string) => withCoops((s) => local.leave(s, id), true);
export const coopInvite = (id: string) => withCoops((s) => local.invite(s, id));
export const coopPeek = async (code: string) => {
  const on = await testPeopleOn();
  return withCoops((s) => local.peek(s, code, on));
};
export const coopJoin = async (code: string) => {
  const on = await testPeopleOn();
  return withCoops((s, me) => local.join(s, me, code, on), true);
};
export const coopNightSet = (id: string, _night: string, project: local.Tonight) => withCoops((s) => local.setTonight(s, id, { slug: project.slug, title: project.title, model: project.model }), true);
export const coopNights = (id: string) => withCoops((s) => local.nights(s, id));
export const testCoopCodes = local.testCodes;
// The link in an invitation: a page on the site that opens the app.
export const inviteUrl = (code: string) => `${SITE}g/?c=${encodeURIComponent(code)}`;
export const why = (e: unknown) => {
  const m = String((e as { message?: string })?.message ?? e);
  return m === 'name' ? t('social.coop.name') : serverText(e);
};

// Tonight as the server counts it: the evening a night starts (before 12:00 is the night before).
export function tonight(): string {
  const d = new Date(Date.now() - 12 * 3600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
