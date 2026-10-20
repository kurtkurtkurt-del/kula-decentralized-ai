-- afterhours — the coverage: all of Europe, the key Asian countries,
-- North America.
--
-- The 54 showcase cities of 11_world.sql were a demonstration; this is
-- the real service area, chosen with the Ticketmaster sync in mind.
-- Every city here is also on the sync map in
-- backend/tools/sync-ticketmaster.mjs — the two lists move together.
--
-- Cities that already exist keep their uuid (and their events); the
-- upsert only refreshes name, country and order. Cities outside the
-- coverage are not touched here — the live cleanup script drops the
-- event-less ones, and the tests keep them for the seed nights.

insert into public.cities
  (slug, name, status, sort_order, country, country_slug, continent, continent_slug)
values
  -- ---------------------------------------------------------- Europe
  ('munchen', 'münchen', 'live', 1, 'Deutschland', 'de', 'Europe', 'eu'),
  ('berlin', 'berlin', 'live', 2, 'Deutschland', 'de', 'Europe', 'eu'),
  ('koln', 'köln', 'live', 3, 'Deutschland', 'de', 'Europe', 'eu'),
  ('hamburg', 'hamburg', 'live', 4, 'Deutschland', 'de', 'Europe', 'eu'),
  ('frankfurt', 'frankfurt', 'live', 5, 'Deutschland', 'de', 'Europe', 'eu'),
  ('stuttgart', 'stuttgart', 'live', 6, 'Deutschland', 'de', 'Europe', 'eu'),
  ('dusseldorf', 'düsseldorf', 'live', 7, 'Deutschland', 'de', 'Europe', 'eu'),
  ('leipzig', 'leipzig', 'live', 8, 'Deutschland', 'de', 'Europe', 'eu'),
  ('istanbul', 'istanbul', 'live', 9, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('ankara', 'ankara', 'live', 10, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('izmir', 'izmir', 'live', 11, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('wien', 'wien', 'live', 12, 'Österreich', 'at', 'Europe', 'eu'),
  ('graz', 'graz', 'live', 13, 'Österreich', 'at', 'Europe', 'eu'),
  ('salzburg', 'salzburg', 'live', 14, 'Österreich', 'at', 'Europe', 'eu'),
  ('zurich', 'zürich', 'live', 15, 'Schweiz', 'ch', 'Europe', 'eu'),
  ('geneva', 'genève', 'live', 16, 'Schweiz', 'ch', 'Europe', 'eu'),
  ('basel', 'basel', 'live', 17, 'Schweiz', 'ch', 'Europe', 'eu'),
  ('london', 'london', 'live', 18, 'United Kingdom', 'gb', 'Europe', 'eu'),
  ('manchester', 'manchester', 'live', 19, 'United Kingdom', 'gb', 'Europe', 'eu'),
  ('birmingham', 'birmingham', 'live', 20, 'United Kingdom', 'gb', 'Europe', 'eu'),
  ('glasgow', 'glasgow', 'live', 21, 'United Kingdom', 'gb', 'Europe', 'eu'),
  ('dublin', 'dublin', 'live', 22, 'Ireland', 'ie', 'Europe', 'eu'),
  ('cork', 'cork', 'live', 23, 'Ireland', 'ie', 'Europe', 'eu'),
  ('paris', 'paris', 'live', 24, 'France', 'fr', 'Europe', 'eu'),
  ('lyon', 'lyon', 'live', 25, 'France', 'fr', 'Europe', 'eu'),
  ('marseille', 'marseille', 'live', 26, 'France', 'fr', 'Europe', 'eu'),
  ('amsterdam', 'amsterdam', 'live', 27, 'Nederland', 'nl', 'Europe', 'eu'),
  ('rotterdam', 'rotterdam', 'live', 28, 'Nederland', 'nl', 'Europe', 'eu'),
  ('utrecht', 'utrecht', 'live', 29, 'Nederland', 'nl', 'Europe', 'eu'),
  ('brussel', 'brussel', 'live', 30, 'België', 'be', 'Europe', 'eu'),
  ('antwerpen', 'antwerpen', 'live', 31, 'België', 'be', 'Europe', 'eu'),
  ('gent', 'gent', 'live', 32, 'België', 'be', 'Europe', 'eu'),
  ('madrid', 'madrid', 'live', 33, 'España', 'es', 'Europe', 'eu'),
  ('barcelona', 'barcelona', 'live', 34, 'España', 'es', 'Europe', 'eu'),
  ('valencia', 'valencia', 'live', 35, 'España', 'es', 'Europe', 'eu'),
  ('sevilla', 'sevilla', 'live', 36, 'España', 'es', 'Europe', 'eu'),
  ('milano', 'milano', 'live', 37, 'Italia', 'it', 'Europe', 'eu'),
  ('roma', 'roma', 'live', 38, 'Italia', 'it', 'Europe', 'eu'),
  ('torino', 'torino', 'live', 39, 'Italia', 'it', 'Europe', 'eu'),
  ('bologna', 'bologna', 'live', 40, 'Italia', 'it', 'Europe', 'eu'),
  ('lisboa', 'lisboa', 'live', 41, 'Portugal', 'pt', 'Europe', 'eu'),
  ('porto', 'porto', 'live', 42, 'Portugal', 'pt', 'Europe', 'eu'),
  ('warszawa', 'warszawa', 'live', 43, 'Polska', 'pl', 'Europe', 'eu'),
  ('krakow', 'kraków', 'live', 44, 'Polska', 'pl', 'Europe', 'eu'),
  ('wroclaw', 'wrocław', 'live', 45, 'Polska', 'pl', 'Europe', 'eu'),
  ('praha', 'praha', 'live', 46, 'Česko', 'cz', 'Europe', 'eu'),
  ('brno', 'brno', 'live', 47, 'Česko', 'cz', 'Europe', 'eu'),
  ('kobenhavn', 'københavn', 'live', 48, 'Danmark', 'dk', 'Europe', 'eu'),
  ('aarhus', 'aarhus', 'live', 49, 'Danmark', 'dk', 'Europe', 'eu'),
  ('stockholm', 'stockholm', 'live', 50, 'Sverige', 'se', 'Europe', 'eu'),
  ('goteborg', 'göteborg', 'live', 51, 'Sverige', 'se', 'Europe', 'eu'),
  ('malmo', 'malmö', 'live', 52, 'Sverige', 'se', 'Europe', 'eu'),
  ('oslo', 'oslo', 'live', 53, 'Norge', 'no', 'Europe', 'eu'),
  ('bergen', 'bergen', 'live', 54, 'Norge', 'no', 'Europe', 'eu'),
  ('helsinki', 'helsinki', 'live', 55, 'Suomi', 'fi', 'Europe', 'eu'),
  ('tampere', 'tampere', 'live', 56, 'Suomi', 'fi', 'Europe', 'eu'),
  ('athina', 'athína', 'live', 57, 'Ελλάδα', 'gr', 'Europe', 'eu'),
  ('thessaloniki', 'thessaloníki', 'live', 58, 'Ελλάδα', 'gr', 'Europe', 'eu'),
  ('budapest', 'budapest', 'live', 59, 'Magyarország', 'hu', 'Europe', 'eu'),
  -- ------------------------------------------------------------ Asia
  ('tokyo', 'tokyo', 'live', 60, '日本', 'jp', 'Asia', 'as'),
  ('osaka', 'osaka', 'live', 61, '日本', 'jp', 'Asia', 'as'),
  ('seoul', 'seoul', 'live', 62, '한국', 'kr', 'Asia', 'as'),
  ('busan', 'busan', 'live', 63, '한국', 'kr', 'Asia', 'as'),
  ('singapore', 'singapore', 'live', 64, 'Singapore', 'sg', 'Asia', 'as'),
  ('dubai', 'dubai', 'live', 65, 'United Arab Emirates', 'ae', 'Asia', 'as'),
  ('abu-dhabi', 'abu dhabi', 'live', 66, 'United Arab Emirates', 'ae', 'Asia', 'as'),
  ('hong-kong', 'hong kong', 'live', 67, '香港', 'hk', 'Asia', 'as'),
  ('taipei', 'taipei', 'live', 68, '台灣', 'tw', 'Asia', 'as'),
  -- --------------------------------------------------- North America
  ('new-york', 'new york', 'live', 69, 'United States', 'us', 'North America', 'na'),
  ('los-angeles', 'los angeles', 'live', 70, 'United States', 'us', 'North America', 'na'),
  ('chicago', 'chicago', 'live', 71, 'United States', 'us', 'North America', 'na'),
  ('detroit', 'detroit', 'live', 72, 'United States', 'us', 'North America', 'na'),
  ('miami', 'miami', 'live', 73, 'United States', 'us', 'North America', 'na'),
  ('san-francisco', 'san francisco', 'live', 74, 'United States', 'us', 'North America', 'na'),
  ('las-vegas', 'las vegas', 'live', 75, 'United States', 'us', 'North America', 'na'),
  ('seattle', 'seattle', 'live', 76, 'United States', 'us', 'North America', 'na'),
  ('austin', 'austin', 'live', 77, 'United States', 'us', 'North America', 'na'),
  ('boston', 'boston', 'live', 78, 'United States', 'us', 'North America', 'na'),
  ('atlanta', 'atlanta', 'live', 79, 'United States', 'us', 'North America', 'na'),
  ('philadelphia', 'philadelphia', 'live', 80, 'United States', 'us', 'North America', 'na'),
  ('washington', 'washington', 'live', 81, 'United States', 'us', 'North America', 'na'),
  ('denver', 'denver', 'live', 82, 'United States', 'us', 'North America', 'na'),
  ('nashville', 'nashville', 'live', 83, 'United States', 'us', 'North America', 'na'),
  ('new-orleans', 'new orleans', 'live', 84, 'United States', 'us', 'North America', 'na'),
  ('houston', 'houston', 'live', 85, 'United States', 'us', 'North America', 'na'),
  ('dallas', 'dallas', 'live', 86, 'United States', 'us', 'North America', 'na'),
  ('toronto', 'toronto', 'live', 87, 'Canada', 'ca', 'North America', 'na'),
  ('montreal', 'montréal', 'live', 88, 'Canada', 'ca', 'North America', 'na'),
  ('vancouver', 'vancouver', 'live', 89, 'Canada', 'ca', 'North America', 'na'),
  ('calgary', 'calgary', 'live', 90, 'Canada', 'ca', 'North America', 'na'),
  ('ottawa', 'ottawa', 'live', 91, 'Canada', 'ca', 'North America', 'na'),
  ('ciudad-de-mexico', 'ciudad de méxico', 'live', 92, 'México', 'mx', 'North America', 'na'),
  ('guadalajara', 'guadalajara', 'live', 93, 'México', 'mx', 'North America', 'na'),
  ('monterrey', 'monterrey', 'live', 94, 'México', 'mx', 'North America', 'na')
on conflict (slug) do update set
  name = excluded.name,
  status = excluded.status,
  sort_order = excluded.sort_order,
  country = excluded.country,
  country_slug = excluded.country_slug,
  continent = excluded.continent,
  continent_slug = excluded.continent_slug;

-- Showcase cities outside the coverage lose their place in the filter as
-- soon as nothing points at them. Here that only catches cities that
-- never had a night; the live cleanup (which removes the seed nights
-- first) catches the rest.
delete from public.cities c
where c.continent_slug not in ('eu', 'as', 'na')
  and not exists (select 1 from public.events e where e.city_id = c.id);

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('16_coverage.sql', 'e99e9d89a3c29bd7e2a68e3db1818e0dc8de82565f4b1fe10a7d1816d795c667');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('16_coverage.sql');
  end if;
end $$;
