-- afterhours — the door (57, after 56)
--
-- Two questions every function used to answer on its own, each in its own words:
-- "who is asking?" and "may they see this person?". From here they have one answer
-- each, so a new function cannot forget a case the others remember (the lesson of
-- 50_blocks.sql, which had to touch four sieves one by one).
--
--   assert_member()              who is asking: a signed-in account that is not
--                                banned, else an exception (42501). Guests (anonymous
--                                sessions) pass: they are limited by the writes they
--                                are refused, not by the door. The write gates
--                                (need_member, need_post) and the big reads
--                                (people_search, people_suggested, posts_feed,
--                                past_feed, waves_kept) ask it first — in plpgsql,
--                                at declaration, so an empty table cannot skip it. A banned
--                                account used to keep reading; now it reads nothing.
--   reachable(viewer, other)     no block either way, the other not banned.
--   visible_to(viewer, other)    reachable, and a friend or discoverable (the one
--                                sieve card_visible of 52 already was, with the viewer
--                                named so a wave can ask it for someone else).
--   card_visible(other)          = visible_to(auth.uid(), other), kept for every caller.
--   spark_waves                  stops at a block and at a ban (reachable), as before
--                                at a block alone.

-- ------------------------------------------------------------ who is asking

create or replace function public.assert_member()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  u uuid := auth.uid();
begin
  if u is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if public.is_banned(u) then
    raise exception 'this account is closed' using errcode = '42501';
  end if;
  return u;
end;
$$;
revoke execute on function public.assert_member() from public, anon;
grant execute on function public.assert_member() to authenticated;

-- ------------------------------------------------------------ who may be seen

create or replace function public.are_friends(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = p_a and f.addressee_id = p_b)
        or (f.requester_id = p_b and f.addressee_id = p_a))
  );
$$;
revoke execute on function public.are_friends(uuid, uuid) from public, anon, authenticated;

