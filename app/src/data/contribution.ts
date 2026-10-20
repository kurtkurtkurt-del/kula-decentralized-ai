import { serverText } from '@/lib/serverText';
import { supabase } from '@/lib/supabase';
import { OfflineError, invalidate, must, newId, outbox, peek, pendingJobs, remember, send, type Job } from '@/lib/offline';
import type { Project } from '@/data/deck';
import type { NightCardData } from '@/content/cardsgen';
import type { Key } from '@/i18n/dict';

// 08_contributions.sql: contribution_start, contribution_end, contribution_open,
// my_cards, person_cards, credits_mine, friends_live.

// Code → string key, resolved at render time: t(reasons[code]).
export const reasons: Record<string, Key> = {
  signedout: 'night.reason.signedout',
  noproject: 'night.reason.noproject',
  notkept: 'night.reason.notkept',
  nonight: 'night.reason.nonight',
  offline: 'offline.write',
};
export const reasonCode = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  return Object.keys(reasons).find((k) => m.includes(k)) ?? serverText(e);
};

const NIGHT_SHELVES = ['cards', 'open', 'live', 'personCards', 'credits', 'projectPage', 'profile'];
// A start and an end go through the outbox: the job's own id travels with it, so a
// retry finds the first try and the card keeps the moment the night began on the phone.
outbox(
  'nightStart',
  async (j) => {
    const r = await supabase.rpc('contribution_start', { p_slug: j.slug, p_client_id: j.id, p_at: new Date(j.at).toISOString() });
    if (r.error) throw r.error;
    return String(r.data);
  },
  NIGHT_SHELVES,
);
outbox(
  'nightEnd',
  async (j) => {
    // The id the server gave the start, or the start job's id when the start was made
    // offline and the server never answered (the start sent the same client_id).
    let id = j.contributionId as string | null;
    if (!id) {
      const r0 = await supabase.rpc('contribution_start', { p_slug: j.slug, p_client_id: j.startId, p_at: new Date(j.startedAt as number).toISOString() });
      if (r0.error) throw r0.error;
      id = String(r0.data);
    }
    const r = await supabase.rpc('contribution_end', { p_id: id, p_tokens: j.tokens, p_seconds: j.seconds, p_kwh: j.kwh, p_at: new Date(j.at).toISOString() });
    if (r.error) throw r.error;
    return Number(r.data);
  },
  NIGHT_SHELVES,
);

// The night begins: the server's id, or null while it waits in the outbox (the job id
// then stands in for it: the end sends it along).
export async function startNight(slug: string): Promise<{ id: string | null; jobId: string; at: number }> {
  const r = await send({ kind: 'nightStart', slug });
  return { id: r.queued ? null : String(r.result), jobId: r.job.id, at: r.job.at };
}
// The morning: the card number, or null while it waits.
export async function endNight(p: { contributionId: string | null; startId: string; startedAt: number; slug: string; tokens: number; seconds: number; kwh: number }): Promise<number | null> {
  const r = await send({ kind: 'nightEnd', ...p });
  return r.queued ? null : Number(r.result);
}

export type OpenNight = { id: string; slug: string; title: string; model: string; started_at: string };
export async function openNight(): Promise<OpenNight | null> {
  const rows = await remember('open', '', async () => ((await must(supabase.rpc('contribution_open'))) ?? []) as OpenNight[]).catch(() => [] as OpenNight[]);
  return rows[0] ?? null;
}

export type CardRow = {
  card_no: number; started_at: string; ended_at: string; tokens: number; seconds: number; kwh: number; credits: number;
  slug: string; title: string; model: string; org: string; city_name: string | null; poster_no: number | null; image_url: string | null;
  night_no: number; crew: string[]; crew_more: number;
  waiting?: boolean; // made offline, still in the outbox
};

