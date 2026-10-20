-- afterhours — real events from Ticketmaster
--
-- Four columns on events, and the deck learns to serve the whole world.
-- The rows themselves are written by backend/tools/sync-ticketmaster.mjs
-- (a daily GitHub Action with the service key); nothing in the browser
-- can write them, the same as every other event.
--
--   source       "seed" for the hand-written nights, "ticketmaster" for
--                the synced ones. The cleanup script and the daily prune
--                only ever touch their own source.
--   external_id  the Ticketmaster id. The sync upserts on it, so a night
--                keeps its uuid between runs and swipes on it survive.
--   image_url    a photograph instead of a drawn poster. The front end
--                shows an <img> when this is set, posters/NN.svg when not.
--   ticket_url   the real ticket page; the button on the event page uses
--                it when it is there.

alter table public.events add column if not exists source text not null default 'seed';
alter table public.events add column if not exists external_id text;
alter table public.events add column if not exists image_url text;
alter table public.events add column if not exists ticket_url text;

create unique index if not exists events_external_idx
  on public.events (external_id);

create index if not exists events_source_idx on public.events (source);

-- ------------------------------------------------- the view grows a little

-- The three new columns the screen needs, appended at the end. The view
-- is dropped rather than replaced: deck() and kept() return its row type,
-- and both are recreated right below (the same dance as in 06_views.sql).
drop view if exists public.events_public cascade;

create view public.events_public
with (security_invoker = true) as
select
  e.id,
  e.slug,
  e.title,
  e.meta,
  e.body,
  e.poster_no,
  e.poster_path,
  e.starts_at,
  e.starts_at_estimated,
  e.date_text,
  e.is_published,
  t.slug  as type_slug,
  t.name  as type_name,
  t.sort_order  as type_sort_order,
  c.slug  as city_slug,
  c.name  as city_name,
  v.slug  as venue_slug,
  v.name  as venue_name,
  e.image_url,
  e.ticket_url,
  e.source
from public.events e
join public.event_types t on t.id = e.type_id
join public.cities      c on c.id = e.city_id
left join public.venues v on v.id = e.venue_id;

-- ---------------------------------------------------- the deck, worldwide

-- One change of meaning: a NULL city now says "everywhere" instead of
-- "nowhere". The filter on explore sends null when the person has picked
-- no city, and the deck answers with the whole world, soonest night
-- inside a city block first. Hand-drawn posters keep their own order;
-- synced nights (no poster number) follow, by date.
create or replace function public.deck(
  p_city text default 'munchen',
  p_type text default null,
  p_limit int  default 60
)
returns setof public.events_public
language sql
stable
-- security definer: anonymous has no rights on the swipes table at all, but
-- the deck has to look there to ask "was this already swiped". The function
-- runs with the rights of its owner, so the published filter and the user
-- filter are written out BY HAND below to stop anything leaking.
security definer
set search_path = public
as $$
  select e.*
  from public.events_public e
  where e.is_published
    and (p_city is null or e.city_slug = p_city)
    and (p_type is null or e.type_slug = p_type)
    and not exists (
      select 1 from public.swipes s
      where s.event_id = e.id and s.user_id = auth.uid()
    )
  order by e.poster_no nulls last, e.starts_at nulls last, e.slug
  limit p_limit;
$$;

-- --------------------------------------------------------- kept cards

-- Unchanged in meaning; recreated because the cascade above took it.
create or replace function public.kept()
returns setof public.events_public
language sql
stable
as $$
  select e.*
  from public.swipes s
  join public.events_public e on e.id = s.event_id
  where s.user_id = auth.uid() and s.direction = 'right'
  order by s.created_at desc;
$$;

-- ------------------------------------------------- what your friends kept

-- Same rows as before plus the photograph, so a synced night in the
-- friends deck does not fall back to the wrong drawn poster.
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.friends_kept(int);
create or replace function public.friends_kept(p_limit int default 60)
returns table (
  friend      text,
  kept_at     timestamptz,
  id          uuid,
  slug        text,
  title       text,
  meta        text,
  body        text,
  poster_no   int,
  type_name   text,
  venue_name  text,
  city_slug   text,
  starts_at   timestamptz,
  image_url   text
)
language sql
stable
as $$
  select coalesce(p.handle, p.display_name, 'a friend'), s.created_at,
         e.id, e.slug, e.title, e.meta, e.body, e.poster_no,
         e.type_name, e.venue_name, e.city_slug, e.starts_at, e.image_url
  from public.swipes s
  join public.events_public e on e.id = s.event_id
  join public.profiles p on p.id = s.user_id
  where s.direction = 'right'
    and s.user_id <> auth.uid()
    and public.is_friend(s.user_id)
  order by s.created_at desc
  limit p_limit;
$$;

-- ------------------------------------------------------------- the keys

-- Dropping a view or a function takes its grants with it; everything the
-- cascade touched gets its keys back here.
grant select on public.events_public to anon, authenticated;
grant execute on function public.deck(text, text, int) to anon, authenticated;
grant execute on function public.kept()                to authenticated;
grant execute on function public.friends_kept(int)     to authenticated;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('15_ticketmaster.sql', '19395a7080f04915970864ca82a17a419dbfaa3771393edbf35ffccff81125db');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('15_ticketmaster.sql');
  end if;
end $$;
