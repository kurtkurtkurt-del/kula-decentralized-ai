-- afterhours — a check-in that means something (88)
--
-- 23 took the door tests away so that a card is never refused; since then any tap,
-- any time, anywhere, told every friend "X is out now" - and the location the phone
-- sent was thrown away (F9, 20.10.2026). Decided: the card is still never refused,
-- but the word to friends is. A check-in is LIVE when it falls six hours before to
-- eight hours after the night starts and, when the phone gave a position and the
-- night has one, within two kilometres of it. Only a live check-in pushes friend_live
-- and shows in friends_live(); the card, the room and the collection are the same
-- either way. The position is kept on the row now (the export of 64 lists it).
-- And a check-in can be taken back within an hour: the card goes, the pushes that
-- have not left go with it.
--
--   check_in(slug, lat, lng, at)   as 37; sets lat, lng, live
--   check_out(slug)                within an hour of the check-in; "toolate" after
--   km_between(lat1, lng1, lat2, lng2)

-- the table of 19 predates 23, which meant to add the position; the columns are made sure of here
alter table public.checkins add column if not exists lat double precision;
alter table public.checkins add column if not exists lng double precision;
alter table public.checkins add column if not exists live boolean not null default true;

create or replace function public.km_between(a_lat double precision, a_lng double precision, b_lat double precision, b_lng double precision)
returns double precision
language sql
immutable
as $$
  select 2 * 6371 * asin(sqrt(
    power(sin(radians(b_lat - a_lat) / 2), 2)
    + cos(radians(a_lat)) * cos(radians(b_lat)) * power(sin(radians(b_lng - a_lng) / 2), 2)));
$$;

create or replace function public.check_in(
  p_slug text,
  p_lat  double precision default null,
  p_lng  double precision default null,
  p_at   timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e     public.events%rowtype;
  n     bigint;
  at    timestamptz := least(coalesce(p_at, now()), now());
  there double precision;
  x_lat double precision;
  x_lng double precision;
  live  boolean := true;
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  select * into e from public.events where slug = p_slug and is_published;
  if not found then raise exception 'nonight'; end if;

  -- One card per person per night: a second try returns the first card.
  select card_no into n from public.checkins where user_id = auth.uid() and event_id = e.id;
  if found then return n; end if;

  if at < now() - interval '12 hours' then at := now(); end if;

  -- the window: six hours before to eight after; a night without a time is always in it
  if e.starts_at is not null and (at < e.starts_at - interval '6 hours' or at > e.starts_at + interval '8 hours') then
    live := false;
  end if;
  -- the place: the position of the night, else of its venue; no position on either side, no test
  select coalesce(e.lat, v.lat), coalesce(e.lng, v.lng) into x_lat, x_lng
    from (select 1) one left join public.venues v on v.id = e.venue_id;
  if live and p_lat is not null and p_lng is not null and x_lat is not null and x_lng is not null then
    there := public.km_between(p_lat, p_lng, x_lat, x_lng);
    if there > 2 then live := false; end if;
  end if;

  insert into public.checkins (user_id, event_id, checked_at, lat, lng, live)
  values (auth.uid(), e.id, at, p_lat, p_lng, live) returning card_no into n;
  return n;
end;
$$;

create or replace function public.check_out(p_slug text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.checkins%rowtype;
begin
  if auth.uid() is null then raise exception 'signedout'; end if;
  select c0.* into c from public.checkins c0 join public.events e on e.id = c0.event_id
   where c0.user_id = auth.uid() and e.slug = p_slug;
  if c.id is null then return false; end if;
  if c.checked_at < now() - interval '1 hour' then raise exception 'toolate'; end if;
  delete from public.push_outbox
   where sent_at is null and (key = 'room_open:' || c.id::text or key like 'live:%:' || c.id::text);
  delete from public.checkins where id = c.id;
  return true;
end;
$$;
grant execute on function public.check_out(text) to authenticated;

create or replace function public.push_on_checkin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night  record;
  friend uuid;
begin
  select e.title, e.slug, v.name as venue
    into night
  from public.events e left join public.venues v on v.id = e.venue_id
  where e.id = new.event_id;

  perform public.push_enqueue(new.user_id, 'room_open', format('room_open:%s', new.id),
    jsonb_build_object('title', night.title, 'url', '/room/' || night.slug));

  if new.show_friends and new.live then
    for friend in select f.friend from public.push_edges f where f.who = new.user_id loop
      perform public.push_enqueue(friend, 'friend_live',
        format('live:%s:%s', friend, new.id),
        jsonb_build_object('name', public.push_name(new.user_id),
                           'title', coalesce(night.venue || ' · ', '') || night.title,
                           'url', '/night/' || night.slug));
    end loop;
  end if;
  return new;
end;
$$;

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
  where c.show_friends and c.live
    and c.checked_at > now() - interval '8 hours'
    and public.is_friend(c.user_id)
  order by c.checked_at desc;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('88_checkin_truth.sql', 'd29cb8a9f3e17270d5f4fb130240b544df21cdf44a76ee452afae94dc84f78d9');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('88_checkin_truth.sql');
  end if;
end $$;
