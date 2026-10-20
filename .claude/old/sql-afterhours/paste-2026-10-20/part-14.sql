-- paste 14/24: 82 83 84
create trigger photo_gone_groups         after delete or update of cover_path            on public.groups         for each row execute function public.photo_gone('cover_path');

create trigger folder_gone_profiles      after delete                                    on public.profiles       for each row execute function public.folder_gone();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('82_leftovers.sql', 'fd331d73d48eca15b020a2173b0828c697fd674a6e72ab30ea4759e2cc933dbf');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('82_leftovers.sql');
  end if;
end $$;

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

alter table public.reports add column if not exists snapshot jsonb;

alter table public.reports alter column reporter_id drop not null;

alter table public.reports drop constraint if exists reports_reporter_id_fkey;

alter table public.reports add constraint reports_reporter_id_fkey
  foreign key (reporter_id) references public.profiles (id) on delete set null;
