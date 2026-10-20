-- afterhours — a country for every city
-- Added after the setup; run once against an existing project.
-- (03_seed_catalog.sql was regenerated, so a clean install already has it.)

alter table public.cities add column if not exists country text;
alter table public.cities add column if not exists country_slug text;

-- The continent fields open up here too. 11_world.sql fills them, but
-- the 06_views.sql IN BETWEEN LOOKS AT them inside city_counts: without
-- the columns here, the update stops halfway with "column c.continent
-- does not exist". (That is exactly what happened.)
alter table public.cities add column if not exists continent text;
alter table public.cities add column if not exists continent_slug text;

update public.cities set country = 'Deutschland', country_slug = 'de'
  where slug in ('munchen', 'berlin', 'koln');
update public.cities set country = 'Türkiye', country_slug = 'tr'
  where slug in ('istanbul', 'ankara');
update public.cities set country = 'Österreich', country_slug = 'at'
  where slug in ('wien');

-- Widen the list a little. None of these has a night yet; the filter
-- shows them with their counts, so their emptiness is not hidden.
insert into public.cities (slug, name, status, sort_order, country, country_slug) values
  ('hamburg',   'hamburg',   'planned', 7,  'Deutschland', 'de'),
  ('frankfurt', 'frankfurt', 'planned', 8,  'Deutschland', 'de'),
  ('leipzig',   'leipzig',   'planned', 9,  'Deutschland', 'de'),
  ('izmir',     'izmir',     'planned', 10, 'Türkiye',     'tr'),
  ('graz',      'graz',      'planned', 11, 'Österreich',  'at')
on conflict (slug) do nothing;

create index if not exists cities_country_idx on public.cities (country_slug, sort_order);

-- The number next to each city in the filter. Only published events are
-- counted, so that an empty city looks empty.
-- Drop it first: create or replace is not enough when the type changes.
drop function if exists public.city_counts();
create or replace function public.city_counts()
returns table (
  slug          text,
  name          text,
  status        text,
  sort_order          int,
  country       text,
  country_slug  text,
  n             bigint
)
language sql
stable
as $$
  select c.slug, c.name, c.status, c.sort_order, c.country, c.country_slug,
         count(e.id) filter (where e.is_published)
  from public.cities c
  left join public.events e on e.city_id = c.id
  group by c.slug, c.name, c.status, c.sort_order, c.country, c.country_slug
  order by c.sort_order;
$$;

grant execute on function public.city_counts() to anon, authenticated;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('10_countries.sql');
  end if;
end $$;
