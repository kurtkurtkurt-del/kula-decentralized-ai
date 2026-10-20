-- afterhours — real people on a night, and the way you reach them
--
-- The column of who is going on an event page, and the roll on the page
-- of a person, used to be drawn from name pools. These two calls replace them
-- with the database: who actually kept a night, how the caller knows
-- each of them, and what one person kept.
--
--   friends_of(uid)      the accepted friends of anybody, as ids
--   event_people(slug)   everybody who kept the night, with the path back
--                        to the caller: degree 1 is a friend, 2 a friend
--                        of a friend (via = that friend), 3 one further
--                        (via = the first hop), 0 no path known
--   profile_kept(handle) the nights one person kept, newest first
--
-- Both readers are definer: swipes are closed to strangers by the rule in
-- 02, and this is the one place they open — everybody is public for now,
-- by decision, except a person who set kept_visibility to private.

-- ------------------------------------------------------------ friends_of

create or replace function public.friends_of(uid uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select case when f.requester_id = uid then f.addressee_id else f.requester_id end
  from public.friendships f
  where f.status = 'accepted'
    and (f.requester_id = uid or f.addressee_id = uid);
$$;

-- ---------------------------------------------------------- event_people

drop function if exists public.event_people(text);
create or replace function public.event_people(p_slug text)
returns table (
  handle        text,
  display_name  text,
  kept_at       timestamptz,
  degree        int,
  via           text,
  via2          text
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  mine as (select f from public.friends_of((select id from me)) f),
  people as (
    select s.user_id, s.created_at
    from public.swipes s
    join public.events e on e.id = s.event_id
    where e.slug = p_slug
      and s.direction = 'right'
      and s.user_id <> coalesce((select id from me), '00000000-0000-0000-0000-000000000000'::uuid)
      and public.kept_visible(s.user_id)
  ),
  -- the first hop: a friend of mine who is a friend of theirs
  hop1 as (
    select p.user_id, min(q.handle) as via
    from people p
    join lateral (
      select pr.handle
      from public.friends_of(p.user_id) g
      join mine m on m.f = g
      join public.profiles pr on pr.id = g
      order by pr.handle
      limit 1
    ) q on true
    group by p.user_id
  ),
  -- two hops: a friend of mine, then a friend of that friend, then them
  hop2 as (
    select p.user_id, min(q.via) as via, min(q.via2) as via2
    from people p
    join lateral (
      select pr1.handle as via, pr2.handle as via2
      from mine m
      join public.friends_of(m.f) g1 on true
      join public.friends_of(g1) g2 on g2 = p.user_id
      join public.profiles pr1 on pr1.id = m.f
      join public.profiles pr2 on pr2.id = g1
      where g1 <> (select id from me)
      order by pr1.handle, pr2.handle
      limit 1
    ) q on true
    group by p.user_id
  )
  select pr.handle, pr.display_name, p.created_at,
         case
           when (select id from me) is null then 0
           when exists (select 1 from mine m where m.f = p.user_id) then 1
           when h1.via is not null then 2
           when h2.via is not null then 3
           else 0
         end,
         case
           when exists (select 1 from mine m where m.f = p.user_id) then null
           else coalesce(h1.via, h2.via)
         end,
         case
           when h1.via is null then h2.via2
         end
  from people p
  join public.profiles pr on pr.id = p.user_id
  left join hop1 h1 on h1.user_id = p.user_id
  left join hop2 h2 on h2.user_id = p.user_id
  where pr.handle is not null
  order by 4 desc, 3 desc;
$$;

-- ---------------------------------------------------------- profile_kept

drop function if exists public.profile_kept(text);
create or replace function public.profile_kept(p_handle text)
returns table (
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
security definer
set search_path = public
as $$
  select s.created_at,
         e.id, e.slug, e.title, e.meta, e.body, e.poster_no,
         e.type_name, e.venue_name, e.city_slug, e.starts_at, e.image_url
  from public.profiles p
  join public.swipes s on s.user_id = p.id and s.direction = 'right'
  join public.events_public e on e.id = s.event_id
  where p.handle = lower(btrim(p_handle))
    and public.kept_visible(p.id)
  order by s.created_at desc
  limit 60;
$$;

-- --------------------------------------------------------------- keys

revoke execute on function public.friends_of(uuid) from public, anon, authenticated;
grant execute on function public.event_people(text)  to anon, authenticated;
grant execute on function public.profile_kept(text)  to anon, authenticated;

-- Stamp the migration log, if it is there.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('17_real_people.sql', '68427f8d1536603cd4b47b493a9366166812d97a8cbd3ae4808e6e07b3a6c1c7');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('17_real_people.sql');
  end if;
end $$;
