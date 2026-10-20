-- GENERATED FILE - source: events-data.js (36 records)
-- The meta field is the very line shown on screen; it must not be changed.

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'asap-rocky', c.id, t.id, v.id,
       'A$AP Rocky', 'Olympiahalle · 11.09.26 · 18:30', 'An arena show built around one voice. Doors early, everyone seated until they aren''t.', 1,
       '2026-09-11T18:30:00+02:00'::timestamptz, false, '11.09.26 · 18:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
join public.venues v on v.city_id = c.id and v.slug = 'olympiahalle'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'nick-cave', c.id, t.id, v.id,
       'Nick Cave', 'Olympiapark · 23.08 · open air', 'The Bad Seeds outdoors, at dusk. Quiet enough that you hear the crowd breathing between songs.', 2,
       '2026-08-23T18:00:00.000Z'::timestamptz, true, '23.08 · open air'
from public.cities c
join public.event_types t on t.slug = 'konzert'
join public.venues v on v.city_id = c.id and v.slug = 'olympiapark'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'bonez-mc-raf-camora', c.id, t.id, v.id,
       'Bonez MC & RAF Camora', 'Olympiahalle · 21.12.26 · 20:00', 'Palmen aus Plastik, ten years on. A December hall show that behaves like a summer one.', 3,
       '2026-12-21T20:00:00+02:00'::timestamptz, false, '21.12.26 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
join public.venues v on v.city_id = c.id and v.slug = 'olympiahalle'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'thirty-seconds-to-mars', c.id, t.id, v.id,
       'Thirty Seconds to Mars', 'Olympiahalle · 12.04.27', 'Stadium rock at hall scale. Bring a voice you don''t mind losing.', 4,
       '2027-04-12T20:00:00+02:00'::timestamptz, false, '12.04.27'
from public.cities c
join public.event_types t on t.slug = 'konzert'
join public.venues v on v.city_id = c.id and v.slug = 'olympiahalle'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'annenmaykantereit', c.id, t.id, v.id,
       'AnnenMayKantereit', 'Olympiapark · 15—16.09', 'Two nights in a row, same park, different setlist. Sung back word for word either way.', 5,
       '2026-09-15T18:00:00.000Z'::timestamptz, true, '15—16.09'
from public.cities c
join public.event_types t on t.slug = 'konzert'
join public.venues v on v.city_id = c.id and v.slug = 'olympiapark'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'elysium', c.id, t.id, v.id,
       'Elysium', 'Maxvorstadt · 12.09.26', 'Three stages, one night, no camping. A festival that fits inside a single walk home.', 6,
       '2026-09-12T20:00:00+02:00'::timestamptz, false, '12.09.26'
from public.cities c
join public.event_types t on t.slug = 'festival'
join public.venues v on v.city_id = c.id and v.slug = 'maxvorstadt'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'tollwood', c.id, t.id, v.id,
       'Tollwood', 'Olympiapark · Sommer 2027', 'Three weeks of stages, kitchens and market stalls. Come for one act, stay for the field.', 7,
       null, false, 'Sommer 2027'
from public.cities c
join public.event_types t on t.slug = 'festival'
join public.venues v on v.city_id = c.id and v.slug = 'olympiapark'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'mondscheinexpress', c.id, t.id, v.id,
       'Mondscheinexpress', 'Bahnwärter Thiel · 19.11 — 23.12', 'The winter counterpart: a month of short, cold, close-up nights between the containers.', 8,
       '2026-12-11T18:00:00.000Z'::timestamptz, true, '19.11 — 23.12'
from public.cities c
join public.event_types t on t.slug = 'festival'
join public.venues v on v.city_id = c.id and v.slug = 'bahnwarter-thiel'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'isle-of-summer', c.id, t.id, v.id,
       'Isle of Summer', 'Galopprennbahn Riem · 2027 TBA', 'Open air on the old racecourse. Line-up lands in spring, tickets go before it does.', 9,
       null, false, '2027 TBA'
from public.cities c
join public.event_types t on t.slug = 'festival'
join public.venues v on v.city_id = c.id and v.slug = 'riem'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'zamanand', c.id, t.id, null,
       'Zamanand', 'München · 12.09 · 16:00', 'Starts in daylight and never quite admits it''s a festival. Local bills, no headliner hierarchy.', 10,
       '2026-09-12T14:00:00.000Z'::timestamptz, true, '12.09 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'blitz', c.id, t.id, v.id,
       'Blitz', 'Museumsinsel 1 · 23:59', 'CJ Bolland b2b The Advent, Polygonia after. Phones stay in pockets — the no-photo rule is the point.', 11,
       null, false, '23:59'
