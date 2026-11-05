import { supabase } from '@/lib/supabase';
import { prefetchImages } from '@/lib/images';
import { markSwiped, must, peek, remember, send, shelve } from '@/lib/offline';

// The projects (06_deck.sql): a projects_public row as kept() returns it, the project page,
// keeping. The swipe deck that used to live here went on 4.11.2026 (the models tab took its
// place); a project is kept from its own page.
export type Project = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  model: string;
  params_b: number;
  nights_wanted: number;
  phones_wanted: number;
  est_kwh: number;
  est_eur: number;
  org: string;
  poster_no: number | null;
  image_url: string | null;
  status: 'open' | 'full' | 'done';
  created_at: string;
  city_slug: string | null;
  city_name: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
};
// The project page: the row plus its numbers (project_page).
export type ProjectPage = Project & { phones_in: number; nights_done: number; tokens: number; kept: boolean; friends: string[] };

// A project page: offline it opens from what was saved from the deck or the keeps.
export const stashProjects = (list: Project[]) => shelve('project', list.map((n) => [n.slug, n]), 200).catch(() => {});
export async function fetchProject(slug: string): Promise<ProjectPage | null> {
  return remember('projectPage', slug, async () => {
    const rows = ((await must(supabase.rpc('project_page', { p_slug: slug }))) ?? []) as ProjectPage[];
    return rows[0] ?? null;
  }, 100);
}
// The saved row alone (the deck's), for pages that open before the network answers.
export const peekProject = (slug: string) => peek<Project>('project', slug);

// Keep / let go. Requires sign-in; the same project again overwrites.
// Offline it is queued and sent on reconnect (lib/offline.ts).
export async function swipe(slug: string, direction: 'left' | 'right') {
  await markSwiped(slug);
  await send({ kind: 'swipe', slug, direction });
}
// Poster URL: the site's hand-drawn SVG for projects without a photo.
export const SITE = process.env.EXPO_PUBLIC_SITE_URL ?? 'https://kurtkurtkurt-del.github.io/pasaport/';
export function posterUrl(n: { poster_no: number | null }) {
  if (n.poster_no) return SITE + 'posters/' + String(n.poster_no).padStart(2, '0') + '.svg';
  return null;
}
