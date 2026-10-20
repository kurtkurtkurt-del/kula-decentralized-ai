-- afterhours — the collection of someone else, for their profile page
-- my_cards (19) is yours only. Now:
--
--   person_cards(handle)   their cards, newest first, same shape as my_cards
--
-- Friends only (and you): the check-ins of a stranger say where they were, so
-- nobody else gets a row. The room lines and crew initials are the same
-- ones the owner sees on their own card.

drop function if exists public.person_cards(text);
create or replace function public.person_cards(p_handle text)
returns table (
  card_no     bigint,
  checked_at  timestamptz,
  freeze_at   timestamptz,
  frozen      boolean,
  slug        text,
  title       text,
  type_name   text,
  venue_name  text,
  city_name   text,
  starts_at   timestamptz,
  image_url   text,
  crew        text[],
  crew_more   int,
  who_count   int,
  post_count  int,
  q1_body     text,
  q1_who      text,
  q1_at       timestamptz,
  q2_body     text,
  q2_who      text,
  q2_at       timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select p.id from public.profiles p
    where p.handle = lower(btrim(p_handle))
      and (p.id = auth.uid() or public.is_friend(p.id))
  ),
  mine as (
    select c.*, public.room_freeze_at(c.event_id) as freeze_at
    from public.checkins c where c.user_id = (select id from target)
  ),
  others as (
    select c.event_id,
           array_agg(lower(left(coalesce(p.display_name, p.handle, 's'), 1)) order by c.checked_at) as initials,
           count(*)::int as n
    from public.checkins c
    join public.profiles p on p.id = c.user_id
    where c.user_id <> (select id from target) and c.event_id in (select event_id from mine)
    group by c.event_id
  ),
  posts as (
    select r.event_id, r.body, lower(left(coalesce(p.display_name, p.handle, 's'), 1)) as who, r.created_at,
           row_number() over (partition by r.event_id order by r.created_at) as rn,
           count(*) over (partition by r.event_id)::int as total
    from public.room_posts r
    left join public.profiles p on p.id = r.user_id
    where r.event_id in (select event_id from mine)
  )
  select m.card_no, m.checked_at, m.freeze_at, now() >= m.freeze_at,
         e.slug, e.title, t.name, v.name, ci.name, e.starts_at, e.image_url,
         coalesce(o.initials[1:4], '{}'), greatest(coalesce(o.n, 0) - 4, 0),
         coalesce(o.n, 0) + 1,
         coalesce((select total from posts p where p.event_id = m.event_id limit 1), 0),
         (select body from posts p where p.event_id = m.event_id and rn = 1),
         (select who  from posts p where p.event_id = m.event_id and rn = 1),
         (select created_at from posts p where p.event_id = m.event_id and rn = 1),
         (select body from posts p where p.event_id = m.event_id and rn = 2),
         (select who  from posts p where p.event_id = m.event_id and rn = 2),
         (select created_at from posts p where p.event_id = m.event_id and rn = 2)
  from mine m
  join public.events e on e.id = m.event_id
  join public.event_types t on t.id = e.type_id
  join public.cities ci on ci.id = e.city_id
  left join public.venues v on v.id = e.venue_id
  left join others o on o.event_id = m.event_id
  order by m.checked_at desc;
$$;

revoke all on function public.person_cards(text) from public, anon;
grant execute on function public.person_cards(text) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('36_person_cards.sql', '234ed583b13e73533ee052fbaff4146a65e8141ac4a2b772b80bb980c05329da');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('36_person_cards.sql');
  end if;
end $$;
