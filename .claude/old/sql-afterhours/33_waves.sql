-- afterhours — the waves on yours: nights kept beyond your friends
-- yours has shown two decks above the friends deck with sample cards only:
--
--   2nd wave   nights kept by friends of your friends
--   3rd wave   one step further
--
-- This is the real thing. The walk goes over CONFIRMED friendships only, at
-- most three steps, and keeps the shortest chain to each person, so a card can
-- say who it came through ("you — lina — tarık"). Your own friends are not in
-- it: their keeps are the friends deck already.
--
-- What it shows of someone you do not know: their handle (else their name) and
-- that they kept a night that is still to come. Nothing at all of a person who
-- set kept_visibility to private (12) — and such a person does not carry the
-- chain either, so nobody is named "via" someone who keeps their keeps closed.
--
--   waves_kept(limit)   upcoming nights kept in the 2nd and 3rd wave

-- Everyone within three confirmed steps, the shortest chain to each, starting
-- after you: path[1] is your friend, the last name is the person. Not callable
-- from the app.
create or replace function public.wave_paths(p_me uuid)
returns table (person uuid, hops int, path uuid[])
language sql
stable
security definer
set search_path = public
as $$
  with recursive f as (
    select requester_id as a, addressee_id as b from public.friendships where status = 'accepted'
    union all
    select addressee_id, requester_id from public.friendships where status = 'accepted'
  ),
  walk(person, hops, path) as (
    select b, 1, array[b] from f where a = p_me
    union all
    select f.b, w.hops + 1, w.path || f.b
    from walk w join f on f.a = w.person
    where w.hops < 3 and f.b <> p_me and not f.b = any (w.path)
  )
  select distinct on (person) person, hops, path
  from walk
  order by person, hops, path;
$$;
revoke execute on function public.wave_paths(uuid) from public, anon, authenticated;

drop function if exists public.waves_kept(int);
create or replace function public.waves_kept(p_limit int default 80)
returns table (
  wave        int,
  via         text[],
  kept_at     timestamptz,
  id          uuid,
  slug        text,
  title       text,
  poster_no   int,
  type_name   text,
  venue_name  text,
  city_slug   text,
  starts_at   timestamptz,
  image_url   text,
  ticket_url  text
)
language sql
stable
security definer
set search_path = public
as $$
  with near as (
    select w.person, w.hops, w.path
    from public.wave_paths(auth.uid()) w
    where w.hops between 2 and 3
      -- everyone on the chain keeps their keeps open
      and not exists (
        select 1 from unnest(w.path) as link(id)
        where not public.kept_visible(link.id)
      )
  )
  select n.hops,
         array(select coalesce(p.handle, p.display_name, 'someone')
               from unnest(n.path) with ordinality as link(id, i)
               join public.profiles p on p.id = link.id
               order by link.i),
         s.created_at,
         e.id, e.slug, e.title, e.poster_no, e.type_name, e.venue_name,
         e.city_slug, e.starts_at, e.image_url, e.ticket_url
  from near n
  join public.swipes s on s.user_id = n.person and s.direction = 'right'
  join public.events_public e on e.id = s.event_id
  where auth.uid() is not null
    and e.starts_at > now() - interval '6 hours'
  order by e.starts_at, n.hops, s.created_at desc
  limit greatest(1, least(coalesce(p_limit, 80), 200));
$$;

revoke execute on function public.waves_kept(int) from public, anon;
grant execute on function public.waves_kept(int) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('33_waves.sql', '414c1cc87d464508f0d618ae209261c4a04a74defe6b76902f938e8bca6b0d4c');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('33_waves.sql');
  end if;
end $$;
