-- afterhours — drop the invented nights
--
-- A one-shot for the LIVE project, run once after setup-1-structure.sql
-- (which brings 15_ticketmaster.sql and its source column). It is not
-- part of the numbered chain on purpose: the tests and the local mock
-- still want the seed nights to exercise the machinery.
--
-- What it does: every event whose source is "seed" — the 142 invented
-- nights — goes. Swipes and comments on those nights go with them
-- (on delete cascade); that is the point, they were opinions about
-- fiction. Real events written by the Ticketmaster sync or by an admin
-- carry a different source and are not touched.
--
-- In the Supabase panel: SQL Editor → New query → paste → Run.
-- The role/RLS toggle next to Run must be OFF.

delete from public.events where source = 'seed';

-- With the invented nights gone, the showcase cities outside the real
-- coverage (Europe, key Asia, North America — 16_coverage.sql) hold
-- nothing and leave the filter. A city that somehow gained a real event
-- keeps its place.
delete from public.cities c
where c.continent_slug not in ('eu', 'as', 'na')
  and not exists (select 1 from public.events e where e.city_id = c.id);

-- The Asian showcase cities the coverage does not name (kyoto, daegu,
-- jakarta, bandung, yogyakarta) go the same way once they are empty:
-- the sync has no map entry for them, so they would only sit faded.
delete from public.cities c
where c.slug in ('kyoto', 'daegu', 'jakarta', 'bandung', 'yogyakarta')
  and not exists (select 1 from public.events e where e.city_id = c.id);

-- The sample comments sat on seed events, so the cascade has already
-- taken them; this reports what is left, as a sanity check.
select
  (select count(*) from public.events)   as events_left,
  (select count(*) from public.cities)   as cities_left,
  (select count(*) from public.comments) as comments_left,
  (select count(*) from public.swipes)   as swipes_left;
