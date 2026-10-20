-- paste 2/24: 66 67 68
create or replace function public.events_prune_untouched(p_days int default 400)
returns integer
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.events e
    where e.source = 'ticketmaster'
      and e.starts_at is not null
      and e.starts_at < now() - make_interval(days => greatest(coalesce(p_days, 400), 365))
      and not exists (select 1 from public.swipes              x where x.event_id = e.id)
      and not exists (select 1 from public.comments            x where x.event_id = e.id)
      and not exists (select 1 from public.checkins            x where x.event_id = e.id)
      and not exists (select 1 from public.room_posts          x where x.event_id = e.id)
      and not exists (select 1 from public.rsvps               x where x.event_id = e.id)
      and not exists (select 1 from public.tickets             x where x.event_id = e.id)
      and not exists (select 1 from public.event_about         x where x.event_id = e.id)
      and not exists (select 1 from public.group_swipes        x where x.event_id = e.id)
      and not exists (select 1 from public.group_live_skips    x where x.event_id = e.id)
      and not exists (select 1 from public.group_photos        x where x.event_id = e.id)
      and not exists (select 1 from public.group_round_options x where x.event_id = e.id)
      and not exists (select 1 from public.group_ballots       x where x.event_id = e.id)
      and not exists (select 1 from public.group_tickets       x where x.event_id = e.id)
      and not exists (select 1 from public.posts               x where x.event_id = e.id)
      and not exists (select 1 from public.groups              x where x.plan_event_id = e.id)
    returning 1
  )
  select count(*)::int from gone;
$$;

revoke execute on function public.events_prune_untouched(int) from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('66_keep_past_nights.sql', 'c6bbe32a8697b1597cb2030db487d991b3ea853f0acc2413116ee63f59c143e6');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('66_keep_past_nights.sql');
  end if;
end $$;

create or replace function public.deck(
  p_city text default 'munchen',
  p_type text default null,
  p_limit int  default 60
)
returns setof public.events_public
language sql
stable
security definer
set search_path = public
as $$
  select e.*
  from public.events_public e
  where e.is_published
    and (p_city is null or e.city_slug = p_city)
    and (p_type is null or e.type_slug = p_type)
    and (e.source <> 'ticketmaster' or e.starts_at is null or e.starts_at > now() - interval '8 hours')
    and not exists (
      select 1 from public.swipes s
      where s.event_id = e.id and s.user_id = auth.uid()
    )
  order by e.poster_no nulls last, e.starts_at nulls last, e.slug
  limit p_limit;
$$;

create or replace function public.event_counts(p_city text default 'munchen')
returns table (type_slug text, type_name text, sort_order int, n bigint)
language sql
stable
as $$
  select e.type_slug, e.type_name, e.type_sort_order, count(*)
  from public.events_public e
  where e.is_published and e.city_slug = p_city
    and (e.source <> 'ticketmaster' or e.starts_at is null or e.starts_at > now() - interval '8 hours')
  group by e.type_slug, e.type_name, e.type_sort_order
  order by e.type_sort_order;
$$;

drop function if exists public.city_counts();

create or replace function public.city_counts()
returns table (
  slug            text,
  name            text,
  status          text,
  sort_order            int,
  country         text,
  country_slug    text,
  continent       text,
  continent_slug  text,
  n               bigint
)
language sql
stable
as $$
  select c.slug, c.name, c.status, c.sort_order, c.country, c.country_slug,
         c.continent, c.continent_slug,
         count(e.id) filter (where e.is_published
                             and (e.source <> 'ticketmaster' or e.starts_at is null or e.starts_at > now() - interval '8 hours'))
  from public.cities c
  left join public.events e on e.city_id = c.id
  group by c.slug, c.name, c.status, c.sort_order, c.country, c.country_slug,
           c.continent, c.continent_slug
  order by c.sort_order;
$$;

grant execute on function public.city_counts()         to anon, authenticated;

grant execute on function public.deck(text, text, int)  to anon, authenticated;

grant execute on function public.event_counts(text)     to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('67_deck_today.sql', '1f9c7019e1c0d8eca57c5a6ac4fb03e867cb2dfd721e72579df6348fb379045a');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('67_deck_today.sql');
  end if;
end $$;

alter table public.notices drop constraint if exists notices_kind_check;

alter table public.notices add constraint notices_kind_check
  check (kind in ('comment_hidden', 'post_hidden', 'removed', 'profile_cleared',
                  'role', 'dj_verified', 'dj_hidden', 'report_removed', 'report_kept'));
