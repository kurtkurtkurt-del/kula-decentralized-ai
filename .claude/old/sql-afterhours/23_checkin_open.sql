-- afterhours — check-in opens up (23)
--
-- The door test and the time window are gone: check in to any published
-- night, whenever, from wherever. What stays: a real account (no guest),
-- a night that exists, one card per person per night, and the room rules
-- (only the people with a card write, and only until it freezes).
-- The coordinates are still accepted so the app does not have to change
-- its call; they are simply not looked at.

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
  e public.events%rowtype;
  n bigint;
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  select * into e from public.events where slug = p_slug and is_published;
  if not found then raise exception 'nonight'; end if;

  select card_no into n from public.checkins where user_id = auth.uid() and event_id = e.id;
  if found then return n; end if;

  insert into public.checkins (user_id, event_id) values (auth.uid(), e.id) returning card_no into n;
  return n;
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('23_checkin_open.sql', 'd14b387bd619ea2e5ea761c4c191d6392275e8c1e16c2c130b10ad89cb765a59');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('23_checkin_open.sql');
  end if;
end $$;
