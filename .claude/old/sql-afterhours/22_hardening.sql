-- afterhours — hardening after review (19, 20, 18)
--
-- What the review found, and what closes it:
--   checkins   a person could UPDATE their own row onto another night and
--              forge the card number. Now only show_friends is writable,
--              card_no is unique, and device coordinates are not stored at
--              all (check_in only ever needed them for the 500 m test).
--   room_posts direct INSERT let anyone backdate a line onto the front of
--              every card; direct SELECT handed out poster ids. Both go
--              through the functions now; delete stops at the freeze.
--   guests     anonymous sessions could check in and post without anyone
--              to hold to it. Cards and rooms need a real account.
--   djs        the admin write policies had no grant behind them, and the
--              follower number was invented. Counts come from dj_follows.
--   check_in   no coordinates skipped the door test; a night without a
--              date had no window at all; a repeat call burned a number.
--   friends_live carried the clock time; it carries the hour now.
--   nights_near ran as definer for no reason.

-- ------------------------------------------------------------- guests

create or replace function public.is_guest()
returns boolean
language sql
stable
as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false);
$$;
grant execute on function public.is_guest() to anon, authenticated;

-- ----------------------------------------------------------- checkins

alter table public.checkins drop column if exists lat;
alter table public.checkins drop column if exists lng;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'checkins_card_no_key') then
    alter table public.checkins add constraint checkins_card_no_key unique (card_no);
  end if;
end $$;

revoke select, update on public.checkins from authenticated;
grant select (id, user_id, event_id, card_no, show_friends) on public.checkins to authenticated;
grant update (show_friends) on public.checkins to authenticated;

revoke select, insert, delete on public.room_posts from authenticated;
grant delete on public.room_posts to authenticated;

drop policy if exists room_posts_delete on public.room_posts;
create policy room_posts_delete on public.room_posts for delete
  using (user_id = auth.uid() and now() < public.room_freeze_at(event_id));

-- the door test needs a point on both sides; a night without a date has
-- no window and takes no check-in; a repeat call returns the same card.
create or replace function public.check_in(
  p_slug text,
  p_lat  double precision default null,
  p_lng  double precision default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e   public.events%rowtype;
  n   bigint;
  km  double precision;
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  select * into e from public.events where slug = p_slug and is_published;
  if not found then raise exception 'nonight'; end if;
  if e.starts_at is null then raise exception 'notnow'; end if;
  if now() < e.starts_at - interval '6 hours' or now() > e.starts_at + interval '12 hours' then
    raise exception 'notnow';
  end if;

  if e.lat is not null and e.lng is not null then
    if p_lat is null or p_lng is null then raise exception 'far'; end if;
    km := 2 * 6371.0 * asin(sqrt(
            power(sin(radians(e.lat - p_lat) / 2), 2)
            + cos(radians(p_lat)) * cos(radians(e.lat))
            * power(sin(radians(e.lng - p_lng) / 2), 2)));
    if km > 0.5 then raise exception 'far'; end if;
  end if;

  select card_no into n from public.checkins where user_id = auth.uid() and event_id = e.id;
  if found then return n; end if;

  insert into public.checkins (user_id, event_id) values (auth.uid(), e.id) returning card_no into n;
  return n;
end;
$$;

create or replace function public.room_post(p_slug text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  ev uuid;
  n  uuid;
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  select id into ev from public.events where slug = p_slug;
  if ev is null then raise exception 'nonight'; end if;
  if not public.checked_in(ev) then raise exception 'notthere'; end if;
  if now() >= public.room_freeze_at(ev) then raise exception 'frozen'; end if;
  insert into public.room_posts (event_id, user_id, body) values (ev, auth.uid(), btrim(p_body)) returning id into n;
  return n;
end;
$$;

-- where friends are: the hour, not the minute
drop function if exists public.friends_live();
create or replace function public.friends_live()
returns table (
  friend_id     uuid,
  handle        text,
  display_name  text,
  slug          text,
  title         text,
  venue_name    text,
  checked_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.user_id, p.handle, p.display_name, e.slug, e.title, v.name, date_trunc('hour', c.checked_at)
  from public.checkins c
  join public.profiles p on p.id = c.user_id
  join public.events e on e.id = c.event_id
  left join public.venues v on v.id = e.venue_id
  where c.show_friends
    and c.checked_at > now() - interval '8 hours'
    and public.is_friend(c.user_id)
  order by c.checked_at desc;
$$;
grant execute on function public.friends_live() to authenticated;

-- ---------------------------------------------------------------- djs

grant insert, update, delete on public.djs, public.dj_sets to authenticated;

alter table public.djs drop column if exists followers;

create or replace function public.dj_follow_counts()
returns table (dj_id uuid, n bigint)
language sql
stable
security definer
set search_path = public
as $$
  select dj_id, count(*) from public.dj_follows group by dj_id;
$$;
grant execute on function public.dj_follow_counts() to anon, authenticated;

drop policy if exists dj_follows_own on public.dj_follows;
create policy dj_follows_own on public.dj_follows for all
  using (user_id = auth.uid()) with check (user_id = auth.uid() and not public.is_guest());

-- one seed set per dj and venue, whatever day the file runs
delete from public.dj_sets s
using public.djs d
where s.dj_id = d.id and d.source = 'seed'
  and s.id not in (
    select distinct on (dj_id, venue) id from public.dj_sets order by dj_id, venue, starts_at
  );

-- -------------------------------------------------------- nights_near

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

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('22_hardening.sql', '5eaab7682fd89f3291aef571b15fda540f691f9c6631d7fcc7f41011dfd51015');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('22_hardening.sql');
  end if;
end $$;
