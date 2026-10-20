-- ============================================================
--  afterhours — THE WORLD: 6 continents, 18 countries, 54 cities, 106 nights
--
--  GENERATED FILE — source: backend/tools/world-sql.mjs
--  The content is invented but written by hand; the posters were
--  generated alongside it (posters/37.svg … 142.svg).
-- ============================================================

-- Continent fields on the cities
alter table public.cities add column if not exists continent text;
alter table public.cities add column if not exists continent_slug text;

-- Drop the cities with no nights that broke the shape (three per country).
delete from public.cities
where slug in ('hamburg', 'frankfurt', 'leipzig')
  and not exists (select 1 from public.events e where e.city_id = cities.id);

insert into public.cities
  (slug, name, status, sort_order, country, country_slug, continent, continent_slug)
values
  ('munchen', 'münchen', 'live', 1, 'Deutschland', 'de', 'Europe', 'eu'),
  ('berlin', 'berlin', 'live', 2, 'Deutschland', 'de', 'Europe', 'eu'),
  ('koln', 'köln', 'live', 3, 'Deutschland', 'de', 'Europe', 'eu'),
  ('istanbul', 'istanbul', 'live', 4, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('ankara', 'ankara', 'live', 5, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('izmir', 'izmir', 'live', 6, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('wien', 'wien', 'live', 7, 'Österreich', 'at', 'Europe', 'eu'),
  ('graz', 'graz', 'live', 8, 'Österreich', 'at', 'Europe', 'eu'),
  ('salzburg', 'salzburg', 'live', 9, 'Österreich', 'at', 'Europe', 'eu'),
  ('tokyo', 'tokyo', 'live', 10, '日本', 'jp', 'Asia', 'as'),
  ('osaka', 'osaka', 'live', 11, '日本', 'jp', 'Asia', 'as'),
  ('kyoto', 'kyoto', 'live', 12, '日本', 'jp', 'Asia', 'as'),
  ('seoul', 'seoul', 'live', 13, '한국', 'kr', 'Asia', 'as'),
  ('busan', 'busan', 'live', 14, '한국', 'kr', 'Asia', 'as'),
  ('daegu', 'daegu', 'live', 15, '한국', 'kr', 'Asia', 'as'),
  ('jakarta', 'jakarta', 'live', 16, 'Indonesia', 'id', 'Asia', 'as'),
  ('bandung', 'bandung', 'live', 17, 'Indonesia', 'id', 'Asia', 'as'),
  ('yogyakarta', 'yogyakarta', 'live', 18, 'Indonesia', 'id', 'Asia', 'as'),
  ('lagos', 'lagos', 'live', 19, 'Nigeria', 'ng', 'Africa', 'af'),
  ('abuja', 'abuja', 'live', 20, 'Nigeria', 'ng', 'Africa', 'af'),
  ('ibadan', 'ibadan', 'live', 21, 'Nigeria', 'ng', 'Africa', 'af'),
  ('nairobi', 'nairobi', 'live', 22, 'Kenya', 'ke', 'Africa', 'af'),
  ('mombasa', 'mombasa', 'live', 23, 'Kenya', 'ke', 'Africa', 'af'),
  ('kisumu', 'kisumu', 'live', 24, 'Kenya', 'ke', 'Africa', 'af'),
  ('casablanca', 'casablanca', 'live', 25, 'Maroc', 'ma', 'Africa', 'af'),
  ('marrakesh', 'marrakesh', 'live', 26, 'Maroc', 'ma', 'Africa', 'af'),
  ('tanger', 'tanger', 'live', 27, 'Maroc', 'ma', 'Africa', 'af'),
  ('new-york', 'new york', 'live', 28, 'United States', 'us', 'North America', 'na'),
  ('chicago', 'chicago', 'live', 29, 'United States', 'us', 'North America', 'na'),
  ('detroit', 'detroit', 'live', 30, 'United States', 'us', 'North America', 'na'),
  ('ciudad-de-mexico', 'ciudad de méxico', 'live', 31, 'México', 'mx', 'North America', 'na'),
  ('guadalajara', 'guadalajara', 'live', 32, 'México', 'mx', 'North America', 'na'),
  ('monterrey', 'monterrey', 'live', 33, 'México', 'mx', 'North America', 'na'),
  ('montreal', 'montréal', 'live', 34, 'Canada', 'ca', 'North America', 'na'),
  ('toronto', 'toronto', 'live', 35, 'Canada', 'ca', 'North America', 'na'),
  ('vancouver', 'vancouver', 'live', 36, 'Canada', 'ca', 'North America', 'na'),
  ('sao-paulo', 'são paulo', 'live', 37, 'Brasil', 'br', 'South America', 'sa'),
  ('rio-de-janeiro', 'rio de janeiro', 'live', 38, 'Brasil', 'br', 'South America', 'sa'),
  ('belo-horizonte', 'belo horizonte', 'live', 39, 'Brasil', 'br', 'South America', 'sa'),
  ('buenos-aires', 'buenos aires', 'live', 40, 'Argentina', 'ar', 'South America', 'sa'),
  ('cordoba', 'córdoba', 'live', 41, 'Argentina', 'ar', 'South America', 'sa'),
  ('rosario', 'rosario', 'live', 42, 'Argentina', 'ar', 'South America', 'sa'),
  ('bogota', 'bogotá', 'live', 43, 'Colombia', 'co', 'South America', 'sa'),
  ('medellin', 'medellín', 'live', 44, 'Colombia', 'co', 'South America', 'sa'),
  ('cali', 'cali', 'live', 45, 'Colombia', 'co', 'South America', 'sa'),
  ('sydney', 'sydney', 'live', 46, 'Australia', 'au', 'Oceania', 'oc'),
  ('melbourne', 'melbourne', 'live', 47, 'Australia', 'au', 'Oceania', 'oc'),
  ('brisbane', 'brisbane', 'live', 48, 'Australia', 'au', 'Oceania', 'oc'),
  ('auckland', 'auckland', 'live', 49, 'Aotearoa', 'nz', 'Oceania', 'oc'),
  ('wellington', 'wellington', 'live', 50, 'Aotearoa', 'nz', 'Oceania', 'oc'),
  ('christchurch', 'christchurch', 'live', 51, 'Aotearoa', 'nz', 'Oceania', 'oc'),
  ('suva', 'suva', 'live', 52, 'Viti', 'fj', 'Oceania', 'oc'),
  ('nadi', 'nadi', 'live', 53, 'Viti', 'fj', 'Oceania', 'oc'),
  ('lautoka', 'lautoka', 'live', 54, 'Viti', 'fj', 'Oceania', 'oc')
on conflict (slug) do update set
  name = excluded.name,
  status = excluded.status,
  sort_order = excluded.sort_order,
  country = excluded.country,
  country_slug = excluded.country_slug,
  continent = excluded.continent,
  continent_slug = excluded.continent_slug;

create index if not exists cities_continent_idx
  on public.cities (continent_slug, country_slug, sort_order);

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'berlin-betonhalle', c.id, t.id, 'Betonhalle', 'Kraftwerk Mitte · 12.09 · 23:30', 'Concrete, three storeys of it, and a sound system that treats the building as a cabinet.',
       37, '2026-09-12T23:30:00+02:00'::timestamptz, false, '12.09 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'berlin'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'berlin-sonntagsclub', c.id, t.id, 'Sonntagsclub', 'Neukölln basement · 20.09 · 22:00', 'Sunday evening as a proper night out. Everyone has work tomorrow and nobody mentions it.',
       38, '2026-09-20T22:00:00+02:00'::timestamptz, false, '20.09 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'berlin'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'koln-domplatte', c.id, t.id, 'Domplatte', 'Kulturkirche · 03.10 · 20:00', 'A choir, a drum machine, and a church that was not built for either.',
       39, '2026-10-03T20:00:00+02:00'::timestamptz, false, '03.10 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'koln'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'koln-zweite-etage', c.id, t.id, 'Zweite Etage', 'Ehrenfeld · 17.10 · 21:00', 'Fourth flat on the left. The neighbours are invited, which is the only reason it works.',
       40, '2026-10-17T21:00:00+02:00'::timestamptz, false, '17.10 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'koln'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'istanbul-karakoy-alt-kat', c.id, t.id, 'Karaköy Alt Kat', 'Karaköy · 19.09 · 23:00', 'Below street level, one room, and the ferry horn coming through the wall at 2am.',
       41, '2026-09-19T23:00:00+02:00'::timestamptz, false, '19.09 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'istanbul'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'istanbul-plak-degisimi', c.id, t.id, 'Plak Değişimi', 'Kadıköy · 27.09 · 16:00', 'Bring three records you are done with. Leave with three you are not.',
       42, '2026-09-27T16:00:00+02:00'::timestamptz, false, '27.09 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'istanbul'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ankara-sanat-sahnesi', c.id, t.id, 'Sanat Sahnesi', 'Kızılay · 10.10 · 20:30', 'A hall built for speeches, borrowed for a band that does not make any.',
       43, '2026-10-10T20:30:00+02:00'::timestamptz, false, '10.10 · 20:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'ankara'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ankara-depo-gecesi', c.id, t.id, 'Depo Gecesi', 'Ostim · 24.10 · 00:30', 'An industrial district that empties at six and fills again at midnight.',
       44, '2026-10-24T00:30:00+02:00'::timestamptz, false, '24.10 · 00:30'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'ankara'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'izmir-korfez-acik-hava', c.id, t.id, 'Körfez Açık Hava', 'Kültürpark · 05.09 · 18:00', 'Five hours of sea breeze, then the wind drops and the bass finally sits still.',
       45, '2026-09-05T18:00:00+02:00'::timestamptz, false, '05.09 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'izmir'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'izmir-alsancak-gec-saat', c.id, t.id, 'Alsancak Geç Saat', 'Alsancak · 18.10 · 23:30', 'The street is loud until two; the room is louder after.',
       46, '2026-10-18T23:30:00+02:00'::timestamptz, false, '18.10 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'izmir'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'wien-gurtelbogen', c.id, t.id, 'Gürtelbogen', 'Stadtbahnbögen · 26.09 · 22:30', 'Under the railway arches, a train passing every four minutes and nobody flinching.',
       47, '2026-09-26T22:30:00+02:00'::timestamptz, false, '26.09 · 22:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'wien'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'wien-kaffeehaus-runde', c.id, t.id, 'Kaffeehaus Runde', 'Josefstadt · 11.10 · 17:00', 'One table, one waiter who has seen it all, and no agenda whatsoever.',
       48, '2026-10-11T17:00:00+02:00'::timestamptz, false, '11.10 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'wien'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'graz-altbau-dritter', c.id, t.id, 'Altbau Dritter', 'Lend · 04.10 · 21:30', 'High ceilings, thin walls, and a landlord who is somehow also invited.',
       49, '2026-10-04T21:30:00+02:00'::timestamptz, false, '04.10 · 21:30'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'graz'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'graz-murufer', c.id, t.id, 'Murufer', 'Kunsthaus · 22.11 · 20:00', 'Played to the river, which does not applaud but does carry the sound.',
       50, '2026-11-22T20:00:00+02:00'::timestamptz, false, '22.11 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'graz'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'salzburg-kellergewolbe', c.id, t.id, 'Kellergewölbe', 'Altstadt · 14.11 · 19:30', 'A cellar older than the country, and a set that leans into the reverb.',
       51, '2026-11-14T19:30:00+02:00'::timestamptz, false, '14.11 · 19:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'salzburg'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'salzburg-bergweg-fruhstuck', c.id, t.id, 'Bergweg Frühstück', 'Kapuzinerberg · 29.11 · 09:00', 'Walk up, eat, walk down. The whole event is the walk.',
       52, '2026-11-29T09:00:00+02:00'::timestamptz, false, '29.11 · 09:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'salzburg'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'tokyo-shibuya-chika', c.id, t.id, 'Shibuya Chika', 'Dogenzaka basement · 13.09 · 23:00', 'Second basement, forty people, and a policy of never announcing who is playing.',
       53, '2026-09-13T23:00:00+02:00'::timestamptz, false, '13.09 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'tokyo'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'tokyo-bayside-warehouse', c.id, t.id, 'Bayside Warehouse', 'Shinkiba · 27.09 · 01:00', 'Out where the trains stop early, so nobody leaves before the sun.',
       54, '2026-09-27T01:00:00+02:00'::timestamptz, false, '27.09 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'tokyo'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'osaka-namba-loft', c.id, t.id, 'Namba Loft', 'Namba · 08.10 · 19:00', 'Three bands, one hour each, and a crowd that stays for all three.',
       55, '2026-10-08T19:00:00+02:00'::timestamptz, false, '08.10 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'osaka'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'osaka-nagaya-night', c.id, t.id, 'Nagaya Night', 'Nishinari · 25.10 · 20:00', 'A row house with the doors open and the party spilling into the lane.',
       56, '2026-10-25T20:00:00+02:00'::timestamptz, false, '25.10 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'osaka'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'kyoto-kamogawa-sit', c.id, t.id, 'Kamogawa Sit', 'Kamo riverbank · 20.09 · 18:30', 'Everyone sits the same distance apart. Nobody planned it; it just happens here.',
       57, '2026-09-20T18:30:00+02:00'::timestamptz, false, '20.09 · 18:30'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'kyoto'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'kyoto-machiya-sound', c.id, t.id, 'Machiya Sound', 'Nakagyo · 15.11 · 22:00', 'A wooden townhouse with a sound system that respects the wood.',
       58, '2026-11-15T22:00:00+02:00'::timestamptz, false, '15.11 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'kyoto'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'seoul-mullae-ironworks', c.id, t.id, 'Mullae Ironworks', 'Mullae-dong · 19.09 · 23:30', 'Metal shops by day, still smelling of it by night, which somehow suits the music.',
       59, '2026-09-19T23:30:00+02:00'::timestamptz, false, '19.09 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'seoul'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'seoul-itaewon-late', c.id, t.id, 'Itaewon Late', 'Itaewon · 10.10 · 23:00', 'The last hour is the point. Everything before it is a waiting room.',
       60, '2026-10-10T23:00:00+02:00'::timestamptz, false, '10.10 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'seoul'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'busan-gwangalli-open-air', c.id, t.id, 'Gwangalli Open Air', 'Gwangalli Beach · 12.09 · 17:00', 'The bridge lights up at nine and the whole crowd turns around for it.',
       61, '2026-09-12T17:00:00+02:00'::timestamptz, false, '12.09 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'busan'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'busan-jagalchi-morning', c.id, t.id, 'Jagalchi Morning', 'Jagalchi Market · 26.09 · 07:00', 'For people who would rather start a day than end one.',
       62, '2026-09-26T07:00:00+02:00'::timestamptz, false, '26.09 · 07:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'busan'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'daegu-bangcheon-stage', c.id, t.id, 'Bangcheon Stage', 'Bangcheon Market · 17.10 · 19:30', 'A market alley that turns into a room once the shutters come down.',
       63, '2026-10-17T19:30:00+02:00'::timestamptz, false, '17.10 · 19:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'daegu'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'daegu-rooftop-4f', c.id, t.id, 'Rooftop 4F', 'Jung-gu · 07.11 · 21:00', 'Fourth floor, no lift, and everyone arrives slightly out of breath.',
       64, '2026-11-07T21:00:00+02:00'::timestamptz, false, '07.11 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'daegu'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'jakarta-kota-tua-cellar', c.id, t.id, 'Kota Tua Cellar', 'Kota Tua · 26.09 · 22:30', 'Colonial walls, tropical heat, and a fan that gave up an hour ago.',
       65, '2026-09-26T22:30:00+02:00'::timestamptz, false, '26.09 · 22:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'jakarta'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'jakarta-ancol-late', c.id, t.id, 'Ancol Late', 'Ancol · 24.10 · 00:00', 'By the water, where the city finally stops being loud in the other way.',
       66, '2026-10-24T00:00:00+02:00'::timestamptz, false, '24.10 · 00:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'jakarta'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'bandung-dago-hall', c.id, t.id, 'Dago Hall', 'Dago · 11.10 · 19:00', 'Cool enough at altitude that nobody complains about standing.',
       67, '2026-10-11T19:00:00+02:00'::timestamptz, false, '11.10 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'bandung'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'bandung-zine-sore', c.id, t.id, 'Zine Sore', 'Braga · 01.11 · 16:00', 'Photocopied, stapled, handed over. The whole economy runs on trade.',
       68, '2026-11-01T16:00:00+02:00'::timestamptz, false, '01.11 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'bandung'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'yogyakarta-kos-kosan', c.id, t.id, 'Kos Kosan', 'Sleman · 18.10 · 20:30', 'A student boarding house where the rule is that you bring something.',
       69, '2026-10-18T20:30:00+02:00'::timestamptz, false, '18.10 · 20:30'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'yogyakarta'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'yogyakarta-sawah-sonic', c.id, t.id, 'Sawah Sonic', 'rice terraces · 22.11 · 16:00', 'Speakers between the fields. The frogs join in after dark and stay.',
       70, '2026-11-22T16:00:00+02:00'::timestamptz, false, '22.11 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'yogyakarta'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'lagos-yaba-backroom', c.id, t.id, 'Yaba Backroom', 'Yaba · 19.09 · 23:00', 'Behind a phone repair shop, and the queue knows exactly which door.',
       71, '2026-09-19T23:00:00+02:00'::timestamptz, false, '19.09 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'lagos'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'lagos-freedom-park-live', c.id, t.id, 'Freedom Park Live', 'Lagos Island · 10.10 · 19:00', 'An old prison yard that has been a concert venue longer than it was a prison.',
       72, '2026-10-10T19:00:00+02:00'::timestamptz, false, '10.10 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'lagos'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'abuja-rock-bottom', c.id, t.id, 'Rock Bottom', 'Wuse · 03.10 · 00:00', 'A city designed on paper, and a night that ignores the plan entirely.',
       73, '2026-10-03T00:00:00+02:00'::timestamptz, false, '03.10 · 00:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'abuja'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'abuja-sunday-sound', c.id, t.id, 'Sunday Sound', 'Jabi Lake · 25.10 · 17:00', 'Everyone brings one speaker. It should not work and it does.',
       74, '2026-10-25T17:00:00+02:00'::timestamptz, false, '25.10 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'abuja'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ibadan-bodija-compound', c.id, t.id, 'Bodija Compound', 'Bodija · 17.10 · 20:00', 'A compound, four families, and one generator that everyone is polite about.',
       75, '2026-10-17T20:00:00+02:00'::timestamptz, false, '17.10 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'ibadan'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ibadan-agodi-open-air', c.id, t.id, 'Agodi Open Air', 'Agodi Gardens · 14.11 · 16:00', 'Starts in daylight so the drummers can see each other.',
       76, '2026-11-14T16:00:00+02:00'::timestamptz, false, '14.11 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'ibadan'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'nairobi-westlands-basement', c.id, t.id, 'Westlands Basement', 'Westlands · 26.09 · 22:30', 'Down two flights, and the traffic above stops mattering.',
       77, '2026-09-26T22:30:00+02:00'::timestamptz, false, '26.09 · 22:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'nairobi'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'nairobi-industrial-area', c.id, t.id, 'Industrial Area', 'Enterprise Road · 07.11 · 01:00', 'Warehouses that are still warehouses on Monday morning.',
       78, '2026-11-07T01:00:00+02:00'::timestamptz, false, '07.11 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'nairobi'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'mombasa-old-town-beats', c.id, t.id, 'Old Town Beats', 'Old Town · 12.09 · 18:00', 'Coral walls hold the heat and hand it back all evening.',
       79, '2026-09-12T18:00:00+02:00'::timestamptz, false, '12.09 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'mombasa'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'mombasa-dhow-sunset', c.id, t.id, 'Dhow Sunset', 'Tudor Creek · 04.10 · 17:30', 'On the water for two hours. There is nowhere to go, which is the design.',
       80, '2026-10-04T17:30:00+02:00'::timestamptz, false, '04.10 · 17:30'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'mombasa'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'kisumu-lakeside-stage', c.id, t.id, 'Lakeside Stage', 'Dunga Beach · 24.10 · 18:30', 'The lake goes flat at dusk and the sound carries much further than it should.',
       81, '2026-10-24T18:30:00+02:00'::timestamptz, false, '24.10 · 18:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'kisumu'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'kisumu-milimani-house', c.id, t.id, 'Milimani House', 'Milimani · 21.11 · 20:00', 'One long table outside, and nobody sits at it until midnight.',
       82, '2026-11-21T20:00:00+02:00'::timestamptz, false, '21.11 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'kisumu'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'casablanca-corniche-sous-sol', c.id, t.id, 'Corniche Sous-Sol', 'Ain Diab · 10.10 · 23:30', 'The sea on one side, a wall of speakers on the other.',
       83, '2026-10-10T23:30:00+02:00'::timestamptz, false, '10.10 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'casablanca'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'casablanca-ancienne-medina', c.id, t.id, 'Ancienne Médina', 'Old Medina · 28.11 · 20:00', 'A courtyard with four walls and a ceiling of exactly nothing.',
       84, '2026-11-28T20:00:00+02:00'::timestamptz, false, '28.11 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'casablanca'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'marrakesh-riad-rooftop', c.id, t.id, 'Riad Rooftop', 'Medina · 19.09 · 18:00', 'Mint tea, low cushions, and the call to prayer cutting cleanly through the conversation.',
       85, '2026-09-19T18:00:00+02:00'::timestamptz, false, '19.09 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'marrakesh'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'marrakesh-palmeraie-night', c.id, t.id, 'Palmeraie Night', 'Palmeraie · 31.10 · 23:00', 'Out among the palms, where the sound has nothing to bounce off.',
       86, '2026-10-31T23:00:00+02:00'::timestamptz, false, '31.10 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'marrakesh'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'tanger-detroit-sessions', c.id, t.id, 'Détroit Sessions', 'Cap Spartel · 05.09 · 17:00', 'Two seas meet here and the wind cannot decide which way to blow.',
       87, '2026-09-05T17:00:00+02:00'::timestamptz, false, '05.09 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'tanger'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'tanger-rue-de-la-plage', c.id, t.id, 'Rue de la Plage', 'Malabata · 14.11 · 23:00', 'A room that has been a cinema, a café, and now this.',
       88, '2026-11-14T23:00:00+02:00'::timestamptz, false, '14.11 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'tanger'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'new-york-bushwick-loft', c.id, t.id, 'Bushwick Loft', 'Bushwick · 12.09 · 23:00', 'Freight lift, fourth floor, and a door person who remembers faces.',
       89, '2026-09-12T23:00:00+02:00'::timestamptz, false, '12.09 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'new-york'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'new-york-bowery-basement', c.id, t.id, 'Bowery Basement', 'Lower East Side · 03.10 · 20:00', 'Two hundred people in a room built for eighty, which is the tradition.',
       90, '2026-10-03T20:00:00+02:00'::timestamptz, false, '03.10 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'new-york'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'chicago-south-side-warehouse', c.id, t.id, 'South Side Warehouse', 'Bridgeport · 26.09 · 00:00', 'Where the whole thing started, and the room still acts like it knows.',
       91, '2026-09-26T00:00:00+02:00'::timestamptz, false, '26.09 · 00:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'chicago'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'chicago-record-fair', c.id, t.id, 'Record Fair', 'Pilsen · 18.10 · 11:00', 'Crates on folding tables. Bring cash and a bag you can carry home.',
       92, '2026-10-18T11:00:00+02:00'::timestamptz, false, '18.10 · 11:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'chicago'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'detroit-eastern-market-late', c.id, t.id, 'Eastern Market Late', 'Eastern Market · 10.10 · 23:30', 'Produce sheds by day. The concrete floor takes the low end perfectly.',
       93, '2026-10-10T23:30:00+02:00'::timestamptz, false, '10.10 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'detroit'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'detroit-riverfront-open-air', c.id, t.id, 'Riverfront Open Air', 'Detroit Riverfront · 05.09 · 15:00', 'Canada on the far bank, close enough to wave at.',
       94, '2026-09-05T15:00:00+02:00'::timestamptz, false, '05.09 · 15:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'detroit'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ciudad-de-mexico-roma-norte-sotano', c.id, t.id, 'Roma Norte Sótano', 'Roma Norte · 19.09 · 23:30', 'A basement under a building that survived two earthquakes and shows it.',
       95, '2026-09-19T23:30:00+02:00'::timestamptz, false, '19.09 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'ciudad-de-mexico'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ciudad-de-mexico-vecindad', c.id, t.id, 'Vecindad', 'Doctores · 07.11 · 01:00', 'Courtyard housing, doors open onto it, and the party is the courtyard.',
       96, '2026-11-07T01:00:00+02:00'::timestamptz, false, '07.11 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'ciudad-de-mexico'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'guadalajara-teatro-chico', c.id, t.id, 'Teatro Chico', 'Centro · 24.10 · 20:00', 'Velvet seats nobody uses, because everyone stands from the first song.',
       97, '2026-10-24T20:00:00+02:00'::timestamptz, false, '24.10 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'guadalajara'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'guadalajara-azotea', c.id, t.id, 'Azotea', 'Americana · 14.11 · 21:00', 'Rooftop, string lights, and a view of every other rooftop doing the same.',
       98, '2026-11-14T21:00:00+02:00'::timestamptz, false, '14.11 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'guadalajara'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'monterrey-cerro-sonoro', c.id, t.id, 'Cerro Sonoro', 'Parque Fundidora · 12.09 · 16:00', 'Old steelworks, mountains behind, and heat that only breaks at nine.',
       99, '2026-09-12T16:00:00+02:00'::timestamptz, false, '12.09 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'monterrey'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'monterrey-fanzine-nocturno', c.id, t.id, 'Fanzine Nocturno', 'Barrio Antiguo · 01.11 · 18:00', 'Photocopies, folding tables, and arguments about staples.',
       100, '2026-11-01T18:00:00+02:00'::timestamptz, false, '01.11 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'monterrey'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'montreal-mile-end-loft', c.id, t.id, 'Mile End Loft', 'Mile End · 03.10 · 23:00', 'A permit that expires at three and a crowd that has read it.',
       101, '2026-10-03T23:00:00+02:00'::timestamptz, false, '03.10 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'montreal'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'montreal-plateau-church', c.id, t.id, 'Plateau Church', 'Le Plateau · 21.11 · 19:30', 'Deconsecrated, freezing, and acoustically almost unfair.',
       102, '2026-11-21T19:30:00+02:00'::timestamptz, false, '21.11 · 19:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'montreal'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'toronto-junction-warehouse', c.id, t.id, 'Junction Warehouse', 'The Junction · 17.10 · 00:30', 'Beside a rail line, so the low end has competition twice an hour.',
       103, '2026-10-17T00:30:00+02:00'::timestamptz, false, '17.10 · 00:30'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'toronto'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'toronto-kensington-swap', c.id, t.id, 'Kensington Swap', 'Kensington Market · 27.09 · 13:00', 'Trade a record, trade a jacket, trade a phone number. All equally likely.',
       104, '2026-09-27T13:00:00+02:00'::timestamptz, false, '27.09 · 13:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'toronto'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'vancouver-east-van-basement', c.id, t.id, 'East Van Basement', 'East Vancouver · 07.11 · 21:00', 'Rain outside, condensation inside, and nobody going home early because of either.',
       105, '2026-11-07T21:00:00+02:00'::timestamptz, false, '07.11 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'vancouver'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'vancouver-harbour-open-air', c.id, t.id, 'Harbour Open Air', 'Crab Park · 05.09 · 15:00', 'Mountains on one side, container cranes on the other.',
       106, '2026-09-05T15:00:00+02:00'::timestamptz, false, '05.09 · 15:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'vancouver'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'sao-paulo-barra-funda', c.id, t.id, 'Barra Funda', 'Barra Funda · 19.09 · 23:59', 'Nothing starts before midnight and nothing ends before the metro reopens.',
       107, '2026-09-19T23:59:00+02:00'::timestamptz, false, '19.09 · 23:59'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'sao-paulo'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'sao-paulo-minhoc-o', c.id, t.id, 'Minhocão', 'Elevado · 31.10 · 01:00', 'An elevated road closed to cars on Sundays, borrowed a few hours early.',
       108, '2026-10-31T01:00:00+02:00'::timestamptz, false, '31.10 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'sao-paulo'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'rio-de-janeiro-lapa-arcos', c.id, t.id, 'Lapa Arcos', 'Lapa · 12.09 · 18:00', 'Under the arches, where four sound systems negotiate all night.',
       109, '2026-09-12T18:00:00+02:00'::timestamptz, false, '12.09 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'rio-de-janeiro'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'rio-de-janeiro-roda-na-praca', c.id, t.id, 'Roda na Praça', 'Santa Teresa · 04.10 · 16:00', 'A circle, instruments passed around it, and no stage anywhere.',
       110, '2026-10-04T16:00:00+02:00'::timestamptz, false, '04.10 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'rio-de-janeiro'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'belo-horizonte-praca-sonora', c.id, t.id, 'Praça Sonora', 'Savassi · 24.10 · 19:00', 'A square that fills from the edges in, until you cannot see where it started.',
       111, '2026-10-24T19:00:00+02:00'::timestamptz, false, '24.10 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'belo-horizonte'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'belo-horizonte-casa-amarela', c.id, t.id, 'Casa Amarela', 'Santa Efigênia · 21.11 · 21:00', 'Yellow house, green gate, and a hill that punishes anyone who arrives late.',
       112, '2026-11-21T21:00:00+02:00'::timestamptz, false, '21.11 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'belo-horizonte'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'buenos-aires-palermo-sotano', c.id, t.id, 'Palermo Sótano', 'Palermo · 26.09 · 01:00', 'Dinner at eleven, arrive at one, leave when the bakeries open.',
       113, '2026-09-26T01:00:00+02:00'::timestamptz, false, '26.09 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'buenos-aires'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'buenos-aires-galpon-san-telmo', c.id, t.id, 'Galpón San Telmo', 'San Telmo · 14.11 · 20:30', 'A shed with a tin roof that becomes an instrument when it rains.',
       114, '2026-11-14T20:30:00+02:00'::timestamptz, false, '14.11 · 20:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'buenos-aires'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'cordoba-sierra-chica', c.id, t.id, 'Sierra Chica', 'outside the city · 10.10 · 23:00', 'Forty minutes out, no lights on the road, and a horizon you can hear.',
       115, '2026-10-10T23:00:00+02:00'::timestamptz, false, '10.10 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'cordoba'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'cordoba-feria-de-discos', c.id, t.id, 'Feria de Discos', 'Güemes · 18.10 · 12:00', 'Sunday, tables, and one man who will not sell you the record you want.',
       116, '2026-10-18T12:00:00+02:00'::timestamptz, false, '18.10 · 12:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'cordoba'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'rosario-costanera', c.id, t.id, 'Costanera', 'Paraná riverfront · 05.09 · 17:00', 'The river is a kilometre wide here and the sound just keeps going.',
       117, '2026-09-05T17:00:00+02:00'::timestamptz, false, '05.09 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'rosario'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'rosario-casa-chica', c.id, t.id, 'Casa Chica', 'Pichincha · 07.11 · 22:00', 'A small house with too many people in it, which is the entire concept.',
       118, '2026-11-07T22:00:00+02:00'::timestamptz, false, '07.11 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'rosario'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'bogota-chapinero-bajo', c.id, t.id, 'Chapinero Bajo', 'Chapinero · 19.09 · 22:30', 'Two thousand six hundred metres up, so pace yourself early.',
       119, '2026-09-19T22:30:00+02:00'::timestamptz, false, '19.09 · 22:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'bogota'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'bogota-bodega-norte', c.id, t.id, 'Bodega Norte', 'Usaquén · 28.11 · 00:00', 'Cold outside, which makes the room feel like a decision.',
       120, '2026-11-28T00:00:00+02:00'::timestamptz, false, '28.11 · 00:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'bogota'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'medellin-comuna-abierta', c.id, t.id, 'Comuna Abierta', 'Comuna 13 · 12.09 · 15:00', 'Escalators up the hillside, sound at every landing.',
       121, '2026-09-12T15:00:00+02:00'::timestamptz, false, '12.09 · 15:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'medellin'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'medellin-intercambio', c.id, t.id, 'Intercambio', 'Laureles · 01.11 · 17:00', 'Bring something to swap and something to say about it.',
       122, '2026-11-01T17:00:00+02:00'::timestamptz, false, '01.11 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'medellin'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'cali-salsa-vieja', c.id, t.id, 'Salsa Vieja', 'Barrio Obrero · 17.10 · 21:00', 'Live brass in a room where everyone already knows the steps.',
       123, '2026-10-17T21:00:00+02:00'::timestamptz, false, '17.10 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'cali'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'cali-terraza', c.id, t.id, 'Terraza', 'San Antonio · 21.11 · 20:00', 'A terrace above the old town, and a hill that keeps the noise local.',
       124, '2026-11-21T20:00:00+02:00'::timestamptz, false, '21.11 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'cali'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'sydney-marrickville-warehouse', c.id, t.id, 'Marrickville Warehouse', 'Marrickville · 26.09 · 22:00', 'Industrial estate, one unmarked roller door, and a noise complaint waiting to happen.',
       125, '2026-09-26T22:00:00+02:00'::timestamptz, false, '26.09 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'sydney'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'sydney-harbour-sunset', c.id, t.id, 'Harbour Sunset', 'Barangaroo · 05.09 · 16:00', 'Finishes at ten because the council says so, and nobody argues.',
       126, '2026-09-05T16:00:00+02:00'::timestamptz, false, '05.09 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'sydney'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'melbourne-laneway-late', c.id, t.id, 'Laneway Late', 'Collingwood · 10.10 · 00:00', 'A lane so narrow the sound has nowhere to go but up.',
       127, '2026-10-10T00:00:00+02:00'::timestamptz, false, '10.10 · 00:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'melbourne'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'melbourne-vinyl-sunday', c.id, t.id, 'Vinyl Sunday', 'Fitzroy · 18.10 · 12:00', 'Four hours, no phones on the table, and coffee taken very seriously.',
       128, '2026-10-18T12:00:00+02:00'::timestamptz, false, '18.10 · 12:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'melbourne'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'brisbane-fortitude-hall', c.id, t.id, 'Fortitude Hall', 'Fortitude Valley · 24.10 · 19:30', 'Humid enough that the band and the crowd are equally wet by the third song.',
       129, '2026-10-24T19:30:00+02:00'::timestamptz, false, '24.10 · 19:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'brisbane'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'brisbane-queenslander', c.id, t.id, 'Queenslander', 'West End · 14.11 · 20:00', 'A house on stilts, the party underneath it, and the mosquitos invited.',
       130, '2026-11-14T20:00:00+02:00'::timestamptz, false, '14.11 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'brisbane'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'auckland-k-road-basement', c.id, t.id, 'K Road Basement', 'Karangahape Road · 19.09 · 23:00', 'The street has changed hands four times; the basement has not changed at all.',
       131, '2026-09-19T23:00:00+02:00'::timestamptz, false, '19.09 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'auckland'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'auckland-waterfront-walk', c.id, t.id, 'Waterfront Walk', 'Wynyard Quarter · 27.09 · 17:00', 'An hour along the water, then whoever is left picks a bar.',
       132, '2026-09-27T17:00:00+02:00'::timestamptz, false, '27.09 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'auckland'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'wellington-cuba-street-cellar', c.id, t.id, 'Cuba Street Cellar', 'Te Aro · 17.10 · 23:30', 'Wind outside that could take the door off, and a room that stays warm anyway.',
       133, '2026-10-17T23:30:00+02:00'::timestamptz, false, '17.10 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'wellington'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'wellington-harbour-stage', c.id, t.id, 'Harbour Stage', 'Oriental Bay · 07.11 · 18:00', 'Played into a southerly, which every band here is prepared for.',
       134, '2026-11-07T18:00:00+02:00'::timestamptz, false, '07.11 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'wellington'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'christchurch-rebuild-open-air', c.id, t.id, 'Rebuild Open Air', 'Central City · 12.09 · 15:00', 'On a site that has been three different things since 2011.',
       135, '2026-09-12T15:00:00+02:00'::timestamptz, false, '12.09 · 15:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'christchurch'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'christchurch-villa-backyard', c.id, t.id, 'Villa Backyard', 'Riccarton · 21.11 · 19:00', 'Long grass, borrowed chairs, and a fire that someone thought about in advance.',
       136, '2026-11-21T19:00:00+02:00'::timestamptz, false, '21.11 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'christchurch'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'suva-seawall-sundown', c.id, t.id, 'Seawall Sundown', 'Suva seawall · 26.09 · 17:30', 'Everyone sits facing the same way. The event is the sunset and the talking.',
       137, '2026-09-26T17:30:00+02:00'::timestamptz, false, '26.09 · 17:30'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'suva'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'suva-victoria-parade', c.id, t.id, 'Victoria Parade', 'Victoria Parade · 24.10 · 22:00', 'Rain most evenings, and the room fills faster when it comes.',
       138, '2026-10-24T22:00:00+02:00'::timestamptz, false, '24.10 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'suva'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'nadi-reef-open-air', c.id, t.id, 'Reef Open Air', 'Wailoaloa Beach · 05.09 · 16:00', 'Sand, one stage, and a tide that decides how much room there is.',
       139, '2026-09-05T16:00:00+02:00'::timestamptz, false, '05.09 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'nadi'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'nadi-backyard-lovo', c.id, t.id, 'Backyard Lovo', 'Namaka · 14.11 · 18:00', 'Food buried in the ground hours before anyone arrives. Worth the wait.',
       140, '2026-11-14T18:00:00+02:00'::timestamptz, false, '14.11 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'nadi'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'lautoka-sugar-city-hall', c.id, t.id, 'Sugar City Hall', 'Lautoka · 17.10 · 19:00', 'The mill smells of molasses for six months a year and tonight is one of them.',
       141, '2026-10-17T19:00:00+02:00'::timestamptz, false, '17.10 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'lautoka'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'lautoka-mill-yard', c.id, t.id, 'Mill Yard', 'Lautoka Mill · 28.11 · 23:00', 'Cane trains on one side, sound system on the other, both running late.',
       142, '2026-11-28T23:00:00+02:00'::timestamptz, false, '28.11 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'lautoka'
on conflict (slug) do nothing;


-- Stamp the migration log, if it is there (00_migrations.sql).
do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('11_world.sql');
  end if;
end $$;