create or replace function public.reachable(p_viewer uuid, p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_viewer is not null and p_other is not null
     and not public.is_banned(p_other)
     and not exists (select 1 from public.blocks b
                     where (b.blocker_id = p_viewer and b.blocked_id = p_other)
                        or (b.blocker_id = p_other and b.blocked_id = p_viewer));
$$;
revoke execute on function public.reachable(uuid, uuid) from public, anon, authenticated;

create or replace function public.visible_to(p_viewer uuid, p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_viewer is not null and p_other is not null
     and (p_other = p_viewer
          or (public.reachable(p_viewer, p_other)
              and (public.are_friends(p_viewer, p_other)
                   or coalesce((select s.discoverable from public.profile_settings s
                                where s.user_id = p_other), true))));
$$;
revoke execute on function public.visible_to(uuid, uuid) from public, anon, authenticated;

create or replace function public.card_visible(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.visible_to(auth.uid(), other);
$$;

-- The wave walks friendships and stops where the host could not reach the person.
create or replace function public.spark_waves(p_me uuid)
returns table (person uuid, hops int)
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
  walk(person, hops) as (
    select b, 1 from f where a = p_me
    union
    select f.b, w.hops + 1 from walk w join f on f.a = w.person where w.hops < 3
  )
  select w.person, min(w.hops)::int from walk w
  where w.person <> p_me
    and public.reachable(p_me, w.person)
  group by w.person;
$$;

-- ------------------------------------------------------------ the gates ask first

create or replace function public.need_member(p_group uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_member();
  if not public.in_group(p_group) then
    raise exception 'not in this group' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.need_post(p_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  perform public.assert_member();
  select author_id into a from public.posts where id = p_id and not is_hidden;
  if a is null or not public.can_see_post(a) then raise exception 'no such post'; end if;
  return a;
end;
$$;

-- ------------------------------------------------------------ the big reads ask first

create or replace function public.people_search(p_query text, p_limit int default 12)
returns table (
  id            uuid,
  handle        text,
  display_name  text,
  city_name     text,
  mutual        int,
  relation      text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me   uuid := public.assert_member();
  q    text := lower(btrim(regexp_replace(coalesce(p_query, ''), '^@', '')));
  safe text;
begin
  if length(q) < 2 then
    return;
  end if;
  safe := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
    select p.id, p.handle, p.display_name, c.name,
           public.people_mutual(p.id), public.people_relation(p.id)
    from public.profiles p
    left join public.cities c on c.id = p.city_id
    where p.handle is not null
      and p.id <> me
      and public.visible_to(me, p.id)
      and (p.handle like safe || '%' or lower(coalesce(p.display_name, '')) like '%' || safe || '%')
    order by (p.handle = q) desc,
             (p.handle like safe || '%') desc,
             public.people_mutual(p.id) desc,
             p.handle
    limit least(greatest(coalesce(p_limit, 12), 1), 20);
end;
$$;

create or replace function public.people_suggested(p_limit int default 3)
returns table (
  id            uuid,
  handle        text,
  display_name  text,
  city_name     text,
  mutual        int,
  reason        text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  with mine as (
    select p.city_id from public.profiles p where p.id = me
  ),
  pool as (
    select p.id, p.handle, p.display_name, c.name as city_name,
           public.people_mutual(p.id) as mutual,
           (p.city_id is not null and p.city_id = (select city_id from mine)) as same_city,
           p.last_seen_at
    from public.profiles p
    left join public.cities c on c.id = p.city_id
    where p.handle is not null
      and p.id <> me
      and not public.is_linked(p.id)
      and public.visible_to(me, p.id)
  )
  select pool.id, pool.handle, pool.display_name, pool.city_name, pool.mutual,
         case when pool.mutual > 0 then 'mutual' when pool.same_city then 'city' else 'new' end
  from pool
  order by pool.mutual desc, pool.same_city desc, pool.last_seen_at desc nulls last, pool.handle
  limit least(greatest(coalesce(p_limit, 3), 1), 12);
end;
$$;

create or replace function public.posts_feed(p_before timestamptz default null, p_limit int default 20)
returns table (id uuid, author_id uuid, handle text, name text, body text, photo_path text,
               event_slug text, event_title text, created_at timestamptz, mine boolean,
               likes int, liked boolean, comments int, first_comments jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select p.id, p.author_id, pr.handle, pr.display_name, p.body, p.photo_path, e.slug, e.title, p.created_at,
         p.author_id = me,
         (select count(*)::int from public.post_likes l where l.post_id = p.id),
         exists (select 1 from public.post_likes l where l.post_id = p.id and l.user_id = me),
         (select count(*)::int from public.post_comments c where c.post_id = p.id and not c.is_hidden),
         coalesce((select jsonb_agg(jsonb_build_object('who', coalesce(x.handle, x.display_name), 'text', x.body) order by x.created_at)
                   from (select c.body, c.created_at, q.handle, q.display_name
                         from public.post_comments c join public.profiles q on q.id = c.author_id
                         where c.post_id = p.id and not c.is_hidden
                           and (c.author_id = me or public.reachable(me, c.author_id))
                         order by c.created_at limit 2) x), '[]'::jsonb)
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
  left join public.events e on e.id = p.event_id
  where not p.is_hidden
    and public.can_see_post(p.author_id)
    and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
end;
$$;

create or replace function public.past_feed(
  p_city   text default null,
  p_before    timestamptz default null,
  p_before_id uuid default null,
  p_limit     int default 12
)
returns table (
  id          uuid,
  slug        text,
  title       text,
  image_url   text,
  venue_name  text,
  city_name   text,
  type_slug   text,
  type_name   text,
  starts_at   timestamptz,
  people      text[],
  mine        boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  with circle as (
    select case when f.requester_id = me then f.addressee_id else f.requester_id end as id
    from public.friendships f
    where f.status = 'accepted' and me in (f.requester_id, f.addressee_id)
  ),
  -- who of yours was there, per night: checked in (shown to friends) or kept it
  went as (
    select c.event_id, c.user_id, c.checked_at as at
    from public.checkins c
    where c.user_id = me
       or (c.show_friends and c.user_id in (select circle.id from circle))
    union
    select s.event_id, s.user_id, s.created_at
    from public.swipes s
    where s.direction = 'right'
      and (s.user_id = me or (s.user_id in (select circle.id from circle) and public.kept_visible(s.user_id)))
  ),
  named as (
    select w.event_id,
           array_agg(distinct lower(coalesce(p.handle, p.display_name, 'someone'))) filter (where w.user_id <> me) as people,
           bool_or(w.user_id = me) as mine
    from went w
    join public.profiles p on p.id = w.user_id
    group by w.event_id
  )
  select e.id, e.slug, e.title, e.image_url, v.name, ci.name, t.slug, t.name, e.starts_at,
         coalesce(n.people, '{}'), coalesce(n.mine, false)
  from public.events e
  join public.event_types t on t.id = e.type_id
  join public.cities ci on ci.id = e.city_id
  left join public.venues v on v.id = e.venue_id
  left join named n on n.event_id = e.id
  where e.starts_at is not null
    and e.starts_at < now()
    and e.starts_at > now() - interval '365 days'
    and (p_before is null or e.starts_at < p_before
         or (e.starts_at = p_before and p_before_id is not null and e.id > p_before_id))
    and e.image_url is not null
    and (ci.slug = p_city or n.event_id is not null)
  order by e.starts_at desc, e.id
  limit least(greatest(coalesce(p_limit, 12), 1), 30);
end;
$$;

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
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  with near as (
    select w.person, w.hops, w.path
    from public.wave_paths(me) w
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
  where e.starts_at > now() - interval '6 hours'
  order by e.starts_at, n.hops, s.created_at desc
  limit greatest(1, least(coalesce(p_limit, 80), 200));
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('57_doors.sql', '9f7b2b2356cfeb17a3dfcf7fc3dcb04c3c41c493384de2a0b426c1ea7dff8df0');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('57_doors.sql');
  end if;
end $$;