// An end still in the outbox as a card: the project from the phone's shelf, number 0
// until the server gives it one.
function waitingCard(j: Job): CardRow | null {
  const n = peek<Project>('project', j.slug as string);
  if (!n) return null;
  return {
    card_no: 0, started_at: new Date(j.startedAt as number).toISOString(), ended_at: new Date(j.at).toISOString(),
    tokens: Number(j.tokens), seconds: Number(j.seconds), kwh: Number(j.kwh), credits: Math.round(((Number(j.tokens) / 1000) * n.params_b) / 7 * 100) / 100,
    slug: n.slug, title: n.title, model: n.model, org: n.org, city_name: n.city_name, poster_no: n.poster_no, image_url: n.image_url,
    night_no: 0, crew: [], crew_more: 0, waiting: true,
  };
}

// Yours, newest first; nights still in the outbox come first as waiting cards.
export async function myCards(): Promise<CardRow[]> {
  const waiting = pendingJobs('nightEnd').map(waitingCard).filter((c): c is CardRow => !!c).reverse();
  let cards: CardRow[];
  try {
    cards = await remember('cards', '', async () => ((await must(supabase.rpc('my_cards'))) ?? []) as CardRow[]);
  } catch (e) {
    if (e instanceof OfflineError && waiting.length) return waiting;
    throw e;
  }
  return [...waiting, ...cards];
}
export async function personCards(handle: string): Promise<CardRow[]> {
  return remember('personCards', handle, async () => ((await must(supabase.rpc('person_cards', { p_handle: handle }))) ?? []) as CardRow[], 8);
}

export type CreditLine = { id: number; amount: number; weight: number; slug: string; title: string; card_no: number; created_at: string };
export async function creditsMine(): Promise<CreditLine[]> {
  return remember('credits', '', async () => ((await must(supabase.rpc('credits_mine'))) ?? []) as CreditLine[]);
}

export type LiveFriend = { handle: string | null; display_name: string | null; slug: string; title: string; started_at: string };
export async function friendsLive(): Promise<LiveFriend[]> {
  return remember('live', '', async () => ((await must(supabase.rpc('friends_live'))) ?? []) as LiveFriend[]);
}
export const forgetNight = () => invalidate(...NIGHT_SHELVES);
export const nightJobId = newId;

// For the card generator (content/cardsgen.js, the site's 400×600 drawing): metal and
// motif derive from the project, so a card always renders the same.
const METALS = ['steel', 'gold', 'chrome', 'copper', 'gunmetal', 'brass', 'rose', 'titanium', 'nickel', 'anthracite'];
const MOTIFS = ['rays', 'oval', 'diagonal', 'orbit', 'grid', 'moon', 'moire', 'bands', 'iso', 'descend'];
const hash = (s: string) => Array.from(s).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
const ddmm = (iso: string | null, year = false) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', year ? { day: '2-digit', month: '2-digit', year: '2-digit' } : { day: '2-digit', month: '2-digit' }) : '';
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

export function toCardData(r: CardRow): NightCardData {
  const h = hash(r.slug);
  const hours = Math.floor(r.seconds / 3600);
  const mins = Math.floor((r.seconds % 3600) / 60);
  return {
    t: r.title.length > 28 ? r.title.slice(0, 27).trimEnd() + '…' : r.title, ty: r.model.toUpperCase(), v: r.org.toUpperCase(), d: ddmm(r.started_at, true),
    metal: METALS[h % METALS.length], motif: MOTIFS[(h >> 4) % MOTIFS.length],
    in: hhmm(r.started_at), out: hhmm(r.ended_at), dur: `${hours}H ${String(mins).padStart(2, '0')}M`,
    crew: r.crew.map((c) => c.toUpperCase()), more: r.crew_more, aud: `${fmtTokens(r.tokens)} TOK`, msg: Math.round(r.credits),
    who: `${Number(r.kwh).toFixed(3)} KWH`, froze: `NIGHT ${r.night_no}`, no: r.waiting ? '····' : String(r.card_no).padStart(4, '0'),
    at1: '', at2: '', blank: true,
  };
}
