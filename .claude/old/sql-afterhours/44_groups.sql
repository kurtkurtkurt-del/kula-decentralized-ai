-- afterhours — groups: friends who find a night together (44)
--
-- A group is a few people (2 to 12) who swipe one deck together. Each swipes in
-- their own time; when everyone said yes it is a match, when more than half did,
-- most are in. Or all at once: a live session, where the same card is in front of
-- everyone and moves on when all who are there have answered.
--
--   groups           name, emoji, colour, a cover photo, lasting or once (a once
--                    group has dates and is put away when they are over), and the
--                    deck it swipes: a city and a window of days
--   group_members    who is in; the one who made it is the owner
--   group_invites    a code for a link or a QR: whoever has it may join (14 days,
--                    20 uses), friends or not
--   group_swipes     the answer of each member to each night, inside this group only;
--                    the personal deck is not touched
--   group_live       a live session: who is there (seen in the last 40 s), and the
--                    cards skipped
--
-- The tables are closed; everything goes through the functions below, and each
-- one asks first whether you are in the group. Members see what the others answered:
-- it is a group of friends deciding together.
--
-- The deck of a group is sorted by the taste of the group before anyone swipes: a night a
-- member already kept on their own counts most, then nights of the kinds the
-- members keep most often.

create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 40),
  emoji       text not null default '✦' check (length(emoji) between 1 and 8),
  color       text not null default 'red' check (color in ('red', 'gold', 'blue', 'green', 'violet', 'paper')),
  cover_path  text,
  kind        text not null default 'lasting' check (kind in ('lasting', 'once')),
  city_slug   text,
  date_from   date,
  date_to     date,
  created_by  uuid references public.profiles on delete set null,
  created_at  timestamptz not null default now(),
  constraint groups_window check (date_to is null or date_from is null or date_to >= date_from),
  constraint groups_once_dated check (kind = 'lasting' or date_to is not null)
);

