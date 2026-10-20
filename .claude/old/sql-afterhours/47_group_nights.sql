-- afterhours — the night and after, for a group (47, after 44 and 46)
--
--   group nights   a night at least two members checked in to (19_checkins.sql).
--                  Nothing to press: checking in as usual is enough. It is the
--                  card of the group: who was there, their card numbers, and "all of
--                  us" when everyone was.
--   the shelf      those nights, newest first: the collection of the group.
--   the album      photos members add to one of those nights (or to the plan),
--                  each into their own folder of the photos bucket. Members see
--                  them; the one who added it, or the owner, takes it out.
--   numbers        nights this year, the room you go to most, who comes most,
--                  matches and votes; and the vibe: the kinds you say yes to most,
--                  the hour your nights start, your room.
--   also there     a group may let itself be seen (visible, off by default).
--                  When such a group has the same plan as yours and one of your
--                  friends is in it, your plan says so: name, emoji, which friends.

alter table public.groups add column if not exists visible boolean not null default false;

create table if not exists public.group_photos (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups on delete cascade,
  event_id    uuid not null references public.events on delete cascade,
  user_id     uuid references public.profiles on delete set null,
  path        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists group_photos_idx on public.group_photos (group_id, event_id, created_at);
alter table public.group_photos enable row level security;
revoke all on public.group_photos from public, anon, authenticated;

-- ---------------------------------------------------------- group nights

-- No membership check here: callers check.
create or replace function public.group_night_rows(p_group uuid)
returns table (event_id uuid, people uuid[], cards bigint[], first_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.event_id, array_agg(c.user_id order by c.checked_at), array_agg(c.card_no order by c.checked_at), min(c.checked_at)
  from public.checkins c
  join public.group_members m on m.group_id = p_group and m.user_id = c.user_id
  group by c.event_id
  having count(*) >= 2;
$$;
revoke all on function public.group_night_rows(uuid) from public, anon, authenticated;

create or replace function public.group_nights(p_group uuid)
returns table (id uuid, slug text, title text, starts_at timestamptz, venue_name text, city_name text, image_url text,
               people json, all_of_us boolean, photos int, cover text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n int;
begin
  perform public.need_member(p_group);
  select count(*) into n from public.group_members where group_id = p_group;
  return query
    select e.id, e.slug, e.title, e.starts_at, v.name, c.name, e.image_url,
           (select json_agg(json_build_object('id', p.id, 'name', coalesce(p.display_name, p.handle), 'card', r.cards[i]) order by i)
              from generate_subscripts(r.people, 1) i join public.profiles p on p.id = r.people[i]),
           cardinality(r.people) >= n,
           (select count(*)::int from public.group_photos ph where ph.group_id = p_group and ph.event_id = e.id),
           (select ph.path from public.group_photos ph where ph.group_id = p_group and ph.event_id = e.id order by ph.created_at limit 1)
    from public.group_night_rows(p_group) r
    join public.events e on e.id = r.event_id
    join public.cities c on c.id = e.city_id
    left join public.venues v on v.id = e.venue_id
    order by coalesce(e.starts_at, r.first_at) desc;
end;
$$;

-- ------------------------------------------------------------ the album

-- A night a group may keep photos of: one of its nights, or its plan.
create or replace function public.group_album_ok(p_group uuid, p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.group_night_rows(p_group) r where r.event_id = p_event)
      or exists (select 1 from public.groups g where g.id = p_group and g.plan_event_id = p_event);
$$;
revoke all on function public.group_album_ok(uuid, uuid) from public, anon, authenticated;

create or replace function public.group_photo_add(p_group uuid, p_event uuid, p_path text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r uuid;
begin
  perform public.need_member(p_group);
  if p_path is null or p_path not like auth.uid()::text || '/%' then raise exception 'not your file'; end if;
  if not public.group_album_ok(p_group, p_event) then raise exception 'only nights the group went to (or its plan)'; end if;
  if (select count(*) from public.group_photos where group_id = p_group and event_id = p_event) >= 200 then
    raise exception 'this album is full (200)';
  end if;
  insert into public.group_photos (group_id, event_id, user_id, path) values (p_group, p_event, auth.uid(), p_path) returning id into r;
  return r;
end;
$$;

-- Returns the file path, so the app can remove the file when the caller added it.
create or replace function public.group_photo_remove(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  ph public.group_photos%rowtype;
begin
  select * into ph from public.group_photos where id = p_id;
  if ph.id is null then return null; end if;
  perform public.need_member(ph.group_id);
  if ph.user_id is distinct from auth.uid()
     and not exists (select 1 from public.group_members where group_id = ph.group_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'whoever added it, or the owner' using errcode = '42501';
  end if;
  delete from public.group_photos where id = p_id;
  return ph.path;
end;
$$;

create or replace function public.group_album(p_group uuid, p_event uuid)
returns table (id uuid, path text, user_id uuid, name text, created_at timestamptz, mine boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_group);
  return query
    select ph.id, ph.path, ph.user_id, coalesce(p.display_name, p.handle), ph.created_at, ph.user_id = auth.uid()
    from public.group_photos ph left join public.profiles p on p.id = ph.user_id
    where ph.group_id = p_group and ph.event_id = p_event
    order by ph.created_at;
end;
$$;

-- -------------------------------------------------------------- numbers

create or replace function public.group_stats(p_group uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  members uuid[];
begin
  perform public.need_member(p_group);
  members := array(select user_id from public.group_members where group_id = p_group);
  return json_build_object(
    'nights', (select count(*) from public.group_night_rows(p_group)),
    'nights_year', (select count(*) from public.group_night_rows(p_group) r join public.events e on e.id = r.event_id
                    where coalesce(e.starts_at, r.first_at) >= date_trunc('year', now())),
    'room', (select v.name from public.group_night_rows(p_group) r join public.events e on e.id = r.event_id
             join public.venues v on v.id = e.venue_id group by v.name order by count(*) desc, v.name limit 1),
    'regular', (select json_build_object('name', coalesce(p.display_name, p.handle), 'n', count(*))
                from public.group_night_rows(p_group) r cross join lateral unnest(r.people) u(uid) join public.profiles p on p.id = u.uid
                group by p.id, p.display_name, p.handle order by count(*) desc, p.display_name limit 1),
    'matches', (select count(*) from (
                  select s.event_id from public.group_swipes s where s.group_id = p_group and s.direction = 'right'
                    and s.user_id = any(members)
                  group by s.event_id having count(*) = cardinality(members)) x),
    'votes', (select count(*) from public.group_rounds where group_id = p_group),
    'photos', (select count(*) from public.group_photos where group_id = p_group),
    -- the vibe: from every yes said in the group and every night gone to together
    'kinds', (select coalesce(json_agg(k.name), '[]'::json) from (
                select t.name from (
                  select s.event_id from public.group_swipes s where s.group_id = p_group and s.direction = 'right'
                  union all select r.event_id from public.group_night_rows(p_group) r) x
                join public.events e on e.id = x.event_id join public.event_types t on t.id = e.type_id
                group by t.name order by count(*) desc, t.name limit 2) k),
    -- averaged from 18:00, so 23:00 and 01:00 make midnight, not noon
    'hour', (select ((round(avg(((extract(hour from e.starts_at) + 6)::int % 24)))::int + 18) % 24)
             from (select s.event_id from public.group_swipes s where s.group_id = p_group and s.direction = 'right'
                   union all select r.event_id from public.group_night_rows(p_group) r) x
             join public.events e on e.id = x.event_id where e.starts_at is not null)
  );
end;
$$;

-- ------------------------------------------------------------ also there

create or replace function public.group_set_visible(p_group uuid, p_visible boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_group);
  if not exists (select 1 from public.group_members where group_id = p_group and user_id = auth.uid() and role = 'owner') then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  update public.groups set visible = coalesce(p_visible, false) where id = p_group;
end;
$$;

-- Visible groups with the same plan as this one, that have a friend of yours in them.
create or replace function public.group_also_there(p_group uuid)
returns table (id uuid, name text, emoji text, color text, friends text[])
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e uuid;
begin
  perform public.need_member(p_group);
  select g0.plan_event_id into e from public.groups g0 where g0.id = p_group;
  if e is null then return; end if;
  return query
    select g.id, g.name, g.emoji, g.color,
           array(select coalesce(p.display_name, p.handle) from public.group_members m join public.profiles p on p.id = m.user_id
                 where m.group_id = g.id and public.is_friend(m.user_id) order by p.display_name)
    from public.groups g
    where g.id <> p_group and g.visible and g.plan_event_id = e
      and not public.in_group(g.id)
      and exists (select 1 from public.group_members m where m.group_id = g.id and public.is_friend(m.user_id))
    order by g.name
    limit 10;
end;
$$;

-- group_get now says whether the group can be seen.
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
                  from public.group_members m join public.profiles p on p.id = m.user_id where m.group_id = g.id))
    from public.groups g where g.id = p_id);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'group_nights(uuid)', 'group_photo_add(uuid, uuid, text)', 'group_photo_remove(uuid)', 'group_album(uuid, uuid)',
    'group_stats(uuid)', 'group_set_visible(uuid, boolean)', 'group_also_there(uuid)', 'group_get(uuid)'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('47_group_nights.sql', '7d742346236655ea89cbb76c5bcc08bc3a959115c306282529b347ac6c86b921');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('47_group_nights.sql');
  end if;
end $$;