from public.cities c
join public.event_types t on t.slug = 'rave'
join public.venues v on v.city_id = c.id and v.slug = 'museumsinsel-1'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'rote-sonne-bahnwarter', c.id, t.id, null,
       'Rote Sonne × Bahnwärter', '29.08.26 · 12:00 — 06:00', 'Eighteen hours that start in the sun and end in a basement. One ticket, two places.', 12,
       '2026-08-29T12:00:00+02:00'::timestamptz, false, '12:00 — 06:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'silo-west', c.id, t.id, null,
       'Silo West', 'München · 05.09 · 14:00', 'Narciss, Bambounou, B4ME. A day rave that sends you home before the last train, in theory.', 13,
       '2026-09-05T12:00:00.000Z'::timestamptz, true, '05.09 · 14:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'cfu-open-air', c.id, t.id, v.id,
       'CFU Open Air', 'Bahnwärter Thiel · 18.07 · 14:00', 'Outside while it''s warm, inside when it isn''t. The same crowd moves between both all afternoon.', 14,
       '2027-07-18T12:00:00.000Z'::timestamptz, true, '18.07 · 14:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
join public.venues v on v.city_id = c.id and v.slug = 'bahnwarter-thiel'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'daytime-rave', c.id, t.id, null,
       'Daytime Rave', 'München · 24.10 · 17:00', 'Anna Reusch and Thomas Schumacher, finished by midnight. Built for people who like sleeping.', 15,
       '2026-10-24T15:00:00.000Z'::timestamptz, true, '24.10 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'echonomist', c.id, t.id, v.id,
       'Echonomist', 'Pimpernel · 25.09 · 22:00', 'Staged inside a former cinema — the screen stays up, the seats don''t. Sound follows the room.', 16,
       '2026-09-25T20:00:00.000Z'::timestamptz, true, '25.09 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
join public.venues v on v.city_id = c.id and v.slug = 'pimpernel'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select '10-years-blurred-vision', c.id, t.id, null,
       '10 Years Blurred Vision', 'München · 30.10 · 22:00', 'A decade of one collective, condensed into one night. Residents only, no guest slot.', 17,
       '2026-10-30T20:00:00.000Z'::timestamptz, true, '30.10 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'legal-blitz', c.id, t.id, null,
       'Legal × Blitz', '29.08 · Muallem', 'Two bookers sharing one floor. House early, techno late, the handover is the whole show.', 18,
       '2026-08-29T18:00:00.000Z'::timestamptz, true, 'Muallem'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'bahnwarter-techno-nacht', c.id, t.id, v.id,
       'Bahnwärter Techno-Nacht', 'Bahnwärter Thiel · 22:00', 'Moritz Minoa, Palastica, Sayuara. Stacked containers, low ceilings, nothing polished.', 19,
       null, false, '22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
join public.venues v on v.city_id = c.id and v.slug = 'bahnwarter-thiel'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'unterwelt', c.id, t.id, v.id,
       'Unterwelt', 'Sunny Red · 02.10.26 · 22:00', 'Down one staircase at a time until the room stops getting bigger. Ends when it ends.', 20,
       '2026-10-02T22:00:00+02:00'::timestamptz, false, '02.10.26 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
join public.venues v on v.city_id = c.id and v.slug = 'sunny-red'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'kuchentisch', c.id, t.id, v.id,
       'Küchentisch', 'Schwabing · 14.11 · 21:00', 'Four rooms, one kitchen, and everyone ends up in the kitchen anyway. Bring something to share.', 21,
       '2026-11-14T19:00:00.000Z'::timestamptz, true, '14.11 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
join public.venues v on v.city_id = c.id and v.slug = 'schwabing'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select '3-stock-links', c.id, t.id, v.id,
       '3. Stock Links', 'Haidhausen · 05.07 · 20:00', 'Balcony party with string lights and a borrowed speaker. Quiet by two, that''s the deal with the neighbours.', 22,
       '2027-07-05T18:00:00.000Z'::timestamptz, true, '05.07 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
join public.venues v on v.city_id = c.id and v.slug = 'haidhausen'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'boxenturm', c.id, t.id, null,
       'Boxenturm', 'Sendling · 19.09 · 22:00', 'Someone stacked four cabinets in a backyard. The stack is the whole concept.', 23,
       '2026-09-19T20:00:00.000Z'::timestamptz, true, '19.09 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'klingel-14', c.id, t.id, v.id,
       'Klingel 14', 'Maxvorstadt · 28.11 · 22:00', 'No address posted — you get the doorbell number and a name. Ring the right one.', 24,
       '2026-11-28T20:00:00.000Z'::timestamptz, true, '28.11 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
