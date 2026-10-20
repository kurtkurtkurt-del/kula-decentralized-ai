import { serverText } from '@/lib/serverText';
import { useEffect, useState } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthContext';
import { loadProfile } from '@/data/profile';

// The panel (12_about.sql, 14_safety.sql). Every staff write is a function with its own
// check in the database; what this file hides or shows is only for looks, the rule is there.

// ------------------------------------------------------------------ the role
// The last answer is kept on the phone so the panel mark is there at once on launch.
const KEY = 'role';
let current: 'admin' | 'user' | null = (Storage.getItemSync(KEY) as 'admin' | 'user' | null) ?? null;
const listeners = new Set<(r: typeof current) => void>();
const announce = (r: typeof current) => {
  current = r;
  try {
    if (r) Storage.setItemSync(KEY, r);
    else Storage.removeItemSync(KEY);
  } catch {}
  listeners.forEach((l) => l(r));
};
export async function refreshRole() {
  const me = await loadProfile().catch(() => null);
  announce(me ? (me.is_admin ? 'admin' : 'user') : null);
}
export function useRole() {
  const { session, isAnonymous } = useAuth();
  const [role, setRole] = useState(current);
  const uid = session?.user.id;
  useEffect(() => {
    listeners.add(setRole);
    return () => {
      listeners.delete(setRole);
    };
  }, []);
  useEffect(() => {
    if (!uid || isAnonymous) announce(null);
    else refreshRole().catch(() => {});
  }, [uid, isAnonymous]);
  return uid && !isAnonymous ? role : null;
}
export const isStaff = (r: 'admin' | 'user' | null) => r === 'admin';

const rpc = async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
};

// ------------------------------------------------------------------ projects
export type StaffProject = { slug: string; title: string; model: string; status: string; is_published: boolean; city_slug: string | null; phones_in: number; nights_done: number; created_at: string };
export type ProjectForm = { slug: string; title: string; summary: string; model: string; params_b: string; nights: string; phones: string; org: string; city: string | null; status: 'open' | 'full' | 'done'; image: string };
export const staffProjects = () => rpc<StaffProject[]>('staff_projects');
export const saveProject = (f: ProjectForm) =>
  rpc<string>('staff_project_save', {
    p_slug: f.slug, p_title: f.title, p_summary: f.summary, p_model: f.model, p_params_b: Number(f.params_b), p_nights: Number(f.nights), p_phones: Number(f.phones),
    p_org: f.org, p_city: f.city, p_status: f.status, p_image_url: f.image || null, p_poster_no: null,
  });
export const deleteProject = (slug: string) => rpc<void>('staff_project_delete', { p_slug: slug });
export const saveAbout = (slug: string, lang: string, kicker: string, who: string, facts: string[], source: string | null) =>
  rpc<void>('staff_about_set', { p_slug: slug, p_lang: lang, p_kicker: kicker || null, p_who: who, p_facts: facts, p_source_url: source });
export const saveSamples = (slug: string, lang: string, prompt: string, lines: string[]) => rpc<void>('staff_samples_set', { p_slug: slug, p_lang: lang, p_prompt: prompt, p_lines: lines });

// ------------------------------------------------------------------ people
export type Person = { id: string; handle: string | null; display_name: string | null; created_at: string; nights: number; banned: boolean };
export const people = (q: string) => rpc<Person[]>('admin_people', { p_query: q });
export const banPerson = (user: string, reason: string | null) => rpc<void>('staff_ban', { p_user: user, p_reason: reason });
export const unbanPerson = (user: string) => rpc<void>('staff_unban', { p_user: user });
export type Feedback = { id: number; subject: string; body: string; contact: string | null; who: string | null; created_at: string };
export const feedbackList = () => rpc<Feedback[]>('feedback_list', { p_limit: 200 });
export const setMinVersion = (v: string) => rpc<string>('set_min_app_version', { p_version: v, p_note: null });

// The error a function raised, as a short line for the screen.
export const why = (e: unknown) => serverText(e);
