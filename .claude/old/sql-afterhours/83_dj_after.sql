-- afterhours — a DJ page after the DJ (83)
--
-- When a DJ deleted their account the page stayed up: owner_id fell to null and
-- verified stayed true, so a page nobody could edit or answer for kept its place;
-- and push_hourly told followers about sets of pages the staff had taken down
-- (F25, 20.10.2026). Now: a page loses its check the moment its owner goes
-- (before the profile row leaves, while owner_id still points at it) - a page the
-- staff made themselves, with no owner, is not touched; and the dj_live push goes
-- only for a checked page. push_hourly is that of 26 with the one condition. The bio
-- the DJ writes is shown on the page from this day (app/src/app/dj/[id].tsx).

create or replace function public.dj_owner_gone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.djs set verified = false, verified_at = null where owner_id = old.id and verified;
  return old;
end;
$$;
drop trigger if exists dj_owner_gone on public.profiles;
create trigger dj_owner_gone before delete on public.profiles
  for each row execute function public.dj_owner_gone();

create or replace function public.push_hourly(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n    integer := 0;
  them record;
begin
  -- a kept night starts in two to three hours
  for them in
    select w.user_id, e.id, e.title, e.slug, e.starts_at
    from public.swipes w join public.events e on e.id = w.event_id
    where w.direction = 'right' and e.is_published and not e.starts_at_estimated
      and e.starts_at > p_now + interval '2 hours' and e.starts_at <= p_now + interval '3 hours'
  loop
    perform public.push_enqueue(them.user_id, 'night_soon', format('soon:%s:%s', them.user_id, them.id),
      jsonb_build_object('title', them.title, 'time', public.push_clock(them.user_id, them.starts_at),
                         'url', '/night/' || them.slug));
    n := n + 1;
  end loop;

  -- a room freezes within two hours
  if to_regclass('public.checkins') is not null then
    for them in execute $q$
      select c.id, c.user_id, e.title, e.slug
      from public.checkins c join public.events e on e.id = c.event_id
      where public.room_freeze_at(c.event_id) > $1 + interval '1 hour'
        and public.room_freeze_at(c.event_id) <= $1 + interval '2 hours'
    $q$ using p_now
    loop
      perform public.push_enqueue(them.user_id, 'room_closing', format('closing:%s', them.id),
        jsonb_build_object('title', them.title, 'url', '/room/' || them.slug));
      n := n + 1;
    end loop;
  end if;

  -- a followed DJ plays within the hour
  if to_regclass('public.dj_sets') is not null then
    for them in execute $q$
      select f.user_id, s.id, s.venue, s.starts_at, d.name, d.slug
      from public.dj_follows f
      join public.dj_sets s on s.dj_id = f.dj_id
      join public.djs d on d.id = f.dj_id
      where s.starts_at > $1 and s.starts_at <= $1 + interval '1 hour'
        and d.verified
    $q$ using p_now
    loop
      perform public.push_enqueue(them.user_id, 'dj_live', format('dj:%s:%s', them.user_id, them.id),
        jsonb_build_object('name', them.name, 'where', them.venue,
                           'time', public.push_clock(them.user_id, them.starts_at), 'url', '/dj/' || them.slug));
      n := n + 1;
    end loop;
  end if;

  -- thursday 18:00 on the phone: the weekend in your city (friday 18:00 to monday 06:00)
  for them in
    with here as (
      select distinct on (k.user_id) k.user_id, k.tz from public.push_tokens k order by k.user_id, k.updated_at desc
    ),
    due as (
      select h.user_id, p.city_id, c.name as city,
             ((p_now at time zone h.tz)::date + 1 + time '18:00') at time zone h.tz as from_at,
             ((p_now at time zone h.tz)::date + 4 + time '06:00') at time zone h.tz as to_at
      from here h
      join public.profiles p on p.id = h.user_id
      join public.cities c on c.id = p.city_id
      where extract(isodow from p_now at time zone h.tz) = 4
        and extract(hour from p_now at time zone h.tz) = 18
    )
    select d.user_id, d.city,
           (select count(*)::int from public.events e
             where e.city_id = d.city_id and e.is_published and e.starts_at >= d.from_at and e.starts_at < d.to_at) as nights,
           (select count(distinct w.event_id)::int from public.swipes w
              join public.events e on e.id = w.event_id
              join public.push_edges f on f.who = d.user_id and f.friend = w.user_id
             where w.direction = 'right' and public.kept_visible(w.user_id)
               and e.city_id = d.city_id and e.starts_at >= d.from_at and e.starts_at < d.to_at) as kept
    from due d
  loop
    if them.nights > 0 then
      perform public.push_enqueue(them.user_id, 'digest', format('digest:%s:%s', them.user_id, to_char(p_now, 'IYYY-IW')),
        jsonb_build_object('city', them.city, 'n', them.nights, 'friends', them.kept, 'url', '/flow'));
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('83_dj_after.sql', '18c17fad8d80b42de42afe6e275348f34a0ea1edf993e45dc07eff43b571b861');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('83_dj_after.sql');
  end if;
end $$;
