-- afterhours — listen to the artist (63)
--
-- A night can carry a 30 second preview of the act: the most played track of the artist
-- on Apple, matched ahead of time by tools/previews.mjs (the artist name must match the
-- act on the night; no match, no row, no button). The app shows a listen button on the
-- card (design D in prototypes/listen.html) and plays the preview over the poster.
--
--   event_previews        one row per night: track, artist, the preview address, the link
--   previews_for(ids)     the rows for these nights (published nights only)
--
-- Anyone may read them (they are about public nights). Only the service role writes:
-- the rows come from the tool, pasted as a reviewed SQL file.

create table if not exists public.event_previews (
  event_id     uuid primary key references public.events on delete cascade,
  track        text not null check (length(track) between 1 and 200),
  artist       text not null check (length(artist) between 1 and 200),
  preview_url  text not null check (preview_url ~ '^https://'),
  link         text check (link is null or link ~ '^https://'),
  source       text not null default 'apple' check (source in ('apple', 'deezer')),
  made_at      timestamptz not null default now()
);

alter table public.event_previews enable row level security;
revoke all on public.event_previews from public, anon, authenticated;

create or replace function public.previews_for(p_events uuid[])
returns table (event_id uuid, track text, artist text, preview_url text, link text, source text)
language sql
stable
security definer
set search_path = public
as $$
  select p.event_id, p.track, p.artist, p.preview_url, p.link, p.source
  from public.event_previews p
  join public.events e on e.id = p.event_id and e.is_published
  where p.event_id = any(p_events);
$$;
revoke all on function public.previews_for(uuid[]) from public;
grant execute on function public.previews_for(uuid[]) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('63_previews.sql', '68f08b2aca6230170b1b71d7d1449e89e8feb7b638587cf56c30babb6f0c5408');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('63_previews.sql');
  end if;
end $$;
