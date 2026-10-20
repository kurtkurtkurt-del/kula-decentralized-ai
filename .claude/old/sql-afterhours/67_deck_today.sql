-- afterhours — the deck does not depend on the clock job (67)
--
-- A synced night whose date has passed left the deck only when hide_past_events (09,
-- pg_cron) or the morning sync got to it. When neither ran, the deck and the counters
-- served last week: on 11.10.2026 health counted 680 past nights still published
-- (A7 / F11, 20.10.2026). The map already filtered by date (18); now the deck and the
-- counters do too. Only synced nights, whose dates are real: a seed or an admin-written
-- night with an estimated date is left to the jobs.
--
-- Same bodies as 15 and 06, plus one line: a synced night stays for eight hours after
-- its start (the night is still going), then it is gone from the deck.

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