create table if not exists public.group_members (
  group_id   uuid not null references public.groups on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists group_members_user_idx on public.group_members (user_id);

create table if not exists public.group_invites (
  code        text primary key,
  group_id    uuid not null references public.groups on delete cascade,
  created_by  uuid references public.profiles on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  uses        int not null default 0,
  max_uses    int not null default 20
);

create table if not exists public.group_swipes (
  group_id   uuid not null references public.groups on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  event_id   uuid not null references public.events on delete cascade,
  direction  text not null check (direction in ('left', 'right')),
  at         timestamptz not null default now(),
  primary key (group_id, user_id, event_id)
);
create index if not exists group_swipes_event_idx on public.group_swipes (group_id, event_id);

create table if not exists public.group_live (
  group_id  uuid not null references public.groups on delete cascade,
  user_id   uuid not null references public.profiles on delete cascade,
  seen_at   timestamptz not null default now(),
  primary key (group_id, user_id)
);
create table if not exists public.group_live_skips (
  group_id  uuid not null references public.groups on delete cascade,
  event_id  uuid not null references public.events on delete cascade,
  primary key (group_id, event_id)
);

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;
alter table public.group_swipes enable row level security;
alter table public.group_live enable row level security;
alter table public.group_live_skips enable row level security;
revoke all on public.groups, public.group_members, public.group_invites, public.group_swipes,
              public.group_live, public.group_live_skips from public, anon, authenticated;

-- ------------------------------------------------------------- helpers

create or replace function public.in_group(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.group_members where group_id = p_group and user_id = auth.uid());
$$;

create or replace function public.need_member(p_group uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.in_group(p_group) then
    raise exception 'not in this group' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.need_account()
returns void
language plpgsql
stable
as $$
begin
  if auth.uid() is null or public.is_guest() then
    raise exception 'make an account first' using errcode = '42501';
  end if;
end;
$$;

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
  if coalesce(p_kind, 'lasting') not in ('lasting', 'once') then raise exception 'lasting or once'; end if;
  if p_kind = 'once' and p_to is null then raise exception 'a group for once needs its last day'; end if;
  if p_from is not null and p_to is not null and p_to < p_from then raise exception 'the last day comes after the first'; end if;
  if p_to is not null and p_to < current_date then raise exception 'those days are over'; end if;
  if p_city is not null and not exists (select 1 from public.cities where slug = p_city) then raise exception 'unknown city'; end if;
end;
$$;

-- ---------------------------------------------------------- the group

-- Members: friends of the maker only (strangers come in by an invite code).
create or replace function public.group_create(p_name text, p_emoji text, p_color text, p_kind text,
                                               p_city text, p_from date, p_to date, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  g uuid;
  m uuid;
  others uuid[] := array(select x from unnest(coalesce(p_members, '{}')) with ordinality as u(x, i)
                         where x <> auth.uid() group by x order by min(i));
begin
  perform public.need_account();
  perform public.group_check(p_name, p_emoji, p_color, p_kind, p_city, p_from, p_to);
  if cardinality(others) > 11 then raise exception 'at most 12 in a group'; end if;
  if (select count(*) from public.group_members where user_id = auth.uid()) >= 30 then
    raise exception 'at most 30 groups';
  end if;
  foreach m in array others loop
    if not public.is_friend(m) then raise exception 'only friends can be added; send the others a link'; end if;
  end loop;
  insert into public.groups (name, emoji, color, kind, city_slug, date_from, date_to, created_by)
  values (btrim(p_name), p_emoji, coalesce(p_color, 'red'), coalesce(p_kind, 'lasting'), p_city, p_from, p_to, auth.uid())
  returning id into g;
  insert into public.group_members (group_id, user_id, role) values (g, auth.uid(), 'owner');
  -- in the order they were picked, a microsecond apart, so "the oldest member" is never a tie
  insert into public.group_members (group_id, user_id, joined_at)
  select g, x, now() + make_interval(secs => i / 1e6) from unnest(others) with ordinality as u(x, i);
  return g;
end;
$$;

-- Any member may change the name, the look and the deck.
create or replace function public.group_update(p_id uuid, p_name text, p_emoji text, p_color text, p_kind text,
                                               p_city text, p_from date, p_to date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  perform public.group_check(p_name, p_emoji, p_color, p_kind, p_city, p_from, p_to);
  update public.groups set name = btrim(p_name), emoji = p_emoji, color = coalesce(p_color, 'red'),
         kind = coalesce(p_kind, 'lasting'), city_slug = p_city, date_from = p_from, date_to = p_to
   where id = p_id;
end;
$$;

-- The cover: a photo the member uploaded into their own folder of the photos bucket.
create or replace function public.group_set_cover(p_id uuid, p_path text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  was text;
begin
  perform public.need_member(p_id);
  if p_path is not null and p_path not like auth.uid()::text || '/%' then raise exception 'not your file'; end if;
  select cover_path into was from public.groups where id = p_id;
  update public.groups set cover_path = p_path where id = p_id;
  return was;
end;
$$;

-- A member adds their own friends.
create or replace function public.group_add(p_id uuid, p_users uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  m uuid;
  n int := 0;
begin
  perform public.need_member(p_id);
  foreach m in array coalesce(p_users, '{}') loop
    if exists (select 1 from public.group_members where group_id = p_id and user_id = m) then continue; end if;
    if not public.is_friend(m) then raise exception 'only friends can be added; send the others a link'; end if;
    if (select count(*) from public.group_members where group_id = p_id) >= 12 then raise exception 'at most 12 in a group'; end if;
    insert into public.group_members (group_id, user_id) values (p_id, m);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Leaving: the oldest member becomes the owner; the last one out takes the group along.
create or replace function public.group_leave(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  was text;
begin
  perform public.need_member(p_id);
  select role into was from public.group_members where group_id = p_id and user_id = auth.uid();
  delete from public.group_members where group_id = p_id and user_id = auth.uid();
  delete from public.group_live where group_id = p_id and user_id = auth.uid();
  if not exists (select 1 from public.group_members where group_id = p_id) then
    delete from public.groups where id = p_id;
  elsif was = 'owner' then
    update public.group_members set role = 'owner'
     where group_id = p_id and user_id = (select user_id from public.group_members where group_id = p_id order by joined_at, user_id limit 1);
  end if;
end;
$$;

-- The owner takes someone out (their answers stay out of the counts from then on).
create or replace function public.group_remove(p_id uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  if p_user = auth.uid() then perform public.group_leave(p_id); return; end if;
  if not exists (select 1 from public.group_members where group_id = p_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  delete from public.group_members where group_id = p_id and user_id = p_user;
  delete from public.group_swipes where group_id = p_id and user_id = p_user;
  delete from public.group_live where group_id = p_id and user_id = p_user;
end;
$$;

create or replace function public.group_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.group_members where group_id = p_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  delete from public.groups where id = p_id;
end;
$$;

-- --------------------------------------------------------- invitations

-- A code for a link or a QR; the same one while it is still good.
create or replace function public.group_invite(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c text;
begin
  perform public.need_member(p_id);
  select code into c from public.group_invites
   where group_id = p_id and expires_at > now() + interval '1 day' and uses < max_uses
   order by created_at desc limit 1;
  if c is not null then return c; end if;
  loop
    -- no 0/O, 1/I: it may be read out loud or typed
    c := array_to_string(array(select substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1)
                               from generate_series(1, 8)), '');
    exit when not exists (select 1 from public.group_invites where code = c);
  end loop;
  insert into public.group_invites (code, group_id, created_by) values (c, p_id, auth.uid());
  return c;
end;
$$;

-- What a code leads to, before joining. (49 widens it; the drop lets this file run again.)
drop function if exists public.group_peek(text);
create or replace function public.group_peek(p_code text)
returns table (id uuid, name text, emoji text, color text, cover_path text, members int, mine boolean, open boolean)
language sql
stable
security definer
set search_path = public
as $$
  select g.id, g.name, g.emoji, g.color, g.cover_path,
         (select count(*)::int from public.group_members m where m.group_id = g.id),
         public.in_group(g.id),
         i.expires_at > now() and i.uses < i.max_uses
  from public.group_invites i join public.groups g on g.id = i.group_id
  where i.code = upper(btrim(p_code));
$$;

create or replace function public.group_join(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  i public.group_invites%rowtype;
begin
  perform public.need_account();
  select * into i from public.group_invites where code = upper(btrim(p_code));
  if i.code is null then raise exception 'no group with that code'; end if;
  if public.in_group(i.group_id) then return i.group_id; end if;
  if i.expires_at <= now() or i.uses >= i.max_uses then raise exception 'that code is used up; ask for a new one'; end if;
  if (select count(*) from public.group_members where group_id = i.group_id) >= 12 then raise exception 'the group is full (12)'; end if;
  if (select count(*) from public.group_members where user_id = auth.uid()) >= 30 then raise exception 'at most 30 groups'; end if;
  insert into public.group_members (group_id, user_id) values (i.group_id, auth.uid());
  update public.group_invites set uses = uses + 1 where code = i.code;
  return i.group_id;
end;
$$;

-- ------------------------------------------------------------ reading

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
      'archived', g.kind = 'once' and g.date_to < current_date,
      'me', auth.uid(),
      'members', (select json_agg(json_build_object('id', p.id, 'handle', p.handle, 'name', p.display_name, 'role', m.role) order by m.joined_at)
                  from public.group_members m join public.profiles p on p.id = m.user_id where m.group_id = g.id))
    from public.groups g where g.id = p_id);
end;
$$;

-- ------------------------------------------------------------ the deck

-- The nights the group looks at: its city (or everywhere) and its days (from today
-- when it has no first day), ordered by the taste of the group. No check here: callers check.
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
    and (g.city_slug is null or e.city_slug = g.city_slug)
    and (e.starts_at is null or e.starts_at::date >= greatest(coalesce(g.date_from, current_date), current_date))
    and (g.date_to is null or e.starts_at::date <= g.date_to)
  order by
    3 * (select count(*) from public.swipes s where s.event_id = e.id and s.direction = 'right' and s.user_id in (select user_id from members))
    + coalesce((select least(n, 20) from liked_types lt join public.events x on x.type_id = lt.type_id where x.id = e.id), 0) / 5.0 desc,
    e.starts_at nulls last, e.id
  limit 400;
$$;
revoke all on function public.group_window(uuid) from public, anon, authenticated;

-- Your deck in the group: what you have not answered yet.
create or replace function public.group_deck(p_id uuid, p_limit int default 60)
returns setof public.events_public
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  return query
    select e.* from public.group_window(p_id) e
    where not exists (select 1 from public.group_swipes s where s.group_id = p_id and s.user_id = auth.uid() and s.event_id = e.id)
    limit greatest(1, least(coalesce(p_limit, 60), 200));
end;
$$;

create or replace function public.group_swipe(p_id uuid, p_event uuid, p_direction text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  if p_direction not in ('left', 'right') then raise exception 'left or right'; end if;
  insert into public.group_swipes (group_id, user_id, event_id, direction) values (p_id, auth.uid(), p_event, p_direction)
  on conflict (group_id, user_id, event_id) do update set direction = excluded.direction, at = now();
end;
$$;

create or replace function public.group_unswipe(p_id uuid, p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  delete from public.group_swipes where group_id = p_id and user_id = auth.uid() and event_id = p_event;
end;
$$;

-- Nights at least one member said yes to: match (everyone), most (more than half), some.
create or replace function public.group_matches(p_id uuid)
returns table (id uuid, slug text, title text, starts_at timestamptz, venue_name text, city_name text,
               image_url text, poster_no int, poster_path text, yes int, no int, members int, status text, yes_ids uuid[])
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n int;
begin
  perform public.need_member(p_id);
  select count(*) into n from public.group_members where group_id = p_id;
  return query
    with votes as (
      select s.event_id,
             count(*) filter (where s.direction = 'right')::int as y,
             count(*) filter (where s.direction = 'left')::int as l,
             array_agg(s.user_id) filter (where s.direction = 'right') as ids
      from public.group_swipes s
      join public.group_members m on m.group_id = s.group_id and m.user_id = s.user_id
      where s.group_id = p_id
      group by s.event_id)
    select e.id, e.slug, e.title, e.starts_at, v.name, c.name, e.image_url, e.poster_no, e.poster_path,
           vo.y, vo.l, n,
           case when vo.y = n then 'match' when vo.y * 2 > n then 'most' else 'some' end,
           vo.ids
    from votes vo
    join public.events e on e.id = vo.event_id and e.is_published
    join public.cities c on c.id = e.city_id
    left join public.venues v on v.id = e.venue_id
    where vo.y > 0 and (e.starts_at is null or e.starts_at > now() - interval '12 hours')
    order by vo.y desc, vo.l, e.starts_at nulls last;
end;
$$;

-- Who answered what on one night.
create or replace function public.group_votes(p_id uuid, p_event uuid)
returns table (user_id uuid, name text, direction text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  return query
    select m.user_id, coalesce(p.display_name, p.handle), s.direction
    from public.group_members m
    join public.profiles p on p.id = m.user_id
    left join public.group_swipes s on s.group_id = m.group_id and s.user_id = m.user_id and s.event_id = p_event
    where m.group_id = p_id
    order by m.joined_at;
end;
$$;

-- Your groups, the live ones first; a once group whose days are over is archived.
create or replace function public.my_groups()
returns table (id uuid, name text, emoji text, color text, cover_path text, kind text, city_slug text,
               date_from date, date_to date, members int, faces uuid[], matches int, to_swipe int,
               live int, archived boolean)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select g.* from public.groups g join public.group_members m on m.group_id = g.id and m.user_id = auth.uid()
  )
  select g.id, g.name, g.emoji, g.color, g.cover_path, g.kind, g.city_slug, g.date_from, g.date_to,
         (select count(*)::int from public.group_members m where m.group_id = g.id),
         array(select m.user_id from public.group_members m where m.group_id = g.id order by m.joined_at limit 4),
         (select count(*)::int from public.group_matches(g.id) x where x.status = 'match'),
         (select count(*)::int from public.group_window(g.id) e
           where not exists (select 1 from public.group_swipes s where s.group_id = g.id and s.user_id = auth.uid() and s.event_id = e.id)),
         (select count(*)::int from public.group_live l where l.group_id = g.id and l.seen_at > now() - interval '40 seconds'),
         g.kind = 'once' and g.date_to < current_date
  from mine g
  order by (g.kind = 'once' and g.date_to < current_date), g.created_at desc;
$$;

-- ------------------------------------------------------------ live

-- Being in the session: call it every few seconds. Who has not called for 40 s
-- is no longer counted.
create or replace function public.group_live_here(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  insert into public.group_live (group_id, user_id) values (p_id, auth.uid())
  on conflict (group_id, user_id) do update set seen_at = now();
end;
$$;

create or replace function public.group_live_leave(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  delete from public.group_live where group_id = p_id and user_id = auth.uid();
end;
$$;

-- The card everyone sees: the first night of the deck of the group that not everyone
-- who is there has answered and nobody skipped; with who is there and what each said.
create or replace function public.group_live_state(p_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  here uuid[];
  card public.events_public%rowtype;
  left_ int;
begin
  perform public.need_member(p_id);
  here := array(select l.user_id from public.group_live l
                join public.group_members m on m.group_id = l.group_id and m.user_id = l.user_id
                where l.group_id = p_id and l.seen_at > now() - interval '40 seconds' order by l.user_id);
  if cardinality(here) = 0 then here := array[auth.uid()]; end if;
  select e.* into card from public.group_window(p_id) e
   where not exists (select 1 from public.group_live_skips k where k.group_id = p_id and k.event_id = e.id)
     and (select count(*) from public.group_swipes s where s.group_id = p_id and s.event_id = e.id and s.user_id = any(here)) < cardinality(here)
   limit 1;
  select count(*)::int into left_ from public.group_window(p_id) e
   where not exists (select 1 from public.group_live_skips k where k.group_id = p_id and k.event_id = e.id)
     and (select count(*) from public.group_swipes s where s.group_id = p_id and s.event_id = e.id and s.user_id = any(here)) < cardinality(here);
  return json_build_object(
    'card', case when card.id is null then null else row_to_json(card) end,
    'left', left_,
    'people', (select json_agg(json_build_object('id', p.id, 'name', coalesce(p.display_name, p.handle),
                                                 'answer', (select s.direction from public.group_swipes s
                                                            where s.group_id = p_id and s.user_id = p.id and s.event_id = card.id)))
               from public.profiles p where p.id = any(here)));
end;
$$;

-- Anyone in the session moves past a card nobody can agree on.
create or replace function public.group_live_skip(p_id uuid, p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  insert into public.group_live_skips (group_id, event_id) values (p_id, p_event) on conflict do nothing;
end;
$$;

-- ------------------------------------------------------- a group to make

-- Friends who kept the same nights as you lately: the start of a group.
create or replace function public.group_suggest()
returns table (user_id uuid, handle text, name text, shared int)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.handle, p.display_name, count(*)::int
  from public.swipes mine
  join public.swipes theirs on theirs.event_id = mine.event_id and theirs.direction = 'right' and theirs.user_id <> mine.user_id
  join public.profiles p on p.id = theirs.user_id
  where mine.user_id = auth.uid() and mine.direction = 'right'
    and mine.created_at > now() - interval '45 days'
    and public.is_friend(theirs.user_id)
  group by p.id, p.handle, p.display_name
  having count(*) >= 2
  order by count(*) desc
  limit 8;
$$;

-- --------------------------------------------------------------- doors

do $$
declare f text;
begin
  foreach f in array array[
    'group_create(text, text, text, text, text, date, date, uuid[])',
    'group_update(uuid, text, text, text, text, text, date, date)',
    'group_set_cover(uuid, text)', 'group_add(uuid, uuid[])', 'group_leave(uuid)', 'group_remove(uuid, uuid)',
    'group_delete(uuid)', 'group_invite(uuid)', 'group_peek(text)', 'group_join(text)',
    'my_groups()', 'group_get(uuid)', 'group_deck(uuid, int)', 'group_swipe(uuid, uuid, text)',
    'group_unswipe(uuid, uuid)', 'group_matches(uuid)', 'group_votes(uuid, uuid)',
    'group_live_here(uuid)', 'group_live_leave(uuid)', 'group_live_state(uuid)', 'group_live_skip(uuid, uuid)',
    'group_suggest()'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;
revoke all on function public.need_member(uuid) from public, anon;
revoke all on function public.in_group(uuid) from public, anon;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('44_groups.sql', 'b0fa59493217b5c5ba29a1ac218427227ba470501108b1ce906501775c6344fd');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('44_groups.sql');
  end if;
end $$;
