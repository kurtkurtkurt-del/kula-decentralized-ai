-- afterhours — the past feed: photos of nights that already happened
-- The bottom of the yours tab is an endless feed, newest first, of past nights:
-- every past night in your city that has a photograph, plus any past night
-- (anywhere) where you or a friend checked in or kept it. Those carry who was
-- there. It is read a page at a time: the app passes the date of the last card
-- it has and gets the next ones.
--
--   past_feed(city, before, before_id, limit)   before + before_id: the last card you have
--
-- Who is named: you, and confirmed friends whose check-in shows to friends
-- (19, show_friends) or who kept the night and keep their kept nights visible
-- (12, kept_visible). Signed out: the nights only, nobody named.
-- Past nights are unpublished by the nightly job (09) but the rows stay; this
-- call reads them, so the feed reaches back a year.

drop function if exists public.past_feed(text, timestamptz, int);
drop function if exists public.past_feed(text, timestamptz, uuid, int);
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
language sql
stable
security definer
set search_path = public
as $$
  with circle as (
    select case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end as id
    from public.friendships f
    where f.status = 'accepted' and auth.uid() in (f.requester_id, f.addressee_id)
  ),
  -- who of yours was there, per night: checked in (shown to friends) or kept it
  went as (
    select c.event_id, c.user_id, c.checked_at as at
    from public.checkins c
    where c.user_id = auth.uid()
       or (c.show_friends and c.user_id in (select id from circle))
    union
    select s.event_id, s.user_id, s.created_at
    from public.swipes s
    where s.direction = 'right'
      and (s.user_id = auth.uid() or (s.user_id in (select id from circle) and public.kept_visible(s.user_id)))
  ),
  named as (
    select w.event_id,
           array_agg(distinct lower(coalesce(p.handle, p.display_name, 'someone'))) filter (where w.user_id <> auth.uid()) as people,
           bool_or(w.user_id = auth.uid()) as mine
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
$$;

revoke execute on function public.past_feed(text, timestamptz, uuid, int) from public;
grant execute on function public.past_feed(text, timestamptz, uuid, int) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('31_past_feed.sql', 'bb1fa6b0708e370eaa850822fd850d3b9fb04cb3b663cd8bba3bd1d62957d693');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('31_past_feed.sql');
  end if;
end $$;