join public.venues v on v.city_id = c.id and v.slug = 'maxvorstadt'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'plattenabend', c.id, t.id, v.id,
       'Plattenabend', 'Giesing · 07.12', 'Vinyl only, everyone brings one record, nobody gets to hear their own twice.', 25,
       '2026-12-07T18:00:00.000Z'::timestamptz, true, '07.12'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
join public.venues v on v.city_id = c.id and v.slug = 'giesing'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'vierter-stock', c.id, t.id, v.id,
       'Vierter Stock', 'Neuhausen · 21.02', 'Fourth floor, no lift, and the stairwell becomes the smoking area by midnight.', 26,
       '2027-02-21T18:00:00.000Z'::timestamptz, true, '21.02'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
join public.venues v on v.city_id = c.id and v.slug = 'neuhausen'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'zine-klub', c.id, t.id, v.id,
       'Zine Klub', 'Glockenbach · 03.09 · 19:00', 'Bring a page, leave with a stapled issue. First Tuesday of every month, no experience needed.', 27,
       '2026-09-03T17:00:00.000Z'::timestamptz, true, '03.09 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
join public.venues v on v.city_id = c.id and v.slug = 'glockenbach'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'kaffee-karten', c.id, t.id, v.id,
       'Kaffee & Karten', 'Westend · Sonntags · 15:00', 'Card games and too much coffee. Daylight only — it''s over before anything else starts.', 28,
       null, false, 'Sonntags · 15:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
join public.venues v on v.city_id = c.id and v.slug = 'westend'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'nachtlinie', c.id, t.id, null,
       'Nachtlinie', 'ab Isartor · 18.10 · 18:00', 'A guided night walk along the river and back through the old town. Ends at a bar, obviously.', 29,
       '2026-10-18T16:00:00.000Z'::timestamptz, true, '18.10 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'sprechstunde', c.id, t.id, v.id,
       'Sprechstunde', 'Untergiesing · Mittwochs · 19:30', 'An open round table — you talk about what you''re making, someone tells you what''s wrong with it.', 30,
       null, false, 'Mittwochs · 19:30'
from public.cities c
join public.event_types t on t.slug = 'meetup'
join public.venues v on v.city_id = c.id and v.slug = 'giesing'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'riso-abend', c.id, t.id, v.id,
       'Riso Abend', 'Schlachthofviertel · 09.10 · 18:00', 'Two-colour risograph workshop. You leave with ink on your hands and forty prints.', 31,
       '2026-10-09T16:00:00.000Z'::timestamptz, true, '09.10 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
join public.venues v on v.city_id = c.id and v.slug = 'schlachthof'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'lange-tafel', c.id, t.id, v.id,
       'Lange Tafel', 'Alte Utting · 26.09 · 18:30', 'One long table on a beached ship, strangers seated next to each other on purpose.', 32,
       '2026-09-26T16:30:00.000Z'::timestamptz, true, '26.09 · 18:30'
from public.cities c
join public.event_types t on t.slug = 'meetup'
join public.venues v on v.city_id = c.id and v.slug = 'alte-utting'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'strobo', c.id, t.id, v.id,
       'Strobo', 'Zenith Halle · 14.11 · 01:00', 'Hector Oaks and Sara Landry. Fast, loud, and unapologetically bright — sit this one out if lights are a problem.', 33,
       '2026-11-13T23:00:00.000Z'::timestamptz, true, '14.11 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
join public.venues v on v.city_id = c.id and v.slug = 'zenith'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'tunnelblick', c.id, t.id, v.id,
       'Tunnelblick', 'Tonhalle · 31.10', 'Twenty-four hours with no announced ending. People arrive in shifts.', 34,
       '2026-10-31T18:00:00.000Z'::timestamptz, true, '31.10'
from public.cities c
join public.event_types t on t.slug = 'rave'
join public.venues v on v.city_id = c.id and v.slug = 'tonhalle'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'spiegelsaal', c.id, t.id, v.id,
       'Spiegelsaal', 'P1 · 06.12 · 23:00', 'Italo and disco under an actual mirror ball. The most fun you''ll have taking nothing seriously.', 35,
       '2026-12-06T21:00:00.000Z'::timestamptz, true, '06.12 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
join public.venues v on v.city_id = c.id and v.slug = 'p1'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'pegel', c.id, t.id, v.id,
       'Pegel', 'Milla Club · 11.10 · 22:00', 'Live hardware sets, no laptops on stage. You watch the sound get built in front of you.', 36,
       '2026-10-11T20:00:00.000Z'::timestamptz, true, '11.10 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
join public.venues v on v.city_id = c.id and v.slug = 'milla'
where c.slug = 'munchen'
on conflict (slug) do nothing;


-- Stamp the migration log, if it is there (00_migrations.sql).
do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('04_seed_events.sql');
  end if;
end $$;
