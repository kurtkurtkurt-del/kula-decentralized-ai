-- afterhours — travel groups (61)
--
-- A group is for friends (as before) or for a trip. A travel group carries a route:
-- legs, one per city, each with the days there (berlin 03.11 to 05.11, wien 05.11 to
-- 07.11 ...). Its deck is the nights of those cities on those days, so the matches,
-- the plan and the live session work as in any group. The page in the app is a
-- passport: one page per leg with that leg of the route, the nights the group kept
-- there and the photos from there.
--
--   group_legs        the route: leg_no, city, first and last day
--   group_legs_set    any member writes the whole route at once (1 to 12 legs, in order)
--   group_legs        the route with counts: nights kept there, photos from there
--   group_leg_nights  the nights at least one member kept, on that leg, past ones too
--   group_leg_photos  the photos of the group from that leg
--   group_window      the deck of a travel group is the union of its legs
--
-- Chosen on 12.10.2026 (design A, prototypes/travel.html). Groups made before keep
-- their kind; the app offers friends or travel when a group is made.

-- the kind: friends (lasting), once (no longer offered) or travel
alter table public.groups drop constraint if exists groups_kind_check;
alter table public.groups add constraint groups_kind_check check (kind in ('lasting', 'once', 'travel'));
alter table public.groups drop constraint if exists groups_once_dated;
alter table public.groups add constraint groups_once_dated check (kind <> 'once' or date_to is not null);

create table if not exists public.group_legs (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups on delete cascade,
  leg_no    int  not null check (leg_no between 1 and 12),
  city_slug   text not null references public.cities (slug),
  date_from   date not null,
  date_to     date not null,
  constraint group_legs_window check (date_to >= date_from),
  unique (group_id, leg_no)
);
alter table public.group_legs enable row level security;
revoke all on public.group_legs from public, anon, authenticated;

-- The checks of a group, now with travel as a kind.
create or replace function public.group_check(p_name text, p_emoji text, p_color text, p_kind text,
                                              p_city text, p_from date, p_to date)
returns void
language plpgsql
stable
set search_path = public
as $$
begin
  if length(btrim(coalesce(p_name, ''))) not between 1 and 40 then raise exception 'name: 1 to 40 characters'; end if;
  if length(coalesce(p_emoji, '')) not between 1 and 8 then raise exception 'one emoji'; end if;
  if coalesce(p_color, 'red') not in ('red', 'gold', 'blue', 'green', 'violet', 'paper') then raise exception 'unknown colour'; end if;
  if coalesce(p_kind, 'lasting') not in ('lasting', 'once', 'travel') then raise exception 'friends, once or travel'; end if;
  if p_kind = 'once' and p_to is null then raise exception 'a group for once needs its last day'; end if;
  if p_from is not null and p_to is not null and p_to < p_from then raise exception 'the last day comes after the first'; end if;
  if p_kind <> 'travel' and p_to is not null and p_to < current_date then raise exception 'those days are over'; end if;
  if p_city is not null and not exists (select 1 from public.cities where slug = p_city) then raise exception 'unknown city'; end if;
end;
$$;

