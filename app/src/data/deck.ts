import { supabase } from '@/lib/supabase';
import { prefetchImages } from '@/lib/images';
import { cachedRead, forgetSwiped, invalidate, markSwiped, must, peek, remember, send, shelve, swipedHere } from '@/lib/offline';

// A projects_public row, as returned by deck() and kept() (06_deck.sql).
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

// The deck: open projects not yet swiped. null country = everywhere.
// The saved deck opens at once, minus what was swiped on this phone since; a fresh one
// is fetched behind it for next time. A saved deck that is nearly used up waits for the
// server instead (when online), so the deck does not run dry.
export async function fetchDeck(country: string | null, limit = 40) {
  const key = `${country ?? '*'}|${limit}`;
  const gone = await swipedHere();
  const saved = peek<Project[]>('deck', key);
  const thin = !saved || saved.filter((n) => !gone.has(n.slug)).length < 4;
  const { value } = await cachedRead('deck', key, async () => {
    const rows = ((await must(supabase.rpc('deck', { p_country: country, p_limit: limit }))) ?? []) as Project[];
    stashProjects(rows);
    prefetchImages(rows.slice(0, 10).map((n) => n.image_url));
    return rows;
  }, 6, { fresh: thin });
  return value.filter((n) => !gone.has(n.slug));
}

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

// Keep / let go. Requires sign-in; swiping the same card again overwrites.
// Offline it is queued and sent on reconnect (lib/offline.ts).
export async function swipe(slug: string, direction: 'left' | 'right') {
  await markSwiped(slug);
  await send({ kind: 'swipe', slug, direction });
}
// Undo: deletes your own join row; the card returns to the deck.
export async function unswipe(slug: string) {
  await markSwiped(slug, false);
  await send({ kind: 'unswipe', slug });
}
// Reset: deletes every join; the deck starts over.
export async function resetSwipes() {
  const { error } = await supabase.rpc('joins_reset');
  if (error) throw error;
  forgetSwiped();
  invalidate('deck', 'kept', 'yours');
}

// What you kept, newest first (kept()).
export async function kept(): Promise<Project[]> {
  const list = await remember('kept', '', async () => ((await must(supabase.rpc('kept'))) ?? []) as Project[]);
  stashProjects(list);
  return list;
}

// Poster URL: the site's hand-drawn SVG for projects without a photo.
export const SITE = process.env.EXPO_PUBLIC_SITE_URL ?? 'https://kurtkurtkurt-del.github.io/pasaport/';
export function posterUrl(n: { poster_no: number | null }) {
  if (n.poster_no) return SITE + 'posters/' + String(n.poster_no).padStart(2, '0') + '.svg';
  return null;
}
