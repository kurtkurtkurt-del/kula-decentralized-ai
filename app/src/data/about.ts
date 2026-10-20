import { supabase } from '@/lib/supabase';
import { must, remember } from '@/lib/offline';
import type { Lang } from '@/i18n';

// 12_about.sql: who runs a project (project_about) and three lines of what its model
// answers (project_samples), per language. Saved on the phone like everything else.
export type About = { project_id: string; lang: Lang; kicker: string | null; who: string; facts: string[]; source_url: string | null };
export type Sample = { project_id: string; lang: Lang; prompt: string; lines: string[] };

export async function aboutFor(ids: string[], lang: Lang): Promise<Map<string, About>> {
  if (!ids.length) return new Map();
  const key = `${lang}|${[...ids].sort().join(',')}`;
  const rows = await remember('about', key, async () => ((await must(supabase.rpc('about_for', { p_projects: ids, p_lang: lang }))) ?? []) as About[], 12, { ttl: 6 * 3600_000 }).catch(() => [] as About[]);
  return new Map(rows.map((r) => [r.project_id, r]));
}
export async function samplesFor(ids: string[], lang: Lang): Promise<Map<string, Sample>> {
  if (!ids.length) return new Map();
  const key = `${lang}|${[...ids].sort().join(',')}`;
  const rows = await remember('samples', key, async () => ((await must(supabase.rpc('samples_for', { p_projects: ids, p_lang: lang }))) ?? []) as Sample[], 12, { ttl: 6 * 3600_000 }).catch(() => [] as Sample[]);
  return new Map(rows.map((r) => [r.project_id, r]));
}