-- The route, written whole: [{"city": "berlin", "from": "2026-11-03", "to": "2026-11-05"}, ...].
-- In order of travel: a leg starts no earlier than the one before it. The window of the
-- group (date_from, date_to) follows the route, so the groups shelf can say when.
create or replace function public.group_legs_set(p_id uuid, p_legs jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  leg jsonb;
  i int := 0;
  prev date;
  d_from date;
  d_to date;
  city text;
begin
  perform public.need_member(p_id);
  if (select kind from public.groups where id = p_id) <> 'travel' then raise exception 'not a travel group'; end if;
  if p_legs is null or jsonb_typeof(p_legs) <> 'array' then raise exception 'a list of legs'; end if;
  if jsonb_array_length(p_legs) not between 1 and 12 then raise exception '1 to 12 cities'; end if;
  delete from public.group_legs where group_id = p_id;
  for leg in select * from jsonb_array_elements(p_legs) loop
    i := i + 1;
    city := leg ->> 'city';
    if city is null or not exists (select 1 from public.cities where slug = city) then raise exception 'unknown city'; end if;
    begin
      d_from := (leg ->> 'from')::date;
      d_to := (leg ->> 'to')::date;
    exception when others then
      raise exception 'days as yyyy-mm-dd';
    end;
    if d_from is null or d_to is null then raise exception 'each city needs its first and last day'; end if;
    if d_to < d_from then raise exception 'the last day comes after the first'; end if;
    if prev is not null and d_from < prev then raise exception 'the cities in the order of travel'; end if;
    insert into public.group_legs (group_id, leg_no, city_slug, date_from, date_to) values (p_id, i, city, d_from, d_to);
    prev := d_from;
  end loop;
  update public.groups g set city_slug = null,
         date_from = (select min(l.date_from) from public.group_legs l where l.group_id = p_id),
         date_to = (select max(l.date_to) from public.group_legs l where l.group_id = p_id)
   where g.id = p_id;
  return i;
end;
$$;

-- The nights at least one member kept, on one leg: the city and the days of the leg.
-- Past nights stay (a trip is also a memory), so this is not group_matches.
create or replace function public.group_leg_nights(p_id uuid, p_leg uuid)
returns table (id uuid, slug text, title text, starts_at timestamptz, venue_name text, image_url text,
               yes int, members int, status text, yes_ids uuid[])
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n int;
  l public.group_legs;
begin
  perform public.need_member(p_id);
  select * into l from public.group_legs where group_legs.id = p_leg and group_id = p_id;
  if l.id is null then raise exception 'no such leg'; end if;
  select count(*) into n from public.group_members where group_id = p_id;
  return query
    with votes as (
      select s.event_id,
             count(*) filter (where s.direction = 'right')::int as y,
             array_agg(s.user_id) filter (where s.direction = 'right') as ids
      from public.group_swipes s
      join public.group_members m on m.group_id = s.group_id and m.user_id = s.user_id
      where s.group_id = p_id
      group by s.event_id)
    select e.id, e.slug, e.title, e.starts_at, v.name, e.image_url, vo.y, n,
           case when vo.y = n then 'match' when vo.y * 2 > n then 'most' else 'some' end, vo.ids
    from votes vo
    join public.events e on e.id = vo.event_id and e.is_published
    join public.cities c on c.id = e.city_id and c.slug = l.city_slug
    left join public.venues v on v.id = e.venue_id
    where vo.y > 0 and e.starts_at::date between l.date_from and l.date_to
    order by e.starts_at, e.id;
end;
$$;

-- The photos of the group from one leg: those of nights on that leg.
create or replace function public.group_leg_photos(p_id uuid, p_leg uuid)
returns table (id uuid, path text, event_id uuid, event_title text, starts_at timestamptz, name text, mine boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  l public.group_legs;
begin
  perform public.need_member(p_id);
  select * into l from public.group_legs where group_legs.id = p_leg and group_id = p_id;
  if l.id is null then raise exception 'no such leg'; end if;
  return query
    select ph.id, ph.path, e.id, e.title, e.starts_at, coalesce(p.display_name, p.handle), ph.user_id = auth.uid(), ph.created_at
    from public.group_photos ph
    join public.events e on e.id = ph.event_id
    join public.cities c on c.id = e.city_id and c.slug = l.city_slug
    left join public.profiles p on p.id = ph.user_id
    where ph.group_id = p_id and e.starts_at::date between l.date_from and l.date_to
    order by e.starts_at, ph.created_at
    limit 300;
end;
$$;

-- The route with its counts, in order of travel.
create or replace function public.group_legs(p_id uuid)
returns table (id uuid, leg_no int, city_slug text, city_name text, country_slug text,
               date_from date, date_to date, kept int, photos int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  return query
    select l.id, l.leg_no, l.city_slug, c.name, c.country_slug, l.date_from, l.date_to,
           (select count(*)::int from public.group_leg_nights(p_id, l.id)),
           (select count(*)::int from public.group_leg_photos(p_id, l.id))
    from public.group_legs l
    join public.cities c on c.slug = l.city_slug
    where l.group_id = p_id
    order by l.leg_no;
end;
$$;

-- The deck of a group: as before for friends; for a trip, the nights of each leg on
-- its days, all legs together.
create or replace function public.group_window(p_id uuid)
returns setof public.events_public
language sql
stable
security definer
set search_path = public
as $$
  with g as (select * from public.groups where id = p_id),
       members as (select user_id from public.group_members where group_id = p_id),
       liked_types as (
         select e.type_id, count(*) as n
         from public.swipes s join public.events e on e.id = s.event_id
         where s.direction = 'right' and s.user_id in (select user_id from members)
         group by e.type_id)
  select e.* from public.events_public e, g
  where e.is_published
    and (
      (g.kind <> 'travel'
        and (g.city_slug is null or e.city_slug = g.city_slug)
        and (e.starts_at is null or e.starts_at::date >= greatest(coalesce(g.date_from, current_date), current_date))
        and (g.date_to is null or e.starts_at::date <= g.date_to))
      or
      (g.kind = 'travel'
        and e.starts_at::date >= current_date
        and exists (select 1 from public.group_legs l
                    where l.group_id = p_id and l.city_slug = e.city_slug
                      and e.starts_at::date between l.date_from and l.date_to))
    )
  order by
    3 * (select count(*) from public.swipes s where s.event_id = e.id and s.direction = 'right' and s.user_id in (select user_id from members))
    + coalesce((select least(n, 20) from liked_types lt join public.events x on x.type_id = lt.type_id where x.id = e.id), 0) / 5.0 desc,
    e.starts_at nulls last, e.id
  limit 400;
$$;
revoke all on function public.group_window(uuid) from public, anon, authenticated;

-- group_get carries the route.
create or replace function public.group_get(p_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  return (
    select json_build_object(
      'id', g.id, 'name', g.name, 'emoji', g.emoji, 'color', g.color, 'cover_path', g.cover_path,
      'kind', g.kind, 'city_slug', g.city_slug, 'date_from', g.date_from, 'date_to', g.date_to,
      'archived', g.kind = 'once' and g.date_to < current_date, 'visible', g.visible,
      'me', auth.uid(),
      'members', (select json_agg(json_build_object('id', p.id, 'handle', p.handle, 'name', p.display_name, 'role', m.role) order by m.joined_at)
                  from public.group_members m join public.profiles p on p.id = m.user_id where m.group_id = g.id),
      'legs', coalesce((select json_agg(json_build_object('id', l.id, 'leg_no', l.leg_no, 'city', l.city_slug, 'from', l.date_from, 'to', l.date_to) order by l.leg_no)
                        from public.group_legs l where l.group_id = g.id), '[]'::json))
    from public.groups g where g.id = p_id);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'group_legs_set(uuid, jsonb)', 'group_legs(uuid)', 'group_leg_nights(uuid, uuid)', 'group_leg_photos(uuid, uuid)', 'group_get(uuid)'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('61_travel.sql', '6d88a4f65688cc0895eac7faf24d741dbb2c4758297bc4889d2ba2b5574ba4fd');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('61_travel.sql');
  end if;
end $$;
