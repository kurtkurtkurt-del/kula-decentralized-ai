-- afterhours — where a night is, on the map
--
-- Two columns on events and one call. The Ticketmaster sync writes the
-- coordinates of the venue on every upsert (backend/tools/sync-ticketmaster.mjs);
-- the hand-written nights get theirs from the venue table, once, below.
--
--   lat / lng    the venue, WGS84. NULL means "we do not know" — the map
--                leaves the night out, the deck does not care.
--   nights_near  the nights within p_km of a point, nearest first. Same
--                row shape as events_public plus the point and the distance,
--                so the app draws a pin from it directly.
--
-- Szene nights keep their real address behind check-in: the sync never
-- touches them, and whoever enters one by hand should put the district
-- centre here, not the door.

alter table public.events add column if not exists lat double precision;
alter table public.events add column if not exists lng double precision;
alter table public.venues add column if not exists lat double precision;
alter table public.venues add column if not exists lng double precision;

create index if not exists events_geo_idx on public.events (lat, lng) where lat is not null;

-- hand-written nights inherit the point of their venue, if the venue has one
update public.events e
   set lat = v.lat, lng = v.lng
  from public.venues v
 where e.venue_id = v.id and e.lat is null and v.lat is not null;

-- ------------------------------------------------------------ nearby

-- Haversine in plain SQL: no PostGIS, no extension to switch on. Good to a
-- few metres at city scale, which is all a night needs. A bounding box
-- goes first so the index does the heavy lifting; the exact distance
-- only runs on what survives it.
create or replace function public.nights_near(
  p_lat   double precision,
  p_lng   double precision,
  p_km    double precision default 3,
  p_limit int default 80
)
returns table (
  id            uuid,
  slug          text,
  title         text,
  meta          text,
  body          text,
  poster_no     int,
  image_url     text,
  ticket_url    text,
  source        text,
  starts_at     timestamptz,
  starts_at_estimated boolean,
  date_text     text,
  type_slug     text,
  type_name     text,
  city_slug     text,
  city_name     text,
  venue_name    text,
  lat           double precision,
  lng           double precision,
  distance_km   double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with box as (
    select p_lat - p_km / 111.0                                  as lat_lo,
           p_lat + p_km / 111.0                                  as lat_hi,
           p_lng - p_km / (111.0 * cos(radians(p_lat)))          as lng_lo,
           p_lng + p_km / (111.0 * cos(radians(p_lat)))          as lng_hi
  ),
  near as (
    select e.id, e.slug, e.title, e.meta, e.body, e.poster_no, e.image_url,
           e.ticket_url, e.source, e.starts_at, e.starts_at_estimated,
           e.date_text, t.slug as type_slug, t.name as type_name,
           c.slug as city_slug, c.name as city_name, v.name as venue_name,
           e.lat, e.lng,
           2 * 6371.0 * asin(sqrt(
             power(sin(radians(e.lat - p_lat) / 2), 2)
             + cos(radians(p_lat)) * cos(radians(e.lat))
             * power(sin(radians(e.lng - p_lng) / 2), 2)
           )) as distance_km
      from public.events e
      join public.event_types t on t.id = e.type_id
      join public.cities      c on c.id = e.city_id
      left join public.venues v on v.id = e.venue_id
      cross join box
     where e.is_published
       and e.lat is not null and e.lng is not null
       and e.lat between box.lat_lo and box.lat_hi
       and e.lng between box.lng_lo and box.lng_hi
       and (e.starts_at is null or e.starts_at > now() - interval '8 hours')
  )
  select * from near
   where distance_km <= p_km
   order by distance_km, starts_at nulls last
   limit p_limit;
$$;

grant execute on function public.nights_near(double precision, double precision, double precision, int)
  to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('18_geo.sql', '845448c0da357dbe8834a5e72d1638b284b6c8fc39fbb4d71b64ee4fa94b06c5');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('18_geo.sql');
  end if;
end $$;
